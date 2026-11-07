/**
 * Sign in with ChatGPT — 세션 ID 별로 로그인을 보관 (지금은 index.ts 가 'shared' 하나만 써서 서버 전체가 한 로그인을 같이 씀) (https://developers.openai.com/siwc/token-sharing-open-source)
 *
 * - 토큰은 서버 파일(data/auth/sessions.json, 저장소 제외)에만 두고 브라우저로 보내지 않는다.
 *   파일에는 세션 ID 대신 그 해시를 키로 쓴다.
 * - client_id: .env 의 CHATGPT_CLIENT_ID(OpenAI 승인 후 받은 값)가 있으면 그것, 없으면 dynamic_agent_client 로 처음 등록하고
 *   돌려받은 client_id(oaiapp_…)를 저장해 다시 쓴다. (승인 없이 쓸 수 있는 건 오픈소스·로컬 실행 범위)
 * - 돌아올 주소는 http://127.0.0.1:1455/auth/callback 고정.
 *   서버를 켠 컴퓨터에서 로그인하면 서버가 이 포트로 바로 받고, 다른 컴퓨터는 로그인 창의 주소를 붙여 넣는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DATA_DIR } from './config';

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CB_PORT = 1455;
const REDIRECT = `http://127.0.0.1:${CB_PORT}/auth/callback`;
const APP_NAME = 'welcomeHome';
const FIXED_CLIENT_ID = process.env.CHATGPT_CLIENT_ID || '';
const STORE = path.join(DATA_DIR, 'auth', 'sessions.json');
const SESSION_TTL = 30 * 86_400_000;

interface Sess {
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  at: number;
}
interface Store {
  hostId: string;
  clientId?: string;
  sessions: Record<string, Sess>;
}
let store: Store | null = null;
async function load(): Promise<Store> {
  if (store) return store;
  try {
    store = JSON.parse(await fs.readFile(STORE, 'utf8')) as Store;
  } catch {
    store = { hostId: `urn:uuid:${crypto.randomUUID()}`, sessions: {} };
  }
  // 오래 안 쓴 세션 정리
  for (const [k, s] of Object.entries(store.sessions)) if (Date.now() - s.at > SESSION_TTL) delete store.sessions[k];
  return store;
}
let saving: Promise<void> = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    await fs.mkdir(path.dirname(STORE), { recursive: true });
    const tmp = STORE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(tmp, STORE);
  });
  return saving;
}
const key = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');
async function sess(sid: string): Promise<Sess> {
  const s = await load();
  return (s.sessions[key(sid)] ??= { at: Date.now() });
}

const b64url = (b: Buffer) => b.toString('base64url');
const rand = () => b64url(crypto.randomBytes(32));
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

/** 새 세션 ID (쿠키) */
export const newSessionId = rand;

// ---------------------------------------------------------------- 로그인
interface Pending {
  sid: string;
  verifier: string;
  nonce: string;
  clientId: string;
  at: number;
}
const pending = new Map<string, Pending>(); // state → 시도
const lastError = new Map<string, string>(); // sid → 오류
let listener: http.Server | null = null;

/** 로그인 주소 만들기. local: 서버를 켠 컴퓨터에서 연 화면이면 포트로 바로 받기 */
export async function startLogin(sid: string, local: boolean): Promise<{ url: string; listening: boolean }> {
  const s = await load();
  const me = await sess(sid);
  for (const [st, p] of pending) if (Date.now() - p.at > 15 * 60_000) pending.delete(st);
  lastError.delete(sid);
  const clientId = FIXED_CLIENT_ID || s.clientId || 'dynamic_agent_client';
  const state = rand();
  const verifier = rand();
  const p: Pending = { sid, verifier, nonce: rand(), clientId, at: Date.now() };
  pending.set(state, p);
  const q = new URLSearchParams({
    client_id: clientId,
    ext_agent_host_id: s.hostId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce: p.nonce,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  if (clientId === 'dynamic_agent_client') q.set('agent_name_hint', APP_NAME);
  else if (me.email) q.set('login_hint', me.email);
  // 이 서버 컴퓨터의 브라우저면 포트로 바로 받음. 다른 기기면 붙여넣기 (local 은 안내 문구용)
  const listening = await listen();
  return { url: `${AUTHORIZE}?${q}`, listening: local && listening };
}

let listenTimer: NodeJS.Timeout | null = null;
function listen(): Promise<boolean> {
  if (listenTimer) clearTimeout(listenTimer);
  listenTimer = setTimeout(closeListener, 15 * 60_000);
  listenTimer.unref();
  if (listener) return Promise.resolve(true);
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${CB_PORT}`);
      if (u.pathname !== '/auth/callback') return res.writeHead(404).end();
      const p = pending.get(u.searchParams.get('state') ?? '');
      let msg = '로그인됐어요. 이 창을 닫아도 돼요.';
      try {
        if (!p) throw new Error('로그인을 다시 시작하세요.');
        await finishLogin(p.sid, u.toString());
      } catch (e: any) {
        msg = `로그인 실패: ${e.message}`;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">${msg}</p>`);
      if (!pending.size) closeListener();
    });
    srv.once('error', () => resolve(false));
    srv.listen(CB_PORT, '127.0.0.1', () => {
      listener = srv;
      resolve(true);
    });
  });
}
function closeListener() {
  listener?.close();
  listener = null;
}

/** 돌아온 주소(콜백)로 토큰 받기 — 포트 수신 또는 붙여넣기 */
export async function finishLogin(sid: string, callbackUrl: string) {
  try {
    let u: URL;
    try {
      u = new URL(callbackUrl.trim());
    } catch {
      throw new Error('주소 형식이 아니에요.');
    }
    const state = u.searchParams.get('state') ?? '';
    const p = pending.get(state);
    if (!p || p.sid !== sid) throw new Error('이 로그인 시도의 주소가 아니에요. 로그인을 다시 시작하세요.');
    pending.delete(state);
    const err = u.searchParams.get('error');
    if (err) throw new Error(err === 'access_denied' ? '승인을 취소했어요.' : err);
    const code = u.searchParams.get('code');
    if (!code) throw new Error('주소에 code 가 없어요.');
    const clientId = u.searchParams.get('client_id') ?? p.clientId;
    const t = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: REDIRECT, resource: RESOURCE });
    if (typeof t.id_token !== 'string') throw new Error('ChatGPT 가 신원 정보를 주지 않았어요. 다시 로그인하세요.');
    // 토큰 엔드포인트에서 TLS 로 직접 받은 ID 토큰 → 발급자·대상·nonce·만료 확인
    const id = jwtPayload(t.id_token);
    const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
    if (id.iss !== 'https://auth.openai.com' || !aud.includes(clientId) || id.nonce !== p.nonce || id.exp * 1000 < Date.now())
      throw new Error('ID 토큰 확인 실패. 다시 로그인하세요.');
    if (!String(t.scope ?? '').split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('플랜 사용 권한이 승인되지 않았어요.');
    const s = await load();
    if (!FIXED_CLIENT_ID) s.clientId = clientId;
    Object.assign(await sess(sid), { email: id.email, at: Date.now() }, tokens(t));
    await save();
    lastError.delete(sid);
  } catch (e: any) {
    lastError.set(sid, e.message);
    throw e;
  }
}

function tokens(t: any): Partial<Sess> {
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description ?? j.error?.message ?? j.error ?? `HTTP ${r.status}`) as Error & { code?: string };
    e.code = typeof j.error === 'string' ? j.error : j.error?.code;
    throw e;
  }
  return j;
}

// ---------------------------------------------------------------- 토큰
const refreshing = new Map<string, Promise<void>>();
const UNUSABLE = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/** 이 세션이 쓸 access token (만료 2분 전이면 갱신). 로그인 안 했으면 null */
export async function accessToken(sid: string): Promise<string | null> {
  const s = await load();
  const me = s.sessions[key(sid)];
  const clientId = FIXED_CLIENT_ID || s.clientId;
  if (!me?.accessToken || !clientId) return null;
  me.at = Date.now();
  if (me.expiresAt! - Date.now() > 120_000) return me.accessToken;
  if (!me.refreshToken) return null;
  if (!refreshing.has(sid))
    refreshing.set(
      sid,
      (async () => {
        try {
          const t = await tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: me.refreshToken!, resource: RESOURCE });
          Object.assign(me, tokens(t), { refreshToken: t.refresh_token ?? me.refreshToken });
        } catch (e: any) {
          if (UNUSABLE.has(e.code)) Object.assign(me, { accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
          else throw e;
        } finally {
          await save();
          refreshing.delete(sid);
        }
      })(),
    );
  await refreshing.get(sid);
  return me.accessToken ?? null;
}

export async function status(sid: string) {
  const me = (await load()).sessions[key(sid)];
  return { signedIn: !!(me?.accessToken && me.refreshToken), email: me?.email ?? null, error: lastError.get(sid) ?? null };
}

export async function logout(sid: string) {
  const s = await load();
  const me = s.sessions[key(sid)];
  const clientId = FIXED_CLIENT_ID || s.clientId;
  if (me?.refreshToken && clientId) {
    try {
      const conf: any = await fetch('https://auth.openai.com/.well-known/openid-configuration').then((r) => r.json());
      if (conf.revocation_endpoint)
        await fetch(conf.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: me.refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
        });
    } catch {
      /* 취소 실패해도 서버의 토큰은 지움 */
    }
  }
  delete s.sessions[key(sid)];
  await save();
}

// ---------------------------------------------------------------- 모델 · 응답
async function tokenOrThrow(sid: string) {
  const tok = await accessToken(sid);
  if (!tok) throw new Error('로그인이 필요해요.');
  return tok;
}

export async function listModels(sid: string): Promise<{ slug: string; name: string }[]> {
  const r = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await tokenOrThrow(sid)}` } });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return (j.models ?? j.data ?? []).filter((m: any) => (m.visibility ?? 'list') === 'list').map((m: any) => ({ slug: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }));
}

export type InputMsg = { role: 'user' | 'assistant'; content: string };

/** Responses API (store:false, stream:true 필수) → 최종 텍스트 */
export async function respond(sid: string, model: string, instructions: string, input: InputMsg[]): Promise<string> {
  const r = await fetch(`${RESOURCE}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenOrThrow(sid)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, instructions, input, store: false, stream: true }),
  });
  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}));
    throw new Error(usageMsg(j.error?.code) ?? j.error?.message ?? `HTTP ${r.status}`);
  }
  // SSE: response.completed 만 성공으로 본다
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const ev = JSON.parse(data);
      if (ev.type === 'response.output_text.delta') text += ev.delta;
      else if (ev.type === 'response.completed') return outputText(ev.response) ?? text;
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const err = ev.response?.error ?? ev.error ?? ev;
        throw new Error(usageMsg(err.code) ?? err.message ?? '응답 실패');
      } else if (ev.type === 'response.incomplete') throw new Error('응답이 중간에 끊겼어요.');
    }
  }
  throw new Error('응답이 중간에 끊겼어요.');
}
function outputText(resp: any): string | null {
  const parts = (resp?.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []);
  const t = parts.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
  return t || null;
}
function usageMsg(code?: string) {
  if (code === 'subscription_sharing_usage_limit_exceeded') return 'ChatGPT 플랜 사용 한도를 넘었어요.';
  if (code === 'subscription_sharing_usage_unavailable') return '이 계정은 ChatGPT 플랜 사용을 쓸 수 없어요 (Plus·Pro 필요).';
  return null;
}
