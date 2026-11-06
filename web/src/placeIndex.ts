/** 시설 공간 색인 — 시설 ~2만 건을 약 220m 버킷으로 나눠 검색 (구역 이름 붙이기용: 가까운 지하철역) */
import type { Cell, LatLng, Place } from '@shared/types';
import { withNearDist } from './classify';

const M_LAT = 111_000;
const M_LNG = 88_200;
/** 성북구 위도 기준 평면 근사 거리(m) */
export const fastDist = (a: LatLng, b: LatLng) => Math.hypot((a.lat - b.lat) * M_LAT, (a.lng - b.lng) * M_LNG);

/** 시설 종류 키 (eat = 음식점+카페, bar = 술집 계열 음식점, any = 전체) */
export type PoiKey = 'any' | 'eat' | 'food' | 'cafe' | 'bar' | 'conv' | 'hosp' | 'pharm' | 'gym' | 'subway' | 'mart';
export const matchPoi = (p: Place, key: PoiKey) =>
  key === 'any' ? true : key === 'eat' ? p.cat === 'food' || p.cat === 'cafe' : key === 'bar' ? !!p.bar : p.cat === key;

export interface PlaceIndex {
  near: (c: LatLng, radius: number, key: PoiKey) => Place[];
  nearest: (c: LatLng, key: PoiKey) => { place: Place; dist: number } | null;
}

export function makePlaceIndex(places: Place[]): PlaceIndex {
  const BLAT = 0.002;
  const BLNG = 0.0025;
  const buckets = new Map<string, Place[]>();
  for (const p of places) {
    const k = `${Math.floor(p.lat / BLAT)}:${Math.floor(p.lng / BLNG)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const near = (c: LatLng, radius: number, key: PoiKey) => {
    const out: Place[] = [];
    const di = Math.ceil(radius / M_LAT / BLAT);
    const dj = Math.ceil(radius / M_LNG / BLNG);
    const ci = Math.floor(c.lat / BLAT);
    const cj = Math.floor(c.lng / BLNG);
    for (let i = ci - di; i <= ci + di; i++)
      for (let j = cj - dj; j <= cj + dj; j++)
        for (const p of buckets.get(`${i}:${j}`) ?? []) if (matchPoi(p, key) && fastDist(c, p) <= radius) out.push(p);
    return out;
  };
  const memo = new Map<string, { place: Place; dist: number } | null>();
  const nearest = (c: LatLng, key: PoiKey) => {
    const mk = `${c.lat},${c.lng},${key}`;
    if (memo.has(mk)) return memo.get(mk)!;
    let res: { place: Place; dist: number } | null = null;
    // 가까운 범위부터 넓혀 찾고, 그래도 없으면 전체 탐색
    for (const r of [300, 800, 2000]) {
      for (const p of near(c, r, key)) {
        const d = fastDist(c, p);
        if (!res || d < res.dist) res = { place: p, dist: d };
      }
      if (res) break;
    }
    if (!res)
      for (const p of places)
        if (matchPoi(p, key)) {
          const d = fastDist(c, p);
          if (!res || d < res.dist) res = { place: p, dist: d };
        }
    memo.set(mk, res);
    return res;
  };
  return { near, nearest };
}

/** 받은 데이터의 구역마다 종류별 가장 가까운 시설까지 거리를 붙인다 ('가까운 곳' 조건용) */
export function attachNearDist<T extends { cells: Cell[]; places: Place[] }>(d: T): T {
  const ix = makePlaceIndex(d.places);
  withNearDist(d.cells, (c, k) => ix.nearest(c, k)?.dist ?? null);
  return d;
}
