import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { Carregando, ErroBox, useCarregar } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';
import { fmtDataHora, MOV } from '../util.js';

function Tile({ t, v, sub, to, tom, ic }) {
  const C = to ? Link : 'div';
  return (
    <C to={to} className={'tile' + (tom ? ' tile-' + tom : '')}>
      <span className="tile-rotulo">{ic && <span aria-hidden>{ic} </span>}{t}</span>
      <b className="tile-valor">{v}</b>
      {sub && <span className="tile-sub2">{sub}</span>}
    </C>
  );
}

export default function Dashboard() {
  const { dados: d, erro, recarregar } = useCarregar(() => get('/dashboard'), []);
  const bal = useCarregar(() => get('/relatorios/balanco'), []);
  useAtualizacao(() => { recarregar(true); bal.recarregar(true); });
  if (!d) return erro ? <div className="pagina"><ErroBox erro={erro} /></div> : <Carregando />;
  const p = d.pedidos;
  const topSobra = (bal.dados || []).filter((b) => b.saldo > 0 || b.entrada_excedente > 0).slice(0, 10);
  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>Dashboard</h1><span className="muted pequeno">Atualiza sozinho quando qualquer aparelho registra algo</span></div>
      <div className="tiles">
        <Tile ic="📥" t="Entradas hoje" v={d.entradas_hoje} sub="unidades" to="/relatorios?tipo=entradas" />
        <Tile ic="📦" t="Estoque atual" v={d.estoque_atual} sub="unidades nas ruas" to="/estoque" />
        <Tile ic="🧺" t="Separados" v={d.separados} sub="retirados das ruas" to="/estoque?status=SEPARADO" />
        <Tile ic="🚛" t="Na doca" v={d.na_doca} sub={`${p.na_doca + p.em_conferencia} pedido(s) aguardando conferência`} to="/conferencia" />
        <Tile ic="✅" t="Conferidos" v={d.conferidos} sub={`${p.conferidos} pedido(s) aguardando saída`} to="/conferencia" />
        <Tile ic="🚚" t="Expedidos hoje" v={d.expedidos_hoje} sub={`${d.pedidos_expedidos_hoje} pedido(s)`} to="/relatorios?tipo=saidas" />
        <Tile ic="⚠️" t="Sobras" v={d.sobras_unidades} sub={`${d.sobras_linhas} saldo(s) sem necessidade`} to="/sobras" tom={d.sobras_unidades ? 'alerta' : ''} />
        <Tile ic="❌" t="Divergências hoje" v={d.divergencias_hoje} sub={`${d.erros_hoje} erro(s) · ${d.alertas_hoje} alerta(s) · ${d.divergencias_30d} em 30 dias`} to="/relatorios?tipo=divergencias" tom={d.erros_hoje ? 'erro' : ''} />
      </div>

      <h3 className="sec">Pedidos em aberto por etapa</h3>
      <div className="etapas">
        {[['Aguardando produção', p.aguardando], ['Recebendo', p.recebendo], ['Prontos p/ separar', p.prontos], ['Em separação', p.em_separacao], ['Na doca', p.na_doca], ['Em conferência', p.em_conferencia], ['Conferidos', p.conferidos], ['Expedidos parcial', p.parciais]].map(([t, v]) => (
          <Link key={t} to="/pedidos" className="etapa"><b>{v}</b><span>{t}</span></Link>
        ))}
      </div>

      <div className="grade-2">
        <div>
          <h3 className="sec">ENTROU → SAIU → SOBROU (produtos com saldo)</h3>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead><tr><th>Produto</th><th className="num">Entrou</th><th className="num">Saiu</th><th className="num">Saldo</th><th className="num">Excedente</th></tr></thead>
              <tbody>
                {topSobra.length === 0 && <tr><td colSpan={5} className="muted">Nenhum saldo.</td></tr>}
                {topSobra.map((b) => <tr key={b.codigo}><td><Link to={`/rastreio?produto=${b.codigo}`}><b>{b.codigo}</b></Link><div className="muted pequeno">{b.descricao}</div></td><td className="num">{b.entrou}</td><td className="num">{b.saiu}</td><td className="num"><b>{b.saldo}</b></td><td className="num">{b.entrada_excedente ? <span className="txt-alerta">⚠️ {b.entrada_excedente}</span> : 0}</td></tr>)}
              </tbody>
            </table>
          </div>
          <Link to="/relatorios?tipo=balanco" className="pequeno">Ver todos os produtos →</Link>
        </div>
        <div>
          <h3 className="sec">Últimas movimentações</h3>
          <div className="lista-cartoes">
            {d.ultimas.map((m) => (
              <div key={m.id} className="mini-cartao">
                <div><b>{MOV[m.tipo]}</b> · {m.qtd} un. · <span className="muted">{m.produtos}</span></div>
                <div className="muted pequeno">{m.usuario} · {fmtDataHora(m.criado_em)}{m.pedido ? ' · Pedido ' + m.pedido : ''}{m.observacao ? ' · ' + m.observacao : ''}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
