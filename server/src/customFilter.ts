/**
 * 커스텀 필터 실행기 — AI(또는 개발자)가 짠 JavaScript 필터를 격리된 QuickJS(WebAssembly)에서 돌린다.
 *
 * 스크립트는 파일·네트워크·서버 내부에 접근할 수 없고, 아래 칸 데이터와 도우미 함수만 쓸 수 있다.
 * 실행 시간·메모리에 한도가 있다.
 *
 * 스크립트 형식: function filter(cell, ctx) { ... return true | false | { pass, value } }
 *  cell: { id, i, j, lat, lng, dong, total, slots[2][4], pop[24], demo[72], kind{resident,worker,visitor}, poi{...}, depts, near{종류: m} }
 *  ctx : params · cells · get(id) · at(cell, di, dj) · near(cell, m) · dist(a, b) · pop(cell, 옵션) · share(cell, 옵션)
 *        poi(cell, 종류[]) · nearest(cell, 종류) · rank(fn)(cell) · median(xs) · quantile(xs, q)
 */
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { Cell, Place } from '../../shared/types';

export interface ScriptParam {
  key: string;
  label: string;
  type: 'number' | 'select' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}
export interface CustomScript {
  name: string;
  description: string;
  params: ScriptParam[];
  code: string;
}
export interface RunResult {
  ok: boolean;
  pass: string[];
  values: Record<string, number>;
  ms: number;
  error?: string;
}

const TIME_LIMIT_MS = 3000;
const MEMORY_LIMIT = 128 * 1024 * 1024;

/** 스크립트 형식 검사 — 잘못된 곳을 사람이 읽을 문장으로 */
export function validateScript(s: unknown): string | null {
  const x = s as CustomScript;
  if (!x || typeof x !== 'object') return '스크립트가 비어 있어요.';
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 60) return 'name: 1~60자 문자열';
  if (typeof x.description !== 'string' || x.description.length > 300) return 'description: 300자 이하 문자열';
  if (typeof x.code !== 'string' || x.code.length > 20000) return 'code: 20,000자 이하 문자열';
  if (!/function\s+filter\s*\(/.test(x.code)) return 'code 에 function filter(cell, ctx) 가 있어야 해요.';
  if (!Array.isArray(x.params) || x.params.length > 8) return 'params: 8개 이하 배열';
  for (const p of x.params) {
    if (!p || typeof p.key !== 'string' || !/^[A-Za-z_]\w{0,30}$/.test(p.key)) return `params.key 는 영문 변수 이름 (${p?.key})`;
    if (typeof p.label !== 'string' || !p.label) return `params.${p.key}.label 필요`;
    if (!['number', 'select', 'boolean'].includes(p.type)) return `params.${p.key}.type 은 number · select · boolean`;
    if (p.type === 'number' && typeof p.default !== 'number') return `params.${p.key}.default 는 숫자`;
    if (p.type === 'boolean' && typeof p.default !== 'boolean') return `params.${p.key}.default 는 true/false`;
    if (p.type === 'select' && (!Array.isArray(p.options) || !p.options.length || !p.options.some((o) => o.value === p.default)))
      return `params.${p.key}: options 와 그 안의 default 필요`;
  }
  return null;
}

// ---------- 스크립트에 넘길 칸 데이터 ----------
const POI_KEYS = ['food', 'cafe', 'bar', 'conv', 'hosp', 'pharm', 'gym', 'subway', 'mart'] as const;
let payload: { key: unknown; json: string } | null = null;
function cellPayload(cells: Cell[], places: Place[], size: number) {
  if (payload?.key === cells) return payload.json;
  // 종류별 가장 가까운 시설까지 거리 (m)
  const B = 0.004;
  const bucket = new Map<string, Place[]>();
  for (const p of places) {
    const k = `${Math.floor(p.lat / B)}:${Math.floor(p.lng / B)}`;
    (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(p);
  }
  const d = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 88200);
  const nearestOf = (c: Cell, key: string) => {
    for (const r of [1, 3, 8]) {
      let best = Infinity;
      const [bi, bj] = [Math.floor(c.center.lat / B), Math.floor(c.center.lng / B)];
      for (let i = bi - r; i <= bi + r; i++)
        for (let j = bj - r; j <= bj + r; j++)
          for (const p of bucket.get(`${i}:${j}`) ?? []) if (key === 'bar' ? p.bar : p.cat === key) best = Math.min(best, d(c.center, p));
      if (best <= r * B * 88200) return Math.round(best);
    }
    return null;
  };
  const out = cells.map((c) => {
    const [, i, j] = c.id.match(/^SB(\d+)_(\d+)$/)!.map(Number);
    return {
      id: c.id,
      i,
      j,
      lat: c.center.lat,
      lng: c.center.lng,
      dong: c.dongName,
      total: c.total,
      slots: c.slots,
      pop: c.pop,
      demo: c.demo,
      kind: c.kindShare,
      poi: c.poi,
      depts: c.depts.length,
      near: Object.fromEntries(POI_KEYS.map((k) => [k, nearestOf(c, k)])),
    };
  });
  payload = { key: cells, json: JSON.stringify({ size, cells: out }) };
  return payload.json;
}

// 스크립트 안에서 쓰는 도우미 (QuickJS 안에서 실행)
const PRELUDE = String.raw`
const __D = JSON.parse(__JSON);
const SIZE = __D.size;
const CELLS = __D.cells;
const __by = {}, __at = {};
for (const c of CELLS) { __by[c.id] = c; __at[c.i + ',' + c.j] = c; }
const __ALL = { days: [0, 1], times: [0, 1, 2, 3], kinds: [0, 1, 2], ages: [0, 1, 2, 3, 4, 5], sexes: [0, 1] };
function __dist(a, b) { return Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 88200); }
function __sum(c, o) {
  let v = 0;
  for (const d of o.days) for (const k of o.kinds) {
    let sh = 1;
    if (o.ages.length < 6 || o.sexes.length < 2) { sh = 0; for (const s of o.sexes) for (const a of o.ages) sh += c.demo[((d * 3 + k) * 2 + s) * 6 + a]; }
    for (const t of o.times) v += c.pop[(d * 4 + t) * 3 + k] * sh;
  }
  return v;
}
const __rank = {};
const ctx = {
  params: __PARAMS,
  cells: CELLS,
  size: SIZE,
  get: (id) => __by[id] || null,
  at: (c, di, dj) => __at[(c.i + di) + ',' + (c.j + dj)] || null,
  dist: __dist,
  near(c, m) {
    const r = Math.ceil(m / SIZE), out = [];
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (!di && !dj) continue;
      const n = __at[(c.i + di) + ',' + (c.j + dj)];
      if (n && __dist(c, n) <= m) out.push(n);
    }
    return out;
  },
  pop(c, opt) { const o = Object.assign({}, __ALL, opt || {}); return __sum(c, o) / (o.days.length * o.times.length); },
  share(c, opt) {
    const o = Object.assign({}, __ALL, opt || {});
    const base = (o.ages.length < 6 || o.sexes.length < 2) ? Object.assign({}, o, { ages: __ALL.ages, sexes: __ALL.sexes }) : Object.assign({}, o, { kinds: __ALL.kinds });
    const b = __sum(c, base);
    return b > 0 ? (__sum(c, o) / b) * 100 : 0;
  },
  poi(c, cats) { return [].concat(cats).reduce((s, k) => s + (c.poi[k] || 0), 0); },
  nearest(c, cat) { const v = c.near[cat]; return v == null ? Infinity : v; },
  median(xs) { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; },
  quantile(xs, q) { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; },
  rank(fn) {
    const k = String(fn);
    if (!__rank[k]) {
      const vals = CELLS.map(fn), sorted = vals.slice().sort((a, b) => a - b), m = {};
      CELLS.forEach((c, i) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < vals[i]) lo = mid + 1; else hi = mid; } m[c.id] = sorted.length > 1 ? lo / (sorted.length - 1) : 0; });
      __rank[k] = m;
    }
    return (c) => __rank[k][c.id];
  },
};
`;
const RUNNER = String.raw`
(function () {
  if (typeof filter !== 'function') throw new Error('function filter(cell, ctx) 가 없어요');
  const out = { pass: [], values: {} };
  for (const c of CELLS) {
    const r = filter(c, ctx);
    if (r && typeof r === 'object') { if (typeof r.value === 'number' && isFinite(r.value)) out.values[c.id] = r.value; if (r.pass) out.pass.push(c.id); }
    else { if (typeof r === 'number' && isFinite(r)) out.values[c.id] = r; if (r) out.pass.push(c.id); }
  }
  return JSON.stringify(out);
})()
`;

/** 스크립트를 모든 칸에 돌린다 */
export async function runCustom(cells: Cell[], places: Place[], size: number, script: CustomScript, values: Record<string, unknown>): Promise<RunResult> {
  const t0 = Date.now();
  const params = Object.fromEntries(script.params.map((p) => [p.key, p.key in values ? values[p.key] : p.default]));
  const QJS = await getQuickJS();
  const rt = QJS.newRuntime();
  rt.setMemoryLimit(MEMORY_LIMIT);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS));
  const vm = rt.newContext();
  try {
    const json = vm.newString(cellPayload(cells, places, size));
    vm.setProp(vm.global, '__JSON', json);
    json.dispose();
    const step = (code: string, where: string) => {
      const r = vm.evalCode(code, where);
      if (r.error) {
        const e = vm.dump(r.error);
        r.error.dispose();
        const msg = e?.message === 'interrupted' ? `시간 초과 (${TIME_LIMIT_MS / 1000}초)` : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
        throw new Error(msg + (e?.stack ? `\n${String(e.stack).split('\n').slice(0, 3).join('\n')}` : ''));
      }
      return r.value;
    };
    step(`const __PARAMS = ${JSON.stringify(params)};`, 'params.js');
    step(PRELUDE, 'prelude.js').dispose();
    step(script.code, 'filter.js').dispose();
    const v = step(RUNNER, 'run.js');
    const out = JSON.parse(vm.getString(v));
    v.dispose();
    return { ok: true, pass: out.pass, values: out.values, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, pass: [], values: {}, ms: Date.now() - t0, error: String(e.message ?? e) };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}
