/**
 * 페르소나 — 관리 화면(/personas)에서 저장한 "어떤 상황에 어떤 조건을 왜 썼는지".
 * AI 가 다른 사용자에게 "비슷한 목적의 사람들은 이런 조건으로 찾았다"고 알려 줄 때 참고한다.
 *
 * 저장: DATABASE_URL 이 있으면 PostgreSQL wh_personas 테이블, 없으면 data/personas.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { pool } from './postgres';

export interface Persona {
  id: string;
  title: string;
  description: string;
  /** 화면 조건 목록 그대로 (관리 화면에서 다시 불러오기용) */
  stack: unknown[];
  /** 조건이 쓰는 동네 성격 정의 (다른 사람 화면에 없을 수 있어서 함께 저장) */
  categories: unknown[];
  /** AI 용: 조건마다 { text(화면 문장), ...AI 항목 형식 } */
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
}
export type PersonaInput = Pick<Persona, 'title' | 'description' | 'stack' | 'categories' | 'items'>;

const FILE = path.join(DATA_DIR, 'personas.json');
const LIMITS = { title: 80, description: 3000, stack: 40, items: 40, categories: 30, bytes: 200_000 };

/** 형식 확인 — 잘못된 곳을 문장으로 */
export function validate(x: any): string | null {
  if (!x || typeof x !== 'object') return '본문이 비어 있어요.';
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > LIMITS.title) return `제목: 1~${LIMITS.title}자`;
  if (typeof x.description !== 'string' || x.description.length > LIMITS.description) return `설명: ${LIMITS.description}자 이하`;
  if (!Array.isArray(x.stack) || !x.stack.length || x.stack.length > LIMITS.stack) return `조건: 1~${LIMITS.stack}개`;
  if (!Array.isArray(x.items) || x.items.length > LIMITS.items) return `items: ${LIMITS.items}개 이하`;
  if (!Array.isArray(x.categories) || x.categories.length > LIMITS.categories) return `categories: ${LIMITS.categories}개 이하`;
  if (JSON.stringify(x).length > LIMITS.bytes) return '너무 커요.';
  return null;
}
const clean = (x: any): PersonaInput => ({
  title: x.title.trim(),
  description: x.description.trim(),
  stack: x.stack,
  categories: x.categories,
  items: x.items,
});

// ---------------------------------------------------------------- 저장소
let tableReady: Promise<unknown> | null = null;
function table() {
  tableReady ??= pool!.query(`
    CREATE TABLE IF NOT EXISTS wh_personas (
      id text PRIMARY KEY,
      title text NOT NULL,
      description text NOT NULL,
      stack jsonb NOT NULL,
      categories jsonb NOT NULL,
      items jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  return tableReady;
}
const fromRow = (r: any): Persona => ({
  id: r.id,
  title: r.title,
  description: r.description,
  stack: r.stack,
  categories: r.categories,
  items: r.items,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

async function readFile(): Promise<Persona[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return [];
  }
}
let writing: Promise<void> = Promise.resolve();
function writeFile(list: Persona[]) {
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE + '.tmp', JSON.stringify(list, null, 2));
    await fs.rename(FILE + '.tmp', FILE);
  });
  return writing;
}

export async function list(): Promise<Persona[]> {
  if (pool) {
    await table();
    return (await pool.query('SELECT * FROM wh_personas ORDER BY updated_at DESC')).rows.map(fromRow);
  }
  return (await readFile()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function create(x: PersonaInput): Promise<Persona> {
  const p = clean(x);
  const id = `p${crypto.randomBytes(6).toString('hex')}`;
  if (pool) {
    await table();
    const r = await pool.query(
      `INSERT INTO wh_personas (id, title, description, stack, categories, items) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING *`,
      [id, p.title, p.description, JSON.stringify(p.stack), JSON.stringify(p.categories), JSON.stringify(p.items)],
    );
    return fromRow(r.rows[0]);
  }
  const now = new Date().toISOString();
  const persona: Persona = { id, ...p, createdAt: now, updatedAt: now };
  await writeFile([...(await readFile()), persona]);
  return persona;
}

export async function update(id: string, x: PersonaInput): Promise<Persona | null> {
  const p = clean(x);
  if (pool) {
    await table();
    const r = await pool.query(
      `UPDATE wh_personas SET title = $2, description = $3, stack = $4::jsonb, categories = $5::jsonb, items = $6::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, p.title, p.description, JSON.stringify(p.stack), JSON.stringify(p.categories), JSON.stringify(p.items)],
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  const all = await readFile();
  const i = all.findIndex((q) => q.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...p, updatedAt: new Date().toISOString() };
  await writeFile(all);
  return all[i];
}

export async function remove(id: string): Promise<boolean> {
  if (pool) {
    await table();
    return ((await pool.query('DELETE FROM wh_personas WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }
  const all = await readFile();
  const rest = all.filter((q) => q.id !== id);
  if (rest.length === all.length) return false;
  await writeFile(rest);
  return true;
}

/** AI 지시문에 넣을 요약 (최근 것부터, 길이 제한) */
export async function forPrompt(maxChars = 12_000): Promise<string> {
  let out = '';
  for (const p of await list()) {
    const conds = p.items
      .map((it) => {
        const { text, code: _code, ...rest } = it as Record<string, unknown>;
        return `  - ${text ?? ''} ${JSON.stringify(rest)}`;
      })
      .join('\n');
    const block = `■ ${p.title}\n${p.description ? `  설명: ${p.description.replace(/\s+/g, ' ')}\n` : ''}  조건:\n${conds}\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out;
}
