/**
 * 튀는 칸(주변 8칸보다 10배 이상)이 왜 튀는지 지도 데이터로 추정한다.
 *
 * 1) 칸마다 안(+10m 여유)에 있는 시설을 센다
 *    - 카카오 로컬: 지하철역·학교·학원·병원·공공기관·문화시설·관광명소·숙박·주차장 + 키워드(아파트·교회·성당·시장)
 *    - 서울시 버스정류소 위치정보 (data/raw/bus_stops)
 *    - 이미 모은 음식점·카페 (places.json)
 * 2) 튀는 칸과 나머지 칸에서 각 시설이 있는 비율을 비교 (몇 배 더 자주 있는지)
 * 3) 튀는 칸마다 대표 이유 하나 + 같이 있는 시설 + 인구 특징(거주·직장·방문 중 무엇이 많은지, 언제 많은지)
 * 결과: data/generated/spike_reasons.json
 *
 *   npx tsx scripts/explainSpikes.ts   (카카오 키 필요, 요청은 디스크 캐시)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FILES, GEN_DIR, RAW_DIR } from '../src/config';
import { searchRect, stats, type KakaoDoc, type Rect, type SearchSpec } from '../src/kakao';
import { POP_KINDS, TIME_SLOTS } from '../../shared/cellTypes';
import type { Cell, Place } from '../../shared/types';

const cells: Cell[] = JSON.parse(await fs.readFile(FILES.cells, 'utf8'));
const places: Place[] = JSON.parse(await fs.readFile(FILES.places, 'utf8'));
const { bbox } = JSON.parse(await fs.readFile(FILES.destinations, 'utf8')) as { bbox: Rect };

// ---------- 시설 모으기 ----------
type Feat = { key: string; label: string; lat: number; lng: number; name: string };
const feats: Feat[] = [];

// 탐색 지역은 두 덩어리라 덩어리별 범위로 (전체 사각형은 사이의 넓은 빈 땅까지 검색하게 됨)
const rects: Rect[] = [];
{
  const north = cells.filter((c) => c.center.lat > 37.56);
  const south = cells.filter((c) => c.center.lat <= 37.56);
  for (const g of [north, south]) {
    if (!g.length) continue;
    const lats = g.flatMap((c) => c.corners.map((p) => p.lat));
    const lngs = g.flatMap((c) => c.corners.map((p) => p.lng));
    rects.push([Math.min(...lngs) - 0.001, Math.min(...lats) - 0.001, Math.max(...lngs) + 0.001, Math.max(...lats) + 0.001]);
  }
}
void bbox;

const KAKAO: { key: string; label: string; spec: SearchSpec; keep?: (d: KakaoDoc) => boolean }[] = [
  { key: 'subway', label: '지하철역', spec: { kind: 'category', code: 'SW8' } },
  { key: 'univ', label: '대학교', spec: { kind: 'category', code: 'SC4' }, keep: (d) => /대학교|대학 >/.test(d.category_name) },
  { key: 'school', label: '초·중·고교', spec: { kind: 'category', code: 'SC4' }, keep: (d) => /초등학교|중학교|고등학교/.test(d.category_name) },
  { key: 'academy', label: '학원', spec: { kind: 'category', code: 'AC5' } },
  { key: 'bigHosp', label: '종합·대학병원', spec: { kind: 'category', code: 'HP8' }, keep: (d) => /종합병원|대학병원/.test(d.category_name) },
  { key: 'public', label: '공공기관', spec: { kind: 'category', code: 'PO3' } },
  { key: 'culture', label: '문화시설', spec: { kind: 'category', code: 'CT1' } },
  { key: 'tour', label: '관광명소', spec: { kind: 'category', code: 'AT4' } },
  { key: 'lodging', label: '숙박', spec: { kind: 'category', code: 'AD5' } },
  { key: 'parking', label: '주차장', spec: { kind: 'category', code: 'PK6' } },
  { key: 'apt', label: '아파트', spec: { kind: 'keyword', query: '아파트' }, keep: (d) => d.category_name.includes('아파트') },
  { key: 'religion', label: '교회·성당', spec: { kind: 'keyword', query: '교회' }, keep: (d) => d.category_name.includes('종교') },
  { key: 'religion', label: '교회·성당', spec: { kind: 'keyword', query: '성당' }, keep: (d) => d.category_name.includes('종교') },
  { key: 'market', label: '전통시장', spec: { kind: 'keyword', query: '시장' }, keep: (d) => d.category_name.startsWith('가정,생활 > 시장') },
];
for (const k of KAKAO) {
  const seen = new Set<string>();
  for (const r of rects)
    for (const d of await searchRect(k.spec, r))
      if (!seen.has(d.id) && (!k.keep || k.keep(d))) {
        seen.add(d.id);
        feats.push({ key: k.key, label: k.label, lat: +d.y, lng: +d.x, name: d.place_name });
      }
  console.log(`  ${k.label.padEnd(8)} ${seen.size}건 (누적 API ${stats.apiCalls} / 캐시 ${stats.cacheHits})`);
}
// 버스정류장 (서울시)
{
  const raw = await fs.readFile(path.join(RAW_DIR, 'bus_stops', 'bus_stops_20251209.csv'), 'utf8');
  let n = 0;
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    const f = line.split(',');
    const [lng, lat] = [+f[3], +f[4]];
    if (!(lat > 37) || f[5] === '한강선착장') continue;
    feats.push({ key: 'bus', label: '버스정류장', lat, lng, name: f[2] });
    n++;
  }
  console.log(`  버스정류장 ${n}건 (서울 전체)`);
}
for (const p of places) if (p.cat === 'food' || p.cat === 'cafe') feats.push({ key: 'eat', label: '식당·카페', lat: p.lat, lng: p.lng, name: p.name });

// ---------- 칸마다 안(+10m)에 있는 시설 ----------
const BUF = { lat: 10 / 111_000, lng: 10 / 88_200 };
const B = 0.001; // 버킷 (~100m)
const bucket = new Map<string, Feat[]>();
for (const f of feats) {
  const k = `${Math.floor(f.lat / B)}:${Math.floor(f.lng / B)}`;
  (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(f);
}
const inside = (c: Cell) => {
  const lats = c.corners.map((p) => p.lat);
  const lngs = c.corners.map((p) => p.lng);
  const [a, b, x, y] = [Math.min(...lats) - BUF.lat, Math.max(...lats) + BUF.lat, Math.min(...lngs) - BUF.lng, Math.max(...lngs) + BUF.lng];
  const out: Feat[] = [];
  for (let i = Math.floor(a / B); i <= Math.floor(b / B); i++)
    for (let j = Math.floor(x / B); j <= Math.floor(y / B); j++)
      for (const f of bucket.get(`${i}:${j}`) ?? []) if (f.lat >= a && f.lat <= b && f.lng >= x && f.lng <= y) out.push(f);
  return out;
};
const EAT_MANY = 5; // 식당·카페 이만큼 이상이면 '밀집'
const flags = (fs_: Feat[]) => {
  const s = new Set(fs_.filter((f) => f.key !== 'eat').map((f) => f.key));
  if (fs_.filter((f) => f.key === 'eat').length >= EAT_MANY) s.add('eatMany');
  return s;
};

// ---------- 튀는 칸 vs 나머지: 시설이 있는 비율 ----------
const LABEL: Record<string, string> = Object.fromEntries([...KAKAO.map((k) => [k.key, k.label]), ['bus', '버스정류장'], ['eatMany', `식당·카페 ${EAT_MANY}곳+`]]);
const spikes = cells.filter((c) => c.spike);
// 비교군: 튀지 않으면서 사람이 어느 정도 있는 칸 (빈 산·공원 칸은 빼야 공정)
const others = cells.filter((c) => !c.spike && c.total >= 20);
const has = new Map(cells.map((c) => [c.id, flags(inside(c))]));
const rate = (cs: Cell[], k: string) => cs.filter((c) => has.get(c.id)!.has(k)).length / Math.max(1, cs.length);
const lift = Object.keys(LABEL).map((k) => ({ k, label: LABEL[k], spike: rate(spikes, k), other: rate(others, k) }));
lift.sort((a, b) => b.spike / Math.max(b.other, 0.002) - a.spike / Math.max(a.other, 0.002));

// ---------- 튀는 칸마다 대표 이유 ----------
// 사람을 한 점에 모을 만한 것부터 (역·정류장 → 큰 시설 → 주거 → 상권)
const PRIORITY = ['subway', 'bus', 'univ', 'school', 'bigHosp', 'market', 'apt', 'public', 'religion', 'lodging', 'culture', 'tour', 'eatMany', 'academy', 'parking'];
const signature = (c: Cell) => {
  const ks = [c.kindShare.resident, c.kindShare.worker, c.kindShare.visitor];
  const top = ks.indexOf(Math.max(...ks));
  const slotSum = [0, 1, 2, 3].map((t) => c.slots[0][t] + c.slots[1][t]);
  const peak = slotSum.indexOf(Math.max(...slotSum));
  const wd = c.slots[0].reduce((s, v) => s + v, 0);
  const we = c.slots[1].reduce((s, v) => s + v, 0);
  return { main: POP_KINDS[top], mainShare: +ks[top].toFixed(2), peak: TIME_SLOTS[peak], weekendRatio: +(we / Math.max(wd, 1)).toFixed(2) };
};
const out: Record<string, { reason: string; features: { label: string; name: string }[]; sig: ReturnType<typeof signature> }> = {};
const reasonCount: Record<string, number> = {};
for (const c of spikes) {
  const fs_ = inside(c);
  const f = has.get(c.id)!;
  const key = PRIORITY.find((k) => f.has(k));
  const sig = signature(c);
  // 시설이 안 잡히면 인구 특징으로: 거주가 대부분이면 주택·건물, 아니면 알 수 없음
  const reason = key ? LABEL[key] : sig.main === '거주' && sig.mainShare >= 0.5 ? '시설 없음 · 주거 위주 (큰 건물·다세대 추정)' : '시설 없음 · 원인 불명';
  reasonCount[reason] = (reasonCount[reason] ?? 0) + 1;
  const named = fs_.filter((x) => x.key !== 'eat');
  const eats = fs_.filter((x) => x.key === 'eat');
  out[c.id] = {
    reason,
    features: [...named.map((x) => ({ label: x.label, name: x.name })), ...(eats.length ? [{ label: '식당·카페', name: `${eats.length}곳` }] : [])].slice(0, 8),
    sig,
  };
}
await fs.writeFile(path.join(GEN_DIR, 'spike_reasons.json'), JSON.stringify({ lift, reasonCount, cells: out }, null, 1));

console.log(`\n튀는 칸 ${spikes.length} · 비교 칸(사람 20명 이상, 안 튐) ${others.length}`);
console.log('시설이 칸 안(+10m)에 있는 비율:  튀는 칸 / 비교 칸 (배)');
for (const l of lift) console.log(`  ${l.label.padEnd(10)} ${(l.spike * 100).toFixed(1).padStart(5)}% / ${(l.other * 100).toFixed(1).padStart(5)}%  (${(l.spike / Math.max(l.other, 0.002)).toFixed(1)}배)`);
console.log('\n대표 이유:');
for (const [r, n] of Object.entries(reasonCount).sort((a, b) => b[1] - a[1])) console.log(`  ${r}: ${n}칸`);
