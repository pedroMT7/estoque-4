import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { DialogProvider, ToastProvider, Carregando } from './components/ui.jsx';
import { useOnline } from './realtime.js';
import { getSom, setSom } from './feedback.js';
import { PERFIS } from './util.js';
import Login from './pages/Login.jsx';
import Inicio from './pages/Inicio.jsx';
import Entrada from './pages/Entrada.jsx';
import { SeparacaoLista, SeparacaoTela } from './pages/Separacao.jsx';
import { ConferenciaLista, ConferenciaTela, SaidaLista } from './pages/Conferencia.jsx';
import Consulta from './pages/Consulta.jsx';
import { MENU } from './menu.js';

const Estoque = lazy(() => import('./pages/Estoque.jsx'));
const Pedidos = lazy(() => import('./pages/Pedidos.jsx'));
const PedidoDetalhe = lazy(() => import('./pages/PedidoDetalhe.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Sobras = lazy(() => import('./pages/Sobras.jsx'));
const Relatorios = lazy(() => import('./pages/Relatorios.jsx'));
const Rastreio = lazy(() => import('./pages/Rastreio.jsx'));
const Importar = lazy(() => import('./pages/Importar.jsx'));
const Clientes = lazy(() => import('./pages/Clientes.jsx'));
const Ruas = lazy(() => import('./pages/Ruas.jsx'));
const Produtos = lazy(() => import('./pages/Produtos.jsx'));
const Usuarios = lazy(() => import('./pages/Usuarios.jsx'));
const Etiquetas = lazy(() => import('./pages/Etiquetas.jsx'));
const CarregamentoLista = lazy(() => import('./pages/Carregamento.jsx').then((m) => ({ default: m.CarregamentoLista })));
const CarregamentoTela = lazy(() => import('./pages/Carregamento.jsx').then((m) => ({ default: m.CarregamentoTela })));
const PedidosMensais = lazy(() => import('./pages/PedidosMensais.jsx').then((m) => ({ default: m.PedidosMensais })));
const PedidoMensalCliente = lazy(() => import('./pages/PedidosMensais.jsx').then((m) => ({ default: m.PedidoMensalCliente })));



export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <DialogProvider>
          <Raiz />
        </DialogProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function Raiz() {
  const { usuario, carregando } = useAuth();
  if (carregando) return <div className="tela-cheia"><Carregando /></div>;
  if (!usuario) return <Login />;
  return <Layout />;
}

function Guard({ perm, children }) {
  const { pode } = useAuth();
  if (perm && !pode(perm)) return <div className="pagina"><div className="erro-box">Seu perfil não tem acesso a esta tela.</div></div>;
  return children;
}

function Layout() {
  const { usuario, pode, sair } = useAuth();
  const [menu, setMenu] = useState(false);
  const [som, setSomSt] = useState(getSom());
  const online = useOnline();
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const itens = MENU.filter((m) => !m.perm || pode(m.perm));
  const principais = itens.filter((m) => m.op).slice(0, 3);
  const inferior = [itens[0], ...principais];
  const grupos = [...new Set(itens.map((m) => m.grupo || ''))];

  const nav = (
    <nav className="nav">
      {grupos.map((g) => (
        <div key={g} className="nav-grupo">
          {g && <div className="nav-grupo-t">{g}</div>}
          {itens.filter((m) => (m.grupo || '') === g).map((m) => (
            <NavLink key={m.to} to={m.to} end={m.fim} className="nav-item"><span className="nav-ic" aria-hidden>{m.ic}</span>{m.t}</NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
  const rodape = (
    <div className="lateral-rodape">
      <div className="usuario"><b>{usuario.nome}</b><span>{PERFIS[usuario.perfil]}</span></div>
      <label className="som"><input type="checkbox" checked={som} onChange={(e) => { setSom(e.target.checked); setSomSt(e.target.checked); }} /> Som nas leituras</label>
      <button className="btn btn-leve btn-bloco" onClick={sair}>Sair</button>
    </div>
  );

  return (
    <div className="app">
      <aside className="lateral">
        <div className="marca"><img src="/icon.svg" alt="" /> <span>VJOY <b>Estoque</b></span></div>
        {nav}
        {rodape}
      </aside>
      <header className="topo-mobile">
        <button className="btn-menu" onClick={() => setMenu(true)} aria-label="Abrir menu">☰</button>
        <span className="marca-mini">VJOY <b>Estoque</b></span>
        <span className={'online ' + (online ? 'on' : 'off')} title={online ? 'Conectado — atualização em tempo real' : 'Sem conexão em tempo real'}>{online ? '●' : '○'}</span>
      </header>
      {menu && (
        <div className="gaveta-fundo" onClick={() => setMenu(false)}>
          <div className="gaveta" onClick={(e) => e.stopPropagation()}>
            <div className="marca"><img src="/icon.svg" alt="" /> <span>VJOY <b>Estoque</b></span></div>
            {nav}
            {rodape}
          </div>
        </div>
      )}
      <main className="conteudo">
        {!online && <div className="faixa-offline">Sem conexão em tempo real com o servidor — verificando…</div>}
        <Suspense fallback={<Carregando />}>
          <Routes>
            <Route path="/" element={<Inicio />} />
            <Route path="/entrada" element={<Guard perm="entrada"><Entrada /></Guard>} />
            <Route path="/separacao" element={<Guard perm="separacao"><SeparacaoLista /></Guard>} />
            <Route path="/separacao/:id" element={<Guard perm="separacao"><SeparacaoTela /></Guard>} />
            <Route path="/carregamento" element={<Guard perm="saida"><CarregamentoLista /></Guard>} />
            <Route path="/carregamento/:id" element={<Guard perm="saida"><CarregamentoTela /></Guard>} />
            <Route path="/pedidos-mensais" element={<PedidosMensais />} />
            <Route path="/pedidos-mensais/:id" element={<PedidoMensalCliente />} />
            <Route path="/saida" element={<Guard perm="saida"><SaidaLista /></Guard>} />
            <Route path="/saida/:id" element={<Guard perm="saida"><ConferenciaTela /></Guard>} />
            <Route path="/conferencia" element={<Guard perm="conferencia"><ConferenciaLista /></Guard>} />
            <Route path="/conferencia/:id" element={<Guard perm="conferencia"><ConferenciaTela /></Guard>} />
            <Route path="/consulta" element={<Guard perm="consulta"><Consulta /></Guard>} />
            <Route path="/estoque" element={<Guard perm="consulta"><Estoque /></Guard>} />
            <Route path="/pedidos" element={<Pedidos />} />
            <Route path="/pedidos/:id" element={<PedidoDetalhe />} />
            <Route path="/dashboard" element={<Guard perm="gestao"><Dashboard /></Guard>} />
            <Route path="/sobras" element={<Guard perm="gestao"><Sobras /></Guard>} />
            <Route path="/relatorios" element={<Guard perm="gestao"><Relatorios /></Guard>} />
            <Route path="/rastreio" element={<Guard perm="gestao"><Rastreio /></Guard>} />
            <Route path="/importar" element={<Guard perm="importar"><Importar /></Guard>} />
            <Route path="/clientes" element={<Guard perm="cadastros"><Clientes /></Guard>} />
            <Route path="/ruas" element={<Guard perm="cadastros"><Ruas /></Guard>} />
            <Route path="/produtos" element={<Guard perm="cadastros"><Produtos /></Guard>} />
            <Route path="/etiquetas" element={<Guard perm="cadastros"><Etiquetas /></Guard>} />
            <Route path="/usuarios" element={<Guard perm="usuarios"><Usuarios /></Guard>} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Suspense>
      </main>
      <nav className="barra-inferior">
        {inferior.map((m) => <NavLink key={m.to} to={m.to} end={m.fim} className="bi-item"><span aria-hidden>{m.ic}</span>{m.t}</NavLink>)}
        <button className="bi-item" onClick={() => setMenu(true)}><span aria-hidden>☰</span>Menu</button>
      </nav>
    </div>
  );
}
