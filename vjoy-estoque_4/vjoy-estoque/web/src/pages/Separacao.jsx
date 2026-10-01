import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import Scanner from '../components/Scanner.jsx';
import { Resultado, Badge, Carregando, ErroBox, Progresso, useCarregar, useDialog, useToast, Vazio } from '../components/ui.jsx';
import { get, post, qs } from '../api.js';
import { feedback } from '../feedback.js';
import { tratarCodigoDesconhecido, dicaSemPermissao } from '../components/codigoDesconhecido.js';
import { useAuth } from '../auth.jsx';
import { useAtualizacao } from '../realtime.js';
import { fmtDia } from '../util.js';

export function ListaPedidosEtapa({ etapa, titulo, acao, onAcao, extra }) {
  const [busca, setBusca] = useState('');
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/pedidos' + qs({ etapa, busca })), [etapa, busca]);
  useAtualizacao(() => recarregar(true));
  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>{titulo}</h1></div>
      <input className="busca" placeholder="Buscar pedido, cliente ou produto…" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="lista-cartoes">
          {dados?.length === 0 && <Vazio>Nenhum pedido nesta etapa.</Vazio>}
          {dados?.map((p) => (
            <div key={p.id} className="pedido-cartao">
              <div className="pedido-cartao-topo">
                <Link to={`/pedidos/${p.id}`} className="pedido-num">Pedido {p.numero}</Link>
                <Badge status={p.status} />
              </div>
              <div className="pedido-cliente">{p.clientes}</div>
              <div className="pedido-info">
                <span>📍 <b>{p.ruas || 'sem rua'}</b></span>
                <span>{p.itens} itens · {p.pedida} un.</span>
                <span>Emissão {fmtDia(p.emissao)}</span>
              </div>
              {extra?.(p)}
              <button className="btn btn-primario btn-bloco" onClick={() => onAcao(p, recarregar)}>{typeof acao === 'function' ? acao(p) : acao}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SeparacaoLista() {
  const nav = useNavigate();
  const toast = useToast();
  return (
    <ListaPedidosEtapa etapa="separacao" titulo="Separação" acao={(p) => (p.separacao_aberta ? 'Continuar separação' : 'Separar pedido')}
      extra={(p) => (
        <div className="linha-prog">
          <span className="pequeno">Em estoque p/ separar: <b>{p.em_estoque}</b> · Recebido {p.recebido}/{p.pedida}</span>
          <Progresso feito={p.recebido} total={p.pedida} />
        </div>
      )}
      onAcao={async (p) => {
        try { const s = await post(`/pedidos/${p.id}/separacao`); nav('/separacao/' + s.id); } catch (e) { toast(e.message, 'ERRO'); }
      }} />
  );
}

export function SeparacaoTela() {
  const { id } = useParams();
  const { pode } = useAuth();
  const nav = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [res, setRes] = useState(null);
  const { dados: s, carregando, erro, recarregar } = useCarregar(() => get('/separacoes/' + id), [id]);
  useAtualizacao(() => recarregar(true));

  if (carregando && !s) return <Carregando />;
  if (erro && !s) return <div className="pagina"><ErroBox erro={erro} /></div>;

  const mostrar = (nivel, titulo, linhas, sub) => { feedback(nivel); setRes({ nivel, titulo, linhas, chave: Date.now() }); return { nivel, titulo, sub }; };
  const onLeitura = async (codigo) => {
    try {
      const r = await post(`/separacoes/${id}/bipar`, { codigo });
      recarregar(true);
      return mostrar('SUCESSO', `SEPARADO ${r.feito}/${r.total}`, [`${r.produto.codigo} — ${r.produto.descricao}`, { texto: `Retirado da RUA ${r.rua} (${r.cliente})`, destaque: true }], `${r.produto.codigo} ${r.feito}/${r.total}`);
    } catch (e) {
      if (e.codigo === 'CODIGO_INEXISTENTE') {
        feedback('ERRO');
        if (await tratarCodigoDesconhecido({ dialog, pode, codigo })) return onLeitura(codigo);
        return mostrar('ERRO', 'CÓDIGO NÃO CADASTRADO', [`Código lido: ${codigo.toUpperCase()}`, pode('cadastros') ? 'Nenhum produto vinculado.' : dicaSemPermissao(codigo.toUpperCase())], `Lido: ${codigo.toUpperCase()}`);
      }
      const t = { PRODUTO_INCORRETO: 'PRODUTO INCORRETO', QUANTIDADE_EXCEDIDA: 'QUANTIDADE EXCEDIDA', ESTOQUE_INSUFICIENTE: 'ESTOQUE INSUFICIENTE' }[e.codigo] || 'ERRO';
      return mostrar('ERRO', t, [e.message], e.message);
    }
  };

  const enviarDoca = async (confirmarIncompleto) => {
    try {
      const r = await post(`/separacoes/${id}/doca`, { confirmarIncompleto });
      feedback('SUCESSO');
      toast(`${r.unidades} unidade(s) enviadas para a DOCA`);
      nav('/separacao');
    } catch (e) {
      if (e.codigo === 'CONFIRMAR') {
        feedback('ALERTA');
        const ok = await dialog({ titulo: '⚠️ Pedido incompleto', mensagem: e.message, confirmar: 'Enviar incompleto para a doca' });
        if (ok) return enviarDoca(true);
      } else toast(e.message, 'ERRO');
    }
  };

  const estornar = async (item) => {
    const ok = await dialog({ titulo: 'Devolver unidade para a rua?', mensagem: `Desfazer 1 unidade separada de ${item.codigo} (volta para a rua ${item.rua}).`, confirmar: 'Devolver 1 unidade' });
    if (!ok) return;
    try { await post(`/separacoes/${id}/estornar`, { pedido_item_id: item.pedido_item_id }); recarregar(true); } catch (e) { toast(e.message, 'ERRO'); }
  };

  const porRua = {};
  for (const i of s.itens) { const k = `${i.rua || 'SEM RUA'}|${i.cliente}`; (porRua[k] = porRua[k] || []).push(i); }
  const total = s.itens.reduce((a, i) => a + i.qtd_pedida - i.expedido, 0);
  const feito = s.itens.reduce((a, i) => a + i.separado + i.na_doca + i.conferido, 0);
  const separadosAgora = s.itens.reduce((a, i) => a + i.separado, 0);
  const aberta = s.status === 'ABERTA';

  return (
    <div className="pagina pagina-op">
      <div className="op-cabeca">
        <div>
          <div className="muted pequeno">SEPARAÇÃO</div>
          <h1 className="op-titulo">Pedido {s.pedido}</h1>
        </div>
        <div className="contador"><b>{feito}</b>/{total}</div>
      </div>
      <Progresso feito={feito} total={total} />
      {aberta ? <Scanner titulo="BIPAR PRODUTO RETIRADO" onLeitura={onLeitura} /> : <div className="erro-box">Separação encerrada ({s.status}).</div>}
      <Resultado r={res} />

      {Object.entries(porRua).map(([k, itens]) => {
        const [rua, cli] = k.split('|');
        return (
          <div key={k} className="bloco-rua">
            <div className="bloco-rua-cabeca"><span className="rua-tag">📍 {rua}</span><span>{cli}</span></div>
            <div className="tabela-rolagem sem-borda"><table className="tabela tabela-op">
              <thead><tr><th>Código</th><th className="num">Pedido</th><th className="num">Feito</th><th className="num">Na rua</th><th></th></tr></thead>
              <tbody>
                {itens.map((i) => {
                  const f = i.separado + i.na_doca + i.conferido + i.expedido;
                  const completo = f >= i.qtd_pedida;
                  return (
                    <tr key={i.pedido_item_id} className={completo ? 'linha-ok' : i.disponivel < i.a_separar ? 'linha-alerta' : ''}>
                      <td><b>{i.codigo}</b><div className="muted pequeno">{i.descricao}</div></td>
                      <td className="num">{i.qtd_pedida}</td>
                      <td className="num"><b>{f}</b>{completo && ' ✓'}</td>
                      <td className="num">{i.disponivel}</td>
                      <td>{aberta && i.separado > 0 && <button className="btn btn-leve btn-p" onClick={() => estornar(i)} title="Devolver 1 unidade para a rua">↩︎</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        );
      })}

      {aberta && (
        <div className="barra-acao">
          <button className="btn btn-sucesso btn-bloco btn-g" disabled={!separadosAgora} onClick={() => enviarDoca(false)}>🚚 ENVIAR {separadosAgora} UN. PARA A DOCA</button>
        </div>
      )}
      <details className="historico">
        <summary>Últimas leituras</summary>
        {s.leituras.map((l) => <div key={l.id} className={'hist-linha ' + l.nivel.toLowerCase()}>{l.nivel === 'SUCESSO' ? '✓' : '❌'} {l.codigo_lido} — {l.mensagem}</div>)}
      </details>
    </div>
  );
}
