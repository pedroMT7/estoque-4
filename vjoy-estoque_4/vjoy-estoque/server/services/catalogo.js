// Catálogo de produtos (planilha "PA" exportada do sistema da empresa: Código | Descrição | Unid | Estoque ...)
// A planilha vem de um relatório paginado: cabeçalhos repetidos, linhas "Empresa", "Filtragem: ..." etc. são ignorados.
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { falha } from '../erros.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const UNIDADES = new Set(['PC', 'UN', 'KIT', 'M', 'KG', 'CX', 'JG', 'PR', 'MT', 'LT', 'RL', 'PCT']);

function linhasParaProdutos(linhas) {
  // acha a coluna de código/descrição pelo primeiro cabeçalho
  let iCod = 0, iDesc = 1;
  const cab = linhas.find((l) => l.some((v) => norm(v) === 'CODIGO'));
  if (cab) {
    iCod = cab.findIndex((v) => norm(v) === 'CODIGO');
    const d = cab.findIndex((v) => norm(v).startsWith('DESCRI'));
    if (d >= 0) iDesc = d;
  }
  const vistos = new Map();
  let ignoradas = 0;
  for (const l of linhas) {
    const cod = String(l[iCod] ?? '').trim().toUpperCase();
    const desc = String(l[iDesc] ?? '').trim();
    if (!cod || !desc || norm(cod) === 'CODIGO' || norm(cod) === 'EMPRESA' || cod.length > 60 || norm(desc).startsWith('DESCRI')
      || norm(cod) === norm(desc) || cod.includes(',') || /^(FILTRAGEM|MATERIAIS|FATURAMENTO|PAGINA|TOTAL)/.test(norm(cod))) { ignoradas++; continue; }
    // unidade: a conversão do relatório às vezes desloca a coluna
    const unidade = l.slice(iDesc + 1, iDesc + 6).map((v) => norm(v)).find((v) => UNIDADES.has(v)) || null;
    if (!vistos.has(cod)) vistos.set(cod, { codigo: cod, descricao: norm(desc), unidade });
  }
  return { produtos: [...vistos.values()], ignoradas };
}

export async function lerCatalogo(buf, nomeArquivo = '') {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const ehXlsx = u8[0] === 0x50 && u8[1] === 0x4b; // arquivo zip (xlsx)
  let linhas = [];
  if (ehXlsx) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(u8); } catch (e) { falha('Não foi possível ler a planilha: ' + e.message); }
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        const v = row.values.slice(1).map((c) => (c && typeof c === 'object' ? (c.text ?? c.result ?? c.richText?.map((t) => t.text).join('') ?? '') : c));
        linhas.push(v);
      });
    }
  } else {
    let texto;
    try { texto = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { texto = new TextDecoder('windows-1252').decode(u8); }
    const primeira = texto.split(/\r?\n/)[0] || '';
    const delimiter = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
    linhas = parse(texto, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true });
  }
  if (!linhas.length) falha(`O arquivo ${nomeArquivo} está vazio.`);
  return linhasParaProdutos(linhas);
}

/** Inclui produtos novos e atualiza descrição/unidade dos existentes. Nunca apaga produto. */
export async function aplicarCatalogo(c, produtos) {
  let novos = 0, atualizados = 0, iguais = 0;
  const conflitos = [];
  const existentes = new Map((await c.query('SELECT id, codigo, descricao, unidade FROM produtos')).rows.map((r) => [r.codigo, r]));
  const barras = new Map((await c.query(`SELECT p.codigo_barras b, p.codigo FROM produtos p UNION ALL SELECT pc.codigo b, p.codigo FROM produto_codigos pc JOIN produtos p ON p.id=pc.produto_id`)).rows.map((r) => [r.b, r.codigo]));
  for (const p of produtos) {
    const ex = existentes.get(p.codigo);
    if (ex) {
      if (ex.descricao !== p.descricao || (p.unidade && ex.unidade !== p.unidade)) {
        await c.query('UPDATE produtos SET descricao=$2, unidade=COALESCE($3, unidade) WHERE id=$1', [ex.id, p.descricao, p.unidade]);
        atualizados++;
      } else iguais++;
      continue;
    }
    const usado = barras.get(p.codigo);
    if (usado && usado !== p.codigo) { if (conflitos.length < 100) conflitos.push(`${p.codigo} já é código de barras de ${usado}`); continue; }
    await c.query(`INSERT INTO produtos(codigo,codigo_barras,descricao,unidade) VALUES ($1,$1,$2,$3)`, [p.codigo, p.descricao, p.unidade]);
    barras.set(p.codigo, p.codigo);
    novos++;
  }
  return { total: produtos.length, novos, atualizados, iguais, conflitos };
}
