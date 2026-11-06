import type { LatLng } from './types';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** 두 좌표 사이 직선거리(m) */
export function distM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 직선거리 → 실제 보행 경로 보정계수 */
export const DETOUR = 1.3;
/** 보행 속도 (m/분, 약 4.5km/h) */
export const WALK_M_PER_MIN = 75;

/** 직선거리(m) → 추정 도보 시간(분) */
export const walkMin = (m: number) => (m * DETOUR) / WALK_M_PER_MIN;
/** 도보 시간(분) → 허용 직선거리(m) */
export const walkMinToM = (min: number) => (min * WALK_M_PER_MIN) / DETOUR;

/**
 * 목적지까지 추정 통학 시간.
 * 길찾기 API(대중교통)는 카카오 로컬 API 범위가 아니므로 프로토타입에서는
 * 도보 vs (대기+버스/지하철 평균속도) 중 빠른 쪽으로 근사한다.
 */
export function estimateCommute(from: LatLng, to: LatLng): { min: number; mode: 'walk' | 'transit' } {
  const d = distM(from, to);
  const walk = walkMin(d);
  const transit = 9 + (d * 1.35) / 300; // 대기·환승·정류장 도보 9분 + 평균 18km/h
  return walk <= transit ? { min: Math.round(walk), mode: 'walk' } : { min: Math.round(transit), mode: 'transit' };
}

/** 점-다각형 포함 판정 (ring: [lng, lat][]) */
export function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** GeoJSON (Multi)Polygon 포함 판정 */
export function pointInGeometry(lng: number, lat: number, geom: { type: string; coordinates: any }): boolean {
  const polys: number[][][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.some(([outer, ...holes]) => pointInRing(lng, lat, outer) && !holes.some((h) => pointInRing(lng, lat, h)));
}
