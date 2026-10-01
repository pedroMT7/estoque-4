// Consultas, dashboard, relatórios e rastreabilidade (somente leitura)
import { q } from '../db.js';
import { falha } from '../erros.js';
import { statusPedido, resumoItens, agregar, acharProduto, acharCliente } from './estoque.js';

export const TZ = process.env.TZ_EMPRESA || 'America/Sao_Paulo';
const diaLocal = (col) => `(${col} AT TIME ZONE '${TZ}')::date`;
const hojeLocal = `(now() AT TIME ZONE '${TZ}')::date`;

// ---------------------------------------------------------------- PEDIDOS
const SQL_PEDIDOS = `
  WITH it AS (
    SELECT r.pedido_id, SUM(r.qtd_pedida)::int pedida, SUM(r.entrou+r.vinculado+r.ajustado)::int recebido,
      SUM(r.em_estoque)::int em_estoque, SUM(r.separado)::int separado, SUM(r.na_doca)::int na_doca,
      SUM(r.conferido)::int conferido, SUM(r.expedido)::int expedido, COUNT(*)::int itens,
      bool_and(r.expedido >= r.qtd_pedida) todos_expedidos,
      bool_or(r.expedido < r.qtd_pedida AND (r.entrou+r.vinculado+r.ajustado) < r.qtd_pedida) falta_receber,
      string_agg(DISTINCT c.nome, ' / ') clientes, string_agg(DISTINCT l.codigo, ', ') ruas,
      bool_or(pi.possivel_duplicidade) possivel_duplicidade,
      array_agg(DISTINCT pi.cliente_id) cliente_ids
    FROM v_item_resumo r JOIN pedido_itens pi ON pi.id=r.pedido_item_id
    JOIN clientes c ON c.id=pi.cliente_id LEFT JOIN localizacoes l ON l.id=c.localizacao_id
    GROUP BY r.pedido_id)
  SELECT p.id, p.numero, p.emissao, p.cancelado, it.*,
    EXISTS(SELECT 1 FROM separacoes s WHERE s.pedido_id=p.id AND s.status='ABERTA') separacao_aberta,
    (SELECT id FROM conferencias cf WHERE cf.pedido_id=p.id AND cf.status='ABERTA') conferencia_aberta_id
  FROM pedidos p JOIN it ON it.pedido_id=p.id`;

function comStatus(r) {
  return { ...r, status: statusPedido(r, { cancelado: r.cancelado, separacao_aberta: r.separacao_aberta, conferencia_aberta: !!r.conferencia_aberta_id }) };
}

export async function listarPedidos({ busca, status, cliente_id, etapa } = {}) {
  const w = [], p = [];
  if (busca) { p.push(`%${busca.trim().toUpperCase()}%`); w.push(`(p.numero ILIKE $${p.length} OR it.clientes ILIKE $${p.length} OR EXISTS (SELECT 1 FROM pedido_itens x JOIN produtos pr ON pr.id=x.produto_id WHERE x.pedido_id=p.id AND (pr.codigo ILIKE $${p.length} OR x.numero_origem ILIKE $${p.length})))`); }
  if (cliente_id) { p.push(+cliente_id); w.push(`$${p.length} = ANY(it.cliente_ids)`); }
  const { rows } = await q(`${SQL_PEDIDOS} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.emissao DESC, p.numero DESC`, p);
  let lista = rows.map(comStatus);
  const ETAPAS = {
    separacao: ['PRONTO', 'RECEBENDO', 'EM_SEPARACAO', 'EXPEDIDO_PARCIAL'],
    conferencia: ['NA_DOCA', 'EM_CONFERENCIA'],
    expedicao: ['CONFERIDO'],
    saida: ['AGUARDANDO', 'RECEBENDO', 'PRONTO', 'EM_SEPARACAO', 'NA_DOCA', 'EM_CONFERENCIA', 'EXPEDIDO_PARCIAL'],
    abertos: ['AGUARDANDO', 'RECEBENDO', 'PRONTO', 'EM_SEPARACAO', 'NA_DOCA', 'EM_CONFERENCIA', 'CONFERIDO', 'EXPEDIDO_PARCIAL'],
  };
  if (etapa && ETAPAS[etapa]) lista = lista.filter((x) => ETAPAS[etapa].includes(x.status));
  if (status) lista = lista.filter((x) => x.status === status);
  if (etapa === 'saida') lista.sort((a, b) => (b.em_estoque + b.separado + b.na_doca) - (a.em_estoque + a.separado + a.na_doca));
  return lista.map(({ cliente_ids, ...x }) => x);
}

export async function detalhePedido(id) {
  const ped = (await q(`${SQL_PEDIDOS} WHERE p.id=$1`, [id])).rows[0];
  if (!ped) falha('Pedido não encontrado', { status: 404 });
  const itens = await resumoItens({ query: q }, 'pi.pedido_id=$1', [id]);
  const [separacoes, conferencias, expedicoes] = await Promise.all([
    q(`SELECT s.*, u.nome usuario, f.nome finalizado_por_nome FROM separacoes s JOIN usuarios u ON u.id=s.usuario_id LEFT JOIN usuarios f ON f.id=s.finalizado_por WHERE pedido_id=$1 ORDER BY id DESC`, [id]),
    q(`SELECT c.*, u.nome usuario, f.nome finalizado_por_nome, a.nome autorizado_por_nome,
         (SELECT count(*)::int FROM leituras l WHERE l.conferencia_id=c.id AND l.nivel<>'SUCESSO') divergencias
       FROM conferencias c JOIN usuarios u ON u.id=c.usuario_id LEFT JOIN usuarios f ON f.id=c.finalizado_por LEFT JOIN usuarios a ON a.id=c.autorizado_por
       WHERE pedido_id=$1 ORDER BY id DESC`, [id]),
    q(`SELECT e.*, u.nome usuario FROM expedicoes e JOIN usuarios u ON u.id=e.usuario_id WHERE pedido_id=$1 ORDER BY id DESC`, [id]),
  ]);
  const { cliente_ids, ...rest } = comStatus(ped);
  return { ...rest, itens, separacoes: separacoes.rows, conferencias: conferencias.rows, expedicoes: expedicoes.rows };
}

export async function detalheSeparacao(id) {
  const sep = (await q(`SELECT s.*, p.numero pedido, u.nome usuario FROM separacoes s JOIN pedidos p ON p.id=s.pedido_id JOIN usuarios u ON u.id=s.usuario_id WHERE s.id=$1`, [id])).rows[0];
  if (!sep) falha('Separação não encontrada', { status: 404 });
  const itens = await resumoItens({ query: q }, 'pi.pedido_id=$1', [sep.pedido_id]);
  // disponível na rua: saldo ESTOQUE do próprio item + livre do cliente
  const disp = (await q(`
    SELECT pi.id, COALESCE((SELECT SUM(delta) FROM movimentacao_itens m WHERE m.pedido_item_id=pi.id AND m.status='ESTOQUE'),0)::int proprio,
      COALESCE((SELECT SUM(delta) FROM movimentacao_itens m WHERE m.pedido_item_id IS NULL AND m.status='ESTOQUE' AND m.produto_id=pi.produto_id AND m.cliente_id=pi.cliente_id),0)::int livre
    FROM pedido_itens pi WHERE pi.pedido_id=$1`, [sep.pedido_id])).rows;
  const dm = new Map(disp.map((d) => [d.id, d]));
  const leituras = (await q(`SELECT l.*, pr.codigo FROM leituras l LEFT JOIN produtos pr ON pr.id=l.produto_id WHERE separacao_id=$1 ORDER BY id DESC LIMIT 30`, [id])).rows;
  return {
    ...sep,
    itens: itens.map((i) => ({ ...i, a_separar: Math.max(0, i.qtd_pedida - i.separado - i.na_doca - i.conferido - i.expedido), disponivel: dm.get(i.pedido_item_id)?.proprio + dm.get(i.pedido_item_id)?.livre })),
    leituras,
  };
}

export async function detalheConferencia(id) {
  const conf = (await q(`SELECT c.*, p.numero pedido, u.nome usuario FROM conferencias c JOIN pedidos p ON p.id=c.pedido_id JOIN usuarios u ON u.id=c.usuario_id WHERE c.id=$1`, [id])).rows[0];
  if (!conf) falha('Conferência não encontrada', { status: 404 });
  const itens = (await q(`
    SELECT ci.*, r.na_doca doca_atual, (r.em_estoque + r.separado + r.na_doca)::int disp_item, pi.cliente_id, pi.produto_id, pi.numero_origem, pr.codigo, pr.descricao, cl.nome cliente, l.codigo rua
    FROM conferencia_itens ci JOIN pedido_itens pi ON pi.id=ci.pedido_item_id JOIN v_item_resumo r ON r.pedido_item_id=pi.id
    JOIN produtos pr ON pr.id=pi.produto_id JOIN clientes cl ON cl.id=pi.cliente_id LEFT JOIN localizacoes l ON l.id=cl.localizacao_id
    WHERE ci.conferencia_id=$1 ORDER BY pr.codigo, pi.numero_origem`, [id])).rows;
  const leituras = (await q(`SELECT l.*, pr.codigo FROM leituras l LEFT JOIN produtos pr ON pr.id=l.produto_id WHERE conferencia_id=$1 ORDER BY id DESC LIMIT 50`, [id])).rows;
  const clientes = [...new Set(itens.map((i) => i.cliente))];
  if (conf.modo === 'DIRETA') { // estoque disponível para a saída (do item + sem pedido do mesmo cliente)
    const livre = new Map();
    for (const i of itens) {
      const k = i.produto_id + '|' + i.cliente_id;
      if (!livre.has(k)) livre.set(k, (await q(`SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND cliente_id=$2 AND pedido_item_id IS NULL AND status='ESTOQUE'`, [i.produto_id, i.cliente_id])).rows[0].n);
    }
    for (const i of itens) i.disponivel = i.disp_item + livre.get(i.produto_id + '|' + i.cliente_id);
  }
  return { ...conf, clientes, itens, leituras,
    total_esperado: itens.reduce((s, i) => s + i.esperado, 0), total_conferido: itens.reduce((s, i) => s + i.conferido, 0),
    divergencias: leituras.filter((l) => l.nivel !== 'SUCESSO').length };
}

// ---------------------------------------------------------------- ESTOQUE ATUAL
export async function estoqueAtual({ cliente_id, produto, rua, pedido, status = 'ESTOQUE', busca, tipo } = {}) {
  const w = ['1=1'], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replaceAll('$?', `$${p.length}`)); };
  if (status && status !== 'TODOS') add(`s.status = $?`, status);
  else w.push(`s.status <> 'EXPEDIDO'`);
  if (cliente_id) add(`s.cliente_id = $?`, +cliente_id);
  if (produto) add(`(pr.codigo ILIKE $? OR pr.descricao ILIKE $?)`, `%${produto}%`);
  if (rua) add(`l.codigo ILIKE $?`, `%${rua}%`);
  if (pedido) add(`(p.numero ILIKE $? OR pi.numero_origem ILIKE $?)`, `%${pedido}%`);
  if (busca) add(`(pr.codigo_barras = UPPER($?) OR pr.codigo ILIKE '%'||$?||'%' OR cl.codigo_barras = UPPER($?) OR cl.nome ILIKE '%'||$?||'%')`, busca.trim());
  if (tipo === 'sobra') w.push(`(s.pedido_item_id IS NULL OR r.expedido >= r.qtd_pedida OR p.cancelado)`);
  if (tipo === 'pedido') w.push(`(s.pedido_item_id IS NOT NULL AND r.expedido < r.qtd_pedida AND NOT p.cancelado)`);
  const { rows } = await q(`
    SELECT s.produto_id, s.cliente_id, s.localizacao_id, s.pedido_item_id, s.status, s.qtd,
      cl.nome cliente, cl.codigo cliente_codigo, l.codigo rua, pr.codigo, pr.descricao, pr.unidade,
      p.numero pedido, p.id pedido_id, pi.numero_origem item, pi.qtd_pedida, r.expedido,
      (s.pedido_item_id IS NULL OR r.expedido >= r.qtd_pedida OR COALESCE(p.cancelado,false)) sobra
    FROM v_saldos s
    JOIN produtos pr ON pr.id=s.produto_id JOIN clientes cl ON cl.id=s.cliente_id
    LEFT JOIN localizacoes l ON l.id=s.localizacao_id
    LEFT JOIN pedido_itens pi ON pi.id=s.pedido_item_id LEFT JOIN pedidos p ON p.id=pi.pedido_id
    LEFT JOIN v_item_resumo r ON r.pedido_item_id=s.pedido_item_id
    WHERE s.qtd > 0 AND ${w.join(' AND ')}
    ORDER BY l.codigo NULLS LAST, cl.nome, pr.codigo, p.numero`, p);
  return rows;
}

// ---------------------------------------------------------------- CONSULTA POR CÓDIGO
export async function consultarCodigo(codigo) {
  const db = { query: q };
  const cli = await acharCliente(db, codigo);
  if (cli) {
    const saldo = await estoqueAtual({ cliente_id: cli.id, status: 'TODOS' });
    return { tipo: 'cliente', cliente: cli, saldo };
  }
  const loc = (await q('SELECT * FROM localizacoes WHERE UPPER(codigo)=UPPER($1)', [String(codigo).trim()])).rows[0];
  if (loc) {
    const saldo = await estoqueAtual({ rua: loc.codigo, status: 'TODOS' });
    const clientes = (await q('SELECT id, nome, codigo FROM clientes WHERE localizacao_id=$1 ORDER BY nome', [loc.id])).rows;
    return { tipo: 'rua', rua: loc, clientes, saldo };
  }
  const prod = await acharProduto(db, codigo);
  if (prod) {
    const saldo = (await estoqueAtual({ status: 'TODOS' })).filter((s) => s.produto_id === prod.id);
    const pedidos = await resumoItens(db, 'pi.produto_id=$1 AND NOT p.cancelado AND r.expedido < r.qtd_pedida', [prod.id]);
    return { tipo: 'produto', produto: prod, saldo, pedidos };
  }
  return { tipo: 'nenhum' };
}

// ---------------------------------------------------------------- SOBRAS
export async function sobras() {
  // saldo físico (em estoque) que já não é necessário: item atendido, pedido cancelado ou estoque livre
  const { rows } = await q(`
    SELECT s.produto_id, s.cliente_id, s.localizacao_id, s.pedido_item_id, s.qtd saldo,
      cl.nome cliente, l.codigo rua, pr.codigo, pr.descricao, p.numero pedido, p.id pedido_id, pi.numero_origem item,
      pi.qtd_pedida, r.entrou + r.vinculado + r.ajustado entrou, r.expedido saiu, p.cancelado,
      (SELECT MIN(m.criado_em) FROM movimentacao_itens mi JOIN movimentacoes m ON m.id=mi.movimentacao_id
        WHERE mi.produto_id=s.produto_id AND mi.cliente_id=s.cliente_id AND mi.pedido_item_id IS NOT DISTINCT FROM s.pedido_item_id AND mi.status='ESTOQUE' AND mi.delta>0) desde
    FROM v_saldos s JOIN produtos pr ON pr.id=s.produto_id JOIN clientes cl ON cl.id=s.cliente_id
    LEFT JOIN localizacoes l ON l.id=s.localizacao_id
    LEFT JOIN pedido_itens pi ON pi.id=s.pedido_item_id LEFT JOIN pedidos p ON p.id=pi.pedido_id
    LEFT JOIN v_item_resumo r ON r.pedido_item_id=s.pedido_item_id
    WHERE s.status='ESTOQUE' AND s.qtd>0 AND (s.pedido_item_id IS NULL OR r.expedido >= r.qtd_pedida OR p.cancelado)
    ORDER BY cl.nome, pr.codigo`);
  // para livres, "entrou" = entradas livres do cliente/produto
  for (const r of rows) {
    if (!r.pedido_item_id) {
      const e = (await q(`SELECT COALESCE(SUM(mi.delta) FILTER (WHERE m.tipo='ENTRADA'),0)::int e FROM movimentacao_itens mi JOIN movimentacoes m ON m.id=mi.movimentacao_id
        WHERE mi.produto_id=$1 AND mi.cliente_id=$2 AND mi.pedido_item_id IS NULL`, [r.produto_id, r.cliente_id])).rows[0];
      r.entrou = e.e; r.saiu = 0;
    }
  }
  return rows;
}

export async function destinosParaSobra(produto_id) {
  return resumoItens({ query: q }, 'pi.produto_id=$1 AND NOT p.cancelado AND (r.entrou+r.vinculado+r.ajustado) < pi.qtd_pedida AND r.expedido < pi.qtd_pedida', [produto_id]);
}

// ---------------------------------------------------------------- DASHBOARD
export async function dashboard() {
  const um = async (sql, p) => (await q(sql, p)).rows[0];
  const [entradasHoje, saldoStatus, expedidosHoje, divHoje, divTotal, sob, pedidosEtapas, ultimas] = await Promise.all([
    um(`SELECT COALESCE(SUM(mi.delta),0)::int un, COUNT(DISTINCT m.id)::int leituras FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id
        WHERE m.tipo='ENTRADA' AND ${diaLocal('m.criado_em')} = ${hojeLocal}`),
    q(`SELECT status, SUM(qtd)::int qtd FROM v_saldos GROUP BY status`),
    um(`SELECT COALESCE(SUM(mi.delta),0)::int un, COUNT(DISTINCT m.pedido_id)::int pedidos FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id
        WHERE m.tipo='EXPEDICAO' AND mi.status='EXPEDIDO' AND ${diaLocal('m.criado_em')} = ${hojeLocal}`),
    um(`SELECT COUNT(*) FILTER (WHERE nivel='ERRO')::int erros, COUNT(*) FILTER (WHERE nivel='ALERTA')::int alertas FROM leituras WHERE ${diaLocal('criado_em')} = ${hojeLocal}`),
    um(`SELECT COUNT(*)::int n FROM leituras WHERE nivel<>'SUCESSO' AND criado_em > now() - interval '30 days'`),
    sobras(),
    listarPedidos({ etapa: 'abertos' }),
    q(`SELECT m.id, m.tipo, m.criado_em, m.observacao, u.nome usuario, p.numero pedido,
         (SELECT SUM(ABS(delta))::int FROM movimentacao_itens x WHERE x.movimentacao_id=m.id AND x.delta>0) qtd,
         (SELECT string_agg(DISTINCT pr.codigo, ', ') FROM movimentacao_itens x JOIN produtos pr ON pr.id=x.produto_id WHERE x.movimentacao_id=m.id) produtos
       FROM movimentacoes m JOIN usuarios u ON u.id=m.usuario_id LEFT JOIN pedidos p ON p.id=m.pedido_id ORDER BY m.id DESC LIMIT 15`),
  ]);
  const st = Object.fromEntries(saldoStatus.rows.map((r) => [r.status, r.qtd]));
  const cont = (s) => pedidosEtapas.filter((p) => p.status === s).length;
  return {
    entradas_hoje: entradasHoje.un,
    estoque_atual: st.ESTOQUE || 0,
    separados: st.SEPARADO || 0,
    na_doca: st.DOCA || 0,
    conferidos: st.CONFERIDO || 0,
    expedidos_hoje: expedidosHoje.un,
    pedidos_expedidos_hoje: expedidosHoje.pedidos,
    expedidos_total: st.EXPEDIDO || 0,
    sobras_unidades: sob.reduce((s, r) => s + r.saldo, 0),
    sobras_linhas: sob.length,
    divergencias_hoje: divHoje.erros + divHoje.alertas,
    erros_hoje: divHoje.erros,
    alertas_hoje: divHoje.alertas,
    divergencias_30d: divTotal.n,
    pedidos: {
      aguardando: cont('AGUARDANDO'), recebendo: cont('RECEBENDO'), prontos: cont('PRONTO'), em_separacao: cont('EM_SEPARACAO'),
      na_doca: cont('NA_DOCA'), em_conferencia: cont('EM_CONFERENCIA'), conferidos: cont('CONFERIDO'), parciais: cont('EXPEDIDO_PARCIAL'),
    },
    ultimas: ultimas.rows,
  };
}

// ---------------------------------------------------------------- RELATÓRIOS
function filtroPeriodo(f, col, p, w) {
  if (f.de) { p.push(f.de); w.push(`${diaLocal(col)} >= $${p.length}::date`); }
  if (f.ate) { p.push(f.ate); w.push(`${diaLocal(col)} <= $${p.length}::date`); }
}

async function relMovimentos(f, tipos, statusLinha) {
  const w = [`m.tipo = ANY($1)`], p = [tipos];
  if (statusLinha) { p.push(statusLinha); w.push(`mi.status = $${p.length} AND mi.delta > 0`); } else w.push('mi.delta <> 0');
  filtroPeriodo(f, 'm.criado_em', p, w);
  if (f.cliente_id) { p.push(+f.cliente_id); w.push(`mi.cliente_id = $${p.length}`); }
  if (f.produto) { p.push(`%${f.produto}%`); w.push(`pr.codigo ILIKE $${p.length}`); }
  if (f.usuario_id) { p.push(+f.usuario_id); w.push(`m.usuario_id = $${p.length}`); }
  if (f.pedido) { p.push(`%${f.pedido}%`); w.push(`(pd.numero ILIKE $${p.length})`); }
  const { rows } = await q(`
    SELECT m.id mov, m.tipo, m.criado_em, u.nome usuario, a.nome autorizado_por, m.observacao,
      pr.codigo, pr.descricao, cl.nome cliente, l.codigo rua, pd.numero pedido, pi.numero_origem item, mi.status, mi.delta, mi.excedente
    FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id
    JOIN usuarios u ON u.id=m.usuario_id LEFT JOIN usuarios a ON a.id=m.autorizado_por
    JOIN produtos pr ON pr.id=mi.produto_id JOIN clientes cl ON cl.id=mi.cliente_id LEFT JOIN localizacoes l ON l.id=mi.localizacao_id
    LEFT JOIN pedido_itens pi ON pi.id=mi.pedido_item_id LEFT JOIN pedidos pd ON pd.id=COALESCE(pi.pedido_id, m.pedido_id)
    WHERE ${w.join(' AND ')} ORDER BY m.id DESC, mi.id LIMIT 5000`, p);
  return rows;
}

export async function relatorio(tipo, f = {}) {
  const dataOk = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : undefined);
  f = { ...f, de: dataOk(f.de), ate: dataOk(f.ate) };
  switch (tipo) {
    case 'estoque': return estoqueAtual({ ...f, status: f.status || 'ESTOQUE' });
    case 'entradas': return relMovimentos(f, ['ENTRADA'], 'ESTOQUE');
    case 'saidas': return relMovimentos(f, ['EXPEDICAO'], 'EXPEDIDO');
    case 'movimentacoes': return relMovimentos(f, ['ENTRADA', 'SEPARACAO', 'ESTORNO_SEPARACAO', 'DOCA', 'CONFERENCIA', 'EXPEDICAO', 'AJUSTE', 'VINCULO', 'TRANSFERENCIA'].filter((t) => !f.tipo || t === f.tipo));
    case 'sobras': return sobras();
    case 'divergencias': {
      const w = [`l.nivel <> 'SUCESSO'`], p = [];
      filtroPeriodo(f, 'l.criado_em', p, w);
      if (f.usuario_id) { p.push(+f.usuario_id); w.push(`l.usuario_id=$${p.length}`); }
      if (f.operacao) { p.push(f.operacao); w.push(`l.operacao=$${p.length}`); }
      const { rows } = await q(`
        SELECT l.id, l.criado_em, l.operacao, l.resultado, l.nivel, l.mensagem, l.codigo_lido, u.nome usuario, a.nome autorizado_por,
          pr.codigo, cl.nome cliente, p.numero pedido
        FROM leituras l JOIN usuarios u ON u.id=l.usuario_id LEFT JOIN usuarios a ON a.id=l.autorizado_por
        LEFT JOIN produtos pr ON pr.id=l.produto_id LEFT JOIN clientes cl ON cl.id=l.cliente_id LEFT JOIN pedidos p ON p.id=l.pedido_id
        WHERE ${w.join(' AND ')} ORDER BY l.id DESC LIMIT 5000`, p);
      const aj = await q(`SELECT a.id, a.criado_em, 'AJUSTE' operacao, 'AJUSTE_MANUAL' resultado, 'ALERTA' nivel,
          a.motivo || ' (' || a.quantidade_anterior || ' → ' || a.quantidade_final || ')' mensagem, '' codigo_lido, u.nome usuario, NULL autorizado_por, pr.codigo, cl.nome cliente, NULL pedido
        FROM ajustes a JOIN usuarios u ON u.id=a.usuario_id JOIN produtos pr ON pr.id=a.produto_id JOIN clientes cl ON cl.id=a.cliente_id
        ${f.de || f.ate ? 'WHERE ' + [f.de ? `${diaLocal('a.criado_em')} >= '${f.de}'::date` : null, f.ate ? `${diaLocal('a.criado_em')} <= '${f.ate}'::date` : null].filter(Boolean).join(' AND ') : ''}`);
      return f.operacao && f.operacao !== 'AJUSTE' ? rows : [...rows, ...aj.rows].sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    }
    case 'excedente': {
      // necessidade (pedido) x recebido (entradas + vínculos + ajustes)
      const { rows } = await q(`
        SELECT p.numero pedido, pi.numero_origem item, cl.nome cliente, pr.codigo, pr.descricao, pi.emissao,
          r.qtd_pedida necessidade, r.entrou, r.vinculado, r.ajustado, (r.entrou+r.vinculado+r.ajustado) recebido, r.expedido saiu,
          (r.entrou+r.vinculado+r.ajustado) - r.qtd_pedida excedente
        FROM v_item_resumo r JOIN pedido_itens pi ON pi.id=r.pedido_item_id JOIN pedidos p ON p.id=pi.pedido_id
        JOIN produtos pr ON pr.id=pi.produto_id JOIN clientes cl ON cl.id=pi.cliente_id
        WHERE (r.entrou+r.vinculado+r.ajustado) > r.qtd_pedida ${f.cliente_id ? 'AND pi.cliente_id=' + Number(f.cliente_id) : ''}
        ORDER BY excedente DESC, p.numero`);
      const livres = await q(`
        SELECT NULL pedido, NULL item, cl.nome cliente, pr.codigo, pr.descricao, NULL emissao, 0 necessidade,
          SUM(mi.delta)::int entrou, 0 vinculado, 0 ajustado, SUM(mi.delta)::int recebido, 0 saiu, SUM(mi.delta)::int excedente
        FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id JOIN produtos pr ON pr.id=mi.produto_id JOIN clientes cl ON cl.id=mi.cliente_id
        WHERE m.tipo='ENTRADA' AND mi.pedido_item_id IS NULL ${f.cliente_id ? 'AND mi.cliente_id=' + Number(f.cliente_id) : ''}
        GROUP BY cl.nome, pr.codigo, pr.descricao`);
      return [...rows, ...livres.rows];
    }
    case 'balanco': {
      // ENTROU x SAIU x SOBROU por produto (principal indicador)
      const w = [], p = [];
      filtroPeriodo(f, 'm.criado_em', p, w);
      if (f.cliente_id) { p.push(+f.cliente_id); w.push(`mi.cliente_id=$${p.length}`); }
      if (f.produto) { p.push(`%${f.produto}%`); w.push(`pr.codigo ILIKE $${p.length}`); }
      const { rows } = await q(`
        SELECT pr.codigo, pr.descricao,
          COALESCE(SUM(mi.delta) FILTER (WHERE m.tipo='ENTRADA'),0)::int entrou,
          COALESCE(SUM(mi.delta) FILTER (WHERE mi.status='EXPEDIDO'),0)::int saiu,
          COALESCE(SUM(mi.delta) FILTER (WHERE m.tipo='AJUSTE'),0)::int ajustes,
          COALESCE(SUM(mi.delta) FILTER (WHERE mi.status<>'EXPEDIDO'),0)::int saldo,
          COALESCE(SUM(mi.delta) FILTER (WHERE m.tipo='ENTRADA' AND mi.excedente),0)::int entrada_excedente
        FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id JOIN produtos pr ON pr.id=mi.produto_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
        GROUP BY pr.codigo, pr.descricao ORDER BY saldo DESC, entrou DESC`, p);
      return rows;
    }
    default: falha('Relatório desconhecido', { status: 404 });
  }
}

// ---------------------------------------------------------------- RASTREABILIDADE
export async function rastreio({ produto, pedido, cliente_id }) {
  const w = [], p = [];
  if (produto) { const pr = await acharProduto({ query: q }, produto); if (!pr) falha('Produto não encontrado'); p.push(pr.id); w.push(`mi.produto_id=$${p.length}`); }
  if (pedido) { p.push(pedido.trim()); w.push(`(pd.numero=$${p.length} OR pd2.numero=$${p.length})`); }
  if (cliente_id) { p.push(+cliente_id); w.push(`mi.cliente_id=$${p.length}`); }
  if (!w.length) falha('Informe produto, pedido ou cliente.');
  const { rows } = await q(`
    SELECT m.id, m.tipo, m.criado_em, u.nome usuario, a.nome autorizado_por, m.observacao,
      json_agg(json_build_object('codigo',pr.codigo,'cliente',cl.nome,'rua',l.codigo,'item',pi.numero_origem,'pedido',pd.numero,'status',mi.status,'delta',mi.delta,'excedente',mi.excedente) ORDER BY mi.id) linhas
    FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id
    JOIN usuarios u ON u.id=m.usuario_id LEFT JOIN usuarios a ON a.id=m.autorizado_por
    JOIN produtos pr ON pr.id=mi.produto_id JOIN clientes cl ON cl.id=mi.cliente_id LEFT JOIN localizacoes l ON l.id=mi.localizacao_id
    LEFT JOIN pedido_itens pi ON pi.id=mi.pedido_item_id LEFT JOIN pedidos pd ON pd.id=pi.pedido_id LEFT JOIN pedidos pd2 ON pd2.id=m.pedido_id
    WHERE ${w.join(' AND ')}
    GROUP BY m.id, u.nome, a.nome ORDER BY m.id DESC LIMIT 1000`, p);
  const ajustes = (await q(`SELECT a.*, u.nome usuario FROM ajustes a JOIN usuarios u ON u.id=a.usuario_id WHERE a.movimentacao_id = ANY($1)`, [rows.map((r) => r.id)])).rows;
  const aj = new Map(ajustes.map((a) => [a.movimentacao_id, a]));
  return rows.map((r) => ({ ...r, ajuste: aj.get(r.id) || null }));
}
