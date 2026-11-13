// 서버(데이터 파이프라인)와 웹이 함께 쓰는 타입 정의

export type LatLng = { lat: number; lng: number };

/** 우리가 쓰는 시설 분류 (카카오 카테고리 그룹 코드 + 키워드 검색을 정규화) */
export type PlaceCat =
  | 'food' // FD6 음식점
  | 'cafe' // CE7 카페
  | 'conv' // CS2 편의점
  | 'hosp' // HP8 병원
  | 'pharm' // PM9 약국
  | 'subway' // SW8 지하철역
  | 'mart' // MT1 대형마트
  | 'gym'; // 키워드(헬스장/피트니스)

export interface Place {
  id: string;
  name: string;
  cat: PlaceCat;
  categoryName: string; // 카카오 원본 category_name
  lat: number;
  lng: number;
  /** 병원 진료과 (category_name 3번째 세그먼트) */
  dept?: string;
  /** 음식점 중 술집 계열 */
  bar?: boolean;
  url?: string;
}

/** 가까운 시설 거리를 계산하는 종류 (bar = 술집 계열 음식점) */
export const NEAR_KINDS = ['food', 'cafe', 'bar', 'conv', 'hosp', 'pharm', 'gym', 'subway', 'mart'] as const;
export type NearKind = (typeof NEAR_KINDS)[number];

/** 셀 유형 */
export type CellType =
  | 'quiet' // 조용한 주거형
  | 'living' // 생활 주거형
  | 'commercial' // 상업·외식형
  | 'office' // 업무형 (직장인구 비중 높음)
  | 'night' // 야간활동형
  | 'medical' // 의료편의형
  | 'green'; // 녹지·비거주

/** 1~5 단계 (매우 낮음 ~ 매우 높음) */
export type Level = 1 | 2 | 3 | 4 | 5;

/** [요일묶음 0:월~목 1:금~일][시간대 0:08-12 1:13-16 2:17-20 3:21-24] 평균 인구 (LG U+ 셀 인구 전체) */
export type SlotMatrix = [[number, number, number, number], [number, number, number, number]];

export interface Cell {
  id: string;
  /** EPSG:5179 셀 중심 좌표 (LG U+ 명세의 Cell center X/Y) */
  cx?: number;
  cy?: number;
  center: LatLng;
  /** 셀 꼭짓점 (WGS84) */
  corners: LatLng[];
  dongCode: string;
  dongName: string;
  /** LG U+ 원본 CELL_ID (원본 CSV 대조용, 여러 셀이면 개수) */
  lguId?: string;
  /** 이 칸에 든 '튀는 50m 셀' 수 (주변 8셀의 10배 이상 — 퍼뜨림 처리됨) */
  spike?: number;
  /** 튀는 셀을 어떻게 퍼뜨렸는지: 아파트 단지 · 큰 건물 · 주변 지역 */
  spread?: { apt: number; building: number; area: number };
  /** 튀는 값 퍼뜨리기 전 원본 pop (pop 은 퍼뜨린 뒤 값). 화면에서 '원본 보기'로 바꿀 때 씀 */
  popRaw?: number[];

  // 유동인구 집계 (LG U+ 셀 데이터, 2025년 월 평균)
  slots: SlotMatrix;
  /**
   * 요일묶음(2) × 시간대(4) × 인구 종류(3: 거주·직장·방문) 평균 인원. 세 종류 합 = 그 칸 전체 인구.
   * 인덱스 = (요일*4 + 시간)*3 + 종류
   */
  pop: number[];
  total: number; // 전체 시간대 평균
  /** 거주·직장·방문 비중 (전체 시간대) */
  kindShare: { resident: number; worker: number; visitor: number };
  /**
   * 성별·연령 비율: [요일묶음 2][인구 종류 3: 거주·직장·방문][성별 2: 남·여][연령 6: 20대 미만~60대 이상] (요일·종류마다 합 1)
   * 시간대 구분은 없어 모든 시간대에 같은 비율을 쓴다. 인덱스 = ((요일*3 + 종류)*2 + 성별)*6 + 연령
   */
  demo: number[];
  /** 금~일 21-24 / 월~목 21-24 */
  weekendSurge?: number;
  /** 21-24 비중 */
  nightShare?: number;

  levels: {
    total: Level;
    wdEvening: Level; // 월~목 17-24
    wdNight: Level; // 월~목 21-24
    weNight: Level; // 금~일 21-24 (혼잡도)
  };

  // 셀 내부 시설
  poi: Record<PlaceCat, number> & { bar: number };
  /** 칸 중심에서 종류별 가장 가까운 시설까지 거리(m, 정수). 그 종류가 하나도 없으면 null. 서버(PostGIS)가 계산 */
  nearM: Record<NearKind, number | null>;
  /** 가장 가까운 지하철역 (구역 이름 '○○역 주변' 용). 없으면 null */
  nearSubway: { name: string; m: number } | null;
  depts: string[];

  type?: CellType;
  /** 주 유형 외 부가 성격 */
  tags?: CellType[];
  /** 한성대(목적지) 기준 추정 통학 시간(분) */
  commuteMin?: number;
}

/** 데이터 생성 단계(build:features)가 만드는 칸 — 가까운 시설 거리는 서버가 붙이고, 유형 필드는 이 단계에서 늘 채움 */
export type GeneratedCell = Omit<Cell, 'nearM' | 'nearSubway' | 'type' | 'tags' | 'commuteMin'> & { type: CellType; tags: CellType[]; commuteMin: number };

export interface DongStat {
  code: string;
  name: string;
  center: LatLng;
  cellCount: number;
  commuteMin: number;
  wdEvening: Level;
  weNight: Level;
  typeCounts: Partial<Record<CellType, number>>;
}

export interface Meta {
  generatedAt: string;
  source: { places: 'kakao' | 'mock'; population: 'lguplus' };
  /** 칸 한 변 (m) */
  cellSize: number;
  destinations: { name: string; lat: number; lng: number }[];
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  placeCounts: Record<string, number>;
}
