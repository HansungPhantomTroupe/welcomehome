import type { Place, PlaceCat } from '../../shared/types';
import type { KakaoDoc, SearchSpec } from './kakao';

/** 수집 대상: 우리 분류 → 카카오 검색 조건 */
export const COLLECT_TARGETS: { cat: PlaceCat; specs: SearchSpec[] }[] = [
  { cat: 'food', specs: [{ kind: 'category', code: 'FD6' }] },
  { cat: 'cafe', specs: [{ kind: 'category', code: 'CE7' }] },
  { cat: 'conv', specs: [{ kind: 'category', code: 'CS2' }] },
  { cat: 'hosp', specs: [{ kind: 'category', code: 'HP8' }] },
  { cat: 'pharm', specs: [{ kind: 'category', code: 'PM9' }] },
  { cat: 'subway', specs: [{ kind: 'category', code: 'SW8' }] },
  { cat: 'mart', specs: [{ kind: 'category', code: 'MT1' }] },
  // 헬스장은 카테고리 그룹 코드가 없어 키워드 검색 후 category_name 으로 거른다
  {
    cat: 'gym',
    specs: [
      { kind: 'keyword', query: '헬스장' },
      { kind: 'keyword', query: '피트니스' },
    ],
  },
];

const GYM_RE = /헬스|피트니스|휘트니스/;
const BAR_RE = /술집|호프|요리주점|이자카야|칵테일|와인바|포장마차|오뎅바|실내포차/;

export function normalize(cat: PlaceCat, d: KakaoDoc): Place | null {
  if (cat === 'gym' && !(GYM_RE.test(d.category_name) && d.category_name.includes('스포츠'))) return null;
  const segs = d.category_name.split('>').map((s) => s.trim());
  const p: Place = {
    id: d.id,
    name: d.place_name,
    cat,
    categoryName: d.category_name,
    lat: +d.y,
    lng: +d.x,
    url: d.place_url,
  };
  if (cat === 'hosp') p.dept = segs[2] ?? segs[1] ?? '기타';
  if (cat === 'food' && BAR_RE.test(d.category_name)) p.bar = true;
  return p;
}
