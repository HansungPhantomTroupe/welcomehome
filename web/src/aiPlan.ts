/**
 * AI ↔ 조건 찾기 목록 변환
 *
 * AI는 조건 목록 전체를 "항목" 배열로 다시 낸다 (위에서부터 모두 만족 = AND).
 *  - { keep: id }                     기존 조건 그대로 (enabled 만 바꿀 수 있음)
 *  - { id?, type: 'pop' | 'poi' | 'depts' | 'category' | 'commute' | 'dong' | 'custom', ... }
 *    id 를 주면 그 기존 조건을 바꾼 것 (입력값·켜짐 유지에 씀), 없으면 새 조건
 * 이미 UI 로 다룰 수 있는 조건은 그 형식으로, 안 되는 것만 custom(스크립트)으로.
 */
import { newPoiCond, newPopCond, POI_KEYS, type Category, type Cond, type PoiCat } from './classify';
import type { CustomScript } from './customExamples';
import type { Dest, FilterDef, ParamValue } from './filters';

export type PlanItem = Record<string, any>;

const nums = (v: unknown, n: number) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 0 && x < n);
const crit = (it: PlanItem) => ({
  op: (['gte', 'lte', 'between'].includes(it.op) ? it.op : 'gte') as 'gte' | 'lte' | 'between',
  mode: (['abs', 'pct', 'level'].includes(it.mode) ? it.mode : 'abs') as 'abs' | 'pct' | 'level',
  value: Number(it.value ?? 0),
  ...(it.value2 !== undefined ? { value2: Number(it.value2) } : {}),
});

/** 기존 조건 → AI가 읽을 항목 */
export function toItem(f: FilterDef, text: string): PlanItem {
  const base = { id: f.id, enabled: f.enabled, text };
  switch (f.type) {
    case 'cell':
      if (f.pred.kind === 'category') return { ...base, type: 'category', ids: f.pred.ids };
      {
        const { adv: _a, deg: _d, scope: _s, ...c } = f.pred.cond as Cond & { adv?: unknown; deg?: unknown; scope?: unknown };
        return { ...base, type: c.src, ...c, src: undefined };
      }
    case 'commute':
      return { ...base, type: 'commute', dest: f.dest.name, maxMin: f.maxMin };
    case 'dong':
      return { ...base, type: 'dong', codes: f.codes };
    case 'custom':
      return { ...base, type: 'custom', name: f.script.name, description: f.script.description, params: f.script.params, values: f.values, code: f.script.code };
  }
}

interface Ctx {
  current: FilterDef[];
  cats: Category[];
  dests: Dest[];
  dongCodes: Set<string>;
}

/** AI 항목 → 조건 목록. 못 읽은 항목은 errors 에 */
export function fromItems(items: PlanItem[], ctx: Ctx): { stack: FilterDef[]; errors: string[] } {
  const byId = new Map(ctx.current.map((f) => [f.id, f]));
  const errors: string[] = [];
  const stack: FilterDef[] = [];
  let seq = 0;
  const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.keep) {
      const f = byId.get(it.keep);
      if (f) stack.push(typeof it.enabled === 'boolean' ? { ...f, enabled: it.enabled } : f);
      else errors.push(`없는 조건 id: ${it.keep}`);
      continue;
    }
    const old = it.id ? byId.get(it.id) : undefined;
    const base = { id: old?.id ?? newId(), enabled: typeof it.enabled === 'boolean' ? it.enabled : old?.enabled ?? true };
    try {
      stack.push({ ...base, ...build(it, ctx, old) } as FilterDef);
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  return { stack, errors };
}

function build(it: PlanItem, ctx: Ctx, old?: FilterDef): Omit<FilterDef, 'id' | 'enabled'> {
  switch (it.type) {
    case 'pop': {
      const c = newPopCond({
        ...(nums(it.days, 2) ? { days: it.days } : {}),
        ...(nums(it.times, 4) ? { times: it.times } : {}),
        ...(nums(it.kinds, 3) ? { kinds: it.kinds } : {}),
        ...(nums(it.ages, 6) ? { ages: it.ages } : {}),
        ...(nums(it.sexes, 2) ? { sexes: it.sexes } : {}),
        measure: it.measure === 'share' ? 'share' : 'count',
        ...crit(it),
      });
      return { type: 'cell', pred: { kind: 'metric', cond: c } } as any;
    }
    case 'poi': {
      const cats = (Array.isArray(it.cats) ? it.cats : []).filter((k: string) => (POI_KEYS as string[]).includes(k)) as PoiCat[];
      if (!cats.length) throw new Error(`poi.cats 는 ${POI_KEYS.join('·')} 중에서`);
      const cond = { ...newPoiCond(cats, { ...crit(it), mode: it.mode === 'pct' ? 'pct' : 'abs' }), by: it.by === 'dist' ? 'dist' : 'count' };
      return { type: 'cell', pred: { kind: 'metric', cond } } as any;
    }
    case 'depts':
      return { type: 'cell', pred: { kind: 'metric', cond: { src: 'depts', ...crit(it), mode: it.mode === 'pct' ? 'pct' : 'abs' } } } as any;
    case 'category': {
      const ids = (Array.isArray(it.ids) ? it.ids : []).filter((id: string) => ctx.cats.some((c) => c.id === id));
      if (!ids.length) throw new Error('category.ids 는 동네 성격 id 중에서');
      return { type: 'cell', pred: { kind: 'category', ids } } as any;
    }
    case 'commute': {
      const dest = ctx.dests.find((d) => d.name === it.dest);
      if (!dest) throw new Error(`commute.dest 는 ${ctx.dests.map((d) => d.name).join('·')} 중 하나`);
      return { type: 'commute', dest, maxMin: Math.max(1, Number(it.maxMin) || 20) } as any;
    }
    case 'dong': {
      const codes = (Array.isArray(it.codes) ? it.codes : []).map(String).filter((c: string) => ctx.dongCodes.has(c));
      if (!codes.length) throw new Error('dong.codes 는 행정동 코드 중에서');
      return { type: 'dong', codes } as any;
    }
    case 'custom': {
      const script: CustomScript = { name: it.name, description: it.description ?? '', params: it.params ?? [], code: it.code };
      const keep = old?.type === 'custom' ? old.values : {};
      const values: Record<string, ParamValue> = { ...keep, ...(it.values ?? {}) };
      // 사라진 입력칸 값은 버림
      for (const k of Object.keys(values)) if (!script.params.some((p) => p.key === k)) delete values[k];
      return { type: 'custom', script, values } as any;
    }
  }
  throw new Error(`모르는 조건 종류: ${it.type}`);
}

/** 바뀐 점 (화면용) */
export function diff(cur: FilterDef[], next: FilterDef[]) {
  const curIds = new Set(cur.map((f) => f.id));
  const nextIds = new Set(next.map((f) => f.id));
  const same = (a: FilterDef, b: FilterDef) => JSON.stringify(a) === JSON.stringify(b);
  return {
    rows: next.map((f) => {
      const o = cur.find((x) => x.id === f.id);
      return { f, mark: !curIds.has(f.id) ? ('add' as const) : o && same(o, f) ? ('keep' as const) : ('edit' as const) };
    }),
    removed: cur.filter((f) => !nextIds.has(f.id)),
  };
}
