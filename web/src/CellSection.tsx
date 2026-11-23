import type { Cell } from '@shared/types';
import { LEVEL_LABEL } from '@shared/cellTypes';
import type { Category } from './classify';
import type { FilterDef } from './filters';
import { DemoBars, KindBar, TimePattern } from './charts';

interface FilterRow {
  f: FilterDef;
  text: string;
  r: { ok: boolean; detail: string };
}

export default function CellSection({
  cell,
  cat,
  filters,
  onClose,
}: {
  cell: Cell;
  cat: Category | null;
  filters: FilterRow[];
  onClose: () => void;
}) {
  const poi: [string, number][] = [
    ['음식점', cell.poi.food],
    ['카페', cell.poi.cafe],
    ['술집', cell.poi.bar],
    ['편의점', cell.poi.conv],
    ['병원', cell.poi.hosp],
    ['약국', cell.poi.pharm],
    ['헬스장', cell.poi.gym],
    ['지하철역', cell.poi.subway],
  ];
  return (
    <div className="cell-info">
      <div className="cell-head">
        <div>
          <span className="type-chip" style={{ background: cat?.color ?? '#94a3b8' }}>
            {cat?.label ?? '미분류'}
          </span>
          <h3>{cell.dongName}</h3>
          {cell.spike && (
            <div
              className="spike-note"
              title="LG U+ 50m 셀 중 주변 8셀의 10배 이상인 셀은 넘친 몫을 퍼뜨린 뒤 200m 칸으로 합쳤어요 (아파트 단지 전체 · 큰 건물과 그 둘레 · 반경 200m 주변). 순위 탭에서 원본으로 바꿔 볼 수 있어요."
            >
              튀는 50m 셀 {cell.spike}개 퍼뜨림
              {cell.spread && ` · ${[cell.spread.apt && `단지 ${cell.spread.apt}`, cell.spread.building && `건물 ${cell.spread.building}`, cell.spread.area && `주변 ${cell.spread.area}`].filter(Boolean).join(' · ')}`}
            </div>
          )}
          <small className="muted">
            {cell.id}
            {cell.lguId && ` · CELL_ID ${cell.lguId}`}
          </small>
        </div>
        <button className="icon-btn" onClick={onClose} title="선택 해제 (Esc)">
          ✕
        </button>
      </div>
      {filters.length > 0 && (
        <>
          <div className="sub">조건</div>
          <ul className="checks">
            {filters.map(({ f, text, r }, i) => (
              <li key={f.id} className={!f.enabled ? 'off' : r.ok ? 'pass' : 'fail'}>
                <span>{!f.enabled ? '–' : r.ok ? '✓' : '✕'}</span>
                <b>
                  {i + 1}. {text}
                </b>
                <small>{r.detail}</small>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="sub">
        시간대별 유동인구 <span className="legend-wd">월~목</span> <span className="legend-we">금~일</span>
      </div>
      <TimePattern cell={cell} />

      <div className="sub">인구 종류</div>
      <KindBar cell={cell} />

      <div className="sub">연령·성별</div>
      <DemoBars cell={cell} />

      <div className="sub">유동인구 (전체 구역 중 상대 위치)</div>
      <dl className="kv">
        <dt>전체</dt>
        <dd>{LEVEL_LABEL[cell.levels.total]}</dd>
        <dt>평일 17~24시</dt>
        <dd>{LEVEL_LABEL[cell.levels.wdEvening]}</dd>
        <dt>평일 21~24시</dt>
        <dd>{LEVEL_LABEL[cell.levels.wdNight]}</dd>
        <dt>금~일 21~24시</dt>
        <dd>{LEVEL_LABEL[cell.levels.weNight]}</dd>
      </dl>

      <div className="sub">구역 안 가게·시설</div>
      <div className="poi-grid">
        {poi.map(([k, v]) => (
          <span key={k} className={v ? '' : 'zero'}>
            {k} <b>{v}</b>
          </span>
        ))}
      </div>
      {cell.depts.length > 0 && <div className="hint">진료과: {cell.depts.join(' · ')}</div>}
    </div>
  );
}
