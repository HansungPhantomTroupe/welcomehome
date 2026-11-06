/**
 * LG U+ 셀 데이터의 50m 셀로 격자를 만든다 (원본 단위 — 화면용 200m 칸은 buildFeatures 에서 합친다) (EPSG:5179 50m 격자에 정렬된 셀 중심 좌표).
 * 서울 행만 쓰고(같은 이름의 나주·진주 성북동 제외), 행정동 코드는 서울 열린데이터광장 코드정보로 붙인다.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { FINE_SIZE as CELL_SIZE, FILES, GEN_DIR, SEOUL_MIN_LAT, toUtmk, toWgs } from '../src/config';

export interface GridCell {
  id: string;
  cx: number;
  cy: number;
  center: { lat: number; lng: number };
  corners: { lat: number; lng: number }[];
  dongCode: string;
  dongName: string;
  /** LG U+ 원본 CELL_ID */
  lguId: string;
}

/** 셀ID: 좌하단 5179 좌표를 셀 크기로 나눈 인덱스 (기본: LG U+ 50m 셀) */
export const gridId = (x: number, y: number, size = CELL_SIZE) => `SB${Math.floor(x / size)}_${Math.floor(y / size)}`;

// 행정동 이름 → 10자리 코드 (생활인구 8자리 코드 + '00', 기존 adm_cd2 형식)
const dongInfo: Record<string, { name: string }> = JSON.parse(await fsp.readFile(FILES.dongAgeSex, 'utf8'));
const codeOf = new Map(Object.entries(dongInfo).map(([code, d]) => [d.name, `${code}00`]));

const cells = new Map<string, GridCell>();
// 동 경계에 걸친 셀은 동마다 따로 행이 있다 (값이 동별로 나뉘어 있음 — 합치면 셀 전체).
// 셀의 동은 인원이 더 많은 쪽으로 정한다
const dongPop = new Map<string, Map<string, number>>();
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
  const lat = +f[col.Y_AXIS_WGS];
  const lng = +f[col.X_AXIS_WGS];
  if (!(lat > SEOUL_MIN_LAT)) continue;
  const [px, py] = toUtmk(lng, lat);
  // 셀 중심은 50m 격자의 한가운데 — 반올림으로 정렬 오차 제거
  const cx = Math.round((px - CELL_SIZE / 2) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2;
  const cy = Math.round((py - CELL_SIZE / 2) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2;
  const id = gridId(cx, cy);
  const name = f[col.ADNG_NM];
  const dp = dongPop.get(id) ?? dongPop.set(id, new Map()).get(id)!;
  dp.set(name, (dp.get(name) ?? 0) + (+f[col.STAY_POPL_CNT] || 0) + (+f[col.WALK_POPL_CNT] || 0) + (+f[col.DRIV_POPL_CNT] || 0));
  if (cells.has(id)) continue;
  const x = cx - CELL_SIZE / 2;
  const y = cy - CELL_SIZE / 2;
  const corners = [
    [x, y],
    [x + CELL_SIZE, y],
    [x + CELL_SIZE, y + CELL_SIZE],
    [x, y + CELL_SIZE],
  ].map(([gx, gy]) => {
    const [g, t] = toWgs(gx, gy);
    return { lat: +t.toFixed(6), lng: +g.toFixed(6) };
  });
  const [g, t] = toWgs(cx, cy);
  cells.set(id, { id, cx, cy, center: { lat: +t.toFixed(6), lng: +g.toFixed(6) }, corners, dongCode: codeOf.get(name) ?? name, dongName: name, lguId: f[col.CELL_ID] });
}

for (const [id, dp] of dongPop) {
  if (dp.size < 2) continue;
  const name = [...dp.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const c = cells.get(id)!;
  c.dongName = name;
  c.dongCode = codeOf.get(name) ?? name;
}
console.log(`동 경계에 걸친 셀 ${[...dongPop.values()].filter((d) => d.size > 1).length}개 — 인원이 많은 동으로`);

await fsp.mkdir(GEN_DIR, { recursive: true });
await fsp.writeFile(FILES.grid, JSON.stringify([...cells.values()]));
const perDong: Record<string, number> = {};
for (const c of cells.values()) perDong[c.dongName] = (perDong[c.dongName] ?? 0) + 1;
const missing = [...new Set([...cells.values()].filter((c) => !codeOf.has(c.dongName)).map((c) => c.dongName))];
console.log(`셀 ${cells.size}개 생성`, perDong, missing.length ? `코드 없음: ${missing}` : '');
