import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../api.js';
import { Carregando, ErroBox, Modal, useCarregar, useToast, useDialog } from '../components/ui.jsx';

export default function Clientes() {
  const toast = useToast();
  const dialog = useDialog();
  const [busca, setBusca] = useState(''), [filtro, setFiltro] = useState('');
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/clientes'), []);
  const ruas = useCarregar(() => get('/localizacoes'), []);
  const [edit, setEdit] = useState(null);
  const lista = (dados || []).filter((c) => (!busca || (c.nome + c.codigo + (c.aliases || []).join(' ')).toUpperCase().includes(busca.toUpperCase())) && (filtro !== 'semrua' || !c.localizacao_id));
  const semRua = (dados || []).filter((c) => !c.localizacao_id).length;

  const mudarRua = async (c, localizacao_id) => {
    try {
      await put(`/clientes/${c.id}`, { localizacao_id: localizacao_id ? +localizacao_id : null });
      toast(`${c.nome} → ${ruas.dados.find((r) => r.id === +localizacao_id)?.codigo || 'sem rua'}`);
      if (c.unidades > 0) {
        const ok = await dialog({ titulo: 'Transferir estoque?', mensagem: `${c.nome} tem ${c.unidades} un. registradas na rua anterior. Registrar a transferência para a nova rua? (Mova os produtos fisicamente.)`, confirmar: 'Transferir', cancelar: 'Não agora' });
        if (ok) await post(`/clientes/${c.id}/transferir`, { localizacao_origem_id: c.localizacao_id });
      }
      recarregar(true);
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  const transferir = async (c, f) => {
    try { const r = await post(`/clientes/${c.id}/transferir`, { localizacao_origem_id: f.localizacao_id }); toast(`${r.unidades} un. transferidas para ${c.rua}`); recarregar(true); } catch (e) { toast(e.message, 'ERRO'); }
  };

  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>Clientes</h1>
        <div className="linha-botoes"><Link className="btn btn-leve" to="/etiquetas">🖨️ Etiquetas</Link><button className="btn btn-primario" onClick={() => setEdit({})}>+ Novo cliente</button></div>
      </div>
      {semRua > 0 && <div className="resultado alerta compacto"><div className="resultado-titulo">⚠️ {semRua} cliente(s) sem rua — a entrada no estoque fica bloqueada para eles.</div></div>}
      <div className="filtros">
        <input className="busca" placeholder="Buscar nome, código ou apelido" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)}><option value="">Todos</option><option value="semrua">Só sem rua</option></select>
      </div>
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead><tr><th>Código / barras</th><th>Nome</th><th>Rua</th><th className="num">Un. na rua</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} className={!c.localizacao_id ? 'linha-alerta' : ''}>
                  <td><b>{c.codigo}</b>{c.codigo_barras !== c.codigo && <div className="pequeno muted">{c.codigo_barras}</div>}</td>
                  <td><Link to={`/pedidos-mensais/${c.id}`}>{c.nome}</Link>{c.aliases?.filter((a) => a !== c.nome).length > 0 && <div className="pequeno muted">também: {c.aliases.filter((a) => a !== c.nome).join(', ')}</div>}
                    {c.fora_da_rua?.map((f) => <div key={f.localizacao_id} className="pequeno txt-alerta">⚠️ {f.qtd} un. ainda em {f.rua || 'sem rua'} <button className="btn btn-leve btn-p" onClick={() => transferir(c, f)}>Transferir p/ {c.rua}</button></div>)}
                  </td>
                  <td><select value={c.localizacao_id || ''} onChange={(e) => mudarRua(c, e.target.value)}><option value="">— sem rua —</option>{ruas.dados?.map((r) => <option key={r.id} value={r.id}>{r.codigo}</option>)}</select></td>
                  <td className="num">{c.unidades}</td>
                  <td>{c.status}</td>
                  <td><button className="btn btn-leve btn-p" onClick={() => setEdit(c)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ClienteModal c={edit} ruas={ruas.dados || []} onFechar={(ok) => { setEdit(null); if (ok) recarregar(true); }} />}
    </div>
  );
}

function ClienteModal({ c, ruas, onFechar }) {
  const toast = useToast();
  const novo = !c.id;
  const [f, setF] = useState({ nome: c.nome || '', codigo: c.codigo || '', codigo_barras: c.codigo_barras || '', localizacao_id: c.localizacao_id || '', status: c.status || 'ATIVO' });
  const [alias, setAlias] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const salvar = async () => {
    try {
      if (novo) await post('/clientes', { ...f, localizacao_id: f.localizacao_id || null });
      else await put(`/clientes/${c.id}`, { nome: f.nome, codigo_barras: f.codigo_barras, status: f.status });
      if (!novo && alias) await post(`/clientes/${c.id}/aliases`, { nome: alias });
      toast('Cliente salvo'); onFechar(true);
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  return (
    <Modal titulo={novo ? 'Novo cliente' : 'Editar cliente ' + c.codigo} onFechar={() => onFechar(false)}
      rodape={<><button className="btn btn-leve" onClick={() => onFechar(false)}>Cancelar</button><button className="btn btn-primario" disabled={!f.nome} onClick={salvar}>Salvar</button></>}>
      <div className="form">
        <label>Nome<input value={f.nome} onChange={set('nome')} /></label>
        {novo && <label>Código (vazio = automático)<input value={f.codigo} onChange={set('codigo')} placeholder="CLI0001" /></label>}
        <label>Código de barras da etiqueta (vazio = igual ao código)<input value={f.codigo_barras} onChange={set('codigo_barras')} /></label>
        {novo && <label>Rua<select value={f.localizacao_id} onChange={set('localizacao_id')}><option value="">— sem rua —</option>{ruas.map((r) => <option key={r.id} value={r.id}>{r.codigo}</option>)}</select></label>}
        {!novo && <label>Status<select value={f.status} onChange={set('status')}><option value="ATIVO">Ativo</option><option value="INATIVO">Inativo</option></select></label>}
        {!novo && <label>Adicionar outro nome usado no CSV para este cliente<input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="ex.: KINGSTAR COLCHOES" /></label>}
      </div>
    </Modal>
  );
}
