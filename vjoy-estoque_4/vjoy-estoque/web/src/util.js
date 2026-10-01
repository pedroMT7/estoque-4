export const fmtData = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');
export const fmtDataHora = (d) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDia = (s) => (s ? s.split('-').reverse().join('/') : '—');
export const hojeISO = () => new Date().toLocaleDateString('sv-SE');
export const STATUS = {
  AGUARDANDO: ['Aguardando produção', 'cinza'],
  RECEBENDO: ['Recebendo', 'azul'],
  PRONTO: ['Pronto p/ separar', 'verde'],
  EM_SEPARACAO: ['Em separação', 'roxo'],
  NA_DOCA: ['Na doca', 'laranja'],
  EM_CONFERENCIA: ['Em conferência', 'laranja'],
  CONFERIDO: ['Conferido', 'verde'],
  EXPEDIDO_PARCIAL: ['Expedido parcial', 'amarelo'],
  EXPEDIDO: ['Expedido', 'cinza'],
  CANCELADO: ['Cancelado', 'vermelho'],
};
export const MOV = {
  ENTRADA: 'Entrada', SEPARACAO: 'Separação', ESTORNO_SEPARACAO: 'Estorno separação', DOCA: 'Enviado à doca', CONFERENCIA: 'Conferência',
  EXPEDICAO: 'Expedição', AJUSTE: 'Ajuste', VINCULO: 'Vínculo de sobra', TRANSFERENCIA: 'Transferência de rua',
};
export const PERFIS = { ADMIN: 'Administrador', ESTOQUE: 'Estoque', EXPEDICAO: 'Expedição', CONFERENCIA: 'Conferência', GESTAO: 'Gestão' };
export function baixarCSV(nome, linhas, colunas) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = colunas || Object.keys(linhas[0] || {}).map((k) => [k, k]);
  const txt = [cols.map((c) => esc(c[1])).join(';'), ...linhas.map((l) => cols.map((c) => esc(typeof c[2] === 'function' ? c[2](l) : l[c[0]])).join(';'))].join('\r\n');
  const blob = new Blob(['﻿' + txt], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
