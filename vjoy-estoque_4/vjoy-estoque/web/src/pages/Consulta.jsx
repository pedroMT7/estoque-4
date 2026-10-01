import { useState } from 'react';
import { Link } from 'react-router-dom';
import Scanner from '../components/Scanner.jsx';
import { Badge } from '../components/ui.jsx';
import { get } from '../api.js';
import { feedback } from '../feedback.js';
import { useDialog } from '../components/ui.jsx';
import { useAuth } from '../auth.jsx';
import { tratarCodigoDesconhecido, dicaSemPermissao } from '../components/codigoDesconhecido.js';

const STATUS_T = { ESTOQUE: 'Na rua', SEPARADO: 'Separado', DOCA: 'Na doca', CONFERIDO: 'Conferido' };

export function TabelaSaldo({ linhas, mostrarCliente = true, onAjustar }) {
  if (!linhas?.length) return <div className="vazio">Sem saldo físico.</div>;
  return (
    <div className="tabela-rolagem">
      <table className="tabela">
        <thead><tr><th>Rua</th>{mostrarCliente && <th>Cliente</th>}<th>Código</th><th>Pedido</th><th>Situação</th><th className="num">Qtd</th>{onAjustar && <th></th>}</tr></thead>
        <tbody>
          {linhas.map((s, i) => (
            <tr key={i}>
              <td><b>{s.rua || '—'}</b></td>
              {mostrarCliente && <td>{s.cliente}</td>}
              <td><b>{s.codigo}</b><div className="muted pequeno">{s.descricao}</div></td>
              <td>{s.pedido ? <Link to={`/pedidos/${s.pedido_id}`}>{s.item}</Link> : <span className="muted">livre</span>} {s.sobra && <span className="badge badge-amarelo">sobra</span>}</td>
              <td>{STATUS_T[s.status] || s.status}</td>
              <td className="num"><b>{s.qtd}</b></td>
              {onAjustar && <td>{s.status === 'ESTOQUE' && <button className="btn btn-leve btn-p" onClick={() => onAjustar(s)}>Ajustar</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Consulta() {
  const [r, setR] = useState(null);
  const dialog = useDialog();
  const { pode } = useAuth();
  const onLeitura = async (codigo) => {
    try {
      const x = await get('/consulta/' + encodeURIComponent(codigo));
      setR({ ...x, codigo });
      if (x.tipo === 'nenhum') {
        feedback('ERRO');
        if (await tratarCodigoDesconhecido({ dialog, pode, codigo })) return onLeitura(codigo);
        return { nivel: 'ERRO', titulo: 'CÓDIGO NÃO ENCONTRADO', sub: 'Lido: ' + codigo };
      }
      feedback('SUCESSO');
      const tot = x.saldo.reduce((s, l) => s + l.qtd, 0);
      if (x.tipo === 'cliente') return { nivel: 'SUCESSO', titulo: x.cliente.nome, sub: `📍 RUA ${x.cliente.rua || '—'} · ${tot} un.` };
      if (x.tipo === 'rua') return { nivel: 'SUCESSO', titulo: 'RUA ' + x.rua.codigo, sub: `${tot} un.` };
      return { nivel: 'SUCESSO', titulo: x.produto.codigo, sub: `${tot} un. na empresa` };
    } catch (e) { feedback('ERRO'); return { nivel: 'ERRO', titulo: e.message }; }
  };
  const tot = r?.saldo?.reduce((s, l) => s + l.qtd, 0);
  return (
    <div className="pagina pagina-op">
      <h1>Consulta rápida</h1>
      <Scanner titulo="BIPAR CLIENTE, RUA OU PRODUTO" onLeitura={onLeitura} />
      {r?.tipo === 'nenhum' && <div className="resultado erro"><div className="resultado-titulo">❌ Código não encontrado</div><div className="resultado-linha">Código lido: <b className="codigo-lido">{r.codigo}</b></div><div className="resultado-linha">{pode('cadastros') ? 'Não é cliente, rua nem produto cadastrado. Bipe de novo para vincular a um produto.' : dicaSemPermissao(r.codigo)}</div></div>}
      {r?.tipo === 'cliente' && (
        <div className="painel">
          <div className="cliente-card"><div><div className="cliente-nome">{r.cliente.nome}</div><div className="muted">{r.cliente.codigo}</div></div><div className="rua-grande"><small>RUA</small>{r.cliente.rua || '—'}</div></div>
          <h3 className="sec">Saldo físico ({tot} un.)</h3>
          <TabelaSaldo linhas={r.saldo} mostrarCliente={false} />
        </div>
      )}
      {r?.tipo === 'rua' && (
        <div className="painel">
          <h2>📍 Rua {r.rua.codigo}</h2>
          <p>Clientes: {r.clientes.map((c) => c.nome).join(', ') || '—'}</p>
          <TabelaSaldo linhas={r.saldo} />
        </div>
      )}
      {r?.tipo === 'produto' && (
        <div className="painel">
          <h2>{r.produto.codigo}</h2>
          <p className="muted">{r.produto.descricao}</p>
          <h3 className="sec">Onde está ({tot} un.)</h3>
          <TabelaSaldo linhas={r.saldo} />
          <h3 className="sec">Pedidos em aberto deste produto</h3>
          <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Pedido</th><th>Cliente</th><th className="num">Pedido</th><th className="num">Recebido</th><th className="num">Expedido</th></tr></thead>
            <tbody>{r.pedidos.map((p) => <tr key={p.pedido_item_id}><td><Link to={`/pedidos/${p.pedido_id}`}>{p.numero_origem}</Link></td><td>{p.cliente} <span className="muted">({p.rua || 'sem rua'})</span></td><td className="num">{p.qtd_pedida}</td><td className="num">{p.recebido}</td><td className="num">{p.expedido}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}
