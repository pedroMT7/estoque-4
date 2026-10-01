import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom';
import Scanner from '../components/Scanner.jsx';
import { EscolherCliente } from '../components/EscolherCliente.jsx';
import { Resultado, Carregando, ErroBox, Progresso, useCarregar, useDialog, useToast, Vazio } from '../components/ui.jsx';
import { get, post, baixarArquivo, semConexao } from '../api.js';
import { guardarLeitura, filaDo, alterarLeitura, descartarLeitura, sincronizar, identificarLocal, guardarCarregamento, carregamentoGuardado, aoMudarFila, atualizarCatalogo } from '../offline.js';
import { feedback } from '../feedback.js';
import { useAtualizacao } from '../realtime.js';
import { useAuth } from '../auth.jsx';
import { tratarCodigoDesconhecido } from '../components/codigoDesconhecido.js';
import { fmtDataHora } from '../util.js';

const mesNome = (m) => (m ? new Date(m + 'T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
export const baixarRomaneio = (id) => baixarArquivo(`/carregamentos/${id}/pdf`, `romaneio-${String(id).padStart(5, '0')}.pdf`);

export function CarregamentoLista() {
  const nav = useNavigate();
  const toast = useToast();
  const [novo, setNovo] = useState(null); // {cliente}
  const [placa, setPlaca] = useState(''), [motorista, setMotorista] = useState('');
  const clientes = useCarregar(() => get('/clientes').then((l) => l.filter((c) => c.status === 'ATIVO')), []);
  const { dados, carregando, erro, recarregar } = useCarregar(async () => {
    try { const l = await get('/carregamentos'); try { localStorage.setItem('vjoy_car_lista', JSON.stringify(l.filter((x) => x.status === 'ABERTO'))); } catch {} return l; }
    catch (e) { if (!semConexao(e)) throw e; try { return JSON.parse(localStorage.getItem('vjoy_car_lista')) || []; } catch { return []; } }
  }, []);
  const [params] = useSearchParams();
  useEffect(() => { // vindo do pedido mensal: cliente já escolhido
    const id = +params.get('cliente');
    const cli = id && (clientes.dados || []).find((x) => x.id === id);
    if (cli) setNovo(cli);
  }, [params, clientes.dados]);
  useAtualizacao(() => recarregar(true));
  const criar = async () => {
    try {
      const c = await post('/carregamentos', { ...(novo.id ? { cliente_id: novo.id } : { cliente_nome: novo.nome }), placa, motorista });
      nav('/carregamento/' + c.id);
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  const abertos = (dados || []).filter((c) => c.status === 'ABERTO');
  const finalizados = (dados || []).filter((c) => c.status === 'FINALIZADO');
  return (
    <div className="pagina pagina-op">
      <h1>Carregamento</h1>
      {!novo ? (
        <>
          <EscolherCliente clientes={clientes.dados || []} onEscolher={setNovo} titulo="NOVO CARREGAMENTO — CLIENTE" />
        </>
      ) : (
        <div className="painel form">
          <div className="cliente-card"><div><div className="cliente-nome">{novo.nome}</div><div className="muted">{novo.novo ? 'cliente novo' : novo.codigo}</div></div>
            <button className="btn btn-leve" onClick={() => setNovo(null)}>Trocar</button></div>
          <label>Placa do caminhão (opcional)<input id="placa" value={placa} onChange={(e) => setPlaca(e.target.value.toUpperCase())} placeholder="ABC1D23" autoCapitalize="characters" /></label>
          <label>Motorista (opcional)<input id="motorista" value={motorista} onChange={(e) => setMotorista(e.target.value)} /></label>
          <button className="btn btn-primario btn-bloco btn-g" onClick={criar}>🚛 Começar a carregar</button>
        </div>
      )}
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <>
          <h3 className="sec">Em carregamento</h3>
          <div className="lista-cartoes">
            {!abertos.length && <Vazio>Nenhum caminhão sendo carregado.</Vazio>}
            {abertos.map((c) => (
              <Link key={c.id} to={'/carregamento/' + c.id} className="pedido-cartao link-limpo">
                <div className="pedido-cartao-topo"><span className="pedido-num">Nº {String(c.id).padStart(5, '0')}</span><span className="badge badge-laranja">Carregando</span></div>
                <div className="pedido-cliente">{c.cliente}</div>
                <div className="pedido-info"><span>{c.pecas} peças · {c.produtos} produtos</span>{c.placa && <span>🚛 {c.placa}</span>}<span>{fmtDataHora(c.criado_em)}</span></div>
              </Link>
            ))}
          </div>
          <h3 className="sec">Carregamentos finalizados</h3>
          <div className="lista-cartoes">
            {!finalizados.length && <Vazio>Nenhum ainda.</Vazio>}
            {finalizados.slice(0, 30).map((c) => (
              <div key={c.id} className="mini-cartao linha-flex">
                <div><b>Nº {String(c.id).padStart(5, '0')}</b> · {c.cliente}<div className="muted pequeno">{c.pecas} peças · {c.placa || 'sem placa'} · {fmtDataHora(c.finalizado_em)} · {c.usuario}</div></div>
                <button className="btn btn-leve btn-p" onClick={() => baixarRomaneio(c.id).catch((e) => toast(e.message, 'ERRO'))}>📄 PDF</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CarregamentoTela() {
  const { id } = useParams();
  const nav = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const { pode } = useAuth();
  const [res, setRes] = useState(null);
  const [confirmarCada, setConfirmarCada] = useState(() => { try { return localStorage.getItem('vjoy_confirmar_leitura') !== '0'; } catch { return true; } });
  const { dados: c, carregando, erro, recarregar } = useCarregar(async () => {
    try { const d = await get('/carregamentos/' + id); guardarCarregamento(d); return d; }
    catch (e) { const salvo = semConexao(e) && carregamentoGuardado(id); if (salvo) return { ...salvo, semInternet: true }; throw e; }
  }, [id]);
  useAtualizacao(() => recarregar(true));
  // leituras guardadas no aparelho (sem internet) para este caminhão
  const [fila, setFila] = useState(() => filaDo(id));
  useEffect(() => {
    let antes = filaDo(id).length;
    const desliga = aoMudarFila(() => { const f = filaDo(id); setFila(f); if (f.length < antes) recarregar(true); antes = f.length; });
    setFila(filaDo(id)); atualizarCatalogo(); sincronizar();
    return desliga;
  }, [id, recarregar]);
  const mostrar = useCallback((nivel, titulo, linhas, sub) => { feedback(nivel); setRes({ nivel, titulo, linhas, chave: Date.now() }); return { nivel, titulo, sub }; }, []);
  if (carregando && !c) return <Carregando />;
  if (erro && !c) return <div className="pagina"><ErroBox erro={erro} /></div>;

  const metaDe = (codigo) => c.pedido_mensal?.itens.find((i) => i.codigo === codigo);
  const pendentes = fila.reduce((n, x) => n + x.quantidade, 0);
  const naFila = (codigo) => fila.filter((x) => (x.produto?.codigo || x.codigo) === codigo).reduce((n, x) => n + x.quantidade, 0);
  const guardar = (codigo, quantidade, produto) => {
    try { guardarLeitura({ carregamento_id: id, codigo, quantidade, produto }); }
    catch (e) { return mostrar('ERRO', 'NÃO FOI POSSÍVEL GUARDAR', [e.message]); }
    sincronizar();
    return mostrar('ALERTA', `📴 GUARDADO NO APARELHO +${quantidade}`, [{ texto: produto?.codigo || codigo.toUpperCase(), destaque: true }, produto?.descricao || 'Descrição aparece quando a internet voltar', 'Sem internet: a leitura está salva neste celular e será enviada sozinha quando a conexão voltar.'], `${produto?.codigo || codigo} guardado`);
  };
  const enviar = async (codigo, quantidade, confirmar = [], produto) => {
    // se já há leituras esperando, a nova entra na fila para manter a ordem
    if (!confirmar.length && filaDo(id).some((x) => x.estado === 'PENDENTE')) return guardar(codigo, quantidade, produto);
    try {
      const r = await post(`/carregamentos/${id}/bipar`, { codigo, quantidade, confirmar });
      await recarregar(true);
      return mostrar(r.nivel, r.nivel === 'SUCESSO' ? `CARREGADO +${r.quantidade}` : 'CARREGADO COM ALERTA', [{ texto: r.produto.codigo, destaque: true }, r.produto.descricao, `Neste caminhão: ${r.no_caminhao} · Total do caminhão: ${r.total} peças`, r.nivel === 'ALERTA' ? r.mensagem : null], `${r.produto.codigo} · ${r.no_caminhao} no caminhão`);
    } catch (e) {
      if (e.codigo === 'CONFIRMAR') {
        feedback('ALERTA');
        const ok = await dialog({ titulo: e.dados?.tipo === 'SEM_ESTOQUE' ? '⚠️ Sem entrada no estoque' : '⚠️ Acima do pedido do mês', mensagem: e.message, confirmar: 'Carregar mesmo assim' });
        if (ok) return enviar(codigo, quantidade, [...confirmar, e.dados.tipo]);
        return mostrar('ALERTA', 'NÃO CARREGADO', ['Operação cancelada.']);
      }
      if (e.codigo === 'CODIGO_INEXISTENTE') {
        feedback('ERRO');
        if (await tratarCodigoDesconhecido({ dialog, pode, codigo, permitirNovo: true })) return lerProduto(codigo);
        return mostrar('ERRO', 'CÓDIGO FORA DA BASE', [`Código lido: ${codigo.toUpperCase()}`]);
      }
      if (semConexao(e)) return guardar(codigo, quantidade, produto);
      return mostrar('ERRO', 'ERRO', [e.message]);
    }
  };
  const lerProduto = async (codigo, aviso) => {
    if (!confirmarCada) return enviar(codigo, 1, [], identificarLocal(codigo));
    let info;
    try { info = await get('/produtos/identificar/' + encodeURIComponent(codigo)); }
    catch (e) {
      if (semConexao(e)) { // sem internet: identifica pela cópia do catálogo no aparelho
        const p = identificarLocal(codigo);
        feedback(p ? 'SUCESSO' : 'ALERTA');
        const r = await dialog({ tipo: 'leitura', aviso, codigo: p?.codigo || codigo.toUpperCase(), lido: codigo.toUpperCase(), descricao: p?.descricao || '⚠️ Não encontrado na cópia do catálogo deste celular',
          confirmar: 'GUARDAR E CARREGAR', linhas: ['📴 Sem internet — a leitura fica salva no celular e é enviada quando a conexão voltar.', `Neste caminhão: ${(c.itens.find((i) => i.codigo === p?.codigo)?.quantidade || 0) + naFila(p?.codigo || codigo)}`] });
        if (r?.trocar) return lerProduto(r.trocar, `↺ Leitura anterior (${r.descartado}) descartada — confira esta.`);
        if (!r) return mostrar('ALERTA', 'LEITURA DESCARTADA', ['Nada foi carregado.']);
        return guardar(p?.codigo || codigo, r.quantidade, p);
      }
      if (e.codigo === 'CODIGO_INEXISTENTE') { feedback('ERRO'); if (await tratarCodigoDesconhecido({ dialog, pode, codigo, permitirNovo: true })) return lerProduto(codigo); return mostrar('ERRO', 'CÓDIGO FORA DA BASE', [`Código lido: ${codigo.toUpperCase()}`]); }
      return mostrar('ERRO', 'ERRO NA LEITURA', [e.message]);
    }
    feedback('SUCESSO');
    const m = metaDe(info.produto.codigo);
    const noCam = (c.itens.find((i) => i.codigo === info.produto.codigo)?.quantidade || 0) + naFila(info.produto.codigo);
    const r = await dialog({ tipo: 'leitura', aviso, codigo: info.produto.codigo, lido: info.lido, descricao: info.produto.descricao, confirmar: 'CARREGAR',
      linhas: [`Cliente: ${c.cliente}`, m ? `Pedido do mês: ${m.pedido} · já carregado: ${m.carregado} · falta: ${m.falta}` : c.pedido_mensal ? '⚠️ Não está no pedido do mês' : null, `Neste caminhão: ${noCam}`] });
    if (r?.trocar) return lerProduto(r.trocar, `↺ Leitura anterior (${r.descartado}) descartada — confira esta.`);
    if (!r) return mostrar('ALERTA', 'LEITURA DESCARTADA', ['Nada foi carregado.']);
    return enviar(info.produto.codigo, r.quantidade, [], info.produto);
  };
  const decidir = async (x, aceitar) => {
    if (!aceitar) {
      if (await dialog({ titulo: 'Descartar leitura?', tom: 'erro', mensagem: `${x.produto?.codigo || x.codigo} ×${x.quantidade} não será carregado.`, confirmar: 'Descartar' })) descartarLeitura(x.chave);
      return;
    }
    if (x.tipo === 'CODIGO_INEXISTENTE') {
      if (!(await tratarCodigoDesconhecido({ dialog, pode, codigo: x.codigo, permitirNovo: true }))) return;
      alterarLeitura(x.chave, { estado: 'PENDENTE', mensagem: null });
    } else alterarLeitura(x.chave, { estado: 'PENDENTE', confirmar: [...(x.confirmar || []), x.tipo], mensagem: null });
    sincronizar();
  };
  const retirar = async (it) => {
    const ok = await dialog({ titulo: 'Tirar do caminhão?', mensagem: `Retirar 1 unidade de ${it.codigo} deste carregamento.`, confirmar: 'Retirar 1' });
    if (!ok) return;
    try { await post(`/carregamentos/${id}/retirar`, { produto_id: it.produto_id, quantidade: 1 }); recarregar(true); } catch (e) { toast(e.message, 'ERRO'); }
  };
  const finalizar = async () => {
    if (filaDo(id).length) { feedback('ERRO'); toast('Ainda há leituras guardadas no celular. Espere a internet voltar para enviar antes de finalizar.', 'ERRO'); return; }
    const ok = await dialog({ titulo: 'Finalizar carregamento', tom: 'ok', mensagem: `Fechar o caminhão com ${c.total} peças (${c.itens.length} produtos)? O estoque do cliente será baixado e o romaneio em PDF será gerado.`, confirmar: '✓ Finalizar e gerar PDF' });
    if (!ok) return;
    try {
      await post(`/carregamentos/${id}/finalizar`, {});
      feedback('SUCESSO'); toast('Carregamento finalizado');
      await baixarRomaneio(id).catch(() => {});
      recarregar(true);
    } catch (e) { feedback('ERRO'); toast(e.message, 'ERRO'); }
  };
  const cancelar = async () => {
    if (!(await dialog({ titulo: 'Cancelar carregamento?', tom: 'erro', mensagem: 'Os produtos bipados neste caminhão serão descartados (o estoque não muda).', confirmar: 'Cancelar carregamento', cancelar: 'Voltar' }))) return;
    try { await post(`/carregamentos/${id}/cancelar`); nav('/carregamento'); } catch (e) { toast(e.message, 'ERRO'); }
  };

  const aberto = c.status === 'ABERTO';
  const pm = c.pedido_mensal;
  return (
    <div className="pagina pagina-op">
      <div className="op-cabeca">
        <div>
          <div className="muted pequeno">CARREGAMENTO Nº {String(c.id).padStart(5, '0')} {c.placa ? '· 🚛 ' + c.placa : ''}</div>
          <h1 className="op-titulo">{c.cliente}</h1>
          <div className="muted pequeno">{pm ? `Pedido de ${mesNome(c.mes)}: ${pm.total_carregado} de ${pm.total_pedido} já carregados · falta ${pm.total_falta}` : 'Sem pedido mensal para este cliente'}</div>
        </div>
        <div className="contador"><b>{c.total + pendentes}</b><small> peças</small></div>
      </div>
      {(c.semInternet || fila.length > 0) && (
        <div className={'painel-fila' + (fila.some((x) => x.estado !== 'PENDENTE') ? ' atencao' : '')}>
          <div className="pf-titulo">{fila.some((x) => x.estado !== 'PENDENTE') ? '⚠️ Leituras guardadas precisam da sua decisão' : c.semInternet ? '📴 Sem internet' : '📤 Enviando leituras guardadas'}{fila.length ? ` — ${pendentes} peça(s) guardada(s) neste celular` : ''}</div>
          <div className="muted pequeno">Pode continuar bipando: tudo fica salvo no aparelho, mesmo se o app fechar, e é enviado sozinho quando a conexão voltar.</div>
          {fila.map((x) => (
            <div key={x.chave} className={'pf-item ' + x.estado.toLowerCase()}>
              <div><b>{x.produto?.codigo || x.codigo}</b> ×{x.quantidade} <span className="muted pequeno">{x.produto?.descricao || ''} · {fmtDataHora(x.lido_em)}</span></div>
              {x.estado === 'PENDENTE' ? <span className="muted pequeno">⏳ aguardando envio</span> : (
                <div className="pf-decisao">
                  <div className="pequeno">⚠️ {x.mensagem}</div>
                  <div className="linha-botoes">
                    {x.estado === 'CONFIRMAR' && <button className="btn btn-alerta btn-p" onClick={() => decidir(x, true)}>Carregar mesmo assim</button>}
                    {x.tipo === 'CODIGO_INEXISTENTE' && <button className="btn btn-primario btn-p" onClick={() => decidir(x, true)}>Resolver código</button>}
                    <button className="btn btn-leve btn-p" onClick={() => decidir(x, false)}>Descartar</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {pm && <Progresso feito={pm.total_carregado + c.total} total={pm.total_pedido} />}
      {aberto ? <Scanner titulo="BIPAR PRODUTO PARA O CAMINHÃO" onLeitura={lerProduto} /> : (
        <div className="resultado ok compacto"><div className="resultado-titulo">✓ Finalizado em {fmtDataHora(c.finalizado_em)}</div>
          <button className="btn btn-primario" style={{ marginTop: 8 }} onClick={() => baixarRomaneio(c.id).catch((e) => toast(e.message, 'ERRO'))}>📄 Baixar romaneio (PDF)</button></div>
      )}
      {aberto && (
        <label className="check-linha">
          <input type="checkbox" checked={confirmarCada} onChange={(e) => { setConfirmarCada(e.target.checked); try { localStorage.setItem('vjoy_confirmar_leitura', e.target.checked ? '1' : '0'); } catch {} }} />
          Mostrar tela de confirmação a cada leitura
        </label>
      )}
      <Resultado r={res} />
      <h3 className="sec">No caminhão</h3>
      <div className="tabela-rolagem"><table className="tabela tabela-op">
        <thead><tr><th>Produto</th><th className="num">Caminhão</th><th className="num"><span className="so-desk">Pedido mês</span><span className="so-mob">Mês</span></th><th className="num">Falta</th>{aberto && <th></th>}</tr></thead>
        <tbody>
          {!c.itens.length && <tr><td colSpan={5} className="muted">Nenhum produto bipado ainda.</td></tr>}
          {c.itens.map((i) => {
            const falta = Math.max(0, i.pedido_mes - i.carregado_antes - i.quantidade);
            return (
              <tr key={i.produto_id} className={i.pedido_mes && falta === 0 ? 'linha-ok' : !i.pedido_mes && pm ? 'linha-alerta' : ''}>
                <td><b>{i.codigo}</b><div className="muted pequeno">{i.descricao}</div></td>
                <td className="num"><b>{i.quantidade}</b></td>
                <td className="num">{i.pedido_mes || '—'}</td>
                <td className="num">{i.pedido_mes ? falta : '—'}</td>
                {aberto && <td><button className="btn btn-leve btn-p" onClick={() => retirar(i)} title="Tirar 1 do caminhão">−1</button></td>}
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {pm && aberto && (
        <details className="historico">
          <summary>Ainda falta do pedido do mês ({pm.itens.filter((i) => i.falta > 0).length} produtos)</summary>
          {pm.itens.filter((i) => !i.fora_do_pedido && i.pedido - i.carregado - (c.itens.find((x) => x.produto_id === i.produto_id)?.quantidade || 0) > 0).map((i) => {
            const f = i.pedido - i.carregado - (c.itens.find((x) => x.produto_id === i.produto_id)?.quantidade || 0);
            return <div key={i.produto_id} className="hist-linha"><b>{i.codigo}</b> — falta {f} <span className="muted">· em estoque: {i.em_estoque}</span></div>;
          })}
        </details>
      )}
      {aberto && (
        <div className="barra-acao">
          <button className="btn btn-sucesso btn-bloco btn-g" disabled={!c.total && !fila.length} onClick={finalizar}>✓ FINALIZAR CARREGAMENTO ({c.total + pendentes} peças)</button>
          <div className="linha-botoes">
            <button className="btn btn-leve" disabled={!c.total} onClick={() => baixarRomaneio(c.id).catch((e) => toast(e.message, 'ERRO'))}>📄 Prévia do romaneio</button>
            <button className="btn btn-leve" onClick={cancelar}>Cancelar carregamento</button>
          </div>
        </div>
      )}
    </div>
  );
}
