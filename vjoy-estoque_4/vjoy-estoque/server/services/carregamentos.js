// Pedidos mensais por cliente + carregamento de caminhão (bipagem) + romaneio em PDF
import PDFDocument from 'pdfkit';
import { q, tx } from '../db.js';
import { falha } from '../erros.js';
import { acharProduto, clientePorId, obterOuCriarCliente, criarMov, registrarLeitura, travarProduto, comLeitura, erroLeitura, saldosBuckets } from './estoque.js';

const TZ = process.env.TZ_EMPRESA || 'America/Sao_Paulo';
/** 'YYYY-MM' → 'YYYY-MM-01'. Sem valor = mês atual no fuso da empresa. */
export function normalizarMes(m) {
  if (m && /^\d{4}-\d{2}(-\d{2})?$/.test(m)) return m.slice(0, 7) + '-01';
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  return hoje.slice(0, 7) + '-01';
}

// ---------------------------------------------------------------- PEDIDOS MENSAIS
async function progressoPedidoMensal(c, pm) {
  const { rows } = await c.query(`
    SELECT pmi.produto_id, pr.codigo, pr.descricao, pr.unidade, pmi.quantidade pedido,
      COALESCE((SELECT SUM(ci.quantidade) FROM carregamento_itens ci JOIN carregamentos ca ON ca.id=ci.carregamento_id
                WHERE ca.pedido_mensal_id=pmi.pedido_mensal_id AND ca.status='FINALIZADO' AND ci.produto_id=pmi.produto_id),0)::int carregado,
      COALESCE((SELECT SUM(ci.quantidade) FROM carregamento_itens ci JOIN carregamentos ca ON ca.id=ci.carregamento_id
                WHERE ca.pedido_mensal_id=pmi.pedido_mensal_id AND ca.status='ABERTO' AND ci.produto_id=pmi.produto_id),0)::int em_carregamento,
      COALESCE((SELECT SUM(delta) FROM movimentacao_itens m WHERE m.produto_id=pmi.produto_id AND m.cliente_id=$2 AND m.status='ESTOQUE'),0)::int em_estoque
    FROM pedido_mensal_itens pmi JOIN produtos pr ON pr.id=pmi.produto_id
    WHERE pmi.pedido_mensal_id=$1 ORDER BY pr.codigo`, [pm.id, pm.cliente_id]);
  // produtos carregados que não estavam no pedido mensal
  const extras = (await c.query(`
    SELECT ci.produto_id, pr.codigo, pr.descricao, pr.unidade, 0 pedido, SUM(ci.quantidade) FILTER (WHERE ca.status='FINALIZADO')::int carregado,
      COALESCE(SUM(ci.quantidade) FILTER (WHERE ca.status='ABERTO'),0)::int em_carregamento, 0 em_estoque
    FROM carregamento_itens ci JOIN carregamentos ca ON ca.id=ci.carregamento_id JOIN produtos pr ON pr.id=ci.produto_id
    WHERE ca.pedido_mensal_id=$1 AND ca.status IN ('FINALIZADO','ABERTO') AND ci.quantidade > 0
      AND ci.produto_id NOT IN (SELECT produto_id FROM pedido_mensal_itens WHERE pedido_mensal_id=$1)
    GROUP BY ci.produto_id, pr.codigo, pr.descricao, pr.unidade`, [pm.id])).rows.map((r) => ({ ...r, carregado: r.carregado || 0, fora_do_pedido: true }));
  const itens = [...rows, ...extras].map((i) => ({ ...i, falta: Math.max(0, i.pedido - i.carregado) }));
  const tot = (k) => itens.reduce((s, i) => s + (i[k] || 0), 0);
  return { ...pm, itens, total_pedido: tot('pedido'), total_carregado: tot('carregado'), total_em_carregamento: tot('em_carregamento'), total_falta: tot('falta') };
}

export async function pedidoMensal(cliente_id, mesStr) {
  const mes = normalizarMes(mesStr);
  const cli = await clientePorId({ query: q }, cliente_id);
  if (!cli) falha('Cliente não encontrado', { status: 404 });
  const pm = (await q('SELECT * FROM pedidos_mensais WHERE cliente_id=$1 AND mes=$2', [cliente_id, mes])).rows[0];
  const carregamentos = (await q(`SELECT ca.id, ca.status, ca.placa, ca.motorista, ca.criado_em, ca.finalizado_em, u.nome usuario,
      COALESCE((SELECT SUM(quantidade) FROM carregamento_itens WHERE carregamento_id=ca.id),0)::int pecas
    FROM carregamentos ca JOIN usuarios u ON u.id=ca.usuario_id
    WHERE ca.cliente_id=$1 AND ca.status<>'CANCELADO' AND (ca.pedido_mensal_id = $2 OR (ca.pedido_mensal_id IS NULL AND date_trunc('month', ca.criado_em AT TIME ZONE '${TZ}')::date = $3::date))
    ORDER BY ca.id DESC`, [cliente_id, pm?.id || 0, mes])).rows;
  return { cliente: cli, mes, pedido: pm ? await progressoPedidoMensal({ query: q }, pm) : null, carregamentos };
}

export async function resumoMensal(mesStr) {
  const mes = normalizarMes(mesStr);
  const pms = (await q(`SELECT pm.*, cl.nome cliente FROM pedidos_mensais pm JOIN clientes cl ON cl.id=pm.cliente_id WHERE pm.mes=$1 ORDER BY cl.nome`, [mes])).rows;
  const out = [];
  for (const pm of pms) {
    const p = await progressoPedidoMensal({ query: q }, pm);
    out.push({ id: pm.id, cliente_id: pm.cliente_id, cliente: pm.cliente, mes, produtos: p.itens.filter((i) => !i.fora_do_pedido).length,
      total_pedido: p.total_pedido, total_carregado: p.total_carregado, total_em_carregamento: p.total_em_carregamento, total_falta: p.total_falta });
  }
  return { mes, pedidos: out };
}

/** Lê planilha/CSV com Código + Quantidade (cabeçalhos repetidos e linhas de relatório são ignorados) */
export async function lerListaMensal(buf, nome) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const linhas = await lerLinhasCruas(u8, nome);
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  let iCod = 0, iQtd = -1;
  const cab = linhas.find((l) => l.some((v) => ['CODIGO', 'COD', 'PRODUTO', 'REFERENCIA'].includes(norm(v))) && l.some((v) => /^(QTD|QTDE|QUANT|QUANTIDADE|PECAS)/.test(norm(v))));
  if (cab) {
    iCod = cab.findIndex((v) => ['CODIGO', 'COD', 'PRODUTO', 'REFERENCIA'].includes(norm(v)));
    iQtd = cab.findIndex((v) => /^(QTD|QTDE|QUANT|QUANTIDADE|PECAS)/.test(norm(v)));
  }
  const itens = new Map();
  let ignoradas = 0;
  for (const l of linhas) {
    if (l === cab) continue;
    const cod = String(l[iCod] ?? '').trim().toUpperCase();
    let qtdBruta = iQtd >= 0 ? l[iQtd] : l.slice(1).find((v) => /^\s*\d+([.,]\d+)?\s*$/.test(String(v ?? '')));
    const qtd = Math.round(Number(String(qtdBruta ?? '').replace(/\./g, '').replace(',', '.')));
    if (!cod || !(qtd > 0) || ['CODIGO', 'COD'].includes(norm(cod))) { ignoradas++; continue; }
    itens.set(cod, (itens.get(cod) || 0) + qtd);
  }
  const lista = [];
  for (const [codigo, quantidade] of itens) {
    const p = await acharProduto({ query: q }, codigo);
    lista.push({ codigo: p?.codigo || codigo, lido: codigo, quantidade, descricao: p?.descricao || null, existe: !!p });
  }
  return { itens: lista, ignoradas, total: lista.reduce((s, i) => s + i.quantidade, 0) };
}

async function lerLinhasCruas(u8, nome) {
  const ehXlsx = u8[0] === 0x50 && u8[1] === 0x4b;
  if (ehXlsx) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(u8); } catch (e) { falha('Não foi possível ler a planilha: ' + e.message); }
    const linhas = [];
    for (const ws of wb.worksheets) ws.eachRow({ includeEmpty: false }, (row) => linhas.push(row.values.slice(1).map((c) => (c && typeof c === 'object' ? (c.text ?? c.result ?? '') : c))));
    return linhas;
  }
  const { parse } = await import('csv-parse/sync');
  let texto;
  try { texto = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { texto = new TextDecoder('windows-1252').decode(u8); }
  const primeira = texto.split(/\r?\n/)[0] || '';
  const delimiter = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : (primeira.includes('\t') ? '\t' : ',');
  if (!texto.trim()) falha(`O arquivo ${nome} está vazio.`);
  return parse(texto, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true });
}

/** Grava (substitui) a lista do mês. itens: [{codigo, quantidade}] — códigos fora da base viram produto novo. */
export async function salvarPedidoMensal({ cliente_id, mes: mesStr, itens, observacao }, usuario) {
  const mes = normalizarMes(mesStr);
  if (!Array.isArray(itens) || !itens.length) falha('A lista está vazia.');
  return tx(async (c) => {
    const cli = await clientePorId(c, cliente_id);
    if (!cli) falha('Cliente não encontrado.');
    let pm = (await c.query('SELECT * FROM pedidos_mensais WHERE cliente_id=$1 AND mes=$2 FOR UPDATE', [cliente_id, mes])).rows[0];
    if (!pm) pm = (await c.query('INSERT INTO pedidos_mensais(cliente_id,mes,observacao,criado_por) VALUES ($1,$2,$3,$4) RETURNING *', [cliente_id, mes, observacao || null, usuario.id])).rows[0];
    else await c.query('UPDATE pedidos_mensais SET atualizado_em=now(), observacao=COALESCE($2,observacao) WHERE id=$1', [pm.id, observacao || null]);
    await c.query('DELETE FROM pedido_mensal_itens WHERE pedido_mensal_id=$1', [pm.id]);
    const somados = new Map();
    let criados = 0;
    for (const it of itens) {
      const cod = String(it.codigo || '').trim().toUpperCase();
      const qtd = Math.trunc(Number(it.quantidade));
      if (!cod || !(qtd > 0)) continue;
      let p = await acharProduto(c, cod);
      if (!p) {
        p = (await c.query(`INSERT INTO produtos(codigo,codigo_barras,descricao,unidade) VALUES ($1,$1,'SEM DESCRIÇÃO (lista mensal)','PC') RETURNING *`, [cod])).rows[0];
        criados++;
      }
      somados.set(p.id, (somados.get(p.id) || 0) + qtd);
    }
    for (const [produto_id, quantidade] of somados) await c.query('INSERT INTO pedido_mensal_itens(pedido_mensal_id,produto_id,quantidade) VALUES ($1,$2,$3)', [pm.id, produto_id, quantidade]);
    await c.query('INSERT INTO logs(usuario_id,acao,entidade,entidade_id,detalhes) VALUES ($1,$2,$3,$4,$5)', [usuario.id, 'PEDIDO_MENSAL_SALVO', 'pedidos_mensais', pm.id, JSON.stringify({ cliente_id, mes, produtos: somados.size, criados })]);
    return { ok: true, id: pm.id, produtos: somados.size, total: [...somados.values()].reduce((s, n) => s + n, 0), produtos_criados: criados };
  });
}

// ---------------------------------------------------------------- CARREGAMENTO
export async function abrirCarregamento(body, usuario) {
  return tx(async (c) => {
    let cli = body.cliente_id ? await clientePorId(c, body.cliente_id) : body.cliente_nome ? await obterOuCriarCliente(c, body.cliente_nome, usuario) : null;
    if (!cli) falha('Escolha o cliente.');
    const mes = normalizarMes(body.mes);
    const pm = (await c.query('SELECT id FROM pedidos_mensais WHERE cliente_id=$1 AND mes=$2', [cli.id, mes])).rows[0];
    const { rows } = await c.query(`INSERT INTO carregamentos(cliente_id,pedido_mensal_id,placa,motorista,observacao,usuario_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cli.id, pm?.id || null, (body.placa || '').trim().toUpperCase() || null, (body.motorista || '').trim() || null, (body.observacao || '').trim() || null, usuario.id]);
    return rows[0];
  });
}

async function estoqueCliente(c, produto_id, cliente_id) {
  return (await c.query(`SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND cliente_id=$2 AND status='ESTOQUE'`, [produto_id, cliente_id])).rows[0].n;
}

export async function detalheCarregamento(id) {
  const ca = (await q(`SELECT ca.*, cl.nome cliente, cl.codigo cliente_codigo, u.nome usuario, f.nome finalizado_por_nome, pm.mes
    FROM carregamentos ca JOIN clientes cl ON cl.id=ca.cliente_id JOIN usuarios u ON u.id=ca.usuario_id
    LEFT JOIN usuarios f ON f.id=ca.finalizado_por LEFT JOIN pedidos_mensais pm ON pm.id=ca.pedido_mensal_id WHERE ca.id=$1`, [id])).rows[0];
  if (!ca) falha('Carregamento não encontrado', { status: 404 });
  const itens = (await q(`SELECT ci.produto_id, ci.quantidade, pr.codigo, pr.descricao, pr.unidade,
      COALESCE((SELECT quantidade FROM pedido_mensal_itens WHERE pedido_mensal_id=$2 AND produto_id=ci.produto_id),0)::int pedido_mes,
      COALESCE((SELECT SUM(x.quantidade) FROM carregamento_itens x JOIN carregamentos y ON y.id=x.carregamento_id
                WHERE y.pedido_mensal_id=$2 AND y.status='FINALIZADO' AND y.id<>$1 AND x.produto_id=ci.produto_id),0)::int carregado_antes,
      COALESCE((SELECT SUM(delta) FROM movimentacao_itens m WHERE m.produto_id=ci.produto_id AND m.cliente_id=$3 AND m.status='ESTOQUE'),0)::int em_estoque
    FROM carregamento_itens ci JOIN produtos pr ON pr.id=ci.produto_id WHERE ci.carregamento_id=$1 AND ci.quantidade>0 ORDER BY pr.codigo`, [id, ca.pedido_mensal_id || 0, ca.cliente_id])).rows;
  const pendentes = ca.pedido_mensal_id ? (await progressoPedidoMensal({ query: q }, { id: ca.pedido_mensal_id, cliente_id: ca.cliente_id })) : null;
  const leituras = (await q(`SELECT l.id, l.criado_em, l.nivel, l.resultado, l.mensagem, l.codigo_lido FROM leituras l WHERE l.carregamento_id=$1 ORDER BY l.id DESC LIMIT 40`, [id])).rows;
  return { ...ca, itens, total: itens.reduce((s, i) => s + i.quantidade, 0), pedido_mensal: pendentes, leituras };
}

/** Bipagem no caminhão. confirmar: lista de alertas já aceitos pelo operador ('SEM_ESTOQUE', 'ACIMA_PEDIDO') */
export async function biparCarregamento(id, body, usuario) {
  const qtd = Math.trunc(Number(body.quantidade ?? 1));
  const confirmados = new Set([].concat(body.confirmar || []));
  const base = { operacao: 'CARREGAMENTO', codigo_lido: body.codigo, usuario_id: usuario.id, carregamento_id: id };
  return comLeitura(base, async (c) => {
    const ca = (await c.query('SELECT * FROM carregamentos WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!ca) falha('Carregamento não encontrado', { status: 404 });
    // leitura reenviada pelo aparelho (feita sem internet): se já foi gravada, devolve o mesmo resultado
    const chave = body.chave ? String(body.chave).slice(0, 80) : null;
    if (chave) {
      const ja = (await c.query('SELECT resposta FROM envios_aparelho WHERE chave=$1', [chave])).rows[0];
      if (ja) return { ...ja.resposta, repetido: true };
    }
    if (ca.status !== 'ABERTO') falha('Este carregamento já foi encerrado.');
    base.cliente_id = ca.cliente_id;
    if (!(qtd >= 1 && qtd <= 1000)) erroLeitura('Quantidade inválida.', { codigo: 'QUANTIDADE_INVALIDA' });
    const prod = await acharProduto(c, body.codigo);
    if (!prod) erroLeitura(`Código fora da base: "${String(body.codigo).trim().toUpperCase()}"`, { codigo: 'CODIGO_INEXISTENTE' });
    await travarProduto(c, prod.id);
    const lk = { produto_id: prod.id };
    const ja = (await c.query('SELECT quantidade FROM carregamento_itens WHERE carregamento_id=$1 AND produto_id=$2', [id, prod.id])).rows[0]?.quantidade || 0;
    // pedido mensal
    if (ca.pedido_mensal_id && !confirmados.has('ACIMA_PEDIDO')) {
      const meta = (await c.query('SELECT quantidade FROM pedido_mensal_itens WHERE pedido_mensal_id=$1 AND produto_id=$2', [ca.pedido_mensal_id, prod.id])).rows[0]?.quantidade || 0;
      const antes = (await c.query(`SELECT COALESCE(SUM(x.quantidade),0)::int n FROM carregamento_itens x JOIN carregamentos y ON y.id=x.carregamento_id
        WHERE y.pedido_mensal_id=$1 AND y.status='FINALIZADO' AND x.produto_id=$2`, [ca.pedido_mensal_id, prod.id])).rows[0].n;
      if (antes + ja + qtd > meta) {
        erroLeitura(meta ? `${prod.codigo}: o pedido do mês é ${meta} e já foram ${antes + ja} (${antes} em caminhões anteriores + ${ja} neste). Carregar acima do pedido?`
          : `${prod.codigo} não está no pedido mensal deste cliente. Carregar mesmo assim?`,
          { codigo: 'CONFIRMAR', nivel: 'ALERTA', status: 409, leitura: lk, dados: { tipo: 'ACIMA_PEDIDO', meta, carregado: antes + ja } });
      }
    }
    // estoque do cliente
    const estoque = await estoqueCliente(c, prod.id, ca.cliente_id);
    const falta = ja + qtd - estoque;
    let observacao = null;
    if (falta > 0) {
      if (!confirmados.has('SEM_ESTOQUE')) {
        erroLeitura(`${prod.codigo}: no estoque deste cliente há ${Math.max(0, estoque - ja)} disponível. Se a peça está aqui, o sistema registra a entrada que faltou e carrega.`,
          { codigo: 'CONFIRMAR', nivel: 'ALERTA', status: 409, leitura: lk, dados: { tipo: 'SEM_ESTOQUE', disponivel: Math.max(0, estoque - ja) } });
      }
      // a peça existe fisicamente mas não tinha entrada: registra a entrada (rastreável)
      await criarMov(c, { tipo: 'ENTRADA', usuario_id: usuario.id, carregamento_id: id, observacao: 'Entrada registrada no carregamento (peça sem entrada anterior)' },
        [{ produto_id: prod.id, cliente_id: ca.cliente_id, localizacao_id: null, pedido_item_id: null, status: 'ESTOQUE', delta: falta }]);
      observacao = `Entrada automática de ${falta} un. (não havia entrada)`;
    }
    await c.query(`INSERT INTO carregamento_itens(carregamento_id,produto_id,quantidade) VALUES ($1,$2,$3)
      ON CONFLICT (carregamento_id,produto_id) DO UPDATE SET quantidade = carregamento_itens.quantidade + EXCLUDED.quantidade`, [id, prod.id, qtd]);
    const total = (await c.query('SELECT COALESCE(SUM(quantidade),0)::int n FROM carregamento_itens WHERE carregamento_id=$1', [id])).rows[0].n;
    const lidoEm = body.lido_em && !Number.isNaN(Date.parse(body.lido_em)) ? new Date(body.lido_em) : null;
    const offline = lidoEm ? ` · lido sem internet em ${lidoEm.toLocaleString('pt-BR', { timeZone: process.env.TZ_EMPRESA || 'America/Sao_Paulo' })}` : '';
    await registrarLeitura(c, { ...base, ...lk, resultado: observacao ? 'CARREGADO_SEM_ENTRADA' : 'OK', nivel: observacao ? 'ALERTA' : 'SUCESSO', mensagem: (observacao || `+${qtd} (${ja + qtd} no caminhão)`) + offline });
    const resposta = { nivel: observacao ? 'ALERTA' : 'SUCESSO', mensagem: observacao || 'CARREGADO', produto: { codigo: prod.codigo, descricao: prod.descricao }, quantidade: qtd, no_caminhao: ja + qtd, total };
    if (chave) await c.query('INSERT INTO envios_aparelho(chave,carregamento_id,usuario_id,resposta,lido_em) VALUES ($1,$2,$3,$4,$5)', [chave, id, usuario.id, resposta, lidoEm]);
    return resposta;
  });
}

export async function retirarDoCarregamento(id, produto_id, quantidade, usuario) {
  const n = Math.max(1, Math.trunc(Number(quantidade || 1)));
  return tx(async (c) => {
    const ca = (await c.query('SELECT * FROM carregamentos WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!ca || ca.status !== 'ABERTO') falha('Carregamento não está aberto.');
    const it = (await c.query('SELECT * FROM carregamento_itens WHERE carregamento_id=$1 AND produto_id=$2', [id, produto_id])).rows[0];
    if (!it || it.quantidade < n) falha('Não há essa quantidade no caminhão.');
    await c.query('UPDATE carregamento_itens SET quantidade=quantidade-$3 WHERE carregamento_id=$1 AND produto_id=$2', [id, produto_id, n]);
    await registrarLeitura(c, { operacao: 'CARREGAMENTO', codigo_lido: '-', resultado: 'RETIRADO', nivel: 'ALERTA', mensagem: `Retirado ${n} un. do caminhão`, usuario_id: usuario.id, produto_id, cliente_id: ca.cliente_id, carregamento_id: id });
    return { ok: true };
  });
}

/** Fecha o caminhão: baixa o estoque do cliente (saída) e libera o romaneio em PDF */
export async function finalizarCarregamento(id, usuario) {
  return tx(async (c) => {
    const ca = (await c.query('SELECT * FROM carregamentos WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!ca || ca.status !== 'ABERTO') falha('Carregamento não está aberto.');
    const itens = (await c.query('SELECT ci.*, pr.codigo FROM carregamento_itens ci JOIN produtos pr ON pr.id=ci.produto_id WHERE carregamento_id=$1 AND quantidade>0', [id])).rows;
    if (!itens.length) falha('Nenhum produto foi carregado.');
    const linhas = [];
    for (const it of itens) {
      await travarProduto(c, it.produto_id);
      let resta = it.quantidade;
      // 1º estoque sem pedido, depois o ligado a pedidos (mais antigos primeiro)
      const buckets = await saldosBuckets(c, `produto_id=$1 AND cliente_id=$2 AND status='ESTOQUE'`, [it.produto_id, ca.cliente_id]);
      buckets.sort((a, b) => (a.pedido_item_id ? 1 : 0) - (b.pedido_item_id ? 1 : 0));
      for (const b of buckets) {
        if (!resta) break;
        const n = Math.min(resta, b.qtd);
        linhas.push({ ...b, status: 'ESTOQUE', delta: -n }, { ...b, status: 'EXPEDIDO', delta: n });
        resta -= n;
      }
      if (resta) falha(`${it.codigo}: faltam ${resta} un. no estoque do cliente (outro carregamento pode ter usado). Retire do caminhão ou bipe de novo.`);
    }
    await criarMov(c, { tipo: 'EXPEDICAO', usuario_id: usuario.id, carregamento_id: id, observacao: `Carregamento nº ${id}${ca.placa ? ' · placa ' + ca.placa : ''}` }, linhas);
    await c.query(`UPDATE carregamentos SET status='FINALIZADO', finalizado_em=now(), finalizado_por=$2 WHERE id=$1`, [id, usuario.id]);
    await c.query('DELETE FROM carregamento_itens WHERE carregamento_id=$1 AND quantidade=0', [id]);
    return { ok: true, id, pecas: itens.reduce((s, i) => s + i.quantidade, 0), produtos: itens.length };
  });
}

export async function cancelarCarregamento(id, usuario) {
  const r = await q(`UPDATE carregamentos SET status='CANCELADO', finalizado_em=now(), finalizado_por=$2 WHERE id=$1 AND status='ABERTO' RETURNING id`, [id, usuario.id]);
  if (!r.rowCount) falha('Carregamento não está aberto.');
  return { ok: true };
}

export async function listarCarregamentos({ status, cliente_id, de, ate } = {}) {
  const w = [`ca.status <> 'CANCELADO'`], p = [];
  if (status) { p.push(status); w.push(`ca.status=$${p.length}`); }
  if (cliente_id) { p.push(+cliente_id); w.push(`ca.cliente_id=$${p.length}`); }
  if (de && /^\d{4}-\d{2}-\d{2}$/.test(de)) { p.push(de); w.push(`(ca.criado_em AT TIME ZONE '${TZ}')::date >= $${p.length}::date`); }
  if (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) { p.push(ate); w.push(`(ca.criado_em AT TIME ZONE '${TZ}')::date <= $${p.length}::date`); }
  return (await q(`SELECT ca.id, ca.status, ca.placa, ca.motorista, ca.criado_em, ca.finalizado_em, cl.nome cliente, ca.cliente_id, u.nome usuario,
      COALESCE((SELECT SUM(quantidade) FROM carregamento_itens WHERE carregamento_id=ca.id),0)::int pecas,
      (SELECT COUNT(*) FROM carregamento_itens WHERE carregamento_id=ca.id AND quantidade>0)::int produtos
    FROM carregamentos ca JOIN clientes cl ON cl.id=ca.cliente_id JOIN usuarios u ON u.id=ca.usuario_id
    WHERE ${w.join(' AND ')} ORDER BY (ca.status='ABERTO') DESC, ca.id DESC LIMIT 200`, p)).rows;
}

// ---------------------------------------------------------------- ROMANEIO (PDF)
const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const mesNome = (m) => (m ? new Date(m + 'T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

export async function romaneioPdf(id) {
  const ca = await detalheCarregamento(id);
  if (ca.status === 'CANCELADO') falha('Carregamento cancelado.');
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Romaneio de carregamento ${id}`, Author: 'VJOY Estoque' } });
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  const fim = new Promise((ok) => doc.on('end', ok));
  const W = doc.page.width - 80;
  const cor = '#0f4c81';

  doc.rect(40, 40, W, 56).fill(cor);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('ROMANEIO DE CARREGAMENTO', 54, 52);
  doc.font('Helvetica').fontSize(10).text(ca.status === 'FINALIZADO' ? 'Documento para faturamento' : 'PRÉVIA — carregamento ainda aberto', 54, 76);
  doc.font('Helvetica-Bold').fontSize(22).text(`Nº ${String(id).padStart(5, '0')}`, 40, 56, { width: W - 14, align: 'right' });

  doc.fillColor('#111').font('Helvetica').fontSize(10);
  let y = 112;
  const campo = (rot, val, x, w) => {
    doc.fillColor('#666').fontSize(8).text(rot.toUpperCase(), x, y, { width: w });
    doc.fillColor('#111').fontSize(11).font('Helvetica-Bold').text(val || '—', x, y + 11, { width: w });
    doc.font('Helvetica');
  };
  campo('Cliente', ca.cliente, 40, W * 0.55); campo('Data do carregamento', fmt(ca.finalizado_em || ca.criado_em), 40 + W * 0.58, W * 0.42);
  y += 36;
  campo('Placa', ca.placa, 40, W * 0.25); campo('Motorista', ca.motorista, 40 + W * 0.27, W * 0.3); campo('Pedido do mês', mesNome(ca.mes) || 'sem pedido mensal', 40 + W * 0.58, W * 0.42);
  y += 36;
  campo('Responsável', ca.finalizado_por_nome || ca.usuario, 40, W * 0.55); campo('Observação', ca.observacao, 40 + W * 0.58, W * 0.42);
  y += 44;

  // tabela
  const col = [{ t: 'Código', w: 0.2 }, { t: 'Descrição', w: 0.58 }, { t: 'Unid.', w: 0.08 }, { t: 'Quantidade', w: 0.14, dir: true }];
  const linhaCab = () => {
    doc.rect(40, y, W, 20).fill('#e8eef5');
    let x = 40;
    doc.fillColor('#333').font('Helvetica-Bold').fontSize(9);
    for (const c of col) { doc.text(c.t.toUpperCase(), x + 6, y + 6, { width: W * c.w - 12, align: c.dir ? 'right' : 'left' }); x += W * c.w; }
    y += 20; doc.font('Helvetica');
  };
  linhaCab();
  ca.itens.forEach((it, i) => {
    const h = Math.max(20, doc.heightOfString(it.descricao, { width: W * 0.58 - 12, fontSize: 9 }) + 10);
    if (y + h > doc.page.height - 120) { doc.addPage(); y = 40; linhaCab(); }
    if (i % 2) doc.rect(40, y, W, h).fill('#f7f9fc');
    let x = 40;
    doc.fillColor('#111').fontSize(9);
    const vals = [it.codigo, it.descricao, it.unidade || 'PC', String(it.quantidade)];
    vals.forEach((v, k) => { doc.font(k === 0 || k === 3 ? 'Helvetica-Bold' : 'Helvetica').text(v, x + 6, y + 5, { width: W * col[k].w - 12, align: col[k].dir ? 'right' : 'left' }); x += W * col[k].w; });
    y += h;
  });
  doc.moveTo(40, y).lineTo(40 + W, y).strokeColor('#0f4c81').lineWidth(1.5).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(`TOTAL: ${ca.total} peças · ${ca.itens.length} produto(s)`, 40, y, { width: W, align: 'right' });
  y += 50;
  if (y > doc.page.height - 110) { doc.addPage(); y = 80; }
  const ass = (rot, x) => { doc.moveTo(x, y).lineTo(x + W * 0.42, y).strokeColor('#999').lineWidth(0.8).stroke(); doc.font('Helvetica').fontSize(9).fillColor('#555').text(rot, x, y + 4, { width: W * 0.42, align: 'center' }); };
  ass('Conferente / Expedição', 40); ass('Motorista', 40 + W * 0.58);
  doc.fontSize(7.5).fillColor('#888').text(`Gerado pelo VJOY Estoque em ${fmt(new Date())}`, 40, doc.page.height - 50, { width: W, align: 'center' });
  doc.end();
  await fim;
  // junta os pedaços sem depender de Buffer (o mesmo código roda na versão de teste no navegador)
  const out = new Uint8Array(partes.reduce((n, b) => n + b.length, 0));
  let pos = 0; for (const b of partes) { out.set(b, pos); pos += b.length; }
  return typeof Buffer !== 'undefined' ? Buffer.from(out.buffer) : out;
}
