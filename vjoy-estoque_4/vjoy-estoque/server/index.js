import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrar } from './db.js';
import { garantirAdmin } from './auth.js';
import { ErroNegocio } from './erros.js';
import api from './routes/api.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const segredo = process.env.JWT_SECRET || (() => {
  console.warn('ATENÇÃO: JWT_SECRET não definido — usando segredo temporário (sessões caem a cada reinício).');
  return crypto.randomBytes(32).toString('hex');
})();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });
await app.register(jwt, { secret: segredo });
// aceita POST com JSON vazio (botões de ação sem corpo)
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, body ? JSON.parse(body) : {}); } catch (e) { e.statusCode = 400; done(e); }
});
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ErroNegocio) {
    reply.code(err.status).send({ erro: err.message, codigo: err.codigo, nivel: err.nivel || (err.status === 409 ? 'ALERTA' : 'ERRO'), dados: err.dados });
    return;
  }
  if (err.validation || err.statusCode === 400) { reply.code(400).send({ erro: err.message }); return; }
  if (err.code === '23505') { reply.code(409).send({ erro: 'Registro duplicado: ' + (err.detail || '') }); return; }
  req.log.error(err);
  console.error(err);
  reply.code(500).send({ erro: 'Erro interno no servidor. Tente novamente.' });
});

// Tempo real: toda operação que altera dados avisa todos os aparelhos conectados
let io;
app.addHook('onResponse', async (req, reply) => {
  if (io && req.method !== 'GET' && reply.statusCode < 400 && req.url.startsWith('/api/') && !req.url.startsWith('/api/login')) {
    io.emit('mudou', { url: req.url.replace(/\?.*$/, ''), por: req.user?.nome, em: Date.now() });
  }
});

await app.register(api, { prefix: '/api' });
app.get('/api/saude', async () => ({ ok: true }));

const dist = path.join(raiz, 'web', 'dist');
if (fs.existsSync(dist)) {
  await app.register(fstatic, { root: dist, wildcard: false,
    setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html') || p.endsWith('manifest.webmanifest')) (res.header ? res.header('Cache-Control', 'no-cache') : res.setHeader('Cache-Control', 'no-cache')); } });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ erro: 'Rota não encontrada' });
    return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.readFileSync(path.join(dist, 'index.html')));
  });
}

try {
  await migrar();
  await garantirAdmin();
} catch (e) {
  console.error('\n❌ Não foi possível conectar ao banco de dados.');
  console.error(process.env.DATABASE_URL ? '   Confira se o PostgreSQL está ligado e se DATABASE_URL está correta.' : '   A variável DATABASE_URL não foi definida (no Railway: DATABASE_URL = ${{Postgres.DATABASE_URL}}).');
  console.error('   Detalhe:', e.message, '\n');
  process.exit(1);
}
const port = +(process.env.PORT || 3000);
await app.listen({ port, host: '0.0.0.0' });
io = new Server(app.server, { cors: { origin: true }, path: '/socket.io' });
io.use((socket, next) => {
  try { app.jwt.verify(socket.handshake.auth?.token); next(); } catch { next(new Error('nao autenticado')); }
});
console.log(`VJOY Estoque rodando na porta ${port}`);
