import fs from 'node:fs/promises';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { pool, readBootstrap } from './postgres';
import { attachNear } from './near';
import { FILES, KAKAO_REST_KEY, PORT } from './config';
import { searchRect, stats, type Rect, type SearchSpec } from './kakao';
import { runCustom, validateScript, type CustomScript, type RunResult } from './customFilter';
import * as chatgpt from './chatgpt';
import { chat } from './aiChat';
import type { Cell, DongStat, GeneratedCell, Meta, Place } from '../../shared/types';

const app = express();
app.use(cors());
app.use(compression());

// ---------- 정적 분석 데이터 (npm run data 결과) ----------
async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
type BootstrapData = { cells: Cell[]; dongStats: DongStat[]; meta: Meta };
let cache: BootstrapData | null = null;
/** DB(PostGIS)가 있으면 DB에서, 없으면 data/generated 파일로 같은 모양을 만든다. 시설 목록은 화면으로 보내지 않는다 */
async function data() {
  if (cache) return cache;
  if (pool) return (cache = await readBootstrap());
  const [cells, dongStats, places, meta] = await Promise.all([
    loadJson<GeneratedCell[]>(FILES.cells),
    loadJson<DongStat[]>(FILES.dongStats),
    loadJson<Place[]>(FILES.places),
    loadJson<Meta>(FILES.meta),
  ]);
  if (!cells || !dongStats || !places || !meta) return null;
  return (cache = { cells: attachNear(cells, places), dongStats, meta });
}

/** 분석에 필요한 데이터를 한 번에 내려준다 (칸 485개 + 행정동 + 메타) */
app.get('/api/bootstrap', async (_req, res) => {
  const d = await data();
  if (!d) return res.status(503).json({ error: '분석 데이터를 불러오지 못했습니다.' });
  // 데이터를 다시 만들면 바로 보이게: 매번 서버에 확인 (안 바뀌었으면 ETag 로 304, 다시 받지 않음)
  res.set('Cache-Control', 'no-cache');
  res.json(d);
});

/**
 * 커스텀 필터 실행 (격리된 JS 실행기)
 * POST /api/custom/run  { script: { name, description, params, code }, values: { 입력칸: 값 } }
 *  → { ok, pass: 칸ID[], values: { 칸ID: 숫자 }, ms, error? }
 */
const customCache = new Map<string, RunResult>();
app.post('/api/custom/run', express.json({ limit: '200kb' }), async (req, res) => {
  const d = await data();
  if (!d) return res.status(503).json({ error: '데이터가 없습니다.' });
  const script = req.body?.script as CustomScript;
  const bad = validateScript(script);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const values = (req.body?.values ?? {}) as Record<string, unknown>;
  const key = JSON.stringify([script.code, script.params, values]);
  let r = customCache.get(key);
  if (!r) {
    r = await runCustom(d.cells, d.meta.cellSize, script, values);
    if (customCache.size > 200) customCache.delete(customCache.keys().next().value!);
    if (r.ok) customCache.set(key, r);
  }
  res.json(r);
});

// ---------- AI (Sign in with ChatGPT) ----------
// 로그인 하나를 서버 전체가 같이 씀: 어느 기기에서 접속하든 같은 ChatGPT 계정으로 AI 사용. 토큰은 서버에만.
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const ai = express.Router();
ai.use(express.json({ limit: '300kb' }));
ai.use((req, res, next) => {
  res.locals.sid = 'shared';
  // 서버를 켠 컴퓨터에서 연 화면인지 (Vite 프록시가 원래 주소를 x-forwarded-for 로 넘김)
  const from = [req.socket.remoteAddress ?? '', ...String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)];
  res.locals.local = from.every((a) => LOOPBACK.test(a));
  next();
});
type H = (req: express.Request, res: express.Response, sid: string) => Promise<unknown>;
const wrap = (fn: H) => (req: express.Request, res: express.Response) =>
  fn(req, res, res.locals.sid).catch((e) => res.status(e.message?.includes('로그인') ? 401 : 502).json({ error: String(e.message ?? e) }));
ai.get('/status', wrap(async (_req, res, sid) => res.json(await chatgpt.status(sid))));
ai.post('/login', wrap(async (_req, res, sid) => res.json(await chatgpt.startLogin(sid, res.locals.local))));
ai.post('/login/finish', wrap(async (req, res, sid) => {
  await chatgpt.finishLogin(sid, String(req.body?.url ?? ''));
  res.json(await chatgpt.status(sid));
}));
ai.post('/logout', wrap(async (_req, res, sid) => {
  await chatgpt.logout(sid);
  res.json(await chatgpt.status(sid));
}));
ai.get('/models', wrap(async (_req, res, sid) => res.json(await chatgpt.listModels(sid))));
/** POST /api/ai/chat { model, history: [{role, content}], context: { stack, categories } } → { reply, plan?: { stack }, history } */
ai.post('/chat', wrap(async (req, res, sid) => {
  const d = await data();
  if (!d) return res.status(503).json({ error: '데이터가 없습니다.' });
  const model = String(req.body?.model ?? '');
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 20000) }));
  if (!model || !history.length) return res.status(400).json({ error: 'model · history 가 필요해요.' });
  const ctx = req.body?.context ?? {};
  const cx = {
    stack: (Array.isArray(ctx.stack) ? ctx.stack : []).slice(0, 40),
    categories: (Array.isArray(ctx.categories) ? ctx.categories : []).slice(0, 30).map((c: any) => ({ id: String(c.id), label: String(c.label), desc: c.desc ? String(c.desc).slice(0, 200) : undefined })),
  };
  res.json(
    await chat(sid, model, history, cx, {
      cells: d.cells,
      size: d.meta.cellSize,
      dongs: d.dongStats,
      dests: (d.meta.destinations ?? []).map((x: { name: string }) => x.name),
    }),
  );
}));
app.use('/api/ai', ai);

/** 데이터 재생성 후 메모리 캐시 비우기 */
app.post('/api/reload', (_req, res) => {
  cache = null;
  customCache.clear();
  res.json({ ok: true });
});

// ---------- 카카오 로컬 API 프록시 (좌표 범위 검색, 캐시) ----------
const ALLOWED_CODES = new Set(['FD6', 'CE7', 'CS2', 'HP8', 'PM9', 'SW8', 'MT1', 'BK9', 'PK6', 'OL7', 'SC4', 'AC5', 'CT1', 'AT4', 'AD5', 'PO3', 'AG2']);
const MAX_RECT_DEG = 0.05; // 약 5km — 과도한 범위 요청 차단

/**
 * GET /api/places?rect=minLng,minLat,maxLng,maxLat&code=FD6
 * GET /api/places?rect=...&query=헬스장
 * 45건 초과 시 자동 분할 조회, 디스크+메모리 캐시
 */
app.get('/api/places', async (req, res) => {
  if (!KAKAO_REST_KEY) return res.status(503).json({ error: 'KAKAO_REST_KEY 미설정' });
  const rect = String(req.query.rect ?? '').split(',').map(Number) as Rect;
  if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n)) || rect[0] >= rect[2] || rect[1] >= rect[3])
    return res.status(400).json({ error: 'rect=minLng,minLat,maxLng,maxLat 형식이어야 합니다.' });
  if (rect[2] - rect[0] > MAX_RECT_DEG || rect[3] - rect[1] > MAX_RECT_DEG) return res.status(400).json({ error: '범위가 너무 큽니다.' });

  const code = req.query.code ? String(req.query.code) : undefined;
  const query = req.query.query ? String(req.query.query).slice(0, 50) : undefined;
  if (code && !ALLOWED_CODES.has(code)) return res.status(400).json({ error: '지원하지 않는 category code' });
  if (!code && !query) return res.status(400).json({ error: 'code 또는 query 가 필요합니다.' });

  const spec: SearchSpec = query ? { kind: 'keyword', query, code } : { kind: 'category', code: code! };
  try {
    const before = { ...stats };
    const docs = await searchRect(spec, rect);
    res.json({
      count: docs.length,
      apiCalls: stats.apiCalls - before.apiCalls,
      cacheHits: stats.cacheHits - before.cacheHits,
      documents: docs,
    });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, kakaoKey: !!KAKAO_REST_KEY, stats }));

app.listen(PORT, () => console.log(`API http://localhost:${PORT}`));
