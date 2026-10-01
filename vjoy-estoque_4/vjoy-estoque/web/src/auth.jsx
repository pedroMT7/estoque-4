import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { get, post, salvarToken, token, definirAoExpirar, semConexao } from './api.js';
import { iniciarSincronizacao } from './offline.js';
import { conectar, desconectar } from './realtime.js';

const Ctx = createContext(null);
export function AuthProvider({ children }) {
  const [sessao, setSessao] = useState({ carregando: !!token(), usuario: null, permissoes: {} });
  const sair = useCallback(() => { salvarToken(null); try { localStorage.removeItem('vjoy_me'); } catch {} desconectar(); setSessao({ carregando: false, usuario: null, permissoes: {} }); }, []);
  const carregar = useCallback(async () => {
    try {
      const me = await get('/me');
      try { localStorage.setItem('vjoy_me', JSON.stringify(me)); } catch {}
      setSessao({ carregando: false, ...me }); conectar(); iniciarSincronizacao();
    } catch (e) {
      // sem internet ao abrir o app: continua logado com os dados guardados (só sai se o login expirou de verdade)
      let salvo = null; try { salvo = JSON.parse(localStorage.getItem('vjoy_me')); } catch {}
      if (semConexao(e) && salvo) { setSessao({ carregando: false, ...salvo, semInternet: true }); conectar(); iniciarSincronizacao(); setTimeout(() => carregar(), 15000); }
      else if (semConexao(e)) setTimeout(() => carregar(), 5000);
      else sair();
    }
  }, [sair]);
  useEffect(() => { definirAoExpirar(sair); if (token()) carregar(); }, [carregar, sair]);
  const entrar = async (login, senha) => { const r = await post('/login', { login, senha }); salvarToken(r.token); await carregar(); };
  const pode = (p) => !!sessao.permissoes?.[p];
  return <Ctx.Provider value={{ ...sessao, entrar, sair, pode }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
