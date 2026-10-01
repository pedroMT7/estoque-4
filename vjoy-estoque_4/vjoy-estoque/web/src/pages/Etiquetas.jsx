import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { get } from '../api.js';
import { useCarregar } from '../components/ui.jsx';

function Barras({ valor, altura = 70 }) {
  const ref = useRef();
  useEffect(() => { try { JsBarcode(ref.current, valor, { format: 'CODE128', height: altura, displayValue: true, fontSize: 16, margin: 4 }); } catch {} }, [valor, altura]);
  return <svg ref={ref} />;
}

export default function Etiquetas() {
  const [tipo, setTipo] = useState('clientes');
  const [sel, setSel] = useState(new Set());
  const [busca, setBusca] = useState('');
  const clientes = useCarregar(() => get('/clientes'), []);
  const ruas = useCarregar(() => get('/localizacoes'), []);
  const produtos = useCarregar(() => get('/produtos?busca=' + encodeURIComponent(busca)), [busca]);
  const lista = tipo === 'clientes' ? (clientes.dados || []).filter((c) => !busca || c.nome.includes(busca.toUpperCase())) : tipo === 'ruas' ? ruas.dados || [] : produtos.dados || [];
  const alternar = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const escolhidos = lista.filter((x) => sel.has(x.id));
  return (
    <div className="pagina">
      <div className="nao-imprimir">
        <div className="pagina-cabeca"><h1>Etiquetas</h1><button className="btn btn-primario" disabled={!escolhidos.length} onClick={() => window.print()}>🖨️ Imprimir {escolhidos.length}</button></div>
        <div className="abas">{[['clientes', 'Clientes'], ['ruas', 'Ruas'], ['produtos', 'Produtos']].map(([k, t]) => <button key={k} className={tipo === k ? 'ativa' : ''} onClick={() => { setTipo(k); setSel(new Set()); }}>{t}</button>)}</div>
        <div className="filtros">
          {tipo !== 'ruas' && <input className="busca" placeholder="Buscar" value={busca} onChange={(e) => setBusca(e.target.value)} />}
          <button className="btn btn-leve" onClick={() => setSel(new Set(lista.map((x) => x.id)))}>Selecionar todos ({lista.length})</button>
          <button className="btn btn-leve" onClick={() => setSel(new Set())}>Limpar</button>
        </div>
        <div className="lista-sel">
          {lista.map((x) => <label key={x.id} className="check-linha"><input type="checkbox" checked={sel.has(x.id)} onChange={() => alternar(x.id)} /> {x.nome || x.codigo} {x.rua && <b>({x.rua})</b>} {tipo === 'produtos' && <span className="muted">{x.descricao}</span>}</label>)}
        </div>
        <h3 className="sec">Pré-visualização</h3>
      </div>
      <div className="etiquetas">
        {escolhidos.map((x) => (
          <div key={x.id} className="etiqueta">
            {tipo === 'clientes' && <><div className="et-nome">{x.nome}</div><div className="et-rua">📍 RUA {x.rua || '—'}</div><Barras valor={x.codigo_barras} /></>}
            {tipo === 'ruas' && <><div className="et-rua et-rua-g">RUA {x.codigo}</div><Barras valor={x.codigo} /></>}
            {tipo === 'produtos' && <><div className="et-nome">{x.descricao}</div><Barras valor={x.codigo_barras} altura={60} /></>}
          </div>
        ))}
      </div>
    </div>
  );
}
