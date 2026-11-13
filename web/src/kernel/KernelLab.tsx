/**
 * 커널 실험실 — 생활권 탐색과 완전히 별도인 페이지.
 * 단계를 쌓아 '구역마다 숫자 하나'인 지도를 차례로 만들고, 어느 단계든 지도에 띄워 본다.
 * 구역을 누르면 단계별 값과, 보고 있는 커널 단계가 그 구역에서 어느 이웃 칸들을 섞었는지 보여준다.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Cell, DongStat, Meta, Place } from '@shared/types';
import { AGES, DAYS, KINDS, POI_CATS, POI_KEYS, SEXES, TIMES, condSubject, defaultCategories, makeMetricEval, newCond, type Category, type Cond, type PoiCat } from '../classify';
import KakaoMap, { hasKakaoKey } from '../map/KakaoMap';
import SvgMap from '../map/SvgMap';
import type { FitRequest, MapLayers, MapPolygon } from '../map/types';
import {
  CELL_M,
  COP_LABEL,
  KIND_LABEL,
  KOP_LABEL,
  MAX_RADIUS_M,
  SHAPE_LABEL,
  exportSpec,
  kernelOffsets,
  kernelWindow,
  makeGrid,
  runSpec,
  thresholdOf,
  validateSpec,
  type CombineOp,
  type KernelOp,
  type KernelShape,
  type RunResult,
  type Step,
  type StepKind,
  type StepResult,
} from './engine';
import { KERNEL_EXAMPLES } from './examples';

interface Bootstrap {
  cells: Cell[];
  dongStats: DongStat[];
  meta: Meta;
}

const ACCENT = '#1d4c93';
const WIN = '#7c3aed';
const HEAT_RAMP = ['#fff4cc', '#fdd28a', '#f8a25a', '#e5643a', '#b3301c'];
const STEP_COLORS = ['#2563eb', '#0d9488', '#d97706', '#db2777', '#7c3aed', '#059669', '#dc2626', '#4f46e5'];

function usePersisted<T>(key: string, init: () => T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? init() : (JSON.parse(raw) as T);
    } catch {
      return init();
    }
  });
  const set = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(key, JSON.stringify(nv));
    } catch {
      /* 저장 실패는 무시 */
    }
  };
  return [v, set];
}

/** 생활권 탐색에서 사용자가 편집해 둔 종류를 그대로 쓴다 (없으면 처음 기준) */
function loadCategories(): Category[] {
  try {
    const raw = localStorage.getItem('wh.categories.v7');
    if (raw) return JSON.parse(raw) as Category[];
  } catch {
    /* 무시 */
  }
  return defaultCategories();
}

const fmt = (v: number) => (!Number.isFinite(v) ? '-' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? String(v) : v.toFixed(1));

export default function KernelLab() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/bootstrap')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then((d) => setData(d))
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="fatal">데이터를 불러오지 못했습니다: {err}</div>;
  if (!data) return <div className="fatal">불러오는 중…</div>;
  return <Lab data={data} />;
}

// ---------------------------------------------------------------- 단계 만들기
function nextId(steps: Step[]) {
  const used = new Set(steps.map((s) => s.id));
  for (let k = 0; k < 26; k++) {
    const id = String.fromCharCode(65 + k);
    if (!used.has(id)) return id;
  }
  let n = 1;
  while (used.has(`S${n}`)) n++;
  return `S${n}`;
}
function newStep(kind: StepKind, steps: Step[], cats: Category[]): Step {
  const id = nextId(steps);
  const last = steps[steps.length - 1]?.id ?? '';
  const prev = steps[steps.length - 2]?.id ?? last;
  switch (kind) {
    case 'source':
      return { id, label: '', kind, cond: newCond('pop') };
    case 'category':
      return { id, label: '', kind, cats: cats[0] ? [cats[0].id] : [] };
    case 'kernel':
      return { id, label: '', kind, input: last, shape: 'disk', r: 400, rIn: 0, op: 'mean' };
    case 'threshold':
      return { id, label: '', kind, input: last, op: 'gte', mode: 'pct', value: 25 };
    case 'combine':
      return { id, label: '', kind, a: prev, b: last, op: 'and' };
    case 'blob':
      return { id, label: '', kind, input: last, minCells: 3 };
  }
}

/** 이름이 없을 때 보여줄 자동 설명 */
function autoText(s: Step, catName: (id: string) => string): string {
  switch (s.kind) {
    case 'source':
      return condSubject(s.cond).replace(/^가게·시설 전체$/, '가게·시설 개수');
    case 'category':
      return s.cats.map(catName).join('·') || '종류 고르기';
    case 'kernel':
      return `${s.input} 주변 ${s.shape === 'ring' ? `${s.rIn}~${s.r}m 고리` : `${s.r}m ${SHAPE_LABEL[s.shape]}`} ${KOP_LABEL[s.op].split(' ')[0]}`;
    case 'threshold':
      return s.mode === 'pct' ? `${s.input} ${s.op === 'gte' ? '상위' : '하위'} ${s.value}%` : `${s.input} ${fmt(s.value)} ${s.op === 'gte' ? '이상' : '이하'}`;
    case 'combine':
      return s.op === 'and_not' ? `${s.a} 이면서 ${s.b} 아님` : `${s.a} ${COP_LABEL[s.op].split(' ')[0]} ${s.b}`;
    case 'blob':
      return `${s.input} 중 ${s.minCells}구역 이상 덩어리`;
  }
}

// ---------------------------------------------------------------- 페이지
function Lab({ data }: { data: Bootstrap }) {
  const grid = useMemo(() => makeGrid(data.cells), [data]);
  const me = useMemo(() => makeMetricEval(data.cells), [data]);
  const cats = useMemo(loadCategories, []);
  const catName = (id: string) => cats.find((c) => c.id === id)?.label ?? id;

  const [steps, setSteps] = usePersisted<Step[]>('wh.kernel.v1', () => []);
  const [viewRaw, setView] = usePersisted<string | null>('wh.kernel.view', () => null);
  const [selected, select] = useState<number | null>(null);
  const run: RunResult = useMemo(() => runSpec(steps, { grid, me, cats }), [steps, grid, me, cats]);

  // 지도에 띄울 단계: 고른 게 없거나 지워졌으면 마지막 단계
  const viewId = viewRaw && steps.some((s) => s.id === viewRaw) ? viewRaw : steps[steps.length - 1]?.id ?? null;
  const viewStep = steps.find((s) => s.id === viewId) ?? null;
  const viewRes = viewId ? run.byId.get(viewId) ?? null : null;

  const update = (id: string, patch: Partial<Step>) => setSteps(steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)));
  const remove = (id: string) => setSteps(steps.filter((s) => s.id !== id));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const add = (kind: StepKind) => {
    const s = newStep(kind, steps, cats);
    setSteps([...steps, s]);
    setView(s.id);
  };

  // ---------- 지도 ----------
  const levels = useMemo(() => {
    if (!viewRes || viewRes.binary) return null;
    const sorted = Float64Array.from(viewRes.values).sort();
    const rank = (v: number) => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo / Math.max(1, sorted.length - 1);
    };
    // 값이 전부 같으면 가운데 색
    if (viewRes.min === viewRes.max) return Array.from(viewRes.values, () => 2);
    return Array.from(viewRes.values, (v) => Math.min(4, Math.floor(rank(v) * 5)));
  }, [viewRes]);

  const win = useMemo(() => (selected !== null && viewStep?.kind === 'kernel' ? kernelWindow(viewStep, grid, selected) : null), [selected, viewStep, grid]);

  const layers: MapLayers = useMemo(() => {
    const polygons: MapPolygon[] = [];
    data.cells.forEach((cell, i) => {
      const isSel = i === selected;
      let fill = '#000000';
      let fillOpacity = 0.01;
      if (viewRes?.binary) {
        if (viewRes.values[i] > 0) [fill, fillOpacity] = [ACCENT, 0.55];
      } else if (levels) [fill, fillOpacity] = [HEAT_RAMP[levels[i]], 0.8];
      polygons.push({
        id: cell.id,
        paths: [cell.corners],
        stroke: isSel ? '#0b0f17' : '#334155',
        strokeWeight: isSel ? 3 : 1,
        strokeOpacity: isSel ? 1 : 0.15,
        fill,
        fillOpacity,
        zIndex: isSel ? 6 : 1,
        onClick: () => select(isSel ? null : i),
      });
    });
    // 커널 창: 이 구역 값을 만들 때 섞은 이웃 칸 (진할수록 가중치 큼)
    if (win) {
      const wmax = Math.max(...win.map((x) => x.w), 1e-9);
      for (const { j, w } of win) {
        const c = data.cells[j];
        polygons.push({
          id: `win-${c.id}`,
          paths: [c.corners],
          stroke: WIN,
          strokeWeight: 2,
          strokeOpacity: 0.9,
          fill: WIN,
          fillOpacity: 0.08 + 0.27 * (w / wmax),
          zIndex: 4,
          onClick: () => select(j === selected ? null : j),
        });
      }
    }
    return { polygons, circles: [], lines: [], markers: [] };
  }, [data, viewRes, levels, selected, win]);

  const fit: FitRequest = useMemo(() => ({ key: 'init', points: data.cells.map((x) => x.center) }), [data]);
  const [mapError, setMapError] = useState<string | null>(null);
  const useKakao = hasKakaoKey && !mapError;
  const mapProps = { layers, fit, blend: 'multiply' };

  const selCell = selected !== null ? data.cells[selected] : null;

  return (
    <div className="app klab">
      <aside className="panel" style={{ width: 460 }}>
        <header className="k-head">
          <div>
            <b>커널 실험실</b>
            <small>주변 구역을 섞어 새 지도 만들기</small>
          </div>
          <a className="k-back" href="/">
            ← 생활권 탐색
          </a>
        </header>
        <div className="k-body">
          {steps.length === 0 && (
            <div className="k-intro">
              단계를 위에서부터 쌓아 지도를 만들어요. 단계마다 <b>구역 611곳에 숫자가 하나씩</b> 생기고, 다음 단계가 그 숫자를 받아 써요.
              <br />
              먼저 <b>+ 데이터</b>나 <b>+ 종류</b>로 시작하거나, 아래 <b>예시</b>를 불러와 고쳐 보세요.
            </div>
          )}
          {steps.map((s, i) => (
            <StepCard
              key={s.id}
              step={s}
              color={STEP_COLORS[i % STEP_COLORS.length]}
              before={steps.slice(0, i)}
              res={run.byId.get(s.id) ?? null}
              inputRes={run}
              error={run.errors.get(s.id) ?? null}
              total={data.cells.length}
              viewing={s.id === viewId}
              onView={() => setView(s.id)}
              onChange={(p) => update(s.id, p)}
              onRemove={() => remove(s.id)}
              onUp={i > 0 ? () => move(i, -1) : undefined}
              onDown={i < steps.length - 1 ? () => move(i, 1) : undefined}
              cats={cats}
              auto={autoText(s, catName)}
              selValue={selected !== null ? run.byId.get(s.id)?.values[selected] ?? null : null}
            />
          ))}
          <div className="k-add">
            {(Object.keys(KIND_LABEL) as StepKind[]).map((k) => (
              <button key={k} onClick={() => add(k)} disabled={k !== 'source' && k !== 'category' && steps.length === 0} title={KIND_HINT[k]}>
                + {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <Examples
            startOpen={steps.length === 0}
            onLoad={(raw) => {
              if (steps.length && !window.confirm('지금 단계를 지우고 예시를 불러올까요?')) return null;
              const r = validateSpec(raw, cats.map((c) => c.id));
              if ('error' in r) return r.error;
              setSteps(r.steps);
              setView(r.steps[r.steps.length - 1]?.id ?? null);
              select(null);
              return null;
            }}
          />
          <SpecJson steps={steps} catIds={cats.map((c) => c.id)} onApply={(s) => setSteps(s)} />
        </div>
      </aside>
      <main className="map-wrap">
        {useKakao ? <KakaoMap {...mapProps} onError={(e) => setMapError(e.message)} /> : <SvgMap {...mapProps} />}
        {viewStep && viewRes && (
          <div className="legend-box">
            <div className="lg-title">
              지도: {viewStep.id} · {viewStep.label || autoText(viewStep, catName)}
            </div>
            {viewRes.binary ? (
              <div className="lg-row">
                <span className="fill-sample" /> 맞는 곳 {viewRes.count}곳 / {data.cells.length}
              </div>
            ) : (
              <>
                <div className="heat-bar">
                  {HEAT_RAMP.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </div>
                <div className="heat-scale">
                  <span>낮음 {fmt(viewRes.min)}</span>
                  <span>높음 {fmt(viewRes.max)}</span>
                </div>
              </>
            )}
            {win && <div className="lg-row k-win-note">보라 칸 = 선택 구역 값을 만들 때 섞은 이웃 {win.length}칸</div>}
          </div>
        )}
        {selCell && (
          <div className="k-sel">
            <b>{selCell.dongName}</b> 구역 선택됨 · 단계별 값은 왼쪽 카드에
            <button className="link" onClick={() => select(null)}>
              해제
            </button>
          </div>
        )}
        {mapError && <div className="map-error">{mapError} — 간이 지도로 표시합니다.</div>}
      </main>
    </div>
  );
}

const KIND_HINT: Record<StepKind, string> = {
  source: '유동인구·가게 개수 같은 값을 구역마다 가져와요',
  category: '주거지 종류에 속하면 1, 아니면 0',
  kernel: '주변 구역들을 섞어 새 값을 만들어요',
  threshold: '기준 이상/이하면 1, 아니면 0',
  combine: '두 단계를 그리고·또는·빼기로 합쳐요',
  blob: '붙어 있는 덩어리 중 큰 것만 남겨요',
};

// ---------------------------------------------------------------- 단계 카드
function StepCard(props: {
  step: Step;
  color: string;
  before: Step[];
  res: StepResult | null;
  inputRes: RunResult;
  error: string | null;
  total: number;
  viewing: boolean;
  onView: () => void;
  onChange: (p: Partial<Step>) => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
  cats: Category[];
  auto: string;
  selValue: number | null;
}) {
  const { step: s, color, before, res, error, viewing, onChange } = props;
  return (
    <section className={`k-step ${viewing ? 'viewing' : ''}`} style={{ borderLeftColor: color }}>
      <div className="k-step-head">
        <span className="k-id" style={{ background: color }}>
          {s.id}
        </span>
        <span className="k-kind">{KIND_LABEL[s.kind]}</span>
        <input className="k-label" value={s.label} placeholder={props.auto} onChange={(e) => onChange({ label: e.target.value })} />
        <button className={`k-eye ${viewing ? 'on' : ''}`} onClick={props.onView} title="이 단계 결과를 지도에">
          지도
        </button>
        <button className="k-mini" onClick={props.onUp} disabled={!props.onUp} title="위로">
          ▲
        </button>
        <button className="k-mini" onClick={props.onDown} disabled={!props.onDown} title="아래로">
          ▼
        </button>
        <button className="k-mini" onClick={props.onRemove} title="삭제">
          ✕
        </button>
      </div>
      <div className="k-step-body">
        {s.kind === 'source' && <SourceEdit cond={s.cond} onChange={(cond) => onChange({ cond })} />}
        {s.kind === 'category' && (
          <Row label="종류">
            <div className="k-chips">
              {props.cats.map((c) => (
                <Chip
                  key={c.id}
                  on={s.cats.includes(c.id)}
                  onClick={() => onChange({ cats: toggle(s.cats, c.id) })}
                >
                  <i className="k-dot" style={{ background: c.color }} />
                  {c.label}
                </Chip>
              ))}
            </div>
          </Row>
        )}
        {s.kind === 'kernel' && <KernelEdit step={s} before={before} onChange={onChange} />}
        {s.kind === 'threshold' && <ThresholdEdit step={s} before={before} run={props.inputRes} onChange={onChange} />}
        {s.kind === 'combine' && (
          <>
            <Row label="A">
              <InputPick value={s.a} before={before} onChange={(a) => onChange({ a })} />
            </Row>
            <Row label="방법">
              <select value={s.op} onChange={(e) => onChange({ op: e.target.value as CombineOp })}>
                {(Object.keys(COP_LABEL) as CombineOp[]).map((k) => (
                  <option key={k} value={k}>
                    {COP_LABEL[k]}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="B">
              <InputPick value={s.b} before={before} onChange={(b) => onChange({ b })} />
            </Row>
          </>
        )}
        {s.kind === 'blob' && (
          <>
            <Row label="입력">
              <InputPick value={s.input} before={before} onChange={(input) => onChange({ input })} />
            </Row>
            <Row label="크기">
              <input type="number" min={1} max={200} value={s.minCells} onChange={(e) => onChange({ minCells: Math.max(1, Math.round(+e.target.value || 1)) })} />
              <span className="muted">구역 이상 붙어 있는 덩어리만 (대각선도 붙은 걸로)</span>
            </Row>
          </>
        )}
      </div>
      <div className="k-result">
        {error ? (
          <span className="k-err">{error}</span>
        ) : res ? (
          <>
            {res.binary ? (
              <span>
                → 맞는 곳 <b>{res.count}</b>곳 / {props.total}
              </span>
            ) : (
              <span>
                → 최소 {fmt(res.min)} · 평균 {fmt(res.mean)} · 최대 {fmt(res.max)}
              </span>
            )}
            {props.selValue !== null && (
              <span className="k-selv">
                선택 구역 <b>{res.binary ? (props.selValue > 0 ? '✓ 맞음' : '✕ 아님') : fmt(props.selValue)}</b>
              </span>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="k-row">
      <span className="k-row-label">{label}</span>
      <div className="k-row-body">{children}</div>
    </div>
  );
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`k-chip ${on ? 'on' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="k-seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
/** 하나도 안 남게 끄지는 못함 */
function toggle<T>(xs: T[], x: T): T[] {
  if (xs.includes(x)) return xs.length > 1 ? xs.filter((v) => v !== x) : xs;
  return [...xs, x];
}
const toggleN = (xs: number[], x: number) => toggle(xs, x).sort((a, b) => a - b);

function InputPick({ value, before, onChange }: { value: string; before: Step[]; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!before.some((b) => b.id === value) && <option value={value}>{value ? `${value} (없음)` : '고르기'}</option>}
      {before.map((b) => (
        <option key={b.id} value={b.id}>
          {b.id} {b.label ? `· ${b.label}` : `· ${KIND_LABEL[b.kind]}`}
        </option>
      ))}
    </select>
  );
}

function SourceEdit({ cond, onChange }: { cond: Cond; onChange: (c: Cond) => void }) {
  return (
    <>
      <Row label="무엇">
        <Seg
          value={cond.src}
          options={[
            ['pop', '유동인구'],
            ['poi', '가게·시설 개수'],
            ['depts', '진료과 수'],
          ]}
          onChange={(src) => onChange(newCond(src))}
        />
      </Row>
      {cond.src === 'pop' && (
        <>
          <Row label="요일">
            <div className="k-chips">
              {DAYS.map((d, k) => (
                <Chip key={d} on={cond.days.includes(k)} onClick={() => onChange({ ...cond, days: toggleN(cond.days, k) })}>
                  {d}
                </Chip>
              ))}
            </div>
          </Row>
          <Row label="시간">
            <div className="k-chips">
              {TIMES.map((t, k) => (
                <Chip key={t} on={cond.times.includes(k)} onClick={() => onChange({ ...cond, times: toggleN(cond.times, k) })}>
                  {t}
                </Chip>
              ))}
            </div>
          </Row>
          <Row label="인구">
            <div className="k-chips">
              {KINDS.map((a, k) => (
                <Chip key={a} on={cond.kinds.includes(k)} onClick={() => onChange({ ...cond, kinds: toggleN(cond.kinds, k) })}>
                  {a}
                </Chip>
              ))}
            </div>
          </Row>
          <Row label="연령">
            <div className="k-chips">
              {AGES.map((a, k) => (
                <Chip key={a} on={cond.ages.includes(k)} onClick={() => onChange({ ...cond, ages: toggleN(cond.ages, k) })}>
                  {a}
                </Chip>
              ))}
            </div>
          </Row>
          <Row label="성별">
            <div className="k-chips">
              {SEXES.map((x, k) => (
                <Chip key={x} on={cond.sexes.includes(k)} onClick={() => onChange({ ...cond, sexes: toggleN(cond.sexes, k) })}>
                  {x}
                </Chip>
              ))}
            </div>
          </Row>
          <Row label="보기">
            <Seg
              value={cond.measure}
              options={[
                ['count', '사람 수'],
                ['share', '비율 %'],
              ]}
              onChange={(measure) => onChange({ ...cond, measure })}
            />
          </Row>
        </>
      )}
      {cond.src === 'poi' && (
        <Row label="종류">
          <div className="k-chips">
            {POI_KEYS.map((k) => (
              <Chip key={k} on={cond.cats.includes(k)} onClick={() => onChange({ ...cond, cats: toggle<PoiCat>(cond.cats, k) })}>
                {POI_CATS[k]}
              </Chip>
            ))}
          </div>
        </Row>
      )}
    </>
  );
}

const RADII = Array.from({ length: MAX_RADIUS_M / CELL_M }, (_, k) => (k + 1) * CELL_M);

function KernelEdit({ step: s, before, onChange }: { step: Extract<Step, { kind: 'kernel' }>; before: Step[]; onChange: (p: Partial<Step>) => void }) {
  return (
    <div className="k-kernel">
      <div className="k-kernel-form">
        <Row label="입력">
          <InputPick value={s.input} before={before} onChange={(input) => onChange({ input })} />
        </Row>
        <Row label="모양">
          <Seg<KernelShape>
            value={s.shape}
            options={(Object.keys(SHAPE_LABEL) as KernelShape[]).map((k) => [k, SHAPE_LABEL[k]])}
            onChange={(shape) => onChange({ shape, rIn: shape === 'ring' ? Math.min(s.rIn || s.r - CELL_M, s.r - CELL_M) : 0 })}
          />
        </Row>
        <Row label={s.shape === 'ring' ? '바깥' : '반경'}>
          <select value={s.r} onChange={(e) => onChange({ r: +e.target.value, rIn: Math.min(s.rIn, +e.target.value - CELL_M) })}>
            {RADII.map((r) => (
              <option key={r} value={r}>
                {r}m ({r / CELL_M}칸)
              </option>
            ))}
          </select>
        </Row>
        {s.shape === 'ring' && (
          <Row label="안쪽">
            <select value={s.rIn} onChange={(e) => onChange({ rIn: +e.target.value })}>
              {[0, ...RADII].filter((r) => r < s.r).map((r) => (
                <option key={r} value={r}>
                  {r}m부터
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label="연산">
          <select value={s.op} onChange={(e) => onChange({ op: e.target.value as KernelOp })}>
            {(Object.keys(KOP_LABEL) as KernelOp[]).map((k) => (
              <option key={k} value={k}>
                {KOP_LABEL[k]}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <KernelPreview step={s} />
    </div>
  );
}

/** 커널 모양 미리보기: 칸 색 진하기 = 가중치, 굵은 테두리 = 가운데(판단하는 구역) */
function KernelPreview({ step: s }: { step: Extract<Step, { kind: 'kernel' }> }) {
  const offs = kernelOffsets(s.shape, s.r, s.rIn, s.op);
  const R = Math.max(1, Math.round(s.r / CELL_M));
  const n = 2 * R + 1;
  const size = Math.max(5, Math.min(14, Math.floor(110 / n)));
  const wmax = Math.max(...offs.map((o) => o.w), 1e-9);
  const w = new Map(offs.map((o) => [`${o.dx},${o.dy}`, o.w]));
  const cms = s.op === 'center_minus_surround';
  const cells = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const isC = dx === 0 && dy === 0;
      const ww = isC && cms ? undefined : w.get(`${dx},${dy}`);
      cells.push(
        <rect
          key={`${dx},${dy}`}
          x={(dx + R) * size}
          y={(R - dy) * size}
          width={size - 1}
          height={size - 1}
          fill={ww !== undefined ? WIN : isC && cms ? '#f59e0b' : '#e5e7eb'}
          fillOpacity={ww !== undefined ? 0.2 + 0.8 * (ww / wmax) : 1}
          stroke={isC ? '#0b0f17' : 'none'}
          strokeWidth={isC ? 1.5 : 0}
        />,
      );
    }
  const used = offs.filter((o) => !cms || o.dx || o.dy).length;
  return (
    <div className="k-preview">
      <svg width={n * size} height={n * size} role="img" aria-label="커널 모양">
        {cells}
      </svg>
      <small>
        {used}칸 섞음{cms ? ' · 주황=가운데' : ''}
      </small>
    </div>
  );
}

function ThresholdEdit({ step: s, before, run, onChange }: { step: Extract<Step, { kind: 'threshold' }>; before: Step[]; run: RunResult; onChange: (p: Partial<Step>) => void }) {
  const inp = run.byId.get(s.input);
  const th = inp ? thresholdOf(s, inp.values) : null;
  return (
    <>
      <Row label="입력">
        <InputPick value={s.input} before={before} onChange={(input) => onChange({ input })} />
      </Row>
      <Row label="기준">
        <Seg
          value={s.mode}
          options={[
            ['pct', '순위 %'],
            ['abs', '값'],
          ]}
          onChange={(mode) => onChange({ mode, value: mode === 'pct' ? 25 : th !== null ? +th.toFixed(1) : 0 })}
        />
        <Seg
          value={s.op}
          options={[
            ['gte', s.mode === 'pct' ? '상위' : '이상'],
            ['lte', s.mode === 'pct' ? '하위' : '이하'],
          ]}
          onChange={(op) => onChange({ op })}
        />
        <input
          type="number"
          value={s.value}
          step={s.mode === 'pct' ? 5 : 'any'}
          min={s.mode === 'pct' ? 1 : undefined}
          max={s.mode === 'pct' ? 100 : undefined}
          onChange={(e) => onChange({ value: +e.target.value })}
        />
        {s.mode === 'pct' && <span className="muted">%</span>}
      </Row>
      {inp && th !== null && (
        <div className="hint">
          입력 범위 {fmt(inp.min)} ~ {fmt(inp.max)} · 지금 기준값 <b>{fmt(th)}</b> {s.op === 'gte' ? '이상' : '이하'}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 예시
function Examples({ startOpen, onLoad }: { startOpen: boolean; onLoad: (steps: unknown[]) => string | null }) {
  const [open, setOpen] = useState(startOpen);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="k-examples">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 예시 불러오기 ({KERNEL_EXAMPLES.length})
      </button>
      {open && (
        <div className="k-ex-list">
          {KERNEL_EXAMPLES.map((ex) => (
            <button key={ex.title} className="k-ex" onClick={() => setErr(onLoad(ex.steps))}>
              <b>{ex.title}</b>
              <small>{ex.desc}</small>
            </button>
          ))}
          {err && <div className="k-err">예시를 불러오지 못했어요 — {err} (종류를 지웠거나 바꿨다면 생길 수 있어요)</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 설계도 JSON
function SpecJson({ steps, catIds, onApply }: { steps: Step[]; catIds: string[]; onApply: (s: Step[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const current = () => JSON.stringify(exportSpec(steps), null, 2);
  return (
    <div className="k-json">
      <button
        className="link"
        onClick={() => {
          if (!open) setDraft(current());
          setOpen(!open);
          setMsg(null);
        }}
      >
        {open ? '▾' : '▸'} 설계도 JSON (저장·붙여넣기용)
      </button>
      {open && (
        <>
          <textarea
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setMsg(null);
            }}
          />
          <div className="k-json-actions">
            <button
              className="tool"
              onClick={() => {
                setDraft(current());
                setMsg(null);
              }}
            >
              지금 단계로 되돌리기
            </button>
            <button
              className="tool"
              onClick={() => navigator.clipboard?.writeText(draft).then(() => setMsg({ ok: true, text: '복사했어요' }), () => setMsg({ ok: false, text: '복사하지 못했어요' }))}
            >
              복사
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="tool primary"
              onClick={() => {
                let raw: unknown;
                try {
                  raw = JSON.parse(draft);
                } catch {
                  return setMsg({ ok: false, text: 'JSON 형식이 아니에요' });
                }
                const r = validateSpec(raw, catIds);
                if ('error' in r) return setMsg({ ok: false, text: r.error });
                onApply(r.steps);
                setMsg({ ok: true, text: `${r.steps.length}단계를 불러왔어요` });
              }}
            >
              적용
            </button>
          </div>
          {msg && <div className={msg.ok ? 'k-ok' : 'k-err'}>{msg.text}</div>}
          <div className="hint">종류 id: {catIds.join(', ')}</div>
        </>
      )}
    </div>
  );
}
