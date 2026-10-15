// analyse.js — Analyse temporelle + FFT + Démodulation enveloppe
// Modes : anMode = 'time' | 'fft' | 'demod' | 'bump_wait' | 'bump_ready'
let anData = null;
let anP    = { g:2, fs:1000, n:0, t:0 };

// ── Persistance localStorage ─────────────────────────────────
const AN_LS_KEY = 'va_analyse_v1';
let _anPersistTimer = null;

function _anPersistSave() {
  clearTimeout(_anPersistTimer);
  _anPersistTimer = setTimeout(function () {
    _anPersistTimer = null;
    if (!anData || anData.length === 0) return;
    try {
      var scale = 32768.0 / anP.g;
      var raw = new Array(anData.length);
      for (var i = 0; i < anData.length; i++) raw[i] = Math.round(anData[i] * scale);
      localStorage.setItem(AN_LS_KEY, JSON.stringify({
        v: 1, g: anP.g, fs: anP.fs, t: anP.t, n: anP.n,
        mode: anMode, unit: anUnit, zMin: anZMin, zMax: anZMax,
        raw: raw
      }));
    } catch (e) {}
  }, 500);
}

function _anPersistRestore() {
  var s;
  try { s = localStorage.getItem(AN_LS_KEY); } catch (e) { return false; }
  if (!s) return false;
  var o;
  try { o = JSON.parse(s); } catch (e) { return false; }
  if (!o || o.v !== 1 || !o.raw || !o.g || !o.fs) return false;
  var n = o.raw.length, scale = o.g / 32768.0;
  anData = new Float64Array(n);
  for (var i = 0; i < n; i++) anData[i] = o.raw[i] * scale;
  anP = { g: o.g, fs: o.fs, t: o.t || (n / o.fs), n: n };
  anMode = o.mode || 'time';
  anUnit = o.unit || 'g';
  anZMin = typeof o.zMin === 'number' ? o.zMin : 0;
  anZMax = typeof o.zMax === 'number' ? o.zMax : anP.t;
  anMag = null; anMagVel = null; anCursorX = -1;
  return true;
}

function anPersistClear() {
  clearTimeout(_anPersistTimer);
  _anPersistTimer = null;
  try { localStorage.removeItem(AN_LS_KEY); } catch (e) {}
}
let anMode = 'time'; // 'time' | 'fft' | 'demod' | 'bump_wait' | 'bump_ready'
let anMag  = null;
let anZMin = 0, anZMax = 1;
let anCursorX = -1;
let _bumpStatusLines = ['Mode pret - appuyez DEMARRER', ''];
let bumpLiveG = 2;
let bumpLiveRunning = false;
// Config bump courante (BUMP_CFG) — ne pas confondre avec anP (derniere acquisition).
let _bumpCfgFs = 4000;
let _bumpCfgN  = 45000;
// Fenetre glissante fixe — meme duree que le buffer ESP (~50 Hz live).
let bumpWindow     = null;
let bumpWindowSize = 0;
let bumpWriteHead  = 0;
let bumpFilled     = false;
const BUMP_LIVE_HZ = 50;
let _bumpRaf       = null;

function _bumpResetLive() {
  bumpWindow = null;
  bumpWindowSize = 0;
  bumpWriteHead = 0;
  bumpFilled = false;
}

function _bumpStopAnim() {
  if (_bumpRaf) {
    cancelAnimationFrame(_bumpRaf);
    _bumpRaf = null;
  }
}

function _bumpStartAnim() {
  _bumpStopAnim();
  const tick = function () {
    if (anMode !== 'bump_wait' && anMode !== 'bump_stream') {
      _bumpStopAnim();
      return;
    }
    anDrawBumpLive();
    _bumpRaf = requestAnimationFrame(tick);
  };
  _bumpRaf = requestAnimationFrame(tick);
}

// ── Démodulation ───────────────────────────────────────────
let anDemodResult = null;

// ── Sélection temporelle ──────────────────────────────────
let anSelStart  = -1;
let anSelEnd    = -1;
let anSelecting = false;
const APAD = { l:52, r:12, t:14, b:30 };

// ── Correction Fs ICM42688P ───────────────────────────────
// Le firmware envoie maintenant le Fs effectif mesure (header F=) pour
// AnalysisCore / BumpTest / LiveFFT / HarmonicCore. Plus aucune correction
// n'est necessaire cote JS. La table est conservee a 1.0 pour ne pas casser
// les fichiers sauvegardes par les versions precedentes.
const FS_CORRECTION = {
  1000:  1.0, 2000:  1.0, 4000:  1.0, 8000:  1.0,
  12000: 1.0, 16000: 1.0, 24000: 1.0, 32000: 1.0,
};
function fsCorrected(fs) {
  return fs;
}

// ── Unité FFT ──────────────────────────────────────────────
let anUnit   = 'g';
let anMagVel = null;

// ── Hamburger ──────────────────────────────────────────────
let anHamOpen = false;

// ─────────────────────────────────────────────────────────
// Valeur max de l'axe X selon le mode courant
// ─────────────────────────────────────────────────────────
function _anMaxVal() {
  if (anMode === 'time') return anP.t || 1;
  if (anMode === 'demod' && anDemodResult)
    return anDemodResult.freqsRpm[anDemodResult.freqsRpm.length - 1] || DEMOD_FMAX_RPM;
  return anUnit === 'mm/s' ? fftMaxRpmVel(anP.fs) : fftMaxRpmG(anP.fs);
}

// ── Indicateur de progression acquisition (analyse temporelle seule) ──
const AN_FIXED_SAMPLES = 45000;
let _acqRaf = null;
let _acqStartMs = 0;
let _acqDurMs = 0;
let _acqActive = false;
let _acqTransfer = false;
let _acqMeta = { fs: 0, g: '?', n: AN_FIXED_SAMPLES };

function _anFsHzFromMenuCmd(cmd) {
  const n = parseInt(String(cmd).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 16000;
  if (n < 100) return n * 1000;
  return n;
}

function _anGLabel(g) {
  const s = String(g == null ? '' : g).trim();
  if (!s || s === ' ') return 'Auto';
  return '\u00b1' + s + 'g';
}

function acqStartTemporal(opts) {
  if (!opts) return;
  const fsHz = opts.fsHz || _anFsHzFromMenuCmd(opts.fs);
  const n = opts.n || AN_FIXED_SAMPLES;
  const autoExtra = opts.autoRange ? 3500 : 600;
  const durMs = opts.durMs != null ? opts.durMs : Math.round(n * 1000 / fsHz) + autoExtra;
  _acqMeta = { fs: fsHz, g: opts.g, n: n };
  _acqDurMs = Math.max(500, durMs);
  _acqStartMs = Date.now();
  _acqTransfer = false;
  _acqActive = true;
  const ov = document.getElementById('an-acq-overlay');
  if (ov) { ov.style.display = 'flex'; ov.setAttribute('aria-hidden', 'false'); }
  showTab('analyse');
  _acqUpdateHeader();
  if (_acqRaf) cancelAnimationFrame(_acqRaf);
  _acqRaf = requestAnimationFrame(_acqAnimFrame);
}

function acqShowProgress(payload) {
  const m = /^(\d+)/.exec(payload || '');
  if (!m) return;
  const durMs = parseInt(m[1], 10);
  const fsM = /FS=(\d+)/.exec(payload);
  const gM = /G=(\d+)/.exec(payload);
  const nM = /N=(\d+)/.exec(payload);
  const opts = {
    durMs: durMs + 400,
    fsHz: fsM ? parseInt(fsM[1], 10) : undefined,
    g: gM ? gM[1] : _acqMeta.g,
    n: nM ? parseInt(nM[1], 10) : AN_FIXED_SAMPLES,
    autoRange: false,
  };
  if (_acqActive) {
    _acqDurMs = opts.durMs;
    _acqStartMs = Date.now();
    if (opts.fsHz) _acqMeta.fs = opts.fsHz;
    if (opts.g) _acqMeta.g = opts.g;
    if (opts.n) _acqMeta.n = opts.n;
    _acqTransfer = false;
    return;
  }
  acqStartTemporal(opts);
}

function acqSetTransferPhase() {
  if (!_acqActive) return;
  _acqTransfer = true;
  _acqUpdateHeader();
}

function acqHideProgress() {
  _acqActive = false;
  _acqTransfer = false;
  if (_acqRaf) { cancelAnimationFrame(_acqRaf); _acqRaf = null; }
  const ov = document.getElementById('an-acq-overlay');
  if (ov) { ov.style.display = 'none'; ov.setAttribute('aria-hidden', 'true'); }
  const ring = document.getElementById('an-acq-ring');
  if (ring) {
    const ctx = ring.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, ring.width, ring.height);
  }
}

function _acqUpdateHeader() {
  const el = document.getElementById('an-fs');
  if (!el) return;
  const g = _anGLabel(_acqMeta.g);
  const fs = _acqMeta.fs || '?';
  const n = _acqMeta.n || AN_FIXED_SAMPLES;
  if (_acqTransfer) {
    el.textContent = 'Transfert\u2026  (' + n + ' samp, ' + fs + ' Hz, ' + g + ')';
    return;
  }
  const totalSec = (_acqDurMs / 1000).toFixed(1);
  const elapsed = Date.now() - _acqStartMs;
  const remain = Math.max(0, _acqDurMs - elapsed);
  const pct = Math.min(100, Math.round(elapsed * 100 / _acqDurMs));
  if (remain <= 0) {
    el.textContent = 'Finalisation\u2026  (' + fs + ' Hz, ' + g + ')';
  } else {
    el.textContent = 'Acquisition ' + pct + '%  ' +
      (remain / 1000).toFixed(1) + 's / ' + totalSec + 's  (' + fs + ' Hz, ' + g + ')';
  }
  const lbl = document.getElementById('an-acq-label');
  if (lbl) {
    lbl.textContent = _acqTransfer
      ? 'Transfert des donn\u00e9es\u2026'
      : (remain <= 0 ? 'Finalisation\u2026' : 'Acquisition ' + pct + '%');
  }
}

function _acqDrawRing(progress) {
  const canvas = document.getElementById('an-acq-ring');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, R = 46;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.stroke();

  if (_acqTransfer) {
    const spin = (Date.now() % 1200) / 1200 * 2 * Math.PI;
    ctx.strokeStyle = '#0066cc';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.setLineDash([10, 14]);
    ctx.lineDashOffset = -spin * 8;
    ctx.beginPath();
    ctx.arc(cx, cy, R, spin, spin + Math.PI * 1.35);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const p = Math.max(0, Math.min(1, progress));
  const start = -Math.PI / 2;
  const end = start + p * 2 * Math.PI;
  const spin = (Date.now() % 1800) / 1800 * 2 * Math.PI;

  if (p > 0.002) {
    ctx.fillStyle = 'rgba(0, 102, 204, 0.18)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, start, end);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#0066cc';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    ctx.stroke();

    const tip = end;
    const wedge = Math.PI / 7;
    ctx.fillStyle = 'rgba(0, 102, 204, 0.42)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R * 0.92, tip + spin - wedge / 2, tip + spin + wedge / 2);
    ctx.closePath();
    ctx.fill();
  }
}

function _acqAnimFrame() {
  if (!_acqActive) return;
  const elapsed = Date.now() - _acqStartMs;
  const progress = _acqTransfer ? 1 : Math.min(1, elapsed / _acqDurMs);
  _acqDrawRing(progress);
  _acqUpdateHeader();
  if (!_acqTransfer && elapsed >= _acqDurMs) _acqTransfer = true;
  _acqRaf = requestAnimationFrame(_acqAnimFrame);
}

function anApplyLayoutByMode() {
  const isBumpWait = (anMode === 'bump_wait' || anMode === 'bump_stream');
  const bumpPanel = document.getElementById('an-bump-panel');
  const header = document.querySelector('#page-analyse .graph-header');
  const stats = document.getElementById('an-stats');
  const wrap = document.getElementById('an-canvas-wrap');
  const ctrl = document.querySelector('#page-analyse .ctrl-bar');
  if (bumpPanel) bumpPanel.style.display = isBumpWait ? 'flex' : 'none';
  if (header) header.style.display = 'flex';
  if (stats) stats.style.display = isBumpWait ? 'none' : 'flex';
  if (wrap) wrap.style.display = 'block';
  if (ctrl) ctrl.style.display = isBumpWait ? 'none' : 'flex';
}

function _bumpWindowT() {
  return (_bumpCfgN || 45000) / (_bumpCfgFs || 4000);
}

/** Pas d'echelle temps lisible selon duree fenetre et largeur graphique. */
function _anBumpTimeStep(T, pW) {
  const minPx = 52;
  const maxTicks = Math.max(2, Math.floor(pW / minPx));
  const raw = T / maxTicks;
  if (raw <= 0.15) return 0.1;
  if (raw <= 0.35) return 0.2;
  if (raw <= 0.6)  return 0.5;
  const nice = [1, 2, 5, 10, 15, 20, 30, 60, 120];
  for (let i = 0; i < nice.length; i++) {
    if (nice[i] >= raw) return nice[i];
  }
  return 60;
}

function _anBumpTimeLabel(ts, step) {
  if (step >= 10) return String(Math.round(ts));
  if (step >= 1) return String(Math.round(ts * 10) / 10);
  return ts.toFixed(1);
}

function bumpSetStatus(text) {
  const clean = (text || '').trim();
  if (clean.length > 0) {
    _bumpStatusLines.unshift(clean);
    _bumpStatusLines = _bumpStatusLines.slice(0, 3);
  }
  const monitor = document.getElementById('an-bump-monitor');
  if (monitor) monitor.textContent = _bumpStatusLines.filter(Boolean).join('\n');
}

function bumpStart() {
  anMode = 'bump_wait';
  bumpLiveRunning = false;
  _bumpResetLive();
  _bumpStopAnim();
  const btn = document.getElementById('btn-bump-start');
  if (btn) btn.textContent = 'DEMARRER';
  _bumpStatusLines = ['Mode pret - appuyez DEMARRER', ''];
  const fsEl = document.getElementById('an-fs');
  if (fsEl) fsEl.textContent = `Bump live  FS=${_bumpCfgFs} Hz  Fenetre=${_bumpWindowT().toFixed(3)} s  ±${bumpLiveG}g`;
  anApplyLayoutByMode();
  bumpSetStatus('');
  showTab('analyse');
  analyseDraw();
}

function bumpSendStart() {
  const btn = document.getElementById('btn-bump-start');
  if (!bumpLiveRunning) {
    wsSend('BUMP_START\n');
    bumpLiveRunning = true;
    anMode = 'bump_stream';
    if (btn) btn.textContent = 'STOP';
    bumpSetStatus('Streaming demarre - frappez puis STOP');
    _bumpStartAnim();
  } else {
    wsSend('BUMP_STOP\n');
    bumpLiveRunning = false;
    _bumpStopAnim();
    if (btn) btn.textContent = 'DEMARRER';
    bumpSetStatus('STOP envoye - envoi buffer complet...');
  }
}

function bumpReceiveLive(rawVal) {
  // Porte firmware ~20 ms (~50 Hz). Fenetre = duree buffer bump (N/Fs du BUMP_CFG).
  const T      = _bumpWindowT();
  const target = Math.max(32, Math.floor(T * BUMP_LIVE_HZ));

  if (!bumpWindow || bumpWindow.length !== target) {
    bumpWindow     = new Float32Array(target);
    bumpWindowSize = target;
    bumpWriteHead  = 0;
    bumpFilled     = false;
  }

  const v    = Number(rawVal) || 0;
  const gVal = v * (bumpLiveG / 32768.0);

  bumpWindow[bumpWriteHead] = gVal;
  bumpWriteHead = (bumpWriteHead + 1) % bumpWindowSize;
  if (bumpWriteHead === 0) bumpFilled = true;

  if (anMode === 'bump_wait') {
    anMode = 'bump_stream';
    if (!bumpLiveRunning) {
      bumpLiveRunning = true;
      _bumpStartAnim();
    }
  }
}

function bumpSetConfig(g, fs, n) {
  const gg = parseInt(g, 10);
  const ffs = parseInt(fs, 10);
  const nn = parseInt(n, 10);
  const prevFs = _bumpCfgFs;
  const prevN  = _bumpCfgN;
  if (gg === 2 || gg === 4 || gg === 8 || gg === 16) bumpLiveG = gg;
  if (ffs > 0) _bumpCfgFs = ffs;
  if (nn > 0) _bumpCfgN = nn;
  if (!bumpLiveRunning && ((ffs > 0 && ffs !== prevFs) || (nn > 0 && nn !== prevN))) {
    bumpWindow = null;
    bumpWriteHead = 0;
    bumpFilled = false;
  }
  const fsEl = document.getElementById('an-fs');
  if (fsEl) fsEl.textContent = `Bump live  FS=${_bumpCfgFs} Hz  Fenetre=${_bumpWindowT().toFixed(3)} s  ±${bumpLiveG}g`;
  if (anMode === 'bump_wait' || anMode === 'bump_stream') analyseDraw();
}

function bumpExit() {
  if (bumpLiveRunning) wsSend('BUMP_STOP\n');
  wsSend('r\n');
  bumpLiveRunning = false;
  _bumpStopAnim();
  _bumpResetLive();
  anMode = 'time';
  anApplyLayoutByMode();
  if (typeof analyseDraw === 'function') analyseDraw();
}

function anDrawBumpLive() {
  const canvas = document.getElementById('an-canvas');
  const wrap = document.getElementById('an-canvas-wrap');
  const W = wrap.offsetWidth || window.innerWidth;
  const H = wrap.offsetHeight || 280;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const P = APAD, pW = W - P.l - P.r, pH = H - P.t - P.b;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(P.l, P.t, pW, pH);

  const ymax = Math.max(0.2, bumpLiveG * 1.05);
  for (let i = 0; i <= 4; i++) {
    const gv = -ymax + (2 * ymax * i / 4);
    const y = P.t + pH / 2 - (gv / ymax) * pH / 2;
    if (i !== 2) {
      ctx.strokeStyle = '#eee';
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pW, y); ctx.stroke();
    }
    ctx.fillStyle = '#333';
    ctx.font = '9px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(gv.toFixed(2), P.l - 4, y + 3);
  }
  ctx.strokeStyle = '#999';
  ctx.beginPath(); ctx.moveTo(P.l, P.t + pH / 2); ctx.lineTo(P.l + pW, P.t + pH / 2); ctx.stroke();

  ctx.save();
  ctx.translate(13, P.t + pH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = '10px Arial';
  ctx.fillStyle = '#333';
  ctx.fillText('Acceleration (g)', 0, 0);
  ctx.restore();

  const T = Math.max(1e-6, _bumpWindowT());
  const tStep = _anBumpTimeStep(T, pW);
  ctx.font = '9px Arial';
  ctx.fillStyle = '#333';
  for (let ts = 0; ts <= T + tStep * 0.01; ts += tStep) {
    const x = P.l + (ts / T) * pW;
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, P.t + pH);
    ctx.lineTo(x, P.t + pH + 4);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(_anBumpTimeLabel(ts, tStep), x, H - 16);
  }
  ctx.fillStyle = '#555';
  ctx.font = '10px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Temps (s)', P.l + pW / 2, H - 2);

  if (!bumpWindow) return;
  const count = bumpFilled ? bumpWindowSize : bumpWriteHead;
  if (count === 0) return;
  const readStart = bumpFilled ? bumpWriteHead : 0;
  const xDenom = Math.max(1, bumpWindowSize - 1);

  ctx.save();
  ctx.beginPath(); ctx.rect(P.l, P.t, pW, pH); ctx.clip();
  ctx.strokeStyle = '#e67e22';
  ctx.lineWidth   = 1.4;
  ctx.beginPath();
  for (let j = 0; j < count; j++) {
    const idx = (readStart + j) % bumpWindowSize;
    // Echelle temps fixe (0..T) : la courbe se remplit puis defile, sans etirer les debutants.
    const x   = P.l + (j / xDenom) * pW;
    const y   = P.t + pH / 2 - (bumpWindow[idx] / ymax) * pH / 2;
    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// ── Réception depuis app.js ───────────────────────────────
function analyseReceiveBloc(g, fs, t, n, raw) {
  acqHideProgress();
  bumpLiveRunning = false;
  _bumpStopAnim();
  _bumpResetLive();
  bumpLiveG = g;
  const btn = document.getElementById('btn-bump-start');
  if (btn) btn.textContent = 'DEMARRER';
  anP = { g, fs, t, n };
  const scale = g / 32768.0;
  anData = new Float64Array(n);
  for (let i = 0; i < n; i++) anData[i] = raw[i] * scale;
  anUpdateStats();
  if (_wavSource) analysePause();
  anMode='time'; anZMin=0; anZMax=t; anMag=null; anMagVel=null; anCursorX=-1;
  anUnit='g'; anDataDisplay=null; anFilterInfo='';
  anDemodResult=null;
  anSelStart=-1; anSelEnd=-1; _anUpdateSelBtn();
  anApplyLayoutByMode();
  anUpdateBtnStates();
  showTab('analyse');
  analyseDraw();
  _anPersistSave();
}

// ── Gestion états boutons ─────────────────────────────────
function anUpdateBtnStates() {
  const inFreq  = anMode === 'fft' || anMode === 'demod';
  const inDemod = anMode === 'demod';
  const inFFT   = anMode === 'fft';
  _btnSet('btn-an-fft',   inFreq);
  _btnSet('btn-an-g',     inFFT && anUnit === 'g');
  _btnSet('btn-an-vel',   inFFT && anUnit === 'mm/s');
  _btnSet('btn-an-demod', inDemod);
}
function _btnSet(id, active) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('active', !!active);
}

// ── Stats ─────────────────────────────────────────────────
function anUpdateStats() {
  if (anMode === 'bump_wait') return;
  const sig = anDataDisplay || anData;

  if (anMode === 'demod' && anDemodResult) {
    const { rmsEnv, crestEnv, fLow, fHigh, amps } = anDemodResult;
    let pkAmp = 0;
    for (let i = 1; i < amps.length; i++) if (amps[i] > pkAmp) pkAmp = amps[i];
    document.getElementById('an-rms').textContent   = rmsEnv.toFixed(4) + ' g';
    document.getElementById('an-peak').textContent  = pkAmp.toFixed(4);
    document.getElementById('an-crest').textContent = crestEnv.toFixed(2);
    document.getElementById('an-fs').textContent    =
      `Démod  Bande: ${fLow.toFixed(0)}–${fHigh.toFixed(0)} Hz  Fs=${anP.fs} Hz`;

  } else if (anMode === 'fft' && anUnit === 'mm/s' && anMagVel) {
    const nFFT  = anMagVel.length * 2;
    const rpmPB = (anP.fs / nFFT) * 60;
    const maxB  = Math.min(anMagVel.length-1, Math.floor(fftMaxRpmVel(anP.fs)/rpmPB));
    let pkBin=0, pkAmp=0;
    for (let i=1;i<=maxB;i++) if(anMagVel[i]>pkAmp){pkAmp=anMagVel[i];pkBin=i;}
    const rmsIso = (typeof calcRmsIso==='function')
      ? calcRmsIso(sig.slice(0,anP.n), anP.fs, anP.n) : 0;
    document.getElementById('an-rms').textContent   = rmsIso.toFixed(3)+' mm/s';
    document.getElementById('an-peak').textContent  = pkAmp.toFixed(3)+' mm/s';
    document.getElementById('an-crest').textContent = (rmsIso>0?pkAmp/rmsIso:0).toFixed(2);
    document.getElementById('an-fs').textContent    =
      anP.fs+' Hz  N='+anP.n+'  T='+anP.t.toFixed(3)+'s  ±'+anP.g+'g';

  } else if (anMode === 'fft' && anUnit === 'g' && anMag) {
    const nFFT  = anMag.length * 2;
    const rpmPB = (anP.fs / nFFT) * 60;
    const maxB  = Math.min(anMag.length-1, Math.floor(fftMaxRpmG(anP.fs)/rpmPB));
    let pkBin=0, pkAmp=0;
    for (let i=1;i<=maxB;i++) if(anMag[i]>pkAmp){pkAmp=anMag[i];pkBin=i;}
    let rmsG=0;
    for (let i=1;i<=maxB;i++) rmsG+=anMag[i]*anMag[i];
    rmsG=Math.sqrt(rmsG*2);
    document.getElementById('an-rms').textContent   = rmsG.toFixed(4)+' g';
    document.getElementById('an-peak').textContent  = pkAmp.toFixed(4)+' g';
    document.getElementById('an-crest').textContent = (rmsG>0?pkAmp/rmsG:0).toFixed(2);
    document.getElementById('an-fs').textContent    =
      anP.fs+' Hz  N='+anP.n+'  T='+anP.t.toFixed(3)+'s  ±'+anP.g+'g';

  } else {
    const rms  = anCalcRMS(sig);
    const peak = anCalcPeak(sig);
    document.getElementById('an-rms').textContent   = rms.toFixed(4)+' g';
    document.getElementById('an-peak').textContent  = peak.toFixed(4)+' g';
    document.getElementById('an-crest').textContent = (peak/rms).toFixed(2);
    document.getElementById('an-fs').textContent    =
      anP.fs+' Hz  N='+anP.n+'  T='+anP.t.toFixed(3)+'s  ±'+anP.g+'g';
  }
}

// ── Dessin principal ──────────────────────────────────────
function analyseDraw() {
  if (anMode === 'bump_wait' || anMode === 'bump_stream') {
    anApplyLayoutByMode();
    anDrawBumpLive();
    return;
  }
  if (!anData) return;
  anApplyLayoutByMode();
  if      (anMode === 'time')  anDrawTime();
  else if (anMode === 'fft')   anDrawFFT();
  else if (anMode === 'demod') anDrawDemod();
  anUpdateStats();
}
function _anDrawOnly() {
  if (!anData) return;
  if      (anMode === 'time')  anDrawTime();
  else if (anMode === 'fft')   anDrawFFT();
  else if (anMode === 'demod') anDrawDemod();
}

// ─────────────────────────────────────────────────────────
// CURSEUR TEMPOREL
// ─────────────────────────────────────────────────────────
function anDrawCursor(ctx, xPx, val, amp, unit, pH, W) {
  ctx.save();
  ctx.strokeStyle='#cc0000'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
  ctx.beginPath(); ctx.moveTo(xPx,APAD.t); ctx.lineTo(xPx,APAD.t+pH); ctx.stroke();
  ctx.setLineDash([]);
  const label=val.toFixed(unit==='s'?4:1)+' '+unit+'  '+amp.toFixed(4)+' g';
  ctx.font='bold 10px Arial';
  const tw=ctx.measureText(label).width;
  const lx=(xPx+tw+6>W-APAD.r)?xPx-tw-6:xPx+4;
  ctx.fillStyle='rgba(255,255,255,0.85)'; ctx.fillRect(lx-2,APAD.t+2,tw+4,14);
  ctx.fillStyle='#cc0000'; ctx.fillText(label,lx,APAD.t+13);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
// CURSEUR FFT + harmoniques 1x/2x/3x
// ─────────────────────────────────────────────────────────
function anDrawCursorFFT(ctx, xPx, rpm, amp, unit, pH, W, mag, rpmPB, zMin, span, pW) {
  const harmonics=[
    {mult:1,color:'#cc0000',dash:[4,3],bold:true},
    {mult:2,color:'#7700cc',dash:[5,2],bold:false},
    {mult:3,color:'#cc5500',dash:[5,2],bold:false},
  ];
  ctx.save();
  harmonics.forEach(({mult,color,dash,bold}) => {
    const hRpm=rpm*mult;
    if (hRpm<zMin||hRpm>zMin+span) return;
    const hX=APAD.l+(hRpm-zMin)/span*pW;
    const bin=Math.round(hRpm/rpmPB);
    const hAmp=(mag&&bin>=1&&bin<mag.length)?mag[bin]:amp*(1/mult);
    ctx.strokeStyle=color; ctx.lineWidth=1; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(hX,APAD.t); ctx.lineTo(hX,APAD.t+pH); ctx.stroke();
    ctx.setLineDash([]);
    const label=(mult===1?'1x':mult===2?'2x':'3x');
    const lines=[label+' '+hRpm.toFixed(0)+' RPM', hAmp.toFixed(mult===1?4:3)+' '+unit];
    ctx.font=(bold?'bold ':'')+' 9px Arial';
    const tw=Math.max(...lines.map(l=>ctx.measureText(l).width));
    const bw=tw+6,bh=lines.length*12+3;
    const yOff=APAD.t+(mult===1?6:mult===2?34:62);
    const bx=(hX+bw+4>W-APAD.r)?hX-bw-4:hX+3;
    ctx.fillStyle='rgba(255,255,220,0.92)'; ctx.fillRect(bx,yOff,bw,bh);
    ctx.strokeStyle=color; ctx.lineWidth=0.7; ctx.strokeRect(bx,yOff,bw,bh);
    ctx.fillStyle=color; ctx.textAlign='left';
    lines.forEach((l,i)=>ctx.fillText(l,bx+3,yOff+10+i*12));
  });
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
// DESSIN TEMPOREL
// ─────────────────────────────────────────────────────────
function anDrawTime() {
  const _sig=anDataDisplay||anData;
  const canvas=document.getElementById('an-canvas');
  const wrap=document.getElementById('an-canvas-wrap');
  const W=wrap.offsetWidth||window.innerWidth;
  const H=wrap.offsetHeight||280;
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  const P=APAD,pW=W-P.l-P.r,pH=H-P.t-P.b;
  const fs=anP.fs,n=anP.n;
  const i0=Math.max(0,Math.floor(anZMin*fs));
  const i1=Math.min(n-1,Math.floor(anZMax*fs));
  const span=anZMax-anZMin;
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#555'; ctx.lineWidth=1; ctx.strokeRect(P.l,P.t,pW,pH);
  let maxA=0;
  for(let i=i0;i<=i1;i++) if(Math.abs(_sig[i])>maxA) maxA=Math.abs(_sig[i]);
  if(maxA===0) maxA=1; maxA*=1.15;
  for(let g=0;g<=4;g++){
    const av=-maxA+maxA*2*g/4,y=P.t+pH/2-(av/maxA)*pH/2;
    if(g!==2){ctx.strokeStyle='#eee';ctx.lineWidth=0.5;ctx.beginPath();ctx.moveTo(P.l,y);ctx.lineTo(P.l+pW,y);ctx.stroke();}
    ctx.fillStyle='#333';ctx.font='9px Arial';ctx.textAlign='right';
    ctx.fillText(av.toFixed(3),P.l-4,y+3);
  }
  ctx.strokeStyle='#ccc';ctx.lineWidth=0.8;
  ctx.beginPath();ctx.moveTo(P.l,P.t+pH/2);ctx.lineTo(P.l+pW,P.t+pH/2);ctx.stroke();
  ctx.save();ctx.translate(11,P.t+pH/2);ctx.rotate(-Math.PI/2);
  ctx.textAlign='center';ctx.font='10px Arial';ctx.fillStyle='#333';
  ctx.fillText('Amplitude (g)',0,0);ctx.restore();
  const xt=Math.min(6,Math.floor(pW/50));
  for(let t2=0;t2<=xt;t2++){
    const ts=anZMin+span*t2/xt,x=P.l+(ts-anZMin)/span*pW;
    ctx.strokeStyle='#888';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,P.t+pH);ctx.lineTo(x,P.t+pH+4);ctx.stroke();
    ctx.fillStyle='#333';ctx.font='9px Arial';ctx.textAlign='center';
    ctx.fillText(ts.toFixed(3)+'s',x,H-2);
  }
  ctx.fillStyle='#555';ctx.font='10px Arial';ctx.textAlign='center';
  ctx.fillText('Temps (s)',P.l+pW/2,H);
  ctx.save();ctx.beginPath();ctx.rect(P.l,P.t,pW,pH);ctx.clip();
  ctx.strokeStyle='#0033cc';ctx.lineWidth=1.2;ctx.beginPath();
  const step=Math.max(1,Math.floor((i1-i0)/pW/2));
  let first=true;
  for(let i=i0;i<=i1;i+=step){
    const x=P.l+((i/fs)-anZMin)/span*pW;
    const y=P.t+pH/2-(_sig[i]/maxA)*pH/2;
    if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y);
  }
  ctx.stroke();ctx.restore();
  if(anSelStart>=0&&anSelEnd>anSelStart){
    const xS=P.l+(Math.max(anSelStart,anZMin)-anZMin)/span*pW;
    const xE=P.l+(Math.min(anSelEnd,anZMax)-anZMin)/span*pW;
    if(xE>xS){
      ctx.save();
      ctx.fillStyle='rgba(255,200,0,0.18)'; ctx.fillRect(xS,P.t,xE-xS,pH);
      ctx.strokeStyle='#cc8800';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(xS,P.t);ctx.lineTo(xS,P.t+pH);ctx.stroke();
      ctx.beginPath();ctx.moveTo(xE,P.t);ctx.lineTo(xE,P.t+pH);ctx.stroke();
      const dur=(anSelEnd-anSelStart).toFixed(3);
      ctx.fillStyle='#cc8800';ctx.font='bold 10px Arial';ctx.textAlign='center';
      ctx.fillText(dur+'s',(xS+xE)/2,P.t+11);
      ctx.restore();
    }
  }
  if(anCursorX>=P.l&&anCursorX<=P.l+pW){
    const ts=anZMin+((anCursorX-P.l)/pW)*span;
    const idx=Math.round(ts*fs);
    if(idx>=0&&idx<n) anDrawCursor(ctx,anCursorX,ts,Math.abs(_sig[idx]),'s',pH,W);
  }
}

// ─────────────────────────────────────────────────────────
// DESSIN FFT
// ─────────────────────────────────────────────────────────
function anDrawFFT() {
  const _sigFFT=anDataDisplay||anData;
  if(!anMag){
    anMag=computeFFT(_sigFFT.slice(0,anP.n),anP.n,anP.fs);
    const rpmPB=(anP.fs/nextPow2(anP.n))*60;
    const minBinHP=Math.max(1,Math.ceil(HP_RPM_MIN/rpmPB));
    const pk=fftPeakBin(anMag,Math.floor(anP.n/2)-1,minBinHP);
    anZMin=HP_RPM_MIN; anZMax=Math.max(600,pk*rpmPB*4);
  }
  const isVel=(anUnit==='mm/s');
  if(isVel&&!anMagVel){
    anMagVel=computeVelFFT(_sigFFT.slice(0,anP.n),anP.fs,anP.n);
  }
  const mag=isVel?anMagVel:anMag;
  const maxRpm=isVel?fftMaxRpmVel(anP.fs):fftMaxRpmG(anP.fs);
  const yLabel=isVel?'Vitesse (mm/s)':'Amplitude (g)';
  const lineColor=isVel?'#007744':'#0033cc';
  const fillColor=isVel?'rgba(0,150,80,0.07)':'rgba(0,80,200,0.07)';
  const decimals=isVel?2:3;
  const canvas=document.getElementById('an-canvas');
  const wrap=document.getElementById('an-canvas-wrap');
  const W=wrap.offsetWidth||window.innerWidth;
  const H=wrap.offsetHeight||280;
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  const zMin=anZMin, zMax=Math.min(anZMax,maxRpm);
  const P=APAD,fs=anP.fs,n=anP.n;
  const nFFT=nextPow2(n);
  const rpmPB=(fs/nFFT)*60,span=zMax-zMin;
  const minB=Math.max(1,Math.floor(zMin/rpmPB));
  const maxB=Math.min(nFFT/2-1,Math.ceil(zMax/rpmPB));
  const pW=W-P.l-P.r,pH=H-P.t-P.b;
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#555'; ctx.lineWidth=1; ctx.strokeRect(P.l,P.t,pW,pH);
  let maxA=0;
  for(let i=minB;i<=maxB;i++) if(mag[i]>maxA) maxA=mag[i];
  if(maxA===0) maxA=1;
  const aS=pH/(maxA*1.1);
  for(let g=0;g<=5;g++){
    const av=maxA*g/5,y=P.t+pH-av*aS;
    if(g>0){ctx.strokeStyle='#eee';ctx.lineWidth=0.5;ctx.beginPath();ctx.moveTo(P.l,y);ctx.lineTo(P.l+pW,y);ctx.stroke();}
    ctx.fillStyle='#333';ctx.font='9px Arial';ctx.textAlign='right';
    ctx.fillText(av.toFixed(decimals),P.l-4,y+3);
  }
  ctx.save();ctx.translate(11,P.t+pH/2);ctx.rotate(-Math.PI/2);
  ctx.textAlign='center';ctx.font='10px Arial';ctx.fillStyle='#333';
  ctx.fillText(yLabel,0,0);ctx.restore();
  const xt=Math.min(8,Math.floor(pW/55));
  for(let t2=0;t2<=xt;t2++){
    const rpm=zMin+span*t2/xt,x=P.l+(rpm-zMin)/span*pW;
    ctx.strokeStyle='#888';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,P.t+pH);ctx.lineTo(x,P.t+pH+4);ctx.stroke();
    ctx.fillStyle='#333';ctx.font='9px Arial';ctx.textAlign='center';
    ctx.fillText(rpm>=1000?(rpm/1000).toFixed(1)+'k':rpm.toFixed(0),x,H-2);
  }
  ctx.fillStyle='#555';ctx.font='10px Arial';ctx.textAlign='center';
  ctx.fillText('Fréquence (RPM)',P.l+pW/2,H);
  ctx.save();ctx.beginPath();ctx.rect(P.l,P.t,pW,pH);ctx.clip();
  ctx.beginPath();let fi=true;
  for(let i=minB;i<=maxB;i++){
    const x=P.l+(i*rpmPB-zMin)/span*pW,y=P.t+pH-mag[i]*aS;
    if(fi){ctx.moveTo(x,P.t+pH);ctx.lineTo(x,y);fi=false;}else ctx.lineTo(x,y);
  }
  if(!fi){ctx.lineTo(P.l+(maxB*rpmPB-zMin)/span*pW,P.t+pH);ctx.closePath();ctx.fillStyle=fillColor;ctx.fill();}
  const ppb=pW/(maxB-minB+1);
  if(ppb>=1.2){
    ctx.lineWidth=Math.min(1.5,ppb*0.7);
    for(let i=minB;i<=maxB;i++){
      if(mag[i]<maxA*0.002) continue;
      const x=P.l+(i*rpmPB-zMin)/span*pW,y=P.t+pH-mag[i]*aS;
      ctx.strokeStyle=lineColor; ctx.beginPath();ctx.moveTo(x,P.t+pH);ctx.lineTo(x,y);ctx.stroke();
    }
  }else{
    ctx.beginPath();ctx.strokeStyle=lineColor;ctx.lineWidth=1.2;let ff=true;
    for(let i=minB;i<=maxB;i++){
      const x=P.l+(i*rpmPB-zMin)/span*pW,y=P.t+pH-mag[i]*aS;
      if(ff){ctx.moveTo(x,y);ff=false;}else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  const pkB=fftPeakBin(mag,maxB);
  if(pkB>=minB){
    const xP=P.l+(pkB*rpmPB-zMin)/span*pW;
    ctx.strokeStyle='#cc6600';ctx.lineWidth=1;ctx.setLineDash([5,3]);
    ctx.beginPath();ctx.moveTo(xP,P.t);ctx.lineTo(xP,P.t+pH);ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#cc6600';ctx.font='bold 10px Arial';ctx.textAlign='left';
    ctx.fillText((pkB*rpmPB).toFixed(0)+' RPM',Math.min(xP+3,W-70),P.t+12);
  }
  ctx.restore();
  if(anCursorX>=P.l&&anCursorX<=P.l+pW){
    const rpm=zMin+((anCursorX-P.l)/pW)*span;
    const bin=Math.round(rpm/rpmPB);
    if(bin>=1&&bin<mag.length)
      anDrawCursorFFT(ctx,anCursorX,rpm,mag[bin],anUnit,pH,W,mag,rpmPB,zMin,span,pW);
  }
}

// ─────────────────────────────────────────────────────────
// DESSIN DÉMODULATION ENVELOPPE
// ─────────────────────────────────────────────────────────
function anDrawDemod() {
  const canvas = document.getElementById('an-canvas');
  const wrap   = document.getElementById('an-canvas-wrap');
  const W = wrap.offsetWidth || window.innerWidth;
  const H = wrap.offsetHeight || 280;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const P = APAD, pW = W-P.l-P.r, pH = H-P.t-P.b;

  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(P.l, P.t, pW, pH);

  if (!anDemodResult) {
    ctx.fillStyle = '#888'; ctx.font = '13px Arial'; ctx.textAlign = 'center';
    ctx.fillText('Appuyez sur ⚙ Démod dans ☰', W/2, H/2 - 8);
    ctx.fillText('(signal chargé dans Analyse requis)', W/2, H/2 + 10);
    return;
  }

  const { freqsRpm, amps, fLow, fHigh, rmsEnv, crestEnv } = anDemodResult;
  const fmaxDemod = freqsRpm[freqsRpm.length - 1] || DEMOD_FMAX_RPM;
  const zMin = Math.max(0, anZMin);
  const zMax = Math.min(anZMax, fmaxDemod);
  const span = Math.max(zMax - zMin, 1);
  const rpmPerBin = freqsRpm.length > 1 ? (freqsRpm[1] - freqsRpm[0]) : 1;
  const minB = Math.max(0,          Math.floor(zMin / rpmPerBin));
  const maxB = Math.min(freqsRpm.length - 1, Math.ceil(zMax  / rpmPerBin));

  // Auto-échelle Y sur la vue courante
  let maxA = 0;
  for (let i = minB; i <= maxB; i++) if (amps[i] > maxA) maxA = amps[i];
  if (!maxA) maxA = 1;
  const aS = pH / (maxA * 1.1);

  // ── Grille H + labels Y ──────────────────────────────
  for (let g = 0; g <= 5; g++) {
    const av = maxA * g / 5, y = P.t + pH - av * aS;
    if (g > 0) {
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l+pW, y); ctx.stroke();
    }
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'right';
    ctx.fillText(av.toFixed(4), P.l-4, y+3);
  }
  ctx.save(); ctx.translate(11, P.t+pH/2); ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center'; ctx.font = '10px Arial'; ctx.fillStyle = '#333';
  ctx.fillText('Ampl. env.', 0, 0); ctx.restore();

  // ── Grille V + labels X (RPM) ────────────────────────
  const xticks = Math.min(8, Math.floor(pW/55));
  for (let ti = 0; ti <= xticks; ti++) {
    const rpm = zMin + span*ti/xticks, x = P.l + (rpm-zMin)/span*pW;
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, P.t+pH); ctx.lineTo(x, P.t+pH+4); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'center';
    ctx.fillText(rpm>=1000?(rpm/1000).toFixed(1)+'k':rpm.toFixed(0), x, H-2);
  }
  ctx.fillStyle = '#555'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
  ctx.fillText('Fréquence (RPM)', P.l+pW/2, H);

  // ── Zone clippée ─────────────────────────────────────
  ctx.save(); ctx.beginPath(); ctx.rect(P.l, P.t, pW, pH); ctx.clip();

  // ── Marqueurs fréquences roulements (curseurs fixes) ─
  const rpm  = parseFloat(document.getElementById('demod-rpm')?.value)  || 0;
  const bpfi = parseFloat(document.getElementById('demod-bpfi')?.value) || 0;
  const bpfo = parseFloat(document.getElementById('demod-bpfo')?.value) || 0;
  const bsf  = parseFloat(document.getElementById('demod-bsf')?.value)  || 0;
  const ftf  = parseFloat(document.getElementById('demod-ftf')?.value)  || 0;

  const bmk = [
    { f: bpfi*rpm, color: '#e53935', label: 'BPFi' },
    { f: bpfo*rpm, color: '#2e7d32', label: 'BPFo' },
    { f: bsf *rpm, color: '#7b1fa2', label: 'BSF'  },
    { f: ftf *rpm, color: '#00838f', label: 'FTF'  },
  ];
  bmk.forEach(m => {
    if (!m.f || m.f <= 0) return;
    for (let h = 1; h <= 3; h++) {
      const fr = m.f * h;
      if (fr < zMin - 1 || fr > zMax + 1) continue;
      const x = P.l + (fr - zMin) / span * pW;
      ctx.save();
      ctx.strokeStyle = m.color;
      ctx.lineWidth   = h === 1 ? 1.5 : 0.8;
      ctx.globalAlpha = h === 1 ? 0.9 : 0.45;
      ctx.setLineDash(h === 1 ? [5, 3] : [3, 5]);
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t+pH); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = h === 1 ? 1.0 : 0.75;
      if (h <= 2) {
        ctx.fillStyle = m.color;
        ctx.font = h === 1 ? 'bold 9px Arial' : '8px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(h === 1 ? m.label : '2×'+m.label, x, P.t + (h===1?9:19));
      }
      ctx.restore();
    }
  });

  // ── Spectre enveloppe ─────────────────────────────────
  // Remplissage
  ctx.beginPath(); let fi = true;
  for (let i = minB; i <= maxB; i++) {
    const x = P.l + (freqsRpm[i]-zMin)/span*pW;
    const y = P.t + pH - amps[i]*aS;
    if (fi) { ctx.moveTo(x, P.t+pH); ctx.lineTo(x, y); fi=false; } else ctx.lineTo(x, y);
  }
  if (!fi) {
    const xLast = P.l + (freqsRpm[maxB]-zMin)/span*pW;
    ctx.lineTo(xLast, P.t+pH); ctx.closePath();
    ctx.fillStyle = 'rgba(199,80,0,0.07)'; ctx.fill();
  }
  // Tracé
  ctx.strokeStyle = '#c75000'; ctx.lineWidth = 1.3;
  ctx.beginPath(); fi = true;
  for (let i = minB; i <= maxB; i++) {
    const x = P.l + (freqsRpm[i]-zMin)/span*pW;
    const y = P.t + pH - amps[i]*aS;
    if (fi) { ctx.moveTo(x, y); fi=false; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.restore(); // fin clip

  // ── Cadre axes ────────────────────────────────────────
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(P.l, P.t, pW, pH);

  // ── Curseur tactile simple ────────────────────────────
  if (anCursorX >= P.l && anCursorX <= P.l+pW) {
    const curRpm = zMin + ((anCursorX-P.l)/pW)*span;
    const idx = Math.max(0, Math.min(freqsRpm.length-1, Math.round(curRpm/rpmPerBin)));
    const cx  = P.l + (freqsRpm[idx]-zMin)/span*pW;

    ctx.save();
    ctx.strokeStyle = '#cc0000'; ctx.lineWidth = 1; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.moveTo(cx, P.t); ctx.lineTo(cx, P.t+pH); ctx.stroke();
    ctx.setLineDash([]);
    const lines = [freqsRpm[idx].toFixed(0)+' RPM', amps[idx].toFixed(5)];
    ctx.font = 'bold 10px Arial';
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
    const bw = tw+8, bh = lines.length*13+5;
    const lx = (cx+bw+5 > W-P.r) ? cx-bw-4 : cx+3;
    const ly = P.t+22;
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(lx-2, ly, bw, bh);
    ctx.strokeStyle = '#cc0000'; ctx.lineWidth = 0.7; ctx.strokeRect(lx-2, ly, bw, bh);
    ctx.fillStyle = '#cc0000'; ctx.textAlign = 'left';
    lines.forEach((l,i) => ctx.fillText(l, lx+2, ly+12+i*13));
    ctx.restore();
  }

  // ── Info bande (au-dessus du graphique) ──────────────
  ctx.fillStyle = '#555'; ctx.font = '9px Arial'; ctx.textAlign = 'left';
  const bandStr = anDemodResult.band
    ? `Bande: ${fLow.toFixed(0)}–${fHigh.toFixed(0)} Hz  (κ=${anDemodResult.band.kurt.toFixed(1)})`
    : `Bande: ${fLow.toFixed(0)}–${fHigh.toFixed(0)} Hz  (défaut)`;
  ctx.fillText(`${bandStr}    RMS: ${rmsEnv.toFixed(4)} g    Crête: ${crestEnv.toFixed(2)}`,
               P.l+2, P.t-3);
}


// ============================================================
// TOUCH — pan / zoom / cursor (fonctionne pour time, fft, demod)
// ============================================================

const anWrap = document.getElementById('an-canvas-wrap');
let anTouchMode  = 'none';
let anTouchX0    = 0, anTouchY0 = 0;
let anPanMin0    = 0, anPanMax0 = 0;
let anPinD0      = 0, anPinMin0 = 0, anPinMax0 = 0;
let _anLongTimer  = null;
let _anLongStart  = 0;
let _anLongAnimId = null;
let _anLongActive = false;
const AN_PAN_THRESHOLD  = 10;
const AN_LONG_PRESS_MS  = 600;
const AN_LONG_PRESS_PX  = 15;

anWrap.addEventListener('touchstart', (e) => {
  if (!anData) return;
  // Fermer le hamburger si ouvert
  if (anHamOpen) { anToggleHam(); return; }

  if (e.touches.length === 1) {
    anTouchX0=e.touches[0].clientX; anTouchY0=e.touches[0].clientY;
    anPanMin0=anZMin; anPanMax0=anZMax;
    _anLongStart=performance.now();

    if (anMode === 'time') {
      _anLongActive=true;
      _anLongTimer=setTimeout(()=>{
        _anLongTimer=null;_anLongActive=false;_anCancelLongAnim();
        if(navigator.vibrate) navigator.vibrate(40);
        anTouchMode='sel'; anSelStart=_anTouchToTime(anTouchX0);
        anSelEnd=anSelStart; anSelecting=true; anCursorX=-1; analyseDraw();
      }, AN_LONG_PRESS_MS);
      _anLongAnimId=requestAnimationFrame(_anDrawLongPressArc);
      anTouchMode='cursor'; anSetCursorFromTouch(e.touches[0].clientX); analyseDraw();
    } else {
      // FFT ou Demod : long press → verrouiller curseur
      _anLongActive=true;
      _anLongTimer=setTimeout(()=>{
        _anLongTimer=null;_anLongActive=false;_anCancelLongAnim();
        if(navigator.vibrate) navigator.vibrate(40);
        anTouchMode='cursor_locked'; anSetCursorFromTouch(anTouchX0); analyseDraw();
      }, AN_LONG_PRESS_MS);
      _anLongAnimId=requestAnimationFrame(_anDrawLongPressArc);
      anTouchMode='wait';
    }
  } else if (e.touches.length === 2) {
    _anCancelLong();
    anTouchMode='pinch'; anCursorX=-1; anSelecting=false;
    anPinD0=anDist(e); anPinMin0=anZMin; anPinMax0=anZMax;
  }
}, {passive:true});

anWrap.addEventListener('touchmove', (e) => {
  if (!anData) return;
  const canvas=document.getElementById('an-canvas');
  const pW=canvas.width-APAD.l-APAD.r;
  const maxVal=_anMaxVal();

  if (e.touches.length === 1) {
    const dx=e.touches[0].clientX-anTouchX0;
    const dy=e.touches[0].clientY-anTouchY0;
    if(_anLongTimer && Math.sqrt(dx*dx+dy*dy)>AN_LONG_PRESS_PX){
      _anCancelLong();
      if(anTouchMode==='wait') anTouchMode='pan';
    }
    if(anTouchMode==='wait'){
      if(Math.abs(dx)>AN_PAN_THRESHOLD){_anCancelLong();anTouchMode='pan';}
      else return;
    }
    if(anTouchMode==='cursor_locked'){
      anSetCursorFromTouch(e.touches[0].clientX); analyseDraw(); return;
    }
    if(anTouchMode==='sel'){
      const t=_anTouchToTime(e.touches[0].clientX);
      const t0=_anTouchToTime(anTouchX0);
      anSelStart=Math.max(0,Math.min(t,t0)); anSelEnd=Math.min(anP.t,Math.max(t,t0));
      analyseDraw(); return;
    }
    if(anTouchMode==='cursor' && Math.abs(dx)>AN_PAN_THRESHOLD){
      _anCancelLong(); anTouchMode='pan'; anCursorX=-1;
    }
    if(anTouchMode==='pan'){
      const span0=anPanMax0-anPanMin0, dVal=-(dx/pW)*span0;
      let nMin=anPanMin0+dVal, nMax=anPanMax0+dVal;
      if(nMin<0){nMax-=nMin;nMin=0;}
      if(nMax>maxVal){nMin-=(nMax-maxVal);nMax=maxVal;}
      anZMin=Math.max(0,nMin); anZMax=Math.min(maxVal,nMax);
      analyseDraw();
    } else if(anTouchMode==='cursor'){
      anSetCursorFromTouch(e.touches[0].clientX); analyseDraw();
    }
  } else if(anTouchMode==='pinch' && e.touches.length===2){
    const ratio=anPinD0/anDist(e);
    const center=(anPinMin0+anPinMax0)/2;
    const half=(anPinMax0-anPinMin0)/2*ratio;
    anZMin=Math.max(0,center-half); anZMax=Math.min(maxVal,center+half);
    const minSpan=anMode==='time'?0.01:50;
    if(anZMax-anZMin<minSpan) anZMax=anZMin+minSpan;
    analyseDraw();
  }
},{passive:true});

anWrap.addEventListener('touchend',()=>{
  _anCancelLong();
  if(anTouchMode==='pan'){anCursorX=-1;analyseDraw();}
  if(anTouchMode==='wait'&&(anMode==='fft'||anMode==='demod')){
    anSetCursorFromTouch(anTouchX0); analyseDraw();
  }
  if(anTouchMode==='sel'){
    anSelecting=false;
    if(anSelEnd-anSelStart<0.01){anSelStart=-1;anSelEnd=-1;}
    _anUpdateSelBtn(); analyseDraw();
  }
  anTouchMode='none';
},{passive:true});

function _anCancelLong(){
  if(_anLongTimer){clearTimeout(_anLongTimer);_anLongTimer=null;}
  _anLongActive=false; _anCancelLongAnim();
}
function _anCancelLongAnim(){
  if(_anLongAnimId){cancelAnimationFrame(_anLongAnimId);_anLongAnimId=null;}
}
function _anDrawLongPressArc(){
  if(!_anLongActive) return;
  const elapsed=performance.now()-_anLongStart;
  const progress=Math.min(elapsed/AN_LONG_PRESS_MS,1);
  const canvas=document.getElementById('an-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const rect=canvas.getBoundingClientRect();
  const scaleX=canvas.width/rect.width, scaleY=canvas.height/rect.height;
  const cx=(anTouchX0-rect.left)*scaleX, cy=(anTouchY0-rect.top)*scaleY;
  const R=22;
  _anDrawOnly();
  ctx.save(); ctx.lineWidth=4;
  ctx.strokeStyle='rgba(0,0,0,0.15)';
  ctx.beginPath(); ctx.arc(cx,cy,R,0,2*Math.PI); ctx.stroke();
  ctx.strokeStyle='#cc8800';
  ctx.beginPath(); ctx.arc(cx,cy,R,-Math.PI/2,-Math.PI/2+2*Math.PI*progress); ctx.stroke();
  ctx.fillStyle='rgba(204,136,0,0.5)';
  ctx.beginPath(); ctx.arc(cx,cy,4,0,2*Math.PI); ctx.fill();
  ctx.restore();
  _anLongAnimId=requestAnimationFrame(_anDrawLongPressArc);
}
function anSetCursorFromTouch(clientX){
  const canvas=document.getElementById('an-canvas');
  const rect=canvas.getBoundingClientRect();
  const scaleX=canvas.width/rect.width;
  const px=(clientX-rect.left)*scaleX;
  const pW=canvas.width-APAD.l-APAD.r;
  anCursorX=Math.max(APAD.l,Math.min(APAD.l+pW,px));
}
function anDist(e){
  const dx=e.touches[0].clientX-e.touches[1].clientX;
  const dy=e.touches[0].clientY-e.touches[1].clientY;
  return Math.sqrt(dx*dx+dy*dy);
}
function _anTouchToTime(clientX){
  const canvas=document.getElementById('an-canvas');
  const rect=canvas.getBoundingClientRect();
  const px=clientX-rect.left;
  const pW=canvas.width-APAD.l-APAD.r;
  const t=anZMin+((px-APAD.l)/pW)*(anZMax-anZMin);
  return Math.max(0,Math.min(anP.t,t));
}
function _anUpdateSelBtn(){
  const hasSel=anSelStart>=0&&anSelEnd>anSelStart;
  const btnFFT=document.getElementById('btn-an-fft-sel');
  const btnClr=document.getElementById('btn-an-sel-clear');
  if(btnFFT) btnFFT.style.display=hasSel?'inline-block':'none';
  if(btnClr) btnClr.style.display=hasSel?'inline-block':'none';
}


// ============================================================
// BOUTONS CTRL-BAR
// ============================================================

// ── FFT toggle ────────────────────────────────────────────
function analyseToggleFFT() {
  if (!anData) return;
  if (anMode === 'time') {
    anMode='fft'; anZMin=0; anZMax=3000; anMag=null; anMagVel=null;
    anUnit='g'; anCursorX=-1;
  } else if (anMode === 'demod') {
    // Quitter démod → FFT standard
    anMode='fft'; anCursorX=-1;
    if (!anMag) { anZMin=0; anZMax=3000; }
  } else {
    // FFT → temporel
    anMode='time'; anZMin=0; anZMax=anP.t||1; anCursorX=-1;
  }
  anUpdateBtnStates();
  analyseDraw();
}

// ── Unité g / mm/s ────────────────────────────────────────
function anSetUnit(unit) {
  if (!anData) return;
  anUnit = unit;
  if (anMode !== 'fft') {
    anMode='fft'; anZMin=0; anZMax=3000; anMag=null; anMagVel=null; anCursorX=-1;
    anUpdateBtnStates(); analyseDraw(); return;
  }
  anCursorX=-1;
  if (unit === 'mm/s') {
    if (!anMagVel && anData) {
      const _s=anDataDisplay||anData;
      const chunk=(anSelStart>=0&&anSelEnd>anSelStart)
        ? _s.slice(Math.round(anSelStart*anP.fs),Math.round(anSelEnd*anP.fs)+1)
        : _s.slice(0,anP.n);
      anMagVel=computeVelFFT(chunk,anP.fs,chunk.length);
    }
    if (anMagVel) {
      const rpmPB=(anP.fs/nextPow2(anP.n))*60;
      const maxBin=Math.min(anP.n/2-1,Math.floor(fftMaxRpmVel(anP.fs)/rpmPB));
      const pk=fftPeakBin(anMagVel,maxBin);
      anZMin=0; anZMax=Math.min(Math.max(600,pk*rpmPB*4),fftMaxRpmVel(anP.fs));
    }
  } else {
    anZMax=Math.min(anZMax,fftMaxRpmG(anP.fs));
  }
  anUpdateBtnStates(); analyseDraw();
}

// ── Hamburger ─────────────────────────────────────────────
function anToggleHam() {
  anHamOpen = !anHamOpen;
  const panel = document.getElementById('an-ham-panel');
  const btn   = document.getElementById('btn-an-ham');
  if (panel) panel.style.display = anHamOpen ? 'grid' : 'none';
  if (btn)   btn.classList.toggle('active', anHamOpen);
}

// Fermer hamburger en cliquant hors
document.addEventListener('click', (e) => {
  if (!anHamOpen) return;
  const panel = document.getElementById('an-ham-panel');
  const btn   = document.getElementById('btn-an-ham');
  if (panel && btn && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    anHamOpen = false;
    panel.style.display = 'none';
    btn.classList.remove('active');
  }
});

// ── Démodulation (toggle + run) ───────────────────────────
function analyseToggleDemod() {
  if (!anData) return;
  if (anMode === 'demod') {
    anMode='fft'; anCursorX=-1;
    if (!anMag) { anZMin=0; anZMax=3000; }
    anUpdateBtnStates(); analyseDraw(); return;
  }
  analyseRunDemod();
}

// Gestion mode bande Auto / Manuel
let _demodBandMode = 'auto'; // 'auto' | 'man'

function demodSetBandMode(mode) {
  _demodBandMode = mode;
  document.getElementById('btn-demod-auto').classList.toggle('active', mode === 'auto');
  document.getElementById('btn-demod-man' ).classList.toggle('active', mode === 'man');
  document.getElementById('demod-band-fields').style.display = mode === 'man' ? 'grid' : 'none';
}

function analyseRunDemod() {
  if (!anData) { alert('Chargez un fichier dans Analyse.'); return; }

  // Vérification bande manuelle
  let manFlo = null, manFhi = null;
  if (_demodBandMode === 'man') {
    manFlo = parseFloat(document.getElementById('demod-flo').value);
    manFhi = parseFloat(document.getElementById('demod-fhi').value);
    const nyq = anP.fs / 2;
    if (isNaN(manFlo) || isNaN(manFhi) || manFlo <= 0 || manFhi <= manFlo || manFhi >= nyq) {
      alert(`Bande invalide.\nf bas doit être > 0\nf haut doit être > f bas et < ${nyq.toFixed(0)} Hz (Nyquist)`);
      return;
    }
  }

  const btn = document.getElementById('btn-an-demod');
  if (btn) { btn.textContent='⏳'; btn.disabled=true; }
  if (anHamOpen) anToggleHam();

  setTimeout(() => {
    try {
      const sig = anDataDisplay || anData;
      const fs  = anP.fs;
      // demodCompute() est défini dans demod.js
      // Si mode manuel, on passe la bande directement (bypass kurtogram)
      anDemodResult = demodCompute(sig, fs, manFlo, manFhi);
      const maxRpm = anDemodResult.freqsRpm[anDemodResult.freqsRpm.length-1];
      anZMin=0; anZMax=maxRpm;
      anMode='demod'; anCursorX=-1;
      anUpdateBtnStates();
      anUpdateStats();
      analyseDraw();
    } catch(e) {
      console.error('[demod]', e);
      alert('Erreur démodulation: '+e.message);
    } finally {
      if (btn) { btn.textContent='Démod'; btn.disabled=false; }
    }
  }, 30);
}

// ── Zoom ──────────────────────────────────────────────────
function analyseZoomIn() {
  const maxVal=_anMaxVal();
  const c=(anZMin+anZMax)/2, h=(anZMax-anZMin)/4;
  anZMin=Math.max(0,c-h); anZMax=Math.min(maxVal,c+h);
  analyseDraw();
}
function analyseZoomOut() {
  const maxVal=_anMaxVal();
  const c=(anZMin+anZMax)/2, h=(anZMax-anZMin);
  anZMin=Math.max(0,c-h); anZMax=Math.min(maxVal,c+h);
  analyseDraw();
}

// ── FFT sur sélection ─────────────────────────────────────
function analyseFFTSel() {
  if(!anData||anSelStart<0||anSelEnd<=anSelStart) return;
  const sig=anDataDisplay||anData;
  const fs=anP.fs;
  const i0=Math.max(0,Math.round(anSelStart*fs));
  const i1=Math.min(sig.length-1,Math.round(anSelEnd*fs));
  const chunk=sig.slice(i0,i1+1);
  const n=chunk.length;
  if(n<64){alert('Sélection trop courte');return;}
  anMag=computeFFT(chunk,n,fs);
  anMagVel=computeVelFFT(chunk,fs,n);
  const nFFT=nextPow2(n);
  const rpmPB=(fs/nFFT)*60;
  const minBinHP=Math.max(1,Math.ceil(HP_RPM_MIN/rpmPB));
  const pk=fftPeakBin(anMag,Math.floor(nFFT/2)-1,minBinHP);
  anZMin=HP_RPM_MIN; anZMax=Math.max(600,pk*rpmPB*4);
  anMode='fft'; anUnit='g'; anCursorX=-1;
  anUpdateBtnStates();
  const dur=(anSelEnd-anSelStart).toFixed(3);
  document.getElementById('an-fs').textContent +=
    '  [Sél: '+anSelStart.toFixed(3)+'–'+anSelEnd.toFixed(3)+'s  '+dur+'s  N='+n+']';
  analyseDraw();
}

function analyseSelClear(){
  anSelStart=-1;anSelEnd=-1;anSelecting=false;
  _anUpdateSelBtn(); analyseDraw();
}

// ============================================================
// SAUVEGARDE / CHARGEMENT
// ============================================================

function analyseSave() {
  if(!anData){alert('Aucune donnée');return;}
  const nom=prompt('Nom du fichier:','acq_'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'));
  if(!nom) return;
  const scale=32768.0/anP.g;
  const raw=[];
  for(let i=0;i<anP.n;i++) raw.push(Math.round(anData[i]*scale));
  const txt='G='+anP.g+'\nF='+anP.fs+'\nT='+anP.t+'\n'+JSON.stringify(raw)+'\n';
  const blob=new Blob([txt],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=nom.endsWith('.txt')?nom:nom+'.txt';a.click();
  URL.revokeObjectURL(url);
}

function analyseExportCSV() {
  if (!anData) { alert('Aucune donnée'); return; }
  var nom = prompt('Nom du fichier:', 'export_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'));
  if (!nom) return;
  var dt = 1.0 / anP.fs;
  var lines = [];
  lines.push('# VibrationAnalyser — Export CSV');
  lines.push('# Date: ' + new Date().toISOString());
  lines.push('# Fs: ' + anP.fs + ' Hz');
  lines.push('# Duration: ' + anP.t.toFixed(6) + ' s');
  lines.push('# Samples: ' + anP.n);
  lines.push('# Range: +/-' + anP.g + ' g');
  lines.push('# Unit: g (1 g = 9.80665 m/s2)');
  lines.push('Time_s,Accel_g');
  for (var i = 0; i < anP.n; i++) {
    lines.push((i * dt).toFixed(7) + ',' + anData[i].toFixed(6));
  }
  var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = nom.endsWith('.csv') ? nom : nom + '.csv'; a.click();
  URL.revokeObjectURL(url);
}

function analyseLoad() {
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.txt,.csv';
  inp.onchange=(e)=>{
    const file=e.target.files[0];if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      const text=ev.target.result,lines=text.split('\n');
      const h={};let dataLine=null;
      for(let i=0;i<lines.length;i++){
        const l=lines[i].trim();if(!l) continue;
        if(l.startsWith('G='))   {h.g =parseFloat(l.slice(2));continue;}
        if(l.startsWith('F='))   {h.fs=parseFloat(l.slice(2));continue;}
        if(l.startsWith('T='))   {h.t =parseFloat(l.slice(2));continue;}
        if(l.startsWith('N='))   {h.n =parseInt(l.slice(2));  continue;}
        if(l.startsWith('['))    {dataLine=l;break;}
        if(!isNaN(parseFloat(l))){dataLine=l;break;}
      }
      if(!h.g||!h.fs){alert('Format invalide');return;}
      let rawArr=[];
      if(dataLine&&dataLine.startsWith('[')){
        try{rawArr=JSON.parse(dataLine);}catch(e){alert('Erreur données');return;}
      }else{
        for(let i=0;i<lines.length;i++){
          const l=lines[i].trim(),v=parseFloat(l);
          if(!isNaN(v)&&!l.includes('=')) rawArr.push(v);
        }
      }
      if(rawArr.length===0){alert('Aucune donnée');return;}
      const n=rawArr.length,scale=h.g/32768.0;
      const isInt16=Math.abs(rawArr[0])>10;
      anData=new Float64Array(n);
      for(let i=0;i<n;i++) anData[i]=isInt16?rawArr[i]*scale:rawArr[i];
      let mean=0;
      for(let i=0;i<n;i++) mean+=anData[i];mean/=n;
      for(let i=0;i<n;i++) anData[i]-=mean;
      const _fsReal=fsCorrected(h.fs);
      anP={g:h.g,fs:_fsReal,fsOrig:h.fs,t:h.t||(n/_fsReal),n};
      anUpdateStats();
      if(_wavSource) analysePause();
      anMode='time';anZMin=0;anZMax=anP.t;anMag=null;anMagVel=null;anCursorX=-1;
      anUnit='g';anDataDisplay=null;anFilterInfo='';
      anDemodResult=null;
      anSelStart=-1;anSelEnd=-1;_anUpdateSelBtn();
      anUpdateBtnStates();
      showTab('analyse');analyseDraw();
      _anPersistSave();
    };
    reader.readAsText(file);
  };
  inp.click();
}

// ── Helpers calcul ────────────────────────────────────────
function anCalcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];return Math.sqrt(s/d.length);}
function anCalcPeak(d){let m=0;for(let i=0;i<d.length;i++)if(Math.abs(d[i])>m)m=Math.abs(d[i]);return m;}

// ============================================================
// EXPORT WAV + PLAYBACK
// ============================================================

function _wavGetSignal(){
  const sig=anDataDisplay||anData;
  const n=sig.length;
  let maxAbs=0;
  for(let i=0;i<n;i++) if(Math.abs(sig[i])>maxAbs) maxAbs=Math.abs(sig[i]);
  const scale=maxAbs>0?1/maxAbs:1;
  const out=new Float32Array(n);
  for(let i=0;i<n;i++) out[i]=sig[i]*scale;
  return out;
}

let _wavCtx=null,_wavSource=null;

function analysePlay(){
  if(!anData){alert('Aucune donnée');return;}
  if(_wavSource){analysePause();return;}
  _wavCtx=_wavCtx||new(window.AudioContext||window.webkitAudioContext)();
  const f32=_wavGetSignal();
  const buf=_wavCtx.createBuffer(1,f32.length,anP.fs);
  buf.copyToChannel(f32,0);
  _wavSource=_wavCtx.createBufferSource();
  _wavSource.buffer=buf;
  _wavSource.connect(_wavCtx.destination);
  _wavSource.onended=_wavPlaybackEnded;
  _wavSource.start();
  document.getElementById('btn-an-play').textContent='⏹ Stop';
  document.getElementById('btn-an-play').classList.add('running');
}
function analysePause(){
  if(_wavSource){_wavSource.onended=null;_wavSource.stop();_wavSource.disconnect();_wavSource=null;}
  _wavPlaybackEnded();
}
function _wavPlaybackEnded(){
  _wavSource=null;
  const btn=document.getElementById('btn-an-play');
  if(btn){btn.textContent='▶ Play';btn.classList.remove('running');}
}

function analyseExportWAV(){
  if(!anData){alert('Aucune donnée');return;}
  const labelFilt=anDataDisplay?'_filtre':'';
  const defNom='acq'+labelFilt+'_'+anP.fs+'Hz';
  const nom=prompt('Nom du fichier WAV:',defNom);
  if(!nom) return;
  const sig=anDataDisplay||anData,n=sig.length,fs=anP.fs;
  const f32=_wavGetSignal(),scale=32767;
  const buf=new ArrayBuffer(44+n*2),view=new DataView(buf),u8=new Uint8Array(buf);
  const ws=(off,s)=>{for(let i=0;i<s.length;i++)u8[off+i]=s.charCodeAt(i);};
  ws(0,'RIFF');view.setUint32(4,36+n*2,true);
  ws(8,'WAVE');ws(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,1,true);view.setUint32(24,fs,true);
  view.setUint32(28,fs*2,true);view.setUint16(32,2,true);
  view.setUint16(34,16,true);ws(36,'data');
  view.setUint32(40,n*2,true);
  for(let i=0;i<n;i++)
    view.setInt16(44+i*2,Math.max(-32768,Math.min(32767,Math.round(f32[i]*scale))),true);
  const fname=nom.endsWith('.wav')?nom:nom+'.wav';
  const blob=new Blob([buf],{type:'audio/wav'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=fname;a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// FILTRE FRÉQUENTIEL
// ============================================================

let anDataDisplay=null;
let anFilterInfo='';

function analyseFilter(){
  if(!anData){alert('Aucune donnée');return;}
  const type=prompt('Type de filtre:\n  ph → Passe-Haut\n  pb → Passe-Bas\n  bp → Passe-Bande\n\nEntrez ph, pb ou bp :','ph');
  if(!type) return;
  const t=type.trim().toLowerCase();
  if(!['ph','pb','bp'].includes(t)){alert('Type invalide');return;}
  const nyq=anP.fs/2;
  let f1=null,f2=null;
  if(t==='ph'||t==='pb'){
    const fc=prompt((t==='ph'?'Passe-Haut':'Passe-Bas')+'\nFréquence de coupure (Hz)\nNyquist='+nyq.toFixed(0)+' Hz:',t==='ph'?'10':(nyq*0.8).toFixed(0));
    if(!fc) return;
    f1=parseFloat(fc);
    if(isNaN(f1)||f1<=0||f1>=nyq){alert('Fréquence invalide');return;}
  }else{
    const range=prompt('Passe-Bande\nf_basse f_haute (Hz)\nNyquist='+nyq.toFixed(0)+' Hz\nEx: 100 500:','100 '+(nyq*0.5).toFixed(0));
    if(!range) return;
    const parts=range.trim().split(/\s+/);
    if(parts.length<2){alert('Format: f_basse f_haute');return;}
    f1=parseFloat(parts[0]);f2=parseFloat(parts[1]);
    if(isNaN(f1)||isNaN(f2)||f1<=0||f2<=f1||f2>=nyq){alert('Fréquences invalides');return;}
  }
  anDataDisplay=applyFilter(anData,anP.fs,t,f1,f2);
  if(t==='ph')      anFilterInfo='PH '+f1.toFixed(0)+' Hz';
  else if(t==='pb') anFilterInfo='PB '+f1.toFixed(0)+' Hz';
  else              anFilterInfo='BP '+f1.toFixed(0)+'-'+f2.toFixed(0)+' Hz';
  anMag=null;anMagVel=null;
  _anUpdateFilterLabel();
  if(anMode==='fft'){anMode='time';anZMin=0;anZMax=anP.t;anUpdateBtnStates();}
  anCursorX=-1;analyseDraw();
}

function analyseFilterReset(){
  anDataDisplay=null;anFilterInfo='';
  anMag=null;anMagVel=null;
  _anUpdateFilterLabel();anCursorX=-1;analyseDraw();
}

function _anUpdateFilterLabel(){
  const el=document.getElementById('an-filter-label');
  if(!el) return;
  if(anFilterInfo){
    el.textContent='⚡ '+anFilterInfo;el.style.display='inline';
    const r=document.getElementById('btn-an-reset');
    if(r) r.style.display='inline-block';
  }else{
    el.textContent='';el.style.display='none';
    const r=document.getElementById('btn-an-reset');
    if(r) r.style.display='none';
  }
}

function applyFilter(sig,fs,type,f1,f2){
  const n=sig.length,nFFT=nextPow2(n),df=fs/nFFT;
  const re=new Float64Array(nFFT),im=new Float64Array(nFFT);
  for(let i=0;i<n;i++) re[i]=sig[i];
  fftRaw(re,im,nFFT);
  const trans=(f)=>Math.max(f*0.05,df*2);
  for(let k=0;k<=nFFT/2;k++){
    const f=k*df;let gain=0;
    if(type==='pb'){
      const bw=trans(f1);
      if(f<=f1-bw/2)      gain=1;
      else if(f<=f1+bw/2) gain=0.5+0.5*Math.cos(Math.PI*(f-(f1-bw/2))/bw);
    }else if(type==='ph'){
      const bw=trans(f1);
      if(f>=f1+bw/2)      gain=1;
      else if(f>=f1-bw/2) gain=0.5-0.5*Math.cos(Math.PI*(f-(f1-bw/2))/bw);
    }else{
      const bw1=trans(f1),bw2=trans(f2);
      let gainH,gainL;
      if(f>=f1+bw1/2)      gainH=1;
      else if(f>=f1-bw1/2) gainH=0.5-0.5*Math.cos(Math.PI*(f-(f1-bw1/2))/bw1);
      else                  gainH=0;
      if(f<=f2-bw2/2)      gainL=1;
      else if(f<=f2+bw2/2) gainL=0.5+0.5*Math.cos(Math.PI*(f-(f2-bw2/2))/bw2);
      else                  gainL=0;
      gain=gainH*gainL;
    }
    re[k]*=gain;im[k]*=gain;
    if(k>0&&k<nFFT/2){re[nFFT-k]*=gain;im[nFFT-k]*=gain;}
  }
  for(let i=0;i<nFFT;i++) im[i]=-im[i];
  fftRaw(re,im,nFFT);
  const out=new Float64Array(n);
  let mean=0;
  for(let i=0;i<n;i++){out[i]=re[i]/nFFT;mean+=out[i];}
  mean/=n;
  for(let i=0;i<n;i++) out[i]-=mean;
  return out;
}
