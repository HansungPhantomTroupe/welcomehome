/**
 * AI 조건 찾기 도우미 — 사용자의 말을 받아 "조건 찾기" 목록 전체를 다시 짠다.
 *
 * - 이미 화면에서 다룰 수 있는 조건(사람·가게/시설·진료과·동네 성격·이동 시간·행정동·매물)은 그 형식으로,
 *   그걸로 안 되는 것(주변 칸 보기 등)만 custom 스크립트로.
 * - 필요하면 여러 조건으로 나누고, 기존 조건을 유지·수정·삭제한다.
 * - AI는 답 안에 ```json { "stack": [...] } ``` 블록 하나로 새 목록을 낸다. 서버가 custom 스크립트를 격리 실행기로 돌려 보고,
 *   형식 오류·실행 오류·통과 0곳/전부면 AI에게 알려 고치게 한다 (최대 3번).
 *   (도구 호출 대신 글 형식을 쓰는 건, ChatGPT 플랜 경로의 도구 지원 범위가 아직 미리보기라서)
 */
import { CUSTOM_API_DOC } from '../../shared/customApi';
import type { Cell, DongStat } from '../../shared/types';
import { respond, type InputMsg } from './chatgpt';
import { runCustom, validateScript, type CustomScript } from './customFilter';

const MAX_FIX = 3;
const MAX_HISTORY = 24;

export interface ChatContext {
  /** 지금 조건 목록 (위에서부터 AND) — 웹이 AI용 항목으로 바꿔 보냄 */
  stack: Record<string, unknown>[];
  /** 사용자가 정의한 동네 성격 */
  categories: { id: string; label: string; desc?: string }[];
  /** 지금 걸러진 칸들 vs 전체 칸 비교 (웹이 계산한 요약 숫자) — 조건이 없거나 전부 통과면 없음 */
  insight?: {
    count: number;
    total: number;
    rows: { label: string; sel: number; all: number; pct: number | null }[];
    /** 매물끼리 비교 (매물이 모자라면 없음) */
    listing?: { basis: string; selN: number; cmpN: number; rows: { label: string; sel: number; cmp: number }[] };
  };
  /** 사용자가 지도에서 지금 고른 구역 하나 — 없으면 고른 곳 없음 */
  selected?: {
    name: string;
    dong: string;
    category: string | null;
    /** 지금 조건을 통과하는지 (조건이 없으면 null) */
    passes: boolean | null;
    filters: { text: string; ok: boolean; detail: string }[];
    rows: { label: string; sel: number; all: number; pct: number | null }[];
    /** 이 구역 매물 한 줄 요약 (화면에서 고른 거래 종류 기준) */
    listings: string[];
  };
}

const EXAMPLE_CUSTOM = {
  type: 'custom',
  name: '반경 안 상권',
  description: '반경 안(자기 칸 포함) 음식점·카페·편의점 수',
  params: [
    { key: 'radius', label: '반경', type: 'number', default: 400, min: 200, max: 1000, step: 100, unit: 'm' },
    { key: 'minShops', label: '반경 안 가게 수', type: 'number', default: 30, min: 0, max: 300, step: 5, unit: '곳 이상' },
  ],
  code: `function filter(cell, ctx) {
  const p = ctx.params;
  const shops = [cell, ...ctx.near(cell, p.radius)].reduce((s, n) => s + ctx.poi(n, ['food', 'cafe', 'conv']), 0);
  return { pass: shops >= p.minShops, value: shops };
}`,
};

function dataSummary(cells: Cell[], size: number) {
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const tot = cells.map((c) => c.total).sort((a, b) => a - b);
  const poiSum: Record<string, number> = {};
  for (const c of cells) for (const [k, v] of Object.entries(c.poi ?? {})) poiSum[k] = (poiSum[k] ?? 0) + (v as number);
  return [
    `칸: ${cells.length}개, 한 변 ${size}m (서울 한성대 주변 + 이태원역 주변 두 덩어리)`,
    `인구: LG U+ 2025년 휴대폰 기반 유동인구, 시간대 평균 인원. total 분포 10%=${q(tot, 0.1).toFixed(0)}, 50%=${q(tot, 0.5).toFixed(0)}, 90%=${q(tot, 0.9).toFixed(0)}, 최대=${tot.at(-1)!.toFixed(0)}`,
    `시설 수 합계: ${Object.entries(poiSum).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  ].join('\n');
}

function instructions(cells: Cell[], size: number, dongs: DongStat[], dests: string[], cx: ChatContext, personas: string, listings: string) {
  return `너는 동네 탐색 지도 앱의 안내 도우미다. 사용자가 이 사이트를 쓰는 목적을 듣고, 필요한 정보를 질문으로 모은 뒤, 지도 칸을 거르는 **조건 목록 전체**를 짜서 제안한다.

[데이터]
${dataSummary(cells, size)}

[조건 목록]
- 위에서부터 모든 켜진 조건(enabled)을 만족하는 칸만 남는다 (AND).
- 답에 \`\`\`json 블록 하나로 { "stack": [항목, ...] } 를 낸다 = 바꾼 뒤의 목록 전체. 블록에 없는 기존 조건은 삭제된다.
- 목록을 바꿀 필요가 없는 답(질문, 되묻기)에는 json 블록을 넣지 않는다.

[항목 형식]
- 기존 조건 그대로: { "keep": "<id>" }  (켜고 끄기만: { "keep": "<id>", "enabled": false })
- 기존 조건 수정: 아래 형식에 "id": "<기존 id>" 를 넣는다. 새 조건은 id 없이.
- 모든 항목에 "enabled" 생략 가능 (기본 true).
공통 기준 필드: "op": "gte"(이상) | "lte"(이하) | "between"(value~value2), "mode": "abs"(값 그대로) | "pct"(전체 칸 중 gte=상위·lte=하위 value%) | "level"(사람 수 단계), "value", "value2"
1) 사람: { "type":"pop", "days":[0 평일(월~목),1 주말(금~일)], "times":[0 08~12시,1 13~16시,2 17~20시,3 21~24시], "kinds":[0 거주,1 직장,2 방문], "ages":[0 20대 미만,1 20대,2 30대,3 40대,4 50대,5 60대 이상], "sexes":[0 남,1 여], "measure":"count"(인원)|"share"(비율 %), op, mode, value, value2 }
   - 고른 것끼리 합친 인원(시간대 평균). 생략한 축은 전체.
   - measure "count" 는 보통 mode "level": 단계 0 매우 한적, 1 한적, 2 보통, 3 활기참, 4 혼잡 (전체 칸 로그 자연 단절). gte → value 이상, lte → value2 이하, between → value~value2.
   - measure "share": 고른 연령·성별(또는 인구 종류)이 전체에서 차지하는 비율 %. mode "abs"(%) 또는 "pct".
2) 가게·시설: { "type":"poi", "cats":[food 음식점, cafe 카페, bar 술집, conv 편의점, hosp 병원, pharm 약국, gym 헬스장, subway 지하철역, mart 대형마트 중 여럿], "by":"count"(칸 안 개수 합)|"dist"(가장 가까운 곳까지 m), op, mode "abs"|"pct", value }
   - "없음" = by count, op lte, value 0. "역 500m 안" = by dist, op lte, value 500.
3) 진료과: { "type":"depts", op, mode "abs", value }  칸 안 병원 진료과 종류 수
4) 동네 성격: { "type":"category", "ids":[동네 성격 id] }  칸의 분류가 그중 하나
5) 이동 시간: { "type":"commute", "dest":"목적지 이름", "maxMin": 분 }  대중교통 추정 시간 이내
6) 행정동: { "type":"dong", "codes":[행정동 코드] }  그중 하나에 속한 칸
7) 매물: { "type":"listing", "cats":[분류], "trades":[거래유형], "kinds":[매물 유형], "depositMax": 만원|null, "rentMax": 만원|null, "areaMin": ㎡|null, "minCount": 건 }
   - 칸 안에 기준에 맞는 매물이 minCount 건 이상인 칸. cats·trades·kinds 를 비우면 전부. 상한·하한은 null 이면 제한 없음.
   - depositMax 는 보증금(월세) · 전세금 · 매매가 모두 이 값으로 본다. 예) "월세 60 이하 원룸" = { "type":"listing", "trades":["월세"], "kinds":["원룸"], "rentMax":60, "minCount":1 }
8) 스크립트(위 1~7로 안 될 때만): { "type":"custom", "name", "description", "params":[...], "values":{}, "code" }

[화면 조건으로 쓸 수 있는 값]
- 동네 성격: ${cx.categories.map((c) => `${c.id}=${c.label}${c.desc ? `(${c.desc})` : ''}`).join(', ') || '없음'}
- 목적지: ${dests.join(', ')}
- 행정동: ${dongs.map((d) => `${d.code}=${d.name}`).join(', ')}
- 매물 (분류 · 거래유형 · 매물 유형: 건수, 금액 범위 — 이 값들로만 cats·trades·kinds 를 쓴다):
${listings || '(매물 데이터 없음 — listing 항목을 쓰지 않는다)'}

[스크립트 형식 (type custom)]
- name: 60자 이하 한국어 이름. description: 한 문장으로 무엇을 거르는지.
- params: 사용자가 바꿀 입력칸 (8개 이하). { key(영문), label(한국어, 짧게), type: "number"|"select"|"boolean", default, min, max, step, unit, options[{value,label}] }
  - 사용자가 조절할 만한 값은 코드에 박지 말고 params 로. label 과 unit 을 이어 읽으면 뜻이 통하게 ("반경 안 가게 수" + "곳 이상").
- code: function filter(cell, ctx) { ... } 하나. 칸마다 true/false 또는 { pass, value } (value 는 지도에 보여 줄 숫자).
- 격리 실행기: require·fetch·import 없음, 3초 제한. filter 는 칸마다 호출됨 — 전체 칸 계산은 ctx.rank 처럼 한 번만.
- 스크립트 하나에는 화면 조건으로 안 되는 부분만 넣는다. 화면 조건으로 되는 부분(예: 칸 안 술집 없음, 밤 한적)은 따로 항목으로.
쓸 수 있는 것:
${CUSTOM_API_DOC}
예시 항목:
${JSON.stringify(EXAMPLE_CUSTOM, null, 2)}

[지금 조건 목록]
${cx.stack.length ? JSON.stringify(cx.stack, null, 1) : '(비어 있음)'}
(text 는 화면에 보이는 문장. 답에 다시 쓸 필요 없음)

[지금 결과의 특징]
${
    cx.insight
      ? `지금 지도에 남은 칸 ${cx.insight.count}곳을 전체 ${cx.insight.total}칸과 비교한 지표 전부 (중간값 기준, 뚜렷한 것부터).
위치 = 남은 칸 중간값이 전체 칸 분포에서 몇 % 위치인지. 40~60 이면 전체와 비슷, 낮으면 전체보다 작음, 높으면 큼. 범주 지표는 비중 %.
시간대별 인원, 시간대별 거주·직장·방문 비중, 연령·성별, 가게 수, 가까운 시설 거리, 목적지까지 이동 시간, 매물 수가 모두 들어 있다. 여기 있는 지표로 답할 수 있는 것은 "데이터가 없다"고 하지 않는다.
${cx.insight.rows.map((r) => `- ${r.label}: 남은 칸 ${r.sel} / 전체 ${r.all}${r.pct === null ? '' : ` (위치 ${r.pct}%)`}`).join('\n')}`
      : '(조건이 없거나 전부 통과 — 비교할 결과 없음)'
  }
${
    cx.insight?.listing
      ? `
[지금 결과의 매물 비교]
${cx.insight.listing.basis} — 걸러진 쪽 ${cx.insight.listing.selN}건 / 비교군 ${cx.insight.listing.cmpN}건
${cx.insight.listing.rows.map((r) => `- ${r.label}: 걸러진 쪽 ${r.sel} / 비교군 ${r.cmp}`).join('\n')}
(층·연식·방·관리비·설비 비중은 매물 태그 기준. 태그가 없는 매물은 해당 없음으로 셈)`
      : ''
  }

[지금 고른 구역]
${
    cx.selected
      ? `사용자가 지도에서 고른 200m 칸 하나: ${cx.selected.name} (${cx.selected.dong})${cx.selected.category ? ` · 동네 성격 "${cx.selected.category}"` : ''}
${cx.selected.passes === null ? '조건 없음' : cx.selected.passes ? '지금 조건을 모두 통과하는 칸' : '지금 조건에서 걸러진 칸'}
${cx.selected.filters.map((f) => `- 조건 "${f.text}": ${f.ok ? '통과' : '탈락'}${f.detail ? ` (${f.detail})` : ''}`).join('\n')}
지표 (이 칸 값 / 전체 칸 중간값, 위치 = 이 칸 값이 전체 ${cx.insight?.total ?? ''}칸 중 몇 % 위치인지. 범주 지표는 해당하면 100%):
${cx.selected.rows.map((r) => `- ${r.label}: 이 칸 ${r.sel} / 전체 ${r.all}${r.pct === null ? '' : ` (위치 ${r.pct}%)`}`).join('\n')}
이 칸 매물 ${cx.selected.listings.length}건${cx.selected.listings.length ? ':\n' + cx.selected.listings.map((s) => `- ${s}`).join('\n') : ''}`
      : '(고른 구역 없음)'
  }

${
    personas
      ? `[다른 사용자 사례]
관리자가 저장한 "어떤 상황에서 어떤 조건을 왜 썼는지" 사례다. 다른 사람 이야기는 이 목록에 있는 것만 말할 수 있다.
${personas}`
      : `[다른 사용자 사례]
저장된 사례가 없다. 다른 사람·다른 사용자가 어떻게 찾았는지는 한 마디도 하지 않는다.`
  }

[대화 흐름]
- 대화는 화면이 먼저 띄운 질문(사이트를 쓰는 목적)으로 시작한다.
- 목적을 파악하면, 그 목적에 맞는 조건을 고르는 데 필요한 정보를 **한 번에 하나씩** 질문해 모은다. 무엇을 물을지는 목적에 따라 네가 정한다. 데이터로 거를 수 있는 것(시간대별 사람 수, 인구 종류·연령·성별, 가게·시설, 이동 시간·목적지, 행정동)에 연결되는 질문만 한다.
- **질문은 한 문장, 30자 안팎.** 설명·이유·선택지 나열(목적지 이름 목록 등)을 붙이지 않는다. 선택지는 아래 [빠른 답]으로 보여 준다.
- 질문은 대화 전체에서 2~4번 안에 끝낸다. 사용자가 바로 조건을 원하거나 정보가 충분하면 바로 제안한다.
- 제안할 때는 json 블록으로 목록을 내고, 조건마다 사용자가 말한 정보와 연결해 왜 골랐는지 짧게 설명한다.
- [다른 사용자 사례]에 목적·상황이 비슷한 사례가 있으면 참고해 조건을 고르고, "비슷한 목적으로 찾은 분들은 ○○ 조건으로 찾았어요"처럼 자연스럽게 한 번 알려 준다. 목록에 없는 사례를 지어내지 않는다. 맞는 사례가 없으면 다른 사람 이야기를 하지 않는다.
- 처음으로 목록을 제안한 답의 끝에 한 줄을 붙인다: "화면 위 ? 버튼을 누르면 조건을 직접 다루는 방법을 볼 수 있어요." 그 뒤로는 반복하지 않는다.

[빠른 답]
- 모든 답의 맨 끝에 사용자가 눌러서 바로 보낼 수 있는 짧은 답을 블록 하나로 붙인다:
\`\`\`replies
["답1", "답2", "답3"]
\`\`\`
- 2~4개, 각 15자 이내, 사용자가 하는 말투로 ("한성대 20분 안", "상관없어요").
- 질문한 답이면 그 질문에 대한 대표적인 답들. 실제 선택지가 정해져 있으면(목적지 등) 그중에서 고른다. "상관없어요"·"바로 추천해 주세요" 같은 넘어가기 답을 하나 넣어도 된다.
- 목록을 제안한 답이면 이어서 할 만한 요청 (조건을 넓히기·좁히기·추가 등).

[대화 규칙]
- 한국어 존댓말, 짧게. 목록을 제안하는 답의 json 밖 설명은 2~4줄.
- 요청을 조건 여러 개로 나누는 게 사용자가 조절하기 좋으면 나눈다. 사용자는 화면에서 각 조건을 끄고 켜거나 값을 바꿀 수 있다.
- 새 요청이 지금 목록과 관계없는 다른 동네 찾기라면 목록을 새로 짜고(기존 조건 삭제), 기존 조건에 더하거나 고치는 요청이면 기존 조건을 keep·수정한다. 애매하면 기존 조건을 유지한다.
- 데이터로 판단할 수 없는 요청(치안, 집값, 소음 측정 등)은 그렇다고 말하고, 가까운 대리 지표를 쓸지 제안한다. 대리 지표를 쓰면 description 이나 설명에 밝힌다.
- 요청이 모호하면 json 없이 짧게 되묻는다.
- 사용자가 지금 결과의 매물이 왜 싸거나 비싼지, 어떤 매물인지 물으면 [지금 결과의 매물 비교]를 근거로 답한다. 면적·㎡당 월세·층(지하·1층)·연식·방 개수·관리비·설비·유형 차이 중 큰 것부터, 걸러진 쪽과 비교군 숫자를 함께. 매물 수가 적으면 그렇다고 밝힌다.
- 사용자가 "여기·이 구역·고른 곳"처럼 지도에서 고른 칸을 물으면 [지금 고른 구역]을 근거로 답한다. 전체 칸과 비교해 뚜렷한 지표, 조건 통과·탈락 이유, 매물(가격·면적·층)을 숫자와 함께. 고른 구역이 없으면 지도에서 구역을 먼저 눌러 달라고 한다.
- 사용자가 지금 결과(남은 구역)의 공통점·특징을 물으면 [지금 결과의 특징]을 근거로 답한다. 조건으로 이미 건 것과 그 조건에서 당연히 따라 나오는 것은 빼고, 뚜렷한 것 3~5개를 숫자와 함께 짧게. 표에 없는 것은 추측하지 않는다. json 목록은 내지 않고, 마지막에 그중 조건으로 추가할 만한 것을 한 줄로 제안한다.
- "[실행 결과]" 로 시작하는 메시지는 서버가 네 목록을 확인한 결과다. 지적한 항목을 고쳐 목록 전체를 다시 낸다.`;
}

/** 답에서 마지막 ```json 블록 ({ stack }) */
function extract(text: string): { plan: any; raw: string; bad?: string } | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const m of blocks.reverse()) {
    if (!m[1].includes('"stack"')) continue;
    try {
      return { plan: JSON.parse(m[1]), raw: m[0] };
    } catch (e: any) {
      return { plan: null, raw: m[0], bad: `JSON 형식 오류: ${e.message}` };
    }
  }
  return null;
}

const TYPES = new Set(['pop', 'poi', 'depts', 'category', 'commute', 'dong', 'listing', 'custom']);

/** 목록 확인: custom 은 돌려 보고, 나머지는 형식만 */
async function check(plan: any, cells: Cell[], size: number, cx: ChatContext, dongs: DongStat[], dests: string[]) {
  if (!plan || !Array.isArray(plan.stack)) return ['{ "stack": [...] } 형식이 아님'];
  const ids = new Set(cx.stack.map((f) => String(f.id)));
  const out: string[] = [];
  for (const [i, it] of (plan.stack as any[]).entries()) {
    const at = `항목 ${i + 1}`;
    if (!it || typeof it !== 'object') {
      out.push(`${at}: 객체가 아님`);
      continue;
    }
    if (it.keep) {
      if (!ids.has(String(it.keep))) out.push(`${at}: 없는 id ${it.keep}`);
      continue;
    }
    if (it.id && !ids.has(String(it.id))) out.push(`${at}: 없는 id ${it.id} (새 조건이면 id 를 빼기)`);
    if (!TYPES.has(it.type)) {
      out.push(`${at}: type 은 ${[...TYPES].join('·')}`);
      continue;
    }
    if (it.type === 'category' && !(it.ids ?? []).some((x: string) => cx.categories.some((c) => c.id === x))) out.push(`${at}: 없는 동네 성격 id`);
    if (it.type === 'commute' && !dests.includes(it.dest)) out.push(`${at}: dest 는 ${dests.join('·')} 중 하나`);
    if (it.type === 'dong' && !(it.codes ?? []).some((x: string) => dongs.some((d) => d.code === String(x)))) out.push(`${at}: 없는 행정동 코드`);
    if (it.type === 'listing') {
      const arr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
      const numOrNull = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && v >= 0);
      if (!arr(it.cats) || !arr(it.trades) || !arr(it.kinds)) out.push(`${at}: cats·trades·kinds 는 문자열 배열`);
      if (!numOrNull(it.depositMax) || !numOrNull(it.rentMax) || !numOrNull(it.areaMin)) out.push(`${at}: depositMax·rentMax·areaMin 은 0 이상 숫자 또는 null`);
      if (it.minCount !== undefined && !(Number.isInteger(it.minCount) && it.minCount >= 1)) out.push(`${at}: minCount 는 1 이상 정수`);
    }
    if (it.type === 'custom') {
      const script: CustomScript = { name: it.name, description: it.description ?? '', params: it.params ?? [], code: it.code };
      const bad = validateScript(script);
      if (bad) {
        out.push(`${at} (${it.name}): 형식 오류 ${bad}`);
        continue;
      }
      const r = await runCustom(cells, size, script, it.values ?? {});
      if (!r.ok) out.push(`${at} (${it.name}): 실행 오류 ${r.error}`);
      else if (r.pass.length === 0 || r.pass.length === cells.length)
        out.push(`${at} (${it.name}): 기본값으로 ${cells.length}칸 중 ${r.pass.length}칸 통과 — 조건이 ${r.pass.length ? '너무 넓음' : '너무 좁음'}`);
    }
  }
  return out;
}

/** 답 끝의 ```replies [...]``` 블록 → 빠른 답 목록 (블록은 화면 문장에서 뺌) */
function splitReplies(text: string): { text: string; replies: string[] } {
  const m = [...text.matchAll(/```replies\s*\n?([\s\S]*?)```/g)].at(-1);
  if (!m) return { text, replies: [] };
  let replies: string[] = [];
  try {
    const v = JSON.parse(m[1]);
    if (Array.isArray(v)) replies = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 30)).slice(0, 4);
  } catch {
    /* 형식이 틀리면 빠른 답 없이 */
  }
  return { text: text.replace(m[0], ''), replies };
}
const tidy = (t: string) => t.replace(/\n{3,}/g, '\n\n').trim();

export interface ChatResult {
  reply: string;
  /** 빠른 답 (화면 아래 버튼) */
  replies: string[];
  /** 새 조건 목록 (AI 항목 형식). 목록을 바꾸지 않는 답이면 없음 */
  plan?: { stack: Record<string, unknown>[] };
  /** 다음 요청에 그대로 돌려줄 대화 (서버 피드백 포함) */
  history: InputMsg[];
}

export async function chat(
  sid: string,
  model: string,
  history: InputMsg[],
  cx: ChatContext,
  d: { cells: Cell[]; size: number; dongs: DongStat[]; dests: string[]; personas: string; listings: string },
): Promise<ChatResult> {
  const input = history.slice(-MAX_HISTORY);
  const instr = instructions(d.cells, d.size, d.dongs, d.dests, cx, d.personas, d.listings);
  let last = '';
  for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
    const text = await respond(sid, model, instr, input);
    input.push({ role: 'assistant', content: text });
    last = text;
    const { text: body, replies } = splitReplies(text);
    const ex = extract(body);
    if (!ex) return { reply: tidy(body), replies, history: input };
    const reply = tidy(body.replace(ex.raw, ''));
    const problems = ex.bad ? [ex.bad] : await check(ex.plan, d.cells, d.size, cx, d.dongs, d.dests);
    if (!problems.length) return { reply, replies, plan: ex.plan, history: input };
    if (attempt === MAX_FIX) return { reply: `${reply}\n\n(목록을 고치지 못했어요: ${problems.join(' / ')})`.trim(), replies, history: input };
    input.push({ role: 'user', content: `[실행 결과] ${problems.join('\n')}` });
  }
  const { text: body, replies } = splitReplies(last);
  return { reply: tidy(body), replies, history: input };
}
