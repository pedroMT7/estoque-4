// Leitura de código de barras: leitor físico (USB/Bluetooth = teclado + Enter) e câmera do aparelho.
// A câmera fica aberta em modo contínuo: lê → valida → mostra resultado → volta a ler sozinha.
import { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { preferencia, salvarPreferencia, ehFimDeLeitura, ehCaractere, veioDeLeitor, modalAberto, FIM_MS, RAJADA_MS, serialDisponivel, ehCampoTexto, estadoSerial, aoMudarSerial, definirOuvinteSerial, conectarSerial, reconectarSerial, desconectarSerial } from '../leitor.js';

// Só formatos lineares usados em etiquetas de produto: menos formatos = leitura mais rápida e menos leitura errada
const FORMATOS_NATIVOS = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a'];
function criarLeitorZXing() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 40, delayBetweenScanSuccess: 40 });
}

/** Lê o código a partir de uma FOTO (quando o navegador não libera a câmera ao vivo) */
async function lerFoto(arquivo) {
  const url = URL.createObjectURL(arquivo);
  try {
    if ('BarcodeDetector' in window) {
      try {
        const bmp = await createImageBitmap(arquivo);
        const r = await new window.BarcodeDetector().detect(bmp);
        if (r.length) return r[0].rawValue;
      } catch {}
    }
    const res = await criarLeitorZXing().decodeFromImageUrl(url);
    return res.getText();
  } finally { URL.revokeObjectURL(url); }
}

const ehToque = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export default function Scanner({ titulo = 'BIPAR CÓDIGO', onLeitura, desabilitado, manterFoco = true, placeholder = 'Aguardando leitura…', grande = true }) {
  const [valor, setValor] = useState('');
  const valorRef = useRef(''); valorRef.current = valor;
  const [camera, setCamera] = useState(false);
  const [digitar, setDigitar] = useState(!ehToque());
  const [pronto, setPronto] = useState(true);
  const [opcoes, setOpcoes] = useState(false);
  const [teste, setTeste] = useState(false);
  const [semEnter, setSemEnter] = useState(() => preferencia('sem_enter', true));
  const [serialEst, setSerialEst] = useState(estadoSerial());
  const [ultima, setUltima] = useState(null);
  const inputRef = useRef(null);
  const tempos = useRef([]); const timer = useRef(null);
  const semEnterRef = useRef(semEnter); semEnterRef.current = semEnter;

  // leituras em fila: o leitor físico pode bipar a próxima peça antes de a anterior terminar — nenhuma se perde
  const onLeituraRef = useRef(onLeitura); onLeituraRef.current = onLeitura;
  const fila = useRef([]); const rodando = useRef(false);
  const processar = useCallback((codigo) => {
    const c = String(codigo || '').replace(/[\x00-\x1f]/g, '').trim();
    if (!c) return Promise.resolve(null);
    setUltima({ c, em: Date.now() });
    return new Promise((resolve) => {
      fila.current.push({ c, resolve });
      if (rodando.current) return;
      rodando.current = true;
      (async () => {
        while (fila.current.length) {
          const x = fila.current.shift();
          try { x.resolve(await onLeituraRef.current(x.c)); } catch (e) { x.resolve({ nivel: 'ERRO', titulo: e.message }); }
        }
        rodando.current = false;
      })();
    });
  }, []);

  const focar = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);
  const enviar = useCallback(async (e) => {
    e?.preventDefault?.();
    clearTimeout(timer.current); tempos.current = [];
    const v = valorRef.current;
    setValor(''); valorRef.current = '';
    focar();
    await processar(v);
  }, [processar, focar]);

  // mantém o foco no campo para o leitor físico funcionar sem tocar na tela + mostra se está pronto
  useEffect(() => {
    if (!manterFoco || camera || desabilitado) return;
    const t = setInterval(() => {
      const a = document.activeElement;
      const outroCampo = a && a !== inputRef.current && (ehCampoTexto(a) || a.tagName === 'SELECT');
      if (!outroCampo && !modalAberto()) focar();
      setPronto(document.hasFocus() && (document.activeElement === inputRef.current || modalAberto()));
    }, 500);
    focar();
    return () => clearInterval(t);
  }, [manterFoco, camera, desabilitado, focar]);

  // leitura que chega com o foco FORA do campo (num botão, no fundo da página): captura a rajada do leitor mesmo assim
  useEffect(() => {
    if (camera || desabilitado) return;
    let buf = '', ts = [], t = null;
    const fim = () => { const b = buf, ok = veioDeLeitor(ts); buf = ''; ts = []; if (b && ok) processar(b); };
    const h = (e) => {
      if (modalAberto()) return; // o modal trata (confirma / troca / ignora)
      const alvo = e.target;
      if (alvo === inputRef.current || ehCampoTexto(alvo) || alvo?.tagName === 'SELECT') return;
      if (ehFimDeLeitura(e)) { if (buf) { e.preventDefault(); e.stopPropagation(); clearTimeout(t); fim(); } return; }
      if (!ehCaractere(e)) return;
      const agora = performance.now();
      if (ts.length && agora - ts[ts.length - 1] > 300) { buf = ''; ts = []; }
      buf += e.key; ts.push(agora);
      clearTimeout(t); if (semEnterRef.current) t = setTimeout(fim, FIM_MS);
    };
    window.addEventListener('keydown', h, true);
    return () => { window.removeEventListener('keydown', h, true); clearTimeout(t); };
  }, [camera, desabilitado, processar]);

  // leitor no modo serial (COM): reconecta sozinho se já foi autorizado antes
  useEffect(() => {
    definirOuvinteSerial((c) => processar(c));
    const des = aoMudarSerial(setSerialEst);
    reconectarSerial();
    return () => { des(); definirOuvinteSerial(null); };
  }, [processar]);

  const aoTeclar = (e) => {
    if (ehFimDeLeitura(e)) { if (e.key !== 'Enter' || e.ctrlKey) { e.preventDefault(); if (valorRef.current) enviar(); } return; }
    if (!ehCaractere(e)) return;
    const agora = performance.now();
    if (tempos.current.length && agora - tempos.current[tempos.current.length - 1] > 300) tempos.current = [];
    tempos.current.push(agora);
    // leitor configurado SEM Enter no final: quando a rajada para, envia sozinho
    clearTimeout(timer.current);
    if (semEnterRef.current) timer.current = setTimeout(() => { if (valorRef.current && veioDeLeitor(tempos.current)) enviar(); }, FIM_MS);
  };

  const recente = ultima && Date.now() - ultima.em < 4000;
  return (
    <div className={'scanner' + (grande ? ' scanner-grande' : '')}>
      <div className="scanner-titulo">{titulo}</div>
      <button type="button" className={'leitor-status ' + (pronto ? 'pronto' : 'parado')} onClick={() => { window.focus(); focar(); }}>
        {pronto ? (recente ? <>✓ Lido: <b>{ultima.c}</b></> : '🟢 Leitor pronto — pode bipar') : '🔴 Leitor parado — toque/clique aqui para ativar'}
        {serialEst === 'conectado' && <span className="pequeno"> · 🔌 serial</span>}
      </button>
      <form onSubmit={enviar} className="scanner-linha">
        <input
          ref={inputRef}
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={aoTeclar}
          placeholder={placeholder}
          inputMode={digitar ? 'text' : 'none'}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          disabled={desabilitado}
          className="scanner-input"
          aria-label={titulo}
        />
        {valor && <button className="btn btn-primario" type="submit" disabled={desabilitado}>OK</button>}
      </form>
      <div className="scanner-botoes">
        <button type="button" className="btn btn-camera" onClick={() => setCamera(true)} disabled={desabilitado}>
          <span aria-hidden>📷</span> CÂMERA
        </button>
        <button type="button" className="btn btn-leve" onClick={() => { setDigitar((d) => !d); setTimeout(focar, 50); }} title="Digitar o código manualmente">
          ⌨️ {digitar ? 'Teclado ligado' : 'Digitar'}
        </button>
      </div>
      <button type="button" className="link-leitor" onClick={() => setOpcoes((o) => !o)}>🔧 Leitor de código de barras: opções e teste {opcoes ? '▲' : '▼'}</button>
      {opcoes && (
        <div className="leitor-opcoes">
          <button type="button" className="btn btn-primario btn-bloco" onClick={() => setTeste(true)}>🧪 Testar meu leitor</button>
          <label className="check-linha"><input type="checkbox" checked={semEnter} onChange={(e) => { setSemEnter(e.target.checked); salvarPreferencia('sem_enter', e.target.checked); focar(); }} />
            Enviar sozinho quando o leitor não manda Enter</label>
          {serialDisponivel() && (serialEst === 'conectado'
            ? <button type="button" className="btn btn-leve btn-bloco" onClick={desconectarSerial}>🔌 Desconectar leitor serial (COM)</button>
            : <button type="button" className="btn btn-leve btn-bloco" onClick={() => conectarSerial().catch((e) => e.name !== 'NotFoundError' && alert(e.message))}>🔌 Conectar leitor USB no modo serial (COM)</button>)}
          <div className="muted pequeno">Leitor USB/Bluetooth comum funciona como teclado: é só bipar com a bolinha verde acesa. Use "serial" só se o teste não receber nada e o leitor estiver configurado como porta COM.</div>
        </div>
      )}
      {teste && <TesteLeitor onFechar={() => { setTeste(false); setTimeout(focar, 50); }} />}
      {camera && <CameraLeitor titulo={titulo} onFechar={() => setCamera(false)} onCodigo={processar} />}
    </div>
  );
}

/** Mostra exatamente o que o leitor envia e diz o que fazer */
function TesteLeitor({ onFechar }) {
  const [teclas, setTeclas] = useState([]);
  const [serial, setSerial] = useState([]);
  useEffect(() => {
    let ant = 0;
    const h = (e) => {
      if (e.key === 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      const agora = performance.now();
      const nome = e.key === 'Enter' ? '⏎ Enter' : e.key === 'Tab' ? '⇥ Tab' : e.ctrlKey ? 'Ctrl+' + e.key : e.key.length === 1 ? e.key : null;
      if (!nome) return;
      setTeclas((t) => [...t.slice(-80), { nome, ms: ant ? Math.round(agora - ant) : 0 }]);
      ant = agora;
    };
    const s = (e) => setSerial((x) => [...x, e.detail]);
    window.addEventListener('keydown', h, true);
    window.addEventListener('vjoy-leitura', s);
    return () => { window.removeEventListener('keydown', h, true); window.removeEventListener('vjoy-leitura', s); };
  }, []);
  const chars = teclas.filter((t) => t.nome.length === 1);
  const fim = teclas.find((t) => t.nome.length > 1);
  const media = chars.length > 1 ? Math.round(chars.slice(1).reduce((n, t) => n + t.ms, 0) / (chars.length - 1)) : null;
  let veredito;
  if (serial.length) veredito = <>✅ Leitor serial funcionando: recebido <b>{serial.at(-1)}</b>.</>;
  else if (!teclas.length) veredito = <>Bipe qualquer etiqueta agora. Se nada aparecer aqui: o leitor não está no modo <b>teclado (HID)</b> ou não está pareado/conectado. Leitores Bluetooth: pareie de novo nas configurações do celular/PC. No PC, se o leitor for porta COM, use "Conectar leitor no modo serial".</>;
  else if (media !== null && media > RAJADA_MS * 2) veredito = <>⚠️ As teclas chegaram devagar ({media} ms entre elas) — parece digitação de pessoa. Se foi o leitor, ele está lento; o Enter no final ainda funciona.</>;
  else if (fim) veredito = <>✅ Leitor funcionando: lê <b>{chars.map((t) => t.nome).join('')}</b> e termina com <b>{fim.nome}</b>. Feche o teste e bipe na tela.</>;
  else veredito = <>✅ Leitor funcionando, mas <b>não manda Enter</b> no final. Deixe ligada a opção "Enviar sozinho quando o leitor não manda Enter" (já vem ligada).</>;
  return (
    <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && onFechar()}>
      <div className="modal" role="dialog" aria-label="Testar leitor">
        <div className="modal-cabeca"><h3>🧪 Teste do leitor</h3><button className="btn-x" onClick={onFechar} aria-label="Fechar">✕</button></div>
        <div className="modal-corpo">
          <div className="confirm-msg">{veredito}</div>
          <div className="teste-teclas">{teclas.length ? teclas.map((t, i) => <span key={i} className={t.nome.length > 1 ? 'fim' : ''}>{t.nome}<small>{t.ms ? t.ms + 'ms' : ''}</small></span>) : <span className="muted">aguardando…</span>}</div>
          <p className="muted pequeno">Nada é registrado durante o teste.</p>
        </div>
        <div className="modal-rodape"><button className="btn btn-leve" onClick={() => { setTeclas([]); setSerial([]); }}>Limpar</button><button className="btn btn-primario" onClick={onFechar}>Fechar teste</button></div>
      </div>
    </div>
  );
}

function CameraLeitor({ titulo, onFechar, onCodigo }) {
  const videoRef = useRef(null);
  const [erro, setErro] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [lanterna, setLanterna] = useState(null); // null = não suportado
  const estado = useRef({ ultimo: null, vistoEm: 0, pausado: false, stream: null, parar: null });
  const onCodigoRef = useRef(onCodigo); onCodigoRef.current = onCodigo;

  const aoDetectar = useCallback(async (bruto, direto) => {
    const s = estado.current;
    const agora = Date.now();
    const codigo = String(bruto || '').trim();
    if (!codigo) return;
    // confirmação por 2 leituras iguais seguidas (evita código errado por leitura parcial)
    if (!direto) {
      if (s.candidato !== codigo || agora - s.candidatoEm > 700) { s.candidato = codigo; s.candidatoEm = agora; return; }
      s.candidato = null;
    }
    // a mesma etiqueta só é lida de novo depois de sair do quadro (evita contar 2x a mesma unidade)
    if (codigo === s.ultimo && agora - s.vistoEm < 900) { s.vistoEm = agora; return; }
    if (s.pausado) return;
    s.pausado = true; s.ultimo = codigo; s.vistoEm = agora;
    let r;
    try { r = await onCodigoRef.current(codigo); } catch (e) { r = { nivel: 'ERRO', titulo: e.message }; }
    setResultado(r ? { ...r, codigo } : { nivel: 'SUCESSO', titulo: codigo, codigo });
    setTimeout(() => { s.pausado = false; s.vistoEm = Date.now(); }, 700);
    setTimeout(() => setResultado((x) => (x?.codigo === codigo ? null : x)), 2500);
  }, []);

  useEffect(() => {
    let vivo = true;
    const s = estado.current;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErro('Este navegador não permite acesso à câmera. Use HTTPS e Chrome/Safari atualizados.');
        return;
      }
      const constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } };
      try {
        const nativo = 'BarcodeDetector' in window ? await window.BarcodeDetector.getSupportedFormats().catch(() => []) : [];
        if (nativo.length) {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (!vivo) { stream.getTracks().forEach((t) => t.stop()); return; }
          s.stream = stream;
          const v = videoRef.current; v.srcObject = stream; await v.play();
          const det = new window.BarcodeDetector({ formats: FORMATOS_NATIVOS.filter((f) => nativo.includes(f)) });
          const track = stream.getVideoTracks()[0];
          const cap = track.getCapabilities?.() || {};
          if (cap.torch) setLanterna(false);
          if (cap.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          const loop = async () => {
            if (!vivo) return;
            try {
              if (v.readyState >= 2) {
                const cods = await det.detect(v);
                if (cods.length) aoDetectar(cods[0].rawValue);
              }
            } catch {}
            setTimeout(loop, 50);
          };
          loop();
        } else {
          const reader = criarLeitorZXing();
          const controls = await reader.decodeFromConstraints(constraints, videoRef.current, (res) => { if (res) aoDetectar(res.getText()); });
          if (!vivo) { controls.stop(); return; }
          s.parar = () => controls.stop();
          if (controls.switchTorch) { s.torch = controls.switchTorch; setLanterna(false); }
        }
      } catch (e) {
        setErro(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'Este navegador não liberou a câmera ao vivo aqui. Use a foto: tire uma foto da etiqueta e o sistema lê o código.' : 'Não foi possível abrir a câmera: ' + (e?.message || e));
      }
    })();
    return () => {
      vivo = false;
      s.stream?.getTracks().forEach((t) => t.stop());
      s.parar?.();
    };
  }, [aoDetectar]);

  const alternarLanterna = async () => {
    const s = estado.current, novo = !lanterna;
    try {
      if (s.stream) await s.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: novo }] });
      else if (s.torch) await s.torch(novo);
      setLanterna(novo);
    } catch {}
  };

  const cor = resultado ? { SUCESSO: 'ok', ERRO: 'erro', ALERTA: 'alerta' }[resultado.nivel] || 'ok' : '';
  return (
    <div className="camera-tela" role="dialog" aria-label="Leitor de código de barras">
      <video ref={videoRef} playsInline muted className="camera-video" />
      <div className={'camera-mira ' + cor} />
      <div className="camera-topo">
        <span className="camera-titulo">{titulo}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {lanterna !== null && <button className="btn btn-escuro" onClick={alternarLanterna}>{lanterna ? '🔦 Desligar' : '🔦 Lanterna'}</button>}
          <button className="btn btn-escuro" onClick={onFechar}>✕ Fechar</button>
        </div>
      </div>
      {erro && (
        <div className="camera-erro">
          <div>{erro}</div>
          <label className="btn btn-camera btn-bloco" style={{ marginTop: 12 }}>
            📸 TIRAR FOTO DO CÓDIGO
            <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              try { const cod = await lerFoto(f); await aoDetectar(cod, true); estado.current.ultimo = null; }
              catch { setResultado({ nivel: 'ERRO', titulo: 'Nenhum código encontrado na foto', sub: 'Aproxime a câmera da etiqueta e tente de novo.' }); }
            }} />
          </label>
        </div>
      )}
      {resultado ? (
        <div className={'camera-resultado ' + cor}>
          <div className="camera-resultado-titulo">{resultado.nivel === 'SUCESSO' ? '✓ ' : resultado.nivel === 'ALERTA' ? '⚠️ ' : '❌ '}{resultado.titulo}</div>
          {resultado.sub && <div className="camera-resultado-sub">{resultado.sub}</div>}
        </div>
      ) : (
        !erro && <div className="camera-dica">Aponte para o código de barras e segure parado um instante. Para ler a mesma etiqueta outra vez, afaste a câmera e aponte de novo.</div>
      )}
    </div>
  );
}
