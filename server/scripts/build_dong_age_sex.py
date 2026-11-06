"""
행정동별 연령·성별 비율 — 서울 열린데이터광장 '행정동 단위 서울 생활인구(내국인)' (OA-14991) 2025년 월별 파일로 만든다.

셀 인구(LG U+)에는 연령·성별이 없으니, 셀이 속한 행정동의 같은 요일묶음·시간대 비율로 나눠 쓰기 위한 표.

입력: data/raw/living_pop_dong/LOCAL_PEOPLE_DONG_2025MM.zip (12개), dong_codes.zip (행정동 코드정보)
출력: data/generated/dong_age_sex.json
  { "11290555": { "name": "삼선동", "sgg": "성북구",
                  "share": [2(요일) × 4(시간대) × 4(연령) × 2(성별)],   # 같은 칸 총생활인구 대비 비율
                  "total": [2 × 4] } }                                 # 시간당 평균 총생활인구
  요일: 0 월~목 · 1 금~일 / 시간대: 0 08~12 · 1 13~16 · 2 17~20 · 3 21~24시 (LG U+ 셀 데이터와 같은 구간)
  연령: 0 20대 · 1 30대 · 2 40~50대 · 3 60대 이상 / 성별: 0 남 · 1 여  (인덱스 = ((요일*4+시간)*4+연령)*2+성별)

실행: python server/scripts/build_dong_age_sex.py
"""
import csv
import datetime
import io
import json
import os
import zipfile

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
RAW = os.path.join(ROOT, 'data', 'raw', 'living_pop_dong')
OUT = os.path.join(ROOT, 'data', 'generated', 'dong_age_sex.json')

# 성북구 전체 + LG U+ 셀 데이터에 들어 있는 종로·용산 동
SGG = {'성북구'}
EXTRA = {'이화동', '혜화동', '창신1동', '창신2동', '창신3동', '용산2가동', '이태원1동', '이태원2동', '한남동', '보광동'}


def hour_slot(h: int):
    """LG U+ 시간대 구간 (08~12 · 13~16 · 17~20 · 21~24시). 그 밖은 None"""
    if 8 <= h <= 12:
        return 0
    if 13 <= h <= 16:
        return 1
    if 17 <= h <= 20:
        return 2
    if 21 <= h <= 23:
        return 3
    return None


# 원본 5세 구간 열 → 앱 연령 4구간 (20대 · 30대 · 40~50대 · 60대 이상), 10대 이하는 비율 계산에서 분모에만 들어감
AGE_BANDS = [
    (0, ['20세부터24세', '25세부터29세']),
    (1, ['30세부터34세', '35세부터39세']),
    (2, ['40세부터44세', '45세부터49세', '50세부터54세', '55세부터59세']),
    (3, ['60세부터64세', '65세부터69세', '70세이상']),
]


def load_codes():
    z = zipfile.ZipFile(os.path.join(RAW, 'dong_codes.zip'))
    rows = csv.DictReader(io.StringIO(z.read('SEOUL_ADMI/ADMI_202512.csv').decode('utf-8-sig')))
    return {r['ADMI_CD']: (r['ADMI_NM'], r['SGG_NM']) for r in rows if r['SIDO_NM'] == '서울특별시' and (r['SGG_NM'] in SGG or r['ADMI_NM'] in EXTRA)}


def main():
    codes = load_codes()
    # 합계: code → [요일][시간대] 총인구, [요일][시간대][연령][성별]
    tot = {c: [0.0] * 8 for c in codes}
    grp = {c: [0.0] * 64 for c in codes}
    hours = {c: [0] * 8 for c in codes}
    cols = None
    for m in range(1, 13):
        path = os.path.join(RAW, f'LOCAL_PEOPLE_DONG_2025{m:02d}.zip')
        z = zipfile.ZipFile(path)
        name = z.namelist()[0]
        # 달마다 인코딩이 다르다 (UTF-8 / CP949) — 머리줄로 판별
        try:
            z.open(name).read(4096).decode('utf-8-sig')
            enc = 'utf-8-sig'
        except UnicodeDecodeError:
            enc = 'cp949'
        with z.open(name) as f:
            r = csv.reader(io.TextIOWrapper(f, encoding=enc))
            head = next(r)
            if cols is None:
                cols = []
                for a, keys in AGE_BANDS:
                    for s, sex in enumerate(['남자', '여자']):
                        cols.append((a, s, [head.index(f'{sex}{k}생활인구수') for k in keys]))
            for row in r:
                code = row[2]
                if code not in codes:
                    continue
                t = hour_slot(int(row[1]))
                if t is None:
                    continue
                d = row[0]
                day = 0 if datetime.date(int(d[:4]), int(d[4:6]), int(d[6:])).weekday() <= 3 else 1
                k = day * 4 + t
                tot[code][k] += float(row[3] or 0)
                hours[code][k] += 1
                for a, s, idx in cols:
                    grp[code][(k * 4 + a) * 2 + s] += sum(float(row[i] or 0) for i in idx)
        print(path, 'ok')

    out = {}
    for c, (name, sgg) in codes.items():
        share = [round(grp[c][i] / tot[c][i // 8], 5) if tot[c][i // 8] else 0 for i in range(64)]
        total = [round(tot[c][k] / hours[c][k], 1) if hours[c][k] else 0 for k in range(8)]
        out[c] = {'name': name, 'sgg': sgg, 'share': share, 'total': total}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(OUT, len(out), 'dongs')


if __name__ == '__main__':
    main()
