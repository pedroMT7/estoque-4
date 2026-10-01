import { useState } from 'react';
import { api, get, post, put } from '../api.js';
import { Carregando, ErroBox, Modal, useCarregar, useToast, useDialog } from '../components/ui.jsx';
import { fmtDataHora } from '../util.js';

export default function Produtos() {
  const toast = useToast();
  const [busca, setBusca] = useState('');
  const { dados, carregando, erro, recarregar } = useCarregar(() => get('/produtos?busca=' + encodeURIComponent(busca)), [busca]);
  const [edit, setEdit] = useState(null);
  const dialog = useDialog();
  const desconhecidos = useCarregar(() => get('/produtos/codigos-desconhecidos'), []);
  const [arq, setArq] = useState(null), [resImp, setResImp] = useState(null), [imp, setImp] = useState(false);
  const [arqCat, setArqCat] = useState(null), [resCat, setResCat] = useState(null), [impCat, setImpCat] = useState(false);
  const importarCatalogo = async () => {
    setImpCat(true); setResCat(null);
    try { const f = new FormData(); f.append('arquivo', arqCat); const r = await api('/produtos/catalogo/importar', { method: 'POST', form: f }); setResCat(r); recarregar(true); }
    catch (e) { toast(e.message, 'ERRO'); } finally { setImpCat(false); }
  };
  const vincular = async (codigo) => { const p = await dialog({ tipo: 'vincular', codigo }); if (p) { toast(`${codigo} vinculado a ${p.codigo}`); desconhecidos.recarregar(true); recarregar(true); } };
  const importar = async () => {
    setImp(true); setResImp(null);
    try { const f = new FormData(); f.append('arquivo', arq); const r = await api('/produtos/codigos/importar', { method: 'POST', form: f }); setResImp(r); recarregar(true); desconhecidos.recarregar(true); }
    catch (e) { toast(e.message, 'ERRO'); } finally { setImp(false); }
  };
  const salvar = async (f) => {
    try {
      if (f.id) await put('/produtos/' + f.id, { codigo_barras: f.codigo_barras, descricao: f.descricao, ativo: f.ativo });
      else await post('/produtos', f);
      toast('Produto salvo'); setEdit(null); recarregar(true);
    } catch (e) { toast(e.message, 'ERRO'); }
  };
  return (
    <div className="pagina">
      <div className="pagina-cabeca"><h1>Produtos</h1><button className="btn btn-primario" onClick={() => setEdit({ codigo: '', descricao: '', unidade: 'PC', ativo: true })}>+ Novo produto</button></div>
      <p className="muted">Produtos são criados automaticamente na importação (linhas PA). O sistema reconhece na bipagem: o <b>Código</b>, o código de barras principal, os códigos de barras vinculados (de outro sistema), o número do item do pedido (ex.: 043212/1/001) e etiquetas que contêm o Código dentro delas.</p>
      <div className="painel form">
        <h3>Atualizar catálogo de produtos</h3>
        <p className="muted pequeno">Envie a planilha de produtos do sistema (ex.: <b>PA.xlsx</b>, com as colunas Código, Descrição e Unid). Cabeçalhos repetidos e linhas de relatório são ignorados. Produtos novos são incluídos e descrições existentes são atualizadas; nada é apagado.</p>
        <div className="linha-botoes">
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setArqCat(e.target.files[0])} />
          <button className="btn btn-primario" disabled={!arqCat || impCat} onClick={importarCatalogo}>{impCat ? 'Atualizando…' : 'Atualizar catálogo'}</button>
        </div>
        {resCat && <div className="mini-cartao">{resCat.total} produtos na planilha · <b>{resCat.novos}</b> novos · <b>{resCat.atualizados}</b> atualizados · {resCat.iguais} sem mudança{resCat.conflitos.length > 0 && <div className="pequeno txt-alerta">Pulados: {resCat.conflitos.slice(0, 10).join(' · ')}</div>}</div>}
      </div>
      <div className="grade-2">
        <div className="painel">
          <h3>Códigos lidos e não reconhecidos</h3>
          <p className="muted pequeno">Etiquetas bipadas no estoque que ainda não estão ligadas a nenhum produto. Vincule uma vez e o código passa a ser reconhecido.</p>
          {desconhecidos.carregando ? <Carregando /> : !desconhecidos.dados?.length ? <div className="vazio">Nenhum código pendente.</div> : (
            <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Código lido</th><th className="num">Leituras</th><th>Última</th><th></th></tr></thead>
              <tbody>{desconhecidos.dados.map((d) => <tr key={d.codigo}><td><b className="codigo-lido">{d.codigo}</b><div className="muted pequeno">{d.operacoes}</div></td><td className="num">{d.leituras}</td><td className="pequeno">{fmtDataHora(d.ultima)}</td><td><button className="btn btn-primario btn-p" onClick={() => vincular(d.codigo)}>Vincular</button></td></tr>)}</tbody></table></div>
          )}
        </div>
        <div className="painel form">
          <h3>Importar lista de códigos de barras</h3>
          <p className="muted pequeno">CSV exportado do outro sistema, com uma coluna <b>Código</b> (o mesmo do arquivo de pedidos) e uma coluna <b>Código de barras</b> (ou EAN/GTIN). Um produto pode ter vários códigos de barras.</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => setArq(e.target.files[0])} />
          <button className="btn btn-primario" disabled={!arq || imp} onClick={importar}>{imp ? 'Importando…' : 'Importar códigos'}</button>
          {resImp && (
            <div className="mini-cartao">
              {resImp.linhas} linhas · <b>{resImp.vinculados}</b> vinculados · {resImp.ja_existiam} já existiam · {resImp.vazias} sem código
              {resImp.produto_nao_encontrado.length > 0 && <div className="pequeno txt-alerta">Produtos não encontrados ({resImp.produto_nao_encontrado.length}): {resImp.produto_nao_encontrado.slice(0, 30).join(', ')}</div>}
              {resImp.conflitos.length > 0 && <div className="pequeno txt-erro">Conflitos: {resImp.conflitos.slice(0, 10).join(' · ')}</div>}
            </div>
          )}
        </div>
      </div>
      <input className="busca" placeholder="Buscar código, código de barras ou descrição (mostra até 300)" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <ErroBox erro={erro} />
      {carregando && !dados ? <Carregando /> : (
        <div className="tabela-rolagem"><table className="tabela"><thead><tr><th>Código</th><th>Código de barras</th><th>Descrição</th><th>Cód. laboratório</th><th>Unid.</th><th className="num">Na empresa</th><th></th></tr></thead>
          <tbody>{dados?.map((p) => <tr key={p.id} className={!p.ativo ? 'muted' : ''}><td><b>{p.codigo}</b></td><td>{p.codigo_barras}{p.codigos_adicionais?.length > 0 && <div className="pequeno muted">+ {p.codigos_adicionais.join(', ')}</div>}</td><td>{p.descricao}</td><td className="pequeno">{p.codigo_laboratorio}</td><td>{p.unidade}</td><td className="num">{p.unidades}</td><td><button className="btn btn-leve btn-p" onClick={() => setEdit(p)}>Editar</button></td></tr>)}</tbody></table></div>
      )}
      {edit && <ProdutoModal p={edit} onSalvar={salvar} onFechar={() => setEdit(null)} />}
    </div>
  );
}
function ProdutoModal({ p, onSalvar, onFechar }) {
  const [f, setF] = useState(p);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <Modal titulo={p.id ? 'Editar ' + p.codigo : 'Novo produto'} onFechar={onFechar}
      rodape={<><button className="btn btn-leve" onClick={onFechar}>Cancelar</button><button className="btn btn-primario" onClick={() => onSalvar(f)}>Salvar</button></>}>
      <div className="form">
        {!p.id && <label>Código<input value={f.codigo} onChange={set('codigo')} /></label>}
        <label>Código de barras (vazio = igual ao código)<input value={f.codigo_barras || ''} onChange={set('codigo_barras')} /></label>
        <label>Descrição<input value={f.descricao} onChange={set('descricao')} /></label>
        {!p.id && <label>Unidade<input value={f.unidade} onChange={set('unidade')} /></label>}
        {p.id && <label className="check-linha"><input type="checkbox" checked={f.ativo} onChange={set('ativo')} /> Ativo</label>}
      </div>
    </Modal>
  );
}
