/**
 * 매물 정보 엑셀(.xlsx) → PostgreSQL wh_listings
 *   npm run import:listings -w server -- "C:\경로\매물정보.xlsx"
 *
 * - 매물번호가 같으면 새 값으로 덮어쓴다 (여러 번 넣어도 중복 없음)
 * - 매물마다 어느 200m 칸에 들어가는지(cell_id) 붙인다. 탐색 지역 밖이면 null
 * - 중개사 이름·전화는 DB 에만 둔다 (API 로 내보내지 않음)
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { FILES } from '../src/config';
import { pool } from '../src/postgres';
import type { GeneratedCell, LatLng } from '../../shared/types';

/** 엑셀 머리글 → 컬럼 */
const COLS: [header: string, column: string, kind: 'text' | 'int' | 'num' | 'date'][] = [
  ['매물번호', 'id', 'text'],
  ['매물명', 'name', 'text'],
  ['위도', 'lat', 'num'],
  ['경도', 'lng', 'num'],
  ['거래유형', 'deal_type', 'text'],
  ['매물유형', 'property_type', 'text'],
  ['가격표시', 'price_text', 'text'],
  ['매매 금액(원)', 'price', 'int'],
  ['보증금(원)', 'deposit', 'int'],
  ['월세(원)', 'monthly_rent', 'int'],
  ['층수', 'floor', 'text'],
  ['면적(㎡)', 'area_m2', 'num'],
  ['전용면적', 'exclusive_m2', 'num'],
  ['방향', 'direction', 'text'],
  ['특징', 'features', 'text'],
  ['등록일', 'registered_on', 'date'],
  ['부동산상호', 'agency', 'text'],
  ['중개사이름', 'agent_name', 'text'],
  ['전화1', 'phone1', 'text'],
  ['전화2', 'phone2', 'text'],
  ['전세_기간(년)', 'jeonse_years', 'int'],
  ['전세_기간내_최고(원)', 'jeonse_max', 'int'],
  ['전세_기간내_최저(원)', 'jeonse_min', 'int'],
  ['기전세금(원)', 'prev_jeonse', 'int'],
  ['갭금액(원)', 'gap', 'int'],
  ['갭비율', 'gap_ratio', 'num'],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wh_listings (
  id text PRIMARY KEY,               -- 매물번호
  name text NOT NULL,                -- 매물명 (단지·건물)
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  cell_id text,                      -- 들어가는 200m 칸 (탐색 지역 밖이면 null)
  deal_type text,                    -- 거래유형 (매매 · 전세 · 월세)
  property_type text,                -- 매물유형
  price_text text,                   -- 가격표시 (원문)
  price bigint,                      -- 매매 금액(원)
  deposit bigint,                    -- 보증금(원) (전세 · 월세)
  monthly_rent bigint,               -- 월세(원)
  floor text,                        -- 층수 (예: 저/19)
  area_m2 double precision,          -- 면적(㎡)
  exclusive_m2 double precision,     -- 전용면적(㎡)
  direction text,
  features text,
  registered_on date,
  agency text,                       -- 부동산상호
  agent_name text,                   -- 중개사 이름 (개인정보 — API 로 내보내지 않음)
  phone1 text,                       -- (개인정보)
  phone2 text,                       -- (개인정보)
  jeonse_years int,                  -- 전세 시세 기간(년)
  jeonse_max bigint,                 -- 기간 내 전세 최고(원)
  jeonse_min bigint,                 -- 기간 내 전세 최저(원)
  prev_jeonse bigint,                -- 기전세금(원)
  gap bigint,                        -- 갭 금액(원)
  gap_ratio double precision,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_listings_cell ON wh_listings (cell_id);
-- 예전에 만든 표에 나중에 생긴 열 추가
ALTER TABLE wh_listings ADD COLUMN IF NOT EXISTS property_type text;
ALTER TABLE wh_listings ADD COLUMN IF NOT EXISTS price_text text;
ALTER TABLE wh_listings ADD COLUMN IF NOT EXISTS deposit bigint;
ALTER TABLE wh_listings ADD COLUMN IF NOT EXISTS monthly_rent bigint;
`;

function inPolygon(p: LatLng, poly: LatLng[]) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) r = !r;
  }
  return r;
}

/** 엑셀 칸 값 → 문자열 (수식·서식 있는 칸도) */
function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10).replace(/-/g, '');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}
function convert(s: string | null, kind: 'text' | 'int' | 'num' | 'date') {
  if (s === null) return null;
  if (kind === 'text') return s;
  if (kind === 'date') return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return kind === 'int' ? Math.round(n) : n;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('엑셀 파일 경로를 넣어 주세요: npm run import:listings -w server -- "경로.xlsx"');
  if (!pool) throw new Error('Set DATABASE_URL in the project root .env file.');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => cellText(v));
  const idx = COLS.map(([h]) => header.indexOf(h));
  const unknown = header.filter((h, i) => i > 0 && h && !COLS.some(([c]) => c === h));
  if (unknown.length) console.warn(`저장하지 않는 열: ${unknown.join(', ')}`);
  const missing = COLS.filter((_, i) => idx[i] < 0 && ['매물번호', '매물명', '위도', '경도'].includes(COLS[i][0])).map(([h]) => h);
  if (missing.length) throw new Error(`필수 머리글이 없어요: ${missing.join(', ')}`);

  const cells: GeneratedCell[] = JSON.parse(await readFile(FILES.cells, 'utf8'));
  const cellOf = (p: LatLng) => cells.find((c) => inPolygon(p, c.corners))?.id ?? null;

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const vals = row.values as ExcelJS.CellValue[];
    const r: Record<string, unknown> = {};
    COLS.forEach(([, col, kind], i) => (r[col] = idx[i] < 0 ? null : convert(cellText(vals[idx[i]]), kind)));
    if (!r.id || !r.name || typeof r.lat !== 'number' || typeof r.lng !== 'number') return void skipped++;
    if (seen.has(r.id as string)) return void skipped++;
    seen.add(r.id as string);
    r.cell_id = cellOf({ lat: r.lat, lng: r.lng });
    rows.push(r);
  });

  const cols = [...COLS.map(([, c]) => c), 'cell_id', 'source_file'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);
    const per = Math.floor(30000 / cols.length);
    for (let i = 0; i < rows.length; i += per) {
      const values: unknown[] = [];
      const tuples = rows.slice(i, i + per).map((r) => `(${cols.map((c) => (values.push(c === 'source_file' ? path.basename(file) : r[c]), `$${values.length}`)).join(',')})`);
      await client.query(
        `INSERT INTO wh_listings (${cols.join(',')}) VALUES ${tuples.join(',')}
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
  const inArea = rows.filter((r) => r.cell_id).length;
  console.log(`매물 ${rows.length}건 저장 (탐색 지역 안 ${inArea}건, 밖 ${rows.length - inArea}건${skipped ? `, 건너뜀 ${skipped}건` : ''})`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
