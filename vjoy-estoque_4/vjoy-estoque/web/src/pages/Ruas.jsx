import { useState } from 'react';
import { get, post } from '../api.js';
import { Carregando, ErroBox, useCarregar, useToast } from '../components/ui.jsx';

export default function Ruas() {
  const toast = useToast();
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/localizacoes'), []);
  const [codigo, setCodigo] = useState(''), [descricao, setDescricao] = useState('');
  const [lote, setLote] = useState({ de: 1, ate: 10, prefixo: 'R-' });
  const criar = async (cod, desc) => post('/localizacoes', { codigo: cod, descricao: desc });
  const salvar = async (e) => { e.preventDefault(); try { await criar(codigo, descricao); setCodigo(''); setDescricao(''); recarregar(true); toast('Rua criada'); } catch (e) { toast(e.message, 'ERRO'); } };
  const criarLote = async () => {
    let n = 0;
    for (let i = +lote.de; i <= +lote.ate; i++) { try { await criar(lote.prefixo + String(i).padStart(2, '0')); n++; } catch {} }
    toast(`${n} rua(s) criadas`); recarregar(true);
  };
  return (
    <div className="pagina">
      <h1>Ruas (localizações)</h1>
      <div className="grade-2">
        <form className="painel form" onSubmit={salvar}>
          <h3>Nova rua</h3>
          <label>Código<input value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="R-05" /></label>
          <label>Descrição (opcional)<input value={descricao} onChange={(e) => setDescricao(e.target.value)} /></label>
          <button className="btn btn-primario" disabled={!codigo}>Criar</button>
        </form>
        <div className="painel form">
          <h3>Criar várias</h3>
          <div className="linha-botoes">
            <label>Prefixo<input value={lote.prefixo} onChange={(e) => setLote({ ...lote, prefixo: e.target.value })} style={{ width: 70 }} /></label>
            <label>De<input type="number" value={lote.de} onChange={(e) => setLote({ ...lote, de: e.target.value })} style={{ width: 70 }} /></label>
            <label>Até<input type="number" value={lote.ate} onChange={(e) => setLote({ ...lote, ate: e.target.value })} style={{ width: 70 }} /></label>
          </div>
          <button type="button" className="btn btn-leve" onClick={criarLote}>Criar {lote.prefixo}{String(lote.de).padStart(2, '0')} a {lote.prefixo}{String(lote.ate).padStart(2, '0')}</button>
        </div>
      </div>
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Rua</th><th>Descrição</th><th className="num">Clientes</th><th className="num">Unidades</th></tr></thead>
          <tbody>{dados?.map((r) => <tr key={r.id}><td><b>{r.codigo}</b></td><td>{r.descricao}</td><td className="num">{r.clientes}</td><td className="num">{r.unidades}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
