/**
 * 부동산 매물 CSV(articleNo 단위, 네이버 부동산 응답 필드) → PostgreSQL wh_articles
 *   npm run import:articles -w server -- "C:\경로\매물_중복제거.csv" [분류]
 *   분류: 주거(기본) · 상가 … 화면에서 이 분류로 거를 수 있다
 *
 * - 매물번호(articleNo)가 같으면 새 값으로 덮어쓴다
 * - 자주 쓰는 값은 열로, 원본 행 전체는 raw(jsonb)에 그대로 둔다
 * - 좌표가 0,0 이면 위치 없음(null). 매물마다 들어가는 200m 칸(cell_id)을 붙인다
 * - 판매자 이름·전화는 raw 에만 있고 API 로 내보내지 않는다
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { FILES } from '../src/config';
import { pool } from '../src/postgres';
import type { GeneratedCell, LatLng } from '../../shared/types';
import { csvRecords } from './csv';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wh_articles (
  id text PRIMARY KEY,                 -- articleNo
  name text,                           -- articleName (예: 일반원룸, 단지명)
  building_name text,
  status text,
  type_code text,                      -- realEstateTypeCode (OR 원룸, OPST 오피스텔 …)
  type_name text,                      -- realEstateTypeName
  trade_type text,                     -- tradeTypeName (월세 · 전세 · 매매 · 단기임대)
  deposit_manwon bigint,               -- 보증금 · 전세금 · 매매가 (만원) — dealOrWarrantPrc
  rent_manwon bigint,                  -- 월세 (만원) — rentPrc
  area_supply double precision,        -- area1 (㎡)
  area_exclusive double precision,     -- area2 (㎡)
  floor_info text,                     -- 예: 1/5
  direction text,
  confirmed_on date,                   -- articleConfirmYmd
  features text,                       -- articleFeatureDesc
  tags jsonb,                          -- tagList
  img_url text,                        -- representativeImgUrl
  realtor_name text,
  cp_name text,                        -- 정보 제공처
  lat double precision,                -- 위치 비공개(0,0)이면 null
  lng double precision,
  cell_id text,                        -- 들어가는 200m 칸 (없으면 null)
  first_seen timestamptz,
  last_seen timestamptz,
  raw jsonb NOT NULL,                  -- 원본 행 전체 (판매자 정보 포함 — API 로 내보내지 않음)
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_articles_cell ON wh_articles (cell_id);
-- 분류 (주거 · 상가 …) — 나중에 생긴 열
ALTER TABLE wh_articles ADD COLUMN IF NOT EXISTS category text;
UPDATE wh_articles SET category = '주거' WHERE category IS NULL;
`;

/** '1,000' · '1억 2,000' · '3억' → 만원 */
export function manwon(s: string): number | null {
  const t = s.replace(/\s/g, '').replace(/,/g, '');
  if (!t) return null;
  const m = t.match(/^(?:(\d+(?:\.\d+)?)억)?(\d+)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return Math.round(Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0));
}
const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
const ymd = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);
const ts = (s: string) => (s && !Number.isNaN(Date.parse(s)) ? s : null);
const json = (s: string) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

function inPolygon(p: LatLng, poly: LatLng[]) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) r = !r;
  }
  return r;
}

async function main() {
  const file = process.argv[2];
  const category = (process.argv[3] ?? '주거').trim() || '주거';
  if (!file) throw new Error('CSV 파일 경로를 넣어 주세요: npm run import:articles -w server -- "경로.csv"');
  if (!pool) throw new Error('Set DATABASE_URL in the project root .env file.');

  const recs = csvRecords(await readFile(file, 'utf8'));
  if (!recs.length || !('articleNo' in recs[0])) throw new Error('articleNo 열이 있는 매물 CSV 가 아니에요.');
  const cells: GeneratedCell[] = JSON.parse(await readFile(FILES.cells, 'utf8'));

  const seen = new Set<string>();
  const rows: unknown[][] = [];
  let noLoc = 0;
  let inArea = 0;
  for (const r of recs) {
    if (!r.articleNo || seen.has(r.articleNo)) continue;
    seen.add(r.articleNo);
    let [lat, lng] = [num(r.latitude), num(r.longitude)];
    if (!lat || !lng) (lat = null), (lng = null), noLoc++;
    const cell = lat && lng ? cells.find((c) => inPolygon({ lat, lng }, c.corners))?.id ?? null : null;
    if (cell) inArea++;
    rows.push([
      r.articleNo,
      r.articleName || null,
      r.buildingName || null,
      r.articleStatus || null,
      r.realEstateTypeCode || null,
      r.realEstateTypeName || null,
      r.tradeTypeName || null,
      manwon(r.dealOrWarrantPrc ?? ''),
      manwon(r.rentPrc ?? ''),
      num(r.area1 ?? ''),
      num(r.area2 ?? ''),
      r.floorInfo || null,
      r.direction || null,
      ymd(r.articleConfirmYmd ?? ''),
      r.articleFeatureDesc || null,
      JSON.stringify(json(r.tagList ?? '') ?? []),
      r.representativeImgUrl || null,
      r.realtorName || null,
      r.cpName || null,
      lat,
      lng,
      cell,
      ts(r['추출_최초수집시각'] ?? ''),
      ts(r['추출_최종수집시각'] ?? ''),
      JSON.stringify(r),
      path.basename(file),
      category,
    ]);
  }

  const cols = ['id', 'name', 'building_name', 'status', 'type_code', 'type_name', 'trade_type', 'deposit_manwon', 'rent_manwon', 'area_supply', 'area_exclusive', 'floor_info', 'direction', 'confirmed_on', 'features', 'tags', 'img_url', 'realtor_name', 'cp_name', 'lat', 'lng', 'cell_id', 'first_seen', 'last_seen', 'raw', 'source_file', 'category'];
  const cast: Record<string, string> = { tags: '::jsonb', raw: '::jsonb' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);
    const per = Math.floor(30000 / cols.length);
    for (let i = 0; i < rows.length; i += per) {
      const values: unknown[] = [];
      const tuples = rows.slice(i, i + per).map((row) => `(${row.map((v, j) => (values.push(v), `$${values.length}${cast[cols[j]] ?? ''}`)).join(',')})`);
      await client.query(
        `INSERT INTO wh_articles (${cols.join(',')}) VALUES ${tuples.join(',')}
         ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, imported_at = now()`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`[${category}] 매물 ${rows.length}건 저장 (탐색 지역 안 ${inArea}건, 밖 ${rows.length - inArea - noLoc}건, 위치 없음 ${noLoc}건)`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
