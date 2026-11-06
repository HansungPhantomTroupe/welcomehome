/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import type { MapCircle, MapMarker, MapPolygon, RendererProps } from './types';

declare global {
  interface Window {
    kakao: any;
  }
}

const JS_KEY = import.meta.env.VITE_KAKAO_JS_KEY as string | undefined;
export const hasKakaoKey = !!JS_KEY;

let loader: Promise<any> | null = null;
export function loadKakao(): Promise<any> {
  if (!JS_KEY) return Promise.reject(new Error('VITE_KAKAO_JS_KEY 미설정'));
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      // 등록 안 된 도메인에서는 스크립트는 받아져도 kakao 객체가 없거나 load 콜백이 영영 안 올 수 있다 → 시간 초과로도 실패 처리
      const fail = () => reject(new Error(`카카오 지도를 불러오지 못했어요 — 카카오 콘솔 > 플랫폼 > Web 에 ${location.origin} 를 등록했는지 확인하세요`));
      const timer = setTimeout(fail, 8000);
      const s = document.createElement('script');
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${JS_KEY}&autoload=false`;
      s.onload = () => {
        if (!window.kakao?.maps?.load) {
          clearTimeout(timer);
          return fail();
        }
        window.kakao.maps.load(() => {
          clearTimeout(timer);
          resolve(window.kakao);
        });
      };
      s.onerror = () => {
        clearTimeout(timer);
        fail();
      };
      document.head.appendChild(s);
    });
    loader.catch(() => (loader = null));
  }
  return loader;
}

export function markerHtml(m: MapMarker): string {
  const t = m.text ? escapeHtml(m.text) : '';
  return `<div class="mk mk-${m.kind}${m.active ? ' active' : ''}" title="${t}">${m.kind === 'dot' ? '' : t}</div>`;
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const toLL = (q: { lat: number; lng: number }) => new window.kakao.maps.LatLng(q.lat, q.lng);

/** 현재 확대 수준의 1px 당 m */
function measureMPerPx(map: any): number {
  const { kakao } = window;
  const proj = map.getProjection();
  const a = proj.coordsFromContainerPoint(new kakao.maps.Point(0, 0));
  const b = proj.coordsFromContainerPoint(new kakao.maps.Point(100, 0));
  return (Math.abs(b.getLng() - a.getLng()) * 88_200) / 100;
}

export default function KakaoMap({ layers, fit, blend = 'normal', onScale, onBounds, onError }: RendererProps & { onError: (e: Error) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<any>(null);
  // 지도 이벤트 콜백은 처음 한 번 등록하므로 최신 prop 을 ref 로 참조
  const cb = useRef({ onScale, onBounds });
  cb.current = { onScale, onBounds };
  const objs = useRef({
    polygons: new Map<string, { obj: any[]; sig: string; pathSig: string; handler: { fn?: () => void } }>(),
    circles: new Map<string, { obj: any; sig: string }>(),
    lines: new Map<string, { obj: any; sig: string }>(),
    markers: new Map<string, { obj: any; sig: string; handler: { fn?: () => void } }>(),
  });

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    loadKakao()
      .then((kakao) => {
        if (cancelled || !el.current) return;
        const m = new kakao.maps.Map(el.current, { center: new kakao.maps.LatLng(37.596, 127.02), level: 6 });
        m.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
        const report = () => {
          cb.current.onScale?.(measureMPerPx(m));
          const b = m.getBounds();
          const sw = b.getSouthWest();
          const ne = b.getNorthEast();
          cb.current.onBounds?.({ minLat: sw.getLat(), minLng: sw.getLng(), maxLat: ne.getLat(), maxLng: ne.getLng() });
        };
        kakao.maps.event.addListener(m, 'zoom_changed', () => cb.current.onScale?.(measureMPerPx(m)));
        kakao.maps.event.addListener(m, 'idle', report);
        // 패널 폭이 바뀌어 지도 크기가 달라지면 카카오 지도에 알려줘야 타일이 제대로 채워진다.
        // 크기가 없어서 미뤄 둔 화면 맞춤이 있으면 이때 적용한다.
        ro = new ResizeObserver(() => {
          m.relayout();
          applyFit.current();
        });
        ro.observe(el.current);
        if (import.meta.env.DEV) (window as any).__kmap ??= m; // 콘솔 디버깅용 (첫 지도)
        setMap(m);
        report();
      })
      .catch(onError);
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
  }, []);

  // ---------- 폴리곤 ----------
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const store = objs.current.polygons;
    const seen = new Set<string>();
    const make = (p: MapPolygon, handler: { fn?: () => void }) =>
      p.paths.map((path) => {
        const poly = new kakao.maps.Polygon({ map, path: path.map(toLL) });
        kakao.maps.event.addListener(poly, 'click', () => handler.fn?.());
        return poly;
      });
    for (const p of layers.polygons) {
      seen.add(p.id);
      const pathSig = pathKey(p);
      let e = store.get(p.id);
      if (!e) {
        const handler: { fn?: () => void } = {};
        e = { obj: make(p, handler), sig: '', pathSig, handler };
        store.set(p.id, e);
      } else if (e.pathSig !== pathSig) {
        // 같은 id 라도 좌표가 바뀌면 위치를 다시 그린다
        if (e.obj.length === p.paths.length) e.obj.forEach((o, i) => o.setPath(p.paths[i].map(toLL)));
        else {
          e.obj.forEach((o) => o.setMap(null));
          e.obj = make(p, e.handler);
        }
        e.pathSig = pathSig;
        e.sig = '';
      }
      e.handler.fn = p.onClick;
      const sig = polySig(p);
      if (e.sig !== sig) {
        for (const o of e.obj) {
          o.setOptions({ strokeColor: p.stroke, strokeWeight: p.strokeWeight, strokeOpacity: p.strokeOpacity, fillColor: p.fill, fillOpacity: p.fillOpacity });
          if (p.zIndex !== undefined) o.setZIndex(p.zIndex);
        }
        e.sig = sig;
      }
    }
    for (const [id, e] of store)
      if (!seen.has(id)) {
        e.obj.forEach((o) => o.setMap(null));
        store.delete(id);
      }
  }, [map, layers.polygons]);

  // ---------- 합성 모드 ----------
  // 카카오는 도형 svg 를 z-index 가 있는 div 로 감싸 별도 쌓임 맥락을 만든다.
  // svg 자체에 걸면 빈 레이어하고만 섞이므로, 지도 타일과 형제인 그 감싸는 div 에 직접 건다.
  useEffect(() => {
    if (!map || !el.current) return;
    el.current.querySelectorAll('svg').forEach((svg) => {
      (svg.parentElement as HTMLElement).style.mixBlendMode = blend;
    });
  });

  // ---------- 원 ----------
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const store = objs.current.circles;
    const seen = new Set<string>();
    for (const c of layers.circles) {
      seen.add(c.id);
      const sig = circleSig(c);
      const e = store.get(c.id);
      if (e && e.sig === sig) continue;
      e?.obj.setMap(null);
      const obj = new kakao.maps.Circle({
        map,
        center: toLL(c.center),
        radius: c.radius,
        strokeWeight: 2,
        strokeColor: c.stroke,
        strokeOpacity: 0.9,
        strokeStyle: c.dashed ? 'dash' : 'solid',
        fillColor: c.fill,
        fillOpacity: c.fillOpacity,
      });
      store.set(c.id, { obj, sig });
    }
    for (const [id, e] of store)
      if (!seen.has(id)) {
        e.obj.setMap(null);
        store.delete(id);
      }
  }, [map, layers.circles]);

  // ---------- 선 ----------
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const store = objs.current.lines;
    const seen = new Set<string>();
    for (const l of layers.lines) {
      seen.add(l.id);
      const sig = `${l.color}|${l.weight}|${l.opacity}|${l.zIndex}`;
      const e = store.get(l.id);
      if (e && e.sig === sig) continue;
      if (e) {
        e.obj.setOptions({ strokeColor: l.color, strokeWeight: l.weight, strokeOpacity: l.opacity });
        if (l.zIndex !== undefined) e.obj.setZIndex(l.zIndex);
        e.sig = sig;
        continue;
      }
      const obj = new kakao.maps.Polyline({ map, path: l.path.map(toLL), strokeColor: l.color, strokeWeight: l.weight, strokeOpacity: l.opacity });
      if (l.zIndex !== undefined) obj.setZIndex(l.zIndex);
      store.set(l.id, { obj, sig });
    }
    for (const [id, e] of store)
      if (!seen.has(id)) {
        e.obj.setMap(null);
        store.delete(id);
      }
  }, [map, layers.lines]);

  // ---------- 마커 (CustomOverlay) ----------
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const store = objs.current.markers;
    const seen = new Set<string>();
    for (const m of layers.markers) {
      seen.add(m.id);
      const sig = `${m.pos.lat},${m.pos.lng},${m.kind},${m.text},${m.active}`;
      let e = store.get(m.id);
      if (e && e.sig !== sig) {
        e.obj.setMap(null);
        store.delete(m.id);
        e = undefined;
      }
      if (!e) {
        const handler: { fn?: () => void } = {};
        const node = document.createElement('div');
        node.innerHTML = markerHtml(m);
        node.addEventListener('click', (ev) => {
          ev.stopPropagation();
          handler.fn?.();
        });
        const obj = new kakao.maps.CustomOverlay({ map, position: toLL(m.pos), content: node, yAnchor: 0.5, zIndex: m.active ? 30 : 10, clickable: true });
        e = { obj, sig, handler };
        store.set(m.id, e);
      }
      e.handler.fn = m.onClick;
    }
    for (const [id, e] of store)
      if (!seen.has(id)) {
        e.obj.setMap(null);
        store.delete(id);
      }
  }, [map, layers.markers]);

  // ---------- 화면 맞춤 ----------
  const lastFit = useRef('');
  const applyFit = useRef<() => void>(() => {});
  applyFit.current = () => {
    if (!map || !fit || !fit.points.length || lastFit.current === fit.key) return;
    const box = el.current?.getBoundingClientRect();
    if (!box || box.width < 50 || box.height < 50) return; // 아직 크기가 없으면 미룸 (ResizeObserver 가 다시 부름)
    lastFit.current = fit.key;
    const b = new window.kakao.maps.LatLngBounds();
    fit.points.forEach((p) => b.extend(toLL(p)));
    map.relayout();
    map.setBounds(b, 24, 24, 24, 24);
    if (fit.allowCrop) {
      // 한 단계 가까이 가면 화면 폭·높이가 절반 — 그래도 거의 다 들어오면 가까이 본다
      const v = map.getBounds();
      const [vw, vh] = [v.getNorthEast().getLng() - v.getSouthWest().getLng(), v.getNorthEast().getLat() - v.getSouthWest().getLat()];
      const [bw, bh] = [b.getNorthEast().getLng() - b.getSouthWest().getLng(), b.getNorthEast().getLat() - b.getSouthWest().getLat()];
      const room = 0.5 * (1 + 2 * fit.allowCrop);
      if (bw <= vw * room && bh <= vh * room) map.setLevel(map.getLevel() - 1);
    }
  };
  useEffect(() => applyFit.current(), [map, fit]);

  return <div ref={el} className="map-canvas" />;
}

const pathKey = (p: MapPolygon) => p.paths.map((r) => r.map((q) => `${q.lat},${q.lng}`).join(';')).join('|');
const polySig = (p: MapPolygon) => `${p.stroke}|${p.strokeWeight}|${p.strokeOpacity}|${p.fill}|${p.fillOpacity}|${p.zIndex}`;
const circleSig = (c: MapCircle) => `${c.center.lat},${c.center.lng}|${c.radius}|${c.stroke}|${c.fill}|${c.fillOpacity}|${c.dashed}`;
