/**
 * 생활권 분석 — "거주 셀 + 주변 셀 조합" 평가
 * 셀 ~600개, 시설 수천 건이라 브라우저에서 바로 계산한다.
 */
import type { Cell, CellType, DongStat, LatLng, Level, Listing, Place } from '@shared/types';
import { estimateCommute, walkMin, walkMinToM } from '@shared/geo';
import { CELL_TYPES } from '@shared/cellTypes';

export interface Criteria {
  destIdx: number;
  // 1. 행정동
  maxCommute: number;
  minYouth: Level;
  excludeLowEvening: boolean;
  excludeWeekendCrowded: boolean;
  selectedDongs: string[];
  // 3. 거주 셀 유형
  homeTypes: CellType[];
  // 4. 주변 셀
  radius: number;
  needTypes: CellType[];
  minEat: number;
  // 5. 헬스장
  gymMaxMin: number;
  // 6. 의료
  medRadius: number;
  minDepts: number;
  // 7. 유동인구 패턴
  homeWdNightMax: Level;
  homeWeNightMax: Level;
  nbEveningMin: Level;
}

export const DEFAULT_CRITERIA: Criteria = {
  destIdx: 0,
  maxCommute: 25,
  minYouth: 3,
  excludeLowEvening: true,
  excludeWeekendCrowded: true,
  selectedDongs: [],
  homeTypes: ['quiet', 'living'],
  radius: 500,
  needTypes: ['living', 'commercial'],
  minEat: 15,
  gymMaxMin: 10,
  medRadius: 800,
  minDepts: 5,
  homeWdNightMax: 3,
  homeWeNightMax: 3,
  nbEveningMin: 3,
};

// ---------- 빠른 거리 (성북구 위도 기준 평면 근사) ----------
const M_LAT = 111_000;
const M_LNG = 88_200;
export const fastDist = (a: LatLng, b: LatLng) => Math.hypot((a.lat - b.lat) * M_LAT, (a.lng - b.lng) * M_LNG);

const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export function direction(from: LatLng, to: LatLng) {
  const ang = (Math.atan2((to.lng - from.lng) * M_LNG, (to.lat - from.lat) * M_LAT) * 180) / Math.PI;
  return DIRS[Math.round(((ang + 360) % 360) / 45) % 8];
}

// ---------- 1단계: 행정동 ----------
export interface DongEval {
  dong: DongStat;
  commute: number;
  pass: boolean;
  reasons: string[];
}
export function evalDongs(dongs: DongStat[], dest: LatLng, c: Criteria): DongEval[] {
  return dongs
    .map((d) => {
      const commute = estimateCommute(d.center, dest).min;
      const reasons: string[] = [];
      if (commute > c.maxCommute) reasons.push(`통학 ${commute}분`);
      if (d.youth < c.minYouth) reasons.push('20대 활동 낮음');
      if (c.excludeLowEvening && d.wdEvening <= 1) reasons.push('평일 저녁 활동 매우 낮음');
      if (c.excludeWeekendCrowded && d.weNight >= 5) reasons.push('금~일 야간 과밀');
      return { dong: d, commute, pass: reasons.length === 0, reasons };
    })
    .sort((a, b) => a.commute - b.commute);
}

// ---------- 셀 단위 생활권 지표 ----------
export interface NeighborInfo {
  cell: Cell;
  dist: number;
  dir: string;
}
export interface CellEval {
  cell: Cell;
  commute: number;
  commuteMode: 'walk' | 'transit';
  neighbors: NeighborInfo[]; // radius 이내 (자기 자신 제외)
  /** 유형별 가장 가까운 주변 셀 */
  nearestByType: Partial<Record<CellType, NeighborInfo>>;
  eatInRadius: number;
  nearestGym: { place: Place; dist: number } | null;
  hospCount: number;
  pharmCount: number;
  depts: string[];
  /** 주변 생활상권 활동도: 주변 비녹지 셀 중 평일 16~24 상위 3개 평균 */
  nbEvening: Level;
  checks: Check[];
  passedUpTo: number; // 통과한 마지막 단계 (3~7), 0이면 후보 풀 밖
  score: number;
  label: string;
  summary: string;
}

export interface Check {
  step: number;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Ctx {
  cells: Cell[];
  places: Place[];
  dest: LatLng;
}

/** 무거운 공간 계산은 radius/medRadius/목적지에만 의존 → 별도 메모이즈 */
export function computeSpatial(ctx: Ctx, radius: number, medRadius: number) {
  const { cells, places } = ctx;
  const gyms = places.filter((p) => p.cat === 'gym');
  const eat = places.filter((p) => p.cat === 'food' || p.cat === 'cafe');
  const med = places.filter((p) => p.cat === 'hosp' || p.cat === 'pharm');
  const out = new Map<string, Omit<CellEval, 'checks' | 'passedUpTo' | 'score' | 'label' | 'summary'>>();

  for (const cell of cells) {
    const neighbors: NeighborInfo[] = [];
    const nearestByType: CellEval['nearestByType'] = {};
    for (const o of cells) {
      if (o === cell) continue;
      const dist = fastDist(cell.center, o.center);
      if (dist > radius) continue;
      const n = { cell: o, dist, dir: direction(cell.center, o.center) };
      neighbors.push(n);
      const prev = nearestByType[o.type];
      if (!prev || prev.dist > dist) nearestByType[o.type] = n;
    }
    neighbors.sort((a, b) => a.dist - b.dist);

    let eatInRadius = 0;
    for (const p of eat) if (fastDist(cell.center, p) <= radius) eatInRadius++;

    let nearestGym: CellEval['nearestGym'] = null;
    for (const g of gyms) {
      const d = fastDist(cell.center, g);
      if (!nearestGym || d < nearestGym.dist) nearestGym = { place: g, dist: d };
    }

    let hospCount = 0;
    let pharmCount = 0;
    const depts = new Set<string>();
    for (const p of med) {
      if (fastDist(cell.center, p) > medRadius) continue;
      if (p.cat === 'pharm') pharmCount++;
      else {
        hospCount++;
        if (p.dept) depts.add(p.dept);
      }
    }

    const ev = neighbors
      .filter((n) => n.cell.type !== 'green')
      .map((n) => n.cell.levels.wdEvening)
      .sort((a, b) => b - a)
      .slice(0, 3);
    const nbEvening = (ev.length ? Math.round(ev.reduce((s, x) => s + x, 0) / ev.length) : 1) as Level;

    const cm = estimateCommute(cell.center, ctx.dest);
    out.set(cell.id, {
      cell,
      commute: cm.min,
      commuteMode: cm.mode,
      neighbors,
      nearestByType,
      eatInRadius,
      nearestGym,
      hospCount,
      pharmCount,
      depts: [...depts].sort(),
      nbEvening,
    });
  }
  return out;
}

export function evaluateCells(spatial: ReturnType<typeof computeSpatial>, c: Criteria, dongPass: Set<string>): CellEval[] {
  const res: CellEval[] = [];
  for (const s of spatial.values()) {
    const cell = s.cell;
    const inPool = c.selectedDongs.length ? c.selectedDongs.includes(cell.dongCode) : dongPass.has(cell.dongCode);
    const commuteOk = s.commute <= c.maxCommute;
    const nbTypes = c.needTypes.filter((t) => s.nearestByType[t]);
    const gymMin = s.nearestGym ? walkMin(s.nearestGym.dist) : Infinity;

    const checks: Check[] = [
      { step: 3, label: '거주 셀 유형', ok: c.homeTypes.includes(cell.type), detail: CELL_TYPES[cell.type].label },
      {
        step: 4,
        label: `주변 ${c.radius}m 생활기능`,
        ok: (c.needTypes.length === 0 || nbTypes.length > 0) && s.eatInRadius >= c.minEat,
        detail: `${nbTypes.length ? nbTypes.map((t) => CELL_TYPES[t].label).join('·') : '필요 유형 없음'} / 음식점·카페 ${s.eatInRadius}곳`,
      },
      {
        step: 5,
        label: `헬스장 도보 ${c.gymMaxMin}분`,
        ok: gymMin <= c.gymMaxMin,
        detail: s.nearestGym ? `최근접 ${Math.round(s.nearestGym.dist)}m (약 ${Math.round(gymMin)}분)` : '없음',
      },
      {
        step: 6,
        label: `의료 ${c.medRadius}m`,
        ok: s.depts.length >= c.minDepts,
        detail: `병원 ${s.hospCount}곳 · 진료과 ${s.depts.length}종`,
      },
      {
        step: 7,
        label: '시간대 패턴',
        ok: cell.levels.wdNight <= c.homeWdNightMax && cell.levels.weNight <= c.homeWeNightMax && s.nbEvening >= c.nbEveningMin,
        detail: `거주셀 평일밤 ${cell.levels.wdNight}·주말밤 ${cell.levels.weNight} / 주변 저녁 ${s.nbEvening}`,
      },
    ];

    let passedUpTo = 0;
    if (inPool && commuteOk) {
      passedUpTo = 2;
      for (const ch of checks) {
        if (!ch.ok) break;
        passedUpTo = ch.step;
      }
    }

    // 점수: 조건 통과 여부와 별개로 "얼마나 균형이 좋은가" (후보 정렬용)
    const score =
      30 * Math.max(0, 1 - s.commute / Math.max(c.maxCommute, 1) / 1.5) +
      15 * Math.max(0, 1 - gymMin / 15) +
      15 * Math.min(1, s.depts.length / 8) +
      15 * Math.min(1, s.eatInRadius / Math.max(c.minEat * 2, 1)) +
      12 * ((s.nbEvening - 1) / 4) +
      13 * ((5 - cell.levels.weNight) / 4);

    const { label, summary } = interpret({ ...s, checks } as CellEval);
    res.push({ ...s, checks, passedUpTo, score: Math.round(score), label, summary });
  }
  return res;
}

/** 셀 조합을 사람이 읽는 문장으로 */
export function interpret(e: CellEval): { label: string; summary: string } {
  const home = e.cell.type;
  const quietHome = home === 'quiet' || home === 'living';
  const shop = e.nearestByType.commercial ?? e.nearestByType.campus ?? e.nearestByType.living;
  const med = e.nearestByType.medical;
  const crowded = e.cell.levels.weNight >= 4;
  const walk = (m: number) => Math.max(1, Math.round(walkMin(m)));

  if (!quietHome) {
    return {
      label: `${CELL_TYPES[home].label} 셀`,
      summary: `셀 자체가 ${CELL_TYPES[home].label}이라 생활은 편하지만 집 주변이 붐빌 수 있는 지역`,
    };
  }
  if (crowded) {
    return { label: '생활 편의 높음 · 주말 혼잡', summary: '생활하기 편하지만 금~일 야간 혼잡도가 높은 지역' };
  }
  if (!shop || e.eatInRadius < 8 || e.nbEvening <= 2) {
    return { label: '매우 조용 · 생활편의 부족', summary: '매우 조용하지만 음식점과 생활편의시설 접근성이 낮은 지역' };
  }
  const parts = [`도보 ${walk(shop.dist)}분 내 생활상권`];
  if (med) parts.push('의료시설');
  return {
    label: `${home === 'quiet' ? '조용한 주거' : '생활 주거'} + 생활상권 접근형`,
    summary: `${home === 'quiet' ? '조용한' : '생활 편의가 갖춰진'} 주거지역이며, ${parts.join('과 ')} 접근성이 좋은 지역`,
  };
}

// ---------- 매물 좌표 기준 재계산 ----------
export interface ListingEval {
  listing: Listing;
  commute: number;
  gym: number | null;
  shop: number | null;
  medical: number | null;
  weNight: Level;
}
export function evalListing(l: Listing, ctx: Ctx, cellById: Map<string, Cell>): ListingEval {
  const near = (pred: (c: Cell) => boolean) => {
    let best: number | null = null;
    for (const c of ctx.cells) if (pred(c)) {
      const d = fastDist(l, c.center);
      if (best === null || d < best) best = d;
    }
    return best;
  };
  let gym: number | null = null;
  for (const p of ctx.places) if (p.cat === 'gym') {
    const d = fastDist(l, p);
    if (gym === null || d < gym) gym = d;
  }
  return {
    listing: l,
    commute: estimateCommute(l, ctx.dest).min,
    gym,
    shop: near((c) => c.type === 'commercial' || c.type === 'campus'),
    medical: near((c) => c.type === 'medical'),
    weNight: cellById.get(l.cellId)?.levels.weNight ?? 1,
  };
}

export const gymRadiusM = walkMinToM;
