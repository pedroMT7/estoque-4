import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, get, post } from '../api.js';
import { Carregando, ErroBox, Progresso, useCarregar, useToast, useDialog, Vazio } from '../components/ui.jsx';
import { EscolherCliente } from '../components/EscolherCliente.jsx';
import { useAtualizacao } from '../realtime.js';
import { useAuth } from '../auth.jsx';
import { fmtDataHora } from '../util.js';
import { baixarRomaneio } from './Carregamento.jsx';

const mesAtual = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
const mesNome = (m) => new Date(m.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function SeletorMes({ mes, onMudar }) {
  const mover = (d) => { const [a, m] = mes.split('-').map(Number); const x = new Date(Date.UTC(a, m - 1 + d, 15)); onMudar(x.toISOString().slice(0, 7)); };
  return (
    <div className="seletor-mes">
      <button className="btn btn-leve" onClick={() => mover(-1)} aria-label="Mês anterior">‹</button>
      <b>{mesNome(mes)}</b>
      <button className="btn btn-leve" onClick={() => mover(1)} aria-label="Próximo mês">›</button>
    </div>
  );
}

export function PedidosMensais() {
  const nav = useNavigate();
  const { pode } = useAuth();
  const [sp, setSp] = useSearchParams();
  const mes = sp.get('mes') || mesAtual();
  const [escolher, setEscolher] = useState(false);
  const clientes = useCarregar(() => get('/clientes'), []);
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/pedidos-mensais?mes=' + mes), [mes]);
  useAtualizacao(() => recarregar(true));
  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <h1>Pedidos mensais</h1>
        {pode('gestao') && <button className="btn btn-primario" onClick={() => setEscolher((x) => !x)}>+ Pedido mensal de um cliente</button>}
      </div>
      <SeletorMes mes={mes} onMudar={(m) => setSp({ mes: m })} />
      {escolher && <EscolherCliente clientes={(clientes.dados || []).filter((c) => c.status === 'ATIVO')} permitirNovo={false} titulo="ESCOLHA O CLIENTE" onEscolher={(c) => nav(`/pedidos-mensais/${c.id}?mes=${mes}`)} />}
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="lista-cartoes grade-cartoes">
          {!dados?.pedidos.length && <Vazio>Nenhum pedido mensal em {mesNome(mes)}.</Vazio>}
          {dados?.pedidos.map((p) => (
            <Link key={p.id} to={`/pedidos-mensais/${p.cliente_id}?mes=${mes}`} className="pedido-cartao link-limpo">
              <div className="pedido-cartao-topo"><span className="pedido-num">{p.cliente}</span><span className={'badge ' + (p.total_falta ? 'badge-azul' : 'badge-verde')}>{p.total_falta ? `falta ${p.total_falta}` : 'completo'}</span></div>
              <div className="pedido-info"><span><b>{p.total_carregado}</b> de {p.total_pedido} peças carregadas</span><span>{p.produtos} produtos</span>{p.total_em_carregamento > 0 && <span>🚛 {p.total_em_carregamento} carregando</span>}</div>
              <Progresso feito={p.total_carregado} total={p.total_pedido} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function PedidoMensalCliente() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const mes = sp.get('mes') || mesAtual();
  const toast = useToast();
  const dialog = useDialog();
  const { pode } = useAuth();
  const { dados: d, carregando, erro, recarregar } = useCarregar(() => get(`/pedidos-mensais/cliente/${id}?mes=${mes}`), [id, mes]);
  useAtualizacao(() => recarregar(true));
  const [lista, setLista] = useState(null); // edição: [{codigo, quantidade, descricao, existe}]
  const [arq, setArq] = useState(null), [lendo, setLendo] = useState(false);
  const [novoCod, setNovoCod] = useState(''), [novoQtd, setNovoQtd] = useState('');
  if (carregando && !d) return <Carregando />;
  if (erro && !d) return <div className="pagina"><ErroBox erro={erro} /></div>;

  const pm = d.pedido;
  const editar = () => setLista((pm?.itens || []).filter((i) => !i.fora_do_pedido).map((i) => ({ codigo: i.codigo, quantidade: i.pedido, descricao: i.descricao, existe: true })));
  const lerArquivo = async () => {
    setLendo(true);
    try {
      const f = new FormData(); f.append('arquivo', arq);
      const r = await api('/pedidos-mensais/ler-arquivo', { method: 'POST', form: f });
      setLista(r.itens);
      toast(`${r.itens.length} produtos lidos · ${r.total} peças${r.ignoradas ? ` · ${r.ignoradas} linhas ignoradas` : ''}`);
    } catch (e) { toast(e.message, 'ERRO'); } finally { setLendo(false); }
  };
  const salvar = async () => {
    const ok = await dialog({ titulo: 'Salvar pedido mensal', tom: 'ok', confirmar: 'Salvar',
      mensagem: `${d.cliente.nome} — ${mesNome(mes)}: ${lista.length} produtos, ${lista.reduce((s, i) => s + Number(i.quantidade || 0), 0)} peças.${pm ? ' A lista anterior deste mês será substituída (o que já foi carregado continua contando).' : ''}` });
    if (!ok) return;
    try { await post('/pedidos-mensais', { cliente_id: +id, mes, itens: lista }); toast('Pedido mensal salvo'); setLista(null); recarregar(); } catch (e) { toast(e.message, 'ERRO'); }
  };
  const addLinha = async () => {
    const cod = novoCod.trim().toUpperCase(); const q = Math.trunc(Number(novoQtd));
    if (!cod || !(q > 0)) return;
    let info = null; try { info = await get('/produtos/identificar/' + encodeURIComponent(cod)); } catch {}
    setLista((l) => [...(l || []), { codigo: info?.produto.codigo || cod, quantidade: q, descricao: info?.produto.descricao, existe: !!info }]);
    setNovoCod(''); setNovoQtd('');
  };

  return (
    <div className="pagina">
      <div className="pagina-cabeca">
        <div>
          <div className="muted pequeno">PEDIDO MENSAL</div>
          <h1>{d.cliente.nome}</h1>
        </div>
        <div className="linha-botoes">
          <Link className="btn btn-leve" to="/pedidos-mensais">← Todos</Link>
          {pode('saida') && <Link className="btn btn-primario" to={"/carregamento?cliente=" + id}>🚛 Carregar caminhão</Link>}
        </div>
      </div>
      <SeletorMes mes={mes} onMudar={(m) => { setLista(null); setSp({ mes: m }); }} />

      {pm && !lista && (
        <>
          <div className="kpis">
            <div className="kpi"><span>Pedido do mês</span><b>{pm.total_pedido}</b></div>
            <div className="kpi"><span>Carregado</span><b>{pm.total_carregado}</b></div>
            <div className="kpi"><span>Carregando agora</span><b>{pm.total_em_carregamento}</b></div>
            <div className={'kpi' + (pm.total_falta ? '' : ' kpi-ok')}><span>Falta</span><b>{pm.total_falta}</b></div>
          </div>
          <Progresso feito={pm.total_carregado} total={pm.total_pedido} />
          <div className="tabela-rolagem"><table className="tabela">
            <thead><tr><th>Código</th><th>Descrição</th><th className="num">Pedido</th><th className="num">Carregado</th><th className="num">Falta</th><th className="num">Em estoque</th></tr></thead>
            <tbody>{pm.itens.map((i) => (
              <tr key={i.produto_id} className={i.fora_do_pedido ? 'linha-alerta' : i.falta === 0 ? 'linha-ok' : ''}>
                <td><b>{i.codigo}</b>{i.fora_do_pedido && <span className="badge badge-amarelo">fora do pedido</span>}</td><td className="pequeno">{i.descricao}</td>
                <td className="num">{i.pedido || '—'}</td><td className="num">{i.carregado}{i.em_carregamento ? <span className="muted"> (+{i.em_carregamento})</span> : ''}</td>
                <td className="num"><b>{i.falta}</b></td><td className="num">{i.em_estoque}</td>
              </tr>))}</tbody>
          </table></div>
          {pode('gestao') && <button className="btn btn-leve" style={{ marginTop: 10 }} onClick={editar}>✏️ Editar / substituir lista do mês</button>}
        </>
      )}

      {!pm && !lista && <Vazio>Nenhum pedido mensal em {mesNome(mes)} para este cliente.{pode('gestao') ? ' Envie a lista abaixo.' : ''}</Vazio>}

      {pode('gestao') && (!pm || lista) && (
        <div className="painel form">
          <h3>{lista ? 'Conferir lista antes de salvar' : 'Subir lista do mês'}</h3>
          <p className="muted pequeno">Planilha (.xlsx) ou CSV com as colunas <b>Código</b> e <b>Quantidade</b>. Cabeçalhos repetidos são ignorados. Exemplo: CBOT088 · 500</p>
          <div className="linha-botoes">
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => setArq(e.target.files[0])} />
            <button className="btn btn-secundario" disabled={!arq || lendo} onClick={lerArquivo}>{lendo ? 'Lendo…' : 'Ler arquivo'}</button>
          </div>
          <div className="linha-botoes">
            <input placeholder="Código" value={novoCod} onChange={(e) => setNovoCod(e.target.value)} style={{ flex: '1 1 140px' }} />
            <input placeholder="Qtd" inputMode="numeric" value={novoQtd} onChange={(e) => setNovoQtd(e.target.value.replace(/\D/g, ''))} style={{ width: 90 }} onKeyDown={(e) => e.key === 'Enter' && addLinha()} />
            <button className="btn btn-leve" onClick={addLinha}>+ Adicionar</button>
          </div>
          {lista && (
            <>
              <div className="tabela-rolagem"><table className="tabela">
                <thead><tr><th>Código</th><th>Descrição</th><th className="num">Quantidade</th><th></th></tr></thead>
                <tbody>{lista.map((i, k) => (
                  <tr key={k} className={i.existe ? '' : 'linha-alerta'}>
                    <td><b>{i.codigo}</b></td><td className="pequeno">{i.descricao || <span className="txt-alerta">fora da base — será cadastrado</span>}</td>
                    <td className="num"><input className="input-qtd" inputMode="numeric" value={i.quantidade} onChange={(e) => setLista((l) => l.map((x, j) => (j === k ? { ...x, quantidade: e.target.value.replace(/\D/g, '') } : x)))} /></td>
                    <td><button className="btn btn-leve btn-p" onClick={() => setLista((l) => l.filter((_, j) => j !== k))}>✕</button></td>
                  </tr>))}</tbody>
              </table></div>
              <div className="total-linha">{lista.length} produtos · <b>{lista.reduce((s, i) => s + Number(i.quantidade || 0), 0)}</b> peças</div>
              <div className="linha-botoes">
                <button className="btn btn-leve" onClick={() => setLista(null)}>Cancelar</button>
                <button className="btn btn-sucesso" disabled={!lista.length} onClick={salvar}>Salvar pedido de {mesNome(mes)}</button>
              </div>
            </>
          )}
        </div>
      )}

      <h3 className="sec">Carregamentos do mês</h3>
      <div className="lista-cartoes">
        {!d.carregamentos.length && <Vazio>Nenhum carregamento neste mês.</Vazio>}
        {d.carregamentos.map((c) => (
          <div key={c.id} className="mini-cartao linha-flex">
            <div><Link to={'/carregamento/' + c.id}><b>Nº {String(c.id).padStart(5, '0')}</b></Link> · {c.pecas} peças · {c.status === 'ABERTO' ? <span className="badge badge-laranja">carregando</span> : fmtDataHora(c.finalizado_em)}
              <div className="muted pequeno">{c.placa || 'sem placa'}{c.motorista ? ' · ' + c.motorista : ''} · {c.usuario}</div></div>
            <button className="btn btn-leve btn-p" onClick={() => baixarRomaneio(c.id).catch((e) => toast(e.message, 'ERRO'))}>📄 PDF</button>
          </div>
        ))}
      </div>
    </div>
  );
}
