/**
 * 커널 실험실 예시 설계도 — 불러오면 평범한 단계로 들어가서 마음대로 고칠 수 있다.
 * 앱 동작에는 관여하지 않는 '시작점' 데이터일 뿐이고, 불러올 때 validateSpec 검사를 똑같이 거친다.
 */
const ALL_POP = { src: 'pop', days: [0, 1], times: [0, 1, 2, 3], kinds: [0, 1, 2], ages: [0, 1, 2, 3, 4, 5], sexes: [0, 1], measure: 'count' };

export interface KernelExample {
  title: string;
  /** 무엇을 배우는 예시인지 (어떤 연산을 쓰는지) */
  desc: string;
  steps: unknown[];
}

export const KERNEL_EXAMPLES: KernelExample[] = [
  {
    title: '걸어서 400m 안 카페 수',
    desc: '합계 커널 — 구역 안이 아니라 주변까지 더해서 셉니다',
    steps: [
      { id: 'A', label: '구역 안 카페', kind: 'source', cond: { src: 'poi', cats: ['cafe'] } },
      { id: 'B', label: '400m 안 카페 수', kind: 'kernel', input: 'A', shape: 'disk', r: 400, rIn: 0, op: 'sum' },
      { id: 'C', label: '카페 25곳 이상', kind: 'threshold', input: 'B', op: 'gte', mode: 'abs', value: 25 },
    ],
  },
  {
    title: '동네 분위기 부드럽게 보기',
    desc: '가우시안 커널 — 들쭉날쭉한 구역 값을 주변과 섞어 흐름을 봅니다 (A·B 를 번갈아 지도에)',
    steps: [
      { id: 'A', label: '하루 유동인구', kind: 'source', cond: ALL_POP },
      { id: 'B', label: '600m 가우시안', kind: 'kernel', input: 'A', shape: 'disk', r: 600, rIn: 0, op: 'gauss' },
    ],
  },
  {
    title: '주변보다 밤에 조용한 곳',
    desc: '가운데 − 주변 커널 — 바로 옆 동네와 비교해 유난히 한산한 구역',
    steps: [
      { id: 'A', label: '21~24시 사람 수', kind: 'source', cond: { ...ALL_POP, times: [3] } },
      { id: 'B', label: '주변 400m 보다 얼마나 적은지', kind: 'kernel', input: 'A', shape: 'disk', r: 400, rIn: 0, op: 'center_minus_surround' },
      { id: 'C', label: '주변보다 많이 적은 곳', kind: 'threshold', input: 'B', op: 'lte', mode: 'pct', value: 20 },
    ],
  },
  {
    title: '주변까지 전부 조용한 곳',
    desc: '최소 커널 — 내 구역뿐 아니라 이웃이 하나도 빠짐없이 조용해야 통과',
    steps: [
      { id: 'A', label: '주말 밤 사람 수', kind: 'source', cond: { ...ALL_POP, days: [1], times: [3] } },
      { id: 'B', label: '조용한 구역', kind: 'threshold', input: 'A', op: 'lte', mode: 'pct', value: 50 },
      { id: 'C', label: '200m 안 전부 조용', kind: 'kernel', input: 'B', shape: 'disk', r: 200, rIn: 0, op: 'min' },
    ],
  },
  {
    title: '역이 400~800m 거리에 있는 곳',
    desc: '고리 커널 — 너무 가깝지도 멀지도 않은 거리 띠',
    steps: [
      { id: 'A', label: '구역 안 지하철역', kind: 'source', cond: { src: 'poi', cats: ['subway'] } },
      { id: 'B', label: '400~800m 고리 안 역', kind: 'kernel', input: 'A', shape: 'ring', r: 800, rIn: 400, op: 'max' },
      { id: 'C', label: '200m 안 역', kind: 'kernel', input: 'A', shape: 'disk', r: 200, rIn: 0, op: 'max' },
      { id: 'D', label: '역이 고리에만', kind: 'combine', a: 'B', b: 'C', op: 'and_not' },
    ],
  },
  {
    title: '상권 근처인데 집 앞은 조용한 곳',
    desc: '여러 번 조합 — 덩어리 → 최대 커널 두 번(거리 띠) → 조용함과 합치기',
    steps: [
      { id: 'A', label: '상권 구역', kind: 'category', cats: ['commercial', 'night'] },
      { id: 'B', label: '3구역 이상 상권 덩어리', kind: 'blob', input: 'A', minCells: 3 },
      { id: 'C', label: '600m 안 상권', kind: 'kernel', input: 'B', shape: 'disk', r: 600, rIn: 0, op: 'max' },
      { id: 'D', label: '200m 안 상권', kind: 'kernel', input: 'B', shape: 'disk', r: 200, rIn: 0, op: 'max' },
      { id: 'E', label: '21~24시 사람 수', kind: 'source', cond: { ...ALL_POP, times: [3] } },
      { id: 'F', label: '200m 평균', kind: 'kernel', input: 'E', shape: 'disk', r: 200, rIn: 0, op: 'mean' },
      { id: 'G', label: '밤에 조용함', kind: 'threshold', input: 'F', op: 'lte', mode: 'pct', value: 40 },
      { id: 'H', label: '상권까지 200~600m', kind: 'combine', a: 'C', b: 'D', op: 'and_not' },
      { id: 'I', label: '찾는 곳', kind: 'combine', a: 'H', b: 'G', op: 'and' },
    ],
  },
];
