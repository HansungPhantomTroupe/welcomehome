/**
 * PostgreSQL + PostGIS 저장소
 *
 * 테이블 (만드는 곳: scripts/importGenerated.ts)
 *  wh_dongs   행정동
 *  wh_cells   200m 칸 — 경계(Polygon)·중심(Point) + 인구·시설 개수 컬럼
 *  wh_places  가게·시설 — 위치(Point, GiST 인덱스). 화면으로는 보내지 않고 거리 계산에만 쓴다
 *  wh_meta    목적지 등 설정 값
 *
 * 칸마다 '종류별 가장 가까운 시설까지 거리'는 요청 때 PostGIS 가 계산한다 (KNN).
 */
import pg from 'pg';
import './config';
import { NEAR_KINDS, type Cell, type DongStat, type Meta } from '../../shared/types';

const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new pg.Pool({ connectionString }) : null;

pool?.on('error', (error) => {
  console.error('PostgreSQL idle connection failed:', error.message);
});

export const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS wh_dongs (
  code text PRIMARY KEY,
  name text NOT NULL,
  center geometry(Point, 4326),
  cell_count int,
  commute_min int,
  wd_evening smallint,
  we_night smallint,
  type_counts jsonb
);

CREATE TABLE IF NOT EXISTS wh_cells (
  id text PRIMARY KEY,
  dong_code text NOT NULL REFERENCES wh_dongs(code),
  dong_name text NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL,
  center geometry(Point, 4326) NOT NULL,
  lgu_id text,
  slots double precision[] NOT NULL,      -- [요일묶음*4 + 시간대] 8개
  pop double precision[] NOT NULL,        -- 24개
  pop_raw double precision[],             -- 24개 (튀는 값 퍼뜨리기 전)
  demo double precision[] NOT NULL,       -- 72개
  total double precision NOT NULL,        -- 전체 시간대 평균 인원
  share_resident double precision NOT NULL,
  share_worker double precision NOT NULL,
  share_visitor double precision NOT NULL,
  level_total smallint NOT NULL,
  level_wd_evening smallint NOT NULL,
  level_wd_night smallint NOT NULL,
  level_we_night smallint NOT NULL,
  poi_food int NOT NULL, poi_cafe int NOT NULL, poi_bar int NOT NULL, poi_conv int NOT NULL, poi_hosp int NOT NULL,
  poi_pharm int NOT NULL, poi_gym int NOT NULL, poi_subway int NOT NULL, poi_mart int NOT NULL,
  depts text[] NOT NULL,
  spike int,
  spread_apt int, spread_building int, spread_area int
);
CREATE INDEX IF NOT EXISTS wh_cells_geom ON wh_cells USING gist (geom);

CREATE TABLE IF NOT EXISTS wh_places (
  id text PRIMARY KEY,
  name text NOT NULL,
  cat text NOT NULL,
  bar boolean NOT NULL DEFAULT false,
  geom geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS wh_places_geom ON wh_places USING gist (geom);
CREATE INDEX IF NOT EXISTS wh_places_cat ON wh_places (cat);

CREATE TABLE IF NOT EXISTS wh_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
`;

const NEAR_SQL = `
SELECT c.id, k.kind, n.m, n.name
FROM wh_cells c
CROSS JOIN unnest($1::text[]) AS k(kind)
LEFT JOIN LATERAL (
  -- 평면 KNN 으로 후보 8곳을 고른 뒤 실제 거리(geography)로 가장 가까운 곳
  SELECT round(ST_Distance(c.center::geography, p.geom::geography))::int AS m, p.name
  FROM (
    SELECT geom, name FROM wh_places p
    WHERE CASE WHEN k.kind = 'bar' THEN p.bar ELSE p.cat = k.kind END
    ORDER BY p.geom <-> c.center
    LIMIT 8
  ) p
  ORDER BY 1
  LIMIT 1
) n ON true`;

const CELLS_SQL = `
SELECT id, dong_code, dong_name, lgu_id,
  ST_Y(center) AS lat, ST_X(center) AS lng,
  (SELECT json_agg(json_build_object('lat', ST_Y(pt.geom), 'lng', ST_X(pt.geom)) ORDER BY pt.path)
     FROM ST_DumpPoints(ST_ExteriorRing(geom)) pt WHERE pt.path[1] <= 4) AS corners,
  slots, pop, pop_raw, demo, total, share_resident, share_worker, share_visitor,
  level_total, level_wd_evening, level_wd_night, level_we_night,
  poi_food, poi_cafe, poi_bar, poi_conv, poi_hosp, poi_pharm, poi_gym, poi_subway, poi_mart,
  depts, spike, spread_apt, spread_building, spread_area
FROM wh_cells ORDER BY id`;

/** 화면에 내려줄 데이터 전체 (시설 목록은 빼고, 칸마다 가까운 시설 거리를 붙임) */
export async function readBootstrap(): Promise<{ cells: Cell[]; dongStats: DongStat[]; meta: Meta } | null> {
  if (!pool) return null;
  try {
    const [cellRows, nearRows, dongRows, metaRows] = await Promise.all([
      pool.query(CELLS_SQL),
      pool.query(NEAR_SQL, [NEAR_KINDS]),
      pool.query(`SELECT code, name, ST_Y(center) AS lat, ST_X(center) AS lng, cell_count, commute_min, wd_evening, we_night, type_counts FROM wh_dongs ORDER BY code`),
      pool.query(`SELECT key, value FROM wh_meta`),
    ]);
    if (!cellRows.rows.length) return null;

    const near = new Map<string, Record<string, { m: number | null; name: string | null }>>();
    for (const r of nearRows.rows) (near.get(r.id) ?? near.set(r.id, {}).get(r.id)!)[r.kind] = { m: r.m, name: r.name };

    const cells: Cell[] = cellRows.rows.map((r) => {
      const n = near.get(r.id) ?? {};
      const cell: Cell = {
        id: r.id,
        center: { lat: r.lat, lng: r.lng },
        corners: r.corners,
        dongCode: r.dong_code,
        dongName: r.dong_name,
        slots: [r.slots.slice(0, 4), r.slots.slice(4, 8)] as Cell['slots'],
        pop: r.pop,
        demo: r.demo,
        total: r.total,
        kindShare: { resident: r.share_resident, worker: r.share_worker, visitor: r.share_visitor },
        levels: { total: r.level_total, wdEvening: r.level_wd_evening, wdNight: r.level_wd_night, weNight: r.level_we_night },
        poi: { food: r.poi_food, cafe: r.poi_cafe, bar: r.poi_bar, conv: r.poi_conv, hosp: r.poi_hosp, pharm: r.poi_pharm, gym: r.poi_gym, subway: r.poi_subway, mart: r.poi_mart },
        depts: r.depts,
        nearM: Object.fromEntries(NEAR_KINDS.map((k) => [k, n[k]?.m ?? null])) as Cell['nearM'],
        nearSubway: n.subway?.m != null ? { name: n.subway.name!, m: n.subway.m } : null,
      };
      if (r.pop_raw) cell.popRaw = r.pop_raw;
      if (r.lgu_id) cell.lguId = r.lgu_id;
      if (r.spike) cell.spike = r.spike;
      if (r.spike) cell.spread = { apt: r.spread_apt ?? 0, building: r.spread_building ?? 0, area: r.spread_area ?? 0 };
      return cell;
    });
    const dongStats: DongStat[] = dongRows.rows.map((r) => ({
      code: r.code,
      name: r.name,
      center: { lat: r.lat, lng: r.lng },
      cellCount: r.cell_count,
      commuteMin: r.commute_min,
      wdEvening: r.wd_evening,
      weNight: r.we_night,
      typeCounts: r.type_counts ?? {},
    }));
    const meta = Object.fromEntries(metaRows.rows.map((r) => [r.key, r.value])) as unknown as Meta;
    return { cells, dongStats, meta };
  } catch (error) {
    console.error('PostgreSQL bootstrap failed:', error instanceof Error ? error.message : error);
    return null;
  }
}
