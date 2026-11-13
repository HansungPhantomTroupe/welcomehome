/**
 * AI 조건 찾기 도우미 — 사용자의 말을 받아 "조건 찾기" 목록 전체를 다시 짠다.
 *
 * - 이미 화면에서 다룰 수 있는 조건(사람·가게/시설·진료과·동네 성격·이동 시간·행정동)은 그 형식으로,
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

function instructions(cells: Cell[], size: number, dongs: DongStat[], dests: string[], cx: ChatContext) {
  return `너는 주거지 탐색 지도 앱의 "조건 찾기" 도우미다. 사용자가 말로 원하는 동네를 설명하면, 지도 칸을 거르는 **조건 목록 전체**를 다시 짠다.

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
7) 스크립트(위 1~6으로 안 될 때만): { "type":"custom", "name", "description", "params":[...], "values":{}, "code" }

[화면 조건으로 쓸 수 있는 값]
- 동네 성격: ${cx.categories.map((c) => `${c.id}=${c.label}${c.desc ? `(${c.desc})` : ''}`).join(', ') || '없음'}
- 목적지: ${dests.join(', ')}
- 행정동: ${dongs.map((d) => `${d.code}=${d.name}`).join(', ')}

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

[대화 규칙]
- 한국어, 보고서처럼 짧게. json 밖 설명은 2~4줄: 무엇을 추가·수정·삭제했는지와 기준만.
- 요청을 조건 여러 개로 나누는 게 사용자가 조절하기 좋으면 나눈다. 사용자는 화면에서 각 조건을 끄고 켜거나 값을 바꿀 수 있다.
- 새 요청이 지금 목록과 관계없는 다른 동네 찾기라면 목록을 새로 짜고(기존 조건 삭제), 기존 조건에 더하거나 고치는 요청이면 기존 조건을 keep·수정한다. 애매하면 기존 조건을 유지한다.
- 데이터로 판단할 수 없는 요청(치안, 집값, 소음 측정 등)은 그렇다고 말하고, 가까운 대리 지표를 쓸지 제안한다. 대리 지표를 쓰면 description 이나 설명에 밝힌다.
- 요청이 모호하면 json 없이 짧게 되묻는다.
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

const TYPES = new Set(['pop', 'poi', 'depts', 'category', 'commute', 'dong', 'custom']);

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

export interface ChatResult {
  reply: string;
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
  d: { cells: Cell[]; size: number; dongs: DongStat[]; dests: string[] },
): Promise<ChatResult> {
  const input = history.slice(-MAX_HISTORY);
  const instr = instructions(d.cells, d.size, d.dongs, d.dests, cx);
  let last = '';
  for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
    const text = await respond(sid, model, instr, input);
    input.push({ role: 'assistant', content: text });
    last = text;
    const ex = extract(text);
    if (!ex) return { reply: text.trim(), history: input };
    const reply = text.replace(ex.raw, '').trim();
    const problems = ex.bad ? [ex.bad] : await check(ex.plan, d.cells, d.size, cx, d.dongs, d.dests);
    if (!problems.length) return { reply, plan: ex.plan, history: input };
    if (attempt === MAX_FIX) return { reply: `${reply}\n\n(목록을 고치지 못했어요: ${problems.join(' / ')})`.trim(), history: input };
    input.push({ role: 'user', content: `[실행 결과] ${problems.join('\n')}` });
  }
  return { reply: last, history: input };
}
