/** 커스텀 필터 예시 — AI 연결 전 개발용 입력란의 처음 값, 그리고 AI에게 보여 줄 형식 예시 */
export interface ScriptParam {
  key: string;
  label: string;
  type: 'number' | 'select' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}
export interface CustomScript {
  name: string;
  description: string;
  params: ScriptParam[];
  code: string;
}

export const EXAMPLE_SCRIPT: CustomScript = {
  name: '주변에 상권이 있는 조용한 주거지',
  description: '밤(21~24시)에 한적하고 칸 안에 술집이 없으면서, 걸어갈 만한 거리 안에 음식점·카페·편의점이 충분한 곳',
  params: [
    { key: 'radius', label: '상권을 찾을 반경', type: 'number', default: 400, min: 200, max: 1000, step: 100, unit: 'm' },
    { key: 'minShops', label: '반경 안 가게 수', type: 'number', default: 30, min: 0, max: 200, step: 5, unit: '곳 이상' },
    { key: 'quietPct', label: '밤 인원 하위', type: 'number', default: 50, min: 10, max: 100, step: 10, unit: '%' },
    { key: 'maxBar', label: '칸 안 술집', type: 'number', default: 0, min: 0, max: 10, step: 1, unit: '곳 이하' },
  ],
  code: `function filter(cell, ctx) {
  const p = ctx.params;
  // 칸 안 술집
  if (ctx.poi(cell, ['bar']) > p.maxBar) return false;
  // 밤(21~24시) 인원이 전체 칸 중 하위 p.quietPct %
  const night = ctx.rank((c) => ctx.pop(c, { times: [3] }));
  if (night(cell) > p.quietPct / 100) return false;
  // 반경 안(자기 칸 포함) 음식점·카페·편의점 수
  const shops = [cell, ...ctx.near(cell, p.radius)].reduce((s, n) => s + ctx.poi(n, ['food', 'cafe', 'conv']), 0);
  return { pass: shops >= p.minShops, value: shops };
}`,
};
