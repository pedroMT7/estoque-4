// Versão de teste: PostgreSQL rodando dentro do navegador (PGlite / WebAssembly).
// Substitui server/db.js no build de teste. As regras de negócio (server/services) são as mesmas.
import { PGlite } from '@electric-sql/pglite';
import sqlInicial from '../../../server/migrations/001_init.sql?raw';
import sqlCodigos from '../../../server/migrations/002_codigos_barras.sql?raw';
import sqlSaida from '../../../server/migrations/003_saida_direta.sql?raw';
import sqlCatalogo from '../../../server/migrations/004_catalogo_produtos.sql?raw';
import sqlCatalogo2 from '../../../server/migrations/005_catalogo_atualizado.sql?raw';
import sqlMensal from '../../../server/migrations/006_pedidos_mensais_carregamentos.sql?raw';

let db = null;
export let modoArmazenamento = 'navegador';
export const NOME_BANCO = 'vjoy-teste';

const parsers = { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v), 1082: (v) => v };
const mapear = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });

export async function iniciarBanco() {
  try {
    db = await PGlite.create(`idb://${NOME_BANCO}`, { parsers });
  } catch (e) {
    console.warn('IndexedDB indisponível, usando memória', e);
    db = await PGlite.create({ parsers });
    modoArmazenamento = 'memoria';
  }
  await migrar();
}

export const q = async (text, params) => mapear(await db.query(text, params));
export const pool = { query: q };

// Conexão única: as requisições são enfileiradas pelo servidor local, então BEGIN/COMMIT é seguro.
export async function tx(fn) {
  await db.query('BEGIN');
  try {
    const r = await fn({ query: q });
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

export async function migrar() {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migracoes (nome TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT now())`);
  const feitas = new Set((await q('SELECT nome FROM _migracoes')).rows.map((r) => r.nome));
  for (const [nome, sql] of [['001_init.sql', sqlInicial], ['002_codigos_barras.sql', sqlCodigos], ['003_saida_direta.sql', sqlSaida], ['004_catalogo_produtos.sql', sqlCatalogo], ['005_catalogo_atualizado.sql', sqlCatalogo2], ['006_pedidos_mensais_carregamentos.sql', sqlMensal]]) {
    if (!feitas.has(nome)) await db.exec('BEGIN;\n' + sql + `\nINSERT INTO _migracoes(nome) VALUES ('${nome}');\nCOMMIT;`);
  }
}

export async function fecharBanco() { try { await db?.close(); } catch {} }
