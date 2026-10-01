// Importação do CSV de pedidos (modelo "modelo pedido.csv")
// Regras confirmadas com a gestão (30/09/2026):
//  - Só linhas Tipo = PA entram como item de pedido (produto acabado). SA = componentes, ignoradas.
//  - Pedido = base do campo Número (043334/K/001 -> pedido 043334; sub-pedido K; item 001).
//  - Necessidade = "Qtde. Produzir". "Qtde. Produzida" etc. não são usados (vêm vazios);
//    o que entrou fisicamente vem da bipagem de entrada.
//  - Código de barras da embalagem = campo "Código".
//  - Chave única do item = Número completo -> reimportar não duplica.
import { parse } from 'csv-parse/sync';
import { q, tx } from '../db.js';
import { falha } from '../erros.js';
import { log } from '../auth.js';

export const normalizar = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

const chaveCol = (s) => normalizar(s).replace(/[^A-Z0-9?]/g, '');

// colunas esperadas (chave normalizada -> nome interno)
const COLUNAS = {
  'IMP?': 'imp', NUMERO: 'numero', IDENTIFICACAOOP: 'identificacao_op', TIPO: 'tipo', CODIGO: 'codigo',
  CODIGOLABORATORIO: 'codigo_laboratorio', PRODUTO: 'produto', EMISSAO: 'emissao', QTDEPRODUZIR: 'qtd_produzir',
  UNID: 'unidade', CLIENTE: 'cliente', QTDEPRODUZIDA: 'qtd_produzida', QTDEPERDA: 'qtd_perda', DATABAIXA: 'data_baixa',
  OBSERVACOESPARAPRODUCAO: 'observacoes', PRECOVENDA: 'preco_venda', PREVINICIO: 'prev_inicio', INICIOREAL: 'inicio_real',
  TERMINOREAL: 'termino_real', CODIGOCOR: 'cor', PREVTERMINO: 'prev_termino', CONFIRMACAO: 'confirmacao',
};
const OBRIGATORIAS = ['numero', 'tipo', 'codigo', 'produto', 'emissao', 'qtd_produzir', 'cliente'];

// Funciona no Node e no navegador (TextDecoder / Web Crypto)
function decodificar(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { return new TextDecoder('windows-1252').decode(u8); } // Latin-1 (padrão do sistema de origem)
}
async function sha256(buf) {
  const h = await globalThis.crypto.subtle.digest('SHA-256', buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function dataBR(s) {
  const m = String(s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, a] = m;
  const dt = new Date(`${a}-${mo}-${d}T00:00:00Z`);
  if (isNaN(dt) || dt.getUTCDate() !== +d) return null;
  return `${a}-${mo}-${d}`;
}
const numBR = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
};

// Similaridade de nomes (coeficiente de Dice sobre bigramas, sem espaços) + contém
function similar(a, b) {
  const x = a.replace(/[^A-Z0-9]/g, ''), y = b.replace(/[^A-Z0-9]/g, '');
  if (!x || !y) return 0;
  if (x.length >= 6 && y.length >= 6 && (x.startsWith(y) || y.startsWith(x))) return 0.95;
  const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** Lê um CSV genérico (qualquer cabeçalho) e devolve objetos {coluna: valor} */
export function lerTabela(buf) {
  const texto = decodificar(buf);
  const primeira = texto.split(/\r?\n/)[0] || '';
  const delimiter = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
  const reg = parse(texto, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true });
  if (reg.length < 2) falha('O arquivo não tem linhas de dados.');
  return reg.slice(1).map((r) => Object.fromEntries(reg[0].map((c, i) => [c, r[i]])));
}

export function lerCsv(buf) {
  const texto = decodificar(buf);
  const primeira = texto.split(/\r?\n/)[0] || '';
  const delimiter = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
  let registros;
  try {
    registros = parse(texto, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true });
  } catch (e) {
    falha('Não foi possível ler o arquivo CSV: ' + e.message);
  }
  if (registros.length < 2) falha('O arquivo não tem linhas de dados.');
  const cab = registros[0];
  const mapa = cab.map((c) => COLUNAS[chaveCol(c)] || null);
  const faltando = OBRIGATORIAS.filter((o) => !mapa.includes(o));
  if (faltando.length) falha('Colunas obrigatórias ausentes: ' + faltando.join(', '), { dados: { cabecalho: cab } });
  const linhas = registros.slice(1).map((r, i) => {
    const o = { _linha: i + 2 };
    mapa.forEach((k, j) => { if (k) o[k] = (r[j] ?? '').trim(); });
    return o;
  });
  return { linhas, colunas: cab, colunasReconhecidas: mapa.filter(Boolean), delimiter };
}

/** Analisa as linhas contra o banco e classifica cada uma. Não grava nada. */
export async function analisar(linhas, client = { query: q }) {
  const db = client;
  const consultas = [
    `SELECT pi.numero_origem, pi.qtd_pedida, p.numero pedido, pr.codigo, pi.cliente_id, pi.emissao
              FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id JOIN produtos pr ON pr.id=pi.produto_id`,
    'SELECT id, numero FROM pedidos',
    'SELECT a.nome_origem, a.cliente_id, c.nome FROM cliente_aliases a JOIN clientes c ON c.id=a.cliente_id',
    'SELECT id, nome, codigo FROM clientes',
    'SELECT id, codigo FROM produtos',
  ];
  const res = [];
  for (const sql of consultas) res.push(await db.query(sql)); // sequencial: mesmo client da transação
  const [itensDb, pedidosDb, aliasesDb, clientesDb, produtosDb] = res;
  const itemExiste = new Map(itensDb.rows.map((r) => [r.numero_origem, r]));
  const pedidoExiste = new Set(pedidosDb.rows.map((r) => r.numero));
  const alias = new Map(aliasesDb.rows.map((r) => [r.nome_origem, r]));
  const produtoExiste = new Set(produtosDb.rows.map((r) => r.codigo));

  const vistos = new Set();
  const resultado = [];
  for (const l of linhas) {
    const r = { linha: l._linha, numero: l.numero, tipo: normalizar(l.tipo), codigo: normalizar(l.codigo), produto: l.produto,
      cliente: normalizar(l.cliente), qtd: numBR(l.qtd_produzir), unidade: l.unidade, emissao: dataBR(l.emissao),
      codigo_laboratorio: l.codigo_laboratorio, cor: l.cor, preco_venda: numBR(l.preco_venda), resultado: null, motivo: null, alerta: null };
    const m = String(l.numero || '').trim().match(/^([^/]+)\/([^/]+)\/([^/]+)$/);
    if (m) { r.pedido = m[1]; r.sub = m[2]; r.seq = m[3]; }
    const pend = (mot) => { r.resultado = 'PENDENTE'; r.motivo = mot; };

    if (!l.numero) pend('Número vazio');
    else if (!m) pend('Número fora do padrão BASE/SUB/ITEM');
    else if (vistos.has(l.numero)) { r.resultado = 'DUPLICADA_ARQUIVO'; r.motivo = 'Número repetido dentro do próprio arquivo'; }
    else if (r.tipo === 'SA') { r.resultado = 'IGNORADA_SA'; r.motivo = 'SA = componente/insumo (não entra no estoque físico)'; }
    else if (r.tipo !== 'PA') { r.resultado = 'IGNORADA_SA'; r.motivo = `Tipo "${l.tipo}" não é PA`; }
    else if (!r.codigo) pend('Produto sem código');
    else if (!r.cliente) pend('Linha sem cliente');
    else if (!l.unidade) pend('Linha sem unidade');
    else if (r.qtd == null || r.qtd <= 0 || !Number.isInteger(r.qtd)) pend(`Quantidade inválida: "${l.qtd_produzir}"`);
    else if (!r.emissao) pend(`Data de emissão inválida: "${l.emissao}"`);
    else if (itemExiste.has(l.numero)) {
      r.resultado = 'EXISTENTE'; r.motivo = 'Item já importado anteriormente';
      const ex = itemExiste.get(l.numero);
      if (ex.qtd_pedida !== r.qtd) r.alerta = `Quantidade no arquivo (${r.qtd}) diferente da já importada (${ex.qtd_pedida}) — não foi alterada`;
      else if (ex.codigo !== r.codigo) r.alerta = `Código no arquivo (${r.codigo}) diferente do já importado (${ex.codigo}) — não foi alterado`;
    } else r.resultado = 'NOVO';
    if (l.numero) vistos.add(l.numero);
    resultado.push(r);
  }

  // possível duplicidade: mesmo pedido + código + qtd + cliente em outro item com emissão diferente
  const grupos = new Map();
  const addG = (k, v) => { if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(v); };
  for (const r of resultado) if (r.resultado === 'NOVO' || r.resultado === 'EXISTENTE') addG(`${r.pedido}|${r.codigo}|${r.qtd}|${r.cliente}`, { numero: r.numero, emissao: r.emissao, r });
  for (const [, g] of grupos) {
    const emissoes = new Set(g.map((x) => x.emissao));
    if (g.length > 1 && emissoes.size > 1) {
      const primeiro = g.slice().sort((a, b) => (a.emissao < b.emissao ? -1 : 1))[0];
      for (const x of g) if (x !== primeiro && x.r.resultado === 'NOVO') {
        x.r.possivel_duplicidade = true;
        x.r.alerta = `Possível duplicidade: mesmo produto/quantidade do item ${primeiro.numero} (emitido em ${primeiro.emissao.split('-').reverse().join('/')})`;
      }
    }
  }

  // pedidos com mais de um cliente
  const cliPorPedido = new Map();
  for (const r of resultado) if (r.resultado === 'NOVO') { if (!cliPorPedido.has(r.pedido)) cliPorPedido.set(r.pedido, new Set()); cliPorPedido.get(r.pedido).add(r.cliente); }
  const pedidosMultiCliente = [...cliPorPedido].filter(([, s]) => s.size > 1).map(([p, s]) => ({ pedido: p, clientes: [...s] }));

  // clientes: novos nomes e sugestões de semelhantes
  const nomesNovos = [...new Set(resultado.filter((r) => r.resultado === 'NOVO' && !alias.has(r.cliente)).map((r) => r.cliente))].sort();
  const existentes = clientesDb.rows.map((c) => ({ id: c.id, nome: normalizar(c.nome), codigo: c.codigo }));
  const clientesNovos = nomesNovos.map((nome) => {
    const sug = [];
    for (const c of existentes) { const s = similar(nome, c.nome); if (s >= 0.8) sug.push({ tipo: 'existente', cliente_id: c.id, nome: c.nome, score: +s.toFixed(2) }); }
    for (const [a, v] of alias) { if (a === nome) continue; const s = similar(nome, a); if (s >= 0.8 && !sug.some((x) => x.cliente_id === v.cliente_id)) sug.push({ tipo: 'existente', cliente_id: v.cliente_id, nome: v.nome, score: +s.toFixed(2) }); }
    for (const o of nomesNovos) { if (o === nome) continue; const s = similar(nome, o); if (s >= 0.8) sug.push({ tipo: 'novo', nome: o, score: +s.toFixed(2) }); }
    sug.sort((a, b) => b.score - a.score);
    return { nome, itens: resultado.filter((r) => r.resultado === 'NOVO' && r.cliente === nome).length, sugestoes: sug.slice(0, 4) };
  });

  const novos = resultado.filter((r) => r.resultado === 'NOVO');
  const pedidosNoArquivo = new Set(resultado.filter((r) => r.pedido && r.tipo === 'PA' && ['NOVO', 'EXISTENTE'].includes(r.resultado)).map((r) => r.pedido));
  const pedidosNovos = new Set(novos.filter((r) => !pedidoExiste.has(r.pedido)).map((r) => r.pedido));
  const pedidosComItensNovos = new Set(novos.filter((r) => pedidoExiste.has(r.pedido)).map((r) => r.pedido));
  const pedidosSemNovidade = [...pedidosNoArquivo].filter((p) => !pedidosNovos.has(p) && !pedidosComItensNovos.has(p));
  const produtosNovos = [...new Map(novos.filter((r) => !produtoExiste.has(r.codigo)).map((r) => [r.codigo, { codigo: r.codigo, descricao: r.produto, unidade: r.unidade }])).values()];
  const cont = (res) => resultado.filter((r) => r.resultado === res).length;

  return {
    linhas: resultado,
    resumo: {
      total_linhas: resultado.length,
      linhas_pa: resultado.filter((r) => r.tipo === 'PA').length,
      linhas_sa: resultado.filter((r) => r.tipo === 'SA').length,
      itens_novos: novos.length,
      itens_existentes: cont('EXISTENTE'),
      ignoradas_sa: cont('IGNORADA_SA'),
      pendentes: cont('PENDENTE'),
      duplicadas_arquivo: cont('DUPLICADA_ARQUIVO'),
      possiveis_duplicidades: novos.filter((r) => r.possivel_duplicidade).length,
      pedidos_no_arquivo: pedidosNoArquivo.size,
      pedidos_novos: pedidosNovos.size,
      pedidos_existentes_com_itens_novos: pedidosComItensNovos.size,
      pedidos_ja_existentes_sem_novidade: pedidosSemNovidade.length,
      unidades_novas: novos.reduce((s, r) => s + r.qtd, 0),
      produtos_novos: produtosNovos.length,
      clientes_novos: clientesNovos.length,
    },
    clientesNovos,
    produtosNovos,
    pedidosMultiCliente,
  };
}

export async function gerarPrevia(buf, nomeArquivo, usuario_id) {
  const hash = await sha256(buf);
  const { linhas, colunas } = lerCsv(buf);
  const an = await analisar(linhas);
  const anterior = (await q(`SELECT id, confirmado_em FROM importacoes WHERE arquivo_hash=$1 AND status='CONFIRMADA' ORDER BY id DESC LIMIT 1`, [hash])).rows[0];
  const imp = await tx(async (c) => {
    const { rows } = await c.query(`INSERT INTO importacoes(arquivo_nome, arquivo_hash, usuario_id, status, resumo) VALUES ($1,$2,$3,'PREVIA',$4) RETURNING id`,
      [nomeArquivo, hash, usuario_id, JSON.stringify({ ...an.resumo, colunas })]);
    const id = rows[0].id;
    // grava linhas em lotes
    for (let i = 0; i < linhas.length; i += 500) {
      const lote = linhas.slice(i, i + 500);
      const vals = [], params = [];
      lote.forEach((l, j) => {
        const r = an.linhas[i + j];
        const b = params.length;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
        params.push(id, l._linha, l.numero || null, r.tipo || null, r.resultado, r.motivo, r.alerta, JSON.stringify(l));
      });
      await c.query(`INSERT INTO importacao_linhas(importacao_id,linha,numero_origem,tipo,resultado,motivo,alerta,dados) VALUES ${vals.join(',')}`, params);
    }
    return id;
  });
  return {
    importacao_id: imp,
    arquivo: nomeArquivo,
    ja_importado_em: anterior?.confirmado_em || null,
    resumo: an.resumo,
    clientesNovos: an.clientesNovos,
    produtosNovos: an.produtosNovos.slice(0, 300),
    pedidosMultiCliente: an.pedidosMultiCliente,
    pendentes: an.linhas.filter((r) => r.resultado === 'PENDENTE' || r.resultado === 'DUPLICADA_ARQUIVO'),
    alertas: an.linhas.filter((r) => r.alerta),
    amostraNovos: an.linhas.filter((r) => r.resultado === 'NOVO').slice(0, 200),
  };
}

/**
 * Confirma a importação.
 * mapaClientes: { "NOME NO CSV": { acao: 'novo' } | { acao: 'existente', cliente_id } | { acao: 'mesmo_que', nome: 'OUTRO NOME NOVO' } }
 */
export async function confirmar(importacao_id, mapaClientes = {}, usuario_id) {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(42)'); // uma importação por vez
    const imp = (await c.query('SELECT * FROM importacoes WHERE id=$1 FOR UPDATE', [importacao_id])).rows[0];
    if (!imp) falha('Importação não encontrada', { status: 404 });
    if (imp.status !== 'PREVIA') falha('Esta prévia já foi ' + (imp.status === 'CONFIRMADA' ? 'confirmada' : 'descartada') + '.');
    const linhasOrig = (await c.query('SELECT dados FROM importacao_linhas WHERE importacao_id=$1 ORDER BY linha', [importacao_id])).rows.map((r) => r.dados);
    const an = await analisar(linhasOrig, c); // reanalisa dentro da transação (evita corrida)

    // 1. clientes
    const idPorNome = new Map((await c.query('SELECT nome_origem, cliente_id FROM cliente_aliases')).rows.map((r) => [r.nome_origem, r.cliente_id]));
    const seq = async () => {
      const { rows } = await c.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo,'\\D','','g'),'')::int),0)+1 n FROM clientes WHERE codigo ~ '^CLI\\d+$'`);
      return 'CLI' + String(rows[0].n).padStart(4, '0');
    };
    const pendentesMesmoQue = [];
    let clientesCriados = 0;
    for (const cn of an.clientesNovos) {
      const acao = mapaClientes[cn.nome] || { acao: 'novo' };
      if (acao.acao === 'existente') {
        const ok = (await c.query('SELECT id FROM clientes WHERE id=$1', [acao.cliente_id])).rows[0];
        if (!ok) falha(`Cliente escolhido para "${cn.nome}" não existe.`);
        await c.query('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [acao.cliente_id, cn.nome]);
        idPorNome.set(cn.nome, acao.cliente_id);
      } else if (acao.acao === 'mesmo_que') pendentesMesmoQue.push([cn.nome, normalizar(acao.nome)]);
      else {
        const codigo = await seq();
        const { rows } = await c.query('INSERT INTO clientes(codigo,nome,codigo_barras) VALUES ($1,$2,$1) RETURNING id', [codigo, cn.nome]);
        await c.query('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [rows[0].id, cn.nome]);
        idPorNome.set(cn.nome, rows[0].id);
        clientesCriados++;
      }
    }
    for (const [nome, alvo] of pendentesMesmoQue) {
      const id = idPorNome.get(alvo);
      if (!id) falha(`"${nome}" foi marcado como mesmo cliente que "${alvo}", mas "${alvo}" não será criado.`);
      await c.query('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [id, nome]);
      idPorNome.set(nome, id);
    }

    // 2. produtos
    const prodId = new Map((await c.query('SELECT id, codigo FROM produtos')).rows.map((r) => [r.codigo, r.id]));
    let produtosCriados = 0;
    for (const r of an.linhas.filter((r) => r.resultado === 'NOVO')) {
      if (prodId.has(r.codigo)) continue;
      const { rows } = await c.query(
        `INSERT INTO produtos(codigo,codigo_barras,codigo_laboratorio,descricao,unidade,cor) VALUES ($1,$1,$2,$3,$4,$5)
         ON CONFLICT (codigo) DO UPDATE SET codigo=EXCLUDED.codigo RETURNING id`,
        [r.codigo, r.codigo_laboratorio || null, r.produto, r.unidade || null, r.cor || null]);
      prodId.set(r.codigo, rows[0].id);
      produtosCriados++;
    }

    // 3. pedidos e itens
    const pedId = new Map((await c.query('SELECT id, numero FROM pedidos')).rows.map((r) => [r.numero, r.id]));
    let pedidosCriados = 0, itensCriados = 0;
    const novos = an.linhas.filter((r) => r.resultado === 'NOVO');
    const emissaoPedido = new Map();
    for (const r of novos) if (!emissaoPedido.has(r.pedido) || r.emissao < emissaoPedido.get(r.pedido)) emissaoPedido.set(r.pedido, r.emissao);
    for (const r of novos) {
      if (!pedId.has(r.pedido)) {
        const { rows } = await c.query('INSERT INTO pedidos(numero,emissao,importacao_id) VALUES ($1,$2,$3) RETURNING id', [r.pedido, emissaoPedido.get(r.pedido), importacao_id]);
        pedId.set(r.pedido, rows[0].id);
        pedidosCriados++;
      }
      const res = await c.query(
        `INSERT INTO pedido_itens(pedido_id,numero_origem,sub_pedido,sequencia,produto_id,cliente_id,qtd_pedida,emissao,preco_venda,possivel_duplicidade,importacao_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (numero_origem) DO NOTHING`,
        [pedId.get(r.pedido), r.numero, r.sub, r.seq, prodId.get(r.codigo), idPorNome.get(r.cliente), r.qtd, r.emissao, r.preco_venda, !!r.possivel_duplicidade, importacao_id]);
      itensCriados += res.rowCount;
    }
    // atualiza emissão do pedido se veio item mais antigo
    await c.query(`UPDATE pedidos p SET emissao = s.m FROM (SELECT pedido_id, MIN(emissao) m FROM pedido_itens GROUP BY pedido_id) s WHERE s.pedido_id=p.id AND (p.emissao IS NULL OR s.m < p.emissao)`);

    // 4. atualiza resultado das linhas e fecha a importação
    await c.query(`UPDATE importacao_linhas SET resultado=CASE WHEN resultado='NOVO' THEN 'IMPORTADA' ELSE resultado END WHERE importacao_id=$1`, [importacao_id]);
    const resumoFinal = { ...an.resumo, clientes_criados: clientesCriados, produtos_criados: produtosCriados, pedidos_criados: pedidosCriados, itens_criados: itensCriados };
    await c.query(`UPDATE importacoes SET status='CONFIRMADA', confirmado_em=now(), resumo=resumo || $2 WHERE id=$1`, [importacao_id, JSON.stringify(resumoFinal)]);
    await log(usuario_id, 'IMPORTACAO_CONFIRMADA', 'importacoes', importacao_id, resumoFinal, c);
    return resumoFinal;
  });
}
