import { useState } from 'react';
import type { Cell, CellType, Level } from '@shared/types';
import { CELL_TYPES, CELL_TYPE_ORDER, LEVEL_LABEL } from '@shared/cellTypes';
import { walkMinToM } from '@shared/geo';
import {
  blankFilter,
  describe,
  METRIC_LABEL,
  POI_LABEL,
  type CellCond,
  type Dest,
  type FilterDef,
  type LevelMetric,
  type Op,
  type PlaceCond,
  type PoiKey,
} from './filters';
import { Swatch } from './ui';

export interface StackProps {
  stack: FilterDef[];
  setStack: (s: FilterDef[]) => void;
  poolCount: number;
  counts: number[]; // 각 필터 뒤 남은 셀 수
  final: Cell[];
  preview: number | null; // null = 마지막까지
  setPreview: (i: number | null) => void;
  dongs: { code: string; name: string }[];
  destinations: Dest[];
  selectedId: string | null;
  selectCell: (id: string | null) => void;
}

// ---------------------------------------------------------------- 시나리오 (사용자가 저장한 스택)
interface Scenario {
  name: string;
  stack: FilterDef[];
}
const SC_KEY = 'welcomehome.scenarios.v1';
function loadScenarios(): Scenario[] {
  try {
    return JSON.parse(localStorage.getItem(SC_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function saveScenarios(list: Scenario[]) {
  try {
    localStorage.setItem(SC_KEY, JSON.stringify(list));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export default function FilterStack(p: StackProps) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const dongName = (code: string) => p.dongs.find((d) => d.code === code)?.name ?? code;

  const update = (id: string, f: FilterDef) => p.setStack(p.stack.map((x) => (x.id === id ? f : x)));
  const remove = (id: string) => p.setStack(p.stack.filter((x) => x.id !== id));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= p.stack.length) return;
    const s = [...p.stack];
    [s[i], s[j]] = [s[j], s[i]];
    p.setStack(s);
  };
  const add = (f: FilterDef) => {
    p.setStack([...p.stack, f]);
    setAdding(false);
    setEditing(f.id);
  };

  // 드래그로 순서 바꾸기
  const [dragId, setDragId] = useState<string | null>(null);
  const onDrop = (overId: string) => {
    if (!dragId || dragId === overId) return;
    const s = p.stack.filter((x) => x.id !== dragId);
    const at = s.findIndex((x) => x.id === overId);
    s.splice(at, 0, p.stack.find((x) => x.id === dragId)!);
    p.setStack(s);
    setDragId(null);
  };

  const [scenarios, setScenarios] = useState<Scenario[]>(loadScenarios);
  const [current, setCurrent] = useState<string>('');
  const [naming, setNaming] = useState<string | null>(null);
  const writeScenarios = (list: Scenario[]) => {
    setScenarios(list);
    saveScenarios(list);
  };
  const saveAs = (name: string) => {
    const n = name.trim();
    if (!n) return;
    writeScenarios([...scenarios.filter((x) => x.name !== n), { name: n, stack: structuredClone(p.stack) }]);
    setCurrent(n);
    setNaming(null);
  };
  const load = (name: string) => {
    setCurrent(name);
    if (!name) return p.setStack([]);
    const sc = scenarios.find((x) => x.name === name);
    if (sc) p.setStack(structuredClone(sc.stack));
  };
  const dirty = (() => {
    const sc = scenarios.find((x) => x.name === current);
    return sc ? JSON.stringify(sc.stack) !== JSON.stringify(p.stack) : p.stack.length > 0;
  })();
  const shown = p.preview === null ? p.final.length : p.counts[p.preview];

  return (
    <div className="stack">
      <div className="scenario-bar">
        <select className="select sm" value={current} onChange={(e) => load(e.target.value)}>
          <option value="">새 시나리오 (빈 스택)</option>
          {scenarios.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name}
            </option>
          ))}
        </select>
        {naming === null ? (
          <>
            <button onClick={() => (current ? saveAs(current) : setNaming(''))} disabled={!dirty || p.stack.length === 0} title="현재 스택을 이 시나리오로 저장">
              저장{dirty && current ? ' *' : ''}
            </button>
            <button onClick={() => setNaming(current ? `${current} 복사` : '')} disabled={p.stack.length === 0}>
              다른 이름으로
            </button>
            {current && (
              <button
                className="danger"
                onClick={() => {
                  writeScenarios(scenarios.filter((x) => x.name !== current));
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
              className="name-input"
              autoFocus
              placeholder="시나리오 이름"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs(naming);
                if (e.key === 'Escape') setNaming(null);
              }}
            />
            <button className="primary" onClick={() => saveAs(naming)} disabled={!naming.trim()}>
              확인
            </button>
            <button onClick={() => setNaming(null)}>취소</button>
          </>
        )}
      </div>

      <div className="stack-pool">
        <div>
          <b>화면 안 셀 {p.poolCount}개</b>
          <div className="hint">지도를 움직이면 보이는 셀 기준으로 다시 계산합니다. 주변 조건은 화면 밖까지 넓혀 계산해요.</div>
        </div>
      </div>

      {p.stack.length === 0 && <div className="stack-empty">필터가 없습니다. 아래 <b>+ 필터 추가</b>로 조건을 쌓아 보세요.</div>}
      <ol className="stack-list">
        {p.stack.map((f, i) => {
          const prev = i === 0 ? p.poolCount : p.counts[i - 1];
          const cut = prev - p.counts[i];
          const on = p.preview === i;
          return (
            <li
              key={f.id}
              className={`stack-card ${f.enabled ? '' : 'off'} ${on ? 'preview' : ''} ${dragId === f.id ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDragId(f.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(f.id)}
              onDragEnd={() => setDragId(null)}
            >
              <div className="stack-row">
                <span className="grip" title="끌어서 순서 바꾸기">⋮⋮</span>
                <input type="checkbox" checked={f.enabled} onChange={(e) => update(f.id, { ...f, enabled: e.target.checked })} title="켜기/끄기" />
                <button className="stack-title" onClick={() => setEditing(editing === f.id ? null : f.id)} title="편집">
                  <span className="stack-num">{i + 1}</span>
                  {describe(f, dongName)}
                </button>
                <button className={`stack-count ${on ? 'on' : ''}`} onClick={() => p.setPreview(on ? null : i)} title="이 필터까지 결과를 지도에 표시">
                  {p.counts[i]}
                  {f.enabled && cut > 0 && <small>−{cut}</small>}
                </button>
              </div>
              {editing === f.id && (
                <div className="stack-edit">
                  <FilterEditor f={f} onChange={(nf) => update(f.id, nf)} dongs={p.dongs} destinations={p.destinations} />
                  <div className="stack-edit-actions">
                    <button onClick={() => move(i, -1)} disabled={i === 0}>▲ 위로</button>
                    <button onClick={() => move(i, 1)} disabled={i === p.stack.length - 1}>▼ 아래로</button>
                    <button className="danger" onClick={() => remove(f.id)}>삭제</button>
                    <button className="primary" onClick={() => setEditing(null)}>완료</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {adding ? (
        <div className="stack-add">
          <div className="stack-add-head">
            <b>필터 추가</b>
            <button className="link" onClick={() => setAdding(false)}>닫기</button>
          </div>
          <div className="preset-group">
            <div className="add-types">
              {(
                [
                  ['cell', '셀 조건', '이 셀 또는 주변 Rm 안의 셀이 [유형 / 유동인구 지표 / 셀 안 시설 수] 조건을 만족'],
                  ['place', '시설 조건', '가장 가까운 시설까지 거리 · 반경 안 시설 개수 · 반경 안 진료과 수'],
                  ['commute', '이동 시간', '고른 목적지까지 추정 이동 시간'],
                  ['dong', '행정동', '고른 행정동 안의 셀만'],
                ] as [FilterDef['type'], string, string][]
              ).map(([t, label, desc]) => (
                <button key={t} className="add-type" onClick={() => add(blankFilter(t, p.destinations[0]))}>
                  <b>{label}</b>
                  <span>{desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="stack-buttons">
          <button className="btn" onClick={() => setAdding(true)}>+ 필터 추가</button>
          {p.stack.length > 0 && (
            <button className="btn ghost" onClick={() => p.setStack([])}>
              모두 지우기
            </button>
          )}
        </div>
      )}

      <div className="section-title">
        {p.preview === null ? '결과' : `${p.preview + 1}번 필터까지 결과`} {shown}셀
        {p.preview !== null && (
          <button className="link" onClick={() => p.setPreview(null)}>
            {' '}끝까지 보기
          </button>
        )}
      </div>
      {p.preview === null && (
        <ul className="cand-list">
          {[...p.final]
            .sort((a, b) => a.dongName.localeCompare(b.dongName) || a.id.localeCompare(b.id))
            .slice(0, 50)
            .map((c) => (
              <li key={c.id} className={p.selectedId === c.id ? 'on' : ''} onClick={() => p.selectCell(c.id)}>
                <div className="cand-body">
                  <div>
                    <Swatch color={CELL_TYPES[c.type].color} />
                    <b>{c.dongName}</b> <span className="muted">{c.id}</span>
                  </div>
                  <div className="hint">
                    {CELL_TYPES[c.type].label} · 평일 저녁 {LEVEL_LABEL[c.levels.wdEvening]} · 주말 밤 {LEVEL_LABEL[c.levels.weNight]}
                  </div>
                </div>
              </li>
            ))}
        </ul>
      )}
      {p.final.length === 0 && p.preview === null && <div className="empty">남은 셀이 없습니다. 필터를 끄거나 조건을 완화해 보세요.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- 편집기
function FilterEditor({ f, onChange, dongs, destinations }: { f: FilterDef; onChange: (f: FilterDef) => void; dongs: { code: string; name: string }[]; destinations: Dest[] }) {
  if (f.type === 'commute')
    return (
      <>
        <Row label="목적지">
          <Select
            value={f.dest.name}
            options={destinations.map((d) => [d.name, d.name] as [string, string])}
            onChange={(name) => onChange({ ...f, dest: destinations.find((d) => d.name === name)! })}
          />
        </Row>
        <Row label="최대">
          <input type="range" className="slider" min={5} max={60} value={f.maxMin} onChange={(e) => onChange({ ...f, maxMin: +e.target.value })} />
          <b>{f.maxMin}분</b>
        </Row>
        <div className="hint">도보 / 대중교통(평균속도) 중 빠른 쪽으로 추정</div>
      </>
    );

  if (f.type === 'dong')
    return (
      <div className="chips">
        {dongs.map((d) => {
          const on = f.codes.includes(d.code);
          return (
            <button key={d.code} className={`chip ${on ? 'on' : ''}`} style={{ '--c': '#1d4c93' } as any} onClick={() => onChange({ ...f, codes: on ? f.codes.filter((x) => x !== d.code) : [...f.codes, d.code] })}>
              {d.name}
            </button>
          );
        })}
      </div>
    );

  if (f.type === 'place') {
    const c = f.cond;
    const setC = (nc: PlaceCond) => onChange({ ...f, cond: nc });
    return (
      <>
        <Row label="종류">
          <Select
            value={c.kind}
            options={[
              ['nearest', '가장 가까운 시설까지 거리'],
              ['count', '반경 안 시설 개수'],
              ['depts', '반경 안 병원 진료과 수'],
            ]}
            onChange={(k) =>
              setC(k === 'nearest' ? { kind: 'nearest', key: 'gym', maxWalkMin: 10 } : k === 'count' ? { kind: 'count', key: 'cafe', radius: 400, min: 5 } : { kind: 'depts', radius: 800, min: 5 })
            }
          />
        </Row>
        {c.kind !== 'depts' && (
          <Row label="시설">
            <PoiSelect value={c.key} onChange={(key) => setC({ ...c, key })} />
          </Row>
        )}
        {c.kind === 'nearest' && (
          <Row label="도보">
            <input type="range" className="slider" min={1} max={20} value={c.maxWalkMin} onChange={(e) => setC({ ...c, maxWalkMin: +e.target.value })} />
            <b>{c.maxWalkMin}분 (약 {Math.round(walkMinToM(c.maxWalkMin))}m)</b>
          </Row>
        )}
        {c.kind !== 'nearest' && (
          <>
            <Row label="반경">
              <input type="range" className="slider" min={100} max={1500} step={50} value={c.radius} onChange={(e) => setC({ ...c, radius: +e.target.value })} />
              <b>{c.radius}m</b>
            </Row>
            <Row label="최소">
              <input type="number" className="num" min={0} value={c.min} onChange={(e) => setC({ ...c, min: Math.max(0, +e.target.value) })} />
              <span>{c.kind === 'depts' ? '종 이상' : '곳 이상'}</span>
            </Row>
          </>
        )}
      </>
    );
  }

  // 셀 조건
  const t = f.target;
  const c = f.cond;
  const setT = (nt: typeof t) => onChange({ ...f, target: nt });
  const setC = (nc: CellCond) => onChange({ ...f, cond: nc });
  return (
    <>
      <Row label="대상">
        <Select
          value={t.mode}
          options={[
            ['self', '이 셀'],
            ['around', '주변 셀'],
          ]}
          onChange={(m) => setT(m === 'self' ? { mode: 'self' } : { mode: 'around', radius: 500, op: 'gte', count: 1 })}
        />
      </Row>
      {t.mode === 'around' && (
        <>
          <Row label="반경">
            <input type="range" className="slider" min={200} max={1200} step={100} value={t.radius} onChange={(e) => setT({ ...t, radius: +e.target.value })} />
            <b>{t.radius}m</b>
          </Row>
          <Row label="개수">
            <input type="number" className="num" min={0} value={t.count} onChange={(e) => setT({ ...t, count: Math.max(0, +e.target.value) })} />
            <span>개</span>
            <OpSelect value={t.op} onChange={(op) => setT({ ...t, op })} />
          </Row>
        </>
      )}
      <Row label="조건">
        <Select
          value={c.kind}
          options={[
            ['type', '셀 유형'],
            ['level', '유동인구 지표'],
            ['poi', '셀 안 시설 수'],
          ]}
          onChange={(k) =>
            setC(k === 'type' ? { kind: 'type', types: ['quiet'] } : k === 'level' ? { kind: 'level', metric: 'wdEvening', op: 'gte', value: 3 } : { kind: 'poi', key: 'cafe', op: 'gte', value: 1 })
          }
        />
      </Row>
      {c.kind === 'type' && (
        <div className="chips">
          {CELL_TYPE_ORDER.map((ty: CellType) => {
            const on = c.types.includes(ty);
            return (
              <button key={ty} className={`chip ${on ? 'on' : ''}`} style={{ '--c': CELL_TYPES[ty].color } as any} onClick={() => setC({ ...c, types: on ? c.types.filter((x) => x !== ty) : [...c.types, ty] })}>
                {CELL_TYPES[ty].label}
              </button>
            );
          })}
        </div>
      )}
      {c.kind === 'level' && (
        <Row label="">
          <Select value={c.metric} options={Object.entries(METRIC_LABEL) as [LevelMetric, string][]} onChange={(metric) => setC({ ...c, metric })} />
          <Select value={String(c.value)} options={([1, 2, 3, 4, 5] as Level[]).map((l) => [String(l), LEVEL_LABEL[l]] as [string, string])} onChange={(v) => setC({ ...c, value: +v as Level })} />
          <OpSelect value={c.op} onChange={(op) => setC({ ...c, op })} />
        </Row>
      )}
      {c.kind === 'poi' && (
        <Row label="">
          <PoiSelect value={c.key} onChange={(key) => setC({ ...c, key })} />
          <input type="number" className="num" min={0} value={c.value} onChange={(e) => setC({ ...c, value: Math.max(0, +e.target.value) })} />
          <span>곳</span>
          <OpSelect value={c.op} onChange={(op) => setC({ ...c, op })} />
        </Row>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="edit-row">
      <span className="edit-label">{label}</span>
      <div className="edit-ctrl">{children}</div>
    </div>
  );
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select className="select sm" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

const OpSelect = ({ value, onChange }: { value: Op; onChange: (o: Op) => void }) => (
  <Select
    value={value}
    options={[
      ['gte', '이상'],
      ['lte', '이하'],
    ]}
    onChange={onChange}
  />
);

const PoiSelect = ({ value, onChange }: { value: PoiKey; onChange: (k: PoiKey) => void }) => (
  <Select value={value} options={Object.entries(POI_LABEL) as [PoiKey, string][]} onChange={onChange} />
);
