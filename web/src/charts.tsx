import type { Cell } from '@shared/types';
import { AGE_GROUPS, POP_KINDS, TIME_SLOTS } from '@shared/cellTypes';

/** 요일묶음별 시간대 유동인구 (월~목 / 금~일) */
export function TimePattern({ cell, max }: { cell: Cell; max?: number }) {
  const W = 260;
  const H = 96;
  const pad = { l: 8, r: 8, t: 10, b: 20 };
  const top = max ?? Math.max(...cell.slots.flat(), 1);
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * (i + 0.5)) / 4;
  const y = (v: number) => H - pad.b - ((H - pad.t - pad.b) * v) / top;
  const bw = 16;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="시간대별 유동인구">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="axis" />
      {cell.slots[0].map((v, i) => (
        <rect key={`a${i}`} x={x(i) - bw - 1} y={y(v)} width={bw} height={H - pad.b - y(v)} rx={2} className="bar-wd">
          <title>{`월~목 ${TIME_SLOTS[i]}: ${Math.round(v)}명`}</title>
        </rect>
      ))}
      {cell.slots[1].map((v, i) => (
        <rect key={`b${i}`} x={x(i) + 1} y={y(v)} width={bw} height={H - pad.b - y(v)} rx={2} className="bar-we">
          <title>{`금~일 ${TIME_SLOTS[i]}: ${Math.round(v)}명`}</title>
        </rect>
      ))}
      {TIME_SLOTS.map((t, i) => (
        <text key={t} x={x(i)} y={H - 6} textAnchor="middle" className="tick">
          {t.replace('시', '')}
        </text>
      ))}
    </svg>
  );
}

/** 인구 종류 비중 (거주 · 직장 · 방문) */
export function KindBar({ cell }: { cell: Cell }) {
  const vals = [cell.kindShare.resident, cell.kindShare.worker, cell.kindShare.visitor];
  return (
    <div className="agebar">
      <div className="agebar-track">
        {vals.map((v, i) => (
          <div key={i} className={`age age-${i}`} style={{ width: `${v * 100}%` }} title={`${POP_KINDS[i]} ${(v * 100).toFixed(0)}%`} />
        ))}
      </div>
      <div className="agebar-legend">
        {vals.map((v, i) => (
          <span key={i}>
            <i className={`age-${i}`} />
            {POP_KINDS[i]} {(v * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** 연령·성별 구성 (거주·직장·방문을 인원 비중대로 합친 전체, 요일 평균) — 남(왼쪽)·여(오른쪽) 막대 */
export function DemoBars({ cell }: { cell: Cell }) {
  // 요일·종류별 인원 비중으로 가중 평균
  const w = [0, 1].flatMap((d) => [0, 1, 2].map((k) => ({ d, k, n: [0, 1, 2, 3].reduce((s, t) => s + (cell.pop[(d * 4 + t) * 3 + k] ?? 0), 0) })));
  const tot = w.reduce((s, x) => s + x.n, 0) || 1;
  const share = (s: number, a: number) => w.reduce((acc, { d, k, n }) => acc + (n / tot) * (cell.demo?.[((d * 3 + k) * 2 + s) * 6 + a] ?? 1 / 12), 0);
  const rows = AGE_GROUPS.map((label, a) => ({ label, m: share(0, a), f: share(1, a) }));
  const max = Math.max(...rows.flatMap((r) => [r.m, r.f]), 0.01);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="demo-bars">
      <div className="demo-head">
        <span>남성 {pct(rows.reduce((s, r) => s + r.m, 0))}</span>
        <span>여성 {pct(rows.reduce((s, r) => s + r.f, 0))}</span>
      </div>
      {[...rows].reverse().map((r) => (
        <div key={r.label} className="demo-row">
          <span className="demo-v">{pct(r.m)}</span>
          <span className="demo-bar m">
            <i style={{ width: `${(r.m / max) * 100}%` }} />
          </span>
          <span className="demo-age">{r.label}</span>
          <span className="demo-bar f">
            <i style={{ width: `${(r.f / max) * 100}%` }} />
          </span>
          <span className="demo-v">{pct(r.f)}</span>
        </div>
      ))}
    </div>
  );
}
