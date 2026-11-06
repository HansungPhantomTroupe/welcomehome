/**
 * [임시 · 디버깅용] 칸 순위표 — 값이 튀는 칸을 찾아 지도에서 보기. 확인이 끝나면 이 파일과 App 의 '순위' 탭을 지운다.
 */
import { useState } from 'react';
import type { Cell } from '@shared/types';
import { POP_KINDS } from '@shared/cellTypes';

type Key = 'total' | 0 | 1 | 2 | 'spike';
const kindAvg = (c: Cell, k: number) => c.pop.filter((_, i) => i % 3 === k).reduce((s, v) => s + v, 0) / 8;
const valOf = (c: Cell, key: Key) => (key === 'total' ? c.total : key === 'spike' ? c.spike ?? 0 : kindAvg(c, key));
const fmt = (v: number) => Math.round(v).toLocaleString();

export default function DebugRank({
  cells,
  selectedId,
  onPick,
  spread,
  setSpread,
}: {
  cells: Cell[];
  selectedId: string | null;
  onPick: (c: Cell) => void;
  spread: boolean;
  setSpread: (v: boolean) => void;
}) {
  const [key, setKey] = useState<Key>('total');
  const [n, setN] = useState(50);
  const rows = [...cells].filter((c) => key !== 'spike' || c.spike).sort((a, b) => valOf(b, key) - valOf(a, key)).slice(0, n);
  return (
    <div className="dbg-rank">
      <div className="dbg-head">
        <b>칸 순위 (임시)</b>
        <select value={String(key)} onChange={(e) => setKey(e.target.value === 'total' || e.target.value === 'spike' ? e.target.value : (+e.target.value as Key))}>
          <option value="total">전체 인구</option>
          <option value="spike">튀는 50m 셀 수</option>
          {POP_KINDS.map((k, i) => (
            <option key={k} value={i}>
              {k} 인구
            </option>
          ))}
        </select>
        <select value={n} onChange={(e) => setN(+e.target.value)}>
          {[20, 50, 100, 300].map((v) => (
            <option key={v} value={v}>
              상위 {v}
            </option>
          ))}
        </select>
      </div>
      <label className="dbg-spread" title="튀는 50m 셀은 주변 8셀의 3배까지만 남기고 넘친 몫을 나눠요: 아파트 단지면 단지 전체에, 큰 건물이면 건물과 그 둘레에, 아니면 반경 200m 주변에 (총합 그대로)">
        <input type="checkbox" checked={spread} onChange={(e) => setSpread(e.target.checked)} /> 튀는 값 퍼뜨리기 (끄면 50m 원본 그대로 합침)
      </label>
      <small className="muted">
        시간대 평균 인원 · <span className="spike-dot" /> 튀는 50m 셀(주변 8셀의 10배 이상)이 든 칸 {cells.filter((c) => c.spike).length}개 · 줄을 누르면 지도에서 그 칸으로
      </small>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>동</th>
            <th>값</th>
            <th>거주·직장·방문</th>
            <th>CELL_ID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.id} className={c.id === selectedId ? 'on' : ''} onClick={() => onPick(c)}>
              <td>{i + 1}</td>
              <td>{c.dongName}</td>
              <td className="num">
                {c.spike && <span className="spike-dot" title={`튀는 50m 셀 ${c.spike}개`} />}
                {key === 'spike' ? `${c.spike}개` : fmt(valOf(c, key))}
              </td>
              <td className="num">
                {Math.round(c.kindShare.resident * 100)}·{Math.round(c.kindShare.worker * 100)}·{Math.round(c.kindShare.visitor * 100)}%
              </td>
              <td className="mono">{c.lguId ?? c.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
