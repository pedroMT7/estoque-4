import { useState } from 'react';
import { get, post, put } from '../api.js';
import { Carregando, Modal, useCarregar, useToast } from '../components/ui.jsx';
import { PERFIS, fmtData } from '../util.js';

const DESC = { ADMIN: 'Acesso total', ESTOQUE: 'Entrada e movimentação', EXPEDICAO: 'Separação', CONFERENCIA: 'Conferência e saída', GESTAO: 'Dashboard, relatórios, análise, importação, ajustes, cadastros' };

export default function Usuarios() {
  const toast = useToast();
  const { dados, carregando, recarregar } = useCarregar(() => get('/usuarios'), []);
  const [edit, setEdit] = useState(null);
  const salvar = async (f) => {
    try {
      if (f.id) await put('/usuarios/' + f.id, { nome: f.nome, perfil: f.perfil, ativo: f.ativo, senha: f.senha || undefined });
      else await post('/usuarios', f);
      toast('Usuário salvo'); setEdit(null); recarregar(true);
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>Usuários</h1><button className="btn btn-primario" onClick={() => setEdit({ nome: '', login: '', senha: '', perfil: 'ESTOQUE', ativo: true })}>+ Novo usuário</button></div>
      <div className="kpis">{Object.entries(DESC).map(([k, v]) => <div key={k} className="kpi"><span>{PERFIS[k]}</span><small>{v}</small></div>)}</div>
      {carregando ? <Carregando /> : (
        <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Status</th><th>Criado</th><th></th></tr></thead>
          <tbody>{dados?.map((u) => <tr key={u.id} className={!u.ativo ? 'muted' : ''}><td>{u.nome}</td><td>{u.login}</td><td>{PERFIS[u.perfil]}</td><td>{u.ativo ? 'Ativo' : 'Inativo'}</td><td>{fmtData(u.criado_em)}</td><td><button className="btn btn-leve btn-p" onClick={() => setEdit({ ...u, senha: '' })}>Editar</button></td></tr>)}</tbody></table></div>
      )}
      {edit && <UsuarioModal u={edit} onSalvar={salvar} onFechar={() => setEdit(null)} />}
    </div>
  );
}
function UsuarioModal({ u, onSalvar, onFechar }) {
  const [f, setF] = useState(u);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <Modal titulo={u.id ? 'Editar ' + u.login : 'Novo usuário'} onFechar={onFechar}
      rodape={<><button className="btn btn-leve" onClick={onFechar}>Cancelar</button><button className="btn btn-primario" onClick={() => onSalvar(f)}>Salvar</button></>}>
      <div className="form">
        <label>Nome<input value={f.nome} onChange={set('nome')} /></label>
        {!u.id && <label>Login<input value={f.login} onChange={set('login')} autoCapitalize="none" /></label>}
        <label>{u.id ? 'Nova senha (vazio = manter)' : 'Senha'}<input type="password" value={f.senha} onChange={set('senha')} autoComplete="new-password" /></label>
        <label>Perfil<select value={f.perfil} onChange={set('perfil')}>{Object.entries(PERFIS).map(([k, v]) => <option key={k} value={k}>{v} — {DESC[k]}</option>)}</select></label>
        {u.id && <label className="check-linha"><input type="checkbox" checked={f.ativo} onChange={set('ativo')} /> Ativo</label>}
      </div>
    </Modal>
  );
}
