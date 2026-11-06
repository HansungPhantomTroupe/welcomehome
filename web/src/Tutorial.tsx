/**
 * 따라 하는 튜토리얼 — 단계마다 실제로 조작해 보고 [다음]을 눌러 넘어간다.
 * 비춘 영역을 가리지 않고(클릭이 그대로 통과), 해내면 "잘했어요"와 함께 [다음]이 강조된다.
 * 넘어가는 건 항상 사용자가 [다음]을 누를 때만 (자동 진행 없음).
 * 처음 접속 때 자동으로 뜨고, 패널의 [?] 로 다시 볼 수 있다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface TourStep {
  /** 앱이 '지금 어느 단계인지' 알아야 할 때 쓰는 이름 (예: 지도 위에 설명 그림 그리기) */
  id?: string;
  /** 비출 요소 (CSS 선택자, 여러 개면 처음 찾은 것). 없으면 가운데 말풍선만 */
  target?: string;
  /** 해 볼 것을 해낸 뒤 비출 요소 — 누른 결과가 다른 곳(지도 등)에 나타날 때 */
  doneTarget?: string;
  title: string;
  body: ReactNode;
  /** 해 볼 것 — 있으면 done() 이 참이 될 때까지 기다림 */
  task?: ReactNode;
  done?: () => boolean;
  /** 이 단계에 들어갈 때 할 일 (예: 탭 전환) */
  onEnter?: () => void;
}

const CARD_W = 330;
const GAP = 14;

export default function Tutorial({
  steps,
  onClose,
  onStep,
  dimArea,
}: {
  steps: TourStep[];
  onClose: () => void;
  onStep?: (id: string | undefined) => void;
  /** 어둡게 덮을 영역 (CSS 선택자). 없으면 화면 전체. 이 영역 밖(예: 지도)은 늘 밝게 두고 노란 테두리로만 짚는다 */
  dimArea?: string;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [area, setArea] = useState<DOMRect | null>(null);
  const step = steps[i];
  const ok = step.done ? step.done() : true;
  const last = i === steps.length - 1;
  const target = ok && step.done && step.doneTarget ? step.doneTarget : step.target;
  // 단계가 바뀐 직후에만 애니메이션 (끄는 동안 따라가는 건 즉시)
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setMoving(true);
    const t = setTimeout(() => setMoving(false), 300);
    return () => clearTimeout(t);
  }, [i, target]);
  const go = (to: number) => (to >= steps.length ? onClose() : setI(Math.max(0, to)));

  // 단계에 들어올 때 이미 되어 있었는지 기록 → "잘했어요" 대신 "이미 되어 있어요"
  const startedDone = useRef<Record<number, boolean>>({});
  if (!(i in startedDone.current)) startedDone.current[i] = !!step.done?.();
  const already = startedDone.current[i];

  useEffect(() => {
    step.onEnter?.();
    onStep?.(step.id);
  }, [i]);
  useEffect(() => () => onStep?.(undefined), []);

  // 비출 요소 위치 추적 (탭 전환·스크롤·레이아웃 변화를 따라감)
  useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = target ? document.querySelector(target) : null;
      const r = el?.getBoundingClientRect() ?? null;
      const same = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
      setRect((prev) => (same(prev, r) ? prev : r));
      const a = dimArea ? document.querySelector(dimArea)?.getBoundingClientRect() ?? null : null;
      setArea((prev) => (same(prev, a) ? prev : a));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [i, target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 말풍선 위치: 비춘 영역의 오른쪽 → 왼쪽 → 아래 → 가운데
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cardStyle: React.CSSProperties = { left: vw / 2 - CARD_W / 2, top: vh / 2 - 140 };
  if (rect) {
    const top = Math.min(Math.max(12, rect.top), vh - 300);
    if (rect.right + GAP + CARD_W < vw - 12) cardStyle = { left: rect.right + GAP, top };
    else if (rect.left - GAP - CARD_W > 12) cardStyle = { left: rect.left - GAP - CARD_W, top };
    else cardStyle = { left: Math.min(Math.max(12, rect.left + 12), vw - CARD_W - 12), top: Math.min(Math.max(12, rect.top + 12), vh - 300) };
  }

  return (
    <div className={`tour ${rect ? 'with-hole' : ''} ${moving ? 'moving' : ''}`} role="dialog" aria-label="따라 하는 사용 안내">
      {(() => {
        // 어둡게 덮는 건 dimArea 안에서만. 비출 곳이 그 안에 있으면 구멍을 뚫고, 밖(지도 등)이면 영역 전체를 덮고 비출 곳엔 테두리만
        const inside = !!rect && (!area || (rect.left >= area.left - 1 && rect.right <= area.right + 1));
        const ox = area?.left ?? 0;
        const oy = area?.top ?? 0;
        return (
          <>
            <div className="tour-area" style={area ? { left: area.left, top: area.top, width: area.width, height: area.height } : { inset: 0 }}>
              {rect && inside ? (
                <div className="tour-hole" style={{ left: rect.left - ox - 6, top: rect.top - oy - 6, width: rect.width + 12, height: rect.height + 12 }} />
              ) : (
                <div className="tour-dim" />
              )}
            </div>
            {rect && !inside && <div className="tour-ring" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
          </>
        );
      })()}
      <div className="tour-card" style={{ ...cardStyle, width: CARD_W }}>
        <div className="tour-progress">
          {steps.map((_, k) => (
            <i key={k} className={k < i ? 'done' : k === i ? 'now' : ''} />
          ))}
        </div>
        <h3>{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        {step.task && (
          <div className={`tour-task ${ok ? 'ok' : ''}`}>
            <span className="tt-icon">{ok ? '✓' : '👉'}</span>
            <span>
              {ok ? (
                <>
                  {already ? '이미 되어 있어요.' : '잘했어요!'} <b>[다음]</b>을 눌러 주세요.
                </>
              ) : (
                step.task
              )}
            </span>
          </div>
        )}
        <div className="tour-actions">
          <button className="link" onClick={onClose}>
            그만 보기
          </button>
          <span className="grow" />
          {i > 0 && (
            <button className="tool" onClick={() => go(i - 1)}>
              이전
            </button>
          )}
          {step.task && !ok ? (
            <button className="tool" onClick={() => go(i + 1)} title="해 보지 않고 다음 단계로">
              건너뛰기
            </button>
          ) : (
            <button className={`tool primary ${step.task ? 'pulse' : ''}`} onClick={() => go(i + 1)}>
              {last ? '끝내기' : '다음'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
