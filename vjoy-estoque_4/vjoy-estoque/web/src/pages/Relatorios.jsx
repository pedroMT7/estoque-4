import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, qs } from '../api.js';
import { Carregando, ErroBox, useCarregar } from '../components/ui.jsx';
import { baixarCSV, fmtDataHora, fmtDia, MOV } from '../util.js';

const lk = (to, t) => <Link to={to}>{t}</Link>;
const TIPOS = {
  balanco: { t: 'Entrou × Saiu × Sobrou', desc: 'Principal indicador: por produto, o que entrou, saiu e ficou.', cols: [['codigo', 'Produto', (r) => lk(`/rastreio?produto=${r.codigo}`, <b>{r.codigo}</b>)], ['descricao', 'Descrição'], ['entrou', 'Entrou', null, 1], ['saiu', 'Saiu', null, 1], ['ajustes', 'Ajustes', null, 1], ['saldo', 'Saldo', null, 1], ['entrada_excedente', 'Entrada excedente', null, 1]] },
  estoque: { t: 'Estoque atual', desc: 'Por rua, cliente e produto.', cols: [['rua', 'Rua'], ['cliente', 'Cliente'], ['codigo', 'Código'], ['descricao', 'Produto'], ['item', 'Pedido/item'], ['qtd', 'Qtd', null, 1]] },
  entradas: { t: 'Entradas', desc: 'Filtre por período, cliente, produto e usuário.', mov: true },
  saidas: { t: 'Saídas', desc: 'Expedições por período, cliente, produto e pedido.', mov: true },
  sobras: { t: 'Sobras', desc: 'Saldo que ficou após o atendimento dos pedidos.', cols: [['cliente', 'Cliente'], ['rua', 'Rua'], ['item', 'Pedido/item'], ['codigo', 'Produto'], ['entrou', 'Entrada', null, 1], ['saiu', 'Saída', null, 1], ['saldo', 'Saldo', null, 1]] },
  excedente: { t: 'Produção excedente', desc: 'Necessidade do pedido × quantidade recebida.', cols: [['pedido', 'Pedido'], ['item', 'Item'], ['cliente', 'Cliente'], ['codigo', 'Produto'], ['emissao', 'Emissão', (r) => fmtDia(r.emissao)], ['necessidade', 'Necessidade', null, 1], ['recebido', 'Recebido', null, 1], ['saiu', 'Saiu', null, 1], ['excedente', 'Excedente', (r) => <b className="txt-alerta">+{r.excedente}</b>, 1]] },
  divergencias: { t: 'Divergências', desc: 'Leituras com erro/alerta e ajustes manuais.', cols: [['criado_em', 'Data/hora', (r) => fmtDataHora(r.criado_em)], ['operacao', 'Operação'], ['resultado', 'Tipo', (r) => <span className={r.nivel === 'ERRO' ? 'txt-erro' : 'txt-alerta'}>{r.resultado}</span>], ['mensagem', 'Detalhe'], ['codigo_lido', 'Código lido'], ['cliente', 'Cliente'], ['pedido', 'Pedido'], ['usuario', 'Usuário'], ['autorizado_por', 'Autorizado por']] },
  movimentacoes: { t: 'Movimentações', desc: 'Histórico completo do razão de estoque.', mov: true },
};
const COLS_MOV = [['criado_em', 'Data/hora', (r) => fmtDataHora(r.criado_em)], ['tipo', 'Tipo', (r) => MOV[r.tipo]], ['codigo', 'Produto'], ['cliente', 'Cliente'], ['rua', 'Rua'], ['pedido', 'Pedido'], ['item', 'Item'], ['status', 'Status'], ['delta', 'Qtd', (r) => (r.delta > 0 ? '+' : '') + r.delta, 1], ['usuario', 'Usuário'], ['autorizado_por', 'Autorizado'], ['observacao', 'Obs.']];

export default function Relatorios() {
  const [sp, setSp] = useSearchParams();
  const tipo = sp.get('tipo') || 'balanco';
  const [f, setF] = useState({ de: '', ate: '', cliente_id: '', produto: '', usuario_id: '', pedido: '' });
  const clientes = useCarregar(() => get('/clientes'), []);
  const usuarios = useCarregar(() => get('/usuarios/lista'), []);
  const { dados, carregando, erro } = useCarregar(() => get(`/relatorios/${tipo}` + qs(f)), [tipo, JSON.stringify(f)]);
  const cfg = TIPOS[tipo];
  const cols = cfg.mov ? COLS_MOV : cfg.cols;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [lim, setLim] = useState(300);
  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>Relatórios</h1>
        <button className="btn btn-leve" disabled={!dados?.length} onClick={() => baixarCSV(`relatorio-${tipo}.csv`, dados, cols.map(([k, t]) => [k, t, k === 'criado_em' ? (r) => fmtDataHora(r.criado_em) : undefined]))}>⬇ Exportar CSV</button>
      </div>
      <div className="abas">{Object.entries(TIPOS).map(([k, v]) => <button key={k} className={k === tipo ? 'ativa' : ''} onClick={() => setSp({ tipo: k })}>{v.t}</button>)}</div>
      <p className="muted">{cfg.desc}</p>
      <div className="filtros">
        <label className="lbl-in">De<input type="date" value={f.de} onChange={set('de')} /></label>
        <label className="lbl-in">Até<input type="date" value={f.ate} onChange={set('ate')} /></label>
        <select value={f.cliente_id} onChange={set('cliente_id')}><option value="">Todos os clientes</option>{clientes.dados?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
        <input placeholder="Produto" value={f.produto} onChange={set('produto')} />
        <input placeholder="Pedido" value={f.pedido} onChange={set('pedido')} />
        <select value={f.usuario_id} onChange={set('usuario_id')}><option value="">Todos os usuários</option>{usuarios.dados?.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
      </div>
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <>
          <div className="total-linha">{dados?.length || 0} linhas{cols.some((c) => c[3]) && dados?.length ? ' · ' + cols.filter((c) => c[3]).map(([k, t]) => `${t}: ${dados.reduce((s, r) => s + (+r[k] || 0), 0)}`).join(' · ') : ''}</div>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead><tr>{cols.map(([k, t, , n]) => <th key={k} className={n ? 'num' : ''}>{t}</th>)}</tr></thead>
              <tbody>{dados?.slice(0, lim).map((r, i) => <tr key={i}>{cols.map(([k, , fn, n]) => <td key={k} className={n ? 'num' : ''}>{fn ? fn(r) : r[k] ?? '—'}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {dados?.length > lim && <button className="btn btn-leve btn-bloco" onClick={() => setLim((l) => l + 500)}>Mostrar mais</button>}
        </>
      )}
    </div>
  );
}
