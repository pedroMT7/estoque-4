// Leitor de código de barras físico — tudo que não é câmera.
// 1) Modo teclado (HID, o padrão de quase todos os leitores USB/Bluetooth): o leitor "digita" o código.
//    Detectamos a rajada de teclas (muito mais rápida que uma pessoa) e enviamos sozinho, com ou sem Enter.
// 2) Modo serial / COM (alguns leitores USB vêm assim): no Chrome/Edge do computador lemos direto pela Web Serial.

export const RAJADA_MS = 45;   // intervalo médio máximo entre teclas para considerar "leitor"
export const FIM_MS = 120;     // silêncio depois da rajada = fim do código (leitor sem Enter)
export const MIN_CHARS = 3;

export const preferencia = (k, padrao) => { try { const v = localStorage.getItem('vjoy_leitor_' + k); return v === null ? padrao : v === '1'; } catch { return padrao; } };
export const salvarPreferencia = (k, v) => { try { localStorage.setItem('vjoy_leitor_' + k, v ? '1' : '0'); } catch {} };

/** teclas que alguns leitores mandam no fim do código no lugar do Enter */
export const ehFimDeLeitura = (e) => e.key === 'Enter' || e.key === 'Tab' || (e.ctrlKey && (e.key === 'j' || e.key === 'J' || e.key === 'm' || e.key === 'M'));
export const ehCaractere = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
export const veioDeLeitor = (tempos) => tempos.length >= MIN_CHARS && (tempos[tempos.length - 1] - tempos[0]) / (tempos.length - 1) <= RAJADA_MS;

/** Há algum modal aberto? Nele, quem trata a leitura é o próprio modal (confirmar / trocar / ignorar). */
export const modalAberto = () => !!document.querySelector('.modal-fundo');
/** Entrega uma leitura vinda de fora do teclado (serial) para o modal aberto */
export const entregarAoModal = (codigo) => window.dispatchEvent(new CustomEvent('vjoy-leitura', { detail: codigo }));

// ---------------------------------------------------------------- Web Serial (modo COM)
const serial = { porta: null, ouvinte: null, estado: 'desligado', avisos: new Set() };
const mudouEstado = (s) => { serial.estado = s; serial.avisos.forEach((f) => f(s)); };
export const serialDisponivel = () => typeof navigator !== 'undefined' && 'serial' in navigator;
export const estadoSerial = () => serial.estado;
export const aoMudarSerial = (f) => { serial.avisos.add(f); return () => serial.avisos.delete(f); };
export const definirOuvinteSerial = (f) => { serial.ouvinte = f; };

async function abrir(porta) {
  await porta.open({ baudRate: 9600 }).catch((e) => { if (!/already open/i.test(e.message)) throw e; });
  serial.porta = porta; mudouEstado('conectado'); salvarPreferencia('serial', true);
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    while (porta.readable && serial.porta === porta) {
      const reader = porta.readable.getReader(); serial.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const partes = buf.split(/[\r\n]+/);
          buf = partes.pop();
          for (const p of partes) entregar(p);
          // leitor sem terminador: entrega depois de um instante de silêncio
          clearTimeout(serial.t); if (buf) serial.t = setTimeout(() => { const b = buf; buf = ''; entregar(b); }, 150);
        }
      } catch { /* cabo desconectado */ } finally { reader.releaseLock(); }
    }
    if (serial.porta === porta) { serial.porta = null; mudouEstado('desligado'); }
  })();
}
function entregar(bruto) {
  const c = String(bruto).replace(/[\x00-\x1f]/g, '').trim();
  if (!c) return;
  if (modalAberto()) entregarAoModal(c); else serial.ouvinte?.(c);
}
export async function conectarSerial() {
  if (!serialDisponivel()) throw new Error('Este navegador não tem acesso a leitor serial. Use Chrome ou Edge no computador.');
  const porta = await navigator.serial.requestPort();
  await abrir(porta);
}
export async function reconectarSerial() {
  if (!serialDisponivel() || serial.porta || !preferencia('serial', false)) return;
  const [porta] = await navigator.serial.getPorts().catch(() => []);
  if (porta) await abrir(porta).catch(() => mudouEstado('desligado'));
}
export async function desconectarSerial() {
  salvarPreferencia('serial', false);
  const p = serial.porta; serial.porta = null;
  try { await serial.reader?.cancel(); } catch {}
  try { await p?.close(); } catch {}
  mudouEstado('desligado');
}
if (serialDisponivel()) navigator.serial.addEventListener?.('disconnect', () => { serial.porta = null; mudouEstado('desligado'); });

/** campo onde a pessoa digita texto (caixinhas de marcar e botões NÃO contam: o leitor continua funcionando) */
const NAO_TEXTO = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);
export const ehCampoTexto = (el) => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !NAO_TEXTO.has((el.type || 'text').toLowerCase())));
