/**
 * AI 탭 (첫 화면) — 사이트를 쓰는 목적을 묻는 첫 질문으로 시작해, AI가 필요한 정보를 질문으로 모은 뒤
 * 조건 목록 전체를 제안한다 (저장된 페르소나를 비슷한 사례로 참고). [적용] 으로 조건 찾기에 반영.
 * ChatGPT 로그인은 서버가 토큰을 보관.
 */
import { useEffect, useRef, useState } from 'react';
import { CUSTOM_API_DOC } from '@shared/customApi';
import { EXAMPLE_SCRIPT, type CustomScript } from './customExamples';
import { describe, runCustomScript, type CustomState, type Dest, type FilterDef, type Names } from './filters';
import { condText, type Category } from './classify';
import { diff, fromItems, toItem, type PlanItem } from './aiPlan';
import type { Insight } from './insights';

type Msg = { role: 'user' | 'assistant'; content: string };
type Shown = { role: 'user' | 'assistant'; text: string; replies?: string[]; base?: FilterDef[]; next?: FilterDef[]; errors?: string[]; count?: number; applied?: boolean };
interface Status {
  signedIn: boolean;
  email: string | null;
  error: string | null;
}

const CHAT_KEY = 'wh.aiChat.v3';
/** 대화를 여는 첫 질문 (모델 호출 없이 바로 표시, AI 에게도 대화의 첫 말로 넘김) */
const GREETING = '안녕하세요. 어떤 곳을 찾고 계세요? 자취방, 이사 갈 집, 가게 자리처럼 목적을 알려 주시면 필요한 걸 몇 가지 여쭤보고 맞는 조건을 만들어 드릴게요.';
/** 첫 질문 아래 빠른 답 (이후 빠른 답은 AI 가 만든다) */
const QUICK = ['자취방', '이사 갈 집', '가게 자리'];
const freshChat = (): { history: Msg[]; shown: Shown[] } => ({ history: [{ role: 'assistant', content: GREETING }], shown: [{ role: 'assistant', text: GREETING, replies: QUICK }] });
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

type Activity = 'idle' | 'busy' | 'new';
export default function AiSection({
  onAdd,
  plan,
  dev,
  visible = true,
  onActivity,
}: {
  onAdd: (s: CustomScript) => void;
  plan: PlanCtx;
  dev?: boolean;
  visible?: boolean;
  onActivity?: (a: Activity) => void;
}) {
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
          <Chat email={st.email} plan={plan} visible={visible} onActivity={onActivity} onLogout={() => api<Status>('/api/ai/logout', {}).then(setSt)} />
        ) : (
          <>
            <div className="ai-msgs">
              <Bubble role="assistant">{GREETING}</Bubble>
            </div>
            <Login st={st} onDone={setSt} refresh={refresh} />
          </>
        )}
      </div>
      {/* 개발용 스크립트 입력은 관리 화면(/personas)에서만 */}
      {dev && <DevInput onAdd={onAdd} />}
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
  /** 이 목록을 적용하면 남는 칸 수 (+ 단계별 · 조건 하나씩 따로 걸었을 때 칸 수, 꺼진 조건은 null) */
  evaluate: (s: FilterDef[]) => Promise<Evaluation>;
  /** 지금 걸러진 칸들 vs 전체 비교 (조건이 없거나 전부 통과면 null) */
  insight: () => Insight | null;
  apply: (s: FilterDef[]) => void;
}

function Chat({
  email,
  onLogout,
  plan,
  visible,
  onActivity,
}: {
  email: string | null;
  onLogout: () => void;
  plan: PlanCtx;
  visible: boolean;
  onActivity?: (a: Activity) => void;
}) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [models, setModels] = useState<{ slug: string; name: string }[]>([]);
  const [model, setModel] = useState<string>(() => read(MODEL_KEY, ''));
  const [chat, setChat] = useState<{ history: Msg[]; shown: Shown[] }>(() => read(CHAT_KEY, freshChat()));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 답을 기다리는 동안 보여 줄 상태 (0곳이라 다시 찾는 중 등) */
  const [status, setStatus] = useState<string | null>(null);
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
  useEffect(() => {
    if (busy) bottom.current?.scrollIntoView({ block: 'nearest' });
    // 답이 오면 'new' 를 따로 알리므로, 끝날 때 'idle' 은 화면을 보고 있을 때만
    if (busy) onActivity?.('busy');
    else if (visibleRef.current) onActivity?.('idle');
  }, [busy]);
  // 다른 탭에 갔다 오면 맨 아래로
  useEffect(() => {
    if (visible) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [visible]);

  const send = async (preset?: string) => {
    const q = (preset ?? text).trim();
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
        insight: plan.insight(),
      };
      // 추천한 목록이 0곳이면 이유(조건별 칸 수)를 AI 에게 알려 다시 짜게 한다
      let hist = history;
      let r: { reply: string; replies?: string[]; plan?: { stack: PlanItem[] }; history: Msg[] };
      let next: Shown;
      for (let retry = 0; ; retry++) {
        r = await api<typeof r>('/api/ai/chat', { model, history: hist, context });
        next = { role: 'assistant', text: r.reply, replies: r.replies ?? [] };
        if (!r.plan) break;
        const { stack, errors } = fromItems(r.plan.stack, { ...plan, current: plan.stack });
        const ev = await plan.evaluate(stack);
        next = { ...next, base: plan.stack, next: stack, errors, count: ev.count };
        if (ev.count > 0 || retry >= MAX_EMPTY_RETRY) break;
        setStatus('조건에 맞는 곳이 없어 다시 찾는 중');
        hist = [...r.history, { role: 'user', content: emptyFeedback(stack, ev, plan.names) }];
      }
      setStatus(null);
      setChat((c) => ({ history: r.history, shown: [...c.shown, next] }));
      if (!visibleRef.current) onActivity?.('new');
    } catch (e: any) {
      setStatus(null);
      setErr(e.message);
      if (!visibleRef.current) onActivity?.('new'); // 다른 탭에 있으면 확인하러 오게
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
        <span className="ai-title">
          <span className="ai-avatar sm">AI</span> 동네 찾기 도우미
        </span>
        <span className="grow" />
        {chat.shown.length > 1 && (
          <button className="ai-ghost" onClick={() => (setChat(freshChat()), setErr(null))} title="처음부터 다시 대화">
            새 대화
          </button>
        )}
        <details className="ai-menu">
          <summary title="설정">⋯</summary>
          <div className="ai-menu-pop">
            <label>
              모델
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
                {models.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="link" onClick={onLogout}>
              로그아웃{email ? ` (${email})` : ''}
            </button>
          </div>
        </details>
      </div>
      <div className="ai-msgs">
        {chat.shown.map((m, i) => (
          <Bubble key={i} role={m.role}>
            {m.role === 'assistant' ? rich(m.text) : m.text}
            {m.next && <PlanCard m={m} names={plan.names} onApply={() => (plan.apply(m.next!), markApplied(i))} />}
          </Bubble>
        ))}
        {/* 빠른 답: 마지막 AI 말 아래에만 */}
        {!busy && chat.shown.at(-1)?.role === 'assistant' && !!chat.shown.at(-1)?.replies?.length && (
          <div className="ai-chips">
            {chat.shown.at(-1)!.replies!.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={!model}>
                {q}
              </button>
            ))}
          </div>
        )}
        {busy && (
          <Bubble role="assistant">
            <span className="ai-typing" aria-label="답을 쓰는 중">
              <i />
              <i />
              <i />
            </span>
            {status && <span className="ai-status">{status}</span>}
          </Bubble>
        )}
        <div ref={bottom} />
      </div>
      {err && <div className="ai-err ai-err-box">{err}</div>}
      <Composer value={text} onChange={setText} onSend={() => send()} disabled={busy} canSend={!!text.trim() && !!model && !busy} />
    </>
  );
}

/** 0곳일 때 AI 에게 다시 짜 달라고 보낼 말 (화면에는 안 보임) */
const MAX_EMPTY_RETRY = 3;
export interface Evaluation {
  count: number;
  /** 전체 칸 수 */
  total: number;
  /** 위에서부터 차례로 걸었을 때 단계별 칸 수 */
  stages: number[];
  /** 조건 하나만 걸었을 때 칸 수 (꺼진 조건은 null) */
  solo: (number | null)[];
  /** 조건 하나만 뺐을 때 칸 수 (꺼진 조건은 null) */
  without: (number | null)[];
}
function emptyFeedback(stack: FilterDef[], ev: Evaluation, names: Names) {
  const on = stack.map((f, i) => ({ f, i, name: describe(f, names) })).filter(({ f }) => f.enabled);
  const rows = on.map(({ i, name }, k) => `${k + 1}) ${name}: 혼자 걸면 ${ev.solo[i]}곳, 이것만 빼면 ${ev.without[i]}곳`).join('\n');
  const flow = on.map(({ i }) => ev.stages[i]).join(' → ');
  const freeing = on.filter(({ i }) => (ev.without[i] ?? 0) > 0).sort((a, b) => (ev.without[b.i] ?? 0) - (ev.without[a.i] ?? 0));
  const hint = freeing.length
    ? `하나만 빼거나 완화해도 되는 조건: ${freeing.map(({ i, name }) => `${name}(빼면 ${ev.without[i]}곳)`).join(', ')}`
    : '어느 조건 하나만 빼서는 계속 0곳이에요. 혼자 걸어도 칸이 적은 조건끼리 겹쳐 있으니, 두 개 이상을 크게 완화하거나 빼야 해요.';
  return [
    `[실행 결과] 제안한 목록을 지도에 적용하면 0곳이에요. (전체 칸은 ${ev.total}개뿐이라, 혼자 걸어도 칸이 적은 조건을 여러 개 겹치면 0곳이 되기 쉬워요)`,
    rows,
    `위에서부터 차례로 걸면: ${flow}`,
    hint,
    '사용자가 말한 핵심은 지키면서 위 정보를 보고 목록 전체를 다시 내세요. 무엇을 왜 완화했는지 설명에 짧게 밝히세요.',
  ].join('\n');
}

/** AI 답의 **굵게** 만 살림 (나머지는 글자 그대로) */
function bold(t: string) {
  return t.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : part));
}
/** AI 답: **굵게** 와 | 표 | 만 살림 (나머지는 글자 그대로) */
function rich(t: string) {
  const lines = t.split('\n');
  const out: React.ReactNode[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length) out.push(<span key={out.length}>{bold(text.join('\n'))}</span>);
    text = [];
  };
  for (let i = 0; i < lines.length; ) {
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); // 구분선(---) 은 뺌
        i++;
      }
      flushText();
      const [head, ...body] = rows;
      out.push(
        <table key={out.length} className="ai-table">
          {head && (
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{bold(c)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, k) => (
              <tr key={k}>
                {r.map((c, j) => (
                  <td key={j}>{bold(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    text.push(lines[i]);
    i++;
  }
  flushText();
  return out;
}


function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div className={`ai-msg ${role}`}>
      {role === 'assistant' && <span className="ai-avatar">AI</span>}
      <div className="ai-bubble">{children}</div>
    </div>
  );
}

/** 입력칸: Enter 보내기, Shift+Enter 줄바꿈, 내용에 맞춰 4줄까지 늘어남 */
function Composer({ value, onChange, onSend, disabled, canSend }: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; canSend: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 96)}px`;
  }, [value]);
  return (
    <div className="ai-composer">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
        placeholder="메시지를 입력하세요"
        disabled={disabled}
      />
      <button className="ai-send" onClick={onSend} disabled={!canSend} title="보내기 (Enter)">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 12l16-8-6 16-2-6-8-2z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

const MARK = { add: '추가', edit: '수정', keep: '유지' } as const;
function PlanCard({ m, names, onApply }: { m: Shown; names: Names; onApply: () => void }) {
  const d = diff(m.base ?? [], m.next ?? []);
  return (
    <div className="ai-card">
      <div className="ai-card-head">추천 조건</div>
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
      <div className="ai-card-foot">
        <span>
          남는 곳 <b>{m.count}곳</b>
        </span>
        <button className="ai-apply" disabled={m.applied} onClick={onApply}>
          {m.applied ? '✓ 지도에 적용됨' : '지도에 적용'}
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
