import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(1082, (v) => v); // DATE como texto 'YYYY-MM-DD'
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint -> number (COUNT)
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number

const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/vjoyestoque', ssl, max: 15 });

export const q = (text, params) => pool.query(text, params);

/** Executa fn dentro de uma transação. fn recebe o client. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function migrar() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  await q(`CREATE TABLE IF NOT EXISTS _migracoes (nome TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT now())`);
  const feitas = new Set((await q('SELECT nome FROM _migracoes')).rows.map((r) => r.nome));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (feitas.has(f)) continue;
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO _migracoes(nome) VALUES ($1)', [f]);
    });
    console.log('Migração aplicada:', f);
  }
}
