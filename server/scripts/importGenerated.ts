/**
 * data/generated 의 결과를 PostgreSQL(PostGIS) 테이블로 옮긴다.
 *   npm run import:generated -w server
 * 테이블 정의는 src/postgres.ts 의 SCHEMA. 기존 데이터는 지우고 새로 넣는다 (한 트랜잭션).
 */
import { readFile } from 'node:fs/promises';
import { FILES } from '../src/config';
import { pool, SCHEMA } from '../src/postgres';
import type { GeneratedCell as Cell, DongStat, Meta, Place } from '../../shared/types';

const read = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;
const polygon = (c: Cell) => {
  const ring = [...c.corners, c.corners[0]].map((p) => `${p.lng} ${p.lat}`).join(',');
  return `SRID=4326;POLYGON((${ring}))`;
};
const point = (p: { lat: number; lng: number }) => `SRID=4326;POINT(${p.lng} ${p.lat})`;

/** 여러 행을 한 번에 INSERT (파라미터 수 한도 안에서 나눠서) */
async function insertMany(client: { query: (q: string, v: unknown[]) => Promise<unknown> }, table: string, cols: string[], rows: unknown[][], cast: Record<string, string> = {}) {
  const per = Math.floor(30000 / cols.length);
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v, j) => (values.push(v), `$${values.length}${cast[cols[j]] ?? ''}`)).join(',')})`);
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

async function main() {
  if (!pool) throw new Error('Set DATABASE_URL in the project root .env file.');
  const [cells, dongStats, places, meta] = await Promise.all([
    read<Cell[]>(FILES.cells),
    read<DongStat[]>(FILES.dongStats),
    read<Place[]>(FILES.places),
    read<Meta>(FILES.meta),
  ]);
  if (!cells.length || !dongStats.length || !places.length) throw new Error('The generated files are empty.');
  if (new Set(cells.map((c) => c.id)).size !== cells.length) throw new Error('Cell IDs must be unique.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);
    await client.query('DROP TABLE IF EXISTS welcomehome_api_datasets'); // 예전 JSON 한 덩어리 저장 방식
    await client.query('TRUNCATE wh_cells, wh_places, wh_meta, wh_dongs');

    const geo = { center: '::geometry', geom: '::geometry' };
    await insertMany(
      client,
      'wh_dongs',
      ['code', 'name', 'center', 'cell_count', 'commute_min', 'wd_evening', 'we_night', 'type_counts'],
      dongStats.map((d) => [d.code, d.name, point(d.center), d.cellCount, d.commuteMin, d.wdEvening, d.weNight, JSON.stringify(d.typeCounts ?? {})]),
      { ...geo, type_counts: '::jsonb' },
    );
    await insertMany(
      client,
      'wh_cells',
      ['id', 'dong_code', 'dong_name', 'geom', 'center', 'lgu_id', 'slots', 'pop', 'pop_raw', 'demo', 'total',
        'share_resident', 'share_worker', 'share_visitor', 'level_total', 'level_wd_evening', 'level_wd_night', 'level_we_night',
        'poi_food', 'poi_cafe', 'poi_bar', 'poi_conv', 'poi_hosp', 'poi_pharm', 'poi_gym', 'poi_subway', 'poi_mart',
        'depts', 'spike', 'spread_apt', 'spread_building', 'spread_area'],
      cells.map((c) => [
        c.id, c.dongCode, c.dongName, polygon(c), point(c.center), c.lguId ?? null,
        c.slots.flat(), c.pop, c.popRaw ?? null, c.demo, c.total,
        c.kindShare.resident, c.kindShare.worker, c.kindShare.visitor,
        c.levels.total, c.levels.wdEvening, c.levels.wdNight, c.levels.weNight,
        c.poi.food, c.poi.cafe, c.poi.bar, c.poi.conv, c.poi.hosp, c.poi.pharm, c.poi.gym, c.poi.subway, c.poi.mart,
        c.depts, c.spike ?? null, c.spread?.apt ?? null, c.spread?.building ?? null, c.spread?.area ?? null,
      ]),
      geo,
    );
    await insertMany(
      client,
      'wh_places',
      ['id', 'name', 'cat', 'bar', 'geom'],
      places.map((p) => [p.id, p.name, p.cat, !!p.bar, point(p)]),
      geo,
    );
    await insertMany(
      client,
      'wh_meta',
      ['key', 'value'],
      Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)]),
      { value: '::jsonb' },
    );
    await client.query('COMMIT');
    await client.query('ANALYZE wh_cells; ANALYZE wh_places;');
    console.log(`Imported ${cells.length} cells, ${places.length} places, and ${dongStats.length} districts.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
