/**
 * 조건 엔진 — 주거지 종류 분류와 조건으로 찾기가 같이 쓴다. 모든 조건은 구역 하나 안의 값으로 판단.
 *
 * 조건 = [무엇을] + [조합 선택] + 기준
 *  - 유동인구: 요일(평일·주말) × 시간대(4) × 인구 종류(거주·직장·방문) × 연령(6) × 성별(2) 를 체크로 골라 합산 → 인원 또는 비율
 *    (연령·성별은 시간대 구분이 없어, 칸·요일·종류마다의 성별·연령 비율을 시간대 인원에 곱한다)
 *  - 가게·시설: 종류를 체크로 골라 구역 안 개수 합산
 *  - 진료과: 구역 안 병원 진료과 종류 수
 * 기준 = 이상/이하 + 값(절대값) 또는 전체 구역 중 상위·하위 % 또는 단계(매우 한적~혼잡, 전체 구역 자연적 단절)
 */
import type { Cell } from '@shared/types';
import { AGE_GROUPS, CELL_TYPES, POP_KINDS, SEX_GROUPS, TIME_SLOTS } from '@shared/cellTypes';

// ---------------------------------------------------------------- 조합 축
export const DAYS = ['평일', '주말'] as const; // 월~목 / 금~일
export const DAY_HINT = ['월~목', '금~일'] as const;
export const TIMES = TIME_SLOTS;
/** 시간대 시작·끝 시각 (붙어 있는 시간대를 "17~24시" 처럼 묶을 때) */
const TIME_FROM = [8, 13, 17, 21];
const TIME_TO = [12, 16, 20, 24];
export const KINDS = POP_KINDS;
export const AGES = AGE_GROUPS;
export const SEXES = SEX_GROUPS;

export const POI_CATS = {
  food: '음식점',
  cafe: '카페',
  bar: '술집',
  conv: '편의점',
  hosp: '병원',
  pharm: '약국',
  gym: '헬스장',
  subway: '지하철역',
  mart: '대형마트',
} as const;
export type PoiCat = keyof typeof POI_CATS;
/** 드문 시설 — 구역 안에 있는 곳이 거의 없어 '가까운 곳(거리)'을 기본으로 */
export const POI_BY_DIST: PoiCat[] = ['subway', 'mart'];
export const POI_KEYS = Object.keys(POI_CATS) as PoiCat[];

/**
 * 기준: 이상(gte) · 이하(lte) · 사이(between: value ~ value2)
 *  - mode abs: 값 그대로 / pct: 전체 구역 상위·하위 % / level: 단계 번호(0~4) 범위 — value ~ value2
 * adv: 세부 설정으로 편집 / deg: 예전 간단 모드의 정도 / scope: 세부 설정 그래프 범위 (all = 전체 구역) — 모두 화면용, 계산과는 무관
 */
type Crit = { op: 'gte' | 'lte' | 'between'; mode: 'abs' | 'pct' | 'level'; value: number; value2?: number; adv?: boolean; deg?: number; scope?: 'view' | 'all' };
export type Cond =
  /** kinds: 인구 종류 (0 거주 · 1 직장 · 2 방문, 셋 다 = 전체) · ages: 연령 0~5 (20대 미만~60대 이상) · sexes: 0 남 · 1 여 */
  | (Crit & { src: 'pop'; days: number[]; times: number[]; kinds: number[]; ages: number[]; sexes: number[]; measure: 'count' | 'share' })
  /** by: count = 구역 안 개수 / dist = 가장 가까운 곳까지 거리(m) */
  | (Crit & { src: 'poi'; cats: PoiCat[]; by?: 'count' | 'dist' })
  | (Crit & { src: 'depts' });

/** 사람 수 단계 — 전체 구역 값을 로그로 바꾼 뒤 자연적 단절(Jenks)로 5구간 (소수 칸의 아주 큰 값에 경계가 끌려가지 않게) */
export const LEVELS = ['매우 한적', '한적', '보통', '활기참', '혼잡'] as const;
/** 단계 색 (매우 한적 → 혼잡) */
export const LEVEL_COLORS = ['#bfe8d2', '#8dd3ae', '#fde58a', '#fba95e', '#e57373'] as const;
/** 단계 조건 문장 — op: 이상(gte, value 부터) · 이하(lte, value2 까지) · 해당 단계만(between) */
export function levelText(op: Crit['op'], lo: number, hi: number) {
  if (op === 'gte') return `${LEVELS[lo]} 이상`;
  if (op === 'lte') return `${LEVELS[hi]} 이하`;
  return lo === hi ? `${LEVELS[lo]}만` : `${LEVELS[lo]}~${LEVELS[hi]}`;
}

const ALL = { days: [0, 1], times: [0, 1, 2, 3], kinds: [0, 1, 2], ages: [0, 1, 2, 3, 4, 5], sexes: [0, 1] };
export const newPopCond = (p: Partial<Extract<Cond, { src: 'pop' }>> = {}): Cond => ({ src: 'pop', ...ALL, measure: 'count', op: 'gte', mode: 'level', value: 2, value2: 4, ...p });
export const newPoiCond = (cats: PoiCat[] = ['cafe'], p: Partial<Crit> = {}): Cond => ({ src: 'poi', cats, op: 'gte', mode: 'abs', value: 1, ...p });
export const newCond = (src: Cond['src'] = 'pop'): Cond => (src === 'pop' ? newPopCond() : src === 'poi' ? newPoiCond() : { src: 'depts', op: 'gte', mode: 'abs', value: 3 });

// ---------------------------------------------------------------- 값 계산
const idx = (d: number, t: number, k: number) => (d * 4 + t) * 3 + k;
/** 칸의 요일 d · 종류 k 인원 중 고른 성별·연령이 차지하는 비율 */
const demoShare = (cell: Cell, d: number, k: number, ages: number[], sexes: number[]) => {
  if (ages.length === 6 && sexes.length === 2) return 1;
  let v = 0;
  for (const s of sexes) for (const a of ages) v += cell.demo?.[((d * 3 + k) * 2 + s) * 6 + a] ?? 1 / 12;
  return v;
};
const sumPop = (cell: Cell, days: number[], times: number[], kinds: number[], ages: number[] = ALL.ages, sexes: number[] = ALL.sexes) => {
  let v = 0;
  for (const d of days)
    for (const k of kinds) {
      const share = demoShare(cell, d, k, ages, sexes);
      for (const t of times) v += (cell.pop[idx(d, t, k)] ?? 0) * share;
    }
  return v;
};

/** 셀 값: 유동인구 인원은 '고른 요일·시간대 1칸(4시간)당 평균', 비율은 % */
export function condValue(cell: Cell, c: Cond): number {
  if (c.src === 'poi' && c.by === 'dist') return Math.round(Math.min(...c.cats.map((k) => cell.nearM?.[k] ?? Infinity)));
  if (c.src === 'poi') return c.cats.reduce((s, k) => s + (cell.poi[k] ?? 0), 0);
  if (c.src === 'depts') return cell.depts.length;
  const slots = Math.max(1, c.days.length * c.times.length);
  const sel = sumPop(cell, c.days, c.times, c.kinds, c.ages, c.sexes);
  if (c.measure === 'count') return Math.round(sel / slots);
  // 비율 (같은 요일·시간대 안에서):
  //  - 연령·성별을 좁혔으면 고른 인구 종류 중 그 연령·성별 비율 (예: 거주 인구 중 20대 여성)
  //  - 인구 종류만 좁혔으면 전체 인구 중 그 종류 비율 (예: 직장 인구 비율)
  //  - 아무것도 안 좁혔으면 하루 전체 중 고른 요일·시간대 비율
  const demoNarrowed = c.ages.length < 6 || c.sexes.length < 2;
  const base = demoNarrowed
    ? sumPop(cell, c.days, c.times, c.kinds)
    : c.kinds.length < 3
      ? sumPop(cell, c.days, c.times, ALL.kinds)
      : sumPop(cell, ALL.days, ALL.times, ALL.kinds);
  return base > 0 ? +((sel / base) * 100).toFixed(1) : 0;
}

export function condUnit(c: Cond) {
  return c.src === 'poi' ? (c.by === 'dist' ? 'm' : '곳') : c.src === 'depts' ? '종' : c.measure === 'share' ? '%' : '명';
}

// ---------------------------------------------------------------- 설명 문장
const join = (xs: readonly string[], idxs: number[], all: number) => (idxs.length === all ? '' : [...idxs].sort().map((i) => xs[i]).join('·'));

/** 고른 조합 요약: "평일 21~24시 거주 인구" */
export function condSubject(c: Cond): string {
  if (c.src === 'poi') {
    const what = c.cats.length === POI_KEYS.length ? '가게·시설 전체' : c.cats.map((k) => POI_CATS[k]).join('·');
    return c.by === 'dist' ? `가장 가까운 ${what}까지 거리` : what;
  }
  if (c.src === 'depts') return '병원 진료과';
  const parts = [join(DAYS, c.days, 2) || '', timeText(c.times), join(AGES, c.ages, 6), join(SEXES, c.sexes, 2)].filter(Boolean);
  const kind = join(KINDS, c.kinds, 3);
  const what = c.measure === 'share' && (c.ages.length < 6 || c.sexes.length < 2) ? `비율${kind ? ` (${kind} 인구 중)` : ''}` : `${kind ? `${kind} 인구` : '사람 수'}${c.measure === 'share' ? ' 비율' : ''}`;
  return `${parts.length ? parts.join(' ') + ' ' : '하루 전체 '}${what}`;
}
function timeText(ts: number[]) {
  if (ts.length === 4) return '';
  const s = [...ts].sort();
  // 붙어 있는 시간대는 "17~24시" 처럼 묶기
  const contiguous = s.every((t, i) => i === 0 || t === s[i - 1] + 1);
  if (contiguous) return `${String(TIME_FROM[s[0]]).padStart(2, '0')}~${TIME_TO[s[s.length - 1]]}시`;
  return s.map((t) => TIMES[t]).join('·');
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? String(v) : v.toFixed(1));
export function condText(c: Cond): string {
  const subj = condSubject(c);
  if (c.mode === 'level') return `${subj} ${levelText(c.op, c.value, c.value2 ?? c.value)}`;
  if (c.src === 'poi' && c.by === 'dist' && c.op === 'lte') return `${condSubject({ ...c, by: 'count' })} ${fmt(c.value)}m 안`;
  if (c.mode === 'pct') return `${subj} ${c.op === 'gte' ? '상위' : '하위'} ${c.value}%`;
  if (c.src === 'poi' && c.op === 'lte' && c.value === 0) return `${subj} 없음`;
  if (c.op === 'between') return `${subj} ${fmt(c.value)}~${fmt(c.value2 ?? c.value)}${condUnit(c)}`;
  return `${subj} ${fmt(c.value)}${condUnit(c)} ${c.op === 'gte' ? '이상' : '이하'}`;
}

// ---------------------------------------------------------------- 분포 · 기준
const keyOf = (c: Cond) =>
  c.src === 'pop' ? `pop|${c.days}|${c.times}|${c.kinds}|${c.ages}|${c.sexes}|${c.measure}` : c.src === 'poi' ? `poi|${c.by ?? 'count'}|${[...c.cats].sort()}` : 'depts';

/** 자연적 단절(Fisher-Jenks): 작은 순 값 xs 를 k 구간으로 — 구간 안 분산 합이 가장 작게. 각 구간의 위 끝 값을 돌려준다 */
export function jenksUpper(xs: number[], k: number): number[] {
  const n = xs.length;
  if (!n) return new Array(k).fill(0);
  k = Math.min(k, n);
  const ps = [0];
  const ps2 = [0];
  for (const x of xs) {
    ps.push(ps[ps.length - 1] + x);
    ps2.push(ps2[ps2.length - 1] + x * x);
  }
  // ssd(i, j): xs[i..j] 의 편차 제곱합
  const ssd = (i: number, j: number) => {
    const m = j - i + 1;
    const s = ps[j + 1] - ps[i];
    return ps2[j + 1] - ps2[i] - (s * s) / m;
  };
  // cost[c][j]: 처음 j+1 개를 c+1 구간으로 나눈 최소 비용, from: 마지막 구간 시작
  const cost = [xs.map((_, j) => ssd(0, j))];
  const from: number[][] = [xs.map(() => 0)];
  for (let c = 1; c < k; c++) {
    const row = new Array(n).fill(Infinity);
    const fr = new Array(n).fill(0);
    for (let j = c; j < n; j++)
      for (let i = c; i <= j; i++) {
        const v = cost[c - 1][i - 1] + ssd(i, j);
        if (v < row[j]) [row[j], fr[j]] = [v, i];
      }
    cost.push(row);
    from.push(fr);
  }
  const ups: number[] = [];
  let j = n - 1;
  for (let c = k - 1; c >= 0; c--) {
    ups.unshift(xs[j]);
    j = from[c][j] - 1;
  }
  return ups;
}

export function makeMetricEval(cells: Cell[]) {
  const sorted = new Map<string, number[]>();
  const values = (c: Cond) => {
    const k = keyOf(c);
    let xs = sorted.get(k);
    if (!xs) sorted.set(k, (xs = cells.map((x) => condValue(x, c)).sort((a, b) => a - b)));
    return xs;
  };
  const quantile = (c: Cond, q: number) => {
    const xs = values(c);
    return xs[Math.min(xs.length - 1, Math.max(0, Math.floor(q * xs.length)))];
  };
  // 단계 경계: 전체 구역 값을 자연적 단절로 나눈 각 단계의 위 끝
  const ups = new Map<string, number[]>();
  const levelUpper = (c: Cond) => {
    const k = keyOf(c);
    let u = ups.get(k);
    if (!u) {
      // 칸이 많으면(수천) 계산이 무거워 고르게 뽑은 800개 값으로 나눈다 — 경계는 거의 같다
      const xs = values(c);
      const sample = xs.length > 800 ? Array.from({ length: 800 }, (_, i) => xs[Math.round((i * (xs.length - 1)) / 799)]) : xs;
      // 인원은 몇백 배씩 차이 나는 쏠린 분포 — 로그(배수 차이)로 바꿔 나누고, 경계는 원래 값으로 돌려놓는다
      const log = (v: number) => Math.log1p(Math.max(0, v));
      const back = new Map(sample.map((v) => [log(v), v]));
      u = jenksUpper(sample.map(log), LEVELS.length).map((x) => back.get(x)!);
      // 구역 수가 단계보다 적으면 마지막 끝을 반복
      while (u.length < LEVELS.length) u.push(u[u.length - 1] ?? 0);
      ups.set(k, u);
    }
    return u;
  };
  /** 단계 i 의 값 범위 [아래, 위] (아래는 이전 단계 위 끝 초과) */
  const levelRange = (c: Cond, i: number): Th => {
    const u = levelUpper(c);
    return [i <= 0 ? -Infinity : u[i - 1] + 1e-9, i >= LEVELS.length - 1 ? Infinity : u[i]];
  };
  const levelOf = (c: Cond, v: number) => {
    const u = levelUpper(c);
    const i = u.findIndex((x) => v <= x);
    return i < 0 ? LEVELS.length - 1 : i;
  };
  /** 기준 → 통과하는 값 범위 [아래, 위] (양 끝 포함) */
  const threshold = (c: Cond): Th => {
    if (c.mode === 'level') return [levelRange(c, c.value)[0], levelRange(c, c.value2 ?? c.value)[1]];
    const t = c.mode === 'abs' ? c.value : quantile(c, c.op === 'gte' ? 1 - c.value / 100 : c.value / 100);
    if (c.op === 'between') return [t, c.value2 ?? t];
    return c.op === 'gte' ? [t, Infinity] : [-Infinity, t];
  };
  const test = (cell: Cell, c: Cond, th = threshold(c)) => passes(c, condValue(cell, c), th);
  return { value: condValue, threshold, test, quantile, levelUpper, levelRange, levelOf };
}
export type MetricEval = ReturnType<typeof makeMetricEval>;
/** 통과 범위 [아래, 위] */
export type Th = [number, number];

/** 값 v 가 기준 범위 th = threshold(c) 안인지 */
export function passes(_c: Cond, v: number, th: Th) {
  return v >= th[0] && v <= th[1];
}

// ---------------------------------------------------------------- 종류
export interface Category {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  match: 'all' | 'any' | 'rest';
  conds: Cond[];
}

// 기본 성격 색(초록·파랑·주황·보라·빨강·청록·회색) 다음에 쓰는 색은 그것들과 헷갈리지 않는 순서로
const PALETTE = ['#3E9B6C', '#3B7DD8', '#E9822F', '#8A5CF0', '#D8405A', '#0E9EA8', '#EC4899', '#7A5C3E', '#1E3A8A', '#5F6B7A'];
let seq = 0;
export function newCategory(existing: Category[]): Category {
  const used = new Set(existing.map((c) => c.color));
  return {
    id: `c${Date.now().toString(36)}${(seq++).toString(36)}`,
    label: `새 성격 ${existing.length + 1}`,
    color: PALETTE.find((c) => !used.has(c)) ?? PALETTE[existing.length % PALETTE.length],
    enabled: true,
    match: 'all',
    conds: [],
  };
}

const base = (id: keyof typeof CELL_TYPES, match: Category['match'], conds: Cond[]): Category => ({
  id,
  label: CELL_TYPES[id].label,
  color: CELL_TYPES[id].color,
  enabled: true,
  match,
  conds,
});

/** 처음 기준 — 서버 데이터 파이프라인(buildFeatures)의 분류 규칙을 조합 조건으로 근사 */
export function defaultCategories(): Category[] {
  const pct = (op: Crit['op'], value: number) => ({ op, mode: 'pct' as const, value, value2: undefined });
  return [
    base('green', 'all', [newPoiCond(POI_KEYS, { op: 'lte', value: 0 }), newPopCond(pct('lte', 25))]),
    base('night', 'all', [newPoiCond(['bar'], { value: 2 }), newPopCond({ times: [3], measure: 'share', ...pct('gte', 10) }), newPopCond({ days: [1], times: [3], ...pct('gte', 25) })]),
    base('office', 'all', [newPopCond({ kinds: [1], measure: 'share', ...pct('gte', 10) })]),
    base('medical', 'all', [newPoiCond(['hosp'], { value: 3 }), { src: 'depts', op: 'gte', mode: 'abs', value: 3 }]),
    base('commercial', 'all', [newPoiCond(['food', 'cafe'], { value: 8 }), newPopCond({ days: [0], times: [2, 3], ...pct('gte', 40) })]),
    base('living', 'any', [newPopCond(pct('gte', 40)), newPoiCond(['food', 'cafe', 'conv', 'pharm', 'hosp'], { value: 4 })]),
    base('quiet', 'rest', []),
  ];
}

export interface Classified {
  /** 종류 id (없으면 미분류) */
  cat: string | null;
}

export function classifyAll(cells: Cell[], me: MetricEval, cats: Category[]) {
  const thresholds = cats.map((r) => r.conds.map(me.threshold));
  const byId = new Map<string, Classified>();
  const counts = new Map<string, number>();
  for (const cell of cells) {
    let cat: string | null = null;
    for (let i = 0; i < cats.length; i++) {
      const r = cats[i];
      if (!r.enabled) continue;
      const ok =
        r.match === 'rest' ||
        (r.conds.length > 0 &&
          (r.match === 'all' ? r.conds.every((k, j) => me.test(cell, k, thresholds[i][j])) : r.conds.some((k, j) => me.test(cell, k, thresholds[i][j]))));
      if (ok) {
        cat = r.id;
        break;
      }
    }
    byId.set(cell.id, { cat });
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return { byId, counts };
}
