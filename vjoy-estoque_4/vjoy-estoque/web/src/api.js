// Cliente HTTP da API
export class ApiError extends Error {
  constructor(msg, status, body) { super(msg); this.status = status; this.codigo = body?.codigo; this.dados = body?.dados; this.nivel = body?.nivel; this.body = body; }
}
const lerToken = () => { try { return localStorage.getItem('vjoy_token'); } catch { return null; } };
export const salvarToken = (t) => { try { t ? localStorage.setItem('vjoy_token', t) : localStorage.removeItem('vjoy_token'); } catch {} };
export const token = () => lerToken();
export const semConexao = (e) => e?.codigo === 'SEM_CONEXAO';

let aoExpirar = () => {};
export const definirAoExpirar = (fn) => { aoExpirar = fn; };

export async function api(url, { method = 'GET', body, form } = {}) {
  const headers = {};
  const t = lerToken();
  if (t) headers.authorization = 'Bearer ' + t;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch('/api' + url, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique o Wi-Fi.', 0, { codigo: 'SEM_CONEXAO' });
  }
  const j = await r.json().catch(() => ({}));
  // servidor reiniciando / fora do ar (resposta do proxy, não da aplicação): trata como falta de conexão
  if ([502, 503, 504].includes(r.status) && !j.erro) throw new ApiError('Servidor fora do ar no momento. Tente de novo em instantes.', r.status, { codigo: 'SEM_CONEXAO' });
  if (r.status === 401 && url !== '/login') { aoExpirar(); }
  if (!r.ok) throw new ApiError(j.erro || `Erro ${r.status}`, r.status, j);
  return j;
}
export const get = (u) => api(u);
export const post = (u, body = {}) => api(u, { method: 'POST', body });
export const put = (u, body = {}) => api(u, { method: 'PUT', body });

export const qs = (o) => {
  const p = new URLSearchParams();
  Object.entries(o || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
};

/** Baixa um arquivo da API (com login) — ex.: romaneio em PDF */
export async function baixarArquivo(url, nome) {
  const t = lerToken();
  const r = await fetch('/api' + url, { headers: t ? { authorization: 'Bearer ' + t } : {} });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new ApiError(j.erro || `Erro ${r.status}`, r.status, j); }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
