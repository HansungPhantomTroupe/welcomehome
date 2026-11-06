import { useEffect, useRef } from 'react';
import { CELL_SIZE } from '@shared/cellTypes';
import type { Cell } from '@shared/types';
import { condSubject, condText, condUnit, passes, DAY_HINT, DAYS, LEVEL_COLORS, LEVELS, levelText, newCond, POI_BY_DIST, POI_CATS, POI_KEYS, KINDS, AGES, SEXES, TIMES, type Cond, type MetricEval, type PoiCat, type Th } from './classify';

/** 조건 편집에 필요한 것 */
export interface ExplainCtx {
  /** 탐색 지역 전체 구역 */
  cells: Cell[];
  /** 이 주변 구역 (지도 화면 + 사방 여유) — 분포 표시용 */
  near: Cell[];
  me: MetricEval;
  /** 구역을 사람이 아는 이름으로 — "성신여대입구역 주변", "정릉3동" */
  place: (cell: Cell) => string;
  /** 지도에서 선택한 구역 — 분포 위에 위치를 표시 */
  selected: Cell | null;
  /** 지금 보는 지역 크기 설명 — "가로 2.4km × 세로 1.8km" */
  areaText: string;
  /** 지도에 색 세기로 보여줄 조건 (한 번에 하나) */
  heatId: string | null;
  setHeat: (h: { id: string; cond: Cond } | null) => void;
  /** 이 조건이 켜 둔 경우에만 끔 */
  clearHeat: (id: string) => void;
  /** 이 조건이 지금 색 세기로 켜져 있으면 바뀐 조건으로 갱신 */
  syncHeat: (id: string, cond: Cond) => void;
}

// ---------------------------------------------------------------- 작은 입력 부품
export function Pill<T extends string>({ value, options, onChange, title }: { value: T; options: [T, string][]; onChange: (v: T) => void; title?: string }) {
  return (
    <select className="pill" value={value} title={title} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function NumPill({ value, onChange, min = 0, step = 1, width = 3 }: { value: number; onChange: (v: number) => void; min?: number; step?: number; width?: number }) {
  return (
    <input type="number" className="pill num-pill" style={{ width: `${width + 1.6}em` }} min={min} step={step} value={value} onChange={(e) => onChange(Math.max(min, +e.target.value))} />
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className="seg">
      {options.map(([v, l]) => (
        <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </span>
  );
}

/** 여러 개 고르는 칩 — 하나는 반드시 남김 */
function Checks<T extends string | number>({ items, value, onChange, hints }: { items: [T, string][]; value: T[]; onChange: (v: T[]) => void; hints?: string[] }) {
  const all = value.length === items.length;
  return (
    <span className="checks-row">
      <button className={`chk all ${all ? 'on' : ''}`} onClick={() => onChange(items.map(([v]) => v))}>
        전체
      </button>
      {items.map(([v, l], i) => {
        const on = value.includes(v);
        return (
          <button
            key={String(v)}
            className={`chk ${on && !all ? 'on' : ''} ${on && all ? 'in-all' : ''}`}
            title={hints?.[i]}
            onClick={() => {
              // 전체 상태에서 누르면 그것 하나만, 아니면 토글 (빈 선택은 막음)
              if (all) return onChange([v]);
              const next = on ? value.filter((x) => x !== v) : [...value, v];
              if (next.length) onChange(next);
            }}
          >
            {l}
          </button>
        );
      })}
    </span>
  );
}


// ---------------------------------------------------------------- 조건 편집
export default function CondBuilder({
  id,
  cond,
  onChange,
  onRemove,
  x,
  autoPick,
}: {
  id: string;
  cond: Cond;
  onChange: (c: Cond) => void;
  onRemove?: () => void;
  x: ExplainCtx;
  /** 간단 모드 사람 조건이 아직 숫자가 없으면 지금 보는 지역 기준으로 바로 정함 (필터용) */
  autoPick?: boolean;
}) {
  const unit = condUnit(cond);
  const set = (p: Partial<Cond>) => onChange({ ...cond, ...p } as Cond);
  const setCombo = (p: Partial<Cond>) => onChange(keepRange(cond, { ...cond, ...p } as Cond, x));

  // 지도 색 세기: 열리면 이 조건으로 켜고, 편집하면 따라가고, 닫히면 끈다
  const heatOn = x.heatId === id;
  const mounted = useRef(false);
  useEffect(() => {
    x.setHeat({ id, cond });
    mounted.current = true;
    return () => x.clearHeat(id);
  }, []);
  useEffect(() => {
    if (mounted.current) x.syncHeat(id, cond);
  }, [cond]);

  const adv = !!cond.adv;
  return (
    <div className={`cb ${adv ? 'adv' : 'simple'}`}>
      {/* 모드 전환은 두 모드 모두 같은 자리(오른쪽 위) — 눌러도 버튼이 움직이지 않게 */}
      <div className="cb-head">
        <b>{adv ? condSubject(cond) : ''}</b>
        <span className="mode-seg" title="간단히: 자주 쓰는 선택지를 문장으로 / 세부 설정: 요일·시간·인구 종류·연령·성별 조합, 그래프로 기준 정하기">
          <Seg
            value={adv ? 'adv' : 'simple'}
            options={[
              ['simple', '간단히'],
              ['adv', '세부 설정'],
            ]}
            onChange={(m) => onChange(m === 'simple' ? toLevel({ ...cond, adv: false } as Cond, x.me) : ({ ...cond, adv: true } as Cond))}
          />
        </span>
        {onRemove && (
          <button className="x" onClick={onRemove} title="이 조건 지우기">
            ✕
          </button>
        )}
      </div>

      {!adv ? (
        <SimpleCond cond={cond} onChange={onChange} x={x} autoPick={autoPick} />
      ) : (
      <>
      {cond.src === 'pop' && (
        <>
          <div className="cb-row">
            <span className="cb-label">요일</span>
            <Checks items={DAYS.map((d, i) => [i, d] as [number, string])} hints={[...DAY_HINT]} value={cond.days} onChange={(days) => setCombo({ days })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">시간대</span>
            <Checks items={TIMES.map((t, i) => [i, t.replace('시', '')] as [number, string])} value={cond.times} onChange={(times) => setCombo({ times })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">인구</span>
            <Checks items={KINDS.map((k, i) => [i, k] as [number, string])} value={cond.kinds} onChange={(kinds) => setCombo({ kinds })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">연령</span>
            <Checks items={AGES.map((a, i) => [i, a] as [number, string])} value={cond.ages} onChange={(ages) => setCombo({ ages })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">성별</span>
            <Checks items={SEXES.map((s, i) => [i, s] as [number, string])} value={cond.sexes} onChange={(sexes) => setCombo({ sexes })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">보기</span>
            <Seg
              value={cond.measure}
              options={[
                ['count', '인원'],
                ['share', '비율(%)'],
              ]}
              onChange={(measure) => set({ measure, op: 'gte', mode: 'pct', value: 25, value2: undefined })}
            />
            <span className="hint inline">
              {cond.measure === 'count'
                ? '고른 요일·시간대 4시간당 평균'
                : cond.kinds.length < 3 || cond.ages.length < 6 || cond.sexes.length < 2
                  ? '그 시간대 사람 중 고른 인구 종류·연령·성별 비율'
                  : '하루 전체 중 고른 시간대 비율'}
            </span>
          </div>
        </>
      )}
      {cond.src === 'poi' && (
        <>
          <div className="cb-row">
            <span className="cb-label">종류</span>
            <Checks items={POI_KEYS.map((k) => [k, POI_CATS[k]] as [PoiCat, string])} value={cond.cats} onChange={(cats) => setCombo({ cats })} />
          </div>
          <div className="cb-row">
            <span className="cb-label">보기</span>
            <Seg
              value={cond.by ?? 'count'}
              options={[
                ['count', '구역 안 개수'],
                ['dist', '가장 가까운 곳까지 거리'],
              ]}
              onChange={(by) => set(by === 'dist' ? { by, op: 'lte', mode: 'abs', value: 300, value2: undefined } : { by, op: 'gte', mode: 'abs', value: 1, value2: undefined })}
            />
          </div>
        </>
      )}

      <div className="cb-row">
        <span className="cb-label">그래프</span>
        <Seg
          value={cond.scope ?? 'view'}
          options={[
            ['view', '지도 내 지역'],
            ['all', '전체 구역'],
          ]}
          onChange={(scope) => set({ scope })}
        />
      </div>
      <div className="cb-row top crit">
        <span className="cb-label">{unit === '명' ? '인원' : unit === '%' ? '비율' : unit === 'm' ? '거리' : '개수'}</span>
        <RangeSlider c={cond} x={x} onChange={onChange} byValue autoPick={autoPick} all={cond.scope === 'all'} />
      </div>
      <CondExtras id={id} c={cond} x={x} heatOn={heatOn} />
      </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 간단 모드
const WHEN: [string, string, number[], number[]][] = [
  ['all', '하루 전체', [0, 1], [0, 1, 2, 3]],
  ['allDay', '매일 낮', [0, 1], [0, 1]],
  ['allNight', '매일 밤', [0, 1], [3]],
  ['wdDay', '평일 낮', [0], [0, 1]],
  ['wdEve', '평일 저녁', [0], [2, 3]],
  ['wdNight', '평일 밤', [0], [3]],
  ['weDay', '주말 낮', [1], [0, 1]],
  ['weNight', '주말 밤', [1], [3]],
];
const WHEN_HINT: Record<string, string> = {
  all: '모든 요일 · 08~24시',
  allDay: '모든 요일 · 08~16시',
  allNight: '모든 요일 · 21~24시',
  wdDay: '월~목 08~16시',
  wdEve: '월~목 17~24시',
  wdNight: '월~목 21~24시',
  weDay: '금~일 08~16시',
  weNight: '금~일 21~24시',
};
const WHO: [string, string, number[]][] = [
  ['all', '모든 인구', [0, 1, 2]],
  ['res', '거주 인구', [0]],
  ['work', '직장 인구', [1]],
  ['visit', '방문 인구', [2]],
];
const AGE_PICK: [string, string, number[]][] = [['all', '모든 연령', [0, 1, 2, 3, 4, 5]], ...AGES.map((a, i) => [String(i), a, [i]] as [string, string, number[]])];
const SEX_PICK: [string, string, number[]][] = [
  ['all', '모든 성별', [0, 1]],
  ['0', '남성', [0]],
  ['1', '여성', [1]],
];
const same = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** 간단 모드로 표현할 수 있는 조건인지 (사람 조건이면 고른 '언제'·'어떤 인구' 프리셋) */
function simpleShape(c: Cond): { when?: string; who?: string; age?: string; sex?: string } | null {
  if (c.src === 'pop') {
    const w = WHEN.find(([, , d, t]) => same(d, c.days) && same(t, c.times));
    const who = WHO.find(([, , k]) => same(k, c.kinds));
    const age = AGE_PICK.find(([, , a]) => same(a, c.ages));
    const sex = SEX_PICK.find(([, , s]) => same(s, c.sexes));
    const ok = w && who && age && sex && (c.measure === 'count' ? c.mode === 'level' : c.mode === 'abs' && c.op !== 'between');
    return ok && w && who && age && sex ? { when: w[0], who: who[0], age: age[0], sex: sex[0] } : null;
  }
  if (c.src === 'poi' && c.by === 'dist') return c.mode === 'abs' && c.cats.length === 1 && c.op === 'lte' && NEAR_M.includes(c.value) ? {} : null;
  if (c.src === 'poi') return c.mode === 'abs' && c.cats.length === 1 && (c.op === 'gte' || c.value === 0) ? {} : null;
  return c.mode === 'abs' && c.op === 'gte' ? {} : null;
}

// ---------------------------------------------------------------- 범위 슬라이더
/** 지금 보는 지역(near) 구역들의 값, 작은 순 */
const nearVals = (c: Cond, x: ExplainCtx) => x.near.map((cell) => x.me.value(cell, c)).sort((a, b) => a - b);
const at = (vals: number[], p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))] ?? 0;
const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/**
 * 슬라이더 눈금 위의 위치(0~1) ↔ 값.
 *  - 순위(rank): 지금 보는 지역 구역을 적은 순으로 줄 세운 자리 — 간단히
 *  - 값(value): 최소~최대를 고르게 — 세부 설정 (위에 분포 그래프)
 */
interface Scale {
  pOf: (v: number, upper?: boolean) => number;
  vOf: (p: number) => number;
  /** 최소 · 중간 · 최대 자리 (minor: 로그 눈금의 10배 간격 — 눈금만, 글자 없음) */
  marks: { p: number; label: string; minor?: boolean }[];
}
function makeScale(vals: number[], byValue: boolean): Scale {
  const n = vals.length;
  const min = vals[0] ?? 0;
  const max = vals[n - 1] ?? 0;
  const span = max - min || 1;
  if (byValue) {
    // 소수 칸만 아주 큰 쏠린 분포(인원 등)는 고르게 펴면 거의 다 왼쪽 끝 한 칸에 몰린다 → 로그 눈금(10배마다 같은 간격)
    const mid = at(vals, 0.5);
    const skewed = min >= 0 && max >= 50 && max > 20 * Math.max(mid, 1);
    const f = skewed ? (v: number) => Math.log1p(Math.max(0, v)) : (v: number) => v;
    const inv = skewed ? (x: number) => Math.expm1(x) : (x: number) => x;
    const [f0, fs] = [f(min), f(max) - f(min) || 1];
    const pOf = (v: number) => clamp01((f(v) - f0) / fs);
    const marks: Scale['marks'] = [0, 0.5, 1].map((q, i) => ({ p: pOf(at(vals, q)), label: ['최소', '중간', '최대'][i] }));
    if (skewed) for (let t = 10; t < max; t *= 10) if (t > min) marks.push({ p: pOf(t), label: `${t}`, minor: true });
    return { pOf, vOf: (p) => inv(f0 + p * fs), marks };
  }
  const pOf = (v: number, upper = false) => {
    if (n < 2) return upper ? 1 : 0;
    // 아래 끝: v 이상인 첫 구역 자리 / 위 끝: v 이하인 마지막 구역 자리
    let i = upper ? -1 : n - 1;
    if (upper) vals.forEach((x, k) => x <= v && (i = k));
    else i = Math.max(0, vals.findIndex((x) => x >= v) < 0 ? n - 1 : vals.findIndex((x) => x >= v));
    return clamp01(Math.max(0, i) / (n - 1));
  };
  return { pOf, vOf: (p) => at(vals, p), marks: [0, 0.5, 1].map((p, i) => ({ p, label: ['최소', '중간', '최대'][i] })) };
}
const roundFor = (c: Cond) => (v: number) => (condUnit(c) === '%' ? Math.round(v * 10) / 10 : v >= 100 ? Math.round(v / 10) * 10 : Math.round(v));

/** 범위 [lp, hp] → 조건. 끝(0·1)에 붙은 쪽은 '제한 없음' */
function rangeToCond(c: Cond, sc: Scale, lp: number, hp: number): Cond {
  const r = roundFor(c);
  const base = { ...c, mode: 'abs' as const, deg: undefined, value2: undefined };
  if (hp >= 1) return { ...base, op: 'gte', value: r(sc.vOf(Math.max(0, lp))) } as Cond;
  if (lp <= 0) return { ...base, op: 'lte', value: r(sc.vOf(hp)) } as Cond;
  return { ...base, op: 'between', value: r(sc.vOf(lp)), value2: r(sc.vOf(hp)) } as Cond;
}
/** 통과 범위 → 슬라이더 위치 (끝이 열려 있으면 0·1) */
function condToRange(th: Th, sc: Scale): [number, number] {
  return [th[0] === -Infinity ? 0 : sc.pOf(th[0]), th[1] === Infinity ? 1 : sc.pOf(th[1], true)];
}

/** 사람 수 조건을 단계 범위로 — 지금 통과 범위의 양 끝이 속한 단계 */
function toLevel(c: Cond, me: MetricEval): Cond {
  if (c.src !== 'pop' || c.measure !== 'count' || c.mode === 'level') return c;
  const [lo, hi] = me.threshold(c);
  const a = lo === -Infinity ? 0 : me.levelOf(c, lo);
  const b = hi === Infinity ? LEVELS.length - 1 : me.levelOf(c, hi);
  const last = LEVELS.length - 1;
  const op = b >= last && a > 0 ? 'gte' : a <= 0 && b < last ? 'lte' : 'between';
  return { ...c, op, mode: 'level', value: a, value2: Math.max(a, b), deg: undefined } as Cond;
}

/** 조합(기간·인구 종류·시설 종류…)이 바뀌어도 슬라이더 자리(순위)는 그대로, 숫자만 새 분포에 맞춘다.
 *  예전 분포가 전부 같은 값이었으면 자리가 의미 없으니 '상위 25%' 부터 다시 */
function keepRange(old: Cond, next: Cond, x: ExplainCtx): Cond {
  if (old.mode !== 'abs') return next; // 순위·단계는 새 분포에서도 그대로 뜻이 통한다
  const [ov, nv] = [nearVals(old, x), nearVals(next, x)];
  if (!ov.length || ov[0] === ov[ov.length - 1]) return { ...next, op: 'gte', mode: 'pct', value: 25, value2: undefined } as Cond;
  return rangeToCond(next, makeScale(nv, false), ...condToRange(x.me.threshold(old), makeScale(ov, false)));
}

const SNAP = 0.025;
const BINS = 24;

/**
 * 양쪽 손잡이 슬라이더. 위 두 줄(값 · 해당 수)은 늘 한 줄씩이라 끄는 동안 높이가 바뀌지 않는다.
 * autoPick: 아직 '상위 n%' 같은 순위 기준이면 지금 보는 지역의 실제 숫자로 바꿔 둔다 (필터용)
 */
function RangeSlider({
  c,
  x,
  onChange,
  byValue = false,
  autoPick,
  all = false,
}: {
  c: Cond;
  x: ExplainCtx;
  onChange: (c: Cond) => void;
  byValue?: boolean;
  autoPick?: boolean;
  /** 분포를 전체 구역으로 (기본: 지도 내 지역) */
  all?: boolean;
}) {
  const vals = all ? x.cells.map((cell) => x.me.value(cell, c)).sort((a, b) => a - b) : nearVals(c, x);
  const sc = makeScale(vals, byValue);
  const th = x.me.threshold(c);
  const [lp, hp] = condToRange(th, sc);
  const unit = condUnit(c);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<0 | 1 | null>(null);
  useEffect(() => {
    if (autoPick && c.mode === 'pct' && vals.length) onChange(rangeToCond(c, sc, lp, hp));
  }, [autoPick, c.mode, c.src === 'pop' && c.measure]);

  const toP = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const p = clamp01((clientX - r.left) / r.width);
    return [0, 1, ...sc.marks.map((m) => m.p)].find((m) => Math.abs(m - p) < SNAP) ?? p;
  };
  const setP = (which: 0 | 1, p: number) => onChange(which === 0 ? rangeToCond(c, sc, Math.min(p, hp), hp) : rangeToCond(c, sc, lp, Math.max(p, lp)));
  const key = (which: 0 | 1) => (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.02 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.02 : 0;
    if (!d) return;
    e.preventDefault();
    setP(which, clamp01((which === 0 ? lp : hp) + d));
  };

  const hits = vals.filter((v) => passes(c, v, th)).length;
  const sel = x.selected ? { p: sc.pOf(x.me.value(x.selected, c)), v: x.me.value(x.selected, c) } : null;
  const text =
    c.mode === 'level'
      ? levelText(c.op, c.value, c.value2 ?? c.value)
      : c.mode === 'pct'
      ? `전체 ${c.op === 'lte' ? '하위' : '상위'} ${c.value}%`
      : c.op === 'between'
        ? `${fmtNum(c.value)} ~ ${fmtNum(c.value2 ?? c.value)}${unit}`
        : lp <= 0 && hp >= 1
          ? '제한 없음'
          : `${fmtNum(c.value)}${unit} ${c.op === 'gte' ? '이상' : '이하'}`;

  if (vals.length && vals[0] === vals[vals.length - 1])
    return (
      <div className="range">
        <div className="range-value">모든 구역이 {fmtNum(vals[0])}{unit}로 같아요</div>
        <div className="range-count">조건을 더 좁혀야 구역끼리 차이가 생겨요</div>
      </div>
    );

  // 세부 설정: 값 분포 막대 (고른 범위 안은 진하게)
  let bars: { h: number; on: boolean }[] = [];
  if (byValue && vals.length) {
    // 막대 칸은 슬라이더 눈금과 같은 자리 (로그 눈금이면 막대도 로그 간격)
    const bins = new Array(BINS).fill(0);
    for (const v of vals) bins[Math.min(BINS - 1, Math.floor(sc.pOf(v) * BINS))]++;
    const peak = Math.max(...bins, 1);
    bars = bins.map((b, i) => ({ h: b / peak, on: (i + 0.5) / BINS >= lp && (i + 0.5) / BINS <= hp }));
  }

  return (
    <div className="range">
      <div className="range-value">{text}</div>
      <div className="range-count">
        {all ? '전체' : '이 근처'} {vals.length}곳 중 <b>{hits}곳</b> 해당
      </div>
      <div
        className={`range-track ${byValue ? 'with-hist' : ''}`}
        ref={track}
        onPointerDown={(e) => {
          e.preventDefault(); // 글자 선택·요소 끌기 막기
          const p = toP(e.clientX);
          // 가까운 손잡이를 잡는다 (겹쳐 있으면 누른 쪽 방향)
          const which: 0 | 1 = Math.abs(p - lp) < Math.abs(p - hp) || (lp === hp && p < lp) ? 0 : 1;
          drag.current = which;
          setP(which, p);
          try {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
          } catch {
            /* 못 잡아도 값은 반영됨 */
          }
        }}
        onPointerMove={(e) => drag.current !== null && setP(drag.current, toP(e.clientX))}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {bars.length > 0 && (
          <span className="range-hist">
            {bars.map((b, i) => (
              <i key={i} className={b.on ? 'on' : ''} style={{ height: `${Math.max(4, b.h * 100)}%` }} />
            ))}
          </span>
        )}
        <i className="range-rail" />
        <i className="range-fill" style={{ left: `${lp * 100}%`, width: `${(hp - lp) * 100}%` }} />
        {sc.marks.map((m) => (
          <i key={m.label} className={`range-tick ${m.minor ? 'minor' : ''}`} style={{ left: `${m.p * 100}%` }} title={m.minor ? `${Number(m.label).toLocaleString()}${unit}` : undefined} />
        ))}
        {sel && <i className="range-sel" style={{ left: `${sel.p * 100}%` }} title={`고른 구역 ${fmtNum(sel.v)}${unit}`} />}
        <span className="range-knob" role="slider" tabIndex={0} aria-label="최소" style={{ left: `${lp * 100}%` }} onKeyDown={key(0)} />
        <span className="range-knob" role="slider" tabIndex={0} aria-label="최대" style={{ left: `${hp * 100}%` }} onKeyDown={key(1)} />
      </div>
      <div className="range-labels">
        {/* '중간' 이 끝에 너무 붙으면 글자가 겹치니 눈금만 두고 이름은 뺀다 */}
        {sc.marks.filter((m) => !m.minor && (m.label !== '중간' || (m.p > 0.2 && m.p < 0.8))).map((m) => (
          <span key={m.label} style={{ left: `${m.p * 100}%` }}>
            <small>{m.label}</small>
            {fmtNum(roundFor(c)(sc.vOf(m.p)))}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 가까운 곳: 구역 가운데에서 이 거리 안 */
const NEAR_M = [100, 200, 300, 500, 800, 1000];

/**
 * 인원 수준 선택 — 전체 구역을 자연적 단절로 나눈 5단계.
 * [이상 · 이하 · 해당 단계만] 을 고르고 단계를 누르면, 그 단계부터 위로 / 아래로 / 그 단계 하나가 선택된다.
 */
type LevelOp = 'gte' | 'lte' | 'between';
function LevelPicker({ c, x, onChange }: { c: Cond; x: ExplainCtx; onChange: (c: Cond) => void }) {
  const last = LEVELS.length - 1;
  const lo = c.value;
  const hi = c.value2 ?? c.value;
  const op = c.op as LevelOp;
  // 기준 단계: 이상이면 아래 끝, 이하면 위 끝
  const anchor = op === 'lte' ? hi : lo;
  const set = (o: LevelOp, i: number) =>
    onChange({ ...c, mode: 'level', op: o, value: o === 'lte' ? 0 : i, value2: o === 'gte' ? last : i } as Cond);
  const unit = condUnit(c);
  const range = (i: number) => {
    const [a, b] = x.me.levelRange(c, i);
    return `${fmtNum(a === -Infinity ? x.me.quantile(c, 0) : Math.ceil(a))}~${fmtNum(b === Infinity ? x.me.quantile(c, 1) : b)}${unit}`;
  };
  const picked = LEVELS.map((_, i) => i).filter((i) => i >= lo && i <= hi);
  return (
    <div className="lv">
      <div className="lv-head">
        <b>인원 수준 선택</b>
        <small>{CELL_SIZE}m × {CELL_SIZE}m 셀 기준</small>
      </div>
      <div className="lv-ops">
        {(
          [
            ['gte', '이상'],
            ['lte', '이하'],
            ['between', '해당 단계만'],
          ] as [LevelOp, string][]
        ).map(([o, l]) => (
          <button key={o} className={op === o ? 'on' : ''} onClick={() => set(o, anchor)}>
            {l}
          </button>
        ))}
      </div>
      <div className="lv-bars">
        {LEVELS.map((l, i) => {
          const on = i >= lo && i <= hi;
          return (
            <button key={l} className={`${on ? 'on' : ''} ${i === anchor ? 'anchor' : ''}`} title={range(i)} onClick={() => set(op, i)}>
              <i style={on ? { background: LEVEL_COLORS[i] } : undefined} />
              <span>{l}</span>
            </button>
          );
        })}
      </div>
      <div className="lv-sum">
        <b>{levelText(op, lo, hi)}</b>
        <span className="lv-badge">{picked.length}개 단계 선택</span>
      </div>
      <div className="lv-chips">
        {picked.map((i) => (
          <span key={i}>{LEVELS[i]}</span>
        ))}
      </div>
      <p className="lv-note">선택한 인원 수준에 해당하는 지역을 지도에서 표시합니다.</p>
    </div>
  );
}

/** 비율 조건: 고른 연령·성별이 그 칸 사람 중 몇 % 이상/이하 */
function SharePicker({ c, x, onChange }: { c: Cond; x: ExplainCtx; onChange: (c: Cond) => void }) {
  if (c.src !== 'pop') return null;
  const set = (p: Partial<Cond>) => onChange({ ...c, ...p } as Cond);
  const narrowed = c.ages.length < 6 || c.sexes.length < 2;
  return (
    <>
      <div className="cb-row">
        <span className="cb-label">비율</span>
        <NumPill value={c.value} min={0} step={5} onChange={(v) => set({ value: Math.min(100, v) })} />
        <span>%</span>
        <Seg
          value={c.op === 'lte' ? 'lte' : 'gte'}
          options={[
            ['gte', '이상'],
            ['lte', '이하'],
          ]}
          onChange={(op) => set({ op })}
        />
      </div>
      {!narrowed && <div className="hint">연령이나 성별을 고르면 그 비율이에요.</div>}
      <NearCount c={c} x={x} />
    </>
  );
}

/** 지금 보는 지역에서 몇 곳이 맞는지 한 줄 */
function NearCount({ c, x }: { c: Cond; x: ExplainCtx }) {
  const vals = nearVals(c, x);
  const th = x.me.threshold(c);
  return (
    <div className="near-count">
      이 근처 {vals.length}곳 중 <b>{vals.filter((v) => passes(c, v, th)).length}곳</b>
    </div>
  );
}

function SimpleCond({ cond, onChange, x, autoPick }: { cond: Cond; onChange: (c: Cond) => void; x: ExplainCtx; autoPick?: boolean }) {
  const shape = simpleShape(cond);
  const set = (p: Partial<Cond>) => onChange({ ...cond, ...p } as Cond);
  // 기간·인구 종류를 바꾸면 슬라이더 위치(분포에서의 자리)는 그대로 두고 숫자만 새 분포에 맞춘다
  // 비율(%) 조건은 숫자 그대로 두고 조합만 바꾼다
  const repick = (next: Cond) => onChange(cond.src === 'pop' && cond.measure === 'share' ? next : keepRange(cond, next, x));
  // 예전에 숫자로 정해 둔 사람 수 조건은 단계로 바꿔서 보여준다
  useEffect(() => {
    const lv = toLevel(cond, x.me);
    if (lv !== cond && simpleShape(lv)) onChange(lv);
  }, [cond]);

  if (!shape)
    return (
      <div className="simple-locked">
        <div>
          세부 설정에서 정한 조건이에요: <b>{condText(cond)}</b>
        </div>
        <div className="row-btns">
          <button onClick={() => onChange({ ...cond, adv: true } as Cond)}>세부 설정에서 보기</button>
          <button onClick={() => onChange(newCond(cond.src))}>간단하게 다시 정하기</button>
        </div>
        <Reason c={cond} x={x} />
      </div>
    );

  return (
    <div className="simple-rows">
      {cond.src === 'pop' && shape.when && shape.who && (
        <>
          <div className="cb-row">
            <span className="cb-label">기간</span>
            <Pill
              value={shape.when}
              title={WHEN_HINT[shape.when]}
              options={WHEN.map(([k, l]) => [k, `${l} (${WHEN_HINT[k]})`] as [string, string])}
              onChange={(k) => {
                const w = WHEN.find(([kk]) => kk === k)!;
                repick({ ...cond, days: w[2], times: w[3] } as Cond);
              }}
            />
          </div>
          <div className="cb-row">
            <span className="cb-label">인구</span>
            <Pill
              value={shape.who}
              options={WHO.map(([k, l]) => [k, l] as [string, string])}
              onChange={(k) => repick({ ...cond, kinds: WHO.find(([kk]) => kk === k)![2] } as Cond)}
            />
          </div>
          <div className="cb-row">
            <span className="cb-label">연령</span>
            <Pill
              value={shape.age!}
              options={AGE_PICK.map(([k, l]) => [k, l] as [string, string])}
              onChange={(k) => repick({ ...cond, ages: AGE_PICK.find(([kk]) => kk === k)![2] } as Cond)}
            />
          </div>
          <div className="cb-row">
            <span className="cb-label">성별</span>
            <Pill
              value={shape.sex!}
              options={SEX_PICK.map(([k, l]) => [k, l] as [string, string])}
              onChange={(k) => repick({ ...cond, sexes: SEX_PICK.find(([kk]) => kk === k)![2] } as Cond)}
            />
          </div>
          {/* 기준: 인원 단계 ↔ 비율(%) — 어느 조건(필터·동네 성격)에서든 같은 자리에서 바꾼다 */}
          <div className="cb-row">
            <span className="cb-label">기준</span>
            <Seg
              value={cond.measure}
              options={[
                ['count', '인원 수준'],
                ['share', '비율 (%)'],
              ]}
              onChange={(m) =>
                m !== cond.measure &&
                onChange(
                  (m === 'share'
                    ? { ...cond, measure: 'share', op: 'gte', mode: 'abs', value: 50, value2: undefined }
                    : { ...cond, measure: 'count', op: 'gte', mode: 'level', value: 2, value2: 4 }) as Cond,
                )
              }
            />
          </div>
          {cond.measure === 'share' ? <SharePicker c={cond} x={x} onChange={onChange} /> : <LevelPicker c={cond} x={x} onChange={onChange} />}
        </>
      )}

      {cond.src === 'poi' && (
        <>
          <div className="cb-row">
            <span className="cb-label">종류</span>
            <Pill
              value={cond.cats[0]}
              options={POI_KEYS.map((k) => [k, POI_CATS[k]] as [PoiCat, string])}
              onChange={(k) =>
                // 드문 시설로 바꾸면 '가까운 곳', 거기서 흔한 시설로 돌아오면 '있는 곳'
                set(
                  POI_BY_DIST.includes(k)
                    ? { cats: [k], by: 'dist', op: 'lte', mode: 'abs', value: 300 }
                    : POI_BY_DIST.includes(cond.cats[0])
                      ? { cats: [k], by: 'count', op: 'gte', mode: 'abs', value: 1 }
                      : { cats: [k] },
                )
              }
            />
          </div>
          <div className="cb-row">
            <span className="cb-label">조건</span>
            <Seg
              value={cond.by === 'dist' ? 'near' : cond.op === 'lte' ? 'none' : 'some'}
              options={[
                ['some', '있는 곳'],
                ['none', '없는 곳'],
                ['near', '가까운 곳'],
              ]}
              onChange={(v) =>
                set(v === 'near' ? { by: 'dist', op: 'lte', value: 300 } : v === 'none' ? { by: 'count', op: 'lte', value: 0 } : { by: 'count', op: 'gte', value: 1 })
              }
            />
          </div>
          {/* 개수·거리는 버튼 아래에 붙어서 나타나도 버튼은 제자리 */}
          {cond.by === 'dist' && (
            <div className="cb-row">
              <span className="cb-label">거리</span>
              <Pill value={String(cond.value)} options={NEAR_M.map((m) => [String(m), m >= 1000 ? `${m / 1000}km` : `${m}m`] as [string, string])} onChange={(v) => set({ value: +v })} />
              <span>안</span>
            </div>
          )}
          {cond.by !== 'dist' && !(cond.op === 'lte' && cond.value === 0) && (
            <div className="cb-row">
              <span className="cb-label">개수</span>
              <NumPill value={cond.value} min={1} onChange={(v) => set({ value: v })} />
              <span>곳 이상</span>
            </div>
          )}
          <NearCount c={cond} x={x} />
        </>
      )}

      {cond.src === 'depts' && (
        <>
          <div className="cb-row">
            <span className="cb-label">진료과</span>
            <NumPill value={cond.value} min={1} onChange={(v) => set({ value: v })} />
            <span>종류 이상</span>
          </div>
          <NearCount c={cond} x={x} />
        </>
      )}
    </div>
  );
}

/** 왜 이 숫자인지: 지금 보는 지역에서 이 기준이 어느 정도인지 문장으로 */
function Reason({ c, x }: { c: Cond; x: ExplainCtx }) {
  const th = x.me.threshold(c);
  const unit = condUnit(c);
  const vals = x.near.map((cell) => x.me.value(cell, c)).sort((a, b) => a - b);
  const n = vals.length;
  const pass = (v: number) => passes(c, v, th);
  const k = vals.filter(pass).length;
  const pct = n ? Math.round((k / n) * 100) : 0;
  const mid = n ? vals[Math.floor(n / 2)] : 0;
  const allHits = x.cells.filter((cell) => x.me.test(cell, c, th)).length;
  const few = pct <= 30;
  const selOk = x.selected ? x.me.test(x.selected, c, th) : null;

  return (
    <div className="reason">
      <div>
        <span title={`지도 화면과 그 주변 (${x.areaText})`}>지금 보는 지역</span> 구역 {n}곳 중 <b className="hit">{k}곳({pct}%)</b>
        {few ? '만' : '이'} 해당돼요. 보통 구역은 {c.src === 'pop' ? '약 ' : ''}
        {fmtNum(mid)}
        {unit}이에요.
      </div>
      <div className="muted">
        전체로는 {allHits}곳
        {selOk !== null && <span className={`quick-sel ${selOk ? 'ok' : 'no'}`}>선택 구역 {selOk ? '✓ 해당' : '✕ 해당 안 됨'}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 분포 · 기준 (그래프를 끌어서 조절)
const fmtNum = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? String(v) : v.toFixed(1));

function CondExtras({ id, c, x, heatOn }: { id: string; c: Cond; x: ExplainCtx; heatOn: boolean }) {
  const unit = condUnit(c);
  const th = x.me.threshold(c);
  const pass = (v: number) => passes(c, v, th);
  const allHits = x.cells.filter((cell) => x.me.test(cell, c, th)).length;
  const sel = x.selected ? { v: x.me.value(x.selected, c), name: x.place(x.selected) } : null;
  const ordered = x.near.filter((cell) => pass(x.me.value(cell, c))).sort((a, b) => x.me.value(b, c) - x.me.value(a, c));
  const ex: string[] = [];
  for (const cell of ordered) {
    const name = x.place(cell);
    if (!ex.includes(name)) ex.push(name);
    if (ex.length === 3) break;
  }
  return (
    <div className="stats">
      <div className="stats-head">
        <span>전체로는 {allHits}곳</span>
        <button className={`heat-btn ${heatOn ? 'on' : ''}`} onClick={() => x.setHeat(heatOn ? null : { id, cond: c })} title="이 값을 지도 전체에 색 세기로 보기">
          {heatOn ? '지도 색 세기 ✓' : '지도에 색 세기로 보기'}
        </button>
      </div>
      {sel && (
        <div className={`stats-sel ${pass(sel.v) ? 'ok' : 'no'}`}>
          고른 구역({sel.name}) <b>{fmtNum(sel.v)}{unit}</b> → {pass(sel.v) ? '해당' : '해당 안 됨'}
        </div>
      )}
      {ex.length > 0 && <div className="stats-ex">예: {ex.join(', ')}</div>}
    </div>
  );
}
