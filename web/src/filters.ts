/**
 * 조건으로 찾기 — 주거지 종류 분류와 별개로, 사용자가 쌓은 조건으로 구역을 위에서부터 차례로 걸러낸다.
 * 지금은 모든 조건을 구역 하나 안의 값으로만 판단한다 (주변 구역과 합친 조건은 이후 별도 기능으로).
 *
 *  - 구역 조건: 구역 안 지표(사람·가게 수) 또는 분류 종류
 *  - 이동 시간: 이 구역에서 고른 목적지까지 추정 시간
 *  - 행정동
 */
import type { Cell } from '@shared/types';
import { estimateCommute } from '@shared/geo';
import { condText, condUnit, type Cond, type MetricEval } from './classify';

export type Dest = { name: string; lat: number; lng: number };
export type CellPred = { kind: 'metric'; cond: Cond } | { kind: 'category'; ids: string[] };

interface Base {
  id: string;
  enabled: boolean;
}
export type FilterDef = (Base & { type: 'cell'; pred: CellPred }) | (Base & { type: 'commute'; maxMin: number; dest: Dest }) | (Base & { type: 'dong'; codes: string[] });

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
  }
}

// ---------------------------------------------------------------- 평가
export interface FilterCtx {
  me: MetricEval;
  catOf: (cellId: string) => string | null;
}

export function evalFilter(f: FilterDef, cell: Cell, ctx: FilterCtx): { ok: boolean; detail: string } {
  switch (f.type) {
    case 'commute': {
      const m = estimateCommute(cell.center, f.dest).min;
      return { ok: m <= f.maxMin, detail: `약 ${m}분` };
    }
    case 'dong':
      return { ok: f.codes.length === 0 || f.codes.includes(cell.dongCode), detail: cell.dongName };
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
