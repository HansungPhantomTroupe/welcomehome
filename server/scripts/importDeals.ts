/**
 * 아파트 매매 실거래(지오코딩된 CSV) → PostgreSQL wh_deals
 *   npm run import:deals -w server -- "C:\경로\deals_geocoded.csv"
 *
 * - 파일 하나가 전체 데이터: 넣을 때마다 표를 비우고 새로 채운다 (한 트랜잭션)
 * - block_id(EPSG5179_{행}_{열}) → 우리 칸 ID(SB{행}_{열}). 우리 칸에 없으면 넣지 않고 알린다
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FILES } from '../src/config';
import { pool } from '../src/postgres';
import type { GeneratedCell } from '../../shared/types';
import { parseCsv } from './csv';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wh_deals (
  id serial PRIMARY KEY,
  cell_id text NOT NULL,              -- 200m 칸
  sgg text,                           -- 구
  dong text,                          -- 법정동 (umdNm)
  jibun text,
  name text,                          -- 단지명
  deal_date date NOT NULL,            -- 계약일
  price_manwon integer NOT NULL,      -- 거래가 (만원)
  area_m2 double precision,           -- 전용면적
  price_per_m2 double precision,      -- ㎡당 가격 (만원)
  floor integer,
  build_year integer,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  source_file text
);
CREATE INDEX IF NOT EXISTS wh_deals_cell ON wh_deals (cell_id);
CREATE INDEX IF NOT EXISTS wh_deals_date ON wh_deals (deal_date);
`;

const num = (s: string | undefined) => (s === undefined || s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
const int = (s: string | undefined) => {
  const n = num(s);
  return n === null ? null : Math.round(n);
};

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('CSV 파일 경로를 넣어 주세요: npm run import:deals -w server -- "경로.csv"');
  if (!pool) throw new Error('Set DATABASE_URL in the project root .env file.');

  const [head, ...body] = parseCsv((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const need = ['block_id', 'dealYear', 'dealMonth', 'dealDay', 'price_manwon', 'lon', 'lat'];
  const miss = need.filter((h) => !head.includes(h));
  if (miss.length) throw new Error(`필수 머리글이 없어요: ${miss.join(', ')}`);
  const col = (r: string[], h: string) => r[head.indexOf(h)];

  const cellIds = new Set((JSON.parse(await readFile(FILES.cells, 'utf8')) as GeneratedCell[]).map((c) => c.id));
  const rows: unknown[][] = [];
  const outside: string[] = [];
  let bad = 0;
  for (const r of body) {
    const m = String(col(r, 'block_id') ?? '').match(/(\d+)_(\d+)$/);
    const cell = m ? `SB${m[1]}_${m[2]}` : null;
    const [y, mo, d] = [int(col(r, 'dealYear')), int(col(r, 'dealMonth')), int(col(r, 'dealDay'))];
    const price = int(col(r, 'price_manwon'));
    const [lat, lng] = [num(col(r, 'lat')), num(col(r, 'lon'))];
    if (!cell || !y || !mo || !d || price === null || lat === null || lng === null) {
      bad++;
      continue;
    }
    if (!cellIds.has(cell)) {
      outside.push(cell);
      continue;
    }
    rows.push([
      cell,
      col(r, '_sgg') || null,
      col(r, 'umdNm') || null,
      col(r, 'jibun') || null,
      col(r, 'name') || null,
      `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      price,
      num(col(r, 'area_m2')),
      num(col(r, 'price_per_m2')),
      int(col(r, 'floor')),
      int(col(r, 'buildYear')),
      lat,
      lng,
      path.basename(file),
    ]);
  }

  const cols = ['cell_id', 'sgg', 'dong', 'jibun', 'name', 'deal_date', 'price_manwon', 'area_m2', 'price_per_m2', 'floor', 'build_year', 'lat', 'lng', 'source_file'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);
    await client.query('TRUNCATE wh_deals RESTART IDENTITY');
    const per = Math.floor(30000 / cols.length);
    for (let i = 0; i < rows.length; i += per) {
      const values: unknown[] = [];
      const tuples = rows.slice(i, i + per).map((row) => `(${row.map((v) => (values.push(v), `$${values.length}`)).join(',')})`);
      await client.query(`INSERT INTO wh_deals (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(
    `실거래 ${rows.length}건 저장 (${new Set(rows.map((r) => r[0])).size}칸)` +
      (outside.length ? `, 우리 칸 밖 ${outside.length}건 제외` : '') +
      (bad ? `, 값이 모자라 건너뜀 ${bad}건` : ''),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
