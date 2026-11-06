/**
 * 카카오 로컬 API — 좌표 범위(rect) 기반 장소 검색 + 캐싱
 *
 * 카카오 로컬 검색은 한 요청에서 최대 45건(15건 × 3페이지)만 노출한다.
 * total_count 가 45를 넘는 범위는 4분할해서 재귀적으로 다시 조회하고,
 * 결과를 id 기준으로 중복 제거해 합친다.
 *
 * 캐시는 2단계:
 *  1) 요청 단위 디스크 캐시 (data/cache/kakao/*.json, TTL) — 같은 페이지 재요청 방지
 *  2) rect 전체 결과 메모리 캐시 — 서버 API 반복 호출 대응
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, CACHE_TTL_MS, KAKAO_REST_KEY } from './config';

export type Rect = [minLng: number, minLat: number, maxLng: number, maxLat: number];

export interface KakaoDoc {
  id: string;
  place_name: string;
  category_name: string;
  category_group_code: string;
  category_group_name: string;
  phone: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  place_url: string;
}

interface KakaoResponse {
  meta: { total_count: number; pageable_count: number; is_end: boolean };
  documents: KakaoDoc[];
}

export type SearchSpec = { kind: 'category'; code: string } | { kind: 'keyword'; query: string; code?: string };

const PAGE_SIZE = 15;
const MAX_PAGES = 3; // 15 × 3 = 45건 노출 한도
const LIMIT = 45;
const MIN_SPLIT_DEG = 0.0004; // 약 40m 이하로는 더 쪼개지 않음

export const stats = { apiCalls: 0, cacheHits: 0, splits: 0 };

// ---------- 동시성 제한 (카카오 쿼터/속도 제한 보호) ----------
const MAX_CONCURRENT = 4;
let running = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

// ---------- 요청 단위 디스크 캐시 ----------
const round = (n: number) => n.toFixed(6);
function cacheKey(spec: SearchSpec, rect: Rect, page: number) {
  const s = spec.kind === 'category' ? `c|${spec.code}` : `k|${spec.query}|${spec.code ?? ''}`;
  return crypto.createHash('sha1').update(`${s}|${rect.map(round).join(',')}|${page}`).digest('hex');
}

async function readCache(key: string): Promise<KakaoResponse | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(CACHE_DIR, key.slice(0, 2), `${key}.json`), 'utf8'));
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    return raw.data;
  } catch {
    return null;
  }
}

async function writeCache(key: string, data: KakaoResponse) {
  const dir = path.join(CACHE_DIR, key.slice(0, 2));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ fetchedAt: Date.now(), data }));
}

async function fetchPage(spec: SearchSpec, rect: Rect, page: number): Promise<KakaoResponse> {
  const key = cacheKey(spec, rect, page);
  const cached = await readCache(key);
  if (cached) {
    stats.cacheHits++;
    return cached;
  }
  if (!KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY 가 .env 에 없습니다.');

  const params = new URLSearchParams({ rect: rect.join(','), page: String(page), size: String(PAGE_SIZE) });
  let endpoint: string;
  if (spec.kind === 'category') {
    endpoint = 'category';
    params.set('category_group_code', spec.code);
  } else {
    endpoint = 'keyword';
    params.set('query', spec.query);
    if (spec.code) params.set('category_group_code', spec.code);
  }
  const url = `https://dapi.kakao.com/v2/local/search/${endpoint}.json?${params}`;

  const data = await withSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      stats.apiCalls++;
      const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } });
      if (res.ok) return (await res.json()) as KakaoResponse;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Kakao API ${res.status}: ${await res.text()}`);
    }
  });
  await writeCache(key, data);
  return data;
}

function splitRect([x1, y1, x2, y2]: Rect): Rect[] {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [
    [x1, y1, mx, my],
    [mx, y1, x2, my],
    [x1, my, mx, y2],
    [mx, my, x2, y2],
  ];
}

async function searchRectRec(spec: SearchSpec, rect: Rect, out: Map<string, KakaoDoc>) {
  const first = await fetchPage(spec, rect, 1);
  const tooSmall = rect[2] - rect[0] < MIN_SPLIT_DEG && rect[3] - rect[1] < MIN_SPLIT_DEG;

  if (first.meta.total_count > LIMIT && !tooSmall) {
    stats.splits++;
    await Promise.all(splitRect(rect).map((r) => searchRectRec(spec, r, out)));
    return;
  }
  for (const d of first.documents) out.set(d.id, d);
  let meta = first.meta;
  for (let page = 2; page <= MAX_PAGES && !meta.is_end; page++) {
    const res = await fetchPage(spec, rect, page);
    for (const d of res.documents) out.set(d.id, d);
    meta = res.meta;
  }
}

const memo = new Map<string, Promise<KakaoDoc[]>>();

/** rect 범위 안의 장소를 빠짐없이 조회 (자동 분할 + 캐시) */
export function searchRect(spec: SearchSpec, rect: Rect): Promise<KakaoDoc[]> {
  const key = cacheKey(spec, rect, 0);
  let p = memo.get(key);
  if (!p) {
    p = (async () => {
      const out = new Map<string, KakaoDoc>();
      await searchRectRec(spec, rect, out);
      // 분할 경계에 걸친 장소/키워드 검색의 범위 밖 결과 제거
      return [...out.values()].filter((d) => {
        const x = +d.x;
        const y = +d.y;
        return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
      });
    })();
    memo.set(key, p);
    p.catch(() => memo.delete(key));
  }
  return p;
}

/** 키워드로 장소 1건 찾기 (목적지 좌표 보정용) */
export async function findPlace(query: string, near?: { lng: number; lat: number }): Promise<KakaoDoc | null> {
  if (!KAKAO_REST_KEY) return null;
  const params = new URLSearchParams({ query, size: '1' });
  if (near) {
    params.set('x', String(near.lng));
    params.set('y', String(near.lat));
    params.set('radius', '10000');
  }
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
  });
  if (!res.ok) throw new Error(`Kakao API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as KakaoResponse;
  return data.documents[0] ?? null;
}

// ---------- 좌표 → 주소 (건물명·건물번호) ----------
export interface KakaoAddress {
  /** 도로명 주소 — 건물 위에 있을 때만. building_name: 건물·단지 이름, main/sub_building_no: 건물 번호 */
  road_address: { address_name: string; road_name: string; main_building_no: string; sub_building_no: string; building_name: string; zone_no: string } | null;
  /** 지번 주소 */
  address: { address_name: string; main_address_no: string; sub_address_no: string } | null;
}

/** 한 좌표의 주소 (디스크 캐시) */
export async function coord2address(lng: number, lat: number): Promise<KakaoAddress | null> {
  const key = crypto.createHash('sha1').update(`c2a|${round(lng)},${round(lat)}`).digest('hex');
  const cached = (await readCache(key)) as unknown as { documents: KakaoAddress[] } | null;
  if (cached) {
    stats.cacheHits++;
    return cached.documents[0] ?? null;
  }
  if (!KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY 가 .env 에 없습니다.');
  const url = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`;
  const data = await withSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      stats.apiCalls++;
      const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } });
      if (res.ok) return (await res.json()) as { documents: KakaoAddress[] };
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Kakao API ${res.status}: ${await res.text()}`);
    }
  });
  await writeCache(key, data as unknown as KakaoResponse);
  return data.documents[0] ?? null;
}
