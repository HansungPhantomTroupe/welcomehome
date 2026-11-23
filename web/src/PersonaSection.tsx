/**
 * 페르소나 관리 (/personas 에서만 보이는 탭)
 * 지금 조건 목록을 "어떤 상황에서 어떤 조건을 왜 썼는지" 설명과 함께 저장한다.
 * 저장한 페르소나는 AI 가 다른 사용자에게 비슷한 목적의 사례로 알려 줄 때 참고한다.
 */
import { useEffect, useState } from 'react';
import { describe, type FilterDef, type Names } from './filters';
import type { Category } from './classify';
import { toItem } from './aiPlan';

interface Persona {
  id: string;
  title: string;
  description: string;
  stack: FilterDef[];
  categories: Category[];
  items: { text?: string }[];
  updatedAt: string;
}

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export default function PersonaSection(p: {
  stack: FilterDef[];
  setStack: (s: FilterDef[]) => void;
  cats: Category[];
  setCats: (c: Category[]) => void;
  names: Names;
}) {
  const [list, setList] = useState<Persona[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 편집 중인 것: 새로 저장(id 없음) 또는 기존 것 고치기
  const [form, setForm] = useState<{ id?: string; title: string; description: string; replaceStack: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Persona[]>('/api/personas')
      .then((l) => (setList(l), setErr(null)))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  /** 지금 조건 목록을 저장할 모양으로 */
  const snapshot = () => {
    const ids = new Set(p.stack.flatMap((f) => (f.type === 'cell' && f.pred.kind === 'category' ? f.pred.ids : [])));
    return {
      stack: p.stack,
      categories: p.cats.filter((c) => ids.has(c.id)),
      items: p.stack.map((f) => toItem(f, describe(f, p.names))),
    };
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      const old = form.id ? list?.find((x) => x.id === form.id) : undefined;
      const body = {
        title: form.title,
        description: form.description,
        ...(old && !form.replaceStack ? { stack: old.stack, categories: old.categories, items: old.items } : snapshot()),
      };
      if (form.id) await api(`/api/personas/${form.id}`, 'PUT', body);
      else await api('/api/personas', 'POST', body);
      setForm(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (x: Persona) => {
    if (!confirm(`'${x.title}' 페르소나를 지울까요? 되돌릴 수 없어요.`)) return;
    try {
      await api(`/api/personas/${x.id}`, 'DELETE');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** 저장한 조건을 화면에 불러오기 (내 화면에 없는 동네 성격은 함께 추가) */
  const apply = (x: Persona) => {
    const have = new Set(p.cats.map((c) => c.id));
    const missing = x.categories.filter((c) => !have.has(c.id));
    if (missing.length) p.setCats([...missing, ...p.cats]);
    p.setStack(x.stack);
  };

  const editing = (id?: string) => form && form.id === id;

  return (
    <div className="persona">
      <div className="persona-now">
        <b>지금 조건 {p.stack.length}개</b>
        {p.stack.length ? (
          <ul className="persona-conds">
            {p.stack.map((f) => (
              <li key={f.id} className={f.enabled ? '' : 'off'}>
                {describe(f, p.names)}
                {!f.enabled && ' (끔)'}
              </li>
            ))}
          </ul>
        ) : (
          <div className="hint">조건 찾기 탭에서 조건을 만든 뒤 저장하세요.</div>
        )}
        {!editing(undefined) && (
          <button className="tool primary" disabled={!p.stack.length} onClick={() => setForm({ title: '', description: '', replaceStack: true })}>
            페르소나로 저장
          </button>
        )}
        {editing(undefined) && <Form form={form!} setForm={setForm} busy={busy} onSave={save} isNew />}
      </div>

      {err && <div className="ai-err">{err}</div>}

      <div className="persona-list">
        <b>저장한 페르소나 {list?.length ?? ''}</b>
        {!list ? (
          <div className="muted">불러오는 중…</div>
        ) : !list.length ? (
          <div className="hint">아직 없어요.</div>
        ) : (
          list.map((x) => (
            <div key={x.id} className="persona-card">
              {editing(x.id) ? (
                <Form form={form!} setForm={setForm} busy={busy} onSave={save} />
              ) : (
                <>
                  <div className="persona-title">{x.title}</div>
                  {x.description && <p className="persona-desc">{x.description}</p>}
                  <ul className="persona-conds">
                    {x.items.map((it, i) => (
                      <li key={i}>{it.text}</li>
                    ))}
                  </ul>
                  <div className="ai-row">
                    <span className="muted">{new Date(x.updatedAt).toLocaleString('ko-KR')}</span>
                    <span className="grow" />
                    <button className="link" onClick={() => apply(x)}>
                      불러오기
                    </button>
                    <button className="link" onClick={() => setForm({ id: x.id, title: x.title, description: x.description, replaceStack: false })}>
                      수정
                    </button>
                    <button className="link danger" onClick={() => remove(x)}>
                      삭제
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Form({
  form,
  setForm,
  busy,
  onSave,
  isNew,
}: {
  form: { id?: string; title: string; description: string; replaceStack: boolean };
  setForm: (f: typeof form | null) => void;
  busy: boolean;
  onSave: () => void;
  isNew?: boolean;
}) {
  return (
    <div className="persona-form">
      <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="제목" maxLength={80} autoFocus />
      <textarea
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        placeholder="어떤 상황에서 어떤 조건을 왜 썼는지"
        rows={6}
        maxLength={3000}
      />
      {!isNew && (
        <label className="persona-check">
          <input type="checkbox" checked={form.replaceStack} onChange={(e) => setForm({ ...form, replaceStack: e.target.checked })} /> 조건을 지금 조건으로 바꾸기
        </label>
      )}
      <div className="ai-row">
        <span className="grow" />
        <button className="tool" onClick={() => setForm(null)} disabled={busy}>
          취소
        </button>
        <button className="tool primary" onClick={onSave} disabled={busy || !form.title.trim()}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
