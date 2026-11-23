/**
 * 공통점 찾기 — 걸러진 칸들이 전체 칸과 비교해 어떤 점이 뚜렷하게 다른지 계산한다.
 *  - 숫자 지표: 걸러진 칸들의 중간값이 전체 칸 분포에서 몇 % 위치인지 (50% 에서 멀수록 뚜렷)
 *  - 범주 지표(동네 성격 · 행정동): 걸러진 칸 중 비중 vs 전체 칸 중 비중
 * 지표는 자르지 않고 전부 보낸다 (뚜렷한 것부터). 전체와 비슷하다는 것도 답의 근거가 된다.
 * AI 에는 이 요약 숫자만 보낸다 (칸별 원본 값은 보내지 않음).
 */
import type { Cell } from '@shared/types';
import { estimateCommute } from '@shared/geo';
import type { Dest, ListingLite } from './filters';

export interface InsightRow {
  /** 지표 이름 (단위 포함) */
  label: string;
  /** 걸러진 칸 중간값 · 전체 칸 중간값 (범주면 비중 %) */
  sel: number;
  all: number;
  /** 숫자 지표: 걸러진 칸 중간값이 전체 분포에서의 위치 0~100 (%) · 범주 지표: null */
  pct: number | null;
  /** 뚜렷한 정도 0~1 */
  score: number;
}
export interface Insight {
  count: number;
  total: number;
  rows: InsightRow[];
  /** 매물끼리 비교 (매물이 모자라면 없음) */
  listing?: ListingInsight | null;
}

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

const AGES = ['20대 미만', '20대', '30대', '40대', '50대', '60대 이상'];
const KINDS = ['거주', '직장', '방문'];
/** [이름, 요일묶음(0 평일 1 주말), 시간대들] */
const TIME_WINDOWS: [string, number, number[]][] = [
  ['평일 낮 08–16시', 0, [0, 1]],
  ['평일 저녁 17–24시', 0, [2, 3]],
  ['주말 낮 08–16시', 1, [0, 1]],
  ['주말 밤 21–24시', 1, [3]],
];
const POI: [string, string][] = [
  ['food', '음식점'],
  ['cafe', '카페'],
  ['bar', '술집'],
  ['conv', '편의점'],
  ['hosp', '병원'],
  ['pharm', '약국'],
  ['gym', '헬스장'],
  ['subway', '지하철역'],
  ['mart', '대형마트'],
];

/** 칸 하나의 숫자 지표들 (없으면 NaN) */
function features(c: Cell, dests: Dest[], listings: ListingLite[] | undefined): [string, number][] {
  const s = c.slots;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const total = c.total ?? avg([...s[0], ...s[1]]);
  // 요일묶음 × 인구 종류별 인원 → 성별·연령 비율에 곱해 전체 비율
  let popSum = 0;
  const ages = new Array(6).fill(0);
  let female = 0;
  for (let d = 0; d < 2; d++)
    for (let k = 0; k < 3; k++) {
      const n = [0, 1, 2, 3].reduce((a, t) => a + (c.pop[(d * 4 + t) * 3 + k] ?? 0), 0);
      popSum += n;
      for (let sx = 0; sx < 2; sx++)
        for (let a = 0; a < 6; a++) {
          const v = n * (c.demo?.[((d * 3 + k) * 2 + sx) * 6 + a] ?? 0);
          ages[a] += v;
          if (sx === 1) female += v;
        }
    }
  const rents = (listings ?? []).filter((l) => l.trade === '월세' && l.rent !== null).map((l) => l.rent!);
  const out: [string, number][] = [
    ['하루 평균 인원 (명)', total],
    ['평일 낮 08–16시 인원 (명)', avg([s[0][0], s[0][1]])],
    ['평일 저녁 17–24시 인원 (명)', avg([s[0][2], s[0][3]])],
    ['주말 낮 08–16시 인원 (명)', avg([s[1][0], s[1][1]])],
    ['주말 밤 21–24시 인원 (명)', s[1][3]],
    ['밤 21–24시 인원 비중 (%)', total ? ((s[0][3] + s[1][3]) / 2 / total) * 100 : NaN],
    ['거주 인구 비중 (%)', c.kindShare.resident * 100],
    ['직장 인구 비중 (%)', c.kindShare.worker * 100],
    ['방문 인구 비중 (%)', c.kindShare.visitor * 100],
    ...TIME_WINDOWS.flatMap(([name, d, ts]) => {
      const by = [0, 1, 2].map((k) => ts.reduce((a, t) => a + (c.pop[(d * 4 + t) * 3 + k] ?? 0), 0));
      const sum = by[0] + by[1] + by[2];
      return KINDS.map((kn, k) => [`${name} ${kn} 비중 (%)`, sum ? (by[k] / sum) * 100 : NaN] as [string, number]);
    }),
    ['여성 비율 (%)', popSum ? (female / popSum) * 100 : NaN],
    ...AGES.map((a, i) => [`${a} 비율 (%)`, popSum ? (ages[i] / popSum) * 100 : NaN] as [string, number]),
    ...POI.map(([k, n]) => [`칸 안 ${n} 수 (곳)`, c.poi[k as keyof typeof c.poi] ?? NaN] as [string, number]),
    ['칸 안 진료과 수 (개)', c.depts.length],
    ...POI.map(([k, n]) => [`가장 가까운 ${n}까지 (m)`, c.nearM?.[k as keyof typeof c.nearM] ?? NaN] as [string, number]),
    ...dests.map((d) => [`${d.name}까지 이동 (분)`, estimateCommute(c.center, d).min] as [string, number]),
    ['칸 안 매물 수 (건)', listings?.length ?? 0],
    ['칸 안 상가 매물 수 (건)', (listings ?? []).filter((l) => l.cat === '상가').length],
    ['칸 안 주거 매물 수 (건)', (listings ?? []).filter((l) => l.cat !== '상가').length],
    ['월세 매물 월세 중간값 (만 원)', rents.length ? median(rents) : NaN],
  ];
  return out.map(([k, v]) => [k, v === null || v === undefined ? NaN : v]);
}

export function computeInsight(
  sel: Cell[],
  all: Cell[],
  o: { dests: Dest[]; listings?: Map<string, ListingLite[]>; categoryOf: (id: string) => string | null },
): Insight {
  const rows: InsightRow[] = [];
  if (!sel.length || sel.length === all.length) return { count: sel.length, total: all.length, rows };
  const selIds = new Set(sel.map((c) => c.id));

  // 숫자 지표
  const table = new Map<string, { sel: number[]; all: number[] }>();
  for (const c of all) {
    for (const [k, v] of features(c, o.dests, o.listings?.get(c.id))) {
      const e = table.get(k) ?? table.set(k, { sel: [], all: [] }).get(k)!;
      if (!Number.isFinite(v)) continue;
      e.all.push(v);
      if (selIds.has(c.id)) e.sel.push(v);
    }
  }
  for (const [label, e] of table) {
    // 걸러진 칸 대부분에 값이 없으면 (예: 월세 매물 없는 칸) 판단하지 않음
    if (e.sel.length < Math.max(3, sel.length * 0.3) || e.all.length < 10) continue;
    const sm = median(e.sel);
    const am = median(e.all);
    const below = e.all.filter((v) => v < sm).length;
    const equal = e.all.filter((v) => v === sm).length;
    const pct = ((below + equal / 2) / e.all.length) * 100;
    const score = Math.abs(pct - 50) / 50;
    rows.push({ label, sel: round(sm), all: round(am), pct: Math.round(pct), score });
  }

  // 범주 지표: 걸러진 칸의 30% 이상을 차지하고 전체보다 1.5배 이상 많은 것
  const cats: [string, (c: Cell) => string | null][] = [
    ['동네 성격', (c) => o.categoryOf(c.id)],
    ['행정동', (c) => c.dongName],
  ];
  for (const [name, get] of cats) {
    const allN = new Map<string, number>();
    const selN = new Map<string, number>();
    for (const c of all) {
      const v = get(c);
      if (!v) continue;
      allN.set(v, (allN.get(v) ?? 0) + 1);
      if (selIds.has(c.id)) selN.set(v, (selN.get(v) ?? 0) + 1);
    }
    for (const [v, n] of selN) {
      const s = n / sel.length;
      const a = (allN.get(v) ?? 0) / all.length;
      if (s >= 0.1) rows.push({ label: `${name}: ${v} 비중 (%)`, sel: Math.round(s * 100), all: Math.round(a * 100), pct: null, score: Math.max(0, Math.min(1, (s - a) * 2)) });
    }
  }

  rows.sort((a, b) => b.score - a.score);
  return { count: sel.length, total: all.length, rows };
}

// ---------------------------------------------------------------- 매물끼리 비교
export interface ListingInsight {
  /** 무엇과 무엇을 비교했는지 */
  basis: string;
  selN: number;
  cmpN: number;
  rows: { label: string; sel: number; cmp: number }[];
}

/** 층 구분: 지하 · 1층 · 저층 · 중층 · 고층 */
function floorBand(f: string | null | undefined): string | null {
  if (!f) return null;
  const [cur, tot] = f.split('/');
  if (/^B/i.test(cur)) return '지하';
  if (cur === '저') return '저층';
  if (cur === '중') return '중층';
  if (cur === '고') return '고층';
  const n = Number(cur);
  const t = Number(tot);
  if (!Number.isFinite(n)) return null;
  if (n === 1) return '1층';
  if (Number.isFinite(t) && t > 0) return n / t > 0.66 ? '고층' : n / t > 0.33 ? '중층' : '저층';
  return '저층';
}
const NEW_TAGS = ['2년이내', '4년이내', '10년이내'];
const TAG_ROWS: [string, (t: string[]) => boolean][] = [
  ['10년 이내 건물', (t) => t.some((x) => NEW_TAGS.includes(x))],
  ['25년 이상 건물', (t) => t.includes('25년이상')],
  ['방 한 개', (t) => t.includes('방한개')],
  ['방 두 개 이상', (t) => t.some((x) => /^방(두|세|네)/.test(x))],
  ['관리비 10만 원 이하', (t) => t.includes('관리비10만원이하')],
  ['엘리베이터', (t) => t.includes('엘리베이터')],
  ['주차 가능', (t) => t.includes('주차가능')],
  ['풀옵션', (t) => t.some((x) => x.startsWith('풀옵'))],
  ['세대분리', (t) => t.includes('세대분리')],
  ['역세권', (t) => t.includes('역세권')],
  ['소형평수', (t) => t.includes('소형평수')],
  ['융자금 없음', (t) => t.includes('융자금없는')],
];

/**
 * 걸러진 칸 안의 매물(매물 조건이 있으면 그 조건에 맞는 것) vs 비교군
 * 비교군: 매물 조건의 분류·거래·유형은 같고 금액·면적 제한은 뺀, 걸러진 칸 밖의 매물 (매물 조건이 없으면 걸러진 칸 밖 전체)
 */
export function computeListingInsight(
  selIds: Set<string>,
  all: ListingLite[],
  filters: { cats: string[]; trades: string[]; kinds: string[]; depositMax: number | null; rentMax: number | null; areaMin: number | null }[],
  match: (f: (typeof filters)[number], l: ListingLite) => boolean,
): ListingInsight | null {
  const peerOf = (f: (typeof filters)[number]) => ({ ...f, depositMax: null, rentMax: null, areaMin: null });
  const inSel = all.filter((l) => selIds.has(l.cell));
  const outSel = all.filter((l) => !selIds.has(l.cell));
  const A = filters.length ? inSel.filter((l) => filters.every((f) => match(f, l))) : inSel;
  const B = filters.length ? outSel.filter((l) => filters.every((f) => match(peerOf(f), l))) : outSel;
  if (A.length < 3 || B.length < 3) return null;
  const f0 = filters[0];
  const what = f0 ? [...f0.cats, ...f0.kinds, ...f0.trades].join(' ') || '같은 종류' : '전체';
  const basis = filters.length
    ? `걸러진 구역 안의 조건에 맞는 매물 vs 다른 구역의 ${what} 매물 (금액·면적 제한 없이)`
    : '걸러진 구역 안의 매물 vs 다른 구역 매물';

  const med = (xs: ListingLite[], v: (l: ListingLite) => number | null) => {
    const ys = xs.map(v).filter((x): x is number => x !== null && Number.isFinite(x) && x > 0);
    return ys.length >= 3 ? median(ys) : NaN;
  };
  const share = (xs: ListingLite[], p: (l: ListingLite) => boolean) => (xs.length ? (xs.filter(p).length / xs.length) * 100 : NaN);
  const rows: { label: string; sel: number; cmp: number }[] = [];
  const add = (label: string, a: number, b: number) => {
    if (Number.isFinite(a) && Number.isFinite(b)) rows.push({ label, sel: round(a), cmp: round(b) });
  };
  add('보증금 중간값 (만 원)', med(A, (l) => l.deposit), med(B, (l) => l.deposit));
  add('월세 중간값 (만 원)', med(A, (l) => l.rent), med(B, (l) => l.rent));
  add('전용면적 중간값 (㎡)', med(A, (l) => l.area), med(B, (l) => l.area));
  add('㎡당 월세 중간값 (만 원)', med(A, (l) => (l.rent && l.area ? l.rent / l.area : null)), med(B, (l) => (l.rent && l.area ? l.rent / l.area : null)));
  for (const band of ['지하', '1층', '저층', '중층', '고층']) add(`${band} 비중 (%)`, share(A, (l) => floorBand(l.floor) === band), share(B, (l) => floorBand(l.floor) === band));
  for (const [label, p] of TAG_ROWS) add(`${label} 비중 (%)`, share(A, (l) => p(l.tags ?? [])), share(B, (l) => p(l.tags ?? [])));
  add('남향(남·남동·남서) 비중 (%)', share(A, (l) => /^남/.test(l.dir ?? '')), share(B, (l) => /^남/.test(l.dir ?? '')));
  const kinds = [...new Set([...A, ...B].map((l) => l.kind).filter((k): k is string => !!k))];
  for (const k of kinds) add(`유형 ${k} 비중 (%)`, share(A, (l) => l.kind === k), share(B, (l) => l.kind === k));
  // 차이가 없는 줄은 뺌
  return { basis, selN: A.length, cmpN: B.length, rows: rows.filter((r) => r.sel !== r.cmp) };
}
