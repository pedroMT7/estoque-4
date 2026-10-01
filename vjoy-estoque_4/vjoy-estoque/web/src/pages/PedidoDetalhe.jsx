import { useParams, useNavigate, Link } from 'react-router-dom';
import { get, post } from '../api.js';
import { Badge, Carregando, ErroBox, Progresso, useCarregar, useDialog, useToast } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';
import { useAuth } from '../auth.jsx';
import { fmtDia, fmtDataHora } from '../util.js';
import { useExpedir } from './Conferencia.jsx';

export default function PedidoDetalhe() {
  const { id } = useParams();
  const nav = useNavigate();
  const { pode } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const expedir = useExpedir();
  const { dados: p, carregando, erro, recarregar } = useCarregar(() => get('/pedidos/' + id), [id]);
  useAtualizacao(() => recarregar(true));
  if (carregando && !p) return <Carregando />;
  if (erro && !p) return <div className="pagina"><ErroBox erro={erro} /></div>;

  const separar = async () => { try { const s = await post(`/pedidos/${id}/separacao`); nav('/separacao/' + s.id); } catch (e) { toast(e.message, 'ERRO'); } };
  const conferir = async () => { try { const c = await post(`/pedidos/${id}/conferencia`); nav('/conferencia/' + c.id); } catch (e) { toast(e.message, 'ERRO'); } };
  const cancelar = async () => {
    const resp = await dialog({ titulo: 'Cancelar pedido?', tom: 'erro', mensagem: 'O pedido deixa de receber entradas. O que já está em estoque vira sobra.', confirmar: 'Cancelar pedido', cancelar: 'Voltar', campo: { rotulo: 'Motivo do cancelamento', minimo: 3 } });
    const motivo = resp?.texto;
    if (!motivo) return;
    try { await post(`/pedidos/${id}/cancelar`, { motivo }); recarregar(); } catch (e) { toast(e.message, 'ERRO'); }
  };
  const podeSeparar = pode('separacao') && ['PRONTO', 'RECEBENDO', 'EM_SEPARACAO', 'EXPEDIDO_PARCIAL'].includes(p.status) && p.em_estoque + p.separado > 0;
  const podeConferir = pode('conferencia') && ['NA_DOCA', 'EM_CONFERENCIA'].includes(p.status);
  const podeExpedir = pode('expedicao') && p.status === 'CONFERIDO';

  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <div>
          <div className="muted pequeno">PEDIDO</div>
          <h1>{p.numero} <Badge status={p.status} /></h1>
          <div className="muted">{p.clientes} · Emissão {fmtDia(p.emissao)}</div>
        </div>
        <div className="linha-botoes">
          {podeSeparar && <button className="btn btn-primario" onClick={separar}>🧺 {p.separacao_aberta ? 'Continuar separação' : 'Separar'}</button>}
          {podeConferir && <button className="btn btn-primario" onClick={conferir}>✅ Conferir</button>}
          {podeExpedir && <button className="btn btn-sucesso" onClick={() => expedir(p, () => recarregar())}>🚚 Registrar saída</button>}
          {pode('gestao') && <Link className="btn btn-leve" to={`/rastreio?pedido=${p.numero}`}>🧭 Rastrear</Link>}
          {pode('gestao') && !p.cancelado && p.status !== 'EXPEDIDO' && <button className="btn btn-leve" onClick={cancelar}>Cancelar</button>}
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><span>Necessidade</span><b>{p.pedida}</b></div>
        <div className="kpi"><span>Entrou</span><b>{p.recebido}</b></div>
        <div className="kpi"><span>Na rua</span><b>{p.em_estoque}</b></div>
        <div className="kpi"><span>Separado/doca</span><b>{p.separado + p.na_doca}</b></div>
        <div className="kpi"><span>Conferido</span><b>{p.conferido}</b></div>
        <div className="kpi"><span>Saiu</span><b>{p.expedido}</b></div>
        <div className={'kpi' + (p.recebido > p.pedida ? ' kpi-alerta' : '')}><span>Excedente</span><b>{Math.max(0, p.recebido - p.pedida)}</b></div>
      </div>
      <h3 className="sec">Itens</h3>
      <div className="tabela-rolagem">
        <table className="tabela">
          <thead><tr><th>Item</th><th>Código</th><th>Cliente / Rua</th><th className="num">Pedido</th><th>Entrou</th><th className="num">Rua</th><th className="num">Sep.</th><th className="num">Doca</th><th className="num">Conf.</th><th className="num">Saiu</th><th className="num">Saldo</th></tr></thead>
          <tbody>
            {p.itens.map((i) => {
              const saldo = i.em_estoque + i.separado + i.na_doca + i.conferido;
              const sobra = i.expedido >= i.qtd_pedida && saldo > 0;
              return (
                <tr key={i.pedido_item_id} className={sobra ? 'linha-alerta' : i.expedido >= i.qtd_pedida ? 'linha-ok' : ''}>
                  <td className="pequeno">{i.numero_origem}{i.possivel_duplicidade && <span className="badge badge-amarelo" title="Possível duplicidade na importação">dup?</span>}</td>
                  <td><b>{i.codigo}</b><div className="muted pequeno">{i.descricao}</div></td>
                  <td>{i.cliente}<div className="pequeno"><b>{i.rua || 'sem rua'}</b></div></td>
                  <td className="num">{i.qtd_pedida}</td>
                  <td style={{ minWidth: 90 }}><span className="pequeno">{i.recebido}/{i.qtd_pedida}{i.vinculado ? ` (${i.vinculado} vínc.)` : ''}</span><Progresso feito={i.recebido} total={i.qtd_pedida} /></td>
                  <td className="num">{i.em_estoque}</td><td className="num">{i.separado}</td><td className="num">{i.na_doca}</td><td className="num">{i.conferido}</td><td className="num">{i.expedido}</td>
                  <td className="num">{saldo ? <b className={sobra ? 'txt-alerta' : ''}>{saldo}{sobra ? ' ⚠️' : ''}</b> : 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grade-2">
        <div>
          <h3 className="sec">Separações</h3>
          {p.separacoes.length ? p.separacoes.map((s) => <div key={s.id} className="mini-cartao">#{s.id} · {s.status} · {s.usuario} · {fmtDataHora(s.iniciado_em)}{s.finalizado_em && ` → ${fmtDataHora(s.finalizado_em)} (${s.finalizado_por_nome})`}</div>) : <div className="vazio">—</div>}
          <h3 className="sec">Expedições</h3>
          {p.expedicoes.length ? p.expedicoes.map((e) => <div key={e.id} className="mini-cartao">🚚 {e.quantidade} un. · {e.usuario} · {fmtDataHora(e.criado_em)}</div>) : <div className="vazio">—</div>}
        </div>
        <div>
          <h3 className="sec">Conferências</h3>
          {p.conferencias.length ? p.conferencias.map((c) => <div key={c.id} className={'mini-cartao' + (c.divergencias ? ' alerta' : '')}>#{c.id} · {c.status}{c.parcial ? ' (parcial, aut. ' + c.autorizado_por_nome + ')' : ''} · {c.usuario} · {fmtDataHora(c.iniciado_em)} · {c.divergencias} divergência(s)</div>) : <div className="vazio">—</div>}
        </div>
      </div>
    </div>
  );
}
