import { useMemo, useState } from 'react';
import type { Cell, CellType, Level, Listing, Meta } from '@shared/types';
import { CELL_TYPES, CELL_TYPE_ORDER, LEVEL_LABEL } from '@shared/cellTypes';
import { walkMin, walkMinToM } from '@shared/geo';
import { evalListing, type CellEval, type Criteria, type Ctx, type DongEval } from './analysis';
import { Field, LevelBadge, LevelPicker, Segmented, Slider, Swatch, Toggle } from './ui';

export const STEPS = [
  { n: 1, title: '목적지 · 행정동', sub: '큰 생활권부터 비교' },
  { n: 2, title: '셀 성격 분류', sub: '200m × 200m 셀 유형' },
  { n: 3, title: '거주 셀 유형', sub: '살고 싶은 셀의 성격' },
  { n: 4, title: '주변 생활권', sub: '도보권 생활상권' },
  { n: 5, title: '헬스장', sub: '최근접 거리' },
  { n: 6, title: '의료 생활권', sub: '진료과 다양성' },
  { n: 7, title: '시간대 패턴', sub: '거주 셀 vs 주변 셀' },
  { n: 8, title: '후보 비교', sub: '최종 후보 셀' },
  { n: 9, title: '매물 탐색', sub: '좌표 기준 재계산' },
];

export type ColorMode = 'type' | 'wdEvening' | 'weNight' | 'youth';

export interface StepProps {
  step: number;
  c: Criteria;
  set: (p: Partial<Criteria>) => void;
  meta: Meta;
  dongEvals: DongEval[];
  evals: CellEval[];
  byId: Map<string, CellEval>;
  selectedId: string | null;
  selectCell: (id: string | null) => void;
  pinned: string[];
  setPinned: (ids: string[]) => void;
  listingCellId: string | null;
  setListingCellId: (id: string | null) => void;
  activeListing: string | null;
  setActiveListing: (id: string | null) => void;
  listings: Listing[];
  ctx: Ctx;
  cellById: Map<string, Cell>;
  colorMode: ColorMode;
  setColorMode: (m: ColorMode) => void;
  goStep: (n: number, cellId?: string) => void;
}

export function StepPanel(p: StepProps) {
  switch (p.step) {
    case 1: return <Step1 {...p} />;
    case 2: return <Step2 {...p} />;
    case 3: return <Step3 {...p} />;
    case 4: return <Step4 {...p} />;
    case 5: return <Step5 {...p} />;
    case 6: return <Step6 {...p} />;
    case 7: return <Step7 {...p} />;
    case 8: return <Step8 {...p} />;
    default: return <Step9 {...p} />;
  }
}

// ---------------------------------------------------------------- 1
function Step1({ c, set, meta, dongEvals }: StepProps) {
  const passing = dongEvals.filter((d) => d.pass);
  const toggle = (code: string) =>
    set({ selectedDongs: c.selectedDongs.includes(code) ? c.selectedDongs.filter((x) => x !== code) : [...c.selectedDongs, code] });
  return (
    <>
      <Field label="주요 목적지">
        <select className="select" value={c.destIdx} onChange={(e) => set({ destIdx: +e.target.value, selectedDongs: [] })}>
          {meta.destinations.map((d, i) => (
            <option key={d.name} value={i}>{d.name}</option>
          ))}
        </select>
      </Field>
      <Field label="통학 시간" value={`${c.maxCommute}분 이내`} hint="도보 / 대중교통(평균속도) 중 빠른 쪽으로 추정">
        <Slider min={10} max={40} value={c.maxCommute} onChange={(v) => set({ maxCommute: v, selectedDongs: [] })} />
      </Field>
      <Field label="20대 활동도">
        <LevelPicker levels={[2, 3, 4]} value={c.minYouth} onChange={(v) => set({ minYouth: v, selectedDongs: [] })} />
        <div className="hint">{LEVEL_LABEL[c.minYouth]} 이상</div>
      </Field>
      <Toggle checked={c.excludeLowEvening} onChange={(v) => set({ excludeLowEvening: v, selectedDongs: [] })}>
        평일 16~24시 활동량 너무 낮은 동 제외
      </Toggle>
      <Toggle checked={c.excludeWeekendCrowded} onChange={(v) => set({ excludeWeekendCrowded: v, selectedDongs: [] })}>
        금~일 20~24시 과밀 동 제외
      </Toggle>

      <div className="section-title">
        1차 후보 {passing.length}개 동 <small>클릭해서 확대할 동 선택 (미선택 시 전체)</small>
      </div>
      <ul className="dong-list">
        {dongEvals.map((d) => {
          const on = c.selectedDongs.includes(d.dong.code);
          return (
            <li key={d.dong.code} className={`${d.pass ? '' : 'fail'} ${on ? 'on' : ''}`} onClick={() => d.pass && toggle(d.dong.code)}>
              <input type="checkbox" checked={on} disabled={!d.pass} readOnly />
              <b>{d.dong.name}</b>
              <span className="muted">{d.commute}분</span>
              {d.pass ? (
                <span className="dong-lv">
                  20대 <LevelBadge level={d.dong.youth} /> 주말밤 <LevelBadge level={d.dong.weNight} invert />
                </span>
              ) : (
                <span className="reason">{d.reasons.join(' · ')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- 2
function Step2({ evals, colorMode, setColorMode }: StepProps) {
  const pool = evals.filter((e) => e.passedUpTo >= 2);
  const counts = useMemo(() => {
    const m: Partial<Record<CellType, number>> = {};
    for (const e of pool) m[e.cell.type] = (m[e.cell.type] ?? 0) + 1;
    return m;
  }, [pool]);
  return (
    <>
      <p className="lead">
        각 셀을 유동인구의 <b>양</b>이 아니라 <b>시간대 패턴 + 주변 시설</b>로 해석해 성격을 부여했습니다. 지도에서 셀을 클릭하면 상세 패턴을 볼 수 있어요.
      </p>
      <ColorModeSwitch colorMode={colorMode} setColorMode={setColorMode} />
      <ul className="type-list">
        {CELL_TYPE_ORDER.map((t) => (
          <li key={t}>
            <Swatch color={CELL_TYPES[t].color} />
            <div>
              <b>{CELL_TYPES[t].label}</b> <span className="muted">{counts[t] ?? 0}셀</span>
              <div className="hint">{CELL_TYPES[t].desc.join(' · ')}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="hint">후보 동 안의 셀 {pool.length}개</div>
    </>
  );
}

function ColorModeSwitch({ colorMode, setColorMode }: Pick<StepProps, 'colorMode' | 'setColorMode'>) {
  return (
    <Field label="지도 색상">
      <Segmented<ColorMode>
        options={[
          { value: 'type', label: '셀 유형' },
          { value: 'wdEvening', label: '평일 저녁' },
          { value: 'weNight', label: '주말 밤' },
          { value: 'youth', label: '20대' },
        ]}
        value={colorMode}
        onChange={setColorMode}
      />
    </Field>
  );
}

// ---------------------------------------------------------------- 3
function Step3({ c, set, evals }: StepProps) {
  const pool = evals.filter((e) => e.passedUpTo >= 2);
  const toggle = (t: CellType) => set({ homeTypes: c.homeTypes.includes(t) ? c.homeTypes.filter((x) => x !== t) : [...c.homeTypes, t] });
  return (
    <>
      <p className="lead">집 바로 주변이 어떤 성격이길 원하나요? 선택하지 않은 유형은 <b>거주 후보</b>에서만 빠지고, 주변 생활권으로는 계속 활용됩니다.</p>
      <ul className="type-list selectable">
        {CELL_TYPE_ORDER.filter((t) => t !== 'green').map((t) => (
          <li key={t} className={c.homeTypes.includes(t) ? 'on' : ''} onClick={() => toggle(t)}>
            <input type="checkbox" checked={c.homeTypes.includes(t)} readOnly />
            <Swatch color={CELL_TYPES[t].color} />
            <div>
              <b>{CELL_TYPES[t].label}</b> <span className="muted">{pool.filter((e) => e.cell.type === t).length}셀</span>
              <div className="hint">{CELL_TYPES[t].desc.join(' · ')}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- 4
function Step4({ c, set }: StepProps) {
  const toggle = (t: CellType) => set({ needTypes: c.needTypes.includes(t) ? c.needTypes.filter((x) => x !== t) : [...c.needTypes, t] });
  return (
    <>
      <p className="lead">
        <b>집은 조용하게, 조금만 걸으면 생활상권.</b> 후보 셀 하나가 아니라 주변 셀과의 조합을 봅니다.
      </p>
      <Field label="주변 탐색 반경" value={`${c.radius}m · 도보 약 ${Math.round(walkMin(c.radius))}분`}>
        <Slider min={400} max={600} step={50} value={c.radius} onChange={(v) => set({ radius: v })} />
      </Field>
      <Field label="반경 안에 최소 1개 이상 있어야 할 셀" hint="선택한 유형 중 하나라도 있으면 통과">
        <div className="chips">
          {(['living', 'commercial', 'campus', 'medical'] as CellType[]).map((t) => (
            <button key={t} className={`chip ${c.needTypes.includes(t) ? 'on' : ''}`} style={{ '--c': CELL_TYPES[t].color } as any} onClick={() => toggle(t)}>
              {CELL_TYPES[t].label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="반경 내 음식점·카페" value={`${c.minEat}곳 이상`}>
        <Slider min={0} max={80} step={5} value={c.minEat} onChange={(v) => set({ minEat: v })} />
      </Field>
      <div className="hint">지도에서 후보 셀을 클릭하면 반경과 주변 셀 구성이 표시됩니다.</div>
    </>
  );
}

// ---------------------------------------------------------------- 5
function Step5({ c, set }: StepProps) {
  return (
    <>
      <p className="lead">헬스장은 <b>개수보다 가장 가까운 한 곳</b>이 중요합니다.</p>
      <Field label="최근접 헬스장" value={`도보 ${c.gymMaxMin}분 이내 (약 ${Math.round(walkMinToM(c.gymMaxMin))}m)`}>
        <Slider min={3} max={20} value={c.gymMaxMin} onChange={(v) => set({ gymMaxMin: v })} />
      </Field>
      <div className="hint">지도의 보라색 점이 헬스장입니다. 셀 중심 기준이며, 매물 단계에서 실제 좌표로 다시 계산합니다.</div>
    </>
  );
}

// ---------------------------------------------------------------- 6
function Step6({ c, set }: StepProps) {
  return (
    <>
      <p className="lead">병원은 헬스장과 달리 <b>개수와 진료과 종류</b>가 중요합니다. 약국은 병원 생활권에 포함해 표시만 합니다.</p>
      <Field label="의료 생활권 반경" value={`${c.medRadius}m`}>
        <Slider min={500} max={1000} step={100} value={c.medRadius} onChange={(v) => set({ medRadius: v })} />
      </Field>
      <Field label="진료과 다양성" value={`${c.minDepts}종 이상`} hint="내과·정형외과·피부과·치과·안과·이비인후과 등">
        <Segmented<number>
          options={[
            { value: 3, label: '낮음 (3)' },
            { value: 5, label: '중간 (5)' },
            { value: 7, label: '높음 (7)' },
          ]}
          value={c.minDepts}
          onChange={(v) => set({ minDepts: v })}
        />
      </Field>
      <div className="hint">지도에서 셀을 클릭하면 반경 안의 병원(청록색 점)이 표시됩니다.</div>
    </>
  );
}

// ---------------------------------------------------------------- 7
function Step7({ c, set, colorMode, setColorMode }: StepProps) {
  return (
    <>
      <p className="lead">거주 셀은 밤에 <b>조용해야</b> 하고, 주변 생활권은 저녁에 <b>살아 있어야</b> 합니다. 두 가지를 분리해서 봅니다.</p>
      <div className="section-title">거주 셀</div>
      <Field label="월~목 20~24시 유동인구" value={`${LEVEL_LABEL[c.homeWdNightMax]} 이하`}>
        <LevelPicker levels={[2, 3, 4]} value={c.homeWdNightMax} onChange={(v) => set({ homeWdNightMax: v })} />
      </Field>
      <Field label="금~일 20~24시 혼잡도" value={`${LEVEL_LABEL[c.homeWeNightMax]} 이하`}>
        <LevelPicker levels={[2, 3, 4]} value={c.homeWeNightMax} onChange={(v) => set({ homeWeNightMax: v })} />
      </Field>
      <div className="section-title">주변 셀 ({c.radius}m)</div>
      <Field label="월~목 16~24시 생활상권 활동도" value={`${LEVEL_LABEL[c.nbEveningMin]} 이상`}>
        <LevelPicker levels={[2, 3, 4]} value={c.nbEveningMin} onChange={(v) => set({ nbEveningMin: v })} />
      </Field>
      <ColorModeSwitch colorMode={colorMode} setColorMode={setColorMode} />
    </>
  );
}

// ---------------------------------------------------------------- 8
const LETTERS = ['A', 'B', 'C'];
function Step8({ evals, pinned, setPinned, selectCell, selectedId, goStep }: StepProps) {
  const finals = evals.filter((e) => e.passedUpTo >= 7).sort((a, b) => b.score - a.score);
  const misses = evals
    .filter((e) => e.passedUpTo >= 3 && e.passedUpTo < 7)
    .sort((a, b) => b.passedUpTo - a.passedUpTo || b.score - a.score)
    .slice(0, 3);
  const togglePin = (id: string) =>
    setPinned(pinned.includes(id) ? pinned.filter((x) => x !== id) : pinned.length >= 3 ? [...pinned.slice(1), id] : [...pinned, id]);
  const compared = pinned.map((id) => evals.find((e) => e.cell.id === id)).filter(Boolean) as CellEval[];

  return (
    <>
      {finals.length === 0 && <div className="empty">조건을 모두 만족하는 셀이 없습니다. 이전 단계의 조건을 완화해 보세요.</div>}
      {compared.length > 0 && <CompareTable rows={compared} />}

      <div className="section-title">
        최종 후보 {finals.length}셀 <small>점수 = 통학·헬스장·진료과·상권·저녁활동·주말 조용함 균형</small>
      </div>
      <ul className="cand-list">
        {finals.slice(0, 12).map((e) => {
          const idx = pinned.indexOf(e.cell.id);
          return (
            <li key={e.cell.id} className={selectedId === e.cell.id ? 'on' : ''} onClick={() => selectCell(e.cell.id)}>
              <div className="cand-score">{e.score}</div>
              <div className="cand-body">
                <div>
                  <Swatch color={CELL_TYPES[e.cell.type].color} />
                  <b>{e.cell.dongName}</b> <span className="muted">{e.cell.id}</span>
                </div>
                <div className="cand-label">{e.label}</div>
                <div className="hint">
                  통학 {e.commute}분 · 헬스장 {e.nearestGym ? Math.round(e.nearestGym.dist) : '-'}m · 병원 {e.hospCount}곳/{e.depts.length}과
                </div>
              </div>
              <div className="cand-actions">
                <button className={`pin ${idx >= 0 ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); togglePin(e.cell.id); }}>
                  {idx >= 0 ? LETTERS[idx] : '+비교'}
                </button>
                <button className="link" onClick={(ev) => { ev.stopPropagation(); goStep(9, e.cell.id); }}>
                  매물 →
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {misses.length > 0 && (
        <>
          <div className="section-title">아깝게 탈락한 셀</div>
          <ul className="cand-list misses">
            {misses.map((e) => {
              const fail = e.checks.find((ch) => !ch.ok)!;
              return (
                <li key={e.cell.id} onClick={() => selectCell(e.cell.id)} className={selectedId === e.cell.id ? 'on' : ''}>
                  <div className="cand-body">
                    <div>
                      <Swatch color={CELL_TYPES[e.cell.type].color} />
                      <b>{e.cell.dongName}</b> <span className="muted">{e.label}</span>
                    </div>
                    <div className="reason">✕ {fail.step}. {fail.label} — {fail.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function CompareTable({ rows }: { rows: CellEval[] }) {
  const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
  const line = (label: string, f: (e: CellEval) => React.ReactNode) => (
    <tr>
      <th>{label}</th>
      {rows.map((e) => <td key={e.cell.id}>{f(e)}</td>)}
    </tr>
  );
  return (
    <div className="compare">
      <table>
        <thead>
          <tr>
            <th />
            {rows.map((e, i) => (
              <th key={e.cell.id} className={e === best ? 'best' : ''}>
                후보 {LETTERS[i]} {e === best && '★'}
                <div className="muted">{e.cell.dongName}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {line('셀 유형', (e) => CELL_TYPES[e.cell.type].label)}
          {line('생활상권', (e) => {
            const s = e.nearestByType.commercial ?? e.nearestByType.living;
            return s ? `${CELL_TYPES[s.cell.type].label} ${Math.round(s.dist / 10) * 10}m` : '-';
          })}
          {line('통학', (e) => `${e.commute}분`)}
          {line('헬스장', (e) => (e.nearestGym ? `${Math.round(e.nearestGym.dist)}m` : '-'))}
          {line('병원 / 진료과', (e) => `${e.hospCount}곳 / ${e.depts.length}종`)}
          {line('평일 야간', (e) => <LevelBadge level={e.cell.levels.wdNight} invert />)}
          {line('주변 상권 활동', (e) => <LevelBadge level={e.nbEvening} />)}
          {line('주말 야간 혼잡', (e) => <LevelBadge level={e.cell.levels.weNight} invert />)}
          {line('점수', (e) => <b>{e.score}</b>)}
        </tbody>
      </table>
      <p className="hint">{best.cell.dongName}: {best.summary}</p>
    </div>
  );
}

// ---------------------------------------------------------------- 9
type SortKey = 'monthly' | 'gym' | 'commute' | 'shop';
function Step9({ evals, listingCellId, setListingCellId, listings, ctx, cellById, activeListing, setActiveListing, pinned }: StepProps) {
  const [sort, setSort] = useState<SortKey>('monthly');
  const finals = evals.filter((e) => e.passedUpTo >= 7).sort((a, b) => b.score - a.score);
  const options = [...new Set([...pinned, ...finals.slice(0, 10).map((e) => e.cell.id), ...(listingCellId ? [listingCellId] : [])])];
  const cellId = listingCellId ?? options[0] ?? null;
  const rows = useMemo(() => {
    if (!cellId) return [];
    const r = listings.filter((l) => l.cellId === cellId).map((l) => evalListing(l, ctx, cellById));
    const key: Record<SortKey, (x: (typeof r)[number]) => number> = {
      monthly: (x) => x.listing.monthly,
      gym: (x) => x.gym ?? 1e9,
      commute: (x) => x.commute,
      shop: (x) => x.shop ?? 1e9,
    };
    return r.sort((a, b) => key[sort](a) - key[sort](b));
  }, [cellId, listings, ctx, cellById, sort]);

  const m = (d: number | null) => (d === null ? '-' : `${Math.round(d / 10) * 10}m`);
  return (
    <>
      <Field label="후보 셀">
        <select
          className="select"
          value={cellId ?? ''}
          onChange={(e) => setListingCellId(e.target.value)}
        >
          {options.map((id) => {
            const e = evals.find((x) => x.cell.id === id)!;
            return (
              <option key={id} value={id}>
                {e.cell.dongName} {id} — {e.label}
              </option>
            );
          })}
        </select>
      </Field>
      <Field label="정렬">
        <Segmented<SortKey>
          options={[
            { value: 'monthly', label: '월세' },
            { value: 'gym', label: '헬스장' },
            { value: 'shop', label: '생활상권' },
            { value: 'commute', label: '통학' },
          ]}
          value={sort}
          onChange={setSort}
        />
      </Field>
      {rows.length === 0 && <div className="empty">이 셀에는 등록된 매물이 없습니다.</div>}
      <ul className="listing-list">
        {rows.map((r) => (
          <li key={r.listing.id} className={activeListing === r.listing.id ? 'on' : ''} onClick={() => setActiveListing(r.listing.id)}>
            <div className="listing-head">
              <b>
                {r.listing.deposit.toLocaleString()}/{r.listing.monthly}
              </b>
              <span className="muted">관리비 {r.listing.maintenance}만 · {r.listing.kind} · {r.listing.areaM2}㎡ · {r.listing.floor}층 · {r.listing.builtYear}년</span>
            </div>
            <div className="listing-title">{r.listing.title}</div>
            <div className="listing-metrics">
              <span>헬스장 {m(r.gym)}</span>
              <span>생활상권 {m(r.shop)}</span>
              <span>병원 밀집 {m(r.medical)}</span>
              <span>통학 {r.commute}분</span>
              <span>
                주말 야간 <LevelBadge level={r.weNight as Level} invert />
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="hint">더미 매물입니다. 거리는 매물 좌표 기준으로 다시 계산했습니다.</div>
    </>
  );
}
