import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, qs } from '../api.js';
import { Badge, Carregando, ErroBox, Progresso, useCarregar } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';
import { STATUS, fmtDia, baixarCSV } from '../util.js';

export default function Pedidos() {
  const [busca, setBusca] = useState(''), [status, setStatus] = useState(''), [etapa, setEtapa] = useState('abertos');
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/pedidos' + qs({ busca, status, etapa: status ? '' : etapa })), [busca, status, etapa]);
  useAtualizacao(() => recarregar(true));
  const [lim, setLim] = useState(60);
  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <h1>Pedidos</h1>
        <button className="btn btn-leve" disabled={!dados?.length} onClick={() => baixarCSV('pedidos.csv', dados, [['numero', 'Pedido'], ['clientes', 'Cliente'], ['ruas', 'Rua'], ['emissao', 'Emissão'], ['status', 'Status'], ['pedida', 'Necessidade'], ['recebido', 'Recebido'], ['expedido', 'Expedido']])}>⬇ CSV</button>
      </div>
      <div className="filtros">
        <input className="busca" placeholder="🔎 Pedido, cliente ou código do produto" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={etapa} onChange={(e) => setEtapa(e.target.value)} disabled={!!status}><option value="abertos">Em aberto</option><option value="">Todos</option></select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Qualquer status</option>{Object.entries(STATUS).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}</select>
      </div>
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <>
          <div className="total-linha">{dados?.length} pedidos</div>
          <div className="tabela-rolagem">
            <table className="tabela tabela-pedidos">
              <thead><tr><th>Pedido</th><th>Cliente</th><th>Rua</th><th>Emissão</th><th>Status</th><th className="num">Necess.</th><th>Recebido</th><th className="num">Expedido</th></tr></thead>
              <tbody>
                {dados?.slice(0, lim).map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/pedidos/${p.id}`}><b>{p.numero}</b></Link>{p.possivel_duplicidade && <span className="badge badge-amarelo" title="Possível duplicidade na importação">dup?</span>}</td>
                    <td>{p.clientes}</td>
                    <td>{p.ruas || <span className="muted">—</span>}</td>
                    <td>{fmtDia(p.emissao)}</td>
                    <td><Badge status={p.status} /></td>
                    <td className="num">{p.pedida}</td>
                    <td style={{ minWidth: 110 }}><span className="pequeno">{p.recebido}/{p.pedida}</span><Progresso feito={p.recebido} total={p.pedida} /></td>
                    <td className="num">{p.expedido}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dados?.length > lim && <button className="btn btn-leve btn-bloco" onClick={() => setLim((l) => l + 100)}>Mostrar mais ({dados.length - lim} restantes)</button>}
        </>
      )}
    </div>
  );
}
