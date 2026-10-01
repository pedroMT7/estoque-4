// Feedback sonoro + vibração (opcional, configurável)
let ctx;
const somLigado = () => { try { return localStorage.getItem('vjoy_som') !== '0'; } catch { return true; } };
export const setSom = (v) => { try { localStorage.setItem('vjoy_som', v ? '1' : '0'); } catch {} };
export const getSom = somLigado;

function tom(freq, dur, when = 0, type = 'square', vol = 0.15) {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, ctx.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + when); o.stop(ctx.currentTime + when + dur + 0.02);
}
export function feedback(nivel) {
  try {
    if (navigator.vibrate) navigator.vibrate(nivel === 'SUCESSO' ? 60 : nivel === 'ALERTA' ? [80, 60, 80] : [250, 80, 250]);
    if (!somLigado()) return;
    if (nivel === 'SUCESSO') { tom(1400, 0.09, 0, 'sine', 0.2); }
    else if (nivel === 'ALERTA') { tom(880, 0.12); tom(660, 0.14, 0.15); }
    else { tom(220, 0.22, 0, 'sawtooth', 0.2); tom(180, 0.3, 0.25, 'sawtooth', 0.2); }
  } catch {}
}
// desbloqueia áudio no iOS no primeiro toque
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch {} }, { once: true });
