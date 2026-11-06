/**
 * 커널 연산 엔진 — 칸 격자를 '숫자 사진'으로 보고, 단계를 차례로 적용해 새 지도를 만든다.
 *
 * 설계도(Spec) = 단계 목록. 각 단계는 앞 단계의 결과(구역마다 숫자 하나)를 받아 새 결과를 낸다.
 *  - source    : 조건 엔진의 값 (유동인구 조합 / 가게·시설 개수 / 진료과 수)
 *  - category  : 주거지 종류에 속하면 1, 아니면 0
 *  - kernel    : 주변 구역을 모양(원·고리·사각) × 연산(평균·합·가우시안·최대·최소·가운데−주변)으로 섞기
 *  - threshold : 기준 이상/이하 → 1·0
 *  - combine   : 두 결과 합치기 (그리고·또는·빼기 …)
 *  - blob      : 붙어 있는 1 덩어리 중 N구역 이상인 것만 남기기
 * 설계도는 JSON 그대로 저장·불러오기 할 수 있어서, 사람이 만들든 AI 가 만들든 같은 검사(validateSpec)를 거친다.
 */
import type { Cell } from '@shared/types';
import { CELL_SIZE } from '@shared/cellTypes';
import { condValue, POI_KEYS, type Category, type Cond, type MetricEval, classifyAll } from '../classify';

export const CELL_M = CELL_SIZE;
export const MAX_RADIUS_M = 2000;

export type KernelShape = 'disk' | 'ring' | 'square';
export type KernelOp = 'mean' | 'sum' | 'gauss' | 'max' | 'min' | 'center_minus_surround';
export type CombineOp = 'and' | 'or' | 'and_not' | 'add' | 'sub' | 'mul' | 'div';

interface Base {
  id: string;
  label: string;
}
export type Step =
  | (Base & { kind: 'source'; cond: Cond })
  | (Base & { kind: 'category'; cats: string[] })
  | (Base & { kind: 'kernel'; input: string; shape: KernelShape; r: number; rIn: number; op: KernelOp })
  | (Base & { kind: 'threshold'; input: string; op: 'gte' | 'lte'; mode: 'abs' | 'pct'; value: number })
  | (Base & { kind: 'combine'; a: string; b: string; op: CombineOp })
  | (Base & { kind: 'blob'; input: string; minCells: number });
export type StepKind = Step['kind'];

export const KIND_LABEL: Record<StepKind, string> = {
  source: '데이터',
  category: '종류',
  kernel: '커널',
  threshold: '기준',
  combine: '합치기',
  blob: '덩어리',
};
export const SHAPE_LABEL: Record<KernelShape, string> = { disk: '원', ring: '고리', square: '사각' };
export const KOP_LABEL: Record<KernelOp, string> = {
  mean: '평균',
  sum: '합계',
  gauss: '가우시안 (가까울수록 크게)',
  max: '최대 (하나라도 있으면)',
  min: '최소 (전부 그래야)',
  center_minus_surround: '가운데 − 주변 평균',
};
export const COP_LABEL: Record<CombineOp, string> = {
  and: '그리고 (둘 다)',
  or: '또는 (하나라도)',
  and_not: '이면서 아닌 (A 그리고 B 아님)',
  add: '더하기 A+B',
  sub: '빼기 A−B',
  mul: '곱하기 A×B',
  div: '나누기 A÷B',
};
/** 결과가 0·1 인 연산 */
const BINARY_COMBINE = new Set<CombineOp>(['and', 'or', 'and_not']);

// ---------------------------------------------------------------- 격자
export interface Grid {
  cells: Cell[];
  gx: Int32Array;
  gy: Int32Array;
  /** 격자 좌표 → 셀 순번 */
  at: Map<number, number>;
}
const key = (x: number, y: number) => x * 100_000 + y;
export function makeGrid(cells: Cell[]): Grid {
  const gx = new Int32Array(cells.length);
  const gy = new Int32Array(cells.length);
  const at = new Map<number, number>();
  cells.forEach((c, i) => {
    const [x, y] = c.id.slice(2).split('_').map(Number);
    gx[i] = x;
    gy[i] = y;
    at.set(key(x, y), i);
  });
  return { cells, gx, gy, at };
}
export const neighbor = (g: Grid, i: number, dx: number, dy: number) => g.at.get(key(g.gx[i] + dx, g.gy[i] + dy)) ?? -1;

// ---------------------------------------------------------------- 커널 모양
export interface Offset {
  dx: number;
  dy: number;
  w: number;
}
/** 커널에 들어가는 칸들과 가중치. 가운데(0,0)는 고리 모양이면 빠진다 */
export function kernelOffsets(shape: KernelShape, r: number, rIn: number, op: KernelOp): Offset[] {
  const R = Math.max(0, Math.round(r / CELL_M));
  const sigma = Math.max(CELL_M / 2, r / 2);
  const out: Offset[] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy) * CELL_M;
      const inside =
        shape === 'square' ? true : shape === 'disk' ? d <= r + 1e-6 : d <= r + 1e-6 && d >= rIn - 1e-6 && !(dx === 0 && dy === 0);
      if (!inside) continue;
      const w = op === 'gauss' ? Math.exp(-(d * d) / (2 * sigma * sigma)) : 1;
      out.push({ dx, dy, w });
    }
  return out;
}

// ---------------------------------------------------------------- 결과
export interface StepResult {
  values: Float64Array;
  binary: boolean;
  min: number;
  max: number;
  mean: number;
  /** binary 일 때 1 인 구역 수 */
  count: number;
}
export interface RunResult {
  byId: Map<string, StepResult>;
  errors: Map<string, string>;
}

function summarize(values: Float64Array, binary: boolean): StepResult {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v > 0) count++;
  }
  return { values, binary, min: values.length ? min : 0, max: values.length ? max : 0, mean: values.length ? sum / values.length : 0, count };
}

function quantile(values: Float64Array, q: number) {
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? 0;
}
export function thresholdOf(step: Extract<Step, { kind: 'threshold' }>, input: Float64Array) {
  if (step.mode === 'abs') return step.value;
  return quantile(input, step.op === 'gte' ? 1 - step.value / 100 : step.value / 100);
}

export interface Env {
  grid: Grid;
  me: MetricEval;
  cats: Category[];
}

export function runSpec(steps: Step[], env: Env): RunResult {
  const { grid } = env;
  const n = grid.cells.length;
  const byId = new Map<string, StepResult>();
  const errors = new Map<string, string>();
  let cls: ReturnType<typeof classifyAll> | null = null;
  const get = (id: string, who: Step) => {
    const r = byId.get(id);
    if (!r) throw new Error(id ? `앞 단계 ${id} 결과가 없어요` : `${who.id}: 입력 단계를 골라 주세요`);
    return r;
  };

  for (const s of steps) {
    try {
      const out = new Float64Array(n);
      let binary = false;
      switch (s.kind) {
        case 'source':
          grid.cells.forEach((c, i) => (out[i] = condValue(c, s.cond)));
          break;
        case 'category': {
          cls ??= classifyAll(grid.cells, env.me, env.cats);
          const want = new Set(s.cats);
          grid.cells.forEach((c, i) => (out[i] = want.has(cls!.byId.get(c.id)?.cat ?? '') ? 1 : 0));
          binary = true;
          break;
        }
        case 'kernel': {
          const inp = get(s.input, s);
          const offs = kernelOffsets(s.shape, s.r, s.rIn, s.op);
          const surround = offs.filter((o) => o.dx !== 0 || o.dy !== 0);
          for (let i = 0; i < n; i++) {
            // 탐색 지역 밖·데이터 없는 칸은 빼고, 있는 칸의 가중치로만 나눈다 (가장자리 보정)
            const use = s.op === 'center_minus_surround' ? surround : offs;
            let acc = s.op === 'max' ? -Infinity : s.op === 'min' ? Infinity : 0;
            let wsum = 0;
            for (const o of use) {
              const j = neighbor(grid, i, o.dx, o.dy);
              if (j < 0) continue;
              const v = inp.values[j];
              if (s.op === 'max') acc = Math.max(acc, v);
              else if (s.op === 'min') acc = Math.min(acc, v);
              else acc += v * o.w;
              wsum += o.w;
            }
            if (wsum === 0) out[i] = s.op === 'center_minus_surround' ? 0 : s.op === 'sum' ? 0 : inp.values[i];
            else if (s.op === 'sum' || s.op === 'max' || s.op === 'min') out[i] = acc;
            else if (s.op === 'center_minus_surround') out[i] = inp.values[i] - acc / wsum;
            else out[i] = acc / wsum;
          }
          binary = inp.binary && (s.op === 'max' || s.op === 'min');
          break;
        }
        case 'threshold': {
          const inp = get(s.input, s);
          const th = thresholdOf(s, inp.values);
          for (let i = 0; i < n; i++) out[i] = (s.op === 'gte' ? inp.values[i] >= th : inp.values[i] <= th) ? 1 : 0;
          binary = true;
          break;
        }
        case 'combine': {
          const a = get(s.a, s).values;
          const b = get(s.b, s).values;
          for (let i = 0; i < n; i++) {
            const A = a[i];
            const B = b[i];
            out[i] =
              s.op === 'and' ? +(A > 0 && B > 0)
              : s.op === 'or' ? +(A > 0 || B > 0)
              : s.op === 'and_not' ? +(A > 0 && !(B > 0))
              : s.op === 'add' ? A + B
              : s.op === 'sub' ? A - B
              : s.op === 'mul' ? A * B
              : B === 0 ? 0 : A / B;
          }
          binary = BINARY_COMBINE.has(s.op);
          break;
        }
        case 'blob': {
          // 1 인 구역끼리 8방향으로 붙어 있으면 한 덩어리
          const inp = get(s.input, s).values;
          const seen = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            if (seen[i] || !(inp[i] > 0)) continue;
            const comp = [i];
            seen[i] = 1;
            for (let k = 0; k < comp.length; k++)
              for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                  const j = neighbor(grid, comp[k], dx, dy);
                  if (j >= 0 && !seen[j] && inp[j] > 0) {
                    seen[j] = 1;
                    comp.push(j);
                  }
                }
            if (comp.length >= s.minCells) for (const j of comp) out[j] = 1;
          }
          binary = true;
          break;
        }
      }
      byId.set(s.id, summarize(out, binary));
    } catch (e) {
      errors.set(s.id, (e as Error).message);
    }
  }
  return { byId, errors };
}

/** 커널 단계에서 한 구역의 계산에 실제로 쓰인 이웃 칸들 (지도에 창을 그리기 위해) */
export function kernelWindow(step: Extract<Step, { kind: 'kernel' }>, grid: Grid, i: number) {
  const offs = kernelOffsets(step.shape, step.r, step.rIn, step.op);
  return offs
    .filter((o) => step.op !== 'center_minus_surround' || o.dx !== 0 || o.dy !== 0)
    .map((o) => ({ j: neighbor(grid, i, o.dx, o.dy), w: o.w }))
    .filter((x) => x.j >= 0);
}

// ---------------------------------------------------------------- 검사 (사람이 붙여 넣은 JSON · AI 가 만든 JSON 공통)
const KINDS: StepKind[] = ['source', 'category', 'kernel', 'threshold', 'combine', 'blob'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const idxList = (v: unknown, max: number) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 0 && x < max);

export function validateSpec(raw: unknown, catIds: string[]): { steps: Step[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: '단계 목록(배열)이어야 해요' };
  const seen = new Set<string>();
  const steps: Step[] = [];
  for (const [k, s] of raw.entries()) {
    const at = `${k + 1}번째 단계`;
    if (!s || typeof s !== 'object') return { error: `${at}: 객체가 아니에요` };
    const o = s as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) return { error: `${at}: id 가 필요해요` };
    if (seen.has(o.id)) return { error: `${at}: id ${o.id} 가 겹쳐요` };
    if (!KINDS.includes(o.kind as StepKind)) return { error: `${at}: kind 는 ${KINDS.join('/')} 중 하나` };
    const ref = (f: string) => {
      if (typeof o[f] !== 'string' || !seen.has(o[f] as string)) throw new Error(`${at}: ${f} 는 앞 단계 id 여야 해요`);
    };
    const label = typeof o.label === 'string' ? o.label : '';
    try {
      switch (o.kind) {
        case 'source': {
          const c = o.cond as Record<string, unknown> | undefined;
          if (!c || !['pop', 'poi', 'depts'].includes(c.src as string)) throw new Error(`${at}: cond.src 는 pop/poi/depts`);
          const crit = { op: 'gte' as const, mode: 'abs' as const, value: 0 };
          let cond: Cond;
          if (c.src === 'pop') {
            const ages = c.ages ?? [0, 1, 2, 3, 4, 5];
            const sexes = c.sexes ?? [0, 1];
            if (!idxList(c.days, 2) || !idxList(c.times, 4) || !idxList(c.kinds, 3) || !idxList(ages, 6) || !idxList(sexes, 2))
              throw new Error(`${at}: days(0~1)·times(0~3)·kinds(0~2: 거주·직장·방문)·ages(0~5, 생략=전체)·sexes(0~1, 생략=전체) 를 하나 이상`);
            cond = { src: 'pop', days: c.days as number[], times: c.times as number[], kinds: c.kinds as number[], ages: ages as number[], sexes: sexes as number[], measure: c.measure === 'share' ? 'share' : 'count', ...crit };
          } else if (c.src === 'poi') {
            const cats = c.cats as string[];
            if (!Array.isArray(cats) || !cats.length || !cats.every((x) => (POI_KEYS as string[]).includes(x))) throw new Error(`${at}: cats 는 ${POI_KEYS.join('/')} 중에서`);
            cond = { src: 'poi', cats: cats as Extract<Cond, { src: 'poi' }>['cats'], ...crit };
          } else cond = { src: 'depts', ...crit };
          steps.push({ id: o.id, label, kind: 'source', cond });
          break;
        }
        case 'category': {
          const cats = o.cats as string[];
          if (!Array.isArray(cats) || !cats.length || !cats.every((x) => catIds.includes(x))) throw new Error(`${at}: cats 는 ${catIds.join('/')} 중에서`);
          steps.push({ id: o.id, label, kind: 'category', cats });
          break;
        }
        case 'kernel': {
          ref('input');
          if (!['disk', 'ring', 'square'].includes(o.shape as string)) throw new Error(`${at}: shape 는 disk/ring/square`);
          if (!Object.keys(KOP_LABEL).includes(o.op as string)) throw new Error(`${at}: op 는 ${Object.keys(KOP_LABEL).join('/')}`);
          if (!isNum(o.r) || o.r < CELL_M || o.r > MAX_RADIUS_M) throw new Error(`${at}: r 은 ${CELL_M}~${MAX_RADIUS_M}m`);
          const rIn = isNum(o.rIn) ? o.rIn : 0;
          if (o.shape === 'ring' && (rIn < 0 || rIn > o.r)) throw new Error(`${at}: 고리 안쪽 반경 rIn 은 0~r`);
          steps.push({ id: o.id, label, kind: 'kernel', input: o.input as string, shape: o.shape as KernelShape, r: o.r, rIn, op: o.op as KernelOp });
          break;
        }
        case 'threshold': {
          ref('input');
          if (o.op !== 'gte' && o.op !== 'lte') throw new Error(`${at}: op 는 gte/lte`);
          if (o.mode !== 'abs' && o.mode !== 'pct') throw new Error(`${at}: mode 는 abs/pct`);
          if (!isNum(o.value) || (o.mode === 'pct' && (o.value <= 0 || o.value > 100))) throw new Error(`${at}: value 가 이상해요`);
          steps.push({ id: o.id, label, kind: 'threshold', input: o.input as string, op: o.op, mode: o.mode, value: o.value });
          break;
        }
        case 'combine': {
          ref('a');
          ref('b');
          if (!Object.keys(COP_LABEL).includes(o.op as string)) throw new Error(`${at}: op 는 ${Object.keys(COP_LABEL).join('/')}`);
          steps.push({ id: o.id, label, kind: 'combine', a: o.a as string, b: o.b as string, op: o.op as CombineOp });
          break;
        }
        case 'blob': {
          ref('input');
          if (!Number.isInteger(o.minCells) || (o.minCells as number) < 1) throw new Error(`${at}: minCells 는 1 이상 정수`);
          steps.push({ id: o.id, label, kind: 'blob', input: o.input as string, minCells: o.minCells as number });
          break;
        }
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
    seen.add(o.id);
  }
  return { steps };
}

/** 저장·내보내기용: 조건 엔진의 화면용 필드(기준 등)는 빼고 설계도에 필요한 것만 */
export function exportSpec(steps: Step[]) {
  return steps.map((s) => {
    if (s.kind !== 'source') return s;
    const c = s.cond;
    const cond = c.src === 'pop' ? { src: c.src, days: c.days, times: c.times, kinds: c.kinds, ages: c.ages, sexes: c.sexes, measure: c.measure } : c.src === 'poi' ? { src: c.src, cats: c.cats } : { src: c.src };
    return { ...s, cond };
  });
}
