import type { LatLng } from '@shared/types';

export interface MapPolygon {
  id: string;
  paths: LatLng[][];
  stroke: string;
  strokeWeight: number;
  strokeOpacity: number;
  fill: string;
  fillOpacity: number;
  zIndex?: number;
  onClick?: () => void;
}

export interface MapCircle {
  id: string;
  center: LatLng;
  radius: number; // m
  stroke: string;
  fill: string;
  fillOpacity: number;
  dashed?: boolean;
}

export interface MapLine {
  id: string;
  path: LatLng[];
  color: string;
  weight: number;
  opacity: number;
  zIndex?: number;
}

/** listing: 칸 모서리 매물 수 · listingGroup: 여러 칸 묶음 매물 수 · home: 매물 가격 핀 */
export type MarkerKind = 'dot' | 'label' | 'listing' | 'listingGroup' | 'home';

export interface MapMarker {
  id: string;
  pos: LatLng;
  kind: MarkerKind;
  text?: string;
  active?: boolean;
  onClick?: () => void;
}

export interface MapLayers {
  polygons: MapPolygon[];
  circles: MapCircle[];
  lines: MapLine[];
  markers: MapMarker[];
}

export const EMPTY_LAYERS: MapLayers = { polygons: [], circles: [], lines: [], markers: [] };

export interface FitRequest {
  key: string;
  points: LatLng[];
  /** 지도가 좁아 한 단계 멀리 맞춰질 때, 가장자리가 이 비율까지 잘려도 한 단계 가까이 (0.1 = 양쪽 합쳐 20%) */
  allowCrop?: number;
}

export interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface RendererProps {
  layers: MapLayers;
  fit: FitRequest | null;
  /** 셀(도형) 레이어를 지도 타일과 합성하는 CSS mix-blend-mode */
  blend?: string;
  /** 확대·축소 시 현재 축척 (1px 당 m) */
  onScale?: (mPerPx: number) => void;
  /** 이동·확대가 끝날 때마다 화면 범위 */
  onBounds?: (b: Bounds) => void;
}
