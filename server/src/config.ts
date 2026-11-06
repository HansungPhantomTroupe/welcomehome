import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import proj4 from 'proj4';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env') });

export const DATA_DIR = path.join(ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const GEN_DIR = path.join(DATA_DIR, 'generated');
export const CACHE_DIR = path.join(DATA_DIR, 'cache', 'kakao');

export const FILES = {
  /** LG U+ 50m 셀 유동인구 (한성대·이태원역 주변 16개 행정동, 2025년 월별) */
  lguCsv: path.join(ROOT, 'DATADNI197_DATADNI197_YGH_HANSUNG_10TEAM_FST_TBL.csv'),
  /** 같은 셀 · 월 · 요일묶음을 성별 × 연령(10세)으로 나눈 표 (시간대 구분 없음) */
  lguDemoCsv: path.join(ROOT, 'DATADNI197_YGH_HANSUNG_10TEAM_SECD_TBL.csv'),
  /** 행정동 이름 → 코드 (build_dong_age_sex.py 결과, 서울 열린데이터광장 행정동 코드정보) */
  dongAgeSex: path.join(GEN_DIR, 'dong_age_sex.json'),
  grid: path.join(GEN_DIR, 'grid.json'),
  places: path.join(GEN_DIR, 'places.json'),
  destinations: path.join(GEN_DIR, 'destinations.json'),
  cells: path.join(GEN_DIR, 'cells.json'),
  dongStats: path.join(GEN_DIR, 'dong_stats.json'),
  meta: path.join(GEN_DIR, 'meta.json'),
  /** 셀별 월별 원본 값 (고른 구역 화면에서 한 칸씩 받아 감) */
  cellMonthly: path.join(GEN_DIR, 'cell_monthly.json'),
};

export const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY ?? '';
export const PORT = Number(process.env.PORT ?? 4000);
export const CACHE_TTL_MS = Number(process.env.KAKAO_CACHE_TTL_DAYS ?? 30) * 86_400_000;

/** 분석 대상: LG U+ 데이터의 서울 행 (같은 이름의 나주·진주 성북동 행은 위도로 걸러냄) */
export const SEOUL_MIN_LAT = 37;

/** 칸 크기 (m): 화면·분석은 200m, LG U+ 원본 셀은 50m */
export { CELL_SIZE, FINE_SIZE } from '../../shared/cellTypes';

/** 기본 목적지 (수집 시 카카오 키워드 검색으로 좌표 보정) */
export const DESTINATIONS = ['한성대학교', '이태원역', '성신여자대학교', '혜화역', '한남역'];

// EPSG:5179 (UTM-K, GRS80) — 국내 격자 통계에서 표준으로 쓰는 좌표계
proj4.defs(
  'EPSG:5179',
  '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);
export const toUtmk = (lng: number, lat: number) => proj4('EPSG:4326', 'EPSG:5179', [lng, lat]) as [number, number];
export const toWgs = (x: number, y: number) => proj4('EPSG:5179', 'EPSG:4326', [x, y]) as [number, number];
