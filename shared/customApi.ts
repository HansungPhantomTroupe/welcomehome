/** 커스텀 필터 스크립트에서 쓸 수 있는 것 — 개발용 화면과 AI 지시문이 같이 쓴다 */
export const CUSTOM_API_DOC = `cell: { id, i, j(칸 좌표), lat, lng, dong(행정동), total(시간대 평균 인원),
        slots[요일 2][시간대 4], pop[24], demo[72],
        kind{resident,worker,visitor}(비중 0~1),
        poi{food 음식점, cafe 카페, bar 술집, conv 편의점, hosp 병원, pharm 약국, gym 운동, subway 지하철역, mart 대형마트}(칸 안 개수),
        depts(진료과 수), near{종류: 가장 가까운 곳까지 m} }
ctx.params              입력칸 값
ctx.cells               전체 칸
ctx.size                칸 한 변 m
ctx.get(id) / ctx.at(cell, di, dj)   칸 찾기 (di·dj: 칸 단위 이웃)
ctx.near(cell, m)       반경 m 안 칸들 (자기 제외)
ctx.dist(a, b)          두 칸 거리 m
ctx.pop(cell, { days:[0 평일,1 주말], times:[0 08~12,1 13~16,2 17~20,3 21~24],
                kinds:[0 거주,1 직장,2 방문], ages:[0~5: 20대 미만~60대 이상], sexes:[0 남,1 여] })
                        → 시간대 평균 인원 (생략한 항목은 전체)
ctx.share(cell, 옵션)    → 고른 연령·성별(또는 인구 종류)의 비율 %
ctx.poi(cell, ['food','cafe'])   칸 안 개수 합
ctx.nearest(cell, 'subway')      가장 가까운 곳까지 m
ctx.rank(fn)(cell)      전체 칸 중 fn 값의 순위 0(최저)~1(최고)
ctx.median(xs) / ctx.quantile(xs, q)`;
