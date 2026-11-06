import { useRef, useState } from 'react';
import { newPoiCond, newPopCond, type Cond } from './classify';
import CondBuilder, { NumPill, Pill, type ExplainCtx } from './CondBuilder';
import { describe, type CellPred, type Dest, type FilterDef, type Names } from './filters';

interface Props {
  on: boolean;
  setOn: (v: boolean) => void;
  stack: FilterDef[];
  setStack: (s: FilterDef[]) => void;
  counts: number[];
  total: number;
  passInView: number;
  /** 위에서 몇 개 조건까지 적용할지 (0 ~ stack.length) */
  pin: number;
  setPin: (n: number) => void;
  /** 이 조건 하나만 적용해서 보기 */
  solo: string | null;
  setSolo: (id: string | null) => void;
  soloCount: number | null;
  cats: { id: string; label: string; color: string }[];
  dongs: { code: string; name: string }[];
  destinations: Dest[];
  x: ExplainCtx;
  names: Names;
  /** 선택한 구역이 각 조건을 통과하는지 (선택 없으면 null) */
  selChecks: boolean[] | null;
  selName: string;
}

// ---------------------------------------------------------------- 저장한 조건 묶음
interface FilterSet {
  name: string;
  stack: FilterDef[];
}
const SET_KEY = 'wh.filterSets.v7'; // v6 이하는 버림 (2026-11-06 칸 단위 연령·성별 추가)
const loadSets = (): FilterSet[] => {
  try {
    return JSON.parse(localStorage.getItem(SET_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const saveSets = (s: FilterSet[]) => {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(s));
  } catch {
    /* 저장 실패는 무시 */
  }
};

// ---------------------------------------------------------------- 추가할 수 있는 조건 (문장 틀)
let seq = 0;
const nid = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;
const metric = (cond: Cond): FilterDef => ({ id: nid(), enabled: true, type: 'cell', pred: { kind: 'metric', cond } });
const TEMPLATES: { label: string; hint: string; make: (dest: Dest) => FilterDef }[] = [
  { label: '사람 (유동인구)', hint: '언제 · 누가 · 많은 곳/적은 곳', make: () => metric(newPopCond()) },
  { label: '연령 · 성별 비율', hint: '여성 비율 · 20대 비율 … 몇 % 이상', make: () => metric(newPopCond({ measure: 'share', sexes: [1], op: 'gte', mode: 'abs', value: 50, value2: undefined })) },
  { label: '가게 · 시설', hint: '카페 · 편의점 · 지하철역 … 있는 곳 · 가까운 곳', make: () => metric(newPoiCond()) },
  { label: '동네 성격', hint: '조용한 주거형 · 상업·외식형 …', make: () => ({ id: nid(), enabled: true, type: 'cell', pred: { kind: 'category', ids: [] } }) },
  { label: '이동 시간', hint: '○○까지 몇 분 안에 갈 수 있는 곳', make: (dest) => ({ id: nid(), enabled: true, type: 'commute', maxMin: 20, dest }) },
  { label: '행정동', hint: '고른 동 안에서만', make: () => ({ id: nid(), enabled: true, type: 'dong', codes: [] }) },
];


/** 펼친 카드 제목: 무엇에 대한 조건인지만 (자세한 값은 아래 편집 칸에) */
function kindLabel(f: FilterDef) {
  if (f.type === 'commute') return '이동 시간';
  if (f.type === 'dong') return '행정동';
  if (f.pred.kind === 'category') return '동네 성격';
  const c = f.pred.cond;
  if (c.src === 'pop' && c.measure === 'share' && (c.ages.length < 6 || c.sexes.length < 2)) return '연령 · 성별 비율';
  return c.src === 'pop' ? '사람 (유동인구)' : c.src === 'poi' ? '가게 · 시설' : '병원 진료과';
}

/** 조건마다 다른 색 — 단계 구분용 */
const STEP_COLORS = ['#2563eb', '#0d9488', '#d97706', '#9333ea', '#e11d48', '#0891b2', '#65a30d', '#c026d3'];

export default function FilterSection(p: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sets, setSetsState] = useState<FilterSet[]>(loadSets);
  const [current, setCurrent] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const setSets = (s: FilterSet[]) => {
    setSetsState(s);
    saveSets(s);
  };
  const saveAs = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setSets([...sets.filter((v) => v.name !== n), { name: n, stack: structuredClone(p.stack) }]);
    setCurrent(n);
    setNaming(null);
  };
  const dirty = (() => {
    const s = sets.find((v) => v.name === current);
    return s ? JSON.stringify(s.stack) !== JSON.stringify(p.stack) : p.stack.length > 0;
  })();

  const update = (i: number, f: FilterDef) => p.setStack(p.stack.map((v, j) => (j === i ? f : v)));
  const pct = (n: number) => `${Math.max(1.5, (n / Math.max(p.total, 1)) * 100)}%`;
  const pinCount = p.pin === 0 ? p.total : p.counts[p.pin - 1];
  const resultCount = p.soloCount ?? pinCount;

  // ---------- 핀 드래그: 놓은 위치의 위쪽 조건까지만 적용 ----------
  const stepEls = useRef<(HTMLDivElement | null)[]>([]);
  const [dragging, setDraggingState] = useState(false);
  const draggingRef = useRef(false); // 이벤트 사이에 바로 반영되도록 ref 로도 들고 있음
  const setDragging = (v: boolean) => {
    draggingRef.current = v;
    setDraggingState(v);
  };
  const pinAt = (clientY: number) => {
    let k = 0;
    stepEls.current.slice(0, p.stack.length).forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) k = i + 1;
    });
    if (k !== p.pin) p.setPin(k);
  };
  // ---------- 순서 바꾸기: 번호(손잡이)를 잡고 위아래로 끌기 ----------
  // to = 끼워 넣을 자리 (0 = 맨 위, stack.length = 맨 아래)
  const [reorder, setReorderState] = useState<{ from: number; to: number } | null>(null);
  const reorderRef = useRef(reorder);
  const setReorder = (v: { from: number; to: number } | null) => {
    reorderRef.current = v;
    setReorderState(v);
  };
  const dropAt = (clientY: number) => {
    let k = 0;
    stepEls.current.slice(0, p.stack.length).forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) k = i + 1;
    });
    return k;
  };
  const finishReorder = () => {
    const r = reorderRef.current;
    setReorder(null);
    if (!r || r.to === r.from || r.to === r.from + 1) return;
    const s = [...p.stack];
    const [item] = s.splice(r.from, 1);
    s.splice(r.to > r.from ? r.to - 1 : r.to, 0, item);
    p.setStack(s);
  };
  // 끼워 넣을 자리 표시 (제자리면 안 보임)
  const dropLine = (k: number) => reorder && k === reorder.to && k !== reorder.from && k !== reorder.from + 1 && <div className="drop-line" />;

  const pinRow = (
    <div
      className={`pin-row ${dragging ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        setDragging(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => draggingRef.current && pinAt(e.clientY)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      title="위아래로 끌어서 몇 번째 조건까지 적용할지 정해요"
    >
      <span className="pin-handle">📍</span>
      <span className="pin-label">
        {p.pin === 0 ? '조건 적용 안 함' : p.pin >= p.stack.length ? '모든 조건 적용' : `${p.pin}번까지 적용`} · <b>{pinCount}곳</b>
      </span>
      <span className="pin-grip">⇕ 끌기</span>
    </div>
  );

  return (
    <div className="filters">
      {/* 도구 줄: 지도 표시 · 저장한 조건 */}
      <div className="toolbar">
        <label className="mini-switch" title="지도에 결과 보기 (F)">
          <input type="checkbox" className="switch" checked={p.on} onChange={(e) => p.setOn(e.target.checked)} />
          지도에 보기 <kbd>F</kbd>
        </label>
        <span className="grow" />
        {(p.stack.length > 0 || sets.length > 0) && (naming === null ? (
          <>
            <select
              className="sel"
              value={current}
              onChange={(e) => {
                const name = e.target.value;
                setCurrent(name);
                const s = sets.find((v) => v.name === name);
                p.setStack(s ? structuredClone(s.stack) : []);
                setOpen(null);
              }}
              title="저장한 조건 불러오기"
            >
              <option value="">{sets.length ? '저장한 조건…' : '저장한 조건 없음'}</option>
              {sets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <button className="tool" onClick={() => (current ? saveAs(current) : setNaming(''))} disabled={!dirty || !p.stack.length}>
              저장
            </button>
            {current && (
              <button
                className="tool danger"
                onClick={() => {
                  setSets(sets.filter((v) => v.name !== current));
                  setCurrent('');
                }}
              >
                삭제
              </button>
            )}
          </>
        ) : (
          <>
            <input
              className="name"
              autoFocus
              placeholder="예: 조용한데 편한 동네"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs(naming);
                if (e.key === 'Escape') setNaming(null);
              }}
            />
            <button className="tool primary" onClick={() => saveAs(naming)} disabled={!naming.trim()}>
              저장
            </button>
            <button className="tool" onClick={() => setNaming(null)}>
              취소
            </button>
          </>
        ))}
      </div>

      {/* 스택: 위에서 아래로 걸러지는 흐름 */}
      <div className={`pipe ${p.solo ? 'solo-mode' : ''}`}>
        <div className="pipe-node src">
          <span className="node-dot" />
          <span>전체 구역</span>
          <b>{p.total}곳</b>
        </div>
        {p.selChecks && p.stack.length > 0 && (
          <div className="sel-banner">
            {/* 결과(✓/✕)가 바뀌어도 높이가 그대로이게 한 줄 고정 — 긴 이름은 말줄임 */}
            <span className="sel-name">
              선택 구역 <b>{p.selName}</b>
            </span>
            {(() => {
              const drop = p.stack.findIndex((f, i) => f.enabled && !p.selChecks![i]);
              return drop === -1 ? <span className="ok">모든 조건 통과 ✓</span> : <span className="no">{drop + 1}번 조건에서 걸러짐 ✕</span>;
            })()}
          </div>
        )}

        {p.stack.length > 1 && p.pin === 0 && !p.solo && pinRow}
        {p.stack.map((f, i) => {
          const prev = i === 0 ? p.total : p.counts[i - 1];
          const movable = p.stack.length > 1;
          const cut = prev - p.counts[i];
          const isOpen = open === f.id;
          const isSolo = p.solo === f.id;
          const afterPin = !p.solo && i >= p.pin;
          const color = STEP_COLORS[i % STEP_COLORS.length];
          return (
            <div key={f.id}>
              {dropLine(i)}
              <div
                ref={(el) => {
                  stepEls.current[i] = el;
                }}
                className={`step ${isOpen ? 'open' : ''} ${f.enabled ? '' : 'off'} ${afterPin ? 'after-pin' : ''} ${isSolo ? 'solo' : ''} ${p.solo && !isSolo ? 'dim' : ''} ${reorder?.from === i ? 'lifted' : ''}`}
                style={{ '--c': color } as React.CSSProperties}
              >
                <div
                  className={`step-rail ${movable ? 'grab' : ''}`}
                  title={movable ? '끌어서 순서 바꾸기' : undefined}
                  onPointerDown={(e) => {
                    if (!movable) return;
                    e.preventDefault();
                    setReorder({ from: i, to: i });
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const r = reorderRef.current;
                    if (!r) return;
                    const to = dropAt(e.clientY);
                    if (to !== r.to) setReorder({ ...r, to });
                  }}
                  onPointerUp={finishReorder}
                  onPointerCancel={() => setReorder(null)}
                >
                  <span className="step-num">{i + 1}</span>
                  {movable && <span className="grip" aria-hidden>⠿</span>}
                </div>
                <div className="step-card">
                  {/* 1줄: 무엇에 대한 조건인지 + 이것만 / 2줄: 남은 수 · 선택 구역 · 사용 */}
                  <div className="step-head">
                    <button className="step-text" onClick={() => setOpen(isOpen ? null : f.id)} title={isOpen ? '접기' : '눌러서 편집'}>
                      {isOpen ? kindLabel(f) : describe(f, p.names)}
                    </button>
                    <button className={`solo-btn ${isSolo ? 'on' : ''}`} onClick={() => p.setSolo(isSolo ? null : f.id)} title="이 조건 하나만 적용해서 지도에 보기">
                      {isSolo ? '이것만 ✓' : '이것만'}
                    </button>
                  </div>
                  {/* 이 조건까지 적용했을 때 통과한 수 · 이 조건에서 걸러진 수 (한 줄 고정) */}
                  <div className="step-meta">
                    <span className="step-count">
                      통과 <b>{isSolo ? p.soloCount : p.counts[i]}곳</b>
                    </span>
                    {!isSolo && f.enabled && cut > 0 && (
                      <span className="step-cut">
                        걸러짐 <b>{cut}곳</b>
                      </span>
                    )}
                    <span className="grow" />
                    {isOpen ? (
                      <label className="use-switch" title="끄면 이 조건을 잠시 빼고 걸러요">
                        <input type="checkbox" className="switch" checked={f.enabled} onChange={(e) => update(i, { ...f, enabled: e.target.checked })} />
                        사용
                      </label>
                    ) : (
                      !f.enabled && <span className="tag-off">꺼짐</span>
                    )}
                  </div>
                  {p.selChecks && f.enabled && (
                    <div className={`step-sel ${p.selChecks[i] ? 'ok' : 'no'}`}>
                      고른 구역({p.selName}) {p.selChecks[i] ? '통과' : '이 조건에서 걸러짐'}
                    </div>
                  )}
                  <div className="step-bar">
                    <i style={{ width: pct(isSolo ? p.soloCount ?? 0 : p.counts[i]) }} />
                  </div>
                  {isOpen && (
                    <div className="step-edit">
                      <div className="fsentence">
                        <FilterSentence f={f} onChange={(nf) => update(i, nf)} {...p} />
                      </div>
                      <div className="step-foot">
                        <button className="del" onClick={() => p.setStack(p.stack.filter((v) => v.id !== f.id))}>
                          조건 삭제
                        </button>
                        <button className="done" onClick={() => setOpen(null)}>
                          완료
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {p.stack.length > 1 && !p.solo && p.pin === i + 1 && i + 1 < p.stack.length && pinRow}
            </div>
          );
        })}
        {dropLine(p.stack.length)}

        <div className="step add">
          <div className="step-rail">
            <span className="step-num plus">+</span>
          </div>
          <div className="step-card ghost">
            {adding ? (
              <div className="templates">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    className="template"
                    onClick={() => {
                      const f = t.make(p.destinations[0]);
                      p.setStack([...p.stack, f]);
                      setAdding(false);
                      setOpen(f.id);
                    }}
                  >
                    <b>{t.label}</b>
                    <small>{t.hint}</small>
                  </button>
                ))}
                <button className="link" onClick={() => setAdding(false)}>
                  취소
                </button>
              </div>
            ) : (
              <button className="step-add" onClick={() => setAdding(true)}>
                조건 추가
              </button>
            )}
          </div>
        </div>
        {p.stack.length > 1 && !p.solo && p.pin >= p.stack.length && pinRow}

        <div className="pipe-node out">
          <span className="node-dot" />
          <span>{p.solo ? '이 조건만 적용한 결과' : p.pin === 0 && p.stack.length ? '조건 적용 전' : p.pin < p.stack.length ? `${p.pin}번까지 적용한 결과` : '결과'}</span>
          <b>{resultCount}곳</b>
          <span className="muted">화면 안 {p.passInView}곳</span>
          {p.solo ? (
            <button className="link" onClick={() => p.setSolo(null)}>
              전체 흐름으로
            </button>
          ) : (
            p.stack.length > 0 && (
              <button className="link" onClick={() => p.setStack([])}>
                비우기
              </button>
            )
          )}
        </div>
        {p.stack.length > 1 && <div className="hint">📍 핀을 위아래로 끌면 그 위 조건까지만 적용돼요. ‘이것만’을 누르면 그 조건 하나만 지도에 보여요.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 조건 문장 (문장 안에서 바로 고침)
function FilterSentence({ f, onChange, cats, dongs, destinations, x }: { f: FilterDef; onChange: (f: FilterDef) => void } & Props) {
  if (f.type === 'commute')
    return (
      <>
        <Pill value={f.dest.name} options={destinations.map((d) => [d.name, d.name] as [string, string])} onChange={(n) => onChange({ ...f, dest: destinations.find((d) => d.name === n)! })} />
        <span>까지</span>
        <NumPill value={f.maxMin} min={1} onChange={(v) => onChange({ ...f, maxMin: v })} />
        <span>분 안에 갈 수 있는 곳</span>
        <div className="hint full">걷기와 대중교통 중 빠른 쪽으로 어림잡은 시간이에요.</div>
      </>
    );

  if (f.type === 'dong')
    return (
      <>
        <span>이 동 안에서만:</span>
        <div className="chips full">
          {dongs.map((d) => {
            const on = f.codes.includes(d.code);
            return (
              <button key={d.code} className={`chip ${on ? 'on' : ''}`} onClick={() => onChange({ ...f, codes: on ? f.codes.filter((v) => v !== d.code) : [...f.codes, d.code] })}>
                {d.name}
              </button>
            );
          })}
        </div>
        {f.codes.length === 0 && <div className="hint full">동을 골라 주세요. 고르기 전에는 전체를 통과시켜요.</div>}
      </>
    );

  // 구역 조건
  const pr = f.pred;
  const setP = (np: CellPred) => onChange({ ...f, pred: np });
  if (pr.kind === 'metric')
    return (
      <div className="full">
        <CondBuilder id={f.id} cond={pr.cond} x={x} autoPick onChange={(cond) => setP({ ...pr, cond })} />
      </div>
    );
  return (
    <>
      <span>동네 성격이 이 중 하나인 곳:</span>
      <div className="chips full">
        {cats.length === 0 && <span className="hint">동네 성격이 없어요. [동네 성격] 탭에서 먼저 만들어 주세요.</span>}
        {cats.length > 0 && pr.ids.length === 0 && <span className="hint">성격을 골라 주세요. 고르기 전에는 전체를 통과시켜요.</span>}
        {cats.map((k) => {
          const on = pr.ids.includes(k.id);
          return (
            <button
              key={k.id}
              className={`chip ${on ? 'on' : ''}`}
              style={{ '--c': k.color } as React.CSSProperties}
              onClick={() => setP({ ...pr, ids: on ? pr.ids.filter((v) => v !== k.id) : [...pr.ids, k.id] })}
            >
              {k.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
