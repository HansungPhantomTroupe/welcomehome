import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Cell, DongStat, LatLng, Listing, Meta, Place } from '@shared/types';
import { CELL_TYPES } from '@shared/cellTypes';
import { walkMinToM } from '@shared/geo';
import { computeSpatial, DEFAULT_CRITERIA, evaluateCells, evalDongs, fastDist, type Criteria, type Ctx } from './analysis';
import { STEPS, StepPanel, type ColorMode } from './Steps';
import CellCard from './CellCard';
import KakaoMap, { hasKakaoKey } from './map/KakaoMap';
import SvgMap from './map/SvgMap';
import type { FitRequest, MapCircle, MapLayers, MapLine, MapMarker, MapPolygon } from './map/types';
import { Swatch } from './ui';
import MapStylePanel, { DENSITY, loadStyle, saveStyle, type MapStyle } from './MapStylePanel';
import FilterStack from './FilterStack';
import { describe, evalFilter, makeFilterCtx, runStack, type FilterDef } from './filters';
import type { Bounds } from './map/types';

interface Bootstrap {
  cells: Cell[];
  dongStats: DongStat[];
  places: Place[];
  listings: Listing[];
  meta: Meta;
  dongs: { features: { properties: { adm_cd2: string }; geometry: { type: string; coordinates: any } }[] };
}

const STACK_KEY = 'welcomehome.stack.v2'; // v1 은 하드코딩 기본 스택이 들어 있어 버림
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 저장 실패는 무시 */
  }
};

/** 색을 흰색 쪽으로 w 만큼 섞은 파스텔 톤 */
function tint(hex: string, w: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c + (255 - c) * w).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}


const HEAT = {
  blue: ['#e8eef8', '#bcd0ef', '#7fa6df', '#3f74c4', '#1d4c93'],
  orange: ['#fbeee4', '#f6cba7', '#ee9a5f', '#d9662b', '#a63c10'],
};

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/bootstrap')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then(setData)
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="fatal">데이터를 불러오지 못했습니다: {err}</div>;
  if (!data) return <div className="fatal">불러오는 중…</div>;
  return <Explorer data={data} />;
}

function Explorer({ data }: { data: Bootstrap }) {
  const [mode, setModeState] = useState<'wizard' | 'stack'>(() => (lsGet('welcomehome.mode') === 'stack' ? 'stack' : 'wizard'));
  const setMode = (m: 'wizard' | 'stack') => {
    setModeState(m);
    lsSet('welcomehome.mode', m);
  };
  const S = mode === 'stack';
  const [step, setStep] = useState(1);
  const [c, setC] = useState<Criteria>(DEFAULT_CRITERIA);
  const set = useCallback((p: Partial<Criteria>) => setC((prev) => ({ ...prev, ...p })), []);
  const [selectedId, selectCell] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [listingCellId, setListingCellId] = useState<string | null>(null);
  const [activeListing, setActiveListing] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [mapError, setMapError] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<'step' | 'cell'>('step');
  // 셀을 새로 고르면 왼쪽 패널을 '셀 정보' 탭으로, 선택이 풀리면 '단계 조건'으로
  useEffect(() => setPanelTab(selectedId ? 'cell' : 'step'), [selectedId]);
  const [mapStyle, setMapStyleState] = useState<MapStyle>(loadStyle);
  const setMapStyle = (st: MapStyle) => {
    setMapStyleState(st);
    saveStyle(st);
  };
  const cellAlpha = DENSITY[mapStyle.density];
  const pastel = mapStyle.tone === 'pastel';
  // 글자 셀 위로: 지도 배경 → 셀 색(반투명/합성) → 카카오 도로·글자 레이어 순으로 쌓는다 (카카오 지도에서만)
  const labelsTop = mapStyle.labels === 'top' && hasKakaoKey && !mapError;

  const dest = data.meta.destinations[c.destIdx] ?? data.meta.destinations[0];
  const ctx: Ctx = useMemo(() => ({ cells: data.cells, places: data.places, dest }), [data, dest]);
  const cellById = useMemo(() => new Map(data.cells.map((x) => [x.id, x])), [data]);

  const dongEvals = useMemo(() => evalDongs(data.dongStats, dest, c), [data, dest, c.maxCommute, c.minYouth, c.excludeLowEvening, c.excludeWeekendCrowded]);
  const dongPass = useMemo(() => new Set(dongEvals.filter((d) => d.pass).map((d) => d.dong.code)), [dongEvals]);
  const spatial = useMemo(() => computeSpatial(ctx, c.radius, c.medRadius), [ctx, c.radius, c.medRadius]);
  const evals = useMemo(() => evaluateCells(spatial, c, dongPass), [spatial, c, dongPass]);
  const byId = useMemo(() => new Map(evals.map((e) => [e.cell.id, e])), [evals]);

  const finals = useMemo(() => evals.filter((e) => e.passedUpTo >= 7).sort((a, b) => b.score - a.score), [evals]);

  // ---------- 필터 스택 ----------
  const [stack, setStackState] = useState<FilterDef[]>(() => {
    try {
      return JSON.parse(lsGet(STACK_KEY) ?? '[]');
    } catch {
      return [];
    }
  });
  const setStack = (st: FilterDef[]) => {
    setStackState(st);
    lsSet(STACK_KEY, JSON.stringify(st));
  };
  const [preview, setPreview] = useState<number | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const fctx = useMemo(() => makeFilterCtx(data.cells, data.places), [data]);
  // 화면에 보이는 셀만 걸러낸다 (주변 계산은 fctx 가 성북구 전체 데이터로 함)
  const viewPool = useMemo(
    () => (bounds ? data.cells.filter((x) => x.center.lat >= bounds.minLat && x.center.lat <= bounds.maxLat && x.center.lng >= bounds.minLng && x.center.lng <= bounds.maxLng) : data.cells),
    [data, bounds],
  );
  const stackRun = useMemo(() => runStack(stack, viewPool, fctx), [stack, viewPool, fctx]);
  const stackCounts = stackRun.stages.map((st) => st.survivors.length);
  const stackPool = useMemo(() => new Set(viewPool.map((x) => x.id)), [viewPool]);
  const stackFocus = useMemo(() => {
    const list = preview === null || preview >= stackRun.stages.length ? stackRun.final : stackRun.stages[preview].survivors;
    return new Set(list.map((x) => x.id));
  }, [stackRun, preview]);

  const goStep = (n: number, cellId?: string) => {
    if (n === 8 && pinned.length === 0) {
      // 비교가 의미 있도록 서로 400m 이상 떨어진 상위 후보 3개를 자동 선택
      const picks: typeof finals = [];
      for (const e of finals) {
        if (picks.length === 3) break;
        if (picks.every((p) => fastDist(p.cell.center, e.cell.center) >= 400)) picks.push(e);
      }
      setPinned(picks.map((e) => e.cell.id));
    }
    if (n === 9 && (cellId || !listingCellId)) {
      const pick = cellId ?? (selectedId && byId.get(selectedId)!.passedUpTo >= 7 ? selectedId : (pinned[0] ?? finals[0]?.cell.id ?? null));
      setListingCellId(pick);
      setActiveListing(null);
    }
    if (n === 9) selectCell(null); // 매물 마커가 가려지지 않도록 셀 카드는 닫는다
    if (n === 1) selectCell(null);
    setStep(n);
  };

  // ---------- 지도 레이어 ----------
  const candMin = step <= 2 ? 2 : step >= 8 ? 7 : step;
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  const layers: MapLayers = useMemo(() => {
    const polygons: MapPolygon[] = [];
    const circles: MapCircle[] = [];
    const lines: MapLine[] = [];
    const markers: MapMarker[] = [];

    // 행정동
    for (const f of data.dongs.features) {
      const code = f.properties.adm_cd2;
      const d = dongEvals.find((x) => x.dong.code === code);
      const rings: number[][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p: any) => p[0]);
      const paths = rings.map((r) => r.map(([lng, lat]) => ({ lat, lng })));
      if (!S && step === 1) {
        const on = c.selectedDongs.includes(code);
        polygons.push({
          id: `dong-${code}`,
          paths,
          stroke: '#25324a',
          strokeWeight: on ? 3 : 1.5,
          strokeOpacity: 0.9,
          fill: d?.pass ? '#3B7DD8' : '#9aa3ad',
          fillOpacity: d?.pass ? (on ? 0.5 : 0.22) : 0.28,
          zIndex: 1,
          onClick: d?.pass
            ? () => set({ selectedDongs: on ? c.selectedDongs.filter((x) => x !== code) : [...c.selectedDongs, code] })
            : undefined,
        });
        if (d) markers.push({ id: `dl-${code}`, pos: d.dong.center, kind: 'label', text: `${d.dong.name} ${d.commute}분` });
      } else {
        polygons.push({ id: `dong-${code}`, paths, stroke: '#25324a', strokeWeight: 2, strokeOpacity: 0.7, fill: '#ffffff', fillOpacity: 0.01, zIndex: 0 });
      }
    }

    // 셀 — 면은 테두리 없이 칠하고, 경계선은 '유형이 바뀌는 곳'과 '후보 영역 경계'에만 긋는다
    if (S || step >= 2) {
      const nbIds = new Set(!S && selected && step >= 4 ? selected.neighbors.map((n) => n.cell.id) : []);
      const heat = colorMode !== 'type';
      const group = (x: (typeof evals)[number]) => (heat && x.cell.type !== 'green' ? `L${x.cell.levels[colorMode as 'wdEvening']}` : x.cell.type);
      const isFocus = (x: (typeof evals)[number]) => (S ? stackFocus.has(x.cell.id) : step === 2 ? x.passedUpTo >= 2 : x.passedUpTo >= candMin);
      const isPool = (x: (typeof evals)[number]) => (S ? stackPool.has(x.cell.id) : x.passedUpTo >= 2);

      for (const e of evals) {
        const inPool = isPool(e);
        const isSel = e.cell.id === selectedId;
        const focus = isFocus(e);
        // 색 톤(원색/파스텔)과 합성 모드는 지도 위 '표시 설정' 패널에서 선택
        let fill = CELL_TYPES[e.cell.type].color;
        if (heat && e.cell.type !== 'green') fill = (colorMode === 'weNight' ? HEAT.orange : HEAT.blue)[e.cell.levels[colorMode] - 1];
        else if (pastel) fill = tint(fill, 0.55);
        let fillOpacity = focus ? 0.85 : inPool ? 0.3 : 0.12;
        if (nbIds.has(e.cell.id) && !focus) fillOpacity = 0.55;
        fillOpacity = Math.min(1, fillOpacity * cellAlpha);
        polygons.push({
          id: `cell-${e.cell.id}`,
          paths: [e.cell.corners],
          stroke: '#0b0f17',
          strokeWeight: isSel ? 3.5 : 0,
          strokeOpacity: isSel ? 1 : 0,
          fill,
          fillOpacity,
          zIndex: isSel ? 5 : 2,
          labelClip: labelsTop,
          onClick: () => selectCell(isSel ? null : e.cell.id),
        });
      }

      // 경계선: 격자 인덱스(SB{x}_{y})로 이웃을 찾아 동쪽·북쪽 변만 검사 (바깥 변은 남·서도)
      const byIdx = new Map(evals.map((x) => [x.cell.id, x]));
      const idx = (id: string) => id.slice(2).split('_').map(Number);
      // corners: 0 남서, 1 남동, 2 북동, 3 북서
      const EDGES: [dx: number, dy: number, a: number, b: number][] = [
        [1, 0, 1, 2],
        [0, 1, 2, 3],
        [-1, 0, 3, 0],
        [0, -1, 0, 1],
      ];
      for (const e of evals) {
        const [x, y] = idx(e.cell.id);
        for (const [dx, dy, a, b] of EDGES) {
          const n = byIdx.get(`SB${x + dx}_${y + dy}`);
          if (n && (dx < 0 || dy < 0)) continue; // 공유 변은 한 번만
          const fe = isFocus(e);
          const fn = n ? isFocus(n) : false;
          const path = [e.cell.corners[a], e.cell.corners[b]];
          if ((S || step >= 3) && fe !== fn) {
            lines.push({ id: `fb-${e.cell.id}-${a}`, path, color: '#111827', weight: 2.2, opacity: 0.85, zIndex: 4 });
          } else if (!n || group(n) !== group(e)) {
            const strong = fe || fn;
            lines.push({ id: `tb-${e.cell.id}-${a}`, path, color: '#1f2937', weight: strong ? 1.2 : 0.8, opacity: strong ? 0.55 : 0.25, zIndex: 3 });
          }
        }
      }
    }

    // 선택 셀 반경 (단계별 탐색 전용)
    if (!S && selected && step >= 4) {
      circles.push({ id: 'radius', center: selected.cell.center, radius: c.radius, stroke: '#1b2330', fill: '#1b2330', fillOpacity: 0.03, dashed: true });
      if (step === 5) circles.push({ id: 'gym', center: selected.cell.center, radius: walkMinToM(c.gymMaxMin), stroke: '#7b3fe4', fill: '#7b3fe4', fillOpacity: 0.05 });
      if (step === 6) circles.push({ id: 'med', center: selected.cell.center, radius: c.medRadius, stroke: '#0E9EA8', fill: '#0E9EA8', fillOpacity: 0.05 });
    }

    if (!S && step === 5)
      for (const p of data.places) if (p.cat === 'gym') markers.push({ id: `g-${p.id}`, pos: p, kind: 'gym', text: p.name });
    if (!S && step === 6 && selected)
      for (const p of data.places)
        if (p.cat === 'hosp' && (Math.hypot((p.lat - selected.cell.center.lat) * 111000, (p.lng - selected.cell.center.lng) * 88200) <= c.medRadius))
          markers.push({ id: `h-${p.id}`, pos: p, kind: 'hosp', text: `${p.name} (${p.dept})` });

    if (!S && step === 8)
      pinned.forEach((id, i) => {
        const e = byId.get(id);
        if (e) markers.push({ id: `pin-${id}`, pos: e.cell.center, kind: 'pin', text: 'ABC'[i], color: i === 0 ? '#1d4c93' : '#25324a', onClick: () => selectCell(id) });
      });

    if (!S && step === 9 && listingCellId)
      for (const l of data.listings)
        if (l.cellId === listingCellId)
          markers.push({ id: `l-${l.id}`, pos: l, kind: 'listing', text: `${l.deposit}/${l.monthly}`, active: l.id === activeListing, onClick: () => setActiveListing(l.id) });

    markers.push({ id: 'dest', pos: dest, kind: 'dest', text: dest.name });
    return { polygons, circles, lines, markers };
  }, [data, dongEvals, evals, step, c, selectedId, selected, colorMode, pinned, listingCellId, activeListing, dest, candMin, byId, set, cellAlpha, pastel, labelsTop, S, stackFocus, stackPool]);

  // ---------- 상세 지도: 선택 셀 테두리만 + 주변 마커 (색에 가리지 않은 원래 지도를 확대해서 봄) ----------
  const useKakao = hasKakaoKey && !mapError;
  const showCell = !!selected && (S || step >= 2);
  const detailLayers: MapLayers = useMemo(() => {
    if (!selected) return { polygons: [], circles: [], lines: [], markers: [] };
    const cc = selected.cell.center;
    const near = (p: LatLng) => fastDist(p, cc) <= 450;
    return {
      polygons: [
        {
          id: 'sel',
          paths: [selected.cell.corners],
          stroke: CELL_TYPES[selected.cell.type].color,
          strokeWeight: 4,
          strokeOpacity: 1,
          fill: '#ffffff',
          fillOpacity: 0,
        },
      ],
      circles: [],
      lines: [],
      markers: layers.markers.filter((m) => (m.kind === 'gym' || m.kind === 'hosp' || m.kind === 'listing' || m.kind === 'dest') && near(m.pos)),
    };
  }, [selected, layers.markers]);
  const detailFit: FitRequest | null = selected ? { key: `d-${selected.cell.id}`, points: selected.cell.corners } : null;

  // ---------- 화면 맞춤 ----------
  const poolKey = c.selectedDongs.length ? c.selectedDongs.join(',') : [...dongPass].join(',');
  const fit: FitRequest | null = useMemo(() => {
    // 필터 스택은 화면 범위가 곧 계산 범위라 처음 한 번만 성북구 전체에 맞춘다
    if (S) return { key: 'stack-all', points: data.cells.map((x) => x.center) };
    if (step === 1) return { key: `all-${c.destIdx}`, points: [...data.cells.map((x) => x.center), dest] };
    if (step === 9 && listingCellId) {
      const cc = cellById.get(listingCellId)!.center;
      const r = c.radius / 111000;
      const pts: LatLng[] = [
        { lat: cc.lat - r, lng: cc.lng - r * 1.26 },
        { lat: cc.lat + r, lng: cc.lng + r * 1.26 },
      ];
      return { key: `cell-${listingCellId}`, points: pts };
    }
    const pool = evals.filter((e) => e.passedUpTo >= 2);
    return { key: `pool-${poolKey}`, points: pool.flatMap((e) => e.cell.corners) };
  }, [S, step === 1, step === 9, listingCellId, poolKey, c.destIdx]);

  // ---------- 진행 현황 ----------
  const counter = (() => {
    if (step === 1) return `1차 후보 동 ${dongPass.size}개`;
    if (step === 2) return `후보 동 안의 셀 ${evals.filter((e) => e.passedUpTo >= 2).length}개`;
    if (step <= 7) return `남은 후보 셀 ${evals.filter((e) => e.passedUpTo >= step).length}개`;
    if (step === 8) return `최종 후보 셀 ${finals.length}개`;
    return `매물 ${data.listings.filter((l) => l.cellId === listingCellId).length}건`;
  })();
  const funnel = [2, 3, 4, 5, 6, 7].map((s) => evals.filter((e) => e.passedUpTo >= s).length);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⌂</span>
          <div>
            <b>생활권 탐색</b>
            <small>환영여단 · 성북구 프로토타입</small>
          </div>
        </div>
        <div className="mode-switch">
          <button className={!S ? 'on' : ''} onClick={() => setMode('wizard')}>단계별 탐색</button>
          <button className={S ? 'on' : ''} onClick={() => setMode('stack')}>필터 스택</button>
        </div>
        <div className="sources">
          <span className={`src ${data.meta.source.places === 'kakao' ? 'real' : 'mock'}`}>시설: {data.meta.source.places === 'kakao' ? '카카오 로컬' : 'mock'}</span>
          <span className="src mock">유동인구: 더미 (LG U+ 명세)</span>
          <span className="src mock">매물: 더미</span>
        </div>
      </header>

      <div className="body">
        <aside className="panel">
          {S ? (
            <div className="step-head">
              <small>FILTER STACK</small>
              <h2>필터 스택</h2>
              <p>필터를 쌓아 위에서부터 차례로 걸러냅니다</p>
            </div>
          ) : (
          <>
          <nav className="stepper">
            {STEPS.map((s) => (
              <button key={s.n} className={`${s.n === step ? 'on' : ''} ${s.n < step ? 'done' : ''}`} onClick={() => goStep(s.n)} title={s.title}>
                <span>{s.n}</span>
              </button>
            ))}
          </nav>
          <div className="step-head">
            <small>STEP {step}</small>
            <h2>{STEPS[step - 1].title}</h2>
            <p>{STEPS[step - 1].sub}</p>
          </div>
          <div className="funnel" title="단계별 남은 셀 수">
            {funnel.map((n, i) => (
              <div key={i} className={i + 2 === step ? 'on' : ''}>
                <i style={{ height: `${(n / Math.max(funnel[0], 1)) * 100}%` }} />
                <span>{n}</span>
              </div>
            ))}
          </div>
          </>
          )}
          {showCell && (
            <div className="panel-tabs">
              <button className={panelTab === 'step' ? 'on' : ''} onClick={() => setPanelTab('step')}>{S ? '필터' : '단계 조건'}</button>
              <button className={panelTab === 'cell' ? 'on' : ''} onClick={() => setPanelTab('cell')}>셀 정보</button>
            </div>
          )}
          {showCell && panelTab === 'cell' ? (
            <CellCard
              e={selected!}
              step={S ? 2 : step}
              radius={c.radius}
              onClose={() => selectCell(null)}
              extra={
                S ? (
                  <>
                    <div className="sub">필터 통과 여부</div>
                    <ul className="checks">
                      {stack.map((f, i) => {
                        const r = evalFilter(f, selected!.cell, fctx);
                        return (
                          <li key={f.id} className={!f.enabled ? 'off' : r.ok ? 'pass' : 'fail'}>
                            <span>{!f.enabled ? '–' : r.ok ? '✓' : '✕'}</span>
                            <b>
                              {i + 1}. {describe(f)}
                            </b>
                            <small>{r.detail}</small>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null
              }
            />
          ) : S ? (
            <div className="step-body">
              <FilterStack
                stack={stack}
                setStack={(st) => {
                  setStack(st);
                  setPreview(null);
                }}
                poolCount={viewPool.length}
                counts={stackCounts}
                final={stackRun.final}
                preview={preview}
                setPreview={setPreview}
                dongs={data.dongStats.map((d) => ({ code: d.code, name: d.name }))}
                destinations={data.meta.destinations}
                selectedId={selectedId}
                selectCell={selectCell}
              />
            </div>
          ) : (
          <div className="step-body">
            <StepPanel
              step={step}
              c={c}
              set={set}
              meta={data.meta}
              dongEvals={dongEvals}
              evals={evals}
              byId={byId}
              selectedId={selectedId}
              selectCell={selectCell}
              pinned={pinned}
              setPinned={setPinned}
              listingCellId={listingCellId}
              setListingCellId={(id) => {
                setListingCellId(id);
                setActiveListing(null);
              }}
              activeListing={activeListing}
              setActiveListing={setActiveListing}
              listings={data.listings}
              ctx={ctx}
              cellById={cellById}
              colorMode={colorMode}
              setColorMode={setColorMode}
              goStep={goStep}
            />
          </div>
          )}
          {!S && (
          <footer className="step-foot">
            <span>{counter}</span>
            <div>
              <button className="btn ghost" disabled={step === 1} onClick={() => goStep(step - 1)}>이전</button>
              <button className="btn" disabled={step === 9} onClick={() => goStep(step + 1)}>다음</button>
            </div>
          </footer>
          )}
        </aside>

        <div className="maps">
          <main className="map-wrap">
            {useKakao ? <KakaoMap layers={layers} fit={fit} blend={mapStyle.blend} labelsOnTop={labelsTop} onBounds={setBounds} onError={(e) => setMapError(e.message)} /> : <SvgMap layers={layers} fit={fit} blend={mapStyle.blend} onBounds={setBounds} />}
            {(S || step >= 2) && <MapStylePanel value={mapStyle} onChange={setMapStyle} />}
            {mapError && <div className="map-error">{mapError} — 간이 지도로 표시합니다.</div>}
            {(S || step >= 2) && (
              <div className="legend">
                {colorMode === 'type' ? (
                  Object.entries(CELL_TYPES).map(([k, t]) => (
                    <span key={k}>
                      <Swatch color={t.color} />
                      {t.label}
                    </span>
                  ))
                ) : (
                  <span className="heat">
                    낮음
                    {(colorMode === 'weNight' ? HEAT.orange : HEAT.blue).map((h) => <i key={h} style={{ background: h }} />)}
                    높음
                  </span>
                )}
              </div>
            )}
          </main>

          {(S || step >= 2) && (
            <main className="map-wrap detail">
              {useKakao ? <KakaoMap layers={detailLayers} fit={detailFit} onError={() => {}} /> : <SvgMap layers={detailLayers} fit={detailFit} />}
              <div className="detail-badge">{selected ? `확대 · ${selected.cell.dongName} ${selected.cell.id}` : '확대 지도'}</div>
              {!selected && <div className="detail-empty">왼쪽 지도에서 격자를 클릭하면 이곳에 해당 격자가 확대되어 표시됩니다</div>}
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
