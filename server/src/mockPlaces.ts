/**
 * 카카오 키가 없을 때 파이프라인 검증용 mock 시설 데이터.
 * 성북구 주요 역세권/상권을 앵커로 두고 주변에 시설을 분포시킨다.
 * (실제 서비스 데이터 아님 — meta.source.places = 'mock' 으로 표시됨)
 */
import type { Place, PlaceCat } from '../../shared/types';
import type { Rect } from './kakao';
import { makeRng } from './rng';

// [이름, lat, lng, 상권 강도(0~1), 야간 강도(0~1)]
const ANCHORS: [string, number, number, number, number][] = [
  ['성신여대입구역', 37.5926, 127.0164, 1.0, 0.8],
  ['한성대입구역', 37.5884, 127.0062, 0.7, 0.4],
  ['안암역', 37.5863, 127.0292, 0.8, 0.7],
  ['고려대역', 37.5905, 127.0362, 0.5, 0.3],
  ['보문역', 37.5853, 127.0193, 0.4, 0.2],
  ['길음역', 37.6033, 127.025, 0.75, 0.4],
  ['월곡역', 37.6019, 127.0414, 0.5, 0.2],
  ['상월곡역', 37.6062, 127.048, 0.35, 0.15],
  ['돌곶이역', 37.6105, 127.0565, 0.4, 0.2],
  ['정릉시장', 37.6064, 127.0129, 0.45, 0.15],
  ['미아사거리역', 37.6133, 127.0301, 0.8, 0.6],
  ['석계역', 37.615, 127.066, 0.6, 0.4],
  ['장위시장', 37.6151, 127.0495, 0.35, 0.1],
  ['종암사거리', 37.5966, 127.0338, 0.4, 0.15],
];

const DEPTS = ['내과', '소아청소년과', '정형외과', '피부과', '치과', '안과', '이비인후과', '산부인과', '한의원', '비뇨의학과', '정신건강의학과', '재활의학과', '가정의학과', '성형외과'];
const FOOD_KINDS = ['한식', '중식', '일식', '분식', '양식', '치킨', '패스트푸드'];
const BAR_KINDS = ['술집 > 호프,요리주점', '술집 > 실내포장마차', '술집 > 이자카야'];

const M_LAT = 1 / 111_000;
const M_LNG = 1 / 88_000;

export function mockPlaces(rect: Rect): Place[] {
  const rng = makeRng(20260701);
  const out: Place[] = [];
  let seq = 0;
  const inRect = (lat: number, lng: number) => lng >= rect[0] && lng <= rect[2] && lat >= rect[1] && lat <= rect[3];

  const add = (cat: PlaceCat, lat: number, lng: number, extra: Partial<Place> = {}) => {
    if (!inRect(lat, lng)) return;
    const id = `mock${++seq}`;
    out.push({ id, name: `${extra.name ?? cat} ${seq}`, cat, categoryName: extra.categoryName ?? cat, lat, lng, ...extra });
  };
  const around = (lat: number, lng: number, sdM: number) => [lat + rng.normal() * sdM * M_LAT, lng + rng.normal() * sdM * M_LNG] as const;

  for (const [aname, lat, lng, com, night] of ANCHORS) {
    const nFood = Math.round(160 * com);
    for (let i = 0; i < nFood; i++) {
      const [a, b] = around(lat, lng, 220);
      const isBar = rng.next() < 0.15 + 0.35 * night;
      add('food', a, b, isBar
        ? { name: `${aname} 주점`, categoryName: `음식점 > ${rng.pick(BAR_KINDS)}`, bar: true }
        : { name: `${aname} 식당`, categoryName: `음식점 > ${rng.pick(FOOD_KINDS)}` });
    }
    for (let i = 0; i < Math.round(60 * com); i++) add('cafe', ...around(lat, lng, 240), { name: `${aname} 카페`, categoryName: '음식점 > 카페' });
    for (let i = 0; i < Math.round(30 * com); i++) {
      const dept = rng.pick(DEPTS);
      add('hosp', ...around(lat, lng, 260), { name: `${aname} ${dept}`, categoryName: `의료,건강 > 병원 > ${dept}`, dept });
    }
    for (let i = 0; i < Math.round(10 * com); i++) add('pharm', ...around(lat, lng, 250), { name: `${aname} 약국` });
    for (let i = 0; i < 1 + Math.round(4 * com); i++) add('gym', ...around(lat, lng, 350), { name: `${aname} 피트니스`, categoryName: '스포츠,레저 > 스포츠시설 > 헬스클럽' });
    if (aname.endsWith('역')) add('subway', lat, lng, { name: aname });
  }

  // 주거지 생활시설 — 범위 전반에 흩뿌림 (북서쪽 북한산 자락은 희박하게)
  for (let i = 0; i < 1400; i++) {
    const lat = rect[1] + rng.next() * (rect[3] - rect[1]);
    const lng = rect[0] + rng.next() * (rect[2] - rect[0]);
    if (lat > 37.6 && lng < 127.005 && rng.next() < 0.85) continue;
    const r = rng.next();
    if (r < 0.25) add('conv', lat, lng, { name: '편의점' });
    else if (r < 0.65) add('food', lat, lng, { name: '동네 식당', categoryName: `음식점 > ${rng.pick(FOOD_KINDS)}` });
    else if (r < 0.8) add('cafe', lat, lng, { name: '동네 카페', categoryName: '음식점 > 카페' });
    else if (r < 0.9) {
      const dept = rng.pick(DEPTS);
      add('hosp', lat, lng, { name: `동네 ${dept}`, categoryName: `의료,건강 > 병원 > ${dept}`, dept });
    } else if (r < 0.95) add('pharm', lat, lng, { name: '동네 약국' });
    else if (r < 0.98) add('gym', lat, lng, { name: '동네 헬스장', categoryName: '스포츠,레저 > 스포츠시설 > 헬스클럽' });
    else add('mart', lat, lng, { name: '마트' });
  }
  return out;
}

export function mockDestinations() {
  return [
    { name: '한성대학교', lat: 37.5826, lng: 127.0106 },
    { name: '고려대학교', lat: 37.5894, lng: 127.0323 },
    { name: '성신여자대학교', lat: 37.5913, lng: 127.022 },
    { name: '국민대학교', lat: 37.6106, lng: 126.997 },
    { name: '서경대학교', lat: 37.6152, lng: 127.013 },
    { name: '동덕여자대학교', lat: 37.6066, lng: 127.042 },
  ];
}
