import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CELL_SIZE } from '@shared/cellTypes';
import type { Cell, DongStat, LatLng, Meta, Place } from '@shared/types';
import { classifyAll, condSubject, condUnit, defaultCategories, makeMetricEval, type Category, type Cond } from './classify';
import { describe, evalFilter, runFilters, type FilterCtx, type FilterDef, type Names } from './filters';
import type { ExplainCtx } from './CondBuilder';
import { attachNearDist, makePlaceIndex } from './placeIndex';
import KakaoMap, { hasKakaoKey } from './map/KakaoMap';
import SvgMap from './map/SvgMap';
import type { Bounds, FitRequest, MapLayers, MapLine, MapPolygon } from './map/types';
import CategoriesSection from './CategoriesSection';
import FilterSection from './FilterSection';
import CellSection from './CellSection';
import DebugRank from './DebugRank';
import { layerKey, layerText, type ValueLayer } from './MonthlyPanel';
import Tutorial, { type TourStep } from './Tutorial';

interface Bootstrap {
  cells: Cell[];
  places: Place[];
  dongStats: DongStat[];
  meta: Meta;
}

// ---------------------------------------------------------------- 저장 (브라우저별 편의 설정)
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

/** 색을 흰색 쪽으로 w 만큼 섞은 파스텔 톤 */
function tint(hex: string, w: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c + (255 - c) * w).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** 셀 한 변이 화면에서 이 px 이상일 때부터 격자를 보여준다 */
const GRID_MIN_PX = 22;
const CELL_M = CELL_SIZE;
const ACCENT = '#1d4c93';
/** 조건에 맞는 구역 — 형광펜처럼 칠한다 (테두리만으로는 눈에 안 들어옴) */
const PASS = '#facc15';
/** 색 세기 5단계 (낮음 → 높음) */
/** 색 세기 5단계 — 가장 옅은 칸도 지도 위에서 보이도록 노랑부터 */
const HEAT_RAMP = ['#fde68a', '#fbbf24', '#f59e0b', '#ea580c', '#b91c1c'];

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/bootstrap')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then((d) => setData(attachNearDist(d)))
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="fatal">데이터를 불러오지 못했습니다: {err}</div>;
  if (!data) return <div className="fatal">불러오는 중…</div>;
  return <WithSpread data={data} />;
}

/** 튀는 값 퍼뜨림 켜기/끄기 — 끄면 원본(popRaw)으로 인원·시간대 합계를 다시 계산 */
function WithSpread({ data }: { data: Bootstrap }) {
  const [spread, setSpread] = usePersisted<boolean>('wh.spread', () => true);
  const view = useMemo(() => {
    if (spread) return data;
    const cells = data.cells.map((c) => {
      if (!c.popRaw) return c;
      const pop = c.popRaw;
      const slots = [0, 1].map((d) => [0, 1, 2, 3].map((t) => pop[(d * 4 + t) * 3] + pop[(d * 4 + t) * 3 + 1] + pop[(d * 4 + t) * 3 + 2])) as Cell['slots'];
      return { ...c, pop, slots, total: +(slots.flat().reduce((a, b) => a + b, 0) / 8).toFixed(1) };
    });
    return { ...data, cells };
  }, [data, spread]);
  return <Explorer data={view} spread={spread} setSpread={setSpread} />;
}

function Explorer({ data, spread, setSpread }: { data: Bootstrap; spread: boolean; setSpread: (v: boolean) => void }) {
  // ---------- 레이아웃 ----------
  const [side, setSide] = usePersisted<'left' | 'right'>('wh.side', () => 'left');
  const [width, setWidth] = usePersisted<number>('wh.width', () => 380);
  const dragging = useRef(false);
  const onResize = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const w = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
    setWidth(Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.6)));
  };

  // ---------- 지도 상태 ----------
  const [mapError, setMapError] = useState<string | null>(null);
  const [mPerPx, setMPerPx] = useState(20);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  // 고른 구역 표에서 누른 월별 값 — 지도 위 모든 칸에 숫자로
  const [valueLayer, setValueLayer] = useState<ValueLayer | null>(null);
  const [layerVals, setLayerVals] = useState<Record<string, number | null> | null>(null);
  useEffect(() => {
    if (!valueLayer) return setLayerVals(null);
    const q = new URLSearchParams({ month: valueLayer.month, cols: valueLayer.cols.join(','), day: String(valueLayer.day), slot: String(valueLayer.slot) });
    let alive = true;
    fetch(`/api/monthly-layer?${q}`)
      .then((r) => r.json())
      .then((v) => alive && setLayerVals(v))
      .catch(() => alive && setLayerVals(null));
    return () => {
      alive = false;
    };
  }, [valueLayer && layerKey(valueLayer)]);
  const gridVisible = CELL_M / mPerPx >= GRID_MIN_PX;
  const [selectedId, selectCell] = useState<string | null>(null);
  // 패널 탭: 필터 · 종류 · 구역 — 구역을 골라도 탭은 그대로 (구역 탭에 표시만)
  const [tab, setTab] = usePersisted<'filter' | 'type' | 'cell' | 'rank'>('wh.tab', () => 'filter');

  // ---------- 공통 계산 ----------
  const idx = useMemo(() => makePlaceIndex(data.places), [data]);
  const me = useMemo(() => makeMetricEval(data.cells), [data]);
  // 구역을 사람이 아는 이름으로: 400m 안 지하철역이 있으면 "○○역 주변", 없으면 동 이름
  const placeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data.cells) {
      const st = idx.nearest(c.center, 'subway');
      m.set(c.id, st && st.dist <= 400 ? `${st.place.name.split(' ')[0]} 주변` : c.dongName);
    }
    return m;
  }, [data, idx]);
  // 이 주변: 지도 화면 + 사방으로 30% 여유 (분포 표시용)
  const near = useMemo(() => {
    if (!bounds) return data.cells;
    const dLat = (bounds.maxLat - bounds.minLat) * 0.3;
    const dLng = (bounds.maxLng - bounds.minLng) * 0.3;
    const list = data.cells.filter(
      (c) => c.center.lat >= bounds.minLat - dLat && c.center.lat <= bounds.maxLat + dLat && c.center.lng >= bounds.minLng - dLng && c.center.lng <= bounds.maxLng + dLng,
    );
    return list.length ? list : data.cells;
  }, [data, bounds]);
  const selected = selectedId ? data.cells.find((c) => c.id === selectedId) ?? null : null;
  // 지도 색 세기: 편집 중인 조건 하나의 값을 지도 전체에 칠한다
  const [heat, setHeat] = useState<{ id: string; cond: Cond } | null>(null);
  const clearHeat = useCallback((id: string) => setHeat((h) => (h?.id === id ? null : h)), []);
  // 편집 중 바뀐 조건을 따라감 — 렌더 시점의 heatId 를 보면 자동 숫자 지정 직후처럼 한 박자 늦은 조건이 남는다
  const syncHeat = useCallback((id: string, cond: Cond) => setHeat((h) => (h?.id === id ? { id, cond } : h)), []);
  // 지금 보는 지역 크기 (화면 + 사방 30%) — 간단 모드 설명 문장용
  const areaText = useMemo(() => {
    if (!bounds) return '전체 구역';
    const w = (bounds.maxLng - bounds.minLng) * 1.6 * 88.2;
    const h = (bounds.maxLat - bounds.minLat) * 1.6 * 111;
    const km = (v: number) => (v >= 10 ? Math.round(v) : v.toFixed(1));
    return `가로 ${km(w)}km × 세로 ${km(h)}km`;
  }, [bounds]);
  const x: ExplainCtx = useMemo(
    () => ({ cells: data.cells, near, me, place: (c) => placeName.get(c.id) ?? c.dongName, selected, areaText, heatId: heat?.id ?? null, setHeat, clearHeat, syncHeat }),
    [data, near, me, placeName, selected, areaText, heat?.id, clearHeat, syncHeat],
  );

  // ---------- 주거지 종류 (분류) ----------
  const [typesOn, setTypesOn] = usePersisted<boolean>('wh.typesOn', () => false);
  const [hiddenList, setHiddenList] = usePersisted<string[]>('wh.hiddenCats', () => []);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const [cats, setCats] = usePersisted<Category[]>('wh.categories.v7', defaultCategories);
  const cls = useMemo(() => classifyAll(data.cells, me, cats), [data, me, cats]);
  const catById = useMemo(() => new Map(cats.map((x) => [x.id, x])), [cats]);

  // ---------- 필터 (분류와 별개) ----------
  const [filtersOn, setFiltersOn] = usePersisted<boolean>('wh.filtersOn', () => true);
  const [stack, setStackRaw] = usePersisted<FilterDef[]>('wh.filterStack.v7', () => []);
  // 핀: 위에서 몇 번째 조건까지 적용할지 (null = 끝까지) / 단독: 이 조건 하나만 적용
  const [pin, setPin] = useState<number | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const setStack = (s: FilterDef[]) => {
    setStackRaw(s);
    if (pin !== null && pin > s.length) setPin(null);
    if (solo && !s.some((f) => f.id === solo)) setSolo(null);
  };
  const fctx: FilterCtx = useMemo(() => ({ me, catOf: (id) => cls.byId.get(id)?.cat ?? null }), [me, cls]);
  const run = useMemo(() => runFilters(stack, data.cells, fctx), [stack, data, fctx]);
  const pinIdx = pin === null ? stack.length : Math.min(pin, stack.length);
  const soloFilter = solo ? stack.find((f) => f.id === solo) ?? null : null;
  const soloList = useMemo(() => (soloFilter ? data.cells.filter((c) => evalFilter(soloFilter, c, fctx).ok) : null), [soloFilter, data, fctx]);
  const passList = soloList ?? (pinIdx === 0 ? data.cells : run.stages[pinIdx - 1]);
  const pass = useMemo(() => new Set(passList.map((x) => x.id)), [passList]);
  const filterActive = filtersOn && (!!soloFilter || stack.slice(0, pinIdx).some((f) => f.enabled));
  const inView = (c: Cell) => !bounds || (c.center.lat >= bounds.minLat && c.center.lat <= bounds.maxLat && c.center.lng >= bounds.minLng && c.center.lng <= bounds.maxLng);
  const names: Names = useMemo(
    () => ({ cat: (id) => catById.get(id)?.label ?? '(삭제된 종류)', dong: (code) => data.dongStats.find((d) => d.code === code)?.name ?? code }),
    [catById, data],
  );

  // ---------- 단축키: T 종류, F 필터, Esc 선택 해제 (입력 중엔 무시) ----------
  const keys = useRef({ typesOn, filtersOn });
  keys.current = { typesOn, filtersOn };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 't' || k === 'ㅅ') setTypesOn(!keys.current.typesOn);
      if (k === 'f' || k === 'ㄹ') setFiltersOn(!keys.current.filtersOn);
      if (e.key === 'Escape') selectCell(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- 지도 레이어 ----------
  // 축소: 아무것도 없음(필터를 켰으면 통과 셀만) / 확대: 연한 격자 + 클릭 / 종류: 파스텔을 곱하기 합성
  // 색 세기 레이어: 값의 전체 구역 내 순위를 5단계로 (연한 노랑 → 진한 빨강)
  const heatInfo = useMemo(() => {
    if (!heat) return null;
    // 칠하는 칸: 필터 조건을 편집 중이면 지금 필터 결과(이것만·핀 반영), 동네 성격 조건이면 그 조건에 맞는 칸.
    // 색 단계는 칠하는 칸들 사이의 순위로 — 안 맞는 칸이 많아도 지도가 지저분해지지 않게
    const th = me.threshold(heat.cond);
    const fromFilter = filterActive && stack.some((f) => f.id === heat.id);
    const passCells = fromFilter ? passList : data.cells.filter((c) => me.test(c, heat.cond, th));
    const passIds = new Set(passCells.map((c) => c.id));
    const vals = passCells.map((c) => me.value(c, heat.cond));
    const sorted = [...vals].sort((a, b) => a - b);
    const flat = sorted.length === 0 || sorted[0] === sorted[sorted.length - 1];
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
    // 거리 조건은 가까울수록 진하게
    const closer = heat.cond.src === 'poi' && heat.cond.by === 'dist';
    const level = new Map(passCells.map((c, i) => [c.id, flat ? 2 : Math.min(4, Math.floor((closer ? 1 - rank(vals[i]) : rank(vals[i])) * 5))]));
    return { level, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, passIds, closer };
  }, [heat, data, me, filterActive, stack, passList]);

  const allIds = useMemo(() => new Set(data.cells.map((c) => c.id)), [data]);
  const baseLayers: MapLayers = useMemo(() => {
    const polygons: MapPolygon[] = [];
    const lines: MapLine[] = [];
    // 통과 구역 덩어리의 바깥 테두리 — 칸마다 긋지 않아 영역으로 읽힌다
    const outline = (ids: Set<string>, cells: Cell[], width: number, color = ACCENT, opacity = 1, prefix = 'ol') => {
      const ix = (id: string) => id.slice(2).split('_').map(Number);
      // corners: 0 남서, 1 남동, 2 북동, 3 북서 / [dx, dy, 변의 꼭짓점 a, b]
      const EDGES: [number, number, number, number][] = [
        [1, 0, 1, 2],
        [0, 1, 2, 3],
        [-1, 0, 3, 0],
        [0, -1, 0, 1],
      ];
      for (const cell of cells) {
        const [cx, cy] = ix(cell.id);
        for (const [dx, dy, ea, eb] of EDGES) {
          if (ids.has(`SB${cx + dx}_${cy + dy}`)) continue;
          lines.push({ id: `${prefix}-${cell.id}-${ea}`, path: [cell.corners[ea], cell.corners[eb]], color, weight: width, opacity, zIndex: prefix === 'ol' ? 4 : 2 });
        }
      }
    };

    if (heatInfo) {
      for (const cell of data.cells) {
        const isSel = cell.id === selectedId;
        polygons.push({
          id: cell.id,
          paths: [cell.corners],
          stroke: isSel ? '#0b0f17' : '#334155',
          strokeWeight: isSel ? 3 : gridVisible ? 1 : 0,
          strokeOpacity: isSel ? 1 : 0.18,
          fill: HEAT_RAMP[heatInfo.level.get(cell.id) ?? 0],
          fillOpacity: heatInfo.passIds.has(cell.id) ? 0.8 : 0.01, // 안 맞는 칸은 칠하지 않음 (클릭만 받음)
          zIndex: isSel ? 5 : 1,
          onClick: () => selectCell(isSel ? null : cell.id),
        });
      }
      if (!gridVisible) outline(allIds, data.cells, 2, '#475569', 0.7, 'sb');
      return { polygons, circles: [], lines, markers: [] };
    }
    for (const cell of data.cells) {
      const isSel = cell.id === selectedId;
      const passed = filterActive && pass.has(cell.id);
      if (!gridVisible && !isSel && !passed) continue;
      const cat = catById.get(cls.byId.get(cell.id)?.cat ?? '');
      const colored = typesOn && cat && !hidden.has(cat.id);
      let fill = '#000000';
      let fillOpacity = 0.01; // 보이지 않지만 클릭은 받도록
      if (colored) [fill, fillOpacity] = [tint(cat.color, 0.5), 0.9];
      if (filterActive) {
        // 맞는 구역은 노랗게 칠하고, 걸러진 구역은 살짝 눌러 둔다
        if (passed) [fill, fillOpacity] = [PASS, colored ? 0.75 : 0.6];
        else [fill, fillOpacity] = ['#0f172a', 0.28];
      }
      polygons.push({
        id: cell.id,
        paths: [cell.corners],
        stroke: isSel ? '#0b0f17' : '#334155',
        strokeWeight: isSel ? 3 : passed ? 0 : 1,
        strokeOpacity: isSel ? 1 : passed ? 0 : 0.22,
        fill,
        fillOpacity,
        zIndex: isSel ? 5 : passed ? 3 : 1,
        onClick: () => selectCell(isSel ? null : cell.id),
      });
    }

    // 멀리서 볼 때: 격자가 숨어 있으니 탐색 지역 경계를 그어 '여기가 탐색 범위' 임을 보여준다
    if (!gridVisible) outline(allIds, data.cells, 2, '#475569', 0.7, 'sb');
    return { polygons, circles: [], lines, markers: [] };
  }, [data, allIds, gridVisible, selectedId, typesOn, hidden, cls, catById, filterActive, pass, passList, heatInfo]);

  // fitRun 이 바뀌면 처음 화면(탐색 지역 전체)으로 다시 맞춤 — 튜토리얼 시작 때
  const [fitRun, setFitRun] = useState(0);
  // focus: 튜토리얼이 보여줄 곳으로 확대 (없으면 탐색 지역 전체)
  const [focus, setFocus] = useState<{ key: string; points: LatLng[] } | null>(null);
  // 튜토리얼 '칸 하나 = 50m × 50m' 단계: 고른 칸 테두리와 가로·세로 길이 표시
  const [tourStepId, setTourStepId] = useState<string | undefined>(undefined);
  const [tourCellId, setTourCellId] = useState<string | null>(null);
  const tourCell = tourStepId === 'cellSize' && tourCellId ? data.cells.find((c) => c.id === tourCellId) ?? null : null;
  // 월별 값 숫자: 화면 안 칸만, 너무 많으면(멀리서 볼 때) 생략
  const VALUE_MAX = 600;
  const valueCells = useMemo(() => {
    if (!layerVals || !bounds || !gridVisible) return null;
    const inView = data.cells.filter((c) => c.center.lat >= bounds.minLat && c.center.lat <= bounds.maxLat && c.center.lng >= bounds.minLng && c.center.lng <= bounds.maxLng);
    return inView.length > VALUE_MAX ? 'many' : inView;
  }, [layerVals, bounds, gridVisible, data]);
  const layersWithValues: MapLayers = useMemo(() => {
    if (!layerVals || !Array.isArray(valueCells)) return baseLayers;
    const fmtVal = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v >= 10 ? String(Math.round(v)) : v.toFixed(1));
    const markers = valueCells.flatMap((c) => {
      const v = layerVals[c.id];
      return v === null || v === undefined ? [] : [{ id: `v-${c.id}`, pos: c.center, kind: 'value' as const, text: fmtVal(v), active: c.id === selectedId, onClick: () => selectCell(c.id) }];
    });
    return { ...baseLayers, markers: [...baseLayers.markers, ...markers] };
  }, [baseLayers, layerVals, valueCells, selectedId]);
  const layers: MapLayers = useMemo(() => {
    const baseLayers = layersWithValues;
    if (!tourCell) return baseLayers;
    const [sw, se, ne, nw] = tourCell.corners; // 남서 · 남동 · 북동 · 북서
    const mid = (a: LatLng, b: LatLng) => ({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
    const add = (p: LatLng, v: LatLng, k: number) => ({ lat: p.lat + v.lat * k, lng: p.lng + v.lng * k });
    // 치수선: 변 바로 바깥에 나란히 |——50m——| (변에서 칸 크기의 14% 띄움, 양 끝 눈금은 변까지 이어짐)
    const down = { lat: sw.lat - nw.lat, lng: sw.lng - nw.lng }; // 남쪽으로 한 칸
    const right = { lat: se.lat - sw.lat, lng: se.lng - sw.lng }; // 동쪽으로 한 칸
    const GAP = 0.14;
    const TICK = 0.06;
    const line = (id: string, path: LatLng[], weight: number): MapLine => ({ id: `tc-${id}`, path, color: '#d97706', weight, opacity: 1, zIndex: 8 });
    const dim = (id: string, a: LatLng, b: LatLng, out: LatLng) => {
      const [a2, b2] = [add(a, out, GAP), add(b, out, GAP)];
      return {
        lines: [line(`${id}-d`, [a2, b2], 2), line(`${id}-ta`, [add(a, out, 0.03), add(a, out, GAP + TICK)], 2), line(`${id}-tb`, [add(b, out, 0.03), add(b, out, GAP + TICK)], 2)],
        label: { id: `tc-${id}-l`, pos: mid(a2, b2), kind: 'label' as const, text: `${CELL_SIZE}m`, active: true },
      };
    };
    const w = dim('w', sw, se, down);
    const h = dim('h', se, ne, right);
    const edge = (id: string, a: LatLng, b: LatLng) => line(id, [a, b], 4);
    return {
      ...baseLayers,
      polygons: [
        ...baseLayers.polygons,
        { id: 'tour-cell', paths: [tourCell.corners], stroke: '#f59e0b', strokeWeight: 0, strokeOpacity: 0, fill: '#fbbf24', fillOpacity: 0.25, zIndex: 7, onClick: () => selectCell(tourCell.id) },
      ],
      lines: [...baseLayers.lines, edge('s', sw, se), edge('e', se, ne), edge('n', ne, nw), edge('w', nw, sw), ...w.lines, ...h.lines],
      markers: [...baseLayers.markers, w.label, h.label],
    };
  }, [layersWithValues, tourCell]);

  const fit: FitRequest = useMemo(
    () => focus ?? { key: `init-${fitRun}`, points: data.cells.flatMap((x) => x.corners), allowCrop: 0.1 },
    [data, fitRun, focus],
  );
  const unclassified = data.cells.length - [...cls.counts.values()].reduce((s, x) => s + x, 0);

  const mapProps = { layers, fit, blend: 'multiply', onScale: setMPerPx, onBounds: setBounds };

  // ---------- 튜토리얼: 처음 접속하면 자동, [?] 로 다시 ----------
  const [tourDone, setTourDone] = usePersisted<boolean>('wh.tourDone', () => false);
  const [tourOpen, setTourOpen] = useState(false);
  // 튜토리얼은 누가 언제 켜든 같은 상태에서 시작: 조건 없음 · 선택 없음 · 색 끔 · 탐색 지역 전체 화면.
  // 쓰던 조건과 화면 설정은 잠깐 맡아 두었다가 튜토리얼을 닫으면 그대로 돌려놓는다 (튜토리얼에서 만든 조건은 연습용)
  const tourBackup = useRef<{ stack: FilterDef[]; typesOn: boolean; filtersOn: boolean; tab: typeof tab; cats: Category[] } | null>(null);
  // 튜토리얼 시작 때 있던 동네 성격 — 이것 말고 새로 생긴 게 '방금 만든 성격'
  const tourCatBase = useRef<Set<string>>(new Set());
  const startTour = () => {
    tourBackup.current ??= { stack, typesOn, filtersOn, tab, cats };
    tourCatBase.current = new Set(cats.map((c) => c.id));
    setStackRaw([]);
    setPin(null);
    setSolo(null);
    selectCell(null);
    setHeat(null);
    setTypesOn(false);
    setFiltersOn(true);
    setTab('filter');
    setFocus(null);
    setFitRun((n) => n + 1);
    setTourOpen(true);
  };
  const endTour = () => {
    const b = tourBackup.current;
    tourBackup.current = null;
    if (b) {
      setStackRaw(b.stack);
      setPin(null);
      setSolo(null);
      setHeat(null);
      setTypesOn(b.typesOn);
      setFiltersOn(b.filtersOn);
      setTab(b.tab);
      setCats(b.cats);
    }
    setTourOpen(false);
    setTourDone(true);
  };
  useEffect(() => {
    if (!tourDone) startTour(); // 처음 접속하면 자동으로
  }, []);
  // 단계마다 '해 볼 것' 이 실제로 됐는지 지금 상태로 확인
  const popFilter = stack.find((f) => f.type === 'cell' && f.pred.kind === 'metric' && f.pred.cond.src === 'pop');
  const popCond = popFilter?.type === 'cell' && popFilter.pred.kind === 'metric' ? popFilter.pred.cond : null;
  // 가게·시설 조건 중 '술집이 없는 곳' (술집만, 0곳 이하)
  const hasNoBarFilter = stack.some(
    (f) => f.type === 'cell' && f.pred.kind === 'metric' && f.pred.cond.src === 'poi' && f.pred.cond.cats.join() === 'bar' && f.pred.cond.op === 'lte' && f.pred.cond.value === 0,
  );
  const newCat = cats.find((c) => !tourCatBase.current.has(c.id)) ?? null;
  const usesNewCat = !!newCat && stack.some((f) => f.type === 'cell' && f.pred.kind === 'category' && f.pred.ids.includes(newCat.id));
  const tourSteps: TourStep[] = [
    {
      title: '살 동네, 지도에서 같이 찾아봐요',
      body: <>직접 몇 번 눌러 보면 금방 익숙해져요. 2분이면 돼요.</>,
    },
    {
      target: '.map-wrap:not(.detail)',
      title: '지도를 확대해 보세요',
      body: <>확대하면 지도 위에 바둑판 같은 칸이 나타나요.</>,
      task: <>마우스 휠이나 오른쪽 + 버튼으로 <b>칸이 보일 때까지</b> 확대하기</>,
      done: () => gridVisible,
    },
    {
      id: 'cellSize',
      target: '.map-wrap:not(.detail)',
      onEnter: () => {
        // 고른 구역이 있으면 풀고 (노란 칸과 헷갈리지 않게), 지금 화면 한가운데 칸을 골라 그 칸으로 확대
        selectCell(null);
        const mid = bounds ? { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 } : data.cells[0].center;
        let best = data.cells[0];
        let bd = Infinity;
        for (const c of data.cells) {
          const d = (c.center.lat - mid.lat) ** 2 + ((c.center.lng - mid.lng) * 0.8) ** 2;
          if (d < bd) [best, bd] = [c, d];
        }
        setTourCellId(best.id);
        const [sw, , ne] = best.corners;
        const [dLat, dLng] = [ne.lat - sw.lat, ne.lng - sw.lng];
        const around = [-1.1, 1.1].flatMap((a) => [-1.1, 1.1].map((b) => ({ lat: best.center.lat + a * dLat, lng: best.center.lng + b * dLng })));
        setFocus({ key: `cell-${best.id}`, points: around });
      },
      title: `${CELL_SIZE}m × ${CELL_SIZE}m 칸 단위로 찾아요`,
      body: (
        <>
          지도는 이런 칸으로 나뉘어 있어요. 노란 칸 하나가 <b>{CELL_SIZE}m × {CELL_SIZE}m</b>예요.
        </>
      ),
    },
    {
      target: '.maps', // 누른 결과가 오른쪽 확대 지도에 나오니 두 지도를 함께 밝힌다
      title: '구역을 하나 눌러 보세요',
      body: <>아무 구역이나 눌러 보세요. 누른 구역이 오른쪽 확대 지도에 크게 나와요.</>,
      task: <>지도에서 <b>구역 하나 누르기</b></>,
      done: () => !!selectedId,
    },
    {
      target: '.map-wrap.detail',
      title: '오른쪽은 확대 지도예요',
      body: (
        <>
          고른 구역을 <b>색 없는 원래 지도</b>로 크게 보여줘요. 가게 이름까지 보여요. 두 지도 사이 경계를 끌면 크기를 바꿀 수 있어요.
        </>
      ),
    },
    {
      target: '.panel',
      onEnter: () => setTab('filter'),
      title: '이제 조건으로 찾아볼게요',
      body: <>[조건 찾기] 탭에서 원하는 조건을 하나씩 쌓으면, 맞는 곳만 지도에 남아요.</>,
      task: (
        <>
          <b>조건 추가</b> → <b>‘사람 (유동인구)’</b> 고르기
        </>
      ),
      done: () => !!popCond,
    },
    {
      target: '.step.open .cb',
      onEnter: () => setTab('filter'),
      title: '평일 저녁에 사람이 많은 곳',
      body: <>인원은 5단계로 골라요.</>,
      task: (
        <>
          기간 <b>평일 저녁</b>, 인원 <b>이상</b> → <b>활기참</b>
        </>
      ),
      done: () =>
        !!popCond &&
        popCond.src === 'pop' &&
        popCond.days.join() === '0' &&
        popCond.times.join() === '2,3' &&
        popCond.mode === 'level' &&
        popCond.op === 'gte' &&
        popCond.value === 3 &&
        popCond.value2 === 4,
    },
    {
      target: '.map-wrap:not(.detail)',
      title: '지도에서 결과를 봐요',
      body: (
        <>
          <b>칠해진 칸</b>이 조건에 맞는 곳이에요.
        </>
      ),
    },
    {
      target: '.panel',
      onEnter: () => setTab('filter'),
      title: '조건을 하나 더 쌓아 봐요',
      body: <>조건은 위에서부터 차례로 걸러요. 단계마다 몇 곳이 남았는지 보여요.</>,
      task: (
        <>
          <b>조건 추가</b> → <b>‘가게 · 시설’</b> → 종류 <b>술집</b>, <b>없는 곳</b>
        </>
      ),
      done: () => hasNoBarFilter,
    },
    {
      target: '.pipe',
      onEnter: () => setTab('filter'),
      title: '조건 하나만 보기',
      body: (
        <>
          조건마다 <b>[이것만]</b>을 누르면 그 조건 하나만 지도에 보여요.
        </>
      ),
    },
    {
      target: '.tabs button:nth-child(2)',
      doneTarget: '.panel',
      title: '나만의 동네 성격',
      body: <>조건을 묶어 동네 성격으로 만들 수 있어요.</>,
      task: (
        <>
          <b>[동네 성격]</b> 탭 누르기
        </>
      ),
      done: () => tab === 'type',
    },
    {
      target: '.add-big',
      doneTarget: '.cat.open',
      onEnter: () => setTab('type'),
      title: '새 성격 만들기',
      body: <>성격마다 이름, 색, 조건을 정해요.</>,
      task: (
        <>
          <b>[+ 새 성격 만들기]</b> 누르기
        </>
      ),
      done: () => !!newCat,
    },
    {
      target: '.cat.open',
      onEnter: () => setTab('type'),
      title: '이름 정하기',
      body: <>예시로 ‘조용한 밤 동네’를 만들어 볼게요.</>,
      task: (
        <>
          이름을 <b>조용한 밤 동네</b>로 바꾸기
        </>
      ),
      done: () => !!newCat && newCat.label.replace(/\s/g, '') === '조용한밤동네',
    },
    {
      target: '.cat.open .cb',
      onEnter: () => setTab('type'),
      title: '조건 정하기',
      body: <>이 조건에 맞는 칸이 ‘조용한 밤 동네’가 돼요.</>,
      task: (
        <>
          기간 <b>평일 밤</b>, 인원 <b>이하</b> → <b>한적</b>
        </>
      ),
      done: () =>
        !!newCat &&
        newCat.conds.some((c) => c.src === 'pop' && c.days.join() === '0' && c.times.join() === '3' && c.mode === 'level' && c.op === 'lte' && c.value2 === 1),
    },
    {
      target: '.switch-row',
      doneTarget: '.map-wrap:not(.detail)',
      onEnter: () => setTab('type'),
      title: '지도에 색으로 보기',
      body: <>만든 성격에 맞는 칸이 그 색으로 칠해져요.</>,
      task: (
        <>
          <b>[지도에 색으로 보기]</b> 켜기 (키보드 <kbd>T</kbd>)
        </>
      ),
      done: () => typesOn,
    },
    {
      target: '.panel',
      onEnter: () => setTab('filter'),
      title: '만든 성격으로 걸러 보기',
      body: <>동네 성격도 조건으로 쓸 수 있어요.</>,
      task: (
        <>
          <b>조건 추가</b> → <b>‘동네 성격’</b> → <b>{newCat?.label ?? '방금 만든 성격'}</b> 고르기
        </>
      ),
      done: () => usesNewCat,
    },
    {
      title: '다 됐어요',
      body: (
        <>
          이 안내는 <b>?</b> 버튼으로 다시 볼 수 있어요.
        </>
      ),
    },
  ];

  // ---------- 오른쪽 확대 지도: 선택한 구역 테두리만, 그 구역에 맞춰 확대 (색에 가리지 않은 원래 지도) ----------
  const detailLayers: MapLayers = useMemo(() => {
    if (!selected) return { polygons: [], circles: [], lines: [], markers: [] };
    const cat = catById.get(cls.byId.get(selected.id)?.cat ?? '');
    return {
      polygons: [{ id: 'sel', paths: [selected.corners], stroke: cat?.color ?? '#0b0f17', strokeWeight: 4, strokeOpacity: 1, fill: '#ffffff', fillOpacity: 0 }],
      circles: [],
      lines: [],
      markers: [],
    };
  }, [selected, cls, catById]);
  const detailFit: FitRequest | null = useMemo(() => (selected ? { key: `d-${selected.id}`, points: selected.corners } : null), [selected]);
  const useKakao = hasKakaoKey && !mapError;

  // 두 지도 사이 경계 드래그: 왼쪽(전체) 지도가 차지하는 비율
  const [split, setSplit] = usePersisted<number>('wh.mapSplit', () => 0.5);
  const mapsRef = useRef<HTMLDivElement>(null);
  const splitting = useRef(false);
  const onSplitMove = (e: React.PointerEvent) => {
    if (!splitting.current || !mapsRef.current) return;
    const r = mapsRef.current.getBoundingClientRect();
    setSplit(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className={`app side-${side}`} onPointerMove={onResize} onPointerUp={() => (dragging.current = false)}>
      <aside className="panel" style={{ width }}>
        <header className="panel-head">
          <div className="brand">
            <b>생활권 탐색</b>
            <small>한성대 · 이태원역 주변</small>
          </div>
          <button className="icon-btn help-btn" onClick={startTour} title="사용 안내 다시 보기 (쓰던 조건은 끝나면 돌려놓아요)">
            ?
          </button>
          <button className="icon-btn" onClick={() => setSide(side === 'left' ? 'right' : 'left')} title={`메뉴를 ${side === 'left' ? '오른쪽' : '왼쪽'}으로`}>
            {side === 'left' ? '⇥' : '⇤'}
          </button>
        </header>
        <nav className="tabs">
          <button className={tab === 'filter' ? 'on' : ''} onClick={() => setTab('filter')}>
            조건 찾기{filterActive && <span className="tab-badge">{passList.length}</span>}
          </button>
          <button className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>
            동네 성격{typesOn && <span className="tab-dot" />}
          </button>
          <button className={tab === 'cell' ? 'on' : ''} onClick={() => setTab('cell')}>
            고른 구역{selected && <span className="tab-dot" />}
          </button>
          {/* [임시 · 디버깅] 값이 튀는 칸 찾기 */}
          <button className={tab === 'rank' ? 'on' : ''} onClick={() => setTab('rank')}>
            순위
          </button>
        </nav>
        <div className="panel-body">
          {tab === 'filter' && (
            <FilterSection
              on={filtersOn}
              setOn={setFiltersOn}
              stack={stack}
              setStack={setStack}
              counts={run.stages.map((s) => s.length)}
              total={data.cells.length}
              passInView={passList.filter(inView).length}
              pin={pinIdx}
              setPin={(n) => setPin(n >= stack.length ? null : n)}
              solo={solo}
              setSolo={setSolo}
              soloCount={soloList?.length ?? null}
              cats={cats}
              dongs={data.dongStats.map((d) => ({ code: d.code, name: d.name }))}
              destinations={data.meta.destinations}
              x={x}
              names={names}
              selChecks={selected ? stack.map((f) => evalFilter(f, selected, fctx).ok) : null}
              selName={selected ? placeName.get(selected.id) ?? selected.dongName : ''}
            />
          )}
          {tab === 'type' && (
            <CategoriesSection
              on={typesOn}
              setOn={setTypesOn}
              hidden={hidden}
              toggleHidden={(id) => setHiddenList(hidden.has(id) ? hiddenList.filter((v) => v !== id) : [...hiddenList, id])}
              cats={cats}
              setCats={setCats}
              counts={cls.counts}
              unclassified={unclassified}
              x={x}
              onReset={() => setCats(defaultCategories())}
            />
          )}
          {tab === 'rank' && (
            <DebugRank
              spread={spread}
              setSpread={setSpread}
              cells={data.cells}
              selectedId={selectedId}
              onPick={(c) => {
                selectCell(c.id);
                // 그 칸 주변으로 확대 (칸 3개 폭)
                const [sw, , ne] = c.corners;
                const [dLat, dLng] = [ne.lat - sw.lat, ne.lng - sw.lng];
                setFocus({ key: `rank-${c.id}-${Date.now()}`, points: [-3, 3].flatMap((a) => [-3, 3].map((b) => ({ lat: c.center.lat + a * dLat, lng: c.center.lng + b * dLng }))) });
              }}
            />
          )}
          {tab === 'cell' &&
            (selected ? (
              <CellSection
                cell={selected}
                cat={catById.get(cls.byId.get(selected.id)?.cat ?? '') ?? null}
                filters={stack.map((f) => ({ f, text: describe(f, names), r: evalFilter(f, selected, fctx) }))}
                onClose={() => selectCell(null)}
                layer={valueLayer}
                setLayer={setValueLayer}
              />
            ) : (
              <div className="empty-box">{gridVisible ? '지도에서 구역을 눌러 보세요.' : `지도를 확대하면 ${CELL_SIZE}m 단위 구역이 나타나고, 눌러서 자세히 볼 수 있어요.`}</div>
            ))}
        </div>
        <footer className="panel-foot">
          시설 {data.meta.source.places === 'kakao' ? '카카오 로컬' : 'mock'} · 유동인구 LG U+ (2025년) ·{' '}
          <a href="/kernel.html" className="link">
            커널 실험실 ↗
          </a>
        </footer>
      </aside>
      <div
        className="resizer"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        title="드래그해서 폭 조절"
      />
      <div className="maps" ref={mapsRef} onPointerMove={onSplitMove} onPointerUp={() => (splitting.current = false)}>
      <main className="map-wrap" style={{ flex: split }}>
        {useKakao ? <KakaoMap {...mapProps} onError={(e) => setMapError(e.message)} /> : <SvgMap {...mapProps} />}
        <div className="map-toggles">
          {gridVisible && (
            <button className={typesOn ? 'on' : ''} onClick={() => setTypesOn(!typesOn)} title="동네 성격 색으로 보기 (T)">
              동네 성격 <kbd>T</kbd>
            </button>
          )}
          {stack.length > 0 && (
            <button className={filtersOn ? 'on' : ''} onClick={() => setFiltersOn(!filtersOn)} title="필터 결과 표시 (F)">
              조건 결과 <kbd>F</kbd>
            </button>
          )}
        </div>
        {valueLayer && (
          <div className="value-banner">
            <b>칸 숫자</b> {layerText(valueLayer)}
            {!gridVisible || valueCells === 'many' ? <span className="muted"> · 더 확대하면 보여요</span> : null}
            <button className="link" onClick={() => setValueLayer(null)}>
              끄기
            </button>
          </div>
        )}
        {/* 범례: 지금 지도에 켜진 것을 한 곳에서 설명 */}
        {(heatInfo || filterActive || (typesOn && gridVisible)) && (
          <div className="legend-box">
            {heat && heatInfo ? (
              <>
                <div className="lg-title">색 세기 · {condSubject(heat.cond)}</div>
                <div className="heat-bar">
                  {HEAT_RAMP.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </div>
                <div className="heat-scale">
                  <span>
                    {heatInfo.min.toLocaleString()}
                    {condUnit(heat.cond)}
                  </span>
                  <span>
                    {heatInfo.max.toLocaleString()}
                    {condUnit(heat.cond)}
                  </span>
                </div>
                <div className="lg-row">
                  칠한 칸: 조건에 맞는 {heatInfo.passIds.size}곳 · 진할수록 {heatInfo.closer ? '가까움' : '많음'}
                </div>
                <div className="lg-hint">조건을 접으면 원래 화면으로 돌아가요</div>
              </>
            ) : (
              <>
                {filterActive && (
                  <>
                    <div className="lg-title">조건 결과</div>
                    {gridVisible ? (
                      <>
                        <div className="lg-row">
                          <span className="pass-sample" /> 조건에 맞는 곳 {passList.length}곳
                        </div>
                        <div className="lg-row">
                          <span className="dark-sample" /> 걸러진 곳
                        </div>
                      </>
                    ) : (
                      <div className="lg-row">
                        <span className="pass-sample" /> 조건에 맞는 곳 {passList.length}곳
                      </div>
                    )}
                  </>
                )}
                {/* 조건 결과를 보는 중엔 동네 성격 체크리스트는 숨김 (칸 색이 조건 결과로 칠해짐) */}
                {typesOn && gridVisible && !filterActive && (
                  <>
                    <div className="lg-title">동네 성격</div>
                    {/* 보고 싶은 성격만 체크 — [동네 성격] 탭의 눈 아이콘과 같은 상태 */}
                    <ul className="lg-checks">
                      {(() => {
                        const ids = cats.filter((k) => k.enabled).map((k) => k.id);
                        const shown = ids.filter((id) => !hidden.has(id)).length;
                        return (
                          <li className="all">
                            <label>
                              <input
                                type="checkbox"
                                checked={shown === ids.length}
                                ref={(el) => {
                                  if (el) el.indeterminate = shown > 0 && shown < ids.length;
                                }}
                                onChange={() => setHiddenList(shown === ids.length ? ids : [])}
                              />
                              <span>전체</span>
                            </label>
                          </li>
                        );
                      })()}
                      {cats
                        .filter((k) => k.enabled)
                        .map((k) => (
                          <li key={k.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={!hidden.has(k.id)}
                                onChange={() => setHiddenList(hidden.has(k.id) ? hiddenList.filter((v) => v !== k.id) : [...hiddenList, k.id])}
                              />
                              <i style={{ background: k.color }} />
                              <span>{k.label}</span>
                              <small>{cls.counts.get(k.id) ?? 0}</small>
                            </label>
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {mapError && <div className="map-error">{mapError} — 간이 지도로 표시합니다.</div>}
      </main>

      <div
        className="map-split"
        onPointerDown={(e) => {
          splitting.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onDoubleClick={() => setSplit(0.5)}
        title="드래그해서 두 지도 크기 조절 · 두 번 누르면 반반"
      />
      <main className="map-wrap detail" style={{ flex: 1 - split }}>
        {useKakao ? <KakaoMap layers={detailLayers} fit={detailFit} onError={() => {}} /> : <SvgMap layers={detailLayers} fit={detailFit} />}
        <div className="detail-badge">{selected ? `확대 · ${placeName.get(selected.id) ?? selected.dongName}` : '확대 지도'}</div>
        {!selected && <div className="detail-empty">왼쪽 지도에서 구역을 누르면 이곳에 확대되어 보여요</div>}
      </main>
      </div>
      {tourOpen && (
        <Tutorial steps={tourSteps} onClose={endTour} onStep={setTourStepId} dimArea=".panel" />
      )}
    </div>
  );
}
