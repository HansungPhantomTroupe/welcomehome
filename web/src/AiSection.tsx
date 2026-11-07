/**
 * AI 탭 — 말로 요청하면 AI가 커스텀 필터(숨은 JS 스크립트 + 입력칸)를 만들어 조건 목록에 넣는다.
 * ChatGPT 로그인(서버가 토큰 보관) → 대화 → 서버가 스크립트를 돌려 본 결과와 함께 제안 → [조건으로 추가]
 */
import { useEffect, useRef, useState } from 'react';
import { CUSTOM_API_DOC } from '@shared/customApi';
import { EXAMPLE_SCRIPT, type CustomScript } from './customExamples';
import { describe, runCustomScript, type CustomState, type Dest, type FilterDef, type Names } from './filters';
import { condText, type Category } from './classify';
import { diff, fromItems, toItem, type PlanItem } from './aiPlan';

type Msg = { role: 'user' | 'assistant'; content: string };
type Shown = { role: 'user' | 'assistant'; text: string; base?: FilterDef[]; next?: FilterDef[]; errors?: string[]; count?: number; applied?: boolean };
interface Status {
  signedIn: boolean;
  email: string | null;
  error: string | null;
}

const CHAT_KEY = 'wh.aiChat.v2';
const MODEL_KEY = 'wh.aiModel';
const read = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 저장 못 해도 동작 */
  }
};
async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export default function AiSection({ onAdd, plan }: { onAdd: (s: CustomScript) => void; plan: PlanCtx }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () =>
    api<Status>('/api/ai/status')
      .then((s) => (setSt(s), setErr(null)))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="ai">
      <div className="ai-chat">
        {!st ? (
          err ? <div className="ai-err">{err}</div> : <div className="muted">확인 중…</div>
        ) : st.signedIn ? (
          <Chat email={st.email} plan={plan} onLogout={() => api<Status>('/api/ai/logout', {}).then(setSt)} />
        ) : (
          <Login st={st} onDone={setSt} refresh={refresh} />
        )}
      </div>
      <DevInput onAdd={onAdd} />
    </div>
  );
}

// ---------------------------------------------------------------- 로그인
function Login({ st, onDone, refresh }: { st: Status; onDone: (s: Status) => void; refresh: () => void }) {
  // null: 시작 전 · true: 서버가 돌아올 주소를 직접 받음 · false: 포트를 못 열어 붙여넣기 필요
  const [listening, setListening] = useState<boolean | null>(null);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (listening === null) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [listening]);
  useEffect(() => {
    if (listening !== null && st.error) setErr(st.error);
  }, [st.error]);

  const start = async () => {
    setErr(null);
    const w = window.open('', '_blank');
    try {
      const r = await api<{ url: string; listening: boolean }>('/api/ai/login', {});
      if (w) w.location.href = r.url;
      else window.open(r.url, '_blank');
      setListening(r.listening);
    } catch (e: any) {
      w?.close();
      setErr(e.message);
    }
  };
  const finish = async () => {
    setErr(null);
    try {
      onDone(await api<Status>('/api/ai/login/finish', { url: paste }));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="ai-login">
      <b>AI 조건 만들기</b>
      <p>ChatGPT Plus·Pro 계정으로 로그인하면 그 플랜으로 AI를 써요.</p>
      <div className="ai-row">
        <button className="tool primary" onClick={start}>
          ChatGPT로 로그인
        </button>
        {listening && <span className="muted">새 창에서 로그인하세요.</span>}
      </div>
      {listening !== null && (
        <>
          <p className="muted">{listening ? '창이 연결 오류로 끝나면' : '로그인 후'} 그 창의 주소를 붙여 넣으세요.</p>
          <div className="ai-input">
            <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="http://127.0.0.1:1455/auth/callback?code=…" />
            <button className="tool" disabled={!paste.trim()} onClick={finish}>
              확인
            </button>
          </div>
        </>
      )}
      {err && <div className="ai-err">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- 대화
export interface PlanCtx {
  stack: FilterDef[];
  cats: Category[];
  dests: Dest[];
  dongCodes: Set<string>;
  names: Names;
  /** 이 목록을 적용하면 남는 칸 수 */
  evaluate: (s: FilterDef[]) => Promise<number>;
  apply: (s: FilterDef[]) => void;
}

function Chat({ email, onLogout, plan }: { email: string | null; onLogout: () => void; plan: PlanCtx }) {
  const [models, setModels] = useState<{ slug: string; name: string }[]>([]);
  const [model, setModel] = useState<string>(() => read(MODEL_KEY, ''));
  const [chat, setChat] = useState<{ history: Msg[]; shown: Shown[] }>(() => read(CHAT_KEY, { history: [], shown: [] }));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ slug: string; name: string }[]>('/api/ai/models')
      .then((ms) => {
        setModels(ms);
        if (!ms.some((m) => m.slug === model) && ms[0]) setModel(ms[0].slug);
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => write(MODEL_KEY, model), [model]);
  useEffect(() => {
    write(CHAT_KEY, chat);
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [chat]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy || !model) return;
    const history: Msg[] = [...chat.history, { role: 'user', content: q }];
    setChat((c) => ({ history, shown: [...c.shown, { role: 'user', text: q }] }));
    setText('');
    setBusy(true);
    setErr(null);
    try {
      const context = {
        stack: plan.stack.map((f) => toItem(f, describe(f, plan.names))),
        categories: plan.cats.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label, desc: catDesc(c) })),
      };
      const r = await api<{ reply: string; plan?: { stack: PlanItem[] }; history: Msg[] }>('/api/ai/chat', { model, history, context });
      let next: Shown = { role: 'assistant', text: r.reply };
      if (r.plan) {
        const { stack, errors } = fromItems(r.plan.stack, { ...plan, current: plan.stack });
        next = { ...next, base: plan.stack, next: stack, errors, count: await plan.evaluate(stack) };
      }
      setChat((c) => ({ history: r.history, shown: [...c.shown, next] }));
    } catch (e: any) {
      setErr(e.message);
      // 실패한 질문은 대화에서 빼고 입력칸에 되돌림
      setChat((c) => ({ history: c.history.slice(0, -1), shown: c.shown.slice(0, -1) }));
      setText(q);
    } finally {
      setBusy(false);
    }
  };
  const markApplied = (i: number) => setChat((c) => ({ ...c, shown: c.shown.map((m, j) => (j === i ? { ...m, applied: true } : m)) }));

  return (
    <>
      <div className="ai-head">
        <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
          {models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name}
            </option>
          ))}
        </select>
        <span className="grow" />
        {chat.shown.length > 0 && (
          <button className="link" onClick={() => setChat({ history: [], shown: [] })}>
            새 대화
          </button>
        )}
        <button className="link" onClick={onLogout} title={email ?? ''}>
          로그아웃
        </button>
      </div>
      {chat.shown.length > 0 && (
        <div className="ai-msgs">
          {chat.shown.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role}`}>
              {m.text && <div className="ai-text">{m.text}</div>}
              {m.next && <PlanCard m={m} names={plan.names} onApply={() => (plan.apply(m.next!), markApplied(i))} />}
            </div>
          ))}
          {busy && <div className="ai-msg assistant muted">만드는 중…</div>}
          <div ref={bottom} />
        </div>
      )}
      <div className="ai-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
          placeholder="원하는 동네를 말로 설명해 주세요"
          disabled={busy}
        />
        <button className="tool primary" onClick={send} disabled={busy || !text.trim() || !model}>
          보내기
        </button>
      </div>
      {err && <div className="ai-err">{err}</div>}
    </>
  );
}

const MARK = { add: '추가', edit: '수정', keep: '유지' } as const;
function PlanCard({ m, names, onApply }: { m: Shown; names: Names; onApply: () => void }) {
  const d = diff(m.base ?? [], m.next ?? []);
  return (
    <div className="ai-card">
      <b>조건 찾기 변경안</b>
      <ul className="ai-plan">
        {d.rows.map(({ f, mark }) => (
          <li key={f.id} className={`${mark}${f.enabled ? '' : ' off'}`}>
            <span className="ai-mark">{MARK[mark]}</span>
            {f.type === 'custom' && <span className="ai-tag">AI</span>}
            <span>
              {describe(f, names)}
              {!f.enabled && ' (끔)'}
            </span>
          </li>
        ))}
        {d.removed.map((f) => (
          <li key={f.id} className="del">
            <span className="ai-mark">삭제</span>
            <span>{describe(f, names)}</span>
          </li>
        ))}
      </ul>
      {!!m.errors?.length && <div className="ai-err">못 읽은 항목: {m.errors.join(' / ')}</div>}
      <div className="ai-row">
        <span>
          적용하면 <b>{m.count}곳</b>
        </span>
        <span className="grow" />
        <button className="tool primary" disabled={m.applied} onClick={onApply}>
          {m.applied ? '적용됨' : '적용'}
        </button>
      </div>
    </div>
  );
}

/** 동네 성격 설명 (AI 에게) */
const catDesc = (c: Category) => (c.match === 'rest' ? '다른 성격에 안 맞는 칸' : c.conds.map(condText).join(c.match === 'any' ? ' 또는 ' : ' 그리고 '));

// ---------------------------------------------------------------- 개발용
function DevInput({ onAdd }: { onAdd: (s: CustomScript) => void }) {
  const [text, setText] = useState(() => JSON.stringify(EXAMPLE_SCRIPT, null, 2));
  const [res, setRes] = useState<CustomState | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const parse = (): CustomScript | null => {
    try {
      const s = JSON.parse(text) as CustomScript;
      setParseErr(null);
      return s;
    } catch (e: any) {
      setParseErr(`JSON 형식 오류: ${e.message}`);
      return null;
    }
  };
  const preview = async () => {
    const s = parse();
    if (!s) return;
    setRes({ status: 'loading' });
    setRes(await runCustomScript(s, {}));
  };

  return (
    <details className="ai-dev">
      <summary>개발용 · 스크립트 직접 넣기</summary>
      <p className="hint">
        형식: <code>{'{ name, description, params[], code }'}</code> — code 안에 <code>function filter(cell, ctx)</code>. 칸마다 true/false 또는{' '}
        <code>{'{ pass, value }'}</code>를 돌려줘요.
      </p>
      <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} rows={18} />
      {parseErr && <div className="ai-err">{parseErr}</div>}
      <div className="ai-row">
        <button className="tool" onClick={preview}>
          미리 실행
        </button>
        <button
          className="tool primary"
          disabled={res?.status !== 'ok'}
          onClick={() => {
            const s = parse();
            if (s) onAdd(s);
          }}
        >
          조건으로 추가
        </button>
        <span className="grow" />
        {res?.status === 'loading' && <span className="muted">실행 중…</span>}
        {res?.status === 'ok' && (
          <span>
            통과 <b>{res.pass.size}곳</b>
          </span>
        )}
      </div>
      {res?.status === 'error' && <pre className="ai-err">{res.error}</pre>}
      <details className="ai-api">
        <summary>스크립트에서 쓸 수 있는 것</summary>
        <pre>{CUSTOM_API_DOC}</pre>
      </details>
    </details>
  );
}
