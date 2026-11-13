/**
 * LG U+ 셀 유동인구 + 시설 데이터 → 200m 칸 특성/유형 분류 + 행정동 통계
 *
 * 순서: 50m 원본 셀로 집계 → 튀는 50m 셀의 넘친 몫을 퍼뜨림(아파트 단지·큰 건물·주변 지역 단위) → 200m 칸으로 합침
 * 인구 = 셀 전체 인구 (거주+직장+방문 = 체류+보행+주행)
 * 원본은 '그 달의 해당 요일 날들 × 시간대 안 각 시간'의 인구를 모두 더한 값(사람×시간 누적)이라,
 * 일수 × 시간 수로 나눠 '그 시간대에 그 칸에 있는 평균 인원'으로 쓴다.
 *  - 시간대 시간 수: 08~12시 5시간(8~12), 13~16·17~20시 4시간, 21~24시 4시간(21·22·23·0)
 *  - 근거: 같은 셀의 다른 팀 1시간 단위 자료(14팀, 주중=월~금·주말=토일)와 비교하면 비율이 정확히 4/5·3/2
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { CELL_SIZE, FILES, SEOUL_MIN_LAT, toUtmk, toWgs } from '../src/config';
import { coord2address } from '../src/kakao';
import { distM, estimateCommute } from '../../shared/geo';
import { AGE_GROUPS, DAY_GROUPS, TIME_SLOTS } from '../../shared/cellTypes';
import type { Cell, GeneratedCell, CellType, DongStat, Level, Meta, Place, PlaceCat, SlotMatrix } from '../../shared/types';
import { gridId, type GridCell } from './genGrid';

/** LG U+ 50m 원본 셀 (genGrid) */
const grid: GridCell[] = JSON.parse(await fsp.readFile(FILES.grid, 'utf8'));
const places: Place[] = JSON.parse(await fsp.readFile(FILES.places, 'utf8'));
const destFile = JSON.parse(await fsp.readFile(FILES.destinations, 'utf8'));
const hansung = destFile.destinations.find((d: any) => d.name === '한성대학교') ?? destFile.destinations[0];

// ---------- 1. 유동인구 집계 ----------
/** cube: [요일묶음 2][시간대 4][인구 종류 3: 거주·직장·방문] 인원 합 */
type Acc = { cube: number[]; months: Set<string> };
const KIND_COLS = ['RESD_POPL_CNT', 'WRK_POPL_CNT', 'VIST_POPL_CNT'];
export const cubeIndex = (g: number, t: number, k: number) => (g * 4 + t) * 3 + k;
const acc = new Map<string, Acc>();
/** 월별 값 (고른 구역 화면용, 평균 인원): 셀 → 월 → [요일 2][시간대 4][지표 6] */
/** 시간대(08~12 · 13~16 · 17~20 · 21~24시)에 들어 있는 시간 수 */
const SLOT_HOURS = [5, 4, 4, 4];
const RAW_COLS = ['STAY_POPL_CNT', 'WALK_POPL_CNT', 'DRIV_POPL_CNT', 'RESD_POPL_CNT', 'WRK_POPL_CNT', 'VIST_POPL_CNT'];
const monthly = new Map<string, Map<string, number[]>>();
/** 그 달에서 요일묶음(0 월~목 / 1 금~일)에 해당하는 날 수 */
const dayCount = new Map<string, number>();
const daysIn = (ym: string, g: number) => {
  const k = `${ym}|${g}`;
  let n = dayCount.get(k);
  if (n === undefined) {
    const [y, m] = [+ym.slice(0, 4), +ym.slice(4)];
    n = 0;
    for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
      const w = new Date(y, m - 1, d).getDay(); // 0 일 ~ 6 토
      if ((w >= 1 && w <= 4) === (g === 0)) n++;
    }
    dayCount.set(k, n);
  }
  return n;
};
const rl = readline.createInterface({ input: fs.createReadStream(FILES.lguCsv, 'utf8'), crlfDelay: Infinity });
let col: Record<string, number> = {};
let first = true;
for await (const raw of rl) {
  const f = raw.replace(/^﻿/, '').split(',');
  if (first) {
    col = Object.fromEntries(f.map((h, i) => [h, i]));
    first = false;
    continue;
  }
  if (f.length < 5 || !(+f[col.Y_AXIS_WGS] > SEOUL_MIN_LAT)) continue;
  const [x, y] = toUtmk(+f[col.X_AXIS_WGS], +f[col.Y_AXIS_WGS]);
  const id = gridId(x, y);
  let a = acc.get(id);
  if (!a) acc.set(id, (a = { cube: new Array(24).fill(0), months: new Set() }));
  const g = DAY_GROUPS.indexOf(f[col.DYBY_NM] as any);
  const t = TIME_SLOTS.indexOf(f[col.TMZN_DIVS_NM] as any);
  if (g < 0 || t < 0) continue;
  // 누적 → 그 시간대 평균 인원
  const per = 1 / (daysIn(f[col.P_YYYYMM], g) * SLOT_HOURS[t]);
  KIND_COLS.forEach((k, i) => (a!.cube[cubeIndex(g, t, i)] += (+f[col[k]] || 0) * per));
  a.months.add(f[col.P_YYYYMM]);
  let byMonth = monthly.get(id);
  if (!byMonth) monthly.set(id, (byMonth = new Map()));
  let m = byMonth.get(f[col.P_YYYYMM]);
  if (!m) byMonth.set(f[col.P_YYYYMM], (m = new Array(48).fill(0)));
  RAW_COLS.forEach((k, i) => (m![(g * 4 + t) * 6 + i] += (+f[col[k]] || 0) * per));
}

// ---------- 1-1. 성별·연령 비율 (SECD 표: 셀 × 월 × 요일묶음 × 성별 × 연령, 시간대 없음) ----------
// 12개월 합으로 비율을 낸다. 성별·연령이 빈 행('모름', 2% 안팎)은 빼고 나머지끼리 나눈다
const demoSum = new Map<string, number[]>();
const demoIndex = (g: number, k: number, s: number, ag: number) => ((g * 3 + k) * 2 + s) * 6 + ag;
const SEX_CODES = ['MALE', 'FEMALE'];
{
  const rl2 = readline.createInterface({ input: fs.createReadStream(FILES.lguDemoCsv, 'utf8'), crlfDelay: Infinity });
  let c2: Record<string, number> = {};
  let head = true;
  for await (const raw of rl2) {
    const f = raw.replace(/^\uFEFF/, '').split(',');
    if (head) {
      c2 = Object.fromEntries(f.map((h, i) => [h, i]));
      head = false;
      continue;
    }
    if (f.length < 5 || !(+f[c2.Y_AXIS_WGS] > SEOUL_MIN_LAT)) continue;
    const s = SEX_CODES.indexOf(f[c2.SEX_DIVS_CD]);
    const ag = AGE_GROUPS.indexOf(f[c2.YY10_AGLV_ID] as any);
    const g = DAY_GROUPS.indexOf(f[c2.DYBY_NM] as any);
    if (s < 0 || ag < 0 || g < 0) continue;
    const id = gridId(...toUtmk(+f[c2.X_AXIS_WGS], +f[c2.Y_AXIS_WGS]));
    let d = demoSum.get(id);
    if (!d) demoSum.set(id, (d = new Array(72).fill(0)));
    KIND_COLS.forEach((k, i) => (d![demoIndex(g, i, s, ag)] += +f[c2[k]] || 0));
  }
}
/** 셀의 성별·연령 비율 — 그 요일·종류에 값이 없으면 같은 종류의 다른 요일, 그것도 없으면 고르게 */
const demoOf = (d: number[]) => {
  const out = new Array(72).fill(1 / 12);
  for (let k = 0; k < 3; k++) {
    const block = (g: number) => Array.from({ length: 12 }, (_, j) => d[(g * 3 + k) * 12 + j]);
    for (let g = 0; g < 2; g++) {
      let b = block(g);
      if (b.reduce((x, y) => x + y, 0) <= 0) b = block(1 - g);
      const sum = b.reduce((x, y) => x + y, 0);
      if (sum > 0) b.forEach((v, j) => (out[(g * 3 + k) * 12 + j] = +(v / sum).toFixed(4)));
    }
  }
  return out;
};

// ---------- 1-2. 튀는 50m 셀 퍼뜨리기 ----------
// 튀는 셀: 주변 8셀 중앙값의 SPIKE_RATIO 배 이상 · 평균 SPIKE_MIN 명 이상. 주변의 SPREAD_KEEP 배까지만 남기고 넘친 몫을 나눈다.
//  - 아파트 단지: 같은 단지 이름의 셀 전체에 고르게 (단지 사람들이 한 점에 모인 것으로 봄)
//  - 큰 건물·시설: 같은 건물(이름 또는 도로명 건물번호) 셀 + 한 칸 둘레에 (건물 셀은 두 배 몫)
//  - 그 밖: 반경 SPREAD_R 셀 안 셀들에 원래 인원 비율대로
// 인원·월별 값·성별연령 합계 모두 같은 몫으로 옮겨 총합과 구성이 그대로다.
const SPIKE_RATIO = 10;
const SPIKE_MIN = 20;
const SPREAD_KEEP = 3;
const SPREAD_R = 4;
const months = [...new Set([...monthly.values()].flatMap((m) => [...m.keys()]))].sort();
const fineIds = grid.map((g) => g.id);
const fineById = new Map(grid.map((g) => [g.id, g]));
/** 50m 셀 값 묶음: cube 24(평균 인원) · month 12×48(평균 인원) · demo 72(원본 합) */
const vecOf = (id: string) => {
  const a = acc.get(id);
  const n = a?.months.size || 1;
  const m = monthly.get(id);
  return {
    cube: (a?.cube ?? new Array(24).fill(0)).map((v) => v / n),
    month: months.flatMap((mo) => m?.get(mo) ?? new Array(48).fill(0)),
    demo: [...(demoSum.get(id) ?? new Array(72).fill(0))],
  };
};
const rawVec = new Map(fineIds.map((id) => [id, vecOf(id)]));
const newVec = new Map(fineIds.map((id) => [id, vecOf(id)]));
const fineTotal = (id: string) => rawVec.get(id)!.cube.reduce((a, b) => a + b, 0) / 8;
const ixy = (id: string) => id.match(/^SB(\d+)_(\d+)$/)!.slice(1).map(Number) as [number, number];
const around = (id: string, r: number) => {
  const [x, y] = ixy(id);
  const out: string[] = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if ((dx || dy) && fineById.has(`SB${x + dx}_${y + dy}`)) out.push(`SB${x + dx}_${y + dy}`);
  return out;
};
const spikes: { id: string; base: number }[] = [];
for (const id of fineIds) {
  const ns = around(id, 1).map(fineTotal).sort((a, b) => a - b);
  if (ns.length < 5) continue;
  const base = Math.max(1, ns[ns.length >> 1]);
  if (fineTotal(id) >= SPIKE_MIN && fineTotal(id) / base >= SPIKE_RATIO) spikes.push({ id, base });
}
const spikeSet = new Set(spikes.map((x) => x.id));

// 셀 가운데 점의 건물 (카카오 좌표→주소, 캐시) — 같은 이름 = 같은 단지·시설, 같은 도로명 번호 = 같은 건물
const addr = new Map<string, { name: string; road: string }>();
{
  const ids = new Set<string>();
  for (const { id } of spikes) for (const n of [id, ...around(id, 8)]) ids.add(n);
  const list = [...ids];
  const BATCH = 8;
  for (let i = 0; i < list.length; i += BATCH)
    await Promise.all(
      list.slice(i, i + BATCH).map(async (id) => {
        const g = fineById.get(id)!;
        const a = await coord2address(g.center.lng, g.center.lat).catch(() => null);
        const r = a?.road_address;
        // '○○아파트 101동', '○○아파트 상가동' → '○○아파트'
        const name = (r?.building_name ?? '').replace(/\s+(제?\d+동|[가-힣A-Za-z]*상가[가-힣]*|관리동|경비실|주차장|복지관|어린이집|노인정)$/, '').trim();
        addr.set(id, { name, road: r ? `${r.road_name} ${r.main_building_no}-${r.sub_building_no}` : '' });
      }),
    );
}
const APT_RE = /아파트|단지|APT|타운|캐슬|자이|푸르지오|래미안|힐스테이트|아이파크|e편한세상|센트레빌|위브|SK뷰|롯데캐슬|파크/i;
const spreadKind = new Map<string, 'apt' | 'building' | 'area'>();
for (const { id, base } of spikes) {
  const me = addr.get(id);
  const near = around(id, 8);
  const sameName = me?.name ? near.filter((n) => addr.get(n)?.name === me.name) : [];
  const sameRoad = me?.road ? near.filter((n) => addr.get(n)?.road === me.road) : [];
  let to: [string, number][]; // [셀, 가중치]
  let kind: 'apt' | 'building' | 'area';
  if (sameName.length && APT_RE.test(me!.name)) {
    kind = 'apt';
    to = [id, ...sameName].map((n) => [n, 1]);
  } else if (sameName.length || sameRoad.length) {
    kind = 'building';
    const body = [...new Set([id, ...sameName, ...sameRoad])];
    const ring = [...new Set(body.flatMap((n) => around(n, 1)))].filter((n) => !body.includes(n) && !spikeSet.has(n));
    to = [...body.map((n) => [n, 2] as [string, number]), ...ring.map((n) => [n, 1] as [string, number])];
  } else {
    kind = 'area';
    to = around(id, SPREAD_R)
      .filter((n) => !spikeSet.has(n))
      .map((n) => [n, fineTotal(n)] as [string, number])
      .filter(([, w]) => w > 0);
  }
  const wsum = to.reduce((a, [, w]) => a + w, 0);
  if (!wsum) continue; // 나눠 줄 곳이 없으면 그대로
  spreadKind.set(id, kind);
  const move = 1 - Math.min(1, (SPREAD_KEEP * base) / fineTotal(id));
  const src = rawVec.get(id)!;
  for (const key of ['cube', 'month', 'demo'] as const) {
    const v = src[key];
    const mine = newVec.get(id)![key];
    for (let i = 0; i < v.length; i++) mine[i] -= v[i] * move;
    for (const [n, w] of to) {
      const tgt = newVec.get(n)![key];
      for (let i = 0; i < v.length; i++) tgt[i] += (v[i] * move * w) / wsum;
    }
  }
}
{
  const kinds: Record<string, number> = {};
  for (const k of spreadKind.values()) kinds[k] = (kinds[k] ?? 0) + 1;
  console.log(`튀는 50m 셀 ${spikes.length}개 퍼뜨림`, kinds);
}

// ---------- 1-3. 50m → 200m 칸으로 합치기 ----------
interface Coarse {
  id: string;
  cx: number;
  cy: number;
  center: { lat: number; lng: number };
  corners: { lat: number; lng: number }[];
  dongCode: string;
  dongName: string;
  fine: string[];
  cube: number[];
  cubeRaw: number[];
  month: number[];
  demo: number[];
  spikeKids: number;
  spread: { apt: number; building: number; area: number };
}
const coarse = new Map<string, Coarse>();
for (const g of grid) {
  const id = gridId(g.cx, g.cy, CELL_SIZE);
  let c = coarse.get(id);
  if (!c) {
    const [ix, iy] = ixy(id);
    const [x, y] = [ix * CELL_SIZE, iy * CELL_SIZE];
    const corners = [
      [x, y],
      [x + CELL_SIZE, y],
      [x + CELL_SIZE, y + CELL_SIZE],
      [x, y + CELL_SIZE],
    ].map(([px, py]) => {
      const [lng, lat] = toWgs(px, py);
      return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    });
    const [lng, lat] = toWgs(x + CELL_SIZE / 2, y + CELL_SIZE / 2);
    c = {
      id, cx: x + CELL_SIZE / 2, cy: y + CELL_SIZE / 2, center: { lat: +lat.toFixed(6), lng: +lng.toFixed(6) }, corners,
      dongCode: '', dongName: '', fine: [], cube: new Array(24).fill(0), cubeRaw: new Array(24).fill(0),
      month: new Array(months.length * 48).fill(0), demo: new Array(72).fill(0), spikeKids: 0, spread: { apt: 0, building: 0, area: 0 },
    };
    coarse.set(id, c);
  }
  c.fine.push(g.id);
  const nv = newVec.get(g.id)!;
  const rv = rawVec.get(g.id)!;
  nv.cube.forEach((v, i) => (c!.cube[i] += v));
  rv.cube.forEach((v, i) => (c!.cubeRaw[i] += v));
  nv.month.forEach((v, i) => (c!.month[i] += v));
  nv.demo.forEach((v, i) => (c!.demo[i] += v));
  if (spikeSet.has(g.id)) c.spikeKids++;
  const k = spreadKind.get(g.id);
  if (k) c.spread[k]++;
}
// 행정동: 가장 많은 50m 셀이 속한 동
for (const c of coarse.values()) {
  const by = new Map<string, number>();
  for (const f of c.fine) {
    const g = fineById.get(f)!;
    by.set(g.dongCode, (by.get(g.dongCode) ?? 0) + 1);
  }
  const code = [...by.entries()].sort((a, b) => b[1] - a[1])[0][0];
  c.dongCode = code;
  c.dongName = fineById.get(c.fine.find((f) => fineById.get(f)!.dongCode === code)!)!.dongName;
}
const coarseList = [...coarse.values()];
console.log(`50m 셀 ${grid.length}개 → 200m 칸 ${coarseList.length}개`);

// ---------- 2. 셀 내부 시설 ----------
const cellOf = (lng: number, lat: number) => gridId(...toUtmk(lng, lat), CELL_SIZE);
const CATS: PlaceCat[] = ['food', 'cafe', 'conv', 'hosp', 'pharm', 'subway', 'mart', 'gym'];
const poiByCell = new Map<string, { poi: Cell['poi']; depts: Set<string> }>();
for (const p of places) {
  const id = cellOf(p.lng, p.lat);
  let e = poiByCell.get(id);
  if (!e) {
    e = { poi: Object.fromEntries([...CATS, 'bar'].map((k) => [k, 0])) as Cell['poi'], depts: new Set() };
    poiByCell.set(id, e);
  }
  e.poi[p.cat]++;
  if (p.bar) e.poi.bar++;
  if (p.dept) e.depts.add(p.dept);
}

// ---------- 3. 셀 특성 ----------
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const rows = coarseList.map((g) => {
  const pop = g.cube.map((v) => +v.toFixed(1));
  const slots = [0, 1].map((d) => [0, 1, 2, 3].map((t) => +(pop[cubeIndex(d, t, 0)] + pop[cubeIndex(d, t, 1)] + pop[cubeIndex(d, t, 2)]).toFixed(1))) as SlotMatrix;
  const kinds = [0, 1, 2].map((k) => pop.filter((_, i) => i % 3 === k).reduce((s, x) => s + x, 0));
  const kindSum = kinds.reduce((s, x) => s + x, 0) || 1;
  const total = avg(slots.flat());
  const e = poiByCell.get(g.id);
  const poi = e?.poi ?? (Object.fromEntries([...CATS, 'bar'].map((k) => [k, 0])) as Cell['poi']);
  // 녹지 판정용: 반경 300m 시설 수
  const near300 = places.filter((p) => Math.abs(p.lat - g.center.lat) < 0.003 && Math.abs(p.lng - g.center.lng) < 0.004 && distM(g.center, p) <= 300).length;
  return {
    g,
    slots,
    pop,
    total,
    wdEvening: (slots[0][2] + slots[0][3]) / 2,
    wdNight: slots[0][3],
    weNight: slots[1][3],
    weekendSurge: slots[0][3] > 0 ? slots[1][3] / slots[0][3] : 1,
    nightShare: total > 0 ? avg([slots[0][3], slots[1][3]]) / total / 4 : 0,
    workShare: kinds[1] / kindSum,
    kindShare: { resident: kinds[0] / kindSum, worker: kinds[1] / kindSum, visitor: kinds[2] / kindSum },
    poi,
    depts: [...(e?.depts ?? [])].sort(),
    near300,
  };
});

// 분위수 유틸
function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function toLevel(x: number, q: (p: number) => number): Level {
  if (x <= q(0.2)) return 1;
  if (x <= q(0.4)) return 2;
  if (x <= q(0.6)) return 3;
  if (x <= q(0.8)) return 4;
  return 5;
}

const qTotalAll = quantiles(rows.map((r) => r.total));
const isGreen = (r: (typeof rows)[number]) => r.near300 <= 2 && r.total <= qTotalAll(0.25);
const live = rows.filter((r) => !isGreen(r));
const Q = {
  total: quantiles(live.map((r) => r.total)),
  wdEvening: quantiles(live.map((r) => r.wdEvening)),
  wdNight: quantiles(live.map((r) => r.wdNight)),
  weNight: quantiles(live.map((r) => r.weNight)),
  work: quantiles(live.map((r) => r.workShare)),
  nightShare: quantiles(live.map((r) => r.nightShare)),
  surge: quantiles(live.map((r) => r.weekendSurge)),
  eat: quantiles(live.map((r) => r.poi.food + r.poi.cafe)),
  hosp: quantiles(live.map((r) => r.poi.hosp)),
  depts: quantiles(live.map((r) => r.depts.length)),
  bar: quantiles(live.map((r) => r.poi.bar)),
};

function classify(r: (typeof rows)[number]): { type: CellType; tags: CellType[] } {
  if (isGreen(r)) return { type: 'green', tags: [] };
  const eat = r.poi.food + r.poi.cafe;
  const daily = eat + r.poi.conv + r.poi.pharm + r.poi.hosp;
  const hit: Record<Exclude<CellType, 'green'>, boolean> = {
    // 절대 하한 + 성북구 내 상대 분위수를 함께 사용 (데이터 밀도가 바뀌어도 분류가 유지되도록)
    night: r.poi.bar >= Math.max(2, Q.bar(0.9)) && r.nightShare >= Q.nightShare(0.88) && r.weekendSurge >= Q.surge(0.7),
    office: r.workShare >= Q.work(0.9),
    medical: r.poi.hosp >= Math.max(2, Q.hosp(0.93)) && r.depts.length >= Math.max(2, Q.depts(0.9)),
    commercial: eat >= Math.max(6, Q.eat(0.85)) && r.wdEvening >= Q.wdEvening(0.5),
    living: r.total >= Q.total(0.4) || daily >= 4,
    quiet: true,
  };
  const order = ['night', 'office', 'medical', 'commercial', 'living', 'quiet'] as const;
  const type = order.find((k) => hit[k])!;
  const tags = order.filter((k) => k !== type && k !== 'quiet' && k !== 'living' && hit[k]);
  return { type, tags };
}

const cells: GeneratedCell[] = rows.map((r) => {
  const { type, tags } = classify(r);
  const green = type === 'green';
  return {
    id: r.g.id,
    cx: r.g.cx,
    cy: r.g.cy,
    center: r.g.center,
    corners: r.g.corners,
    dongCode: r.g.dongCode,
    dongName: r.g.dongName,
    lguId: r.g.fine.length === 1 ? fineById.get(r.g.fine[0])!.lguId : `50m 셀 ${r.g.fine.length}개`,
    spike: r.g.spikeKids || undefined,
    spread: r.g.spikeKids ? r.g.spread : undefined,
    popRaw: r.g.cubeRaw.some((v, i) => Math.abs(v - r.g.cube[i]) >= 0.05) ? r.g.cubeRaw.map((v) => +v.toFixed(1)) : undefined,
    demo: demoOf(r.g.demo),
    slots: r.slots,
    pop: r.pop,
    total: +r.total.toFixed(1),
    kindShare: {
      resident: +r.kindShare.resident.toFixed(3),
      worker: +r.kindShare.worker.toFixed(3),
      visitor: +r.kindShare.visitor.toFixed(3),
    },
    weekendSurge: +r.weekendSurge.toFixed(2),
    nightShare: +r.nightShare.toFixed(3),
    levels: {
      total: green ? 1 : toLevel(r.total, Q.total),
      wdEvening: green ? 1 : toLevel(r.wdEvening, Q.wdEvening),
      wdNight: green ? 1 : toLevel(r.wdNight, Q.wdNight),
      weNight: green ? 1 : toLevel(r.weNight, Q.weNight),
    },
    poi: r.poi,
    depts: r.depts,
    type,
    tags,
    commuteMin: estimateCommute(r.g.center, hansung).min,
  };
});

// ---------- 4. 행정동 통계 ----------
const byDong = new Map<string, GeneratedCell[]>();
for (const c of cells) {
  if (!byDong.has(c.dongCode)) byDong.set(c.dongCode, []);
  byDong.get(c.dongCode)!.push(c);
}
const dongRaw = [...byDong.entries()].map(([code, cs]) => {
  const liveCs = cs.filter((c) => c.type !== 'green');
  const useCs = liveCs.length ? liveCs : cs;
  const center = { lat: avg(useCs.map((c) => c.center.lat)), lng: avg(useCs.map((c) => c.center.lng)) };
  const wdEvening = avg(useCs.map((c) => (c.slots[0][2] + c.slots[0][3]) / 2));
  // 동 단위 과밀은 동 평균으로 판단 (개별 번화 셀은 7단계 셀 필터에서 거른다)
  const weNight = avg(useCs.map((c) => c.slots[1][3]));
  const typeCounts: DongStat['typeCounts'] = {};
  for (const c of cs) typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;
  return { code, name: cs[0].dongName, center, cellCount: cs.length, wdEvening, weNight, typeCounts };
});
// 활동량·혼잡도는 셀과 같은 척도(전체 셀 분위수)로 평가
const dongStats: DongStat[] = dongRaw.map((d) => ({
  code: d.code,
  name: d.name,
  center: { lat: +d.center.lat.toFixed(6), lng: +d.center.lng.toFixed(6) },
  cellCount: d.cellCount,
  commuteMin: estimateCommute(d.center, hansung).min,
  wdEvening: toLevel(d.wdEvening, Q.wdEvening),
  weNight: toLevel(d.weNight, Q.weNight),
  typeCounts: d.typeCounts,
}));

// ---------- 5. 저장 ----------
const placeCounts: Record<string, number> = {};
for (const p of places) placeCounts[p.cat] = (placeCounts[p.cat] ?? 0) + 1;
const b = destFile.bbox;
const meta: Meta = {
  generatedAt: new Date().toISOString(),
  source: { places: destFile.source, population: 'lguplus' },
  cellSize: CELL_SIZE,
  destinations: destFile.destinations,
  bbox: { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] },
  placeCounts,
};
await fsp.writeFile(FILES.cells, JSON.stringify(cells));
await fsp.writeFile(FILES.dongStats, JSON.stringify(dongStats));
await fsp.writeFile(FILES.meta, JSON.stringify(meta, null, 2));

const tc: Record<string, number> = {};
for (const c of cells) tc[c.type] = (tc[c.type] ?? 0) + 1;
console.log(`칸 ${cells.length}개 분류`, tc, `· 튀는 50m 셀이 든 칸 ${cells.filter((c) => c.spike).length}개`);
console.log(`행정동 ${dongStats.length}개`, dongStats.map((d) => `${d.name}(${d.commuteMin}분)`).join(' '));
