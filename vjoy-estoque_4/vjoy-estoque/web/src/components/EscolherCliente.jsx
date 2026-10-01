import { useEffect, useMemo, useRef, useState } from 'react';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const lerRecentes = () => { try { return JSON.parse(localStorage.getItem('vjoy_clientes_recentes') || '[]'); } catch { return []; } };
export const salvarRecente = (id) => { try { localStorage.setItem('vjoy_clientes_recentes', JSON.stringify([id, ...lerRecentes().filter((x) => x !== id)].slice(0, 6))); } catch {} };
export const ruaTexto = (c) => (c?.rua ? `RUA ${c.rua}` : 'Sem rua definida');

/** Passo 1: escolher o cliente pelo NOME (sem etiqueta). Também aceita o código, se alguém bipar. */
export function EscolherCliente({ clientes, onEscolher, titulo = 'CLIENTE', permitirNovo = true }) {
  const [texto, setTexto] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const t = norm(texto);
  const lista = useMemo(() => {
    if (!t) { const rec = lerRecentes(); return rec.map((id) => clientes.find((c) => c.id === id)).filter(Boolean); }
    return clientes.filter((c) => norm(c.nome).includes(t) || c.codigo === t || c.codigo_barras === t || (c.aliases || []).some((a) => a.includes(t))).slice(0, 8);
  }, [t, clientes]);
  const exato = clientes.find((c) => norm(c.nome) === t || c.codigo_barras === t || c.codigo === t);
  const escolher = (c) => { setTexto(''); onEscolher(c); };
  return (
    <div className="scanner scanner-grande">
      <div className="scanner-titulo">{titulo}</div>
      <form className="scanner-linha" onSubmit={(e) => { e.preventDefault(); if (exato) escolher(exato); else if (lista.length === 1) escolher(lista[0]); }}>
        <input ref={ref} id="cliente-nome" className="scanner-input" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Digite o nome do cliente…" autoComplete="off" autoCapitalize="characters" aria-label="Nome do cliente" />
      </form>
      {!t && lista.length > 0 && <div className="muted pequeno" style={{ marginTop: 8 }}>Usados recentemente</div>}
      <div className="lista-clientes">
        {lista.map((c) => (
          <button key={c.id} type="button" className="item-cliente" onClick={() => escolher(c)}>
            <b>{c.nome}</b><span className="muted pequeno">{c.rua ? `📍 ${c.rua}` : 'sem rua'} · {c.codigo}</span>
          </button>
        ))}
        {permitirNovo && t.length >= 3 && !exato && (
          <button type="button" className="item-cliente novo" onClick={() => escolher({ id: null, nome: t, novo: true })}>
            <b>➕ Usar novo cliente: {t}</b><span className="muted pequeno">Será cadastrado na primeira entrada</span>
          </button>
        )}
        {t && !lista.length && t.length < 3 && <div className="muted pequeno">Continue digitando…</div>}
      </div>
    </div>
  );
}

