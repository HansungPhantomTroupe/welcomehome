import type { CellType } from '@shared/types';
import { CELL_TYPES, CELL_TYPE_ORDER } from '@shared/cellTypes';
import type { CellEval } from './analysis';
import { AgeBar, TimePattern } from './charts';
import { LevelBadge, Swatch } from './ui';

export default function CellCard({ e, step, radius, onClose, extra }: { e: CellEval; step: number; radius: number; onClose: () => void; extra?: React.ReactNode }) {
  const c = e.cell;
  const t = CELL_TYPES[c.type];
  const nearest = CELL_TYPE_ORDER.filter((k) => k !== 'green' && e.nearestByType[k as CellType]).map((k) => ({ k, n: e.nearestByType[k]! }));
  const allOk = e.passedUpTo >= 7;

  return (
    <div className="cell-card">
      <div className="cell-card-head">
        <div>
          <div className="type-badge" style={{ background: t.color }}>{t.label}</div>
          {c.tags.map((tag) => (
            <span key={tag} className="tag" style={{ borderColor: CELL_TYPES[tag].color, color: CELL_TYPES[tag].color }}>
              +{CELL_TYPES[tag].label}
            </span>
          ))}
          <h3>
            {c.dongName} <small>{c.id}</small>
          </h3>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      <p className="interpret">{e.summary}</p>

      <div className="kv">
        <span>통학</span>
        <b>
          {e.commute}분 <small>({e.commuteMode === 'walk' ? '도보' : '대중교통'} 추정)</small>
        </b>
        <span>평일 16~24</span>
        <LevelBadge level={c.levels.wdEvening} />
        <span>평일 20~24</span>
        <LevelBadge level={c.levels.wdNight} invert />
        <span>금~일 20~24</span>
        <LevelBadge level={c.levels.weNight} invert />
        <span>20대 활동</span>
        <LevelBadge level={c.levels.youth} />
        <span>주변 저녁 상권</span>
        <LevelBadge level={e.nbEvening} />
      </div>

      <div className="sub">
        시간대별 유동인구 <span className="legend-wd">월~목</span> <span className="legend-we">금~일</span>
      </div>
      <TimePattern cell={c} />
      <div className="sub">연령대 구성</div>
      <AgeBar cell={c} />

      <div className="sub">주변 {radius}m 셀 구성</div>
      {nearest.length ? (
        <ul className="nearest">
          {nearest.map(({ k, n }) => (
            <li key={k}>
              <Swatch color={CELL_TYPES[k].color} />
              {n.dir}쪽 {Math.round(n.dist / 10) * 10}m · {CELL_TYPES[k].label}
            </li>
          ))}
        </ul>
      ) : (
        <div className="hint">주변 셀 없음</div>
      )}

      <div className="poi-row">
        <span>음식점·카페 {e.eatInRadius}</span>
        <span>헬스장 {e.nearestGym ? `${Math.round(e.nearestGym.dist)}m` : '-'}</span>
        <span>병원 {e.hospCount} · {e.depts.length}과</span>
        <span>약국 {e.pharmCount}</span>
      </div>
      {e.depts.length > 0 && <div className="depts">{e.depts.join(' · ')}</div>}

      {extra}
      {step >= 3 && (
        <>
          <div className="sub">조건 통과 {allOk ? <span className="ok">✓ 최종 후보</span> : null}</div>
          {e.passedUpTo < 2 && <div className="check fail">✕ 1단계: 선택한 행정동 밖이거나 통학시간 초과</div>}
          <ul className="checks">
            {e.checks.filter((ch) => ch.step <= Math.max(step, 3)).map((ch) => (
              <li key={ch.step} className={ch.ok ? 'pass' : 'fail'}>
                <span>{ch.ok ? '✓' : '✕'}</span>
                <b>{ch.step}. {ch.label}</b>
                <small>{ch.detail}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
