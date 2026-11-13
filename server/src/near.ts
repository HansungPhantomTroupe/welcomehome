/**
 * 칸마다 종류별 가장 가까운 시설까지 거리 — DB(PostGIS)가 없을 때 파일 데이터로 계산하는 대체 경로.
 * DB 모드에서는 postgres.ts 의 SQL 이 같은 값을 계산한다.
 */
import type { Cell, GeneratedCell, LatLng, NearKind, Place } from '../../shared/types';
import { NEAR_KINDS } from '../../shared/types';

const M_LAT = 111_000;
const M_LNG = 88_200;
/** 성북구 위도 기준 평면 근사 거리(m) */
const dist = (a: LatLng, b: LatLng) => Math.hypot((a.lat - b.lat) * M_LAT, (a.lng - b.lng) * M_LNG);
const match = (p: Place, k: NearKind) => (k === 'bar' ? !!p.bar : p.cat === k);

export function attachNear(generated: GeneratedCell[], places: Place[]): Cell[] {
  const cells = generated as Cell[];
  const BLAT = 0.002;
  const BLNG = 0.0025;
  const buckets = new Map<string, Place[]>();
  for (const p of places) {
    const k = `${Math.floor(p.lat / BLAT)}:${Math.floor(p.lng / BLNG)}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p);
  }
  const nearest = (c: LatLng, kind: NearKind): { p: Place; d: number } | null => {
    let best: { p: Place; d: number } | null = null;
    for (const r of [300, 800, 2000]) {
      const di = Math.ceil(r / M_LAT / BLAT);
      const dj = Math.ceil(r / M_LNG / BLNG);
      const [ci, cj] = [Math.floor(c.lat / BLAT), Math.floor(c.lng / BLNG)];
      for (let i = ci - di; i <= ci + di; i++)
        for (let j = cj - dj; j <= cj + dj; j++)
          for (const p of buckets.get(`${i}:${j}`) ?? []) {
            if (!match(p, kind)) continue;
            const d = dist(c, p);
            if (d <= r && (!best || d < best.d)) best = { p, d };
          }
      if (best) return best;
    }
    for (const p of places) if (match(p, kind)) {
      const d = dist(c, p);
      if (!best || d < best.d) best = { p, d };
    }
    return best;
  };
  for (const c of cells) {
    const near = Object.fromEntries(NEAR_KINDS.map((k) => [k, nearest(c.center, k)])) as Record<NearKind, { p: Place; d: number } | null>;
    c.nearM = Object.fromEntries(NEAR_KINDS.map((k) => [k, near[k] ? Math.round(near[k]!.d) : null])) as Cell['nearM'];
    c.nearSubway = near.subway ? { name: near.subway.p.name, m: Math.round(near.subway.d) } : null;
  }
  return cells;
}
