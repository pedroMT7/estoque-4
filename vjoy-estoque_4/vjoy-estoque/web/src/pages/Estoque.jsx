import { useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { AjusteModal } from './Sobras.jsx';
import { get, qs } from '../api.js';
import { Carregando, ErroBox, useCarregar } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';
import { baixarCSV } from '../util.js';
import { TabelaSaldo } from './Consulta.jsx';

export default function Estoque() {
  const [sp] = useSearchParams();
  const { pode } = useAuth();
  const [aj, setAj] = useState(null);
  const [f, setF] = useState({ status: sp.get('status') || 'ESTOQUE', busca: '', produto: '', rua: '', pedido: '', cliente_id: '', tipo: '' });
  const [visao, setVisao] = useState('tabela');
  const clientes = useCarregar(() => get('/clientes'), []);
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/estoque' + qs(f)), [JSON.stringify(f)]);
  useAtualizacao(() => recarregar(true));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const total = dados?.reduce((s, r) => s + r.qtd, 0) || 0;

  const arvore = useMemo(() => {
    const m = new Map();
    for (const r of dados || []) {
      const rua = r.rua || 'SEM RUA';
      if (!m.has(rua)) m.set(rua, new Map());
      const c = m.get(rua);
      if (!c.has(r.cliente)) c.set(r.cliente, []);
      c.get(r.cliente).push(r);
    }
    return m;
  }, [dados]);

  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <h1>Estoque atual</h1>
        <div className="linha-botoes">
          <div className="seg">
            <button className={visao === 'tabela' ? 'ativo' : ''} onClick={() => setVisao('tabela')}>Tabela</button>
            <button className={visao === 'rua' ? 'ativo' : ''} onClick={() => setVisao('rua')}>Rua → Cliente</button>
          </div>
          <button className="btn btn-leve" disabled={!dados?.length} onClick={() => baixarCSV('estoque.csv', dados, [['rua', 'Rua'], ['cliente', 'Cliente'], ['codigo', 'Código'], ['descricao', 'Produto'], ['item', 'Pedido/Item'], ['status', 'Situação'], ['qtd', 'Quantidade']])}>⬇ CSV</button>
        </div>
      </div>
      <div className="filtros">
        <input placeholder="🔎 Bipar/buscar código" value={f.busca} onChange={set('busca')} className="busca" />
        <select value={f.cliente_id} onChange={set('cliente_id')}><option value="">Todos os clientes</option>{clientes.dados?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
        <input placeholder="Produto" value={f.produto} onChange={set('produto')} />
        <input placeholder="Rua" value={f.rua} onChange={set('rua')} />
        <input placeholder="Pedido" value={f.pedido} onChange={set('pedido')} />
        <select value={f.status} onChange={set('status')}>
          <option value="ESTOQUE">Na rua (estoque)</option><option value="SEPARADO">Separado</option><option value="DOCA">Na doca</option><option value="CONFERIDO">Conferido</option><option value="TODOS">Tudo na empresa</option>
        </select>
        <select value={f.tipo} onChange={set('tipo')}><option value="">Pedido + sobras</option><option value="pedido">Só com pedido em aberto</option><option value="sobra">Só sobras / livres</option></select>
      </div>
      <ErroBox erro={erro} />
      <div className="total-linha">{dados?.length || 0} linhas · <b>{total}</b> unidades</div>
      {carregando && !dados ? <Carregando /> : visao === 'tabela' ? <TabelaSaldo linhas={dados} onAjustar={pode('ajuste') ? setAj : undefined} /> : (
        <div>
          {[...arvore].map(([rua, clis]) => (
            <details key={rua} className="arvore-rua" open>
              <summary><span className="rua-tag">📍 {rua}</span> {[...clis.values()].flat().reduce((s, r) => s + r.qtd, 0)} un.</summary>
              {[...clis].map(([cli, linhas]) => (
                <details key={cli} className="arvore-cli" open>
                  <summary>{cli} — {linhas.reduce((s, r) => s + r.qtd, 0)} un.</summary>
                  <ul className="arvore-prod">{linhas.map((l, i) => <li key={i}><b>{l.codigo}</b> <span className="muted">{l.descricao}</span> <span className="muted">{l.item ? <Link to={`/pedidos/${l.pedido_id}`}>{l.item}</Link> : 'livre'}</span> <b className="qtd">{l.qtd}</b></li>)}</ul>
                </details>
              ))}
            </details>
          ))}
        </div>
      )}
      {aj && <AjusteModal b={aj} onFechar={() => { setAj(null); recarregar(true); }} />}
    </div>
  );
}
