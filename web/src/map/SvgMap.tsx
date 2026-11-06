/**
 * 카카오 JS 키가 없을 때 쓰는 간이 지도 (배경지도 없이 레이어만 렌더)
 * 드래그로 이동, 휠로 확대/축소.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LatLng } from '@shared/types';
import { markerHtml } from './KakaoMap';
import type { RendererProps } from './types';

const M_LAT = 111_000;
const M_LNG = 88_200;
const ORIGIN = { lat: 37.6, lng: 127.03 };
const proj = (p: LatLng) => ({ x: (p.lng - ORIGIN.lng) * M_LNG, y: -(p.lat - ORIGIN.lat) * M_LAT });

type VB = { x: number; y: number; w: number; h: number };

export default function SvgMap({ layers, fit, blend = 'normal', onScale, onBounds }: RendererProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [vb, setVb] = useState<VB>({ x: -4500, y: -3000, w: 9000, h: 6750 });
  const drag = useRef<{ sx: number; sy: number; vb: VB; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 화면 비율에 맞춰 viewBox 높이 보정
  const view: VB = { ...vb, h: (vb.w * size.h) / Math.max(size.w, 1) };
  const k = view.w / Math.max(size.w, 1); // 1px 당 m

  useEffect(() => onScale?.(k), [k]);
  useEffect(() => {
    if (!onBounds) return;
    const t = setTimeout(
      () =>
        onBounds({
          minLng: view.x / M_LNG + ORIGIN.lng,
          maxLng: (view.x + view.w) / M_LNG + ORIGIN.lng,
          maxLat: -view.y / M_LAT + ORIGIN.lat,
          minLat: -(view.y + view.h) / M_LAT + ORIGIN.lat,
        }),
      200,
    );
    return () => clearTimeout(t);
  }, [view.x, view.y, view.w, view.h]);

  const lastFit = useRef('');
  useEffect(() => {
    if (!fit || !fit.points.length || lastFit.current === fit.key + size.w) return;
    lastFit.current = fit.key + size.w;
    const ps = fit.points.map(proj);
    const minX = Math.min(...ps.map((p) => p.x));
    const maxX = Math.max(...ps.map((p) => p.x));
    const minY = Math.min(...ps.map((p) => p.y));
    const maxY = Math.max(...ps.map((p) => p.y));
    const pad = 1.12;
    const w = Math.max((maxX - minX) * pad, ((maxY - minY) * pad * size.w) / Math.max(size.h, 1), 400);
    const h = (w * size.h) / size.w;
    setVb({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h });
  }, [fit, size]);

  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const z = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const w = Math.min(40000, Math.max(300, view.w * z));
    const h = (w * size.h) / size.w;
    setVb({ x: view.x + (view.w - w) * fx, y: view.y + (view.h - h) * fy, w, h });
  };
  const onDown = (e: React.PointerEvent) => {
    drag.current = { sx: e.clientX, sy: e.clientY, vb: view, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setVb({ ...d.vb, x: d.vb.x - dx * k, y: d.vb.y - dy * k });
  };
  const onUp = () => setTimeout(() => (drag.current = null));
  const click = (fn?: () => void) => () => {
    if (!drag.current?.moved) fn?.();
  };

  const toPath = (paths: LatLng[][], close = true) =>
    paths
      .map(
        (path) =>
          path
            .map((p, i) => {
              const q = proj(p);
              return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
            })
            .join('') + (close ? 'Z' : ''),
      )
      .join('');

  const sorted = [...layers.polygons].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  return (
    <div ref={wrap} className="map-canvas svg-map" onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      <svg width="100%" height="100%" style={{ mixBlendMode: blend as any }} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}>
        {sorted.map((p) => (
          <path
            key={p.id}
            d={toPath(p.paths)}
            fill={p.fill}
            fillOpacity={p.fillOpacity}
            stroke={p.stroke}
            strokeOpacity={p.strokeOpacity}
            strokeWidth={p.strokeWeight * k}
            strokeLinejoin="round"
            onClick={click(p.onClick)}
            style={{ cursor: p.onClick ? 'pointer' : 'default' }}
          />
        ))}
        {layers.lines.map((l) => (
          <path key={l.id} d={toPath([l.path], false)} fill="none" stroke={l.color} strokeOpacity={l.opacity} strokeWidth={l.weight * k} pointerEvents="none" />
        ))}
        {layers.circles.map((c) => {
          const q = proj(c.center);
          return (
            <circle
              key={c.id}
              cx={q.x}
              cy={q.y}
              r={c.radius}
              fill={c.fill}
              fillOpacity={c.fillOpacity}
              stroke={c.stroke}
              strokeWidth={2 * k}
              strokeDasharray={c.dashed ? `${6 * k} ${4 * k}` : undefined}
              pointerEvents="none"
            />
          );
        })}
      </svg>
      <div className="svg-markers">
        {layers.markers.map((m) => {
          const q = proj(m.pos);
          const left = (q.x - view.x) / k;
          const top = (q.y - view.y) / k;
          if (left < -50 || top < -50 || left > size.w + 50 || top > size.h + 50) return null;
          return <div key={m.id} className="svg-marker" style={{ left, top }} onClick={click(m.onClick)} dangerouslySetInnerHTML={{ __html: markerHtml(m) }} />;
        })}
      </div>
      <div className="svg-badge">간이 지도 (카카오 JS 키 미설정)</div>
    </div>
  );
}
