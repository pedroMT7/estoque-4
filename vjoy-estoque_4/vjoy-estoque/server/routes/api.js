import { q, tx } from '../db.js';
import { falha } from '../erros.js';
import { exigir, exigirAlgum, autenticar, hashSenha, log, PERFIS, pode, PERMISSOES } from '../auth.js';
import * as E from '../services/estoque.js';
import * as C from '../services/consultas.js';
import * as I from '../services/importacao.js';
import { normalizar } from '../services/importacao.js';
import { lerCatalogo, aplicarCatalogo } from '../services/catalogo.js';
import * as K from '../services/carregamentos.js';

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

export default async function api(app) {
  // ------------------------------------------------ autenticação
  app.post('/login', async (req, reply) => {
    const u = await autenticar(req.body?.login, req.body?.senha);
    if (!u) { reply.code(401); return { erro: 'Login ou senha inválidos.' }; }
    await log(u.id, 'LOGIN');
    const token = app.jwt.sign({ id: u.id, nome: u.nome, perfil: u.perfil, login: u.login }, { expiresIn: '14d' });
    return { token, usuario: { id: u.id, nome: u.nome, perfil: u.perfil, login: u.login } };
  });

  app.register(async (priv) => {
    priv.addHook('onRequest', async (req) => {
      try { await req.jwtVerify(); } catch { falha('Sessão expirada. Faça login novamente.', { status: 401, codigo: 'NAO_AUTENTICADO' }); }
      const u = (await q('SELECT id, nome, perfil, login, ativo FROM usuarios WHERE id=$1', [req.user.id])).rows[0];
      if (!u?.ativo) falha('Usuário inativo.', { status: 401, codigo: 'NAO_AUTENTICADO' });
      req.user = u;
    });
    const P = (perm) => ({ preHandler: exigir(perm) });

    priv.get('/me', async (req) => ({ usuario: req.user, permissoes: Object.fromEntries(Object.keys(PERMISSOES).map((k) => [k, pode(req.user.perfil, k)])) }));

    // ------------------------------------------------ usuários
    priv.get('/usuarios', P('usuarios'), async () => (await q('SELECT id,nome,login,perfil,ativo,criado_em FROM usuarios ORDER BY nome')).rows);
    priv.get('/usuarios/lista', P('gestao'), async () => (await q('SELECT id,nome FROM usuarios ORDER BY nome')).rows);
    priv.post('/usuarios', P('usuarios'), async (req) => {
      const { nome, login, senha, perfil } = req.body || {};
      if (!nome || !login || !senha || senha.length < 4) falha('Nome, login e senha (mín. 4 caracteres) são obrigatórios.');
      if (!PERFIS.includes(perfil)) falha('Perfil inválido.');
      const ex = (await q('SELECT 1 FROM usuarios WHERE login=$1', [login.trim().toLowerCase()])).rows[0];
      if (ex) falha('Já existe usuário com este login.');
      const { rows } = await q('INSERT INTO usuarios(nome,login,senha_hash,perfil) VALUES ($1,$2,$3,$4) RETURNING id', [nome.trim(), login.trim().toLowerCase(), await hashSenha(senha), perfil]);
      await log(req.user.id, 'USUARIO_CRIADO', 'usuarios', rows[0].id, { login, perfil });
      return { id: rows[0].id };
    });
    priv.put('/usuarios/:id', P('usuarios'), async (req) => {
      const id = int(req.params.id); const { nome, perfil, ativo, senha } = req.body || {};
      if (perfil && !PERFIS.includes(perfil)) falha('Perfil inválido.');
      if (id === req.user.id && (ativo === false || (perfil && perfil !== 'ADMIN'))) falha('Você não pode desativar ou rebaixar o próprio usuário.');
      await q('UPDATE usuarios SET nome=COALESCE($2,nome), perfil=COALESCE($3,perfil), ativo=COALESCE($4,ativo) WHERE id=$1', [id, nome || null, perfil || null, ativo ?? null]);
      if (senha) { if (senha.length < 4) falha('Senha muito curta.'); await q('UPDATE usuarios SET senha_hash=$2 WHERE id=$1', [id, await hashSenha(senha)]); }
      await log(req.user.id, 'USUARIO_ALTERADO', 'usuarios', id, { nome, perfil, ativo, senha: senha ? '***' : undefined });
      return { ok: true };
    });
    priv.post('/me/senha', async (req) => {
      const { atual, nova } = req.body || {};
      const u = await autenticar(req.user.login, atual);
      if (!u) falha('Senha atual incorreta.');
      if (!nova || nova.length < 4) falha('Nova senha muito curta.');
      await q('UPDATE usuarios SET senha_hash=$2 WHERE id=$1', [req.user.id, await hashSenha(nova)]);
      return { ok: true };
    });

    // ------------------------------------------------ ruas
    priv.get('/localizacoes', async () => (await q(`SELECT l.*, (SELECT count(*)::int FROM clientes c WHERE c.localizacao_id=l.id) clientes,
      COALESCE((SELECT SUM(qtd) FROM v_saldos s WHERE s.localizacao_id=l.id AND s.status='ESTOQUE'),0)::int unidades FROM localizacoes l ORDER BY codigo`)).rows);
    priv.post('/localizacoes', P('cadastros'), async (req) => {
      const codigo = String(req.body?.codigo || '').trim().toUpperCase();
      if (!codigo) falha('Informe o código da rua (ex.: R-05).');
      if ((await q('SELECT 1 FROM localizacoes WHERE codigo=$1', [codigo])).rows[0]) falha('Rua já cadastrada.');
      const { rows } = await q('INSERT INTO localizacoes(codigo,descricao) VALUES ($1,$2) RETURNING *', [codigo, req.body?.descricao || null]);
      await log(req.user.id, 'RUA_CRIADA', 'localizacoes', rows[0].id, { codigo });
      return rows[0];
    });
    priv.put('/localizacoes/:id', P('cadastros'), async (req) => {
      const { descricao, ativo } = req.body || {};
      await q('UPDATE localizacoes SET descricao=COALESCE($2,descricao), ativo=COALESCE($3,ativo) WHERE id=$1', [int(req.params.id), descricao ?? null, ativo ?? null]);
      return { ok: true };
    });

    // ------------------------------------------------ clientes
    priv.get('/clientes', async (req) => {
      const { rows } = await q(`SELECT c.*, l.codigo rua,
          (SELECT json_agg(nome_origem ORDER BY nome_origem) FROM cliente_aliases a WHERE a.cliente_id=c.id) aliases,
          COALESCE((SELECT SUM(qtd) FROM v_saldos s WHERE s.cliente_id=c.id AND s.status='ESTOQUE'),0)::int unidades,
          (SELECT json_agg(json_build_object('localizacao_id', x.localizacao_id, 'rua', lx.codigo, 'qtd', x.q)) FROM
             (SELECT localizacao_id, SUM(qtd)::int q FROM v_saldos s WHERE s.cliente_id=c.id AND s.status='ESTOQUE' AND s.localizacao_id IS DISTINCT FROM c.localizacao_id GROUP BY localizacao_id) x
             LEFT JOIN localizacoes lx ON lx.id=x.localizacao_id) fora_da_rua
        FROM clientes c LEFT JOIN localizacoes l ON l.id=c.localizacao_id
        ${req.query.busca ? `WHERE c.nome ILIKE $1 OR c.codigo ILIKE $1` : ''} ORDER BY c.nome`, req.query.busca ? [`%${req.query.busca}%`] : []);
      return rows;
    });
    priv.get('/clientes/codigo/:codigo', async (req) => {
      const c = await E.acharCliente({ query: q }, req.params.codigo);
      if (!c) {
        await E.registrarLeitura(null, { operacao: 'ENTRADA', codigo_lido: req.params.codigo, resultado: 'CLIENTE_INEXISTENTE', nivel: 'ERRO', mensagem: 'Cliente não cadastrado', usuario_id: req.user.id });
        falha(`Cliente não cadastrado: "${req.params.codigo}"`, { status: 404, codigo: 'CLIENTE_INEXISTENTE' });
      }
      if (c.status !== 'ATIVO') falha(`Cliente ${c.nome} está inativo.`, { codigo: 'CLIENTE_INATIVO' });
      if (!c.localizacao_id) falha(`Cliente ${c.nome} não tem rua cadastrada. Peça à gestão para cadastrar.`, { codigo: 'CLIENTE_SEM_RUA', dados: { cliente: c } });
      const pend = (await q(`SELECT COUNT(*)::int itens, COALESCE(SUM(r.qtd_pedida-(r.entrou+r.vinculado+r.ajustado)),0)::int unidades FROM v_item_resumo r JOIN pedido_itens pi ON pi.id=r.pedido_item_id JOIN pedidos p ON p.id=pi.pedido_id
        WHERE pi.cliente_id=$1 AND NOT p.cancelado AND (r.entrou+r.vinculado+r.ajustado) < r.qtd_pedida`, [c.id])).rows[0];
      return { ...c, pendente_receber: pend };
    });
    priv.post('/clientes', P('cadastros'), async (req) => {
      const nome = normalizar(req.body?.nome);
      if (!nome) falha('Informe o nome do cliente.');
      return tx(async (c) => {
        let codigo = String(req.body?.codigo || '').trim().toUpperCase();
        if (!codigo) { const { rows } = await c.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo,'\\D','','g'),'')::int),0)+1 n FROM clientes WHERE codigo ~ '^CLI\\d+$'`); codigo = 'CLI' + String(rows[0].n).padStart(4, '0'); }
        const barras = String(req.body?.codigo_barras || codigo).trim().toUpperCase();
        if ((await c.query('SELECT 1 FROM clientes WHERE codigo=$1 OR codigo_barras=$2', [codigo, barras])).rows[0]) falha('Código ou código de barras já usado por outro cliente.');
        if ((await c.query('SELECT 1 FROM cliente_aliases WHERE nome_origem=$1', [nome])).rows[0]) falha('Já existe cliente com este nome.');
        const { rows } = await c.query('INSERT INTO clientes(codigo,nome,codigo_barras,localizacao_id) VALUES ($1,$2,$3,$4) RETURNING *', [codigo, nome, barras, int(req.body?.localizacao_id)]);
        await c.query('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [rows[0].id, nome]);
        await log(req.user.id, 'CLIENTE_CRIADO', 'clientes', rows[0].id, { nome, codigo }, c);
        return rows[0];
      });
    });
    priv.put('/clientes/:id', P('cadastros'), async (req) => {
      const id = int(req.params.id); const b = req.body || {};
      const antes = (await q('SELECT * FROM clientes WHERE id=$1', [id])).rows[0];
      if (!antes) falha('Cliente não encontrado', { status: 404 });
      if (b.codigo_barras) { const ex = (await q('SELECT 1 FROM clientes WHERE codigo_barras=$1 AND id<>$2', [b.codigo_barras.trim().toUpperCase(), id])).rows[0]; if (ex) falha('Código de barras já usado por outro cliente.'); }
      await q(`UPDATE clientes SET nome=COALESCE($2,nome), codigo_barras=COALESCE($3,codigo_barras), localizacao_id=CASE WHEN $4::boolean THEN $5 ELSE localizacao_id END, status=COALESCE($6,status) WHERE id=$1`,
        [id, b.nome ? normalizar(b.nome) : null, b.codigo_barras ? b.codigo_barras.trim().toUpperCase() : null, 'localizacao_id' in b, int(b.localizacao_id), b.status || null]);
      await log(req.user.id, 'CLIENTE_ALTERADO', 'clientes', id, { antes: { nome: antes.nome, localizacao_id: antes.localizacao_id, status: antes.status }, depois: b });
      return { ok: true };
    });
    priv.post('/clientes/:id/aliases', P('cadastros'), async (req) => {
      const nome = normalizar(req.body?.nome); if (!nome) falha('Informe o nome.');
      if ((await q('SELECT 1 FROM cliente_aliases WHERE nome_origem=$1', [nome])).rows[0]) falha('Este nome já está associado a um cliente.');
      await q('INSERT INTO cliente_aliases(cliente_id,nome_origem) VALUES ($1,$2)', [int(req.params.id), nome]);
      return { ok: true };
    });
    priv.post('/clientes/:id/transferir', P('cadastros'), async (req) => E.transferirRua({ cliente_id: int(req.params.id), localizacao_origem_id: int(req.body?.localizacao_origem_id) }, req.user));

    // ------------------------------------------------ produtos
    priv.get('/produtos', async (req) => {
      const b = req.query.busca;
      const { rows } = await q(`SELECT p.*, COALESCE((SELECT SUM(qtd) FROM v_saldos s WHERE s.produto_id=p.id AND s.status<>'EXPEDIDO'),0)::int unidades,
          (SELECT json_agg(pc.codigo ORDER BY pc.codigo) FROM produto_codigos pc WHERE pc.produto_id=p.id) codigos_adicionais
        FROM produtos p ${b ? 'WHERE p.codigo ILIKE $1 OR p.descricao ILIKE $1 OR p.codigo_barras ILIKE $1 OR p.codigo_laboratorio ILIKE $1 OR EXISTS (SELECT 1 FROM produto_codigos pc WHERE pc.produto_id=p.id AND pc.codigo ILIKE $1)' : ''} ORDER BY p.codigo LIMIT 300`, b ? [`%${b}%`] : []);
      return rows;
    });
    // códigos de barras de outro sistema ligados a um produto
    const vincularCodigo = async (c, produto_id, codigoBruto, origem, usuario_id) => {
      const codigo = String(codigoBruto || '').trim().toUpperCase();
      if (!codigo) falha('Código de barras vazio.');
      const prod = (await c.query('SELECT * FROM produtos WHERE id=$1', [produto_id])).rows[0];
      if (!prod) falha('Produto não encontrado.');
      const outro = (await c.query(`SELECT p.codigo FROM produtos p WHERE (p.codigo=$1 OR p.codigo_barras=$1) AND p.id<>$2
        UNION SELECT p.codigo FROM produto_codigos pc JOIN produtos p ON p.id=pc.produto_id WHERE pc.codigo=$1`, [codigo, produto_id])).rows[0];
      if (outro && outro.codigo !== prod.codigo) falha(`O código ${codigo} já pertence ao produto ${outro.codigo}.`, { status: 409, codigo: 'CODIGO_EM_USO' });
      if (outro) return { ok: true, ja_existia: true, produto: prod.codigo };
      await c.query('INSERT INTO produto_codigos(produto_id,codigo,origem,usuario_id) VALUES ($1,$2,$3,$4)', [produto_id, codigo, origem, usuario_id]);
      await log(usuario_id, 'CODIGO_BARRAS_VINCULADO', 'produtos', produto_id, { codigo, origem }, c);
      return { ok: true, produto: prod.codigo, codigo };
    };
    // produto que não está na base: cadastra na hora da bipagem (descrição pode ser completada depois)
    priv.post('/produtos/rapido', { preHandler: exigirAlgum(['entrada', 'cadastros']) }, async (req) => {
      const codigo = String(req.body?.codigo || '').trim().toUpperCase();
      if (!codigo || codigo.length > 60) falha('Código inválido.');
      const ex = await E.acharProduto({ query: q }, codigo);
      if (ex) return { ok: true, ja_existia: true, produto: ex };
      const descricao = String(req.body?.descricao || '').trim().toUpperCase() || 'SEM DESCRIÇÃO (cadastrado na bipagem)';
      const { rows } = await q(`INSERT INTO produtos(codigo,codigo_barras,descricao,unidade) VALUES ($1,$1,$2,'PC') RETURNING *`, [codigo, descricao]);
      await log(req.user.id, 'PRODUTO_CRIADO_NA_BIPAGEM', 'produtos', rows[0].id, { codigo, descricao });
      return { ok: true, produto: rows[0] };
    });
    priv.post('/produtos/codigos', P('cadastros'), async (req) => vincularCodigo({ query: q }, int(req.body?.produto_id), req.body?.codigo, req.body?.origem === 'BIPAGEM' ? 'BIPAGEM' : 'MANUAL', req.user.id));
    priv.post('/produtos/codigos/remover', P('cadastros'), async (req) => {
      const r = await q('DELETE FROM produto_codigos WHERE codigo=$1 RETURNING produto_id', [String(req.body?.codigo || '').trim().toUpperCase()]);
      if (r.rowCount) await log(req.user.id, 'CODIGO_BARRAS_REMOVIDO', 'produtos', r.rows[0].produto_id, { codigo: req.body.codigo });
      return { ok: true };
    });
    // lista CSV do outro sistema: colunas "Código" e "Código de barras" (ou EAN)
    priv.post('/produtos/codigos/importar', P('cadastros'), async (req) => {
      const f = await req.file();
      if (!f) falha('Envie o arquivo CSV.');
      const linhas = I.lerTabela(await f.toBuffer());
      const achar = (l, nomes) => { for (const [k, v] of Object.entries(l)) if (nomes.includes(normalizar(k).replace(/[^A-Z]/g, ''))) return String(v || '').trim(); return ''; };
      const res = { vinculados: 0, ja_existiam: 0, produto_nao_encontrado: [], conflitos: [], vazias: 0 };
      await tx(async (c) => {
        for (const l of linhas) {
          const cod = achar(l, ['CODIGO', 'CODPRODUTO', 'PRODUTO', 'REFERENCIA', 'SKU']).toUpperCase();
          const barras = achar(l, ['CODIGODEBARRAS', 'CODBARRAS', 'EAN', 'GTIN', 'BARRAS', 'CODIGOBARRAS']);
          if (!cod || !barras) { res.vazias++; continue; }
          const prod = (await c.query('SELECT id FROM produtos WHERE codigo=$1', [cod])).rows[0];
          if (!prod) { if (res.produto_nao_encontrado.length < 200) res.produto_nao_encontrado.push(cod); continue; }
          try {
            await c.query('SAVEPOINT s');
            const r = await vincularCodigo(c, prod.id, barras, 'IMPORTACAO', req.user.id);
            r.ja_existia ? res.ja_existiam++ : res.vinculados++;
            await c.query('RELEASE SAVEPOINT s');
          } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); if (res.conflitos.length < 200) res.conflitos.push(`${barras}: ${e.message}`); }
        }
      });
      return { ...res, linhas: linhas.length };
    });
    // catálogo de produtos (planilha PA.xlsx ou CSV com Código / Descrição / Unid)
    priv.post('/produtos/catalogo/importar', P('cadastros'), async (req) => {
      const f = await req.file();
      if (!f) falha('Envie a planilha.');
      const { produtos, ignoradas } = await lerCatalogo(await f.toBuffer(), f.filename);
      if (!produtos.length) falha('Nenhum produto encontrado. A planilha precisa ter as colunas Código e Descrição.');
      const r = await tx((c) => aplicarCatalogo(c, produtos));
      await log(req.user.id, 'CATALOGO_IMPORTADO', 'produtos', null, { arquivo: f.filename, ...r, conflitos: r.conflitos.length, ignoradas });
      return { ...r, linhas_ignoradas: ignoradas };
    });
    // códigos bipados que o sistema não reconheceu (para a gestão vincular)
    priv.get('/produtos/codigos-desconhecidos', P('cadastros'), async () => (await q(`
      SELECT l.codigo_lido codigo, COUNT(*)::int leituras, MAX(l.criado_em) ultima, string_agg(DISTINCT l.operacao, ', ') operacoes
      FROM leituras l WHERE l.resultado='CODIGO_INEXISTENTE' AND l.codigo_lido <> '-'
        AND NOT EXISTS (SELECT 1 FROM produto_codigos pc WHERE pc.codigo=UPPER(l.codigo_lido))
        AND NOT EXISTS (SELECT 1 FROM produtos p WHERE p.codigo=UPPER(l.codigo_lido) OR p.codigo_barras=UPPER(l.codigo_lido))
        AND NOT EXISTS (SELECT 1 FROM clientes c WHERE c.codigo_barras=UPPER(l.codigo_lido))
      GROUP BY l.codigo_lido ORDER BY MAX(l.criado_em) DESC LIMIT 200`)).rows);
    priv.post('/produtos', P('cadastros'), async (req) => {
      const b = req.body || {}; const codigo = String(b.codigo || '').trim().toUpperCase();
      if (!codigo || !b.descricao) falha('Código e descrição são obrigatórios.');
      const barras = String(b.codigo_barras || codigo).trim().toUpperCase();
      if ((await q('SELECT 1 FROM produtos WHERE codigo=$1 OR codigo_barras=$2', [codigo, barras])).rows[0]) falha('Código ou código de barras já cadastrado.');
      const { rows } = await q('INSERT INTO produtos(codigo,codigo_barras,codigo_laboratorio,descricao,unidade,cor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [codigo, barras, b.codigo_laboratorio || null, b.descricao, b.unidade || 'PC', b.cor || null]);
      await log(req.user.id, 'PRODUTO_CRIADO', 'produtos', rows[0].id, { codigo });
      return rows[0];
    });
    priv.put('/produtos/:id', P('cadastros'), async (req) => {
      const id = int(req.params.id); const b = req.body || {};
      if (b.codigo_barras) { const ex = (await q('SELECT 1 FROM produtos WHERE (codigo_barras=$1 OR codigo=$1) AND id<>$2', [b.codigo_barras.trim().toUpperCase(), id])).rows[0]; if (ex) falha('Código de barras já usado por outro produto.'); }
      await q('UPDATE produtos SET codigo_barras=COALESCE($2,codigo_barras), descricao=COALESCE($3,descricao), ativo=COALESCE($4,ativo) WHERE id=$1', [id, b.codigo_barras ? b.codigo_barras.trim().toUpperCase() : null, b.descricao || null, b.ativo ?? null]);
      await log(req.user.id, 'PRODUTO_ALTERADO', 'produtos', id, b);
      return { ok: true };
    });

    // ------------------------------------------------ consulta rápida
    priv.get('/consulta/:codigo', P('consulta'), async (req) => C.consultarCodigo(req.params.codigo));

    // ------------------------------------------------ entrada
    priv.post('/entrada', P('entrada'), async (req) => E.registrarEntrada(req.body || {}, req.user));
    priv.get('/entrada/recentes', P('entrada'), async (req) => (await q(`
      SELECT m.id, m.criado_em, m.observacao, pr.codigo, pr.descricao, cl.nome cliente, l.codigo rua, mi.delta qtd, mi.excedente, pd.numero pedido
      FROM movimentacoes m JOIN movimentacao_itens mi ON mi.movimentacao_id=m.id JOIN produtos pr ON pr.id=mi.produto_id JOIN clientes cl ON cl.id=mi.cliente_id
      LEFT JOIN localizacoes l ON l.id=mi.localizacao_id LEFT JOIN pedido_itens pi ON pi.id=mi.pedido_item_id LEFT JOIN pedidos pd ON pd.id=pi.pedido_id
      WHERE m.tipo='ENTRADA' AND m.usuario_id=$1 ORDER BY m.id DESC LIMIT 20`, [req.user.id])).rows);

    // ------------------------------------------------ pedidos
    priv.get('/pedidos', async (req) => C.listarPedidos(req.query));
    priv.get('/pedidos/:id', async (req) => C.detalhePedido(int(req.params.id)));
    priv.get('/pedidos/numero/:numero', async (req) => {
      const p = (await q('SELECT id FROM pedidos WHERE numero=$1 OR id IN (SELECT pedido_id FROM pedido_itens WHERE numero_origem=$1)', [req.params.numero.trim()])).rows[0];
      if (!p) falha('Pedido não encontrado', { status: 404 });
      return C.detalhePedido(p.id);
    });
    priv.post('/pedidos/:id/cancelar', P('gestao'), async (req) => {
      if (!req.body?.motivo) falha('Informe o motivo.');
      await q('UPDATE pedidos SET cancelado=TRUE WHERE id=$1', [int(req.params.id)]);
      await log(req.user.id, 'PEDIDO_CANCELADO', 'pedidos', int(req.params.id), { motivo: req.body.motivo });
      return { ok: true };
    });

    // ------------------------------------------------ separação
    priv.post('/pedidos/:id/separacao', P('separacao'), async (req) => E.abrirSeparacao(int(req.params.id), req.user));
    priv.get('/separacoes/:id', P('separacao'), async (req) => C.detalheSeparacao(int(req.params.id)));
    priv.post('/separacoes/:id/bipar', P('separacao'), async (req) => E.biparSeparacao(int(req.params.id), req.body?.codigo, req.user));
    priv.post('/separacoes/:id/estornar', P('separacao'), async (req) => E.estornarSeparacao(int(req.params.id), int(req.body?.pedido_item_id), req.user));
    priv.post('/separacoes/:id/doca', P('separacao'), async (req) => E.enviarParaDoca(int(req.params.id), req.body || {}, req.user));

    // ------------------------------------------------ conferência / expedição
    priv.post('/pedidos/:id/saida', P('saida'), async (req) => E.abrirSaida(int(req.params.id), req.user));
    priv.post('/pedidos/:id/conferencia', P('conferencia'), async (req) => E.abrirConferencia(int(req.params.id), req.user));
    priv.get('/conferencias/:id', { preHandler: exigirAlgum(['conferencia', 'saida']) }, async (req) => C.detalheConferencia(int(req.params.id)));
    priv.post('/conferencias/:id/bipar', { preHandler: exigirAlgum(['conferencia', 'saida']) }, async (req) => E.biparConferencia(int(req.params.id), req.body?.codigo, req.user));
    priv.post('/conferencias/:id/finalizar', { preHandler: exigirAlgum(['conferencia', 'saida']) }, async (req) => E.finalizarConferencia(int(req.params.id), req.body || {}, req.user));
    priv.post('/conferencias/:id/cancelar', { preHandler: exigirAlgum(['conferencia', 'saida']) }, async (req) => E.cancelarConferencia(int(req.params.id), req.user));
    priv.post('/pedidos/:id/expedir', P('expedicao'), async (req, reply) => {
      const r = await E.expedir(int(req.params.id), req.body || {}, req.user);
      if (r.erro) { reply.code(422); return { erro: r.mensagem, codigo: 'EXPEDIR_SEM_CONFERENCIA' }; }
      return r;
    });

    // ------------------------------------------------ estoque / sobras / ajustes
    priv.get('/estoque', P('consulta'), async (req) => C.estoqueAtual(req.query));
    priv.get('/sobras', P('gestao'), async () => C.sobras());
    priv.get('/sobras/destinos/:produto_id', P('gestao'), async (req) => C.destinosParaSobra(int(req.params.produto_id)));
    priv.post('/vinculos', P('gestao'), async (req) => E.vincularSobra({ ...req.body, produto_id: int(req.body?.produto_id), cliente_id: int(req.body?.cliente_id), localizacao_id: int(req.body?.localizacao_id), pedido_item_origem_id: int(req.body?.pedido_item_origem_id), pedido_item_destino_id: int(req.body?.pedido_item_destino_id) }, req.user));
    priv.post('/ajustes', P('ajuste'), async (req) => E.ajustar({ ...req.body, produto_id: int(req.body?.produto_id), cliente_id: int(req.body?.cliente_id), localizacao_id: int(req.body?.localizacao_id), pedido_item_id: int(req.body?.pedido_item_id) }, req.user));
    priv.get('/ajustes', P('gestao'), async () => (await q(`SELECT a.*, u.nome usuario, pr.codigo, pr.descricao, cl.nome cliente, pi.numero_origem item
      FROM ajustes a JOIN usuarios u ON u.id=a.usuario_id JOIN produtos pr ON pr.id=a.produto_id JOIN clientes cl ON cl.id=a.cliente_id LEFT JOIN pedido_itens pi ON pi.id=a.pedido_item_id ORDER BY a.id DESC LIMIT 500`)).rows);

    // ------------------------------------------------ importação
    priv.post('/importacoes/previa', P('importar'), async (req) => {
      const f = await req.file();
      if (!f) falha('Envie o arquivo CSV.');
      const buf = await f.toBuffer();
      if (!buf.length) falha('Arquivo vazio.');
      return I.gerarPrevia(buf, f.filename, req.user.id);
    });
    priv.post('/importacoes/:id/confirmar', P('importar'), async (req) => I.confirmar(int(req.params.id), req.body?.clientes || {}, req.user.id));
    priv.post('/importacoes/:id/descartar', P('importar'), async (req) => { await q(`UPDATE importacoes SET status='DESCARTADA' WHERE id=$1 AND status='PREVIA'`, [int(req.params.id)]); return { ok: true }; });
    priv.get('/importacoes', P('importar'), async () => (await q(`SELECT i.id, i.arquivo_nome, i.status, i.resumo, i.criado_em, i.confirmado_em, u.nome usuario FROM importacoes i JOIN usuarios u ON u.id=i.usuario_id WHERE i.status='CONFIRMADA' ORDER BY i.id DESC LIMIT 100`)).rows);
    priv.get('/importacoes/:id/linhas', P('importar'), async (req) => (await q(`SELECT linha, numero_origem, tipo, resultado, motivo, alerta, dados->>'codigo' codigo, dados->>'cliente' cliente, dados->>'qtd_produzir' qtd
      FROM importacao_linhas WHERE importacao_id=$1 ${req.query.resultado ? 'AND resultado=$2' : ''} ORDER BY linha LIMIT 5000`, req.query.resultado ? [int(req.params.id), req.query.resultado] : [int(req.params.id)])).rows);

    // ------------------------------------------------ pedidos mensais por cliente
    priv.get('/pedidos-mensais', async (req) => K.resumoMensal(req.query.mes));
    priv.get('/pedidos-mensais/cliente/:id', async (req) => K.pedidoMensal(int(req.params.id), req.query.mes));
    priv.post('/pedidos-mensais/ler-arquivo', P('gestao'), async (req) => {
      const f = await req.file();
      if (!f) falha('Envie o arquivo.');
      return K.lerListaMensal(await f.toBuffer(), f.filename);
    });
    priv.post('/pedidos-mensais', P('gestao'), async (req) => K.salvarPedidoMensal({ ...req.body, cliente_id: int(req.body?.cliente_id) }, req.user));

    // ------------------------------------------------ carregamento de caminhão
    // cópia do catálogo para o aparelho mostrar código e descrição mesmo sem internet
    priv.get('/produtos/offline', async () => {
      const { rows } = await q(`SELECT p.codigo, p.descricao, NULLIF(p.codigo_barras, p.codigo) barras,
        COALESCE((SELECT array_agg(pc.codigo) FROM produto_codigos pc WHERE pc.produto_id=p.id), '{}') extras
        FROM produtos p WHERE p.ativo IS NOT FALSE ORDER BY p.codigo`);
      return { gerado_em: new Date().toISOString(), itens: rows.map((r) => [r.codigo, r.descricao, [r.barras, ...r.extras].filter(Boolean)]) };
    });
    priv.get('/produtos/identificar/:codigo', async (req) => {
      const p = await E.acharProduto({ query: q }, req.params.codigo);
      if (!p) falha(`Código fora da base: "${req.params.codigo.trim().toUpperCase()}"`, { status: 404, codigo: 'CODIGO_INEXISTENTE' });
      return { produto: { id: p.id, codigo: p.codigo, descricao: p.descricao, unidade: p.unidade }, lido: req.params.codigo.trim().toUpperCase() };
    });
    priv.get('/carregamentos', P('saida'), async (req) => K.listarCarregamentos(req.query));
    priv.post('/carregamentos', P('saida'), async (req) => K.abrirCarregamento({ ...req.body, cliente_id: int(req.body?.cliente_id) }, req.user));
    priv.get('/carregamentos/:id', P('saida'), async (req) => K.detalheCarregamento(int(req.params.id)));
    priv.post('/carregamentos/:id/bipar', P('saida'), async (req) => K.biparCarregamento(int(req.params.id), req.body || {}, req.user));
    priv.post('/carregamentos/:id/retirar', P('saida'), async (req) => K.retirarDoCarregamento(int(req.params.id), int(req.body?.produto_id), req.body?.quantidade, req.user));
    priv.post('/carregamentos/:id/finalizar', P('saida'), async (req) => K.finalizarCarregamento(int(req.params.id), req.user));
    priv.post('/carregamentos/:id/cancelar', P('saida'), async (req) => K.cancelarCarregamento(int(req.params.id), req.user));
    priv.get('/carregamentos/:id/pdf', async (req, reply) => {
      const pdf = await K.romaneioPdf(int(req.params.id));
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="romaneio-${String(req.params.id).padStart(5, '0')}.pdf"`);
      return reply.send(pdf);
    });

    // ------------------------------------------------ gestão
    priv.get('/dashboard', async () => C.dashboard());
    priv.get('/relatorios/:tipo', P('gestao'), async (req) => C.relatorio(req.params.tipo, req.query));
    priv.get('/rastreio', P('gestao'), async (req) => C.rastreio(req.query));
    priv.get('/logs', P('usuarios'), async () => (await q(`SELECT l.*, u.nome usuario FROM logs l LEFT JOIN usuarios u ON u.id=l.usuario_id ORDER BY l.id DESC LIMIT 500`)).rows);
  });
}
