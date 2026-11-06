/**
 * 필터 스택 — 사용자가 필터를 임의로 쌓아 위에서부터 차례로 셀을 걸러낸다.
 *
 * 필터 대상
 *  - 셀 조건(cell): [이 셀] 또는 [주변 Rm 안의 셀 중 N개 이상]이 조건을 만족하는지
 *  - 시설 조건(place): 셀 중심에서 가장 가까운 시설 거리 / 반경 안 시설 수 / 반경 안 진료과 수
 *  - 통학(commute), 행정동(dong)
 *
 * 계산 범위: 지도 화면에 보이는 셀만 걸러내지만, 주변 셀·시설은 화면 밖(성북구 전체 데이터)까지 넓혀 계산한다.
 */
import type { Cell, CellType, LatLng, Level, Place, PlaceCat } from '@shared/types';
import { CELL_TYPES, CELL_TYPE_ORDER, LEVEL_LABEL } from '@shared/cellTypes';
import { estimateCommute, walkMin } from '@shared/geo';
import { fastDist } from './analysis';

// ---------------------------------------------------------------- 정의
export type LevelMetric = 'total' | 'wdEvening' | 'wdNight' | 'weNight' | 'youth';
export type Op = 'gte' | 'lte';
/** 셀 안 시설 수 집계 키 (bar = 술집 계열 음식점, eat = 음식점+카페) */
export type PoiKey = PlaceCat | 'bar' | 'eat';

export type Target = { mode: 'self' } | { mode: 'around'; radius: number; op: Op; count: number };

export type CellCond =
  | { kind: 'type'; types: CellType[] }
  | { kind: 'level'; metric: LevelMetric; op: Op; value: Level }
  | { kind: 'poi'; key: PoiKey; op: Op; value: number };

export type PlaceCond =
  | { kind: 'nearest'; key: PoiKey; maxWalkMin: number }
  | { kind: 'count'; key: PoiKey; radius: number; min: number }
  | { kind: 'depts'; radius: number; min: number };

export type Dest = { name: string; lat: number; lng: number };

interface Base {
  id: string;
  enabled: boolean;
}
export type FilterDef =
  | (Base & { type: 'cell'; target: Target; cond: CellCond })
  | (Base & { type: 'place'; cond: PlaceCond })
  | (Base & { type: 'commute'; maxMin: number; dest: Dest })
  | (Base & { type: 'dong'; codes: string[] });

// ---------------------------------------------------------------- 라벨
export const METRIC_LABEL: Record<LevelMetric, string> = {
  total: '전체 유동인구',
  wdEvening: '평일 16~24시 활동',
  wdNight: '평일 20~24시 유동인구',
  weNight: '금~일 20~24시 혼잡도',
  youth: '20대 활동',
};
export const POI_LABEL: Record<PoiKey, string> = {
  food: '음식점',
  cafe: '카페',
  eat: '음식점·카페',
  bar: '술집',
  conv: '편의점',
  hosp: '병원',
  pharm: '약국',
  gym: '헬스장',
  subway: '지하철역',
  mart: '대형마트',
};
const opText = (op: Op) => (op === 'gte' ? '이상' : '이하');

function condText(c: CellCond): string {
  if (c.kind === 'type') {
    if (!c.types.length) return '(유형 없음)';
    // 고른 유형보다 빠진 유형이 적으면 "~ 아님"으로 짧게
    const excluded = CELL_TYPE_ORDER.filter((t) => !c.types.includes(t));
    if (excluded.length && excluded.length < c.types.length) return `${excluded.map((t) => CELL_TYPES[t].label).join('·')} 아님`;
    return c.types.map((t) => CELL_TYPES[t].label).join('·');
  }
  if (c.kind === 'level') return `${METRIC_LABEL[c.metric]} ${LEVEL_LABEL[c.value]} ${opText(c.op)}`;
  return `셀 안 ${POI_LABEL[c.key]} ${c.value}곳 ${opText(c.op)}`;
}

/** 필터를 사람이 읽는 한 줄로 */
export function describe(f: FilterDef, dongName?: (code: string) => string): string {
  switch (f.type) {
    case 'commute':
      return `${f.dest.name}까지 ${f.maxMin}분 이내`;
    case 'dong':
      return f.codes.length ? `행정동: ${f.codes.map((c) => dongName?.(c) ?? c).join(', ')}` : '행정동: (선택 없음)';
    case 'place': {
      const c = f.cond;
      if (c.kind === 'nearest') return `가장 가까운 ${POI_LABEL[c.key]} 도보 ${c.maxWalkMin}분 이내`;
      if (c.kind === 'count') return `반경 ${c.radius}m 안 ${POI_LABEL[c.key]} ${c.min}곳 이상`;
      return `반경 ${c.radius}m 안 병원 진료과 ${c.min}종 이상`;
    }
    case 'cell': {
      const t = f.target;
      if (t.mode === 'self') return f.cond.kind === 'type' ? `이 셀이 ${condText(f.cond)}` : `이 셀: ${condText(f.cond)}`;
      const what = f.cond.kind === 'type' ? condText(f.cond) : `[${condText(f.cond)}]`;
      if (t.op === 'lte' && t.count === 0) return `주변 ${t.radius}m 안에 ${what} 셀 없음`;
      return `주변 ${t.radius}m 안에 ${what} 셀 ${t.count}개 ${opText(t.op)}`;
    }
  }
}

// ---------------------------------------------------------------- 계산 컨텍스트
export interface FilterCtx {
  cells: Cell[];
  neighbors: (cell: Cell, radius: number) => Cell[];
  placesNear: (p: LatLng, radius: number, key: PoiKey | 'hospAll') => Place[];
  nearest: (p: LatLng, key: PoiKey) => { place: Place; dist: number } | null;
}

const matchKey = (p: Place, key: PoiKey | 'hospAll') =>
  key === 'eat' ? p.cat === 'food' || p.cat === 'cafe' : key === 'bar' ? !!p.bar : key === 'hospAll' ? p.cat === 'hosp' : p.cat === key;

/** 셀 ~600개 · 시설 ~2만 건 규모. 시설은 약 220m 버킷으로 공간 색인 */
export function makeFilterCtx(cells: Cell[], places: Place[]): FilterCtx {
  const BLAT = 0.002;
  const BLNG = 0.0025;
  const buckets = new Map<string, Place[]>();
  const bkey = (i: number, j: number) => `${i}:${j}`;
  for (const p of places) {
    const k = bkey(Math.floor(p.lat / BLAT), Math.floor(p.lng / BLNG));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const placesNear = (c: LatLng, radius: number, key: PoiKey | 'hospAll') => {
    const out: Place[] = [];
    const di = Math.ceil(radius / 111_000 / BLAT);
    const dj = Math.ceil(radius / 88_200 / BLNG);
    const ci = Math.floor(c.lat / BLAT);
    const cj = Math.floor(c.lng / BLNG);
    for (let i = ci - di; i <= ci + di; i++)
      for (let j = cj - dj; j <= cj + dj; j++)
        for (const p of buckets.get(bkey(i, j)) ?? []) if (matchKey(p, key) && fastDist(c, p) <= radius) out.push(p);
    return out;
  };

  const nearestMemo = new Map<string, { place: Place; dist: number } | null>();
  const byKey = new Map<PoiKey, Place[]>();
  const nearest = (c: LatLng, key: PoiKey) => {
    const mk = `${c.lat},${c.lng},${key}`;
    if (nearestMemo.has(mk)) return nearestMemo.get(mk)!;
    // 가까운 범위부터 넓혀 찾고, 없으면 전체 탐색
    for (const r of [300, 800, 2000]) {
      const near = placesNear(c, r, key);
      if (near.length) {
        let best = near[0];
        let bd = fastDist(c, best);
        for (const p of near) {
          const d = fastDist(c, p);
          if (d < bd) [best, bd] = [p, d];
        }
        const res = { place: best, dist: bd };
        nearestMemo.set(mk, res);
        return res;
      }
    }
    if (!byKey.has(key)) byKey.set(key, places.filter((p) => matchKey(p, key)));
    let res: { place: Place; dist: number } | null = null;
    for (const p of byKey.get(key)!) {
      const d = fastDist(c, p);
      if (!res || d < res.dist) res = { place: p, dist: d };
    }
    nearestMemo.set(mk, res);
    return res;
  };

  const nbMemo = new Map<number, Map<string, Cell[]>>();
  const neighbors = (cell: Cell, radius: number) => {
    let m = nbMemo.get(radius);
    if (!m) nbMemo.set(radius, (m = new Map()));
    let r = m.get(cell.id);
    if (!r) {
      r = cells.filter((o) => o !== cell && fastDist(cell.center, o.center) <= radius);
      m.set(cell.id, r);
    }
    return r;
  };

  return { cells, neighbors, placesNear, nearest };
}

// ---------------------------------------------------------------- 평가
const cmp = (v: number, op: Op, x: number) => (op === 'gte' ? v >= x : v <= x);

function poiValue(cell: Cell, key: PoiKey) {
  if (key === 'eat') return cell.poi.food + cell.poi.cafe;
  return cell.poi[key];
}

function cellMatches(cell: Cell, c: CellCond): boolean {
  if (c.kind === 'type') return c.types.includes(cell.type);
  if (c.kind === 'level') return cmp(cell.levels[c.metric], c.op, c.value);
  return cmp(poiValue(cell, c.key), c.op, c.value);
}

export interface FilterResult {
  ok: boolean;
  detail: string;
}

export function evalFilter(f: FilterDef, cell: Cell, ctx: FilterCtx): FilterResult {
  switch (f.type) {
    case 'commute': {
      const m = estimateCommute(cell.center, f.dest).min;
      return { ok: m <= f.maxMin, detail: `${f.dest.name}까지 약 ${m}분` };
    }
    case 'dong':
      return { ok: f.codes.length === 0 || f.codes.includes(cell.dongCode), detail: cell.dongName };
    case 'place': {
      const c = f.cond;
      if (c.kind === 'nearest') {
        const n = ctx.nearest(cell.center, c.key);
        if (!n) return { ok: false, detail: `${POI_LABEL[c.key]} 없음` };
        const m = walkMin(n.dist);
        return { ok: m <= c.maxWalkMin, detail: `${n.place.name} ${Math.round(n.dist)}m (도보 약 ${Math.round(m)}분)` };
      }
      if (c.kind === 'count') {
        const n = ctx.placesNear(cell.center, c.radius, c.key).length;
        return { ok: n >= c.min, detail: `${POI_LABEL[c.key]} ${n}곳` };
      }
      const hs = ctx.placesNear(cell.center, c.radius, 'hospAll');
      const depts = new Set(hs.map((h) => h.dept).filter(Boolean));
      return { ok: depts.size >= c.min, detail: `병원 ${hs.length}곳 · 진료과 ${depts.size}종` };
    }
    case 'cell': {
      if (f.target.mode === 'self') {
        const ok = cellMatches(cell, f.cond);
        const c = f.cond;
        const detail =
          c.kind === 'type' ? CELL_TYPES[cell.type].label : c.kind === 'level' ? `${METRIC_LABEL[c.metric]} ${LEVEL_LABEL[cell.levels[c.metric]]}` : `${POI_LABEL[c.key]} ${poiValue(cell, c.key)}곳`;
        return { ok, detail };
      }
      const nb = ctx.neighbors(cell, f.target.radius);
      const n = nb.filter((o) => cellMatches(o, f.cond)).length;
      return { ok: cmp(n, f.target.op, f.target.count), detail: `해당 셀 ${n}개 / 주변 ${nb.length}개` };
    }
  }
}

/** 스택 실행: 각 필터 뒤에 남은 셀 집합 */
export function runStack(stack: FilterDef[], pool: Cell[], ctx: FilterCtx) {
  const stages: { filter: FilterDef; survivors: Cell[] }[] = [];
  let cur = pool;
  for (const f of stack) {
    if (f.enabled) cur = cur.filter((c) => evalFilter(f, c, ctx).ok);
    stages.push({ filter: f, survivors: cur });
  }
  return { pool, stages, final: cur };
}

// ---------------------------------------------------------------- 새 필터
let seq = 0;
export const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 새 필터의 초기값 (추가 직후 편집기가 열리고 사용자가 값을 정함) */
export const blankFilter = (type: FilterDef['type'], dest: Dest): FilterDef => {
  const id = newId();
  if (type === 'cell') return { id, enabled: true, type, target: { mode: 'around', radius: 500, op: 'gte', count: 1 }, cond: { kind: 'type', types: ['commercial'] } };
  if (type === 'place') return { id, enabled: true, type, cond: { kind: 'count', key: 'cafe', radius: 400, min: 5 } };
  if (type === 'commute') return { id, enabled: true, type, maxMin: 20, dest };
  return { id, enabled: true, type, codes: [] };
};
