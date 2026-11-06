/**
 * 탐색 지역(격자, +바깥 600m 버퍼)의 시설 정보를 카카오 로컬 API로 수집한다.
 * 지역이 여러 덩어리(한성대 주변 · 이태원역 주변)라 행정동별 범위를 겹치는 것끼리 묶어 덩어리마다 검색한다.
 * 결과: data/generated/places.json, destinations.json
 *
 *   npm run collect          — KAKAO_REST_KEY 필요. 없으면 mock 데이터로 대체
 *   npm run collect -- --mock — 강제로 mock 데이터 생성
 */
import fs from 'node:fs/promises';
import { DESTINATIONS, FILES, GEN_DIR, KAKAO_REST_KEY } from '../src/config';
import { findPlace, searchRect, stats, type Rect } from '../src/kakao';
import { COLLECT_TARGETS, normalize } from '../src/places';
import { mockDestinations, mockPlaces } from '../src/mockPlaces';
import type { Place } from '../../shared/types';
import type { GridCell } from './genGrid';

const grid: GridCell[] = JSON.parse(await fs.readFile(FILES.grid, 'utf8'));
// 경계 셀의 주변 생활권 분석을 위해 바깥으로 약 600m 확장
const BUF_LAT = 0.0054;
const BUF_LNG = 0.0068;
const byDong = new Map<string, Rect>();
for (const c of grid)
  for (const { lat, lng } of c.corners) {
    const r = byDong.get(c.dongCode) ?? [Infinity, Infinity, -Infinity, -Infinity];
    byDong.set(c.dongCode, [Math.min(r[0], lng), Math.min(r[1], lat), Math.max(r[2], lng), Math.max(r[3], lat)]);
  }
// 버퍼 넣은 동 범위를 서로 겹치면 합친다 → 덩어리별 검색 범위
let rects: Rect[] = [...byDong.values()].map((r) => [r[0] - BUF_LNG, r[1] - BUF_LAT, r[2] + BUF_LNG, r[3] + BUF_LAT]);
const overlap = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
for (let merged = true; merged; ) {
  merged = false;
  for (let i = 0; i < rects.length && !merged; i++)
    for (let j = i + 1; j < rects.length && !merged; j++)
      if (overlap(rects[i], rects[j])) {
        const [a, b] = [rects[i], rects[j]];
        rects = rects.filter((_, k) => k !== i && k !== j).concat([[Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]]);
        merged = true;
      }
}
const all: Rect = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];

const useMock = process.argv.includes('--mock') || !KAKAO_REST_KEY;
await fs.mkdir(GEN_DIR, { recursive: true });

let places: Place[];
let destinations: { name: string; lat: number; lng: number }[];

if (useMock) {
  console.warn('⚠ KAKAO_REST_KEY 가 없어 mock 시설 데이터를 생성합니다. (.env 설정 후 다시 실행하면 실제 데이터로 대체)');
  places = rects.flatMap((r) => mockPlaces(r));
  destinations = mockDestinations();
} else {
  for (const r of rects) console.log('수집 범위', r.map((n) => n.toFixed(5)).join(','));
  const byId = new Map<string, Place>();
  for (const t of COLLECT_TARGETS) {
    const t0 = Date.now();
    let n = 0;
    for (const spec of t.specs) {
      const docs = [];
      for (const r of rects) docs.push(...(await searchRect(spec, r)));
      for (const d of docs) {
        const p = normalize(t.cat, d);
        if (p && !byId.has(p.id)) {
          byId.set(p.id, p);
          n++;
        }
      }
    }
    console.log(`  ${t.cat.padEnd(6)} ${String(n).padStart(5)}건  (${Date.now() - t0}ms, 누적 API ${stats.apiCalls} / 캐시 ${stats.cacheHits} / 분할 ${stats.splits})`);
  }
  places = [...byId.values()];

  const center = { lng: (all[0] + all[2]) / 2, lat: (all[1] + all[3]) / 2 };
  destinations = [];
  for (const name of DESTINATIONS) {
    const d = await findPlace(name, center);
    if (d) destinations.push({ name, lat: +d.y, lng: +d.x });
  }
}

await fs.writeFile(FILES.places, JSON.stringify(places));
await fs.writeFile(FILES.destinations, JSON.stringify({ source: useMock ? 'mock' : 'kakao', bbox: all, destinations }, null, 2));

const counts: Record<string, number> = {};
for (const p of places) counts[p.cat] = (counts[p.cat] ?? 0) + 1;
console.log(`시설 ${places.length}건 저장`, counts);
