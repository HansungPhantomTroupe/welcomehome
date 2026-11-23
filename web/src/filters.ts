/**
 * 조건으로 찾기 — 주거지 종류 분류와 별개로, 사용자가 쌓은 조건으로 구역을 위에서부터 차례로 걸러낸다.
 * 지금은 모든 조건을 구역 하나 안의 값으로만 판단한다 (주변 구역과 합친 조건은 이후 별도 기능으로).
 *
 *  - 구역 조건: 구역 안 지표(사람·가게 수) 또는 분류 종류
 *  - 이동 시간: 이 구역에서 고른 목적지까지 추정 시간
 *  - 행정동
 *  - 매물: 구역 안에 기준(분류·거래·유형·금액·면적)에 맞는 매물이 몇 건 이상인지
 *  - 커스텀(AI): 서버의 격리 실행기에서 돌린 스크립트 결과 (주변 칸을 보는 조건 등)
 */
import type { Cell } from '@shared/types';
import { estimateCommute } from '@shared/geo';
import { condText, condUnit, type Cond, type MetricEval } from './classify';
import type { CustomScript } from './customExamples';

export type Dest = { name: string; lat: number; lng: number };
export type CellPred = { kind: 'metric'; cond: Cond } | { kind: 'category'; ids: string[] };

interface Base {
  id: string;
  enabled: boolean;
}
export type ParamValue = number | string | boolean;
export type FilterDef =
  | (Base & { type: 'cell'; pred: CellPred })
  | (Base & { type: 'commute'; maxMin: number; dest: Dest })
  | (Base & { type: 'dong'; codes: string[] })
  /** 매물: 비운 목록은 전부, null 은 제한 없음. 금액은 만원, 면적은 전용 ㎡ */
  | (Base & {
      type: 'listing';
      cats: string[];
      trades: string[];
      kinds: string[];
      depositMax: number | null;
      rentMax: number | null;
      areaMin: number | null;
      minCount: number;
    })
  /** 커스텀: 스크립트는 숨기고 이름·입력칸만 보여 준다 */
  | (Base & { type: 'custom'; script: CustomScript; values: Record<string, ParamValue> });

// ---------------------------------------------------------------- 커스텀 실행 (서버)
export type CustomState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; pass: Set<string>; values: Record<string, number> };
export const customKey = (script: CustomScript, values: Record<string, ParamValue>) => JSON.stringify([script.code, script.params, values]);
export async function runCustomScript(script: CustomScript, values: Record<string, ParamValue>): Promise<CustomState> {
  try {
    const r = await fetch('/api/custom/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script, values }) }).then((x) => x.json());
    return r.ok ? { status: 'ok', pass: new Set(r.pass), values: r.values } : { status: 'error', error: r.error ?? '실행 실패' };
  } catch (e: any) {
    return { status: 'error', error: String(e.message ?? e) };
  }
}
/** 입력칸 값 (없으면 기본값) */
export const paramValue = (f: Extract<FilterDef, { type: 'custom' }>, key: string) => f.values[key] ?? f.script.params.find((p) => p.key === key)?.default;

// ---------------------------------------------------------------- 설명
export interface Names {
  cat: (id: string) => string;
  dong: (code: string) => string;
}

export function describe(f: FilterDef, n: Names): string {
  switch (f.type) {
    case 'commute':
      return `${f.dest.name}까지 ${f.maxMin}분 이내`;
    case 'dong':
      return f.codes.length ? `행정동 ${f.codes.map(n.dong).join(', ')}` : '행정동 (선택 없음)';
    case 'cell':
      return f.pred.kind === 'metric' ? condText(f.pred.cond) : f.pred.ids.length ? `동네 성격 ${f.pred.ids.map(n.cat).join('·')}` : '동네 성격 (선택 없음)';
    case 'listing':
      return listingText(f);
    case 'custom':
      return `${f.script.name} · ${f.script.params
        .map((p) => {
          const v = paramValue(f, p.key);
          const shown = p.type === 'select' ? p.options?.find((o) => o.value === v)?.label ?? v : p.type === 'boolean' ? (v ? '예' : '아니오') : v;
          return `${p.label} ${shown}${p.unit ?? ''}`;
        })
        .join(' · ')}`;
  }
}

/** 만원 → '1억 2,000만' · '60만' */
export const manText = (m: number) => {
  const eok = Math.floor(m / 10000);
  const rest = m % 10000;
  return eok ? `${eok}억${rest ? ` ${rest.toLocaleString()}만` : ''}` : `${rest.toLocaleString()}만`;
};
function listingText(f: Extract<FilterDef, { type: 'listing' }>) {
  const what = [...f.cats, ...f.kinds, ...f.trades].join(' ');
  const lim = [
    f.rentMax !== null ? `월세 ${manText(f.rentMax)} 이하` : '',
    f.depositMax !== null ? `${f.trades.length === 1 && f.trades[0] === '매매' ? '매매가' : '보증금'} ${manText(f.depositMax)} 이하` : '',
    f.areaMin !== null ? `${f.areaMin}㎡ 이상` : '',
  ].filter(Boolean);
  return `${what ? `${what} ` : ''}매물${lim.length ? ` (${lim.join(', ')})` : ''} ${f.minCount}건 이상`;
}

// ---------------------------------------------------------------- 평가
/** 매물 조건용 요약 (서버 /api/articles/index) */
export interface ListingLite {
  cell: string;
  cat: string;
  trade: string | null;
  kind: string | null;
  deposit: number | null;
  rent: number | null;
  area: number | null;
  floor?: string | null;
  tags?: string[];
  dir?: string | null;
}
export type ListingCrit = Pick<Extract<FilterDef, { type: 'listing' }>, 'cats' | 'trades' | 'kinds' | 'depositMax' | 'rentMax' | 'areaMin'>;
export const listingMatches = (f: ListingCrit, l: ListingLite) =>
  (!f.cats.length || f.cats.includes(l.cat)) &&
  (!f.trades.length || (l.trade !== null && f.trades.includes(l.trade))) &&
  (!f.kinds.length || (l.kind !== null && f.kinds.includes(l.kind))) &&
  (f.depositMax === null || (l.deposit !== null && l.deposit <= f.depositMax)) &&
  (f.rentMax === null || (l.rent !== null && l.rent <= f.rentMax)) &&
  (f.areaMin === null || (l.area !== null && l.area >= f.areaMin));

export interface FilterCtx {
  me: MetricEval;
  catOf: (cellId: string) => string | null;
  /** 커스텀 조건의 서버 실행 결과 (아직이면 undefined) */
  custom?: (f: Extract<FilterDef, { type: 'custom' }>) => CustomState | undefined;
  /** 구역별 매물 (아직 못 받았으면 undefined) */
  listings?: Map<string, ListingLite[]>;
}

export function evalFilter(f: FilterDef, cell: Cell, ctx: FilterCtx): { ok: boolean; detail: string } {
  switch (f.type) {
    case 'commute': {
      const m = estimateCommute(cell.center, f.dest).min;
      return { ok: m <= f.maxMin, detail: `약 ${m}분` };
    }
    case 'dong':
      return { ok: f.codes.length === 0 || f.codes.includes(cell.dongCode), detail: cell.dongName };
    case 'listing': {
      // 매물을 아직 못 받았으면 거르지 않는다
      if (!ctx.listings) return { ok: true, detail: '매물 불러오는 중' };
      const n = (ctx.listings.get(cell.id) ?? []).filter((l) => listingMatches(f, l)).length;
      return { ok: n >= f.minCount, detail: `${n}건` };
    }
    case 'custom': {
      // 계산 중이거나 스크립트 오류면 거르지 않는다 (행정동 '선택 전'과 같은 처리)
      const st = ctx.custom?.(f);
      if (!st || st.status === 'loading') return { ok: true, detail: '계산 중' };
      if (st.status === 'error') return { ok: true, detail: '스크립트 오류' };
      const v = st.values[cell.id];
      return { ok: st.pass.has(cell.id), detail: v === undefined ? '' : String(Math.round(v * 10) / 10) };
    }
    case 'cell': {
      const p = f.pred;
      if (p.kind === 'category') {
        // 종류를 아직 안 골랐으면 (행정동처럼) 걸러내지 않는다
        if (p.ids.length === 0) return { ok: true, detail: '종류를 고르기 전' };
        return { ok: p.ids.includes(ctx.catOf(cell.id) ?? ''), detail: '' };
      }
      return { ok: ctx.me.test(cell, p.cond), detail: `${ctx.me.value(cell, p.cond).toLocaleString()}${condUnit(p.cond)}` };
    }
  }
}

/** 위에서부터 차례로 걸러내기 — 각 조건 뒤에 남은 구역 */
export function runFilters(stack: FilterDef[], cells: Cell[], ctx: FilterCtx) {
  const stages: Cell[][] = [];
  let cur = cells;
  for (const f of stack) {
    if (f.enabled) cur = cur.filter((c) => evalFilter(f, c, ctx).ok);
    stages.push(cur);
  }
  return { stages, final: cur };
}
