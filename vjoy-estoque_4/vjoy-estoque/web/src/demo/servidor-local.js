// "Servidor" dentro do navegador para a versão de teste.
// Registra as MESMAS rotas de server/routes/api.js num roteador simples e intercepta fetch('/api/...').
import api from '../../../server/routes/api.js';
import { ErroNegocio } from '../../../server/erros.js';
import { garantirAdmin, hashSenha } from '../../../server/auth.js';
import { q, iniciarBanco, fecharBanco, NOME_BANCO } from './db-local.js';
import { gerarPrevia, confirmar } from '../../../server/services/importacao.js';

// ---------------- JWT de teste (só identifica o usuário nesta aba)
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
const jwt = {
  sign: (payload) => 'teste.' + b64({ ...payload, iat: Date.now() }),
  verify: (t) => { if (!t || !t.startsWith('teste.')) throw new Error('token'); return unb64(t.slice(6)); },
};

// ---------------- roteador compatível com a parte do Fastify que as rotas usam
const rotas = [];
function escopo(prefixo, hooks) {
  const add = (metodo) => (caminho, a, b) => {
    const handler = b || a, opts = b ? a : {};
    const nomes = [];
    const re = new RegExp('^' + (prefixo + caminho).replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, handler, pre: opts.preHandler, hooks });
  };
  return {
    jwt,
    get: add('GET'), post: add('POST'), put: add('PUT'),
    addHook: (nome, fn) => { if (nome === 'onRequest') hooks.push(fn); },
    register: async (fn, o = {}) => fn(escopo(prefixo + (o.prefix || ''), [...hooks])),
  };
}

const ouvintes = new Set();
export const aoMudar = (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); };

let fila = Promise.resolve();
async function despachar(metodo, url, headers, corpo) {
  const u = new URL(url, location.href);
  const caminho = u.pathname.replace(/^.*?\/api\//, '/api/');
  if (caminho === '/api/saude') return [200, { ok: true }];
  for (const r of rotas) {
    if (r.metodo !== metodo) continue;
    const m = caminho.match(r.re);
    if (!m) continue;
    const req = {
      method: metodo, url: caminho, headers,
      params: Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])])),
      query: Object.fromEntries(u.searchParams),
      body: corpo instanceof FormData ? undefined : corpo,
      user: null,
      jwtVerify: async () => { req.user = jwt.verify((headers.authorization || '').replace(/^Bearer /, '')); },
      file: async () => {
        const f = corpo instanceof FormData ? [...corpo.values()].find((v) => v instanceof Blob) : null;
        if (!f) return null;
        const buf = new Uint8Array(await f.arrayBuffer());
        return { filename: f.name || 'arquivo.csv', toBuffer: async () => buf };
      },
    };
    const reply = { statusCode: 200, headers: {}, code(n) { this.statusCode = n; return this; }, header(k, v) { this.headers[k.toLowerCase()] = v; return this; }, type(v) { return this.header('content-type', v); }, send(v) { return v; } };
    try {
      for (const h of r.hooks) await h(req, reply);
      if (r.pre) await r.pre(req, reply);
      const res = await r.handler(req, reply);
      if (metodo !== 'GET' && reply.statusCode < 400 && !caminho.startsWith('/api/login')) ouvintes.forEach((f) => f({ url: caminho }));
      return [reply.statusCode, res, reply.headers];
    } catch (err) {
      if (err instanceof ErroNegocio) return [err.status, { erro: err.message, codigo: err.codigo, nivel: err.nivel || (err.status === 409 ? 'ALERTA' : 'ERRO'), dados: err.dados }];
      if (err?.code === '23505') return [409, { erro: 'Registro duplicado: ' + (err.detail || '') }];
      console.error(err);
      return [500, { erro: 'Erro interno: ' + (err?.message || err) }];
    }
  }
  return [404, { erro: 'Rota não encontrada' }];
}

export async function iniciarServidorLocal(progresso = () => {}) {
  progresso('Abrindo banco de dados de teste…');
  await iniciarBanco();
  await api(escopo('/api', []));
  await garantirAdmin();
  const { rows } = await q('SELECT count(*)::int n FROM usuarios');
  if (rows[0].n === 1) {
    for (const [nome, login, perfil] of [['Operador Estoque', 'estoque', 'ESTOQUE'], ['Operador Expedição', 'expedicao', 'EXPEDICAO'], ['Conferente', 'conferencia', 'CONFERENCIA'], ['Gestão', 'gestao', 'GESTAO']]) {
      await q('INSERT INTO usuarios(nome,login,senha_hash,perfil) VALUES ($1,$2,$3,$4)', [nome, login, await hashSenha('1234'), perfil]);
    }
  }
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!new URL(url, location.href).pathname.includes('/api/')) return fetchOriginal(input, init);
    const metodo = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let corpo = init.body;
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = {}; } }
    if (corpo == null) corpo = {};
    const exec = fila.then(() => despachar(metodo, url, headers, corpo));
    fila = exec.catch(() => {});
    const [status, dados, cab] = await exec;
    if (dados instanceof Uint8Array) return new Response(dados, { status, headers: cab || {} }); // arquivo (PDF)
    // ida e volta em JSON, como numa rede de verdade (datas viram texto etc.)
    return new Response(JSON.stringify(dados ?? {}), { status, headers: { 'content-type': 'application/json' } });
  };
}

export async function resetarDados() {
  await fecharBanco();
  await new Promise((ok) => { try { const r = indexedDB.deleteDatabase('/pglite/' + NOME_BANCO); r.onsuccess = r.onerror = r.onblocked = () => ok(); } catch { ok(); } });
  try { localStorage.removeItem('vjoy_token'); } catch {}
  location.reload();
}

// ---------------- dados de exemplo FICTÍCIOS (só quando a pessoa pede)
export async function carregarExemplo(usuarioId) {
  const clientes = ['EXEMPLO LOJA ALFA', 'EXEMPLO LOJA BETA', 'EXEMPLO LOJA GAMA'];
  const produtos = [
    ['EXBAU088CZ', 'BAU EXEMPLO CINZA 0,88 X 1,88 X 0,38'], ['EXBAU138BG', 'BAU EXEMPLO BEGE 1,38 X 1,88 X 0,38'],
    ['EXBOX096PT', 'BOX EXEMPLO PRETO 0,96 X 2,03 X 0,30'], ['EXBOX158BR', 'BOX EXEMPLO BRANCO 1,58 X 1,98 X 0,30'],
    ['EXAUX088GR', 'AUXILIAR EXEMPLO GRAFITE 0,88 X 1,88 X 0,34'],
  ];
  const hoje = new Date().toLocaleDateString('pt-BR');
  const cab = 'Imp?;Número;Identificação OP;Tipo;Código;Código Laboratório;Produto;Emissão;Qtde. Produzir;Unid.;Cliente;Qtde. Produzida;Qtde. Perda;Data Baixa;Observações para Produção;Preço Venda;Prev. Início;Início Real;Término Real;Código Cor;Prev. Término;Confirmação';
  const L = (num, tipo, cod, desc, qtd, un, cli) => `N;${num};;${tipo};${cod};EXEMPLO;${desc};${hoje};${qtd};${un};${cli};;;;;100,00;;;;;;`;
  const linhas = [cab,
    L('900001/1/001', 'PA', ...produtos[0], 2, 'PC', clientes[0]), L('900001/1/002', 'PA', ...produtos[2], 1, 'PC', clientes[0]), L('900001/1/003', 'SA', 'EXCAPA088', 'CAPA EXEMPLO (componente)', 2, 'PC', clientes[0]),
    L('900002/1/001', 'PA', ...produtos[1], 3, 'PC', clientes[1]), L('900002/1/002', 'PA', ...produtos[4], 2, 'PC', clientes[1]), L('900002/A/001', 'PA', ...produtos[3], 1, 'PC', clientes[1]),
    L('900003/1/001', 'PA', ...produtos[0], 1, 'PC', clientes[2]), L('900003/1/002', 'PA', ...produtos[3], 2, 'PC', clientes[2]), L('900003/1/003', 'SA', 'EXESTR158', 'ESTRUTURA EXEMPLO (componente)', 4, 'PC', clientes[2]),
  ];
  const buf = new TextEncoder().encode(linhas.join('\r\n'));
  const pv = await gerarPrevia(buf, 'exemplo-ficticio.csv', usuarioId);
  if (pv.resumo.itens_novos) await confirmar(pv.importacao_id, {}, usuarioId);
  else await q(`UPDATE importacoes SET status='DESCARTADA' WHERE id=$1`, [pv.importacao_id]);
  const ruas = ['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06'];
  for (const r of ruas) await q('INSERT INTO localizacoes(codigo, descricao) VALUES ($1, $2) ON CONFLICT (codigo) DO NOTHING', [r, 'Rua de exemplo']);
  for (const [i, c] of clientes.entries()) {
    await q(`UPDATE clientes SET localizacao_id=(SELECT id FROM localizacoes WHERE codigo=$2) WHERE nome=$1 AND localizacao_id IS NULL`, [c, ruas[i + 1]]);
  }
  ouvintes.forEach((f) => f({ url: '/api/exemplo' }));
  return pv.resumo;
}
