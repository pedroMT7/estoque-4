// Entrada da VERSÃO DE TESTE: tudo roda no navegador (banco PGlite + mesmas regras do servidor).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../estilo.css';
import { iniciarServidorLocal, aoMudar, resetarDados, carregarExemplo } from './servidor-local.js';
import { modoArmazenamento } from './db-local.js';

globalThis.__vjoyLocal = { aoMudar };
const raiz = createRoot(document.getElementById('root'));

function PainelTeste() {
  const [aberto, setAberto] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirmaReset, setConfirmaReset] = useState(false);
  return (
    <>
      <button className="teste-pilula" onClick={() => setAberto(true)} aria-label="Opções da versão de teste">🧪 Teste</button>
      {aberto && (
        <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && setAberto(false)}>
          <div className="modal" role="dialog" aria-label="Versão de teste">
            <div className="modal-cabeca"><h3>Versão de teste</h3><button className="btn-x" onClick={() => setAberto(false)}>✕</button></div>
            <div className="modal-corpo">
              <p>Este é o sistema completo, com as mesmas regras, rodando <b>dentro deste navegador</b>. Os dados ficam só aqui{modoArmazenamento === 'memoria' ? ' e somem ao recarregar a página' : ''}: outros aparelhos não veem o que você registra.</p>
              <p className="muted pequeno">Nesta versão, impressão de etiquetas, download de CSV e câmera ao vivo são bloqueados pelo visualizador. No lugar da câmera, use “Tirar foto do código”, digite o código ou use um leitor USB/Bluetooth. Na versão publicada (Railway) tudo isso funciona e vários aparelhos compartilham o mesmo banco.</p>
              <div className="form">
                <button className="btn btn-secundario" onClick={async () => { setMsg('Carregando…'); try { const r = await carregarExemplo(1); setMsg(r.itens_novos ? `Exemplo fictício carregado: ${r.pedidos_novos} pedidos, ${r.itens_novos} itens, 3 clientes nas ruas R-02 a R-04.` : 'O exemplo fictício já estava carregado.'); } catch (e) { setMsg('Erro: ' + e.message); } }}>Carregar exemplo fictício (3 clientes, 3 pedidos)</button>
                {!confirmaReset
                  ? <button className="btn btn-leve" onClick={() => setConfirmaReset(true)}>Apagar todos os dados de teste</button>
                  : <button className="btn btn-perigo" onClick={resetarDados}>Confirmar: apagar tudo e recomeçar</button>}
                {msg && <div className="mini-cartao">{msg}</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Carregando({ texto, erro }) {
  return (
    <div className="tela-cheia">
      <div className="carregando-teste">
        <img src="icon.svg" alt="" width="64" height="64" />
        <b>VJOY Estoque — versão de teste</b>
        {erro ? <div className="erro-box">{erro}</div> : <span className="muted"><span className="spinner" /> {texto}</span>}
      </div>
    </div>
  );
}

raiz.render(<Carregando texto="Preparando o banco de dados de teste…" />);
iniciarServidorLocal((t) => raiz.render(<Carregando texto={t} />))
  .then(async () => {
    const { default: App } = await import('../App.jsx');
    raiz.render(
      <StrictMode>
        <MemoryRouter>
          <App />
          <PainelTeste />
        </MemoryRouter>
      </StrictMode>,
    );
  })
  .catch((e) => { console.error(e); raiz.render(<Carregando erro={'Não foi possível iniciar a versão de teste: ' + (e?.message || e)} />); });
