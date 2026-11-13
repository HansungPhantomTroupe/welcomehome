#!/usr/bin/env node
/**
 * API 명세(docs/API.md) 검사기 — 서버가 웹이 기대하는 모양으로 데이터를 주는지 확인한다.
 *
 *   node tools/api-check.mjs                       # http://localhost:4000
 *   node tools/api-check.mjs http://10.0.0.5:8080  # 다른 서버
 *   node tools/api-check.mjs --verbose             # 문제 예시를 전부 출력
 *
 * 필요: Node 18 이상 (외부 패키지 없음). 문제가 하나라도 있으면 종료 코드 1.
 */

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:4000').replace(/\/$/, '');
const VERBOSE = args.includes('--verbose');
const SHOW = VERBOSE ? Infinity : 5; // 항목마다 보여 줄 예시 수

// ---------------------------------------------------------------- 결과 모으기
const results = []; // { section, ok, msg, examples[] }
let section = '';
const problems = new Map(); // `${section}|${msg}` → { count, examples }

function bad(msg, example) {
  const k = `${section}|${msg}`;
  const p = problems.get(k) ?? problems.set(k, { section, msg, count: 0, examples: [] }).get(k);
  p.count++;
  if (example !== undefined && p.examples.length < SHOW) p.examples.push(example);
}
function check(cond, msg, example) {
  if (!cond) bad(msg, example);
  return !!cond;
}
function note(msg) {
  results.push({ section, info: msg });
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isInteger(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 157) + '…' : s;
};

async function get(path) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(BASE + path);
  } catch (e) {
    return { netError: `연결 실패: ${e.cause?.code ?? e.message}`, ms: Date.now() - t0 };
  }
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON 아님 */
  }
  return { status: r.status, headers: r.headers, json, text, ms: Date.now() - t0, bytes: text.length };
}

// ---------------------------------------------------------------- 상수 (docs/API.md)
const POI_KEYS = ['food', 'cafe', 'conv', 'hosp', 'pharm', 'subway', 'mart', 'gym', 'bar'];
const LEVEL_KEYS = ['total', 'wdEvening', 'wdNight', 'weNight'];
const ID_RE = /^SB(\d+)_(\d+)$/;

function inPolygon(p, poly) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) r = !r;
  }
  return r;
}
const isLatLng = (x) => isObj(x) && isNum(x.lat) && isNum(x.lng) && x.lat > 33 && x.lat < 39 && x.lng > 124 && x.lng < 132;

// ---------------------------------------------------------------- 1. bootstrap
async function checkBootstrap() {
  section = '1. GET /api/bootstrap';
  const res = await get('/api/bootstrap');
  if (res.netError) return bad(res.netError), null;
  if (!check(res.status === 200, '상태 코드가 200 이어야 함', `받은 상태 ${res.status}: ${short(res.json ?? res.text)}`)) return null;
  if (!check(isObj(res.json), '본문이 JSON 객체여야 함', short(res.text))) return null;
  note(`응답 ${(res.bytes / 1e6).toFixed(1)}MB, ${res.ms}ms`);
  const cc = res.headers.get('cache-control') ?? '';
  if (!/no-cache/.test(cc)) note(`참고: Cache-Control 에 no-cache 권장 (지금: ${cc || '없음'})`);

  const d = res.json;
  for (const k of ['cells', 'dongStats']) check(Array.isArray(d[k]) && d[k].length > 0, `"${k}" 가 비어 있지 않은 배열이어야 함`, short(d[k]));
  check(isObj(d.meta), '"meta" 가 객체여야 함', short(d.meta));
  if (!Array.isArray(d.cells) || !Array.isArray(d.dongStats) || !isObj(d.meta)) return null;
  note(`칸 ${d.cells.length}개, 행정동 ${d.dongStats.length}개`);
  if ('places' in d) note(`참고: places 는 이제 보내지 않아도 됨 (지금 ${Array.isArray(d.places) ? d.places.length + '개' : '있음'})`);

  // ---- 1-3 행정동
  section = '1-2. dongStats';
  const dongCodes = new Set();
  for (const [n, g] of d.dongStats.entries()) {
    const at = `dongStats[${n}]`;
    if (!check(isObj(g), '항목이 객체여야 함', at)) continue;
    check(typeof g.code === 'string' && g.code.length > 0, 'code 는 문자열', `${at}.code = ${short(g.code)}`);
    check(typeof g.name === 'string' && g.name.length > 0, 'name 은 문자열', `${at}.name = ${short(g.name)}`);
    check(!dongCodes.has(g.code), 'code 가 중복됨', g.code);
    dongCodes.add(g.code);
  }
  note(`${d.dongStats.length}개 확인`);

  // ---- 1-4 meta
  section = '1-3. meta';
  const m = d.meta;
  if (check(Array.isArray(m.destinations) && m.destinations.length > 0, 'destinations 는 비어 있지 않은 배열', short(m.destinations)))
    for (const [n, x] of m.destinations.entries())
      check(isObj(x) && typeof x.name === 'string' && x.name && isLatLng(x), 'destinations[] 는 { name, lat, lng } (lat·lng 는 한국 범위 숫자)', `destinations[${n}] = ${short(x)}`);
  check(isObj(m.source) && ['kakao', 'mock'].includes(m.source.places), 'source.places 는 "kakao" 또는 "mock"', short(m.source));
  note('destinations · source 확인');

  // ---- 1-1 칸
  section = '1-1. cells';
  const ids = new Set();
  const ij = new Set();
  const goodCells = [];
  for (const [n, c] of d.cells.entries()) {
    const at = `cells[${n}]${c?.id ? ` (${c.id})` : ''}`;
    if (!check(isObj(c), '항목이 객체여야 함', at)) continue;
    let ok = true;
    const t = (cond, msg, ex) => (check(cond, msg, ex) ? true : (ok = false));

    // id
    const mm = typeof c.id === 'string' ? c.id.match(ID_RE) : null;
    t(mm, 'id 는 "SB{행}_{열}" 형식 (예: SB4782_9741)', `${at}.id = ${short(c.id)}`);
    t(!ids.has(c.id), 'id 가 중복됨', c.id);
    ids.add(c.id);
    if (mm) {
      const key = `${+mm[1]},${+mm[2]}`;
      t(!ij.has(key), '행·열 번호가 다른 칸과 겹침', c.id);
      ij.add(key);
    }
    // 위치
    t(isLatLng(c.center), 'center 는 { lat, lng } 숫자 (한국 범위)', `${at}.center = ${short(c.center)}`);
    const cornersOk = Array.isArray(c.corners) && c.corners.length === 4 && c.corners.every(isLatLng);
    t(cornersOk, 'corners 는 { lat, lng } 4개', `${at}.corners = ${short(c.corners)}`);
    if (cornersOk && isLatLng(c.center)) t(inPolygon(c.center, c.corners), 'center 가 corners 사각형 안에 있어야 함 (꼭짓점 순서 확인: 둘레 순서)', at);
    // 행정동
    t(typeof c.dongCode === 'string' && dongCodes.has(c.dongCode), 'dongCode 가 dongStats[].code 중 하나여야 함', `${at}.dongCode = ${short(c.dongCode)}`);
    t(typeof c.dongName === 'string' && c.dongName.length > 0, 'dongName 은 문자열', `${at}.dongName = ${short(c.dongName)}`);
    // 인구
    const slotsOk = Array.isArray(c.slots) && c.slots.length === 2 && c.slots.every((r) => Array.isArray(r) && r.length === 4 && r.every((v) => isNum(v) && v >= 0));
    t(slotsOk, 'slots 는 [2][4] 0 이상 숫자', `${at}.slots = ${short(c.slots)}`);
    const popOk = Array.isArray(c.pop) && c.pop.length === 24 && c.pop.every((v) => isNum(v) && v >= 0);
    t(popOk, 'pop 은 0 이상 숫자 24개', `${at}.pop 길이 ${c.pop?.length}`);
    if (slotsOk && popOk)
      for (let dd = 0; dd < 2; dd++)
        for (let tt = 0; tt < 4; tt++) {
          const s = c.pop[(dd * 4 + tt) * 3] + c.pop[(dd * 4 + tt) * 3 + 1] + c.pop[(dd * 4 + tt) * 3 + 2];
          const want = c.slots[dd][tt];
          t(near(s, want, Math.max(0.5, want * 0.01)), 'slots[d][t] = pop 의 같은 (d,t) 거주+직장+방문 합 이어야 함', `${at} d=${dd} t=${tt}: slots ${want}, pop 합 ${+s.toFixed(2)}`);
        }
    const demoOk = Array.isArray(c.demo) && c.demo.length === 72 && c.demo.every((v) => isNum(v) && v >= 0 && v <= 1);
    t(demoOk, 'demo 는 0~1 숫자 72개', `${at}.demo 길이 ${c.demo?.length}`);
    if (demoOk)
      for (let dd = 0; dd < 2; dd++)
        for (let k = 0; k < 3; k++) {
          let s = 0;
          for (let sx = 0; sx < 2; sx++) for (let a = 0; a < 6; a++) s += c.demo[((dd * 3 + k) * 2 + sx) * 6 + a];
          // 그 인구가 0명이면 비율이 전부 0 일 수 있음
          const kindPop = popOk ? [0, 1, 2, 3].reduce((acc, tt) => acc + c.pop[(dd * 4 + tt) * 3 + k], 0) : 1;
          if (kindPop > 0 || s > 0) t(near(s, 1, 0.02), 'demo 의 같은 (요일묶음, 인구 종류) 12개 합 = 1', `${at} d=${dd} k=${k}: 합 ${s.toFixed(3)}`);
        }
    if (c.popRaw !== undefined) t(Array.isArray(c.popRaw) && c.popRaw.length === 24 && c.popRaw.every((v) => isNum(v) && v >= 0), '(선택) popRaw 는 있으면 0 이상 숫자 24개', `${at}.popRaw 길이 ${c.popRaw?.length}`);
    const ks = c.kindShare;
    const ksOk = isObj(ks) && ['resident', 'worker', 'visitor'].every((k) => isNum(ks[k]) && ks[k] >= 0 && ks[k] <= 1);
    t(ksOk, 'kindShare 는 { resident, worker, visitor } 0~1', `${at}.kindShare = ${short(ks)}`);
    if (ksOk && ks.resident + ks.worker + ks.visitor > 0) t(near(ks.resident + ks.worker + ks.visitor, 1, 0.01), 'kindShare 합 = 1', `${at}: 합 ${(ks.resident + ks.worker + ks.visitor).toFixed(3)}`);
    t(isObj(c.levels) && LEVEL_KEYS.every((k) => isInt(c.levels[k]) && c.levels[k] >= 1 && c.levels[k] <= 5), `levels 는 { ${LEVEL_KEYS.join(', ')} } 1~5 정수`, `${at}.levels = ${short(c.levels)}`);
    // 시설
    const poiOk = isObj(c.poi) && POI_KEYS.every((k) => isInt(c.poi[k]) && c.poi[k] >= 0);
    t(poiOk, `poi 는 { ${POI_KEYS.join(', ')} } 0 이상 정수`, `${at}.poi = ${short(c.poi)}`);
    if (poiOk) t(c.poi.bar <= c.poi.food, 'poi.bar(술집) 는 poi.food(음식점) 이하 (술집은 음식점의 일부)', `${at}: bar ${c.poi.bar}, food ${c.poi.food}`);
    t(Array.isArray(c.depts) && c.depts.every((x) => typeof x === 'string') && new Set(c.depts).size === c.depts.length, 'depts 는 중복 없는 문자열 배열 (없으면 [])', `${at}.depts = ${short(c.depts)}`);
    if (poiOk && Array.isArray(c.depts) && c.poi.hosp === 0) t(c.depts.length === 0, '병원이 0곳인데 진료과가 있음', `${at}: depts ${short(c.depts)}`);
    // 가까운 시설 거리
    const nm = c.nearM;
    const nmOk = isObj(nm) && POI_KEYS.every((k) => nm[k] === null || (isInt(nm[k]) && nm[k] >= 0));
    t(nmOk, `nearM 은 { ${POI_KEYS.join(', ')} } 0 이상 정수(m) 또는 null`, `${at}.nearM = ${short(nm)}`);
    if (nmOk && poiOk)
      for (const k of POI_KEYS)
        if (c.poi[k] > 0) t(nm[k] !== null && nm[k] <= 150, '칸 안에 그 시설이 있으면(poi > 0) nearM 은 150m 이하 (칸 중심~꼭짓점 약 141m)', `${at}: poi.${k} ${c.poi[k]}, nearM.${k} ${nm[k]}`);
    const ns = c.nearSubway;
    const nsOk = ns === null || (isObj(ns) && typeof ns.name === 'string' && ns.name.length > 0 && isInt(ns.m) && ns.m >= 0);
    t(nsOk, 'nearSubway 는 { name, m } 또는 null', `${at}.nearSubway = ${short(ns)}`);
    if (nsOk && nmOk) t(ns === null ? nm.subway === null : ns.m === nm.subway, 'nearSubway.m 은 nearM.subway 와 같아야 함', `${at}: nearSubway ${short(ns)}, nearM.subway ${nm.subway}`);
    if (ok) goodCells.push(c);
  }
  note(`${d.cells.length}개 확인 (형식 · slots=pop 합 · demo 합 1 · kindShare 합 1 · 격자 번호 · 가까운 시설 거리)`);

  // 격자: 같은 행·열 번호 간격 = 칸 하나
  if (goodCells.length > 1) {
    const byIJ = new Map(goodCells.map((c) => { const [, i, j] = c.id.match(ID_RE); return [`${+i},${+j}`, c]; }));
    let tested = 0;
    for (const c of goodCells) {
      const [, i, j] = c.id.match(ID_RE);
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const nb = byIJ.get(`${+i + di},${+j + dj}`);
        if (!nb) continue;
        tested++;
        const dist = Math.hypot((c.center.lat - nb.center.lat) * 111000, (c.center.lng - nb.center.lng) * 88200);
        check(near(dist, 200, 40), '행 또는 열 번호가 1 차이 나는 칸은 중심이 약 200m 떨어져 있어야 함 (번호가 격자 위치와 맞는지)', `${c.id} ↔ ${nb.id}: ${dist.toFixed(0)}m`);
      }
    }
    if (!tested) bad('행·열 번호로 이웃 칸을 하나도 찾을 수 없음 (번호가 격자 위치를 나타내야 함)');
  }

  return true;
}

// ---------------------------------------------------------------- 실행
console.log(`API 명세 검사: ${BASE}\n`);
await checkBootstrap();

// ---------------------------------------------------------------- 보고
const order = ['1. GET /api/bootstrap', '1-1. cells', '1-2. dongStats', '1-3. meta'];
const sections = [...new Set([...order, ...results.map((r) => r.section), ...[...problems.values()].map((p) => p.section)])];
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failed = 0;
for (const s of sections) {
  const ps = [...problems.values()].filter((p) => p.section === s);
  const infos = results.filter((r) => r.section === s);
  if (!ps.length && !infos.length) continue;
  console.log(ps.length ? red(`✗ ${s}`) : green(`✓ ${s}`));
  for (const r of infos) console.log(dim(`    ${r.info}`));
  for (const p of ps) {
    failed++;
    console.log(red(`    • ${p.msg}`) + (p.count > 1 ? ` (${p.count}건)` : ''));
    for (const e of p.examples) console.log(`        ${e}`);
    if (p.count > p.examples.length && p.examples.length) console.log(dim(`        … 외 ${p.count - p.examples.length}건 (--verbose 로 전부 보기)`));
  }
}
console.log('\n' + (failed ? red(`문제 ${failed}종류`) : green('모두 통과')));
process.exit(failed ? 1 : 0);
