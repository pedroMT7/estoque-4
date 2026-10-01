import { useState } from 'react';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { entrar } = useAuth();
  const [login, setLogin] = useState(''), [senha, setSenha] = useState(''), [erro, setErro] = useState(''), [env, setEnv] = useState(false);
  const enviar = async (e) => {
    e.preventDefault(); setErro(''); setEnv(true);
    try { await entrar(login, senha); } catch (e) { setErro(e.message); } finally { setEnv(false); }
  };
  return (
    <div className="login-tela">
      <form className="login-caixa" onSubmit={enviar}>
        <img src="/icon.svg" alt="" className="login-logo" />
        <h1>VJOY <b>Estoque</b></h1>
        <p className="muted">Controle físico: entrada, estoque, separação, conferência e expedição</p>
        <label>Login<input value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" autoComplete="username" autoFocus /></label>
        <label>Senha<input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="current-password" /></label>
        {erro && <div className="erro-box">{erro}</div>}
        <button className="btn btn-primario btn-bloco btn-g" disabled={env || !login || !senha}>{env ? 'Entrando…' : 'Entrar'}</button>
        {globalThis.__vjoyLocal && (
          <div className="demo-box">
            <b>Versão de teste</b>
            <span>Os dados ficam só neste navegador. Toque num perfil para entrar:</span>
            <div className="demo-usuarios">
              {[['admin', 'admin123', 'Administrador'], ['estoque', '1234', 'Estoque'], ['expedicao', '1234', 'Expedição'], ['conferencia', '1234', 'Conferência'], ['gestao', '1234', 'Gestão']].map(([l, s, t]) => (
                <button key={l} type="button" className="btn btn-leve" onClick={async () => { setErro(''); setEnv(true); try { await entrar(l, s); } catch (e) { setErro(e.message); } finally { setEnv(false); } }}>{t}<small>{l} / {s}</small></button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
