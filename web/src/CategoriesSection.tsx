import { Fragment, useRef, useState } from 'react';
import { CELL_SIZE } from '@shared/cellTypes';
import { newCategory, newPoiCond, newPopCond, type Category } from './classify';
import CondBuilder, { type ExplainCtx } from './CondBuilder';

interface Props {
  on: boolean;
  setOn: (v: boolean) => void;
  hidden: Set<string>;
  toggleHidden: (id: string) => void;
  cats: Category[];
  setCats: (r: Category[]) => void;
  counts: Map<string, number>;
  unclassified: number;
  x: ExplainCtx;
  onReset: () => void;
}

export default function CategoriesSection(p: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const setCat = (i: number, r: Category) => p.setCats(p.cats.map((v, j) => (j === i ? r : v)));
  // ---------- 순서 바꾸기: 손잡이를 잡고 위아래로 끌기 (위에 있을수록 먼저 적용) ----------
  // to = 끼워 넣을 자리 (0 = 맨 위, cats.length = 맨 아래)
  const itemEls = useRef<(HTMLLIElement | null)[]>([]);
  const [reorder, setReorderState] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const reorderRef = useRef(reorder);
  const setReorder = (v: { from: number; to: number } | null) => {
    reorderRef.current = v;
    setReorderState(v);
  };
  const dropAt = (clientY: number) => {
    let k = 0;
    itemEls.current.slice(0, p.cats.length).forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) k = i + 1;
    });
    return k;
  };
  const finishReorder = () => {
    const r = reorderRef.current;
    setReorder(null);
    if (!r || r.to === r.from || r.to === r.from + 1) return;
    const s = [...p.cats];
    const [item] = s.splice(r.from, 1);
    s.splice(r.to > r.from ? r.to - 1 : r.to, 0, item);
    p.setCats(s);
  };
  const dropLine = (k: number) => reorder && k === reorder.to && k !== reorder.from && k !== reorder.from + 1 && <li className="drop-line cat-drop" />;
  const movable = p.cats.length > 1;
  const add = () => {
    const n = newCategory(p.cats);
    // 새 성격은 맨 위에 — 아래에 두면 위 성격이 구역을 먼저 가져가 0곳으로 보인다
    // 조건은 비워 두고 사용자가 첫 조건 종류를 고른다 (조건 없으면 0곳)
    p.setCats([n, ...p.cats]);
    setEditing(n.id);
  };

  return (
    <div className="types">
      <label className="switch-row">
        <span>
          지도에 색으로 보기 <kbd>T</kbd>
        </span>
        <input type="checkbox" className="switch" checked={p.on} onChange={(e) => p.setOn(e.target.checked)} />
      </label>
      <p className="lead-text">탐색 지역의 {CELL_SIZE}m 구역을 동네 성격별로 나눠 봐요. 이름을 누르면 어떤 구역을 그 성격으로 볼지 직접 정할 수 있어요.</p>

      {p.cats.length === 0 && (
        <div className="empty-box">
          아직 성격이 없어요. 아래 <b>+ 새 성격 만들기</b>를 눌러 보세요.
        </div>
      )}
      <ol className="cat-list">
        {p.cats.map((r, i) => {
          const open = editing === r.id;
          const hidden = p.hidden.has(r.id);
          return (
            <Fragment key={r.id}>
              {dropLine(i)}
              <li
                ref={(el) => {
                  itemEls.current[i] = el;
                }}
                className={`cat ${open ? 'open' : ''} ${r.enabled ? '' : 'disabled'} ${reorder?.from === i ? 'lifted' : ''}`}
              >
                <div className="cat-row">
                  {movable && (
                    <span
                      className="cat-grip"
                      title="끌어서 순서 바꾸기"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setReorder({ from: i, to: i });
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const cur = reorderRef.current;
                        if (!cur) return;
                        const to = dropAt(e.clientY);
                        if (to !== cur.to) setReorder({ ...cur, to });
                      }}
                      onPointerUp={finishReorder}
                      onPointerCancel={() => setReorder(null)}
                    >
                      ⠿
                    </span>
                  )}
                  <button
                    className={`eye ${hidden ? 'off' : ''}`}
                    onClick={() => p.toggleHidden(r.id)}
                    title={hidden ? '지도에 다시 보이기' : '지도에서 잠깐 숨기기'}
                  >
                    <span className="dot" style={{ background: r.color }} />
                  </button>
                  <button className="cat-name" onClick={() => setEditing(open ? null : r.id)}>
                    <span>{r.label}</span>
                    <span className="cat-count">{p.counts.get(r.id) ?? 0}곳</span>
                    <span className="cat-edit">{open ? '접기' : '편집'}</span>
                  </button>
                </div>

                {open && (
                  <div className="cat-body">
                    <div className="cat-title">
                      <input type="color" className="color" value={r.color} onChange={(e) => setCat(i, { ...r, color: e.target.value })} title="색 바꾸기" />
                      <input
                        className="name"
                        value={r.label}
                        onChange={(e) => setCat(i, { ...r, label: e.target.value })}
                        placeholder="성격 이름 (예: 조용한 주택가)"
                      />
                    </div>

                    <div className="q">어떤 구역인가요?</div>
                    <div className="radio-list">
                      <label>
                        <input
                          type="radio"
                          checked={r.match === 'all'}
                          onChange={() =>
                            setCat(i, {
                              ...r,
                              match: 'all',
                            })
                          }
                        />
                        아래 조건에 <b>모두</b> 맞는 구역
                      </label>
                      <label>
                        <input
                          type="radio"
                          checked={r.match === 'any'}
                          onChange={() =>
                            setCat(i, {
                              ...r,
                              match: 'any',
                            })
                          }
                        />
                        아래 조건 중 <b>하나라도</b> 맞는 구역
                      </label>
                      <label>
                        <input type="radio" checked={r.match === 'rest'} onChange={() => setCat(i, { ...r, match: 'rest' })} />위 성격에 들지 않은{' '}
                        <b>나머지 구역 전부</b>
                      </label>
                    </div>

                    {r.match !== 'rest' && (
                      <>
                        {r.conds.map((k, j) => (
                          <CondBuilder
                            key={j}
                            id={`${r.id}-${j}`}
                            cond={k}
                            x={p.x}
                            onChange={(nk) =>
                              setCat(i, {
                                ...r,
                                conds: r.conds.map((v, m) => (m === j ? nk : v)),
                              })
                            }
                            onRemove={() =>
                              setCat(i, {
                                ...r,
                                conds: r.conds.filter((_, m) => m !== j),
                              })
                            }
                          />
                        ))}
                        {r.conds.length === 0 && <div className="hint">첫 조건 종류를 고르세요.</div>}
                        <span className="add-pair">
                          <button
                            className="add-line"
                            onClick={() =>
                              setCat(i, {
                                ...r,
                                conds: [...r.conds, newPopCond()],
                              })
                            }
                          >
                            + 유동인구 조건
                          </button>
                          <button
                            className="add-line"
                            onClick={() =>
                              setCat(i, {
                                ...r,
                                conds: [...r.conds, newPoiCond()],
                              })
                            }
                          >
                            + 가게·시설 조건
                          </button>
                        </span>
                      </>
                    )}

                    <div className="cat-foot">
                      <span className="grow" />
                      <label className="use">
                        <input type="checkbox" checked={r.enabled} onChange={(e) => setCat(i, { ...r, enabled: e.target.checked })} /> 사용
                      </label>
                      <button
                        className="danger"
                        onClick={() => {
                          p.setCats(p.cats.filter((v) => v.id !== r.id));
                          setEditing(null);
                        }}
                      >
                        삭제
                      </button>
                    </div>
                    <div className="hint">한 구역이 여러 성격에 맞으면 목록에서 위에 있는 성격이 먼저 적용돼요.</div>
                  </div>
                )}
              </li>
            </Fragment>
          );
        })}
        {dropLine(p.cats.length)}
      </ol>

      <button className="add-big" onClick={add}>
        + 새 성격 만들기
      </button>
      <div className="types-foot">
        {p.unclassified > 0 ? <span className="muted">어느 성격에도 안 든 구역 {p.unclassified}곳</span> : <span />}
        <span>
          <button className="link" onClick={p.onReset}>
            처음 상태로
          </button>
          {' · '}
          <button className="link" onClick={() => p.setCats([])}>
            모두 지우기
          </button>
        </span>
      </div>
    </div>
  );
}
