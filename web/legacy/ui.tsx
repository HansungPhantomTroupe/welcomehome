import type { ReactNode } from 'react';
import type { Level } from '@shared/types';
import { LEVEL_LABEL } from '@shared/cellTypes';

export function Field({ label, value, children, hint }: { label: string; value?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span>{label}</span>
        {value !== undefined && <b>{value}</b>}
      </div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Slider(props: { min: number; max: number; step?: number; value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
      className="slider"
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      onChange={(e) => props.onChange(+e.target.value)}
    />
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LevelPicker({ value, onChange, levels = [2, 3, 4] }: { value: Level; onChange: (v: Level) => void; levels?: Level[] }) {
  return <Segmented options={levels.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} value={value} onChange={onChange} />;
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span>{children}</span>
    </label>
  );
}

export function LevelBadge({ level, invert }: { level: Level; invert?: boolean }) {
  // invert: 높을수록 나쁜 지표(혼잡도)
  const tone = invert ? (level >= 4 ? 'bad' : level <= 2 ? 'good' : 'mid') : level >= 4 ? 'good' : level <= 2 ? 'bad' : 'mid';
  return <span className={`lv lv-${tone}`}>{LEVEL_LABEL[level]}</span>;
}

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} />;
}
