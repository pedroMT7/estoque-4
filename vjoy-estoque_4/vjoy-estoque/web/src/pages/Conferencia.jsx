import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Scanner from '../components/Scanner.jsx';
import { Resultado, Carregando, ErroBox, Progresso, useCarregar, useDialog, useToast, Modal } from '../components/ui.jsx';
import { get, post } from '../api.js';
import { feedback } from '../feedback.js';
import { tratarCodigoDesconhecido, dicaSemPermissao } from '../components/codigoDesconhecido.js';
import { useAuth } from '../auth.jsx';
import { useAtualizacao } from '../realtime.js';
import { ListaPedidosEtapa } from './Separacao.jsx';

/** Registrar saída (expedição) com confirmação e aviso de sobra */
export function useExpedir() {
  const dialog = useDialog();
  const toast = useToast();
  return async (pedido, onFim) => {
    const ok = await dialog({ titulo: 'Registrar saída', tom: 'ok', mensagem: `Confirmar a saída (expedição) do pedido ${pedido.numero}? O estoque será baixado.`, confirmar: '🚚 Registrar saída' });
    if (!ok) return;
    try {
      const r = await post(`/pedidos/${pedido.id}/expedir`, {});
      feedback('SUCESSO');
      toast(`Pedido ${pedido.numero}: ${r.unidades} un. expedidas`);
      if (r.sobras?.length) {
        feedback('ALERTA');
        await dialog({ titulo: `⚠️ ${r.sobras.reduce((s, x) => s + x.saldo, 0)} UNIDADE(S) SOBRARAM`, confirmar: 'Entendi', cancelar: 'Fechar',
          mensagem: <table className="tabela"><thead><tr><th>Produto</th><th>Rua</th><th className="num">Entrou</th><th className="num">Saiu</th><th className="num">Saldo</th></tr></thead>
            <tbody>{r.sobras.map((x) => <tr key={x.item}><td>{x.codigo}</td><td>{x.rua}</td><td className="num">{x.entrou}</td><td className="num">{x.saiu}</td><td className="num"><b>{x.saldo}</b></td></tr>)}</tbody></table> });
      }
      onFim?.(r);
    } catch (e) { feedback('ERRO'); toast(e.message, 'ERRO'); }
  };
}

export function ConferenciaLista() {
  const nav = useNavigate();
  const toast = useToast();
  const expedir = useExpedir();
  const [aba, setAba] = useState('conferencia');
  return (
    <>
      <div className="abas abas-topo">
        <button className={aba === 'conferencia' ? 'ativa' : ''} onClick={() => setAba('conferencia')}>Na doca / conferir</button>
        <button className={aba === 'expedicao' ? 'ativa' : ''} onClick={() => setAba('expedicao')}>Conferidos — registrar saída</button>
      </div>
      {aba === 'conferencia' ? (
        <ListaPedidosEtapa key="c" etapa="conferencia" titulo="Conferência" acao={(p) => (p.conferencia_aberta_id ? 'Continuar conferência' : 'Conferir pedido')}
          extra={(p) => <div className="pequeno">Na doca: <b>{p.na_doca}</b> un. de {p.pedida - p.expedido} pendentes</div>}
          onAcao={async (p) => { try { const c = await post(`/pedidos/${p.id}/conferencia`); nav('/conferencia/' + c.id); } catch (e) { toast(e.message, 'ERRO'); } }} />
      ) : (
        <ListaPedidosEtapa key="e" etapa="expedicao" titulo="Saída / Expedição" acao="🚚 Registrar saída"
          extra={(p) => <div className="pequeno">Conferido: <b>{p.conferido}</b> un.</div>}
          onAcao={(p, recarregar) => expedir(p, () => recarregar())} />
      )}
    </>
  );
}

export function SaidaLista() {
  const nav = useNavigate();
  const toast = useToast();
  return (
    <ListaPedidosEtapa etapa="saida" titulo="Saída por bipagem"
      acao={(p) => (p.conferencia_aberta_id ? 'Continuar bipagem' : 'Bipar e dar saída')}
      extra={(p) => <div className="pequeno">No estoque: <b>{p.em_estoque + p.separado + p.na_doca}</b> un. · Pedido: {p.pedida} · Já saiu: {p.expedido}</div>}
      onAcao={async (p) => { try { const c = await post(`/pedidos/${p.id}/saida`); nav('/saida/' + c.id); } catch (e) { toast(e.message, 'ERRO'); } }} />
  );
}

export function ConferenciaTela() {
  const { id } = useParams();
  const { pode } = useAuth();
  const nav = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const expedir = useExpedir();
  const [res, setRes] = useState(null);
  const [final, setFinal] = useState(null);
  const { dados: c, carregando, erro, recarregar } = useCarregar(() => get('/conferencias/' + id), [id]);
  useAtualizacao(() => recarregar(true));
  if (carregando && !c) return <Carregando />;
  if (erro && !c) return <div className="pagina"><ErroBox erro={erro} /></div>;

  const mostrar = (nivel, titulo, linhas, sub) => { feedback(nivel); setRes({ nivel, titulo, linhas, chave: Date.now() }); return { nivel, titulo, sub }; };
  const onLeitura = async (codigo) => {
    try {
      const r = await post(`/conferencias/${id}/bipar`, { codigo });
      await recarregar(true);
      if (r.concluida) { feedback('SUCESSO'); setRes({ nivel: 'SUCESSO', titulo: 'CONFERÊNCIA CONCLUÍDA', linhas: [`Todos os ${r.total_esperado} itens conferidos. Toque em FINALIZAR.`], chave: Date.now() }); return { nivel: 'SUCESSO', titulo: 'CONFERÊNCIA CONCLUÍDA', sub: `${r.total_conferido}/${r.total_esperado}` }; }
      return mostrar('SUCESSO', `CORRETO  ${r.conferido}/${r.esperado}`, [`${r.produto.codigo} — ${r.produto.descricao}`, `Total do pedido: ${r.total_conferido}/${r.total_esperado}`], `${r.produto.codigo}  ${r.conferido}/${r.esperado}`);
    } catch (e) {
      recarregar(true);
      if (e.codigo === 'CODIGO_INEXISTENTE') {
        feedback('ERRO');
        if (await tratarCodigoDesconhecido({ dialog, pode, codigo })) return onLeitura(codigo);
        return mostrar('ERRO', 'CÓDIGO NÃO CADASTRADO', [`Código lido: ${codigo.toUpperCase()}`, pode('cadastros') ? 'Nenhum produto vinculado.' : dicaSemPermissao(codigo.toUpperCase())], `Lido: ${codigo.toUpperCase()}`);
      }
      const t = { PRODUTO_INCORRETO: 'PRODUTO INCORRETO', QUANTIDADE_EXCEDIDA: 'QUANTIDADE EXCEDIDA', NAO_CONSTA_NA_DOCA: 'NÃO CONSTA NA DOCA', SEM_ESTOQUE: 'SEM ESTOQUE' }[e.codigo] || 'ERRO';
      const linhas = e.codigo === 'PRODUTO_INCORRETO' ? [`Produto bipado: ${codigo.toUpperCase()}`, 'Este produto não pertence ao pedido.'] : [e.message];
      return mostrar('ERRO', t, linhas, linhas.join(' · '));
    }
  };

  const finalizar = async (parcial) => {
    let autorizacao;
    if (parcial) {
      const ok = await dialog({ titulo: '⚠️ Saída incompleta', mensagem: `Foram bipados ${c.total_conferido} de ${c.total_esperado}. Dar saída só do que foi bipado? O restante do pedido continua pendente.`, confirmar: 'Continuar' });
      if (!ok) return;
      autorizacao = await dialog({ tipo: 'autorizacao', mensagem: `Finalizar a conferência do pedido ${c.pedido} com ${c.total_conferido}/${c.total_esperado}.` });
      if (!autorizacao) return;
    }
    try {
      const r = await post(`/conferencias/${id}/finalizar`, { parcial, autorizacao });
      feedback('SUCESSO');
      setFinal(r);
    } catch (e) { feedback('ERRO'); toast(e.message, 'ERRO'); }
  };
  const cancelar = async () => {
    if (!(await dialog({ titulo: 'Cancelar conferência?', tom: 'erro', mensagem: 'As contagens desta conferência serão descartadas (as leituras continuam no histórico).', confirmar: 'Cancelar conferência', cancelar: 'Voltar' }))) return;
    try { await post(`/conferencias/${id}/cancelar`); nav(c.modo === 'DIRETA' ? '/saida' : '/conferencia'); } catch (e) { toast(e.message, 'ERRO'); }
  };

  const aberta = c.status === 'ABERTA';
  const completo = c.total_conferido === c.total_esperado;
  const direta = c.modo === 'DIRETA';
  const voltar = direta ? '/saida' : '/conferencia';
  return (
    <div className="pagina pagina-op">
      <div className="op-cabeca">
        <div>
          <div className="muted pequeno">{direta ? 'SAÍDA POR BIPAGEM' : 'CONFERÊNCIA'}</div>
          <h1 className="op-titulo">Pedido {c.pedido}</h1>
          <div className="muted">{c.clientes.join(' / ')}</div>
        </div>
        <div className="contador"><b>{c.total_conferido}</b>/{c.total_esperado}</div>
      </div>
      <Progresso feito={c.total_conferido} total={c.total_esperado} />
      {aberta && <Scanner titulo="BIPAR PRODUTO" onLeitura={onLeitura} />}
      <Resultado r={res} />
      <div className="tabela-rolagem"><table className="tabela tabela-op tabela-conf">
        <thead><tr><th>Produto</th><th className="num"><span className="so-desk">Esperado</span><span className="so-mob">Esp.</span></th><th className="num"><span className="so-desk">{direta ? 'Bipado' : 'Conferido'}</span><span className="so-mob">{direta ? 'Bip.' : 'Conf.'}</span></th>{direta && <th className="num"><span className="so-desk">No estoque</span><span className="so-mob">Est.</span></th>}</tr></thead>
        <tbody>
          {c.itens.map((i) => (
            <tr key={i.id} className={i.conferido === i.esperado ? 'linha-ok' : i.conferido > 0 ? 'linha-parcial' : ''}>
              <td><b>{i.codigo}</b><div className="muted pequeno">{i.descricao}{!direta && i.doca_atual < i.esperado ? ` · na doca: ${i.doca_atual}` : ''}</div></td>
              <td className="num">{i.esperado}</td>
              <td className="num"><b>{i.conferido}</b>{i.conferido === i.esperado && ' ✓'}</td>
              {direta && <td className={'num' + (i.disponivel < i.esperado ? ' txt-alerta' : '')}>{i.disponivel}</td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      {aberta && (
        <div className="barra-acao">
          <button className="btn btn-sucesso btn-bloco btn-g" disabled={!completo} onClick={() => finalizar(false)}>{completo ? (direta ? '🚚 DAR SAÍDA DO PEDIDO' : '✓ FINALIZAR CONFERÊNCIA') : `Faltam ${c.total_esperado - c.total_conferido} para ${direta ? 'dar saída' : 'finalizar'}`}</button>
          <div className="linha-botoes">
            {!completo && c.total_conferido > 0 && <button className="btn btn-leve" onClick={() => finalizar(true)}>{direta ? 'Dar saída só do que foi bipado (autorização)' : 'Finalizar incompleta (autorização)'}</button>}
            <button className="btn btn-leve" onClick={cancelar}>{direta ? 'Cancelar saída' : 'Cancelar conferência'}</button>
          </div>
        </div>
      )}
      <details className="historico" open={c.divergencias > 0}>
        <summary>Leituras ({c.divergencias} divergência{c.divergencias === 1 ? '' : 's'})</summary>
        {c.leituras.map((l) => <div key={l.id} className={'hist-linha ' + l.nivel.toLowerCase()}>{l.nivel === 'SUCESSO' ? '✓' : '❌'} {l.codigo_lido} — {l.mensagem}</div>)}
      </details>

      {final && final.saida && (
        <Modal titulo={final.parcial ? '✓ SAÍDA PARCIAL REGISTRADA' : '✓ SAÍDA REGISTRADA'} tom="ok" onFechar={() => nav(voltar)}
          rodape={<button className="btn btn-sucesso btn-g" onClick={() => nav(voltar)}>OK</button>}>
          <div className="resumo-final">
            <div><span>Pedido</span><b>{c.pedido}</b></div>
            <div><span>Cliente</span><b>{c.clientes.join(' / ')}</b></div>
            <div><span>Saíram</span><b>{final.unidades} un. ({final.conferido}/{final.esperado})</b></div>
            <div><span>Divergências</span><b className={final.divergencias ? 'txt-alerta' : ''}>{final.divergencias}</b></div>
            {final.sobras?.length > 0 && <div className="txt-alerta">⚠️ Sobraram {final.sobras.reduce((a, x) => a + x.saldo, 0)} un. no estoque: {final.sobras.map((x) => `${x.codigo} (${x.saldo})`).join(', ')}</div>}
          </div>
        </Modal>
      )}
      {final && !final.saida && (
        <Modal titulo="✓ PEDIDO CONFERIDO" tom="ok" onFechar={() => nav('/conferencia')}
          rodape={<>
            <button className="btn btn-leve" onClick={() => nav('/conferencia')}>Depois</button>
            <button className="btn btn-sucesso btn-g" onClick={() => { setFinal(null); expedir({ id: c.pedido_id, numero: c.pedido }, () => nav('/conferencia')); }}>🚚 REGISTRAR SAÍDA AGORA</button>
          </>}>
          <div className="resumo-final">
            <div><span>Pedido</span><b>{c.pedido}</b></div>
            <div><span>Cliente</span><b>{c.clientes.join(' / ')}</b></div>
            <div><span>Itens</span><b>{final.conferido}/{final.esperado}</b></div>
            <div><span>Divergências</span><b className={final.divergencias ? 'txt-alerta' : ''}>{final.divergencias}</b></div>
            {final.parcial && <div className="txt-alerta">Conferência parcial autorizada</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
