import { useState } from 'react';

/** 셀 색을 지도와 합성하는 방식 (CSS mix-blend-mode) */
export type Blend = 'normal' | 'multiply' | 'darken' | 'color-burn' | 'color' | 'overlay' | 'soft-light' | 'hard-light' | 'difference';
export type Tone = 'vivid' | 'pastel';
export type Density = 'line' | 'light' | 'normal' | 'strong';

export type Labels = 'top' | 'under';

export interface MapStyle {
  /** top: 카카오 도로·글자 레이어를 셀 위로 다시 올림 */
  labels: Labels;
  blend: Blend;
  tone: Tone;
  density: Density;
}

export const DENSITY: Record<Density, number> = { line: 0, light: 0.6, normal: 1, strong: 1.35 };

const BLENDS: { value: Blend; label: string; desc: string }[] = [
  { value: 'normal', label: '일반', desc: '그냥 위에 덮어 그림' },
  { value: 'multiply', label: '곱하기', desc: '밝은 곳만 물들고 어두운 글자·도로는 유지' },
  { value: 'darken', label: '어둡게', desc: '셀 색보다 밝은 부분만 셀 색으로 바뀜' },
  { value: 'color-burn', label: '색상 번', desc: '곱하기보다 대비가 강함' },
  { value: 'color', label: '색상', desc: '지도 밝기는 그대로, 색조만 셀 색으로' },
  { value: 'overlay', label: '오버레이', desc: '밝은 곳은 더 밝게, 어두운 곳은 더 어둡게' },
  { value: 'soft-light', label: '소프트 라이트', desc: '오버레이보다 부드러움' },
  { value: 'hard-light', label: '하드 라이트', desc: '셀 색 기준으로 강하게 대비' },
  { value: 'difference', label: '확인용: 반전', desc: '합성이 실제로 먹는지 확인용 — 지도 색이 뒤집혀 보이면 합성이 동작하는 것' },
];

const KEY = 'welcomehome.mapStyle.v2'; // 기본값이 바뀌면 버전을 올려 예전 저장값을 무시
export const DEFAULT_STYLE: MapStyle = { labels: 'under', blend: 'multiply', tone: 'pastel', density: 'normal' };

export function loadStyle(): MapStyle {
  try {
    return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULT_STYLE;
  }
}
export function saveStyle(s: MapStyle) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export default function MapStylePanel({ value, onChange }: { value: MapStyle; onChange: (s: MapStyle) => void }) {
  const [open, setOpen] = useState(false);
  const set = (p: Partial<MapStyle>) => onChange({ ...value, ...p });
  const cur = BLENDS.find((b) => b.value === value.blend)!;
  return (
    <div className="style-panel">
      <button className="style-toggle" onClick={() => setOpen(!open)}>
        표시 설정 <span className="muted">{value.labels === 'top' ? '글자 위로 · ' : ''}{cur.label} · {value.tone === 'pastel' ? '파스텔' : '원색'}</span> {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="style-body">
          <div className="style-row">
            <span>글자</span>
            <div className="style-opts">
              {(
                [
                  ['top', '셀 위로'],
                  ['under', '셀 아래'],
                ] as [Labels, string][]
              ).map(([k, l]) => (
                <button key={k} className={value.labels === k ? 'on' : ''} onClick={() => set({ labels: k })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="hint">{value.labels === 'top' ? '지도 배경 위에 셀 색을 덮고, 그 위에 도로·글자를 다시 올립니다' : '셀 색이 지도 글자 위에 그려집니다'}</div>
          <div className="style-row">
            <span>합성</span>
            <div className="style-opts">
              {BLENDS.map((b) => (
                <button key={b.value} className={value.blend === b.value ? 'on' : ''} title={b.desc} onClick={() => set({ blend: b.value })}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="hint">{cur.desc}</div>
          <div className="style-row">
            <span>색</span>
            <div className="style-opts">
              {(
                [
                  ['vivid', '원색'],
                  ['pastel', '파스텔'],
                ] as [Tone, string][]
              ).map(([k, l]) => (
                <button key={k} className={value.tone === k ? 'on' : ''} onClick={() => set({ tone: k })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="style-row">
            <span>진하기</span>
            <div className="style-opts">
              {(
                [
                  ['line', '테두리만'],
                  ['light', '연하게'],
                  ['normal', '보통'],
                  ['strong', '진하게'],
                ] as [Density, string][]
              ).map(([k, l]) => (
                <button key={k} className={value.density === k ? 'on' : ''} onClick={() => set({ density: k })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
