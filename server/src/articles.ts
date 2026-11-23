/**
 * 부동산 매물 (wh_articles, scripts/importArticles.ts 로 넣음)
 *  - 거래유형별 건수 (탐색 지역 안): 화면의 유형 칩
 *  - 칸별 매물 수 (고른 유형): 왼쪽 지도 숫자
 *  - 칸 하나의 매물 목록: 오른쪽 지도 핀 · 매물 카드
 * 판매자 이름·전화와 원본(raw)은 내보내지 않는다.
 */
import { pool } from './postgres';

export class NoArticles extends Error {}

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) throw new NoArticles('DB(DATABASE_URL)가 없어 매물을 볼 수 없어요.');
  try {
    return (await pool.query(sql, params)).rows as T[];
  } catch (e: any) {
    if (e?.code === '42P01') throw new NoArticles('매물 데이터가 없어요. `npm run import:articles -w server -- 파일.csv` 로 넣어 주세요.');
    throw e;
  }
}

/** 쉼표로 받은 거래유형 → 목록 (비면 전부) */
export const parseTrades = (s: unknown) =>
  String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10);

/** 분류 · 거래유형별 건수 (탐색 지역 안) */
export async function types(): Promise<{ category: string; trade: string; n: number }[]> {
  return q(
    `SELECT coalesce(category, '주거') AS category, trade_type AS trade, count(*)::int AS n
       FROM wh_articles WHERE cell_id IS NOT NULL AND trade_type IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
  );
}

/** 분류·거래유형 조건 (비면 전부) */
const WHERE_KIND = `(cardinality($1::text[]) = 0 OR coalesce(category, '주거') = ANY($1)) AND (cardinality($2::text[]) = 0 OR trade_type = ANY($2))`;

export async function counts(cats: string[], trades: string[]): Promise<Record<string, number>> {
  const rows = await q<{ cell_id: string; n: number }>(
    `SELECT cell_id, count(*)::int AS n FROM wh_articles
      WHERE cell_id IS NOT NULL AND ${WHERE_KIND}
      GROUP BY 1`,
    [cats, trades],
  );
  return Object.fromEntries(rows.map((r) => [r.cell_id, r.n]));
}

export interface Article {
  id: string;
  category: string;
  name: string | null;
  buildingName: string | null;
  typeName: string | null;
  trade: string | null;
  depositManwon: number | null;
  rentManwon: number | null;
  areaSupply: number | null;
  areaExclusive: number | null;
  floor: string | null;
  direction: string | null;
  confirmedOn: string | null;
  features: string | null;
  tags: string[];
  realtor: string | null;
  provider: string | null;
  lat: number | null;
  lng: number | null;
}

export async function byCell(cell: string, cats: string[], trades: string[]): Promise<Article[]> {
  const rows = await q<any>(
    `SELECT id, coalesce(category, '주거') AS category, name, building_name, type_name, trade_type, deposit_manwon, rent_manwon, area_supply, area_exclusive,
            floor_info, direction, to_char(confirmed_on, 'YYYY-MM-DD') AS confirmed_on, features, tags, realtor_name, cp_name, lat, lng
       FROM wh_articles
      WHERE cell_id = $3 AND ${WHERE_KIND}
      ORDER BY confirmed_on DESC NULLS LAST, deposit_manwon`,
    [cats, trades, cell],
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    name: r.name,
    buildingName: r.building_name,
    typeName: r.type_name,
    trade: r.trade_type,
    depositManwon: r.deposit_manwon === null ? null : Number(r.deposit_manwon),
    rentManwon: r.rent_manwon === null ? null : Number(r.rent_manwon),
    areaSupply: r.area_supply,
    areaExclusive: r.area_exclusive,
    floor: r.floor_info,
    direction: r.direction,
    confirmedOn: r.confirmed_on,
    features: r.features,
    tags: Array.isArray(r.tags) ? r.tags : [],
    realtor: r.realtor_name,
    provider: r.cp_name,
    lat: r.lat,
    lng: r.lng,
  }));
}

/** 필터용 요약 — 탐색 지역 안 매물 전부 (개인정보 없음). 웹이 '매물' 조건을 칸마다 판단할 때 씀 */
export interface ListingLite {
  cell: string;
  cat: string;
  trade: string | null;
  kind: string | null;
  deposit: number | null;
  rent: number | null;
  area: number | null;
  /** 예: '1/5' · 'B1/4' · '저/19' */
  floor: string | null;
  /** 연식 · 층 · 방 · 관리비 · 설비 태그 */
  tags: string[];
  dir: string | null;
}
export async function index(): Promise<ListingLite[]> {
  const rows = await q<any>(
    `SELECT cell_id, coalesce(category, '주거') AS category, trade_type, type_name, deposit_manwon, rent_manwon, area_exclusive,
            floor_info, tags, direction
       FROM wh_articles WHERE cell_id IS NOT NULL`,
  );
  return rows.map((r) => ({
    cell: r.cell_id,
    cat: r.category,
    trade: r.trade_type,
    kind: r.type_name,
    deposit: r.deposit_manwon === null ? null : Number(r.deposit_manwon),
    rent: r.rent_manwon === null ? null : Number(r.rent_manwon),
    area: r.area_exclusive,
    floor: r.floor_info,
    tags: Array.isArray(r.tags) ? r.tags : [],
    dir: r.direction,
  }));
}

/** AI 지시문용: 분류·거래·유형별 건수와 금액 범위 */
export async function forPrompt(): Promise<string> {
  try {
    const rows = await q<any>(
      `SELECT coalesce(category, '주거') AS cat, trade_type AS trade, type_name AS kind, count(*)::int AS n,
              min(deposit_manwon) AS dmin, percentile_disc(0.5) WITHIN GROUP (ORDER BY deposit_manwon) AS dmed, max(deposit_manwon) AS dmax,
              min(rent_manwon) AS rmin, percentile_disc(0.5) WITHIN GROUP (ORDER BY rent_manwon) AS rmed, max(rent_manwon) AS rmax
         FROM wh_articles WHERE cell_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`,
    );
    return rows
      .map((r) => `${r.cat} · ${r.trade} · ${r.kind}: ${r.n}건, 보증금(매매가) ${r.dmin}~${r.dmax}만(중간 ${r.dmed})${r.rmax ? `, 월세 ${r.rmin}~${r.rmax}만(중간 ${r.rmed})` : ''}`)
      .join('\n');
  } catch {
    return '';
  }
}
