/**
 * 고른 구역의 월별 값 (LG U+, 2025년)
 * 값은 모두 '그 시간대에 그 칸에 있는 평균 인원' (원본 누적 ÷ 그 달 요일 일수 ÷ 시간대 시간 수)
 *  - 그래프: 거주·직장·방문·전체를 평일/주말로 나눈 월별 타임라인 (시간대 4개 평균)
 *  - 표: 원본 CSV 행 단위 (월 × 요일 × 시간대, 체류·보행·주행·거주·직장·방문)
 * 표의 값 칸을 누르면 같은 월·요일·시간대·지표 값을 지도 위 모든 칸에 숫자로 쓴다 (다시 누르면 끔).
 */
import { useEffect, useState } from 'react';
import { DAY_GROUPS, TIME_SLOTS } from '@shared/cellTypes';

interface Monthly {
  months: string[];
  cols: string[];
  /** [월][요일 2][시간대 4][지표 6] 한 줄, 평균 인원 */
  v: (number | null)[];
}

// 지표 순서 (서버 cols): 체류 · 보행 · 주행 · 거주 · 직장 · 방문
const M = { stay: 0, walk: 1, driv: 2, resd: 3, wrk: 4, vist: 5 } as const;
const KIND_SERIES = [
  { key: M.resd, label: '거주', color: '#3b7dd8' },
  { key: M.wrk, label: '직장', color: '#e9822f' },
  { key: M.vist, label: '방문', color: '#3e9b6c' },
];
const DAY = ['평일', '주말'] as const; // 월~목 / 금~일
const COL_NAME = ['체류', '보행', '주행', '거주', '직장', '방문'];

/** 지도 위에 숫자로 쓸 값: 월 · 지표 · 요일 · 시간대 (표 한 행의 한 칸) */
export interface ValueLayer {
  month: string;
  cols: number[];
  day: 0 | 1 | 'avg';
  slot: number | 'avg';
}
export const layerKey = (l: ValueLayer) => `${l.month}|${l.cols}|${l.day}|${l.slot}`;
export function layerText(l: ValueLayer) {
  const what = l.cols.length === 3 ? '전체' : COL_NAME[l.cols[0]];
  const day = l.day === 'avg' ? '평일·주말 평균' : DAY_GROUPS[l.day];
  const slot = l.slot === 'avg' ? '시간대 평균' : TIME_SLOTS[l.slot];
  return `${l.month} · ${day} · ${slot} · ${what}`;
}

const fmt = (v: number | null) => (v === null ? '–' : Math.round(v).toLocaleString());
const fmtRaw = (v: number | null) => (v === null ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const short = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}만` : Math.round(v).toLocaleString());

export default function MonthlyPanel({ cellId, layer, setLayer }: { cellId: string; layer: ValueLayer | null; setLayer: (l: ValueLayer | null) => void }) {
  const [data, setData] = useState<Monthly | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 표 거르기 (원본 96행 중)
  const [fMonth, setFMonth] = useState<number | 'all'>('all');
  const [fDay, setFDay] = useState<number | 'all'>('all');
  const [fSlot, setFSlot] = useState<number | 'all'>('all');
  useEffect(() => {
    setData(null);
    setErr(null);
    fetch(`/api/cell/${cellId}/monthly`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [cellId]);

  if (err) return <div className="hint">월별 값을 불러오지 못했어요: {err}</div>;
  if (!data) return <div className="hint">월별 값 불러오는 중…</div>;

  const raw = (m: number, d: number, t: number, k: number) => data.v[((m * 2 + d) * 4 + t) * 6 + k];
  /** 그래프용: 월 m · 요일 d 의 시간대 4개 평균 */
  const perDay = (m: number, d: number, ks: number[]): number | null => {
    const xs = [0, 1, 2, 3].map((t) => ks.map((k) => raw(m, d, t, k)));
    if (xs.some((r) => r.some((x) => x === null))) return null;
    return xs.reduce<number>((s, r) => s + r.reduce<number>((a, x) => a + (x ?? 0), 0), 0) / 4;
  };
  const mLabel = (s: string) => `${+s.slice(4)}월`;
  const rows = data.months.flatMap((_, m) => [0, 1].flatMap((d) => [0, 1, 2, 3].map((t) => ({ m, d, t }))))
    .filter((r) => (fMonth === 'all' || r.m === fMonth) && (fDay === 'all' || r.d === fDay) && (fSlot === 'all' || r.t === fSlot));
  /** 표의 값 칸: 누르면 지도에 같은 값을 띄우고, 띄운 칸을 다시 누르면 끈다 */
  const pick = (m: number, d: number, t: number, k: number) => {
    const l: ValueLayer = { month: data.months[m], cols: [k], day: d as 0 | 1, slot: t };
    const on = !!layer && layerKey(layer) === layerKey(l);
    return (
      <td key={k} className={`pick ${on ? 'on' : ''}`} onClick={() => setLayer(on ? null : l)} title="지도 위 모든 칸에 이 값 보기">
        {fmtRaw(raw(m, d, t, k))}
      </td>
    );
  };
  const sel = <T extends number | 'all'>(v: T, set: (v: T) => void, opts: [number, string][], all: string) => (
    <select value={String(v)} onChange={(e) => set((e.target.value === 'all' ? 'all' : +e.target.value) as T)}>
      <option value="all">{all}</option>
      {opts.map(([i, l]) => (
        <option key={i} value={i}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <div className="monthly">
      <div className="monthly-tools">
        <span className="monthly-legend">
          평균 인원 · <i className="solid" /> 평일(월~목) <i className="dash" /> 주말(금~일)
        </span>
      </div>
      <div className="monthly-grid">
        {KIND_SERIES.map((s) => (
          <LineChart
            key={s.label}
            title={`${s.label} 인구`}
            color={s.color}
            months={data.months.map(mLabel)}
            series={[0, 1].map((d) => ({ name: DAY[d], dashed: d === 1, values: data.months.map((_, m) => perDay(m, d, [s.key])) }))}
          />
        ))}
        <LineChart
          title="전체 (거주+직장+방문)"
          color="#4b5563"
          months={data.months.map(mLabel)}
          series={[0, 1].map((d) => ({ name: DAY[d], dashed: d === 1, values: data.months.map((_, m) => perDay(m, d, [M.resd, M.wrk, M.vist])) }))}
        />
      </div>

      <div className="monthly-tools">
        <b className="monthly-cap">월별 행</b>
        {sel(fMonth, setFMonth, data.months.map((mo, i) => [i, mo] as [number, string]), '모든 월')}
        {sel(fDay, setFDay, DAY_GROUPS.map((d, i) => [i, d] as [number, string]), '모든 요일')}
        {sel(fSlot, setFSlot, TIME_SLOTS.map((t, i) => [i, t] as [number, string]), '모든 시간대')}
        <span className="muted">{rows.length}행</span>
      </div>
      <div className="monthly-table raw">
        <table>
          <thead>
            <tr>
              <th>월</th>
              <th>요일</th>
              <th>시간대</th>
              {COL_NAME.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, d, t }) => (
              <tr key={`${m}-${d}-${t}`} className={t === 0 ? 'grp' : ''}>
                <td>{data.months[m]}</td>
                <td>{DAY_GROUPS[d]}</td>
                <td>{TIME_SLOTS[t]}</td>
                {COL_NAME.map((_, k) => pick(m, d, t, k))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint">200m 칸 안 50m 셀 합계 · 튀는 값 퍼뜨린 뒤. 평균 인원 = 원본(월 누적) ÷ 그 달 요일 일수 ÷ 시간대 시간 수(08~12시 5, 나머지 4). 값 칸을 누르면 지도 위 모든 칸에 같은 값을 숫자로 보여줘요.</div>
    </div>
  );
}

/** 월별 선 그래프 하나 — 평일(실선)·주말(점선), 마우스를 올리면 그 달 값 */
function LineChart({ title, color, months, series }: { title: string; color: string; months: string[]; series: { name: string; dashed: boolean; values: (number | null)[] }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 170;
  const H = 104;
  const pad = { l: 30, r: 6, t: 8, b: 16 };
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, months.length - 1);
  const y = (v: number) => H - pad.b - ((H - pad.t - pad.b) * v) / max;
  const path = (vals: (number | null)[]) =>
    vals.reduce((d, v, i) => (v === null ? d : `${d}${d && vals[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`), '');
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(months.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (months.length - 1)))));
  };
  return (
    <div className="mchart">
      <div className="mchart-title">
        <i style={{ background: color }} />
        {title}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${title} 월별`}>
        {[0, 0.5, 1].map((q) => (
          <g key={q}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * q)} y2={y(max * q)} className="mgrid" />
            <text x={pad.l - 3} y={y(max * q) + 3} textAnchor="end" className="mtick">
              {short(max * q)}
            </text>
          </g>
        ))}
        {months.map((m, i) =>
          i % 3 === 0 || i === months.length - 1 ? (
            <text key={m} x={x(i)} y={H - 4} textAnchor="middle" className="mtick">
              {m}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="mcross" />}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={color} strokeWidth={2} strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" />
        ))}
        {hover !== null &&
          series.map((s) =>
            s.values[hover] !== null ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={3} fill={s.dashed ? '#fff' : color} stroke={color} strokeWidth={1.5} /> : null,
          )}
      </svg>
      <div className="mchart-read">
        {hover === null ? (
          <span className="muted">마우스를 올려 보세요</span>
        ) : (
          <>
            <b>{months[hover]}</b> {series.map((s) => `${s.name} ${fmt(s.values[hover])}`).join(' · ')}
          </>
        )}
      </div>
    </div>
  );
}
