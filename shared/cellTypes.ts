import type { CellType, Level } from './types';

export const CELL_TYPES: Record<CellType, { label: string; color: string; desc: string[] }> = {
  quiet: {
    label: '조용한 주거형',
    color: '#3E9B6C',
    desc: ['유동인구 낮음~중간', '평일·주말 변동 작음', '금~일 야간 유동인구 낮음', '음식점·카페 밀도 낮음'],
  },
  living: {
    label: '생활 주거형',
    color: '#3B7DD8',
    desc: ['유동인구 중간', '평일 저녁에도 사람 유지', '편의시설 일정 수준', '주말 야간 혼잡 높지 않음'],
  },
  commercial: {
    label: '상업·외식형',
    color: '#E9822F',
    desc: ['음식점·카페 많음', '16~24시 유동인구 높음', '금~일 저녁 크게 증가'],
  },
  office: {
    label: '업무형',
    color: '#8A5CF0',
    desc: ['직장인구 비중 높음', '평일 낮 활동량 높음'],
  },
  night: {
    label: '야간활동형',
    color: '#D8405A',
    desc: ['20~24시 유동인구 비중 높음', '금~일 야간 증가폭 큼'],
  },
  medical: {
    label: '의료편의형',
    color: '#0E9EA8',
    desc: ['병원 수 많음', '진료과 종류 다양'],
  },
  green: {
    label: '녹지·비거주',
    color: '#A8B0B8',
    desc: ['산·공원·학교부지 등', '유동인구와 시설 거의 없음'],
  },
};

export const CELL_TYPE_ORDER: CellType[] = ['quiet', 'living', 'commercial', 'office', 'night', 'medical', 'green'];

export const LEVEL_LABEL: Record<Level, string> = {
  1: '매우 낮음',
  2: '낮음',
  3: '중간',
  4: '높음',
  5: '매우 높음',
};

/** 칸 한 변 (m) — LG U+ 50m 셀 16개를 합친 200m 칸 */
export const CELL_SIZE = 200;
/** LG U+ 원본 셀 한 변 (m) */
export const FINE_SIZE = 50;

export const DAY_GROUPS = ['월~목', '금~일'] as const;
/** LG U+ 셀 데이터의 시간대 구간 */
export const TIME_SLOTS = ['08~12시', '13~16시', '17~20시', '21~24시'] as const;
/** 인구 종류 (LG U+ 거주·직장·방문 인구, 세 종류 합 = 전체) */
export const POP_KINDS = ['거주', '직장', '방문'] as const;
/** 연령 (LG U+ 10세 구간) · 성별 */
export const AGE_GROUPS = ['20대 미만', '20대', '30대', '40대', '50대', '60대 이상'] as const;
export const SEX_GROUPS = ['남성', '여성'] as const;
