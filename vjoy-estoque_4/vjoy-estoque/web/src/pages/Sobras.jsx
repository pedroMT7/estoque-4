import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api.js';
import { Carregando, ErroBox, Modal, useCarregar, useToast } from '../components/ui.jsx';
import { useAtualizacao } from '../realtime.js';
import { useAuth } from '../auth.jsx';
import { baixarCSV, fmtData } from '../util.js';

export default function Sobras() {
  const { pode } = useAuth();
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/sobras'), []);
  useAtualizacao(() => recarregar(true));
  const [vinc, setVinc] = useState(null);
  const [aj, setAj] = useState(null);
  const total = dados?.reduce((s, r) => s + r.saldo, 0) || 0;
  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <h1>Sobras / Excedentes</h1>
        <button className="btn btn-leve" disabled={!dados?.length} onClick={() => baixarCSV('sobras.csv', dados, [['cliente', 'Cliente'], ['rua', 'Rua'], ['pedido', 'Pedido'], ['item', 'Item'], ['codigo', 'Produto'], ['entrou', 'Entrada'], ['saiu', 'Saída'], ['saldo', 'Saldo']])}>⬇ CSV</button>
      </div>
      <p className="muted">Unidades que continuam fisicamente no estoque sem necessidade: o item do pedido já foi todo expedido, o pedido foi cancelado ou a entrada não tinha pedido. Podem ser vinculadas a um pedido futuro ou ajustadas.</p>
      <ErroBox erro={erro} />
      {dados && (total ? <div className="resultado alerta compacto"><div className="resultado-titulo">⚠️ {total} UNIDADE(S) SOBRANDO em {dados.length} saldo(s)</div></div> : <div className="resultado ok compacto"><div className="resultado-titulo">✓ Nenhuma sobra no estoque</div></div>)}
      {carregando && !dados ? <Carregando /> : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead><tr><th>Cliente</th><th>Rua</th><th>Pedido</th><th>Produto</th><th className="num">Entrada</th><th className="num">Saída</th><th className="num">Saldo</th><th>Desde</th><th></th></tr></thead>
            <tbody>
              {dados?.map((s, i) => (
                <tr key={i}>
                  <td>{s.cliente}</td><td><b>{s.rua}</b></td>
                  <td>{s.pedido ? <Link to={`/pedidos/${s.pedido_id}`}>{s.item}</Link> : <span className="muted">sem pedido</span>}{s.cancelado && <span className="badge badge-vermelho">cancelado</span>}</td>
                  <td><b>{s.codigo}</b><div className="muted pequeno">{s.descricao}</div></td>
                  <td className="num">{s.entrou}</td><td className="num">{s.saiu}</td><td className="num"><b className="txt-alerta">{s.saldo}</b></td>
                  <td className="pequeno">{fmtData(s.desde)}</td>
                  <td className="acoes">
                    <button className="btn btn-primario btn-p" onClick={() => setVinc(s)}>Usar em pedido</button>
                    {pode('ajuste') && <button className="btn btn-leve btn-p" onClick={() => setAj(s)}>Ajustar</button>}
                  </td>
                </tr>
              ))}
              {dados?.length === 0 && <tr><td colSpan={9} className="muted">Nenhuma sobra. 🎯</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {vinc && <VincularModal s={vinc} onFechar={() => { setVinc(null); recarregar(true); }} />}
      {aj && <AjusteModal b={{ ...aj, qtd: aj.saldo }} onFechar={() => { setAj(null); recarregar(true); }} />}
    </div>
  );
}

function VincularModal({ s, onFechar }) {
  const toast = useToast();
  const { dados } = useCarregar(() => get('/sobras/destinos/' + s.produto_id), [s.produto_id]);
  const [dest, setDest] = useState(null), [qtd, setQtd] = useState(1), [obs, setObs] = useState('');
  const falta = dest ? dest.qtd_pedida - dest.recebido : 0;
  const salvar = async () => {
    try {
      const r = await post('/vinculos', { produto_id: s.produto_id, cliente_id: s.cliente_id, localizacao_id: s.localizacao_id, pedido_item_origem_id: s.pedido_item_id, pedido_item_destino_id: dest.pedido_item_id, quantidade: qtd, observacao: obs });
      toast(r.mensagem + (r.ainda_falta ? ` · ainda falta receber/produzir ${r.ainda_falta}` : ' · item completo'));
      onFechar();
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  return (
    <Modal titulo={`Usar sobra de ${s.codigo} em outro pedido`} largo onFechar={onFechar}
      rodape={<><button className="btn btn-leve" onClick={onFechar}>Cancelar</button><button className="btn btn-primario" disabled={!dest || qtd < 1 || qtd > Math.min(s.saldo, falta)} onClick={salvar}>Vincular {qtd} un.</button></>}>
      <p>Disponível: <b>{s.saldo}</b> un. em <b>{s.rua}</b> ({s.cliente})</p>
      {!dados ? <Carregando /> : dados.length === 0 ? <div className="vazio">Nenhum pedido em aberto precisando deste produto.</div> : (
        <div className="tabela-rolagem"><table className="tabela"><thead><tr><th></th><th>Pedido/item</th><th>Cliente</th><th className="num">Pedido</th><th className="num">Recebido</th><th className="num">Falta</th></tr></thead>
          <tbody>{dados.map((d) => <tr key={d.pedido_item_id} className={dest?.pedido_item_id === d.pedido_item_id ? 'linha-sel' : ''} onClick={() => { setDest(d); setQtd(Math.min(s.saldo, d.qtd_pedida - d.recebido)); }} style={{ cursor: 'pointer' }}>
            <td><input type="radio" readOnly checked={dest?.pedido_item_id === d.pedido_item_id} /></td><td>{d.numero_origem}</td><td>{d.cliente} <span className="muted">({d.rua || 'sem rua'})</span></td><td className="num">{d.qtd_pedida}</td><td className="num">{d.recebido}</td><td className="num"><b>{d.qtd_pedida - d.recebido}</b></td></tr>)}</tbody></table></div>
      )}
      {dest && (
        <div className="form">
          <label>Quantidade a vincular<input type="number" min={1} max={Math.min(s.saldo, falta)} value={qtd} onChange={(e) => setQtd(+e.target.value)} /></label>
          <div className="muted">Resultado: {qtd} do estoque existente · {Math.max(0, falta - qtd)} ainda precisam ser produzidas/recebidas.{dest.cliente_id !== s.cliente_id && <b className="txt-alerta"> Cliente diferente: mover fisicamente para a rua {dest.rua}.</b>}</div>
          <label>Observação (opcional)<input value={obs} onChange={(e) => setObs(e.target.value)} /></label>
        </div>
      )}
    </Modal>
  );
}

export function AjusteModal({ b, onFechar }) {
  const toast = useToast();
  const [cont, setCont] = useState(b.qtd), [motivo, setMotivo] = useState('');
  const salvar = async () => {
    try {
      const r = await post('/ajustes', { produto_id: b.produto_id, cliente_id: b.cliente_id, localizacao_id: b.localizacao_id, pedido_item_id: b.pedido_item_id, contagem: cont, motivo });
      toast(`Ajuste registrado: ${r.quantidade_anterior} → ${r.quantidade_final} (${r.ajuste > 0 ? '+' : ''}${r.ajuste})`);
      onFechar();
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  const delta = cont - b.qtd;
  return (
    <Modal titulo={`Ajuste de estoque — ${b.codigo}`} onFechar={onFechar}
      rodape={<><button className="btn btn-leve" onClick={onFechar}>Cancelar</button><button className="btn btn-alerta" disabled={!delta || motivo.trim().length < 5} onClick={salvar}>Registrar ajuste</button></>}>
      <p>{b.cliente} · Rua <b>{b.rua}</b> · {b.item || 'estoque livre'}</p>
      <div className="form">
        <div className="resumo-final"><div><span>Saldo no sistema</span><b>{b.qtd}</b></div><div><span>Ajuste</span><b className={delta ? 'txt-alerta' : ''}>{delta > 0 ? '+' : ''}{delta}</b></div><div><span>Quantidade final</span><b>{cont}</b></div></div>
        <label>Contagem física<input type="number" min={0} value={cont} onChange={(e) => setCont(Math.max(0, +e.target.value))} /></label>
        <label>Motivo (obrigatório)<textarea rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: contagem física encontrou 4 unidades" /></label>
        <p className="muted pequeno">O ajuste gera uma movimentação nova. Nada é apagado.</p>
      </div>
    </Modal>
  );
}
