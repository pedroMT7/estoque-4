import { useState } from 'react';
import { api, get, post } from '../api.js';
import { Carregando, ErroBox, useCarregar, useToast, useDialog } from '../components/ui.jsx';
import { fmtDataHora, fmtDia } from '../util.js';

export default function Importar() {
  const toast = useToast();
  const dialog = useDialog();
  const [arquivo, setArquivo] = useState(null);
  const [pv, setPv] = useState(null);
  const [erro, setErro] = useState(null);
  const [env, setEnv] = useState(false);
  const [mapa, setMapa] = useState({});
  const [aba, setAba] = useState('clientes');
  const hist = useCarregar(() => get('/importacoes'), []);

  const analisar = async () => {
    setEnv(true); setErro(null); setPv(null);
    try {
      const f = new FormData(); f.append('arquivo', arquivo);
      const r = await api('/importacoes/previa', { method: 'POST', form: f });
      // sugestão padrão: se há semelhante com score alto, pré-seleciona
      const m = {};
      for (const c of r.clientesNovos) {
        const s = c.sugestoes[0];
        m[c.nome] = s && s.score >= 0.95 ? (s.tipo === 'existente' ? { acao: 'existente', cliente_id: s.cliente_id } : { acao: 'mesmo_que', nome: s.nome }) : { acao: 'novo' };
      }
      // evita ciclo "A mesmo que B" e "B mesmo que A": o primeiro em ordem alfabética fica como novo
      for (const [n, a] of Object.entries(m)) if (a.acao === 'mesmo_que' && m[a.nome]?.acao === 'mesmo_que' && m[a.nome].nome === n) m[n < a.nome ? n : a.nome] = { acao: 'novo' };
      setMapa(m); setPv(r); setAba(r.clientesNovos.length ? 'clientes' : 'pendentes');
    } catch (e) { setErro(e); } finally { setEnv(false); }
  };
  const confirmar = async () => {
    const R = pv.resumo;
    const ok = await dialog({ tom: 'ok', titulo: 'Confirmar importação', confirmar: 'Importar',
      mensagem: <>Serão importados <b>{R.itens_novos}</b> itens ({R.unidades_novas} un.) em <b>{R.pedidos_novos}</b> pedidos novos e {R.pedidos_existentes_com_itens_novos} existentes. <br />Nada já importado será duplicado.</> });
    if (!ok) return;
    setEnv(true);
    try {
      const r = await post(`/importacoes/${pv.importacao_id}/confirmar`, { clientes: mapa });
      toast(`Importado: ${r.pedidos_criados} pedidos, ${r.itens_criados} itens, ${r.clientes_criados} clientes e ${r.produtos_criados} produtos novos`);
      setPv(null); setArquivo(null); hist.recarregar();
    } catch (e) { setErro(e); } finally { setEnv(false); }
  };
  const descartar = async () => { await post(`/importacoes/${pv.importacao_id}/descartar`).catch(() => {}); setPv(null); };

  const R = pv?.resumo;
  const nomesNovos = pv?.clientesNovos.map((c) => c.nome) || [];
  return (
    <div className="pagina">
      <h1>Importar pedidos</h1>
      <p className="muted">Arquivo CSV no modelo atual (separado por “;”). Regras: só linhas <b>PA</b> (produto acabado) viram itens; <b>SA</b> (componentes) são ignoradas. Pedido = base do campo Número (ex.: <code>043334/K/001</code> → pedido <b>043334</b>). Necessidade = <b>Qtde. Produzir</b>. Reimportar não duplica.</p>
      {!pv && (
        <div className="painel upload">
          <input type="file" accept=".csv,text/csv" onChange={(e) => setArquivo(e.target.files[0])} />
          <button className="btn btn-primario" disabled={!arquivo || env} onClick={analisar}>{env ? 'Analisando…' : 'Analisar arquivo'}</button>
        </div>
      )}
      <ErroBox erro={erro} />
      {pv && (
        <div className="painel">
          <h2>Prévia — {pv.arquivo}</h2>
          {pv.ja_importado_em && <div className="resultado alerta compacto"><div className="resultado-titulo">⚠️ Este mesmo arquivo já foi importado em {fmtDataHora(pv.ja_importado_em)}. Nada será duplicado.</div></div>}
          <div className="resumo-imp">
            <p className="grande">Existem <b>{R.pedidos_no_arquivo}</b> pedidos no arquivo. <b>{R.pedidos_novos}</b> são novos, <b>{R.pedidos_ja_existentes_sem_novidade}</b> já existem{R.pedidos_existentes_com_itens_novos ? <> e <b>{R.pedidos_existentes_com_itens_novos}</b> existentes recebem itens novos</> : ''}.</p>
            <p><b>{R.itens_novos}</b> itens ({R.unidades_novas} unidades) serão importados.</p>
          </div>
          <div className="kpis">
            <div className="kpi"><span>Linhas</span><b>{R.total_linhas}</b></div>
            <div className="kpi"><span>PA (produto acabado)</span><b>{R.linhas_pa}</b></div>
            <div className="kpi"><span>SA ignoradas</span><b>{R.ignoradas_sa}</b></div>
            <div className="kpi"><span>Itens já existentes</span><b>{R.itens_existentes}</b></div>
            <div className={'kpi' + (R.pendentes ? ' kpi-erro' : '')}><span>Inválidas/pendentes</span><b>{R.pendentes + R.duplicadas_arquivo}</b></div>
            <div className={'kpi' + (R.possiveis_duplicidades ? ' kpi-alerta' : '')}><span>Possíveis duplicidades</span><b>{R.possiveis_duplicidades}</b></div>
            <div className="kpi"><span>Clientes novos</span><b>{R.clientes_novos}</b></div>
            <div className="kpi"><span>Produtos novos</span><b>{R.produtos_novos}</b></div>
          </div>
          <div className="abas">
            <button className={aba === 'clientes' ? 'ativa' : ''} onClick={() => setAba('clientes')}>Clientes novos ({pv.clientesNovos.length})</button>
            <button className={aba === 'pendentes' ? 'ativa' : ''} onClick={() => setAba('pendentes')}>Não importadas ({pv.pendentes.length})</button>
            <button className={aba === 'alertas' ? 'ativa' : ''} onClick={() => setAba('alertas')}>Alertas ({pv.alertas.length + pv.pedidosMultiCliente.length})</button>
            <button className={aba === 'amostra' ? 'ativa' : ''} onClick={() => setAba('amostra')}>Itens novos</button>
          </div>
          {aba === 'clientes' && (
            <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Nome no arquivo</th><th className="num">Itens</th><th>O que fazer</th></tr></thead>
              <tbody>{pv.clientesNovos.map((c) => {
                const a = mapa[c.nome] || { acao: 'novo' };
                const val = a.acao === 'existente' ? 'e:' + a.cliente_id : a.acao === 'mesmo_que' ? 'm:' + a.nome : 'novo';
                return (
                  <tr key={c.nome} className={c.sugestoes.length ? 'linha-alerta' : ''}>
                    <td><b>{c.nome}</b>{c.sugestoes.length > 0 && <div className="pequeno txt-alerta">⚠️ Parecido com: {c.sugestoes.map((s) => s.nome).join(', ')}</div>}</td>
                    <td className="num">{c.itens}</td>
                    <td>
                      <select value={val} onChange={(e) => { const v = e.target.value; setMapa((m) => ({ ...m, [c.nome]: v === 'novo' ? { acao: 'novo' } : v.startsWith('e:') ? { acao: 'existente', cliente_id: +v.slice(2) } : { acao: 'mesmo_que', nome: v.slice(2) } })); }}>
                        <option value="novo">Criar cliente novo</option>
                        {c.sugestoes.filter((s) => s.tipo === 'existente').map((s) => <option key={s.cliente_id} value={'e:' + s.cliente_id}>É o cliente já cadastrado: {s.nome}</option>)}
                        {nomesNovos.filter((n) => n !== c.nome).sort((x, y) => (c.sugestoes.some((s) => s.nome === y) ? 1 : 0) - (c.sugestoes.some((s) => s.nome === x) ? 1 : 0)).map((n) => <option key={n} value={'m:' + n}>Mesmo cliente que: {n}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}</tbody></table></div>
          )}
          {aba === 'pendentes' && <TabelaLinhas linhas={pv.pendentes} campo="motivo" />}
          {aba === 'alertas' && (
            <>
              {pv.pedidosMultiCliente.length > 0 && <div className="mini-cartao alerta"><b>Pedidos com mais de um cliente</b> (cada item fica na rua do seu cliente): {pv.pedidosMultiCliente.map((p) => `${p.pedido} (${p.clientes.join(' / ')})`).join('; ')}</div>}
              <TabelaLinhas linhas={pv.alertas} campo="alerta" />
            </>
          )}
          {aba === 'amostra' && <TabelaLinhas linhas={pv.amostraNovos} campo={null} />}
          <div className="barra-acao linha-botoes">
            <button className="btn btn-leve" onClick={descartar} disabled={env}>Descartar</button>
            <button className="btn btn-sucesso btn-g" disabled={env || !R.itens_novos} onClick={confirmar}>{env ? 'Importando…' : `Confirmar importação de ${R.itens_novos} itens`}</button>
          </div>
        </div>
      )}
      <h3 className="sec">Importações anteriores</h3>
      {hist.carregando ? <Carregando /> : (
        <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Data</th><th>Arquivo</th><th>Usuário</th><th>Status</th><th className="num">Pedidos criados</th><th className="num">Itens criados</th></tr></thead>
          <tbody>{hist.dados?.map((h) => <tr key={h.id}><td>{fmtDataHora(h.confirmado_em || h.criado_em)}</td><td>{h.arquivo_nome}</td><td>{h.usuario}</td><td>{h.status === 'CONFIRMADA' ? 'Importada' : 'Prévia não confirmada'}</td><td className="num">{h.resumo.pedidos_criados ?? '—'}</td><td className="num">{h.resumo.itens_criados ?? '—'}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

function TabelaLinhas({ linhas, campo }) {
  if (!linhas.length) return <div className="vazio">Nada aqui.</div>;
  return (
    <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Linha</th><th>Número</th><th>Tipo</th><th>Código</th><th>Cliente</th><th className="num">Qtd</th><th>Emissão</th>{campo && <th>Motivo</th>}</tr></thead>
      <tbody>{linhas.map((l) => <tr key={l.linha}><td>{l.linha}</td><td>{l.numero}</td><td>{l.tipo}</td><td>{l.codigo}</td><td>{l.cliente || <span className="txt-erro">vazio</span>}</td><td className="num">{l.qtd}</td><td>{fmtDia(l.emissao)}</td>{campo && <td className="pequeno">{l[campo]}</td>}</tr>)}</tbody></table></div>
  );
}
