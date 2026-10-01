import bcrypt from 'bcryptjs';
import { q } from './db.js';
import { falha } from './erros.js';

export const PERFIS = ['ADMIN', 'ESTOQUE', 'EXPEDICAO', 'CONFERENCIA', 'GESTAO'];

// Permissão -> perfis que podem (ADMIN sempre pode tudo)
export const PERMISSOES = {
  entrada: ['ESTOQUE'],
  separacao: ['EXPEDICAO'],
  conferencia: ['CONFERENCIA'],
  expedicao: ['CONFERENCIA'],
  saida: ['ESTOQUE', 'EXPEDICAO', 'CONFERENCIA'], // saída direta por bipagem
  consulta: ['ESTOQUE', 'EXPEDICAO', 'CONFERENCIA', 'GESTAO'],
  gestao: ['GESTAO'],        // dashboard, relatórios, sobras, vínculos
  ajuste: ['GESTAO'],
  importar: ['GESTAO'],
  cadastros: ['GESTAO'],     // clientes, ruas, produtos
  autorizar: ['GESTAO'],     // autorizar divergências
  usuarios: [],              // só ADMIN
};

export const pode = (perfil, perm) => perfil === 'ADMIN' || (PERMISSOES[perm] || []).includes(perfil);

export function exigir(perm) {
  return async (req) => {
    if (!pode(req.user.perfil, perm)) falha('Seu perfil não tem permissão para esta operação.', { status: 403, codigo: 'SEM_PERMISSAO' });
  };
}

export function exigirAlgum(perms) {
  return async (req) => {
    if (!perms.some((p) => pode(req.user.perfil, p))) falha('Seu perfil não tem permissão para esta operação.', { status: 403, codigo: 'SEM_PERMISSAO' });
  };
}

export const hashSenha = (s) => bcrypt.hash(s, 10);

/** Valida login+senha de um supervisor que autoriza uma operação. Retorna o id. */
export async function validarAutorizacao(aut) {
  if (!aut?.login || !aut?.senha) falha('Informe login e senha de um usuário autorizado.', { status: 403, codigo: 'AUTORIZACAO_NECESSARIA' });
  const { rows } = await q('SELECT * FROM usuarios WHERE login=$1 AND ativo', [aut.login.trim().toLowerCase()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(aut.senha, u.senha_hash))) falha('Autorização inválida: login ou senha incorretos.', { status: 403, codigo: 'AUTORIZACAO_INVALIDA' });
  if (!pode(u.perfil, 'autorizar')) falha(`${u.nome} não tem perfil para autorizar (precisa ser Administrador ou Gestão).`, { status: 403, codigo: 'AUTORIZACAO_INVALIDA' });
  return u.id;
}

export async function autenticar(login, senha) {
  const { rows } = await q('SELECT * FROM usuarios WHERE login=$1', [String(login || '').trim().toLowerCase()]);
  const u = rows[0];
  if (!u || !u.ativo || !(await bcrypt.compare(String(senha || ''), u.senha_hash))) return null;
  return u;
}

export async function garantirAdmin() {
  const { rows } = await q('SELECT count(*)::int n FROM usuarios');
  if (rows[0].n > 0) return;
  const login = (process.env.ADMIN_LOGIN || 'admin').toLowerCase();
  const senha = process.env.ADMIN_SENHA || 'admin123';
  await q('INSERT INTO usuarios(nome,login,senha_hash,perfil) VALUES ($1,$2,$3,$4)', ['Administrador', login, await hashSenha(senha), 'ADMIN']);
  console.log(`Usuário administrador criado: ${login}`);
}

export async function log(usuario_id, acao, entidade, entidade_id, detalhes, client) {
  await (client || { query: q }).query('INSERT INTO logs(usuario_id,acao,entidade,entidade_id,detalhes) VALUES ($1,$2,$3,$4,$5)', [usuario_id, acao, entidade, entidade_id, detalhes ? JSON.stringify(detalhes) : null]);
}
