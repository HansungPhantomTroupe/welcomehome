/**
 * 오른쪽(확대) 지도 아래 매물 시트 — 고른 칸의 매물 카드 목록
 * 카드를 누르면 펼쳐서 특징 전문 · 공급면적 · 정보 제공처
 */
import { useEffect, useRef } from 'react';

export interface Article {
  id: string;
  category: string;
  name: string | null;
  buildingName: string | null;
  typeName: string | null;
  trade: string | null;
  depositManwon: number | null;
  rentManwon: number | null;
  areaSupply: number | null;
  areaExclusive: number | null;
  floor: string | null;
  direction: string | null;
  confirmedOn: string | null;
  features: string | null;
  tags: string[];
  realtor: string | null;
  provider: string | null;
  lat: number | null;
  lng: number | null;
}

/** 만원 → '1억 2,000' · '1,000' */
const amount = (m: number) => {
  const eok = Math.floor(m / 10000);
  const rest = m % 10000;
  return eok ? `${eok}억${rest ? ` ${rest.toLocaleString()}` : ''}` : rest.toLocaleString();
};
/** 카드 가격 줄: '월세 1,000/50' · '전세 1억 2,000' */
export const articlePrice = (a: Article) => {
  const dep = a.depositManwon ?? 0;
  if (a.rentManwon) return `${a.trade ?? ''} ${amount(dep)}/${a.rentManwon.toLocaleString()}`.trim();
  return `${a.trade ?? ''} ${amount(dep)}`.trim();
};
/** 핀: '1,000/50' · '전 1.2억' · '매 3억' */
export const articlePin = (a: Article) => {
  const dep = a.depositManwon ?? 0;
  if (a.rentManwon) return `${dep.toLocaleString()}/${a.rentManwon}`;
  const short = dep >= 10000 ? `${(dep / 10000).toFixed(1).replace(/\.0$/, '')}억` : `${dep.toLocaleString()}`;
  return `${(a.trade ?? '').slice(0, 1)} ${short}`.trim();
};
const pyeong = (m2: number) => Math.round(m2 / 3.3058);

export default function ListingPanel({ items, picked, onPick, inline }: { items: Article[]; picked: string | null; onPick: (id: string | null) => void; inline?: boolean }) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  // 핀을 누르면 그 카드로 스크롤
  useEffect(() => {
    if (picked) refs.current.get(picked)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [picked]);
  if (!items.length) return null;
  return (
    <div className={`deal-sheet listing-sheet${inline ? ' inline' : ''}`}>
      {!inline && (
        <div className="deal-sheet-bar">
          <b>이 구역 매물</b>
          <span>{items.length}건</span>
        </div>
      )}
      <div className="listing-list">
        {items.map((a) => {
          const open = a.id === picked;
          const meta = [
            a.typeName,
            a.areaExclusive ? `${a.areaExclusive}㎡(${pyeong(a.areaExclusive)}평)` : null,
            a.floor ? `${a.floor}층` : null,
            a.direction,
          ].filter(Boolean);
          return (
            <div
              key={a.id}
              ref={(el) => {
                if (el) refs.current.set(a.id, el);
                else refs.current.delete(a.id);
              }}
              className={`listing-card${open ? ' open' : ''}`}
              onClick={() => onPick(open ? null : a.id)}
            >
              <div className="listing-top">
                {a.category !== '주거' && <span className="listing-badge t-cat">{a.category}</span>}
                <span className={`listing-badge t-${a.trade ?? ''}`}>{a.trade}</span>
                <b className="listing-price">{articlePrice(a).replace(/^\S+\s/, '')}</b>
                {!a.lat && <span className="listing-noloc">위치 비공개</span>}
              </div>
              <div className="listing-meta">{meta.join(' · ')}</div>
              {a.features && <div className={`listing-feat${open ? '' : ' clamp'}`}>{a.features}</div>}
              {!!a.tags.length && (
                <div className="listing-tags">
                  {a.tags.slice(0, open ? 20 : 4).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
              <div className="listing-foot">
                {a.confirmedOn && <span>{a.confirmedOn.slice(5).replace('-', '.')} 확인</span>}
                {a.realtor && <span>{a.realtor}</span>}
              </div>
              {open && (
                <div className="listing-more">
                  {a.areaSupply ? <span>공급 {a.areaSupply}㎡</span> : null}
                  {a.provider && <span>제공 {a.provider}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
