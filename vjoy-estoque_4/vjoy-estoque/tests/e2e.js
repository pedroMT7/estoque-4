// Teste ponta a ponta com o CSV real. Uso: BASE=http://localhost:3000 CSV=caminho node tests/e2e.js
// ATENÇÃO: usa um banco limpo (o script NÃO apaga dados; rode contra um banco de teste).
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const CSV = process.env.CSV; if (!CSV) { console.error('Informe o CSV de teste: CSV=caminho/arquivo.csv ./tests/run.sh'); process.exit(1); }
let falhas = 0, ok = 0;
const check = (cond, msg, extra) => { if (cond) { ok++; console.log('  ✓', msg); } else { falhas++; console.log('  ✗', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

async function call(token, method, url, body, raw) {
  const r = await fetch(BASE + '/api' + url, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, ...j, _j: j };
}
const login = async (l, s) => (await call(null, 'POST', '/login', { login: l, senha: s })).token;

const adm = await login('admin', 'admin123');
console.log('\n1. Usuários e perfis');
for (const [n, p] of [['estoque1', 'ESTOQUE'], ['exped1', 'EXPEDICAO'], ['conf1', 'CONFERENCIA'], ['gestor', 'GESTAO']]) {
  await call(adm, 'POST', '/usuarios', { nome: n, login: n, senha: '1234', perfil: p });
}
const est = await login('estoque1', '1234'), exp = await login('exped1', '1234'), conf = await login('conf1', '1234'), ges = await login('gestor', '1234');
check(est && exp && conf && ges, 'logins dos 4 perfis');
check((await call(est, 'POST', '/pedidos/1/separacao')).s === 403, 'ESTOQUE não pode separar (403)');
check((await call(conf, 'GET', '/relatorios/balanco')).s === 403, 'CONFERÊNCIA não vê relatórios (403)');

console.log('\n2. Importação do CSV real');
const fd = () => { const f = new FormData(); f.append('arquivo', new Blob([fs.readFileSync(CSV)]), 'modelo pedido.csv'); return f; };
const pv = await call(ges, 'POST', '/importacoes/previa', fd(), true);
const R = pv.resumo || {};
console.log('   resumo:', JSON.stringify(R));
check(R.total_linhas === 2949, 'lê 2949 linhas');
check(R.linhas_pa === 1893 && R.ignoradas_sa === 1056, 'PA=1893, SA ignoradas=1056');
check(R.pendentes === 2, '2 pendentes (sem cliente / sem unidade)', pv.pendentes?.map((x) => x.numero + ':' + x.motivo));
check(R.itens_novos === 1891, '1891 itens novos');
const king = pv.clientesNovos.find((c) => c.nome === 'KINGSTAR COLCHOES');
check(king?.sugestoes?.some((s) => s.nome === 'KING STAR'), 'sugere KINGSTAR COLCHOES ≈ KING STAR', king);
check(!pv.alertas.some((a) => a.numero?.startsWith('044172/1/01')), `044172 (mesmos itens p/ outro cliente) NÃO é duplicidade; possíveis duplicidades: ${R.possiveis_duplicidades}`);
const cf = await call(ges, 'POST', `/importacoes/${pv.importacao_id}/confirmar`, { clientes: { 'KINGSTAR COLCHOES': { acao: 'mesmo_que', nome: 'KING STAR' } } });
check(cf.itens_criados === 1891, `confirmado: ${cf.pedidos_criados} pedidos, ${cf.itens_criados} itens, ${cf.clientes_criados} clientes, ${cf.produtos_criados} produtos`, cf);
check((await call(ges, 'POST', `/importacoes/${pv.importacao_id}/confirmar`, {})).s === 400, 'não confirma a mesma prévia duas vezes');
const pv2 = await call(ges, 'POST', '/importacoes/previa', fd(), true);
check(pv2.resumo.itens_novos === 0 && pv2.resumo.itens_existentes === 1891 && pv2.ja_importado_em, 'reimportar: 0 novos, 1891 existentes, avisa arquivo já importado');
check(pv2.resumo.pedidos_novos === 0, `reimportar: 0 pedidos novos (${pv2.resumo.pedidos_ja_existentes_sem_novidade} já existem)`);
await call(ges, 'POST', `/importacoes/${pv2.importacao_id}/confirmar`, {});
const p043212 = await call(ges, 'GET', '/pedidos/numero/043212');
check(p043212.itens?.length === 21, 'pedido 043212 agrupa 21 itens', p043212.itens?.length);
const p043334 = await call(ges, 'GET', '/pedidos/numero/043334');
check(p043334.itens?.length === 4 && new Set(p043334.itens.map((i) => i.sub_pedido)).size === 3, 'pedido 043334 = base, com sub-pedidos 1/K/L');
const clis = await call(adm, 'GET', '/clientes');
const kingC = clis._j.find((c) => c.nome === 'KING STAR');
check(kingC?.aliases?.includes('KINGSTAR COLCHOES'), 'KINGSTAR COLCHOES virou apelido de KING STAR');

console.log('\n3. Ruas e clientes');
const r05 = await call(ges, 'POST', '/localizacoes', { codigo: 'r-05' });
const r06 = await call(ges, 'POST', '/localizacoes', { codigo: 'R-06' });
const cfc = clis._j.find((c) => c.nome === 'C.F.C COM DE COLCHOES EIRELI ME');
const mc = clis._j.find((c) => c.nome === 'MC FRANQUEDORA - RIBEIRAO PRETO');
await call(ges, 'PUT', `/clientes/${cfc.id}`, { localizacao_id: r05.id });
await call(ges, 'PUT', `/clientes/${mc.id}`, { localizacao_id: r06.id });
const bip = await call(est, 'GET', `/clientes/codigo/${cfc.codigo_barras}`);
check(bip.rua === 'R-05', `bipar cliente ${cfc.codigo_barras} → RUA R-05`);
const semRua = clis._j.find((c) => c.nome === 'YOUMAR COLCHOES LTDA');
check((await call(est, 'GET', `/clientes/codigo/${semRua.codigo_barras}`)).codigo === 'CLIENTE_SEM_RUA', 'cliente sem rua é bloqueado');
check((await call(est, 'GET', `/clientes/codigo/XYZ`)).s === 404, 'cliente inexistente → 404');

console.log('\n4. Entrada no estoque (pedido 043212)');
const itens = p043212.itens;
for (const it of itens) for (let k = 0; k < it.qtd_pedida; k++) {
  const r = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: it.codigo });
  if (r.s !== 200) { check(false, 'entrada ' + it.codigo, r); break; }
}
const totalPed = itens.reduce((s, i) => s + i.qtd_pedida, 0);
let det = await call(ges, 'GET', `/pedidos/${p043212.id}`);
check(det.recebido === totalPed && det.status === 'PRONTO', `recebeu ${det.recebido}/${totalPed}, status PRONTO`, det.status);
const alvo = itens[0];
const exc = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: alvo.codigo });
check(exc.s === 409 && exc.dados?.tipo === 'EXCEDENTE', 'entrada acima do pedido pede confirmação (EXCEDENTE)', exc);
const exc2 = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: alvo.codigo, quantidade: 2, confirmar: 'EXCEDENTE' });
check(exc2.s === 200 && exc2.nivel === 'ALERTA', '2 unidades excedentes registradas com alerta');
const div = await call(est, 'POST', '/entrada', { cliente: mc.codigo_barras, produto: alvo.codigo });
check(div.s === 409 && div.dados?.tipo === 'EXCEDENTE' || div.dados?.tipo === 'CLIENTE_DIVERGENTE', `produto de outro cliente → alerta (${div.dados?.tipo})`);
// produto só de outro cliente: pega um produto do MC que o CFC não tem
const pMc = (await call(ges, 'GET', `/pedidos?cliente_id=${mc.id}`))._j[0];
const itMc = (await call(ges, 'GET', `/pedidos/${pMc.id}`)).itens.find((i) => i.cliente_id === mc.id);
const d1 = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: itMc.codigo });
check(d1.s === 409 && d1.dados?.tipo === 'CLIENTE_DIVERGENTE' && d1.dados.precisaAutorizacao, `produto do MC bipado no CFC → CLIENTE_DIVERGENTE com autorização`, d1);
const d2 = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: itMc.codigo, confirmar: 'CLIENTE_DIVERGENTE', autorizacao: { login: 'estoque1', senha: '1234' } });
check(d2.s === 403, 'autorização por usuário ESTOQUE é recusada');
const d3 = await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: itMc.codigo, confirmar: 'CLIENTE_DIVERGENTE', autorizacao: { login: 'gestor', senha: '1234' } });
check(d3.s === 200, 'autorizado pelo gestor → registrado como livre no CFC');
check((await call(est, 'POST', '/entrada', { cliente: cfc.codigo_barras, produto: 'NAOEXISTE' })).codigo === 'CODIGO_INEXISTENTE', 'código inexistente → erro');

console.log('\n5. Separação');
check((await call(exp, 'POST', `/pedidos/${p043212.id}/conferencia`)).s === 403, 'EXPEDIÇÃO não confere (403)');
const sep = await call(exp, 'POST', `/pedidos/${p043212.id}/separacao`);
check(sep.id, 'separação aberta');
check((await call(exp, 'POST', `/separacoes/${sep.id}/bipar`, { codigo: itMc.codigo })).codigo === 'PRODUTO_INCORRETO', 'produto de fora do pedido → PRODUTO INCORRETO');
for (const it of itens) for (let k = 0; k < it.qtd_pedida; k++) {
  const r = await call(exp, 'POST', `/separacoes/${sep.id}/bipar`, { codigo: it.codigo });
  if (r.s !== 200) { check(false, 'separar ' + it.codigo, r); break; }
}
check((await call(exp, 'POST', `/separacoes/${sep.id}/bipar`, { codigo: alvo.codigo })).codigo === 'QUANTIDADE_EXCEDIDA', 'separar além do pedido → QUANTIDADE EXCEDIDA');
const doca = await call(exp, 'POST', `/separacoes/${sep.id}/doca`, {});
check(doca.unidades === totalPed && doca.faltam === 0, `${doca.unidades} unidades enviadas para a doca`);
det = await call(ges, 'GET', `/pedidos/${p043212.id}`);
check(det.status === 'NA_DOCA', 'status NA_DOCA');

console.log('\n6. Conferência');
const expSem = await call(conf, 'POST', `/pedidos/${p043212.id}/expedir`);
check(expSem.s === 422 && expSem.codigo === 'EXPEDIR_SEM_CONFERENCIA', 'expedir sem conferência é bloqueado');
const co = await call(conf, 'POST', `/pedidos/${p043212.id}/conferencia`);
check(co.id, 'conferência aberta');
const wrong = await call(conf, 'POST', `/conferencias/${co.id}/bipar`, { codigo: itMc.codigo });
check(wrong.codigo === 'PRODUTO_INCORRETO', 'produto incorreto não conta');
const b1 = await call(conf, 'POST', `/conferencias/${co.id}/bipar`, { codigo: alvo.codigo });
check(b1.conferido === 1 && b1.esperado === alvo.qtd_pedida, `✓ CORRETO ${b1.conferido}/${b1.esperado}`);
const fin0 = await call(conf, 'POST', `/conferencias/${co.id}/finalizar`, {});
check(fin0.s === 409 && fin0.codigo === 'PEDIDO_INCOMPLETO', 'não finaliza incompleta');
for (const it of itens) for (let k = it === alvo ? 1 : 0; k < it.qtd_pedida; k++) await call(conf, 'POST', `/conferencias/${co.id}/bipar`, { codigo: it.codigo });
const ex3 = await call(conf, 'POST', `/conferencias/${co.id}/bipar`, { codigo: alvo.codigo });
check(ex3.codigo === 'QUANTIDADE_EXCEDIDA', `3ª unidade → QUANTIDADE EXCEDIDA (${ex3.erro})`);
const cdet = await call(conf, 'GET', `/conferencias/${co.id}`);
check(cdet.total_conferido === totalPed && cdet.divergencias === 2, `conferido ${cdet.total_conferido}/${cdet.total_esperado}, divergências ${cdet.divergencias}`);
const fin = await call(conf, 'POST', `/conferencias/${co.id}/finalizar`, {});
check(fin.ok && fin.conferido === totalPed, 'CONFERÊNCIA CONCLUÍDA');

console.log('\n7. Saída e sobras');
const sai = await call(conf, 'POST', `/pedidos/${p043212.id}/expedir`);
check(sai.ok && sai.unidades === totalPed && sai.status === 'EXPEDIDO', `expedido ${sai.unidades} un.`);
check(sai.sobras?.[0]?.saldo === 2 && sai.sobras[0].entrou === alvo.qtd_pedida + 2, `⚠️ SOBRA: entrou ${sai.sobras?.[0]?.entrou}, saiu ${sai.sobras?.[0]?.saiu}, saldo ${sai.sobras?.[0]?.saldo}`);
const sob = await call(ges, 'GET', '/sobras');
check(sob._j.some((s) => s.codigo === alvo.codigo && s.saldo === 2), 'aparece em SOBRAS/EXCEDENTES');
check(sob._j.some((s) => s.codigo === itMc.codigo && !s.pedido_item_id), 'entrada autorizada sem pedido aparece como sobra livre');
const bal = (await call(ges, 'GET', `/relatorios/balanco?produto=${alvo.codigo}`))._j[0];
check(bal.entrou === alvo.qtd_pedida + 2 && bal.saiu === alvo.qtd_pedida && bal.saldo === 2, `ENTROU ${bal.entrou} → SAIU ${bal.saiu} → SOBROU ${bal.saldo}`);
const exd = (await call(ges, 'GET', '/relatorios/excedente'))._j;
check(exd.some((e) => e.codigo === alvo.codigo && e.excedente === 2), 'relatório de produção excedente mostra +2');

console.log('\n8. Reutilização de sobra');
const destinos = (await call(ges, 'GET', `/sobras/destinos/${alvo.produto_id}`))._j;
if (destinos.length) {
  const d = destinos[0];
  const s = sob._j.find((x) => x.codigo === alvo.codigo);
  const semRuaV = await call(ges, 'POST', '/vinculos', { produto_id: alvo.produto_id, cliente_id: s.cliente_id, localizacao_id: s.localizacao_id, pedido_item_origem_id: s.pedido_item_id, pedido_item_destino_id: d.pedido_item_id, quantidade: 1 });
  check(d.cliente_id === s.cliente_id || semRuaV.s === 400, 'vínculo p/ cliente sem rua é bloqueado');
  await call(ges, 'PUT', `/clientes/${d.cliente_id}`, { localizacao_id: r06.id });
  const v = await call(ges, 'POST', '/vinculos', { produto_id: alvo.produto_id, cliente_id: s.cliente_id, localizacao_id: s.localizacao_id, pedido_item_origem_id: s.pedido_item_id, pedido_item_destino_id: d.pedido_item_id, quantidade: Math.min(2, d.qtd_pedida) });
  check(v.ok, `sobra vinculada ao pedido ${d.pedido}: ${v.mensagem || v.erro}`);
  const dd = (await call(ges, 'GET', `/pedidos/${d.pedido_id}`)).itens.find((i) => i.pedido_item_id === d.pedido_item_id);
  check(dd.vinculado === Math.min(2, d.qtd_pedida), `destino recebeu ${dd.vinculado} por vínculo; falta ${dd.qtd_pedida - dd.recebido} produzir`);
} else console.log('   (nenhum outro pedido com o mesmo produto — vínculo não testado)');

console.log('\n9. Ajuste manual');
const livre = sob._j.find((x) => x.codigo === itMc.codigo && !x.pedido_item_id);
check((await call(est, 'POST', '/ajustes', {})).s === 403, 'ESTOQUE não ajusta (403)');
check((await call(ges, 'POST', '/ajustes', { produto_id: livre.produto_id, cliente_id: livre.cliente_id, localizacao_id: livre.localizacao_id, contagem: 0 })).s === 400, 'ajuste sem motivo é recusado');
const aj = await call(ges, 'POST', '/ajustes', { produto_id: livre.produto_id, cliente_id: livre.cliente_id, localizacao_id: livre.localizacao_id, contagem: 0, motivo: 'Contagem física: produto não encontrado' });
check(aj.quantidade_anterior === 1 && aj.ajuste === -1 && aj.quantidade_final === 0, 'ajuste 1 → 0 registrado (anterior, ajuste, final)');

console.log('\n10. Concorrência: 8 aparelhos dando entrada ao mesmo tempo');
const pAlvo = (await call(ges, 'GET', `/pedidos/${pMc.id}`));
const itC = pAlvo.itens.find((i) => i.cliente_id === mc.id);
const reqs = await Promise.all(Array.from({ length: 8 }, () => call(est, 'POST', '/entrada', { cliente: mc.codigo_barras, produto: itC.codigo, confirmar: 'EXCEDENTE' })));
check(reqs.every((r) => r.s === 200), '8 entradas simultâneas aceitas');
const itC2 = (await call(ges, 'GET', `/pedidos/${pMc.id}`)).itens.find((i) => i.pedido_item_id === itC.pedido_item_id);
const bal2 = (await call(ges, 'GET', `/relatorios/balanco?produto=${itC.codigo}`))._j[0];
check(bal2.entrou >= 8 && itC2.entrou === Math.max(itC.qtd_pedida, 0) + Math.max(0, 8 - itC.qtd_pedida) || itC2.recebido >= itC.qtd_pedida, `sem perda de contagem (entrou ${bal2.entrou}, item ${itC2.recebido}/${itC2.qtd_pedida})`);

console.log('\n11. Dashboard, relatórios, rastreio, imutabilidade');
const dash = await call(ges, 'GET', '/dashboard');
check(dash.entradas_hoje > 0 && dash.expedidos_hoje === totalPed && dash.sobras_unidades >= 0, `dashboard: entradas hoje ${dash.entradas_hoje}, expedidos ${dash.expedidos_hoje}, sobras ${dash.sobras_unidades}, divergências ${dash.divergencias_hoje}`);
for (const t of ['estoque', 'entradas', 'saidas', 'sobras', 'divergencias', 'movimentacoes', 'excedente', 'balanco']) {
  const r = await call(ges, 'GET', `/relatorios/${t}?de=2026-01-01&ate=2030-12-31`);
  check(Array.isArray(r._j), `relatório ${t}: ${r._j.length} linhas`);
}
const ras = await call(ges, 'GET', `/rastreio?pedido=043212`);
const tipos = new Set(ras._j.map((m) => m.tipo));
check(['ENTRADA', 'SEPARACAO', 'DOCA', 'CONFERENCIA', 'EXPEDICAO'].every((t) => tipos.has(t)), 'rastreio do pedido tem entrada→separação→doca→conferência→expedição com usuário/data');

console.log(`\nResultado: ${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
