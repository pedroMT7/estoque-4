import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { get, qs } from '../api.js';
import { Carregando, ErroBox } from '../components/ui.jsx';
import Scanner from '../components/Scanner.jsx';
import { fmtDataHora, MOV } from '../util.js';

const ST = { ESTOQUE: 'rua', SEPARADO: 'separado', DOCA: 'doca', CONFERIDO: 'conferido', EXPEDIDO: 'expedido' };

export default function Rastreio() {
  const [sp, setSp] = useSearchParams();
  const [dados, setDados] = useState(null), [erro, setErro] = useState(null), [carr, setCarr] = useState(false);
  const [pedido, setPedido] = useState(sp.get('pedido') || ''), [produto, setProduto] = useState(sp.get('produto') || '');
  const buscar = async (p = pedido, pr = produto) => {
    setCarr(true); setErro(null);
    try { setDados(await get('/rastreio' + qs({ pedido: p, produto: pr }))); setSp(qs({ pedido: p, produto: pr }).slice(1)); } catch (e) { setErro(e); setDados(null); } finally { setCarr(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (pedido || produto) buscar(); }, []);
  // resumo das perguntas
  const r = dados && {
    entrou: dados.filter((m) => m.tipo === 'ENTRADA').flatMap((m) => m.linhas).reduce((s, l) => s + l.delta, 0),
    saiu: dados.filter((m) => m.tipo === 'EXPEDICAO').flatMap((m) => m.linhas).filter((l) => l.status === 'EXPEDIDO').reduce((s, l) => s + l.delta, 0),
    ajustes: dados.filter((m) => m.tipo === 'AJUSTE').length,
  };
  return (
    <div className="pagina">
      <h1>Rastreabilidade</h1>
      <p className="muted">Quem registrou, quando, em qual rua, quem separou, quem conferiu, quando saiu, quanto sobrou e se houve ajuste.</p>
      <form className="filtros" onSubmit={(e) => { e.preventDefault(); buscar(); }}>
        <input placeholder="Número do pedido" value={pedido} onChange={(e) => setPedido(e.target.value)} />
        <input placeholder="Código do produto" value={produto} onChange={(e) => setProduto(e.target.value)} />
        <button className="btn btn-primario">Rastrear</button>
      </form>
      <details className="historico"><summary>📷 Bipar produto para rastrear</summary>
        <Scanner titulo="BIPAR PRODUTO" manterFoco={false} grande={false} onLeitura={async (c) => { setProduto(c); setPedido(''); await buscar('', c); return { nivel: 'SUCESSO', titulo: c }; }} />
      </details>
      <ErroBox erro={erro} />
      {carr && <Carregando />}
      {dados && (
        <>
          <div className="kpis"><div className="kpi"><span>Entrou</span><b>{r.entrou}</b></div><div className="kpi"><span>Saiu</span><b>{r.saiu}</b></div><div className="kpi"><span>Movimentações</span><b>{dados.length}</b></div><div className={'kpi' + (r.ajustes ? ' kpi-alerta' : '')}><span>Ajustes</span><b>{r.ajustes}</b></div></div>
          <div className="linha-tempo">
            {dados.length === 0 && <div className="vazio">Nenhuma movimentação.</div>}
            {dados.map((m) => (
              <div key={m.id} className={'lt-item lt-' + m.tipo.toLowerCase()}>
                <div className="lt-cabeca"><b>{MOV[m.tipo]}</b><span className="muted">{fmtDataHora(m.criado_em)} · {m.usuario}{m.autorizado_por ? ` · autorizado por ${m.autorizado_por}` : ''}</span></div>
                {m.observacao && <div className="pequeno txt-alerta">{m.observacao}</div>}
                {m.ajuste && <div className="pequeno">Ajuste: {m.ajuste.quantidade_anterior} → {m.ajuste.quantidade_final} ({m.ajuste.ajuste > 0 ? '+' : ''}{m.ajuste.ajuste}) · Motivo: {m.ajuste.motivo}</div>}
                <ul className="lt-linhas">
                  {m.linhas.map((l, i) => <li key={i} className={l.delta > 0 ? 'mais' : 'menos'}>{l.delta > 0 ? '+' : ''}{l.delta} <b>{l.codigo}</b> · {ST[l.status]} · {l.cliente} · rua {l.rua || '—'} · {l.item ? <Link to={`/pedidos?busca=${l.pedido}`}>{l.item}</Link> : 'livre'}{l.excedente ? ' · ⚠️ excedente' : ''}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
