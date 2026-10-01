import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { MENU } from '../menu.js';
import { get } from '../api.js';
import { useCarregar } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';

export default function Inicio() {
  const { usuario, pode } = useAuth();
  const { dados: d, recarregar } = useCarregar(() => get('/dashboard'), []);
  useAtualizacao(() => recarregar(true));
  const ops = MENU.filter((m) => m.op && pode(m.perm));
  const outros = MENU.filter((m) => !m.op && m.to !== '/' && (!m.perm || pode(m.perm)));
  const n = (k) => (d ? d[k] : '…');
  const contagem = { '/entrada': `${n('entradas_hoje')} hoje`, '/saida': d ? `${d.estoque_atual} un. no estoque` : '', '/carregamento': 'Bipar e gerar romaneio', '/separacao': d ? `${d.pedidos.prontos} prontos` : '', '/conferencia': d ? `${d.pedidos.na_doca + d.pedidos.em_conferencia} na doca · ${d.pedidos.conferidos} p/ saída` : '' };
  return (
    <div className="pagina">
      <h1>Olá, {usuario.nome.split(' ')[0]}</h1>
      <div className="grade-op">
        {ops.map((m) => (
          <Link key={m.to} to={m.to} className="tile-op">
            <span className="tile-ic" aria-hidden>{m.ic}</span>
            <span className="tile-t">{m.t}</span>
            {contagem[m.to] && <span className="tile-sub">{contagem[m.to]}</span>}
          </Link>
        ))}
      </div>
      {d && (
        <div className="kpis kpis-mini">
          <div className="kpi"><span>Em estoque</span><b>{d.estoque_atual}</b></div>
          <div className="kpi"><span>Separados</span><b>{d.separados}</b></div>
          <div className="kpi"><span>Na doca</span><b>{d.na_doca}</b></div>
          <div className="kpi"><span>Expedidos hoje</span><b>{d.expedidos_hoje}</b></div>
        </div>
      )}
      <div className="links-grade">
        {outros.map((m) => <Link key={m.to} to={m.to} className="link-cartao"><span aria-hidden>{m.ic}</span>{m.t}</Link>)}
      </div>
    </div>
  );
}
