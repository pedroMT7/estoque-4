// Regras de movimentação física. Toda mudança de saldo gera movimentação (razão imutável).
// Saldo ("bucket") = produto + cliente + rua + item de pedido (NULL = livre) + status.
import { q, tx } from '../db.js';
import { falha, ErroNegocio } from '../erros.js';
import { validarAutorizacao } from '../auth.js';

const norm = (s) => String(s ?? '').trim().toUpperCase();

// ---------------------------------------------------------------- helpers
/**
 * Identifica o produto a partir do que o leitor entregou. Ordem:
 * 1) Código ou código de barras principal  2) códigos de barras adicionais (outro sistema)
 * 3) número do item do pedido (ex.: 043212/1/001 ou 0432121001)  4) etiqueta que CONTÉM o Código do produto
 */
export async function acharProduto(c, codigo) {
  const cod = norm(codigo);
  if (!cod) return null;
  let { rows } = await c.query('SELECT * FROM produtos WHERE codigo_barras=$1 OR codigo=$1 ORDER BY (codigo_barras=$1) DESC LIMIT 1', [cod]);
  if (rows[0]) return rows[0];
  ({ rows } = await c.query('SELECT p.*, true via_codigo_adicional FROM produto_codigos pc JOIN produtos p ON p.id=pc.produto_id WHERE pc.codigo=$1', [cod]));
  if (rows[0]) return rows[0];
  const soAlnum = cod.replace(/[^A-Z0-9]/g, '');
  if (soAlnum.length >= 6) {
    ({ rows } = await c.query(`SELECT DISTINCT p.* FROM pedido_itens pi JOIN produtos p ON p.id=pi.produto_id
      WHERE UPPER(pi.numero_origem)=$1 OR regexp_replace(UPPER(pi.numero_origem),'[^A-Z0-9]','','g')=$2 LIMIT 2`, [cod, soAlnum]));
    if (rows.length === 1) return { ...rows[0], via_numero_item: true };
    ({ rows } = await c.query(`SELECT * FROM produtos WHERE length(codigo) >= 6 AND position(codigo in $1) > 0 ORDER BY length(codigo) DESC LIMIT 3`, [cod]));
    if (rows.length && (rows.length === 1 || rows[0].codigo.length > rows[1].codigo.length)) return { ...rows[0], via_contem: true };
  }
  return null;
}
export async function acharCliente(c, codigo) {
  const cod = norm(codigo);
  if (!cod) return null;
  const { rows } = await c.query(
    `SELECT c.*, l.codigo rua FROM clientes c LEFT JOIN localizacoes l ON l.id=c.localizacao_id
     WHERE c.codigo_barras=$1 OR c.codigo=$1 LIMIT 1`, [cod]);
  return rows[0] || null;
}
export async function clientePorId(c, id) {
  const { rows } = await c.query('SELECT c.*, l.codigo rua FROM clientes c LEFT JOIN localizacoes l ON l.id=c.localizacao_id WHERE c.id=$1', [id]);
  return rows[0] || null;
}
const normNome = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
/** Encontra o cliente pelo nome (ou apelido do CSV); se não existir, cadastra. */
export async function obterOuCriarCliente(c, nomeBruto, usuario) {
  const nome = normNome(nomeBruto);
  if (nome.length < 2) falha('Informe o nome do cliente.');
  const ex = (await c.query('SELECT cliente_id FROM cliente_aliases WHERE nome_origem=$1', [nome])).rows[0]
    || (await c.query('SELECT id cliente_id FROM clientes WHERE UPPER(nome)=$1 LIMIT 1', [nome])).rows[0];
  if (ex) return clientePorId(c, ex.cliente_id);
  await c.query('SELECT pg_advisory_xact_lock(43)');
  const { rows } = await c.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo,'\\D','','g'),'')::int),0)+1 n FROM clientes WHERE codigo ~ '^CLI\\d+$'`);
  const codigo = 'CLI' + String(rows[0].n).padStart(4, '0');
  const novo = (await c.query('INSERT INTO clientes(codigo,nome,codigo_barras) VALUES ($1,$2,$1) RETURNING id', [codigo, nome])).rows[0];
  await c.query('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [novo.id, nome]);
  await c.query('INSERT INTO logs(usuario_id,acao,entidade,entidade_id,detalhes) VALUES ($1,$2,$3,$4,$5)', [usuario.id, 'CLIENTE_CRIADO_NA_ENTRADA', 'clientes', novo.id, JSON.stringify({ nome, codigo })]);
  return clientePorId(c, novo.id);
}
export const travarProduto = (c, produto_id) => c.query('SELECT pg_advisory_xact_lock(7, $1)', [produto_id]);
const travarPedido = (c, pedido_id) => c.query('SELECT id FROM pedidos WHERE id=$1 FOR UPDATE', [pedido_id]);

export async function criarMov(c, cab, itens) {
  const { rows } = await c.query(
    `INSERT INTO movimentacoes(tipo,usuario_id,autorizado_por,pedido_id,separacao_id,conferencia_id,expedicao_id,observacao,carregamento_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, criado_em`,
    [cab.tipo, cab.usuario_id, cab.autorizado_por || null, cab.pedido_id || null, cab.separacao_id || null, cab.conferencia_id || null, cab.expedicao_id || null, cab.observacao || null, cab.carregamento_id || null]);
  const id = rows[0].id;
  for (const i of itens) {
    await c.query(
      `INSERT INTO movimentacao_itens(movimentacao_id,produto_id,cliente_id,localizacao_id,pedido_item_id,status,delta,excedente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, i.produto_id, i.cliente_id, i.localizacao_id || null, i.pedido_item_id || null, i.status, i.delta, !!i.excedente]);
  }
  return id;
}

export async function registrarLeitura(c, l) {
  const { rows } = await (c || { query: q }).query(
    `INSERT INTO leituras(operacao,codigo_lido,resultado,nivel,mensagem,usuario_id,autorizado_por,produto_id,cliente_id,pedido_id,separacao_id,conferencia_id,movimentacao_id,carregamento_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [l.operacao, String(l.codigo_lido ?? '').slice(0, 200) || '-', l.resultado, l.nivel, l.mensagem || null, l.usuario_id, l.autorizado_por || null,
      l.produto_id || null, l.cliente_id || null, l.pedido_id || null, l.separacao_id || null, l.conferencia_id || null, l.movimentacao_id || null, l.carregamento_id || null]);
  return rows[0].id;
}

/** Erro que também é gravado como leitura (bipagem com erro/alerta) */
export class ErroLeitura extends ErroNegocio {
  constructor(msg, { codigo, nivel = 'ERRO', status = 422, dados, leitura } = {}) {
    super(msg, { status, codigo, dados });
    this.nivel = nivel;
    this.leitura = leitura;
  }
}
export const erroLeitura = (msg, opts) => { throw new ErroLeitura(msg, opts); };

/** Executa operação de bipagem: se falhar, grava a leitura com erro fora da transação. */
export async function comLeitura(base, fn) {
  try {
    return await tx(fn);
  } catch (e) {
    if (e instanceof ErroLeitura) {
      await registrarLeitura(null, { ...base, ...(e.leitura || {}), resultado: e.codigo, nivel: e.nivel, mensagem: e.message }).catch(() => {});
    }
    throw e;
  }
}

export async function saldosBuckets(c, where, params) {
  const { rows } = await c.query(
    `SELECT produto_id, cliente_id, localizacao_id, pedido_item_id, status, SUM(delta)::int qtd
     FROM movimentacao_itens WHERE ${where}
     GROUP BY produto_id, cliente_id, localizacao_id, pedido_item_id, status HAVING SUM(delta) > 0
     ORDER BY MIN(id)`, params);
  return rows;
}

export async function resumoItens(c, where, params) {
  const { rows } = await c.query(
    `SELECT r.*, (r.entrou + r.vinculado + r.ajustado) recebido,
            pi.numero_origem, pi.sub_pedido, pi.sequencia, pi.emissao, pi.possivel_duplicidade,
            pr.codigo, pr.descricao, pr.unidade, cl.nome cliente, cl.codigo cliente_codigo, l.codigo rua, p.numero pedido, p.cancelado
     FROM v_item_resumo r
     JOIN pedido_itens pi ON pi.id=r.pedido_item_id
     JOIN pedidos p ON p.id=pi.pedido_id
     JOIN produtos pr ON pr.id=pi.produto_id
     JOIN clientes cl ON cl.id=pi.cliente_id
     LEFT JOIN localizacoes l ON l.id=cl.localizacao_id
     WHERE ${where} ORDER BY pi.emissao, pi.numero_origem`, params);
  return rows;
}

/** Agrega itens (v_item_resumo) em totais do pedido */
export function agregar(itens) {
  const s = (k) => itens.reduce((a, i) => a + (i[k] || 0), 0);
  return {
    pedida: s('qtd_pedida'), recebido: s('recebido'), em_estoque: s('em_estoque'), separado: s('separado'), na_doca: s('na_doca'),
    conferido: s('conferido'), expedido: s('expedido'),
    todos_expedidos: itens.length > 0 && itens.every((i) => i.expedido >= i.qtd_pedida),
    falta_receber: itens.some((i) => i.expedido < i.qtd_pedida && i.recebido < i.qtd_pedida),
  };
}

/** Status do pedido derivado das movimentações (nunca gravado, então nunca fica inconsistente) */
export function statusPedido(a, extra = {}) {
  if (Array.isArray(a)) a = agregar(a);
  if (extra.cancelado) return 'CANCELADO';
  if (a.todos_expedidos) return 'EXPEDIDO';
  if (a.conferido > 0) return 'CONFERIDO';
  if (extra.conferencia_aberta) return 'EM_CONFERENCIA';
  if (a.na_doca > 0) return 'NA_DOCA';
  if (a.separado > 0 || extra.separacao_aberta) return 'EM_SEPARACAO';
  if (a.expedido > 0) return 'EXPEDIDO_PARCIAL';
  if (!a.falta_receber && a.pedida > 0) return 'PRONTO';
  if (a.recebido > 0) return 'RECEBENDO';
  return 'AGUARDANDO';
}

// ---------------------------------------------------------------- ENTRADA
/**
 * body: { cliente, produto, quantidade=1, confirmar?: 'EXCEDENTE'|'SEM_PEDIDO'|'CLIENTE_DIVERGENTE', autorizacao?: {login,senha} }
 */
export async function registrarEntrada(body, usuario) {
  const qtd = Math.trunc(Number(body.quantidade ?? 1));
  const base = { operacao: 'ENTRADA', codigo_lido: body.produto, usuario_id: usuario.id };
  return comLeitura(base, async (c) => {
    if (!(qtd >= 1 && qtd <= 500)) erroLeitura('Quantidade inválida.', { codigo: 'QUANTIDADE_INVALIDA' });
    // cliente: escolhido pelo nome (id ou nome digitado) ou, se preferir, pela etiqueta
    let cli;
    if (body.cliente_id) cli = await clientePorId(c, body.cliente_id);
    else if (body.cliente_nome) cli = await obterOuCriarCliente(c, body.cliente_nome, usuario);
    else cli = await acharCliente(c, body.cliente);
    if (!cli) erroLeitura(`Cliente não encontrado: "${body.cliente_nome || body.cliente || body.cliente_id}"`, { codigo: 'CLIENTE_INEXISTENTE', leitura: { codigo_lido: String(body.cliente_nome || body.cliente || '-') } });
    if (cli.status !== 'ATIVO') erroLeitura(`Cliente ${cli.nome} está inativo.`, { codigo: 'CLIENTE_INATIVO', leitura: { cliente_id: cli.id } });
    const prod = await acharProduto(c, body.produto);
    if (!prod) erroLeitura(`Código de barras inexistente: "${norm(body.produto)}"`, { codigo: 'CODIGO_INEXISTENTE', leitura: { cliente_id: cli.id } });
    if (!prod.ativo) erroLeitura(`Produto ${prod.codigo} está inativo.`, { codigo: 'PRODUTO_INATIVO', leitura: { cliente_id: cli.id, produto_id: prod.id } });
    await travarProduto(c, prod.id);
    const lk = { cliente_id: cli.id, produto_id: prod.id };

    // itens de pedido em aberto desse produto (qualquer cliente)
    const itens = (await resumoItens(c, 'pi.produto_id=$1 AND NOT p.cancelado AND r.expedido < r.qtd_pedida', [prod.id]));
    const doCliente = itens.filter((i) => i.cliente_id === cli.id);
    const outros = itens.filter((i) => i.cliente_id !== cli.id && i.recebido < i.qtd_pedida);

    let autorizado_por = null;
    const alocacoes = []; // {item|null, qtd, excedente}
    let alerta = null, semPedido = false;

    if (doCliente.length) {
      let resta = qtd;
      for (const i of doCliente) {
        const falta = i.qtd_pedida - i.recebido;
        if (falta > 0 && resta > 0) { const n = Math.min(falta, resta); alocacoes.push({ item: i, qtd: n, excedente: false }); resta -= n; }
      }
      if (resta > 0) {
        const alvo = doCliente[doCliente.length - 1];
        if (body.confirmar !== 'EXCEDENTE') {
          const outro = outros[0];
          erroLeitura(`Pedido ${alvo.pedido} já recebeu tudo deste produto (${alvo.recebido}/${alvo.qtd_pedida}). Esta unidade será registrada como SOBRA/EXCEDENTE.` +
            (outro ? ` Atenção: o cliente ${outro.cliente} (rua ${outro.rua || '—'}) tem pedido ${outro.pedido} em aberto deste produto.` : ''),
            { codigo: 'CONFIRMAR', nivel: 'ALERTA', status: 409, leitura: { ...lk, pedido_id: alvo.pedido_id },
              dados: { tipo: 'EXCEDENTE', precisaAutorizacao: false, clientesSugeridos: outro ? [{ cliente_id: outro.cliente_id, nome: outro.cliente, codigo: outro.cliente_codigo, rua: outro.rua, pedido: outro.pedido }] : [] } });
        }
        alocacoes.push({ item: alvo, qtd: resta, excedente: true });
        alerta = { resultado: 'ENTRADA_EXCEDENTE', mensagem: `Entrada acima da necessidade do pedido ${alvo.pedido}: +${resta}` };
      }
    } else if (outros.length) {
      const o = outros[0];
      const outrosClientes = [...new Map(outros.map((x) => [x.cliente_id, { cliente_id: x.cliente_id, nome: x.cliente, codigo: x.cliente_codigo, rua: x.rua, pedido: x.pedido }])).values()];
      if (body.confirmar !== 'CLIENTE_DIVERGENTE') {
        erroLeitura(`Produto associado ao cliente ${o.cliente} (pedido ${o.pedido}). Cliente bipado: ${cli.nome}.`,
          { codigo: 'CONFIRMAR', nivel: 'ALERTA', status: 409, leitura: lk, dados: { tipo: 'CLIENTE_DIVERGENTE', precisaAutorizacao: true, clientesSugeridos: outrosClientes } });
      }
      autorizado_por = await validarAutorizacao(body.autorizacao);
      alocacoes.push({ item: null, qtd, excedente: false });
      alerta = { resultado: 'CLIENTE_DIVERGENTE', mensagem: `Produto do cliente ${o.cliente} registrado no cliente ${cli.nome} (autorizado)` };
    } else {
      // sem pedido em aberto: entra direto como estoque do cliente (sem pedido vinculado)
      alocacoes.push({ item: null, qtd, excedente: false });
      semPedido = true;
    }

    const movId = await criarMov(c, { tipo: 'ENTRADA', usuario_id: usuario.id, autorizado_por, pedido_id: alocacoes[0].item?.pedido_id, observacao: alerta?.mensagem || (semPedido ? 'Entrada sem pedido em aberto' : null) },
      alocacoes.map((a) => ({ produto_id: prod.id, cliente_id: cli.id, localizacao_id: cli.localizacao_id, pedido_item_id: a.item?.pedido_item_id, status: 'ESTOQUE', delta: a.qtd, excedente: a.excedente })));

    await registrarLeitura(c, { ...base, ...lk, resultado: alerta?.resultado || (semPedido ? 'ENTRADA_SEM_PEDIDO' : 'OK'), nivel: alerta ? 'ALERTA' : 'SUCESSO', mensagem: alerta?.mensagem || (semPedido ? 'Entrada sem pedido em aberto' : 'Entrada registrada'), autorizado_por, pedido_id: alocacoes[0].item?.pedido_id, movimentacao_id: movId });

    const principal = alocacoes[0].item;
    const atualizado = principal ? (await resumoItens(c, 'pi.id=$1', [principal.pedido_item_id]))[0] : null;
    return {
      nivel: alerta ? 'ALERTA' : 'SUCESSO',
      mensagem: alerta ? alerta.mensagem : 'PRODUTO REGISTRADO NO ESTOQUE',
      movimentacao_id: movId,
      quantidade: qtd,
      sem_pedido: semPedido,
      cliente: { id: cli.id, nome: cli.nome, codigo: cli.codigo, rua: cli.rua },
      produto: { id: prod.id, codigo: prod.codigo, descricao: prod.descricao },
      pedido: atualizado ? { numero: atualizado.pedido, item: atualizado.numero_origem, recebido: atualizado.recebido, pedida: atualizado.qtd_pedida } : null,
    };
  });
}

// ---------------------------------------------------------------- SEPARAÇÃO
export async function abrirSeparacao(pedido_id, usuario) {
  return tx(async (c) => {
    await travarPedido(c, pedido_id);
    const ped = (await c.query('SELECT * FROM pedidos WHERE id=$1', [pedido_id])).rows[0];
    if (!ped) falha('Pedido não encontrado', { status: 404 });
    if (ped.cancelado) falha('Pedido cancelado.');
    const aberta = (await c.query(`SELECT * FROM separacoes WHERE pedido_id=$1 AND status='ABERTA'`, [pedido_id])).rows[0];
    if (aberta) return aberta;
    const itens = await resumoItens(c, 'pi.pedido_id=$1', [pedido_id]);
    const aSeparar = itens.reduce((s, i) => s + Math.max(0, i.qtd_pedida - i.separado - i.na_doca - i.conferido - i.expedido), 0);
    if (!aSeparar) falha('Não há itens pendentes de separação neste pedido.');
    const { rows } = await c.query('INSERT INTO separacoes(pedido_id,usuario_id) VALUES ($1,$2) RETURNING *', [pedido_id, usuario.id]);
    return rows[0];
  });
}

export async function biparSeparacao(separacao_id, codigo, usuario) {
  const base = { operacao: 'SEPARACAO', codigo_lido: codigo, usuario_id: usuario.id, separacao_id };
  return comLeitura(base, async (c) => {
    const sep = (await c.query('SELECT * FROM separacoes WHERE id=$1', [separacao_id])).rows[0];
    if (!sep) falha('Separação não encontrada', { status: 404 });
    base.pedido_id = sep.pedido_id;
    if (sep.status !== 'ABERTA') falha('Esta separação já foi encerrada.');
    await travarPedido(c, sep.pedido_id);
    const prod = await acharProduto(c, codigo);
    if (!prod) erroLeitura(`Código de barras inexistente: "${norm(codigo)}"`, { codigo: 'CODIGO_INEXISTENTE', leitura: { pedido_id: sep.pedido_id } });
    await travarProduto(c, prod.id);
    const lk = { produto_id: prod.id, pedido_id: sep.pedido_id };
    const itens = await resumoItens(c, 'pi.pedido_id=$1 AND pi.produto_id=$2', [sep.pedido_id, prod.id]);
    if (!itens.length) erroLeitura(`PRODUTO INCORRETO: ${prod.codigo} não pertence a este pedido.`, { codigo: 'PRODUTO_INCORRETO', leitura: lk });
    const pend = itens.filter((i) => i.qtd_pedida - i.separado - i.na_doca - i.conferido - i.expedido > 0);
    if (!pend.length) {
      const t = itens.reduce((a, i) => a + i.qtd_pedida, 0);
      erroLeitura(`QUANTIDADE EXCEDIDA: ${prod.codigo} já está todo separado (${t}/${t}).`, { codigo: 'QUANTIDADE_EXCEDIDA', leitura: lk });
    }
    // procura estoque: 1º do próprio item, 2º livre do mesmo cliente
    let escolhido = null, origem = null, viaLivre = false;
    for (const i of pend) {
      const proprio = await saldosBuckets(c, `pedido_item_id=$1 AND status='ESTOQUE'`, [i.pedido_item_id]);
      if (proprio.length) { escolhido = i; origem = proprio[0]; break; }
    }
    if (!escolhido) {
      for (const i of pend) {
        const livre = await saldosBuckets(c, `produto_id=$1 AND cliente_id=$2 AND pedido_item_id IS NULL AND status='ESTOQUE'`, [prod.id, i.cliente_id]);
        if (livre.length) { escolhido = i; origem = livre[0]; viaLivre = true; break; }
      }
    }
    if (!escolhido) {
      const sobras = (await c.query(`SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND status='ESTOQUE'`, [prod.id])).rows[0].n;
      erroLeitura(`ESTOQUE INSUFICIENTE: não há entrada registrada de ${prod.codigo} para este pedido.` + (sobras ? ` Existem ${sobras} un. em estoque de outros pedidos/sobras — a gestão pode vinculá-las.` : ''),
        { codigo: 'ESTOQUE_INSUFICIENTE', leitura: lk });
    }
    if (viaLivre) {
      // estoque livre do cliente é vinculado automaticamente ao item (rastreável)
      await criarMov(c, { tipo: 'VINCULO', usuario_id: usuario.id, pedido_id: sep.pedido_id, separacao_id, observacao: 'Estoque livre vinculado automaticamente na separação' }, [
        { ...origem, delta: -1 },
        { ...origem, pedido_item_id: escolhido.pedido_item_id, delta: 1 },
      ]);
    }
    const movId = await criarMov(c, { tipo: 'SEPARACAO', usuario_id: usuario.id, pedido_id: sep.pedido_id, separacao_id }, [
      { produto_id: prod.id, cliente_id: origem.cliente_id, localizacao_id: origem.localizacao_id, pedido_item_id: escolhido.pedido_item_id, status: 'ESTOQUE', delta: -1 },
      { produto_id: prod.id, cliente_id: origem.cliente_id, localizacao_id: origem.localizacao_id, pedido_item_id: escolhido.pedido_item_id, status: 'SEPARADO', delta: 1 },
    ]);
    const it = (await resumoItens(c, 'pi.id=$1', [escolhido.pedido_item_id]))[0];
    const feito = it.separado + it.na_doca + it.conferido + it.expedido;
    await registrarLeitura(c, { ...base, ...lk, cliente_id: it.cliente_id, resultado: 'OK', nivel: 'SUCESSO', mensagem: `${feito}/${it.qtd_pedida}`, movimentacao_id: movId });
    return { nivel: 'SUCESSO', mensagem: 'SEPARADO', produto: { codigo: prod.codigo, descricao: prod.descricao }, item: it.numero_origem, rua: it.rua, cliente: it.cliente, feito, total: it.qtd_pedida };
  });
}

export async function estornarSeparacao(separacao_id, pedido_item_id, usuario) {
  return tx(async (c) => {
    const sep = (await c.query('SELECT * FROM separacoes WHERE id=$1', [separacao_id])).rows[0];
    if (!sep || sep.status !== 'ABERTA') falha('Separação não está aberta.');
    await travarPedido(c, sep.pedido_id);
    const b = (await saldosBuckets(c, `pedido_item_id=$1 AND status='SEPARADO'`, [pedido_item_id]))[0];
    if (!b) falha('Não há unidade separada deste item para devolver.');
    await travarProduto(c, b.produto_id);
    await criarMov(c, { tipo: 'ESTORNO_SEPARACAO', usuario_id: usuario.id, pedido_id: sep.pedido_id, separacao_id, observacao: 'Devolvido para a rua' }, [
      { ...b, status: 'SEPARADO', delta: -1 }, { ...b, status: 'ESTOQUE', delta: 1 }]);
    return { ok: true };
  });
}

export async function enviarParaDoca(separacao_id, { confirmarIncompleto } = {}, usuario) {
  return tx(async (c) => {
    const sep = (await c.query('SELECT * FROM separacoes WHERE id=$1', [separacao_id])).rows[0];
    if (!sep || sep.status !== 'ABERTA') falha('Separação não está aberta.');
    await travarPedido(c, sep.pedido_id);
    const itens = await resumoItens(c, 'pi.pedido_id=$1', [sep.pedido_id]);
    const buckets = await saldosBuckets(c, `status='SEPARADO' AND pedido_item_id IN (SELECT id FROM pedido_itens WHERE pedido_id=$1)`, [sep.pedido_id]);
    if (!buckets.length) falha('Nenhum produto foi separado ainda.');
    const faltam = itens.reduce((s, i) => s + Math.max(0, i.qtd_pedida - i.separado - i.na_doca - i.conferido - i.expedido), 0);
    if (faltam > 0 && !confirmarIncompleto) {
      falha(`Pedido incompleto: faltam ${faltam} unidade(s) para separar. Enviar mesmo assim para a doca?`, { status: 409, codigo: 'CONFIRMAR', dados: { tipo: 'PEDIDO_INCOMPLETO', faltam } });
    }
    const movId = await criarMov(c, { tipo: 'DOCA', usuario_id: usuario.id, pedido_id: sep.pedido_id, separacao_id, observacao: faltam ? `Enviado incompleto (faltam ${faltam})` : null },
      buckets.flatMap((b) => [{ ...b, status: 'SEPARADO', delta: -b.qtd }, { ...b, status: 'DOCA', delta: b.qtd }]));
    await c.query(`UPDATE separacoes SET status='NA_DOCA', finalizado_em=now(), finalizado_por=$2 WHERE id=$1`, [separacao_id, usuario.id]);
    if (faltam) await registrarLeitura(c, { operacao: 'SEPARACAO', codigo_lido: '-', resultado: 'PEDIDO_INCOMPLETO', nivel: 'ALERTA', mensagem: `Enviado para doca incompleto: faltam ${faltam} un.`, usuario_id: usuario.id, pedido_id: sep.pedido_id, separacao_id, movimentacao_id: movId });
    return { ok: true, unidades: buckets.reduce((s, b) => s + b.qtd, 0), faltam };
  });
}

// ---------------------------------------------------------------- CONFERÊNCIA
export async function abrirConferencia(pedido_id, usuario) {
  return tx(async (c) => {
    await travarPedido(c, pedido_id);
    const aberta = (await c.query(`SELECT * FROM conferencias WHERE pedido_id=$1 AND status='ABERTA'`, [pedido_id])).rows[0];
    if (aberta) return aberta;
    const sepAberta = (await c.query(`SELECT 1 FROM separacoes WHERE pedido_id=$1 AND status='ABERTA'`, [pedido_id])).rows[0];
    if (sepAberta) falha('A separação deste pedido ainda está aberta. Envie para a doca antes de conferir.');
    const itens = await resumoItens(c, 'pi.pedido_id=$1', [pedido_id]);
    if (!itens.some((i) => i.na_doca > 0)) falha('Não há produtos deste pedido na doca.');
    const { rows } = await c.query('INSERT INTO conferencias(pedido_id,usuario_id) VALUES ($1,$2) RETURNING *', [pedido_id, usuario.id]);
    for (const i of itens) {
      const esperado = i.qtd_pedida - i.expedido - i.conferido;
      if (esperado > 0) await c.query('INSERT INTO conferencia_itens(conferencia_id,pedido_item_id,esperado,na_doca) VALUES ($1,$2,$3,$4)', [rows[0].id, i.pedido_item_id, esperado, i.na_doca]);
    }
    return rows[0];
  });
}

// ---------------------------------------------------------------- SAÍDA DIRETA POR BIPAGEM
// Bipa os produtos do pedido direto do estoque e dá saída no fim (sem passar por separação/doca).
export async function abrirSaida(pedido_id, usuario) {
  return tx(async (c) => {
    await travarPedido(c, pedido_id);
    const ped = (await c.query('SELECT * FROM pedidos WHERE id=$1', [pedido_id])).rows[0];
    if (!ped) falha('Pedido não encontrado', { status: 404 });
    if (ped.cancelado) falha('Pedido cancelado.');
    const aberta = (await c.query(`SELECT * FROM conferencias WHERE pedido_id=$1 AND status='ABERTA'`, [pedido_id])).rows[0];
    if (aberta) return aberta;
    const itens = await resumoItens(c, 'pi.pedido_id=$1', [pedido_id]);
    const pend = itens.filter((i) => i.qtd_pedida - i.expedido - i.conferido > 0);
    if (!pend.length) falha('Este pedido já saiu por completo.');
    const { rows } = await c.query(`INSERT INTO conferencias(pedido_id,usuario_id,modo) VALUES ($1,$2,'DIRETA') RETURNING *`, [pedido_id, usuario.id]);
    for (const i of pend) await c.query('INSERT INTO conferencia_itens(conferencia_id,pedido_item_id,esperado,na_doca) VALUES ($1,$2,$3,0)', [rows[0].id, i.pedido_item_id, i.qtd_pedida - i.expedido - i.conferido]);
    return rows[0];
  });
}

/** Quanto há fisicamente para a saída direta: do próprio item (rua/separado/doca) + estoque sem pedido do mesmo cliente */
async function disponivelDireta(c, conferencia_id, produto_id) {
  const itens = (await c.query(
    `SELECT ci.*, pi.cliente_id, (r.em_estoque + r.separado + r.na_doca)::int disp_item FROM conferencia_itens ci
     JOIN pedido_itens pi ON pi.id=ci.pedido_item_id JOIN v_item_resumo r ON r.pedido_item_id=pi.id
     WHERE ci.conferencia_id=$1 AND pi.produto_id=$2 ORDER BY ci.id`, [conferencia_id, produto_id])).rows;
  const livrePorCliente = new Map();
  for (const cl of new Set(itens.map((i) => i.cliente_id))) {
    const n = (await c.query(`SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND cliente_id=$2 AND pedido_item_id IS NULL AND status='ESTOQUE'`, [produto_id, cl])).rows[0].n;
    livrePorCliente.set(cl, n);
  }
  return { itens, livrePorCliente };
}

export async function biparConferencia(conferencia_id, codigo, usuario) {
  const base = { operacao: 'CONFERENCIA', codigo_lido: codigo, usuario_id: usuario.id, conferencia_id };
  return comLeitura(base, async (c) => {
    const conf = (await c.query('SELECT * FROM conferencias WHERE id=$1', [conferencia_id])).rows[0];
    if (!conf) falha('Conferência não encontrada', { status: 404 });
    base.pedido_id = conf.pedido_id;
    if (conf.status !== 'ABERTA') falha('Esta conferência já foi encerrada.');
    await travarPedido(c, conf.pedido_id);
    const prod = await acharProduto(c, codigo);
    if (!prod) erroLeitura(`Código de barras inexistente: "${norm(codigo)}"`, { codigo: 'CODIGO_INEXISTENTE' });
    const lk = { produto_id: prod.id };
    const itens = (await c.query(
      `SELECT ci.*, r.na_doca doca_atual FROM conferencia_itens ci
       JOIN pedido_itens pi ON pi.id=ci.pedido_item_id JOIN v_item_resumo r ON r.pedido_item_id=pi.id
       WHERE ci.conferencia_id=$1 AND pi.produto_id=$2 ORDER BY ci.id`, [conferencia_id, prod.id])).rows;
    if (!itens.length) erroLeitura(`PRODUTO INCORRETO: ${prod.codigo} não pertence ao pedido.`, { codigo: 'PRODUTO_INCORRETO', leitura: lk, dados: { produto: prod.codigo } });
    const esperado = itens.reduce((s, i) => s + i.esperado, 0), conferido = itens.reduce((s, i) => s + i.conferido, 0);
    const alvo = itens.find((i) => i.conferido < i.esperado);
    if (!alvo) erroLeitura(`QUANTIDADE EXCEDIDA: esperado ${esperado}, conferido ${conferido}.`, { codigo: 'QUANTIDADE_EXCEDIDA', leitura: lk, dados: { esperado, conferido } });
    let alvoDoca;
    if (conf.modo === 'DIRETA') {
      const { itens: di, livrePorCliente } = await disponivelDireta(c, conferencia_id, prod.id);
      const usadoLivre = new Map();
      for (const i of di) usadoLivre.set(i.cliente_id, (usadoLivre.get(i.cliente_id) || 0) + Math.max(0, i.conferido - i.disp_item));
      alvoDoca = di.find((i) => i.conferido < i.esperado && (i.conferido < i.disp_item || (livrePorCliente.get(i.cliente_id) || 0) - (usadoLivre.get(i.cliente_id) || 0) > 0));
      if (!alvoDoca) erroLeitura(`${prod.codigo} não consta no estoque deste cliente. Registre a entrada antes de dar saída.`, { codigo: 'SEM_ESTOQUE', leitura: lk });
    } else {
      alvoDoca = itens.find((i) => i.conferido < i.esperado && i.conferido < i.doca_atual);
      if (!alvoDoca) erroLeitura(`${prod.codigo} não consta na doca: a separação desta unidade não foi registrada.`, { codigo: 'NAO_CONSTA_NA_DOCA', leitura: lk });
    }
    await c.query('UPDATE conferencia_itens SET conferido=conferido+1 WHERE id=$1', [alvoDoca.id]);
    const tot = (await c.query('SELECT SUM(esperado)::int e, SUM(conferido)::int c FROM conferencia_itens WHERE conferencia_id=$1', [conferencia_id])).rows[0];
    await registrarLeitura(c, { ...base, ...lk, resultado: 'OK', nivel: 'SUCESSO', mensagem: `${conferido + 1}/${esperado}` });
    return { nivel: 'SUCESSO', mensagem: 'CORRETO', produto: { codigo: prod.codigo, descricao: prod.descricao }, conferido: conferido + 1, esperado, total_conferido: tot.c, total_esperado: tot.e, concluida: tot.c === tot.e };
  });
}

export async function finalizarConferencia(conferencia_id, { parcial, autorizacao } = {}, usuario) {
  return tx(async (c) => {
    const conf = (await c.query('SELECT * FROM conferencias WHERE id=$1', [conferencia_id])).rows[0];
    if (!conf || conf.status !== 'ABERTA') falha('Conferência não está aberta.');
    await travarPedido(c, conf.pedido_id);
    const itens = (await c.query(
      `SELECT ci.*, r.na_doca doca_atual, pr.codigo FROM conferencia_itens ci JOIN v_item_resumo r ON r.pedido_item_id=ci.pedido_item_id
       JOIN pedido_itens pi ON pi.id=ci.pedido_item_id JOIN produtos pr ON pr.id=pi.produto_id WHERE ci.conferencia_id=$1`, [conferencia_id])).rows;
    const esperado = itens.reduce((s, i) => s + i.esperado, 0), conferido = itens.reduce((s, i) => s + i.conferido, 0);
    let autorizado_por = null;
    if (conferido !== esperado) {
      if (!parcial) falha(`Conferência incompleta: ${conferido}/${esperado}. Todos os produtos precisam estar com a quantidade esperada.`, { status: 409, codigo: 'PEDIDO_INCOMPLETO', dados: { conferido, esperado } });
      if (conferido === 0) falha('Nenhum produto foi conferido.');
      autorizado_por = await validarAutorizacao(autorizacao);
    }
    if (conf.modo === 'DIRETA') return finalizarSaidaDireta(c, conf, itens, { conferido, esperado, autorizado_por }, usuario);
    const linhas = [];
    for (const i of itens) {
      if (i.conferido > i.doca_atual) falha(`Item ${i.codigo}: conferido ${i.conferido} mas só há ${i.doca_atual} na doca.`);
      let resta = i.conferido;
      for (const b of await saldosBuckets(c, `pedido_item_id=$1 AND status='DOCA'`, [i.pedido_item_id])) {
        if (!resta) break;
        const n = Math.min(resta, b.qtd);
        linhas.push({ ...b, status: 'DOCA', delta: -n }, { ...b, status: 'CONFERIDO', delta: n });
        resta -= n;
      }
    }
    const movId = await criarMov(c, { tipo: 'CONFERENCIA', usuario_id: usuario.id, autorizado_por, pedido_id: conf.pedido_id, conferencia_id, observacao: parcial && conferido !== esperado ? `Conferência parcial ${conferido}/${esperado}` : null }, linhas);
    await c.query(`UPDATE conferencias SET status='CONCLUIDA', parcial=$2, autorizado_por=$3, finalizado_em=now(), finalizado_por=$4 WHERE id=$1`, [conferencia_id, conferido !== esperado, autorizado_por, usuario.id]);
    if (conferido !== esperado) await registrarLeitura(c, { operacao: 'CONFERENCIA', codigo_lido: '-', resultado: 'CONFERENCIA_PARCIAL', nivel: 'ALERTA', mensagem: `Finalizada parcial ${conferido}/${esperado} (autorizado)`, usuario_id: usuario.id, autorizado_por, pedido_id: conf.pedido_id, conferencia_id, movimentacao_id: movId });
    const div = (await c.query(`SELECT count(*)::int n FROM leituras WHERE conferencia_id=$1 AND nivel<>'SUCESSO'`, [conferencia_id])).rows[0].n;
    return { ok: true, conferido, esperado, divergencias: div, parcial: conferido !== esperado };
  });
}

async function finalizarSaidaDireta(c, conf, itens, { conferido, esperado, autorizado_por }, usuario) {
  const linhas = [];
  for (const i of itens) {
    if (!i.conferido) continue;
    const pi = (await c.query('SELECT * FROM pedido_itens WHERE id=$1', [i.pedido_item_id])).rows[0];
    await travarProduto(c, pi.produto_id);
    let resta = i.conferido;
    // 1º o que já está ligado ao item (doca, separado, rua)
    for (const st of ['DOCA', 'SEPARADO', 'ESTOQUE']) {
      for (const b of await saldosBuckets(c, `pedido_item_id=$1 AND status=$2`, [i.pedido_item_id, st])) {
        if (!resta) break;
        const n = Math.min(resta, b.qtd);
        linhas.push({ ...b, status: st, delta: -n }, { ...b, status: 'EXPEDIDO', delta: n });
        resta -= n;
      }
    }
    // 2º estoque sem pedido do mesmo cliente (vinculado ao item, para rastrear)
    if (resta) {
      for (const b of await saldosBuckets(c, `produto_id=$1 AND cliente_id=$2 AND pedido_item_id IS NULL AND status='ESTOQUE'`, [pi.produto_id, pi.cliente_id])) {
        if (!resta) break;
        const n = Math.min(resta, b.qtd);
        await criarMov(c, { tipo: 'VINCULO', usuario_id: usuario.id, pedido_id: conf.pedido_id, conferencia_id: conf.id, observacao: 'Estoque sem pedido usado na saída' }, [
          { ...b, delta: -n }, { ...b, pedido_item_id: i.pedido_item_id, delta: n }]);
        linhas.push({ ...b, pedido_item_id: i.pedido_item_id, status: 'ESTOQUE', delta: -n }, { ...b, pedido_item_id: i.pedido_item_id, status: 'EXPEDIDO', delta: n });
        resta -= n;
      }
    }
    if (resta) falha(`Item ${i.codigo}: bipado ${i.conferido}, mas só há ${i.conferido - resta} no estoque.`);
  }
  const total = conferido;
  const { rows } = await c.query('INSERT INTO expedicoes(pedido_id,usuario_id,quantidade,observacao) VALUES ($1,$2,$3,$4) RETURNING id',
    [conf.pedido_id, usuario.id, total, conferido !== esperado ? `Saída parcial ${conferido}/${esperado}` : 'Saída por bipagem']);
  const expId = rows[0].id;
  await c.query('UPDATE conferencias SET status=$2, parcial=$3, autorizado_por=$4, finalizado_em=now(), finalizado_por=$5 WHERE id=$1', [conf.id, 'CONCLUIDA', conferido !== esperado, autorizado_por, usuario.id]);
  await c.query('INSERT INTO expedicao_conferencias(expedicao_id, conferencia_id) VALUES ($1,$2)', [expId, conf.id]);
  const movId = await criarMov(c, { tipo: 'EXPEDICAO', usuario_id: usuario.id, autorizado_por, pedido_id: conf.pedido_id, conferencia_id: conf.id, expedicao_id: expId, observacao: 'Saída por bipagem' }, linhas);
  if (conferido !== esperado) await registrarLeitura(c, { operacao: 'CONFERENCIA', codigo_lido: '-', resultado: 'SAIDA_PARCIAL', nivel: 'ALERTA', mensagem: `Saída parcial ${conferido}/${esperado} (autorizada)`, usuario_id: usuario.id, autorizado_por, pedido_id: conf.pedido_id, conferencia_id: conf.id, movimentacao_id: movId });
  const div = (await c.query(`SELECT count(*)::int n FROM leituras WHERE conferencia_id=$1 AND nivel<>'SUCESSO'`, [conf.id])).rows[0].n;
  const its = await resumoItens(c, 'pi.pedido_id=$1', [conf.pedido_id]);
  const sobras = its.filter((i) => i.expedido >= i.qtd_pedida && i.em_estoque + i.separado + i.na_doca + i.conferido > 0)
    .map((i) => ({ item: i.numero_origem, codigo: i.codigo, cliente: i.cliente, rua: i.rua, entrou: i.recebido, saiu: i.expedido, saldo: i.em_estoque + i.separado + i.na_doca + i.conferido }));
  return { ok: true, saida: true, conferido, esperado, unidades: total, divergencias: div, parcial: conferido !== esperado, expedicao_id: expId, sobras, status: statusPedido(its) };
}

export async function cancelarConferencia(conferencia_id, usuario) {
  const r = await q(`UPDATE conferencias SET status='CANCELADA', finalizado_em=now(), finalizado_por=$2 WHERE id=$1 AND status='ABERTA' RETURNING id`, [conferencia_id, usuario.id]);
  if (!r.rowCount) falha('Conferência não está aberta.');
  return { ok: true };
}

// ---------------------------------------------------------------- EXPEDIÇÃO
export async function expedir(pedido_id, { observacao } = {}, usuario) {
  return tx(async (c) => {
    await travarPedido(c, pedido_id);
    const buckets = await saldosBuckets(c, `status='CONFERIDO' AND pedido_item_id IN (SELECT id FROM pedido_itens WHERE pedido_id=$1)`, [pedido_id]);
    if (!buckets.length) {
      await registrarLeitura(c, { operacao: 'CONFERENCIA', codigo_lido: '-', resultado: 'EXPEDIR_SEM_CONFERENCIA', nivel: 'ERRO', mensagem: 'Tentativa de expedir sem conferência', usuario_id: usuario.id, pedido_id });
      // grava a tentativa mesmo com erro: commit acontece porque não lançamos dentro da tx
      return { erro: true, mensagem: 'Não há produtos conferidos para expedir. A saída só é permitida após a conferência.' };
    }
    const total = buckets.reduce((s, b) => s + b.qtd, 0);
    const { rows } = await c.query('INSERT INTO expedicoes(pedido_id,usuario_id,quantidade,observacao) VALUES ($1,$2,$3,$4) RETURNING id', [pedido_id, usuario.id, total, observacao || null]);
    const expId = rows[0].id;
    await c.query(`INSERT INTO expedicao_conferencias(expedicao_id, conferencia_id)
                   SELECT $1, id FROM conferencias WHERE pedido_id=$2 AND status='CONCLUIDA' AND id NOT IN (SELECT conferencia_id FROM expedicao_conferencias)`, [expId, pedido_id]);
    await criarMov(c, { tipo: 'EXPEDICAO', usuario_id: usuario.id, pedido_id, expedicao_id: expId, observacao },
      buckets.flatMap((b) => [{ ...b, status: 'CONFERIDO', delta: -b.qtd }, { ...b, status: 'EXPEDIDO', delta: b.qtd }]));
    const itens = await resumoItens(c, 'pi.pedido_id=$1', [pedido_id]);
    const sobras = itens.filter((i) => i.expedido >= i.qtd_pedida && i.em_estoque + i.separado + i.na_doca + i.conferido > 0)
      .map((i) => ({ item: i.numero_origem, codigo: i.codigo, cliente: i.cliente, rua: i.rua, entrou: i.recebido, saiu: i.expedido, saldo: i.em_estoque + i.separado + i.na_doca + i.conferido }));
    return { ok: true, expedicao_id: expId, unidades: total, sobras, status: statusPedido(itens) };
  });
}

// ---------------------------------------------------------------- AJUSTE
export async function ajustar(body, usuario) {
  const { produto_id, cliente_id, localizacao_id, pedido_item_id, contagem, motivo } = body;
  if (!motivo || String(motivo).trim().length < 5) falha('Informe o motivo do ajuste (mínimo 5 caracteres).');
  const cont = Math.trunc(Number(contagem));
  if (!(cont >= 0)) falha('Contagem física inválida.');
  return tx(async (c) => {
    await travarProduto(c, produto_id);
    const cli = (await c.query('SELECT * FROM clientes WHERE id=$1', [cliente_id])).rows[0];
    if (!cli) falha('Cliente não encontrado.');
    const loc = localizacao_id || cli.localizacao_id;
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND cliente_id=$2 AND status='ESTOQUE'
       AND localizacao_id IS NOT DISTINCT FROM $3 AND pedido_item_id IS NOT DISTINCT FROM $4`, [produto_id, cliente_id, loc, pedido_item_id || null]);
    const anterior = rows[0].n;
    const delta = cont - anterior;
    if (!delta) falha(`A contagem física (${cont}) é igual ao saldo do sistema. Nada a ajustar.`);
    const movId = await criarMov(c, { tipo: 'AJUSTE', usuario_id: usuario.id, observacao: motivo }, [
      { produto_id, cliente_id, localizacao_id: loc, pedido_item_id: pedido_item_id || null, status: 'ESTOQUE', delta }]);
    const aj = await c.query(`INSERT INTO ajustes(movimentacao_id,produto_id,cliente_id,pedido_item_id,quantidade_anterior,ajuste,quantidade_final,motivo,usuario_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [movId, produto_id, cliente_id, pedido_item_id || null, anterior, delta, cont, motivo.trim(), usuario.id]);
    return aj.rows[0];
  });
}

// ---------------------------------------------------------------- VÍNCULO DE SOBRA A OUTRO PEDIDO
export async function vincularSobra(body, usuario) {
  const { produto_id, cliente_id, localizacao_id, pedido_item_origem_id, pedido_item_destino_id } = body;
  const qtd = Math.trunc(Number(body.quantidade));
  if (!(qtd >= 1)) falha('Quantidade inválida.');
  return tx(async (c) => {
    await travarProduto(c, produto_id);
    const dest = (await resumoItens(c, 'pi.id=$1', [pedido_item_destino_id]))[0];
    if (!dest) falha('Item de destino não encontrado.');
    if (dest.produto_id !== produto_id) falha('O item de destino é de outro produto.');
    if (dest.cancelado) falha('Pedido de destino cancelado.');
    const falta = dest.qtd_pedida - dest.recebido;
    if (qtd > falta) falha(`O item de destino só precisa de ${Math.max(0, falta)} unidade(s).`);
    if (pedido_item_origem_id && pedido_item_origem_id === pedido_item_destino_id) falha('Origem e destino iguais.');
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(delta),0)::int n FROM movimentacao_itens WHERE produto_id=$1 AND cliente_id=$2 AND status='ESTOQUE'
       AND localizacao_id IS NOT DISTINCT FROM $3 AND pedido_item_id IS NOT DISTINCT FROM $4`, [produto_id, cliente_id, localizacao_id || null, pedido_item_origem_id || null]);
    if (rows[0].n < qtd) falha(`Saldo disponível na origem: ${rows[0].n}.`);
    const destCli = (await c.query('SELECT * FROM clientes WHERE id=$1', [dest.cliente_id])).rows[0];
    const trocaRua = dest.cliente_id !== cliente_id;
    if (trocaRua && !destCli.localizacao_id) falha(`Cliente ${destCli.nome} não tem rua cadastrada.`);
    const obs = `Sobra vinculada ao pedido ${dest.pedido} (${dest.numero_origem})` + (trocaRua ? ` — mover fisicamente para a rua ${dest.rua}` : '');
    const movId = await criarMov(c, { tipo: 'VINCULO', usuario_id: usuario.id, pedido_id: dest.pedido_id, observacao: body.observacao ? `${obs}. ${body.observacao}` : obs }, [
      { produto_id, cliente_id, localizacao_id, pedido_item_id: pedido_item_origem_id || null, status: 'ESTOQUE', delta: -qtd },
      { produto_id, cliente_id: dest.cliente_id, localizacao_id: trocaRua ? destCli.localizacao_id : localizacao_id, pedido_item_id: dest.pedido_item_id, status: 'ESTOQUE', delta: qtd }]);
    return { ok: true, movimentacao_id: movId, mensagem: obs, ainda_falta: falta - qtd };
  });
}

// ---------------------------------------------------------------- TRANSFERÊNCIA DE RUA
export async function transferirRua({ cliente_id, localizacao_origem_id }, usuario) {
  return tx(async (c) => {
    const cli = (await c.query('SELECT * FROM clientes WHERE id=$1', [cliente_id])).rows[0];
    if (!cli?.localizacao_id) falha('Cliente sem rua atual.');
    const buckets = await saldosBuckets(c, `cliente_id=$1 AND status='ESTOQUE' AND localizacao_id IS NOT DISTINCT FROM $2`, [cliente_id, localizacao_origem_id || null]);
    if (!buckets.length) falha('Nada a transferir.');
    if (localizacao_origem_id === cli.localizacao_id) falha('Origem igual à rua atual.');
    await criarMov(c, { tipo: 'TRANSFERENCIA', usuario_id: usuario.id, observacao: 'Transferência para a rua atual do cliente' },
      buckets.flatMap((b) => [{ ...b, delta: -b.qtd }, { ...b, localizacao_id: cli.localizacao_id, delta: b.qtd }]));
    return { ok: true, unidades: buckets.reduce((s, b) => s + b.qtd, 0) };
  });
}
