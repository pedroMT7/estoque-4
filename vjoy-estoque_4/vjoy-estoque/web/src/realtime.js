import { io } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';
import { token } from './api.js';

let socket;
const ouvintes = new Set();
let desligarLocal = null;
export function conectar() {
  if (globalThis.__vjoyLocal) { // versão de teste: eventos vêm do servidor local no navegador
    desligarLocal?.();
    desligarLocal = globalThis.__vjoyLocal.aoMudar((e) => ouvintes.forEach((f) => f(e)));
    return null;
  }
  if (socket) socket.disconnect();
  socket = io({ path: '/socket.io', auth: { token: token() }, transports: ['websocket', 'polling'] });
  socket.on('mudou', (e) => ouvintes.forEach((f) => f(e)));
  socket.on('connect', () => ouvintes.forEach((f) => f({ url: '*reconectou' })));
  return socket;
}
export const desconectar = () => { desligarLocal?.(); desligarLocal = null; socket?.disconnect(); socket = null; };
export function useOnline() {
  const [on, setOn] = useState(!!globalThis.__vjoyLocal || !!socket?.connected);
  useEffect(() => {
    if (globalThis.__vjoyLocal || !socket) return;
    const a = () => setOn(true), b = () => setOn(false);
    socket.on('connect', a); socket.on('disconnect', b); setOn(socket.connected);
    return () => { socket?.off('connect', a); socket?.off('disconnect', b); };
  }, []);
  return on;
}
/** Chama fn (com debounce) sempre que outro aparelho alterar dados. filtro: regex opcional sobre a URL */
export function useAtualizacao(fn, filtro) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    let t;
    const h = (e) => { if (filtro && !filtro.test(e.url) && e.url !== '*reconectou') return; clearTimeout(t); t = setTimeout(() => ref.current(e), 300); };
    ouvintes.add(h);
    return () => { ouvintes.delete(h); clearTimeout(t); };
  }, [filtro]);
}
