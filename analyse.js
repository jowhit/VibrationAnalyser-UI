// analyse.js — Analyse temporelle + FFT + Démodulation enveloppe
// Modes : anMode = 'time' | 'fft' | 'demod' | 'bump_wait' | 'bump_stream'
let anData = null;
let anDataB = null; // 2e sonde (mode DOUBLE) — même G/Fs
let anP    = { g:2, fs:1000, n:0, t:0 };
let _anDualArm = false;
let _anGotA = false;
let _anGotB = false;

// Couleurs fixes A/B — tous modes (temps, FFT g/mm/s, démod, bump live)
const AN_COLOR_A = '#0033cc';
const AN_COLOR_B = '#e67e22';
const AN_FILL_A  = 'rgba(0,51,204,0.07)';
const AN_FILL_B  = 'rgba(230,126,34,0.07)';

/** Slot primaire (anData) = sonde B en mono B (routage WS). */
function _anPrimaryTag() {
  if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) return 'B';
  return 'A';
}
function _anPrimaryColor() {
  return _anPrimaryTag() === 'B' ? AN_COLOR_B : AN_COLOR_A;
}
function _anPrimaryFill() {
  return _anPrimaryTag() === 'B' ? AN_FILL_B : AN_FILL_A;
}
function _anIsDualUi() {
  return (typeof DualSession !== 'undefined' && DualSession.is()) ||
         !!_anDualArm || !!(anDataB && anDataB.length);
}

let anMagB = null;
let anMagVelB = null;
let anMagDisp = null;
let anMagDispB = null;
let anDemodResultB = null;
let anDataDisplayB = null;
/** Caches temporel intégré (mm/s, mm) — invalidés avec filtre / nouvelle acquis. */
let anDataVel = null, anDataVelB = null;
let anDataDispMm = null, anDataDispMmB = null;

// Visibilité traces A/B (hamburger 👁) — indépendante du flush données
let anShowA = true;
let anShowB = true;

function analyseToggleVis(which) {
  if (which === 'A') anShowA = !anShowA;
  else if (which === 'B') anShowB = !anShowB;
  // Au moins une visible si les deux existent
  if (!anShowA && !anShowB) {
    if (which === 'A') anShowB = true;
    else anShowA = true;
  }
  _anUpdateVisBtns();
  analyseDraw();
}
window.analyseToggleVis = analyseToggleVis;

function _anUpdateVisBtns() {
  const ba = document.getElementById('btn-an-vis-a');
  const bb = document.getElementById('btn-an-vis-b');
  // Bouton B visible dès session DOUBLE (pas seulement quand la trame B arrive)
  const dualUi = _anIsDualUi();
  const monoB = (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB());
  if (ba) {
    // Ne pas toucher style.color (CSS .active = texte blanc sur fond bleu)
    ba.textContent = monoB && !dualUi ? '👁 B' : '👁 A';
    ba.classList.toggle('active', anShowA);
    ba.classList.toggle('off', !anShowA);
  }
  if (bb) {
    bb.textContent = '👁 B';
    bb.style.display = dualUi ? '' : 'none';
    bb.classList.toggle('active', anShowB && dualUi);
    bb.classList.toggle('off', !anShowB || !dualUi);
  }
}

function _anVisA() { return anShowA && anData; }
function _anVisB() { return anShowB && anDataB && anDataB.length; }

/**
 * Choix sonde pour Play / WAV / Sauv / CSV.
 * DOUBLE : A | B | 2 (deux fichiers séparés) — jamais un mix (décalage temporel).
 * @returns {'A'|'B'|'2'|null}
 */
function _anAskProbe(actionLabel) {
  const hasB = !!(anDataB && anDataB.length);
  if (!hasB) return 'A';
  const raw = prompt(
    actionLabel + ' — quelle sonde ?\n' +
    '  A  = sonde A (bleu)\n' +
    '  B  = sonde B (orange)\n' +
    '  2  = deux fichiers séparés (_A et _B)\n\n' +
    '(Pas de mix stéréo : A et B ne sont pas synchrones.)',
    'A'
  );
  if (raw === null) return null;
  const c = String(raw).trim().toUpperCase();
  if (c === 'B') return 'B';
  if (c === '2' || c === 'AB' || c === 'A+B') return '2';
  return 'A';
}

function _anSigForProbe(probe) {
  if (probe === 'B') {
    if (!anDataB || !anDataB.length) return null;
    return { sig: anDataDisplayB || anDataB, tag: 'B', filt: !!anDataDisplayB };
  }
  if (!anData) return null;
  return { sig: anDataDisplay || anData, tag: 'A', filt: !!anDataDisplay };
}

/** Efface sonde B + caches FFT/démod B. */
function analyseFlushB() {
  anDataB = null;
  anDataDisplayB = null;
  anMagB = null;
  anMagVelB = null;
  anDemodResultB = null;
  _anGotB = false;
}
window.analyseFlushB = analyseFlushB;

/**
 * Fin de session DOUBLE / changement de module.
 * À appeler à chaque WS_GOTO (live, bump, harm, balance, term…)
 * pour ne jamais garder une vieille trace B.
 */
function analyseResetDualSession() {
  if (typeof AnalSession !== 'undefined') AnalSession.reset(true);
  _anDualArm = false;
  _anGotA = false;
  analyseFlushB();
  if (typeof DualSession !== 'undefined') DualSession.end();
  _anUpdateVisBtns();
}
window.analyseResetDualSession = analyseResetDualSession;

/** Appelé juste avant ANAL_START / bump STOP — réarme session DOUBLE si 2 ESP. */
function analyseArmDual() {
  analyseFlushB();
  _anGotA = false;
  _anGotB = false;
  _anDualArm = (typeof DualSession !== 'undefined')
    ? DualSession.begin()
    : (typeof isDualMode === 'function' && isDualMode());
  _anUpdateVisBtns();
}
window.analyseArmDual = analyseArmDual;

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
let anMode = 'time'; // 'time' | 'fft' | 'demod' | 'bump_wait' | 'bump_stream'
let anMag  = null;
let anZMin = 0, anZMax = 1;
/** Zoom vertical temporel (>1 = zoom in). anYPan = décalage du centre (g). */
let anYZoom = 1;
let anYPan = 0;
/** Dernière plage Y pleine (sans zoom) — pour clamp pan / scrollbar. */
let _anYBaseMid = 0;
let _anYFullHalf = 1;
const AN_YZOOM_FACTOR = 1.25;
const AN_YZOOM_MIN = 0.2;
const AN_YZOOM_MAX = 50;
let anCursorX = -1;
/** Curseurs temporels : {t, amp} | null — clic1 puis clic2 → Δt / RPM */
let anTimeC1 = null;
let anTimeC2 = null;
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
let bumpWindowB    = null;
let bumpWriteHeadB = 0;
let bumpFilledB    = false;
const BUMP_LIVE_HZ = 50;
let _bumpRaf       = null;

function _bumpResetLive() {
  bumpWindow = null;
  bumpWindowSize = 0;
  bumpWriteHead = 0;
  bumpFilled = false;
  bumpWindowB = null;
  bumpWriteHeadB = 0;
  bumpFilledB = false;
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
  if (anUnit === 'g') return fftMaxRpmG(anP.fs);
  return (typeof fftMaxRpmVel === 'function') ? fftMaxRpmVel(anP.fs) : fftMaxRpmG(anP.fs);
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
    // Recaler durée ESP sans rebond du cadran (2e ACQ_PROGRESS quasi identique)
    const sameFs = !opts.fsHz || opts.fsHz === _acqMeta.fs;
    const sameN = !opts.n || opts.n === _acqMeta.n;
    if (sameFs && sameN && Math.abs(opts.durMs - _acqDurMs) < 800) {
      _acqDurMs = opts.durMs;
      if (opts.g) _acqMeta.g = opts.g;
      return;
    }
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

let _acqStuckTimer = null;

function acqHideProgress() {
  _acqActive = false;
  _acqTransfer = false;
  if (_acqStuckTimer) { clearTimeout(_acqStuckTimer); _acqStuckTimer = null; }
  if (_acqRaf) { cancelAnimationFrame(_acqRaf); _acqRaf = null; }
  const ov = document.getElementById('an-acq-overlay');
  if (ov) { ov.style.display = 'none'; ov.setAttribute('aria-hidden', 'true'); }
  const ring = document.getElementById('an-acq-ring');
  if (ring) {
    const ctx = ring.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, ring.width, ring.height);
  }
}

function _acqArmStuckWatch() {
  if (_acqStuckTimer) clearTimeout(_acqStuckTimer);
  _acqStuckTimer = setTimeout(function () {
    _acqStuckTimer = null;
    if (!_acqActive) return;
    if (typeof termAddLine === 'function') {
      termAddLine('!! Acquisition bloquée (pas de données) — abandon', 'sys');
    }
    acqHideProgress();
  }, 90000);
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
  // Ne pas basculer en « transfert » juste parce que l'estimé est fini —
  // sinon A fait le tour puis attend, B (sans ACQ_PROGRESS) coupe à ~1/3.
  // Transfert = acqSetTransferPhase() (duo SEND) ou hide à la réception.
  if (!_acqTransfer && elapsed >= _acqDurMs && !_acqStuckTimer) {
    _acqArmStuckWatch();
  }
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

// bumpStart / bumpSendStart / bumpExit → bump-session.js (BumpSession)

function _bumpPushLive(rawVal, isB) {
  const T = _bumpWindowT();
  const target = Math.max(32, Math.floor(T * BUMP_LIVE_HZ));
  const v = Number(rawVal) || 0;
  const gVal = v * (bumpLiveG / 32768.0);

  if (isB) {
    if (!bumpWindowB || bumpWindowB.length !== target) {
      bumpWindowB = new Float32Array(target);
      bumpWriteHeadB = 0;
      bumpFilledB = false;
    }
    bumpWindowB[bumpWriteHeadB] = gVal;
    bumpWriteHeadB = (bumpWriteHeadB + 1) % bumpWindowB.length;
    if (bumpWriteHeadB === 0) bumpFilledB = true;
  } else {
    if (!bumpWindow || bumpWindow.length !== target) {
      bumpWindow = new Float32Array(target);
      bumpWindowSize = target;
      bumpWriteHead = 0;
      bumpFilled = false;
    }
    bumpWindow[bumpWriteHead] = gVal;
    bumpWriteHead = (bumpWriteHead + 1) % bumpWindowSize;
    if (bumpWriteHead === 0) bumpFilled = true;
  }

  if (anMode === 'bump_wait' || anMode === 'bump_stream') {
    if (anMode === 'bump_wait') anMode = 'bump_stream';
    if (!_bumpRaf) _bumpStartAnim();
  }
  if (typeof BumpSession !== 'undefined' && BumpSession.onLive) BumpSession.onLive();
}

function bumpReceiveLive(rawVal) {
  _bumpPushLive(rawVal, false);
}
function bumpReceiveLiveB(rawVal) {
  _bumpPushLive(rawVal, true);
}
window.bumpReceiveLive = bumpReceiveLive;
window.bumpReceiveLiveB = bumpReceiveLiveB;

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

// bumpExit → bump-session.js

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

  function _strokeBumpWin(win, head, filled, color) {
    if (!win || !win.length) return;
    const n = win.length;
    const count = filled ? n : head;
    if (count === 0) return;
    const readStart = filled ? head : 0;
    const xDenom = Math.max(1, n - 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let j = 0; j < count; j++) {
      const idx = (readStart + j) % n;
      const x = P.l + (j / xDenom) * pW;
      const y = P.t + pH / 2 - (win[idx] / ymax) * pH / 2;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(P.l, P.t, pW, pH); ctx.clip();
  const dualBump = !!(bumpWindowB && bumpWindowB.length);
  const drawA = anShowA && bumpWindow && bumpWindow.length;
  const drawB = anShowB && bumpWindowB && bumpWindowB.length;
  if (drawA) {
    _strokeBumpWin(bumpWindow, bumpWriteHead, bumpFilled,
      dualBump ? AN_COLOR_A : _anPrimaryColor());
  }
  if (drawB) {
    _strokeBumpWin(bumpWindowB, bumpWriteHeadB, bumpFilledB, AN_COLOR_B);
  }
  ctx.restore();

  // Légende
  ctx.font = 'bold 10px Arial';
  ctx.textAlign = 'left';
  if (dualBump) {
    ctx.fillStyle = drawA ? AN_COLOR_A : '#bbb';
    ctx.fillText('A', P.l + 6, P.t + 12);
    ctx.fillStyle = drawB ? AN_COLOR_B : '#bbb';
    ctx.fillText('B', P.l + 28, P.t + 12);
  } else {
    ctx.fillStyle = drawA ? _anPrimaryColor() : '#bbb';
    ctx.fillText(_anPrimaryTag(), P.l + 6, P.t + 12);
  }
}

function _analyseFillFloat(raw, g, n) {
  const scale = g / 32768.0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i] * scale;
  return out;
}

function _analyseAfterReceive(t, fromB) {
  if (_wavSource) analysePause();
  anMode = 'time'; anZMin = 0; anZMax = t; anYZoom = 1; anYPan = 0;
  anMag = null; anMagVel = null; anMagDisp = null;
  anMagB = null; anMagVelB = null; anMagDispB = null; anCursorX = -1;
  _anClearTimeCursors();
  anUnit = 'g'; anDataDisplay = null; anDataDisplayB = null; anFilterInfo = '';
  _anInvalidateTimeIntegrated();
  anDemodResult = null; anDemodResultB = null;
  anSelStart = -1; anSelEnd = -1; _anUpdateSelBtn();
  anApplyLayoutByMode();
  anUpdateBtnStates();
  showTab('analyse');
  anUpdateStats();
  analyseDraw();
  if (!fromB) _anPersistSave();
}

/** DOUBLE temporel : afficher A+B ensemble (pas A seul puis B en retard). */
let _anDualDrawTimer = null;
const AN_DUAL_DRAW_WAIT_MS = 45000; // transfert B peut prendre longtemps (WiFi séquentiel)

function _anCancelDualDrawWait() {
  if (_anDualDrawTimer) {
    clearTimeout(_anDualDrawTimer);
    _anDualDrawTimer = null;
  }
}

function _anShowDualWaitStatus() {
  const st = document.getElementById('an-status') || document.getElementById('an-fs');
  const msg = _anGotA && !_anGotB
    ? 'A reçu, attente B…'
    : (!_anGotA && _anGotB
      ? 'B reçu, attente A…'
      : 'réception A+B…');
  if (st) st.textContent = 'DOUBLE — ' + msg;
  // Éviter le spam « DOUBLE DOUBLE — … » dans le terminal
  if (typeof termAddLine === 'function') termAddLine('[DOUBLE] ' + msg, 'sys');
}

function _anTryDualDraw(forceAlone) {
  if (!_anDualArm) {
    _anCancelDualDrawWait();
    if (anData && anData.length) _analyseAfterReceive(anP.t, false);
    return;
  }
  if (_anGotA && _anGotB) {
    _anCancelDualDrawWait();
    _analyseAfterReceive(anP.t, false);
    return;
  }
  if (forceAlone && _anGotA) {
    _anCancelDualDrawWait();
    if (typeof termAddLine === 'function') {
      termAddLine('[DOUBLE] timeout B — affichage A seul', 'sys');
    }
    _analyseAfterReceive(anP.t, false);
  }
}

// ── Réception depuis app.js (ESP A) ───────────────────────
function analyseReceiveBloc(g, fs, t, n, raw) {
  acqHideProgress();
  bumpLiveRunning = false;
  _bumpStopAnim();
  _bumpResetLive();
  bumpLiveG = g;
  const btn = document.getElementById('btn-bump-start');
  if (btn) {
    btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
    btn.classList.add('bal-btn-run');
    btn.classList.remove('bal-btn-stop');
  }
  anP = { g, fs, t, n };
  anData = _analyseFillFloat(raw, g, n);
  _anGotA = true;
  // Hors dual (ex. bump) : jamais garder un vieux B
  if (!_anDualArm) analyseFlushB();
  if (typeof BumpSession !== 'undefined' && BumpSession.onBinaryA) BumpSession.onBinaryA();

  // Duo temporel : attendre A+B avant d'afficher (évite A seul puis B en retard).
  // Bump WAIT_BINARY : afficher A tout de suite (live déjà figé).
  const bumpBin = (typeof BumpSession !== 'undefined' &&
    BumpSession.getState && BumpSession.getState() === 'WAIT_BINARY');
  if (_anDualArm && !bumpBin) {
    _anShowDualWaitStatus();
    _anCancelDualDrawWait();
    _anDualDrawTimer = setTimeout(function () { _anTryDualDraw(true); }, AN_DUAL_DRAW_WAIT_MS);
    _anTryDualDraw(false);
  } else {
    _analyseAfterReceive(t, false);
  }
}

/** Réception ESP B (mode DOUBLE) — même G/Fs attendus. */
function analyseReceiveBlocB(g, fs, t, n, raw) {
  if (!anData || !_anDualArm) {
    // B arrivé avant A ou hors dual : stocker comme référence secondaire
    if (!anData) {
      anP = { g, fs, t, n };
    }
  } else if (Math.abs(fs - anP.fs) > 1 || g !== anP.g) {
    if (typeof termAddLine === 'function') {
      termAddLine('[B] !! G/Fs différent de A (A: ' + anP.g + 'g/' + anP.fs +
        '  B: ' + g + 'g/' + fs + ') — affichage quand même', 'sys');
    }
  }
  anDataB = _analyseFillFloat(raw, g, Math.min(n, raw.length));
  anDataDisplayB = null;
  anMagB = null; anMagVelB = null; anMagDispB = null; anDemodResultB = null;
  anDataVelB = null; anDataDispMmB = null;
  _anGotB = true;
  if (typeof termAddLine === 'function') {
    termAddLine('[B] acquis. reçue' + (_anGotA ? ' — DOUBLE OK' : ' — attente A…'), 'sys');
  }
  if (typeof BumpSession !== 'undefined' && BumpSession.onBinaryB) BumpSession.onBinaryB();
  const bumpBinB = (typeof BumpSession !== 'undefined' &&
    BumpSession.getState && BumpSession.getState() === 'WAIT_BINARY');
  if (_anDualArm) {
    if (_anGotA) {
      _anTryDualDraw(false);
    } else if (bumpBinB) {
      // Bump : B avant A — montrer B en attendant
      bumpLiveRunning = false;
      _bumpStopAnim();
      anMode = 'time';
      anZMin = 0;
      anZMax = t || (anP && anP.t) || 1;
      anApplyLayoutByMode();
      anUpdateBtnStates();
      showTab('analyse');
      anUpdateStats();
      analyseDraw();
      _anShowDualWaitStatus();
    } else {
      // Temporel duo : B avant A — ne pas dessiner B seul (évite décalage perçu)
      _anShowDualWaitStatus();
    }
  } else if (anData && anData.length) {
    anUpdateStats();
    analyseDraw();
  } else if (!anP.n) {
    anP = { g, fs, t, n };
  }
}
window.analyseReceiveBlocB = analyseReceiveBlocB;

// ── Gestion états boutons ─────────────────────────────────
function anUpdateBtnStates() {
  const inTime  = anMode === 'time';
  const inFFT   = anMode === 'fft';
  const inDemod = anMode === 'demod';
  _btnSet('btn-an-time',  inTime);
  _btnSet('btn-an-fft',   inFFT || inDemod);
  _btnSet('btn-an-g',     anUnit === 'g');
  _btnSet('btn-an-vel',   anUnit === 'mm/s');
  _btnSet('btn-an-disp',  anUnit === 'mm');
  _btnSet('btn-an-demod', inDemod);
}

function _anUnitLabel() {
  if (typeof t === 'function') {
    if (anUnit === 'mm/s') return t('an.unit.vel');
    if (anUnit === 'mm') return t('an.unit.disp');
    return t('an.unit.g');
  }
  if (anUnit === 'mm/s') return 'Vitesse (mm/s)';
  if (anUnit === 'mm') return 'Déplacement (mm)';
  return 'Amplitude (g)';
}
function _anUnitShort() {
  if (anUnit === 'mm/s') return 'mm/s';
  if (anUnit === 'mm') return 'mm';
  return 'g';
}

/** Signal temporel A/B selon unité (g brut ou intégré). */
function _anTimeSigA() {
  if (anUnit === 'mm/s') return anDataVel || anDataDisplay || anData;
  if (anUnit === 'mm') return anDataDispMm || anDataDisplay || anData;
  return anDataDisplay || anData;
}
function _anTimeSigB() {
  if (anUnit === 'mm/s') return anDataVelB || anDataDisplayB || anDataB;
  if (anUnit === 'mm') return anDataDispMmB || anDataDisplayB || anDataB;
  return anDataDisplayB || anDataB;
}

function _anInvalidateTimeIntegrated() {
  anDataVel = null; anDataVelB = null;
  anDataDispMm = null; anDataDispMmB = null;
}

function _anEnsureTimeIntegrated() {
  if (anUnit !== 'mm/s' && anUnit !== 'mm') return;
  const fs = anP.fs;
  const srcA = anDataDisplay || anData;
  if (srcA && srcA.length) {
    const n = Math.min(anP.n || srcA.length, srcA.length);
    if (anUnit === 'mm/s' && !anDataVel && typeof integrateAccelToVel === 'function') {
      anDataVel = integrateAccelToVel(srcA, fs, n);
    }
    if (anUnit === 'mm' && !anDataDispMm && typeof integrateAccelToDisp === 'function') {
      anDataDispMm = integrateAccelToDisp(srcA, fs, n);
    }
  }
  const srcB = anDataDisplayB || anDataB;
  if (srcB && srcB.length) {
    const nB = Math.min(srcB.length, anP.n || srcB.length);
    if (anUnit === 'mm/s' && !anDataVelB && typeof integrateAccelToVel === 'function') {
      anDataVelB = integrateAccelToVel(srcB, fs, nB);
    }
    if (anUnit === 'mm' && !anDataDispMmB && typeof integrateAccelToDisp === 'function') {
      anDataDispMmB = integrateAccelToDisp(srcB, fs, nB);
    }
  }
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

  } else if (anMode === 'fft' && (anUnit === 'g' || anUnit === 'mm') && anMag) {
    _anEnsureFftA();
    const mag = _anPickMag(anMag, anMagVel, anMagDisp) || anMag;
    const u = _anUnitShort();
    const nFFT  = mag.length * 2;
    const rpmPB = (anP.fs / nFFT) * 60;
    const maxB  = Math.min(mag.length-1, Math.floor(_anMaxVal()/rpmPB));
    let pkBin=0, pkAmp=0;
    for (let i=1;i<=maxB;i++) if(mag[i]>pkAmp){pkAmp=mag[i];pkBin=i;}
    let rmsS=0;
    for (let i=1;i<=maxB;i++) rmsS+=mag[i]*mag[i];
    rmsS=Math.sqrt(rmsS*2);
    const dec = anUnit === 'g' ? 4 : 3;
    document.getElementById('an-rms').textContent   = rmsS.toFixed(dec)+' '+u;
    document.getElementById('an-peak').textContent  = pkAmp.toFixed(dec)+' '+u;
    document.getElementById('an-crest').textContent = (rmsS>0?pkAmp/rmsS:0).toFixed(2);
    document.getElementById('an-fs').textContent    =
      anP.fs+' Hz  N='+anP.n+'  T='+anP.t.toFixed(3)+'s  ±'+anP.g+'g';

  } else {
    // Temporel (g / mm/s / mm)
    _anEnsureTimeIntegrated();
    const tSig = _anTimeSigA() || sig;
    const u = _anUnitShort();
    const dec = anUnit === 'g' ? 4 : 3;
    const rms  = anCalcRMS(tSig);
    const peak = anCalcPeak(tSig);
    document.getElementById('an-rms').textContent   = rms.toFixed(dec)+' '+u;
    document.getElementById('an-peak').textContent  = peak.toFixed(dec)+' '+u;
    document.getElementById('an-crest').textContent = (peak/rms).toFixed(2);
    let dual = '';
    if (anDataB && anDataB.length) {
      const tSigB = _anTimeSigB();
      if (anUnit === 'g') {
        const meanA = anCalcMean(tSig);
        const meanB = anCalcMean(tSigB);
        dual = '  |  Ā=' + meanA.toFixed(2) + 'g  B̄=' + meanB.toFixed(2) + 'g';
      }
      dual += '  B RMS ' + anCalcRMS(tSigB).toFixed(dec) + ' ' + u;
    }
    document.getElementById('an-fs').textContent    =
      anP.fs+' Hz  N='+anP.n+'  T='+anP.t.toFixed(3)+'s  ±'+anP.g+'g' +
      (anDataB && anDataB.length ? '  DOUBLE' : '') + dual;
  }
}

// ── Dessin principal ──────────────────────────────────────
function analyseDraw() {
  _anUpdateVisBtns();
  if (anMode === 'bump_wait' || anMode === 'bump_stream') {
    anApplyLayoutByMode();
    anDrawBumpLive();
    if (typeof _anSyncHScroll === 'function') _anSyncHScroll();
    if (typeof _anSyncVScroll === 'function') _anSyncVScroll();
    return;
  }
  if (!anData) return;
  anApplyLayoutByMode();
  if      (anMode === 'time')  anDrawTime();
  else if (anMode === 'fft')   anDrawFFT();
  else if (anMode === 'demod') anDrawDemod();
  anUpdateStats();
  if (typeof _anSyncHScroll === 'function') _anSyncHScroll();
  if (typeof _anSyncVScroll === 'function') _anSyncVScroll();
}
function _anDrawOnly() {
  if (!anData) return;
  if      (anMode === 'time')  anDrawTime();
  else if (anMode === 'fft')   anDrawFFT();
  else if (anMode === 'demod') anDrawDemod();
}

// ─────────────────────────────────────────────────────────
// CURSEUR TEMPOREL (1 ou 2 points → Δt / RPM)
// ─────────────────────────────────────────────────────────
function anDrawCursor(ctx, xPx, val, amp, unit, pH, W, color, tag) {
  color = color || '#cc0000';
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(xPx, APAD.t); ctx.lineTo(xPx, APAD.t + pH); ctx.stroke();
  ctx.setLineDash([]);
  const prefix = tag ? (tag + ' ') : '';
  const uAmp = (typeof _anUnitShort === 'function') ? _anUnitShort() : 'g';
  const aDec = (uAmp === 'g') ? 4 : 3;
  const label = prefix + val.toFixed(unit === 's' ? 4 : 1) + ' ' + unit + '  ' + amp.toFixed(aDec) + ' ' + uAmp;
  ctx.font = 'bold 10px Arial';
  const tw = ctx.measureText(label).width;
  const lx = (xPx + tw + 6 > W - APAD.r) ? xPx - tw - 6 : xPx + 4;
  const ly = APAD.t + 2 + (tag === 'C2' ? 16 : 0);
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(lx - 2, ly, tw + 4, 14);
  ctx.fillStyle = color; ctx.fillText(label, lx, ly + 11);
  ctx.restore();
}

function _anClearTimeCursors() {
  anTimeC1 = null;
  anTimeC2 = null;
  _anUpdateTimeCursorBar();
}

function _anUpdateTimeCursorBar() {
  const el = document.getElementById('an-time-cursors');
  if (!el) return;
  if (anMode !== 'time' || (!anTimeC1 && !anTimeC2)) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  let html = '';
  if (anTimeC1) {
    html += '<span class="tc1">C1</span> t=' + anTimeC1.t.toFixed(4) + ' s  ' +
      anTimeC1.amp.toFixed(anUnit === 'g' ? 4 : 3) + ' ' + _anUnitShort();
  }
  if (anTimeC2) {
    html += ' &nbsp;|&nbsp; <span class="tc2">C2</span> t=' + anTimeC2.t.toFixed(4) + ' s  ' +
      anTimeC2.amp.toFixed(anUnit === 'g' ? 4 : 3) + ' ' + _anUnitShort();
    const dt = Math.abs(anTimeC2.t - anTimeC1.t);
    if (dt > 1e-9) {
      const rpm = 60 / dt;
      const hz = 1 / dt;
      html += ' &nbsp;|&nbsp; <span class="tc-delta">Δt=' + dt.toFixed(4) + ' s → ' +
        rpm.toFixed(1) + ' RPM</span> (' + hz.toFixed(2) + ' Hz)';
    }
  } else {
    html += ' <span style="color:#888">— clic 2ᵉ point pour Δt / RPM</span>';
  }
  el.innerHTML = html;
}

/** Snap au pic local (|amp| max) autour du clic. */
function _anSnapTimePeak(tClick) {
  _anEnsureTimeIntegrated();
  const sig = _anTimeSigA();
  if (!sig || !anP.fs) return { t: tClick, amp: 0 };
  const fs = anP.fs;
  const n = Math.min(anP.n, sig.length);
  let idx = Math.round(tClick * fs);
  idx = Math.max(0, Math.min(n - 1, idx));
  // fenêtre ~2 % de la vue, min 3 samples, max ~20 ms
  const span = Math.max(anZMax - anZMin, 1e-6);
  let win = Math.round(span * 0.02 * fs);
  win = Math.max(3, Math.min(win, Math.round(0.02 * fs)));
  const lo = Math.max(0, idx - win);
  const hi = Math.min(n - 1, idx + win);
  let best = idx, bestA = Math.abs(sig[idx]);
  for (let i = lo; i <= hi; i++) {
    const a = Math.abs(sig[i]);
    if (a > bestA) { bestA = a; best = i; }
  }
  return { t: best / fs, amp: sig[best], ampAbs: bestA };
}

function _anPlaceTimeCursor(clientX) {
  if (!anData || anMode !== 'time') return;
  const tRaw = _anTouchToTime(clientX);
  const pt = _anSnapTimePeak(tRaw);
  const snap = { t: pt.t, amp: pt.ampAbs };
  if (!anTimeC1 || anTimeC2) {
    // 1ʳᵉ pose, ou 3ᵉ clic → recommence à C1
    anTimeC1 = snap;
    anTimeC2 = null;
  } else {
    anTimeC2 = snap;
  }
  anCursorX = -1;
  _anUpdateTimeCursorBar();
  analyseDraw();
}

// ─────────────────────────────────────────────────────────
// CURSEUR FFT — N harmoniques + sidebands (réglages hamburger)
// ─────────────────────────────────────────────────────────
let anHarmN = 3;       // 1…10
let anSbN = 2;         // 0…5 paires
let anSbDelta = 60;    // RPM = écart porteuse → 1re sideband
/** 'harm' | 'sb' — toggle hamburger (Harm par défaut) */
let anCursorKind = 'harm';
let anSelMode = false; // drag = sélection (sans Shift)
const AN_HARM_COLS = ['#cc0000','#7700cc','#cc5500','#0066aa','#2a8a3e','#aa8800','#8e24aa','#555555','#c62828','#1565c0'];
const AN_SB_COL = '#008877';

function _anReadCursorPrefs() {
  const hn = document.getElementById('an-harm-n');
  const sn = document.getElementById('an-sb-n');
  const sd = document.getElementById('an-sb-delta');
  if (hn) {
    let v = parseInt(hn.value, 10);
    if (!Number.isFinite(v)) v = 3;
    anHarmN = Math.max(1, Math.min(10, v));
    hn.value = String(anHarmN);
  }
  if (sn) {
    let v = parseInt(sn.value, 10);
    if (!Number.isFinite(v)) v = 2;
    anSbN = Math.max(0, Math.min(5, v));
    sn.value = String(anSbN);
  }
  if (sd) {
    let v = parseFloat(sd.value);
    if (!Number.isFinite(v) || v < 1) v = 60;
    anSbDelta = v;
    sd.value = String(anSbDelta);
  }
}

function anSetCursorKind(kind) {
  anCursorKind = (kind === 'sb') ? 'sb' : 'harm';
  const bh = document.getElementById('btn-an-cur-harm');
  const bs = document.getElementById('btn-an-cur-sb');
  if (bh) bh.classList.toggle('active', anCursorKind === 'harm');
  if (bs) bs.classList.toggle('active', anCursorKind === 'sb');
  const fh = document.getElementById('an-cur-harm-fields');
  const fs = document.getElementById('an-cur-sb-fields');
  if (fh) fh.style.display = anCursorKind === 'harm' ? 'flex' : 'none';
  if (fs) fs.style.display = anCursorKind === 'sb' ? 'flex' : 'none';
  if (anCursorKind === 'sb') {
    _anReadCursorPrefs();
    if (anSbN < 1) {
      anSbN = 2;
      const sn = document.getElementById('an-sb-n');
      if (sn) sn.value = '2';
    }
  }
  if (anData && (anMode === 'fft' || anMode === 'demod')) analyseDraw();
}
window.anSetCursorKind = anSetCursorKind;

function analyseToggleSelMode() {
  anSelMode = !anSelMode;
  const btn = document.getElementById('btn-an-sel-mode');
  if (btn) btn.classList.toggle('active', anSelMode);
}
window.analyseToggleSelMode = analyseToggleSelMode;

function anDrawCursorFFT(ctx, xPx, rpm, amp, unit, pH, W, mag, rpmPB, zMin, span, pW) {
  _anReadCursorPrefs();
  const lines = [];
  if (anCursorKind === 'harm') {
    for (let m = 1; m <= anHarmN; m++) {
      lines.push({
        rpm: rpm * m,
        color: AN_HARM_COLS[(m - 1) % AN_HARM_COLS.length],
        dash: m === 1 ? [4, 3] : [5, 2],
        bold: m === 1,
        label: m + 'x',
        kind: 'harm',
      });
    }
  } else {
    // Sidebands : porteuse 1× + paires ±k·écart
    lines.push({
      rpm: rpm, color: AN_HARM_COLS[0], dash: [4, 3], bold: true,
      label: '1x', kind: 'harm',
    });
    for (let k = 1; k <= anSbN; k++) {
      const d = anSbDelta * k;
      lines.push({ rpm: rpm - d, color: AN_SB_COL, dash: [2, 3], bold: false, label: '−' + k + 'Δ', kind: 'sb' });
      lines.push({ rpm: rpm + d, color: AN_SB_COL, dash: [2, 3], bold: false, label: '+' + k + 'Δ', kind: 'sb' });
    }
  }
  ctx.save();
  let labelSlot = 0;
  lines.forEach((L) => {
    if (L.rpm < zMin || L.rpm > zMin + span) return;
    const hX = APAD.l + (L.rpm - zMin) / span * pW;
    const bin = Math.round(L.rpm / rpmPB);
    const hAmp = (mag && bin >= 1 && bin < mag.length) ? mag[bin] : amp;
    ctx.strokeStyle = L.color;
    ctx.lineWidth = L.kind === 'harm' && L.bold ? 1.4 : 1;
    ctx.setLineDash(L.dash);
    ctx.beginPath(); ctx.moveTo(hX, APAD.t); ctx.lineTo(hX, APAD.t + pH); ctx.stroke();
    ctx.setLineDash([]);
    // Labels : 1x (absolu) ; SB = écart ±RPM vs porteuse
    if (L.label === '1x' || L.label === '−1Δ' || L.label === '+1Δ') {
      let line1;
      if (L.kind === 'sb') {
        const dRpm = L.rpm - rpm;
        line1 = (dRpm >= 0 ? '+' : '') + dRpm.toFixed(0) + ' RPM';
      } else {
        line1 = L.label + ' ' + L.rpm.toFixed(0) + ' RPM';
      }
      const txt = [line1, hAmp.toFixed(L.label === '1x' ? 4 : 3) + ' ' + unit];
      ctx.font = (L.bold ? 'bold ' : '') + '9px Arial';
      const tw = Math.max(...txt.map(t => ctx.measureText(t).width));
      const bw = tw + 6, bh = txt.length * 12 + 3;
      const yOff = APAD.t + 6 + labelSlot * 28;
      labelSlot++;
      const bx = (hX + bw + 4 > W - APAD.r) ? hX - bw - 4 : hX + 3;
      ctx.fillStyle = 'rgba(255,255,220,0.92)'; ctx.fillRect(bx, yOff, bw, bh);
      ctx.strokeStyle = L.color; ctx.lineWidth = 0.7; ctx.strokeRect(bx, yOff, bw, bh);
      ctx.fillStyle = L.color; ctx.textAlign = 'left';
      txt.forEach((t, i) => ctx.fillText(t, bx + 3, yOff + 10 + i * 12));
    }
  });
  ctx.restore();
}

/** Hit-test curseur : 'carrier' | 'sb' | null (px canvas). */
function _anHitCursorFeature(px, rpmCarrier, zMin, span, pW) {
  if (anCursorX < 0 || span <= 0 || pW <= 0) return null;
  const HIT = 14;
  const carX = APAD.l + (rpmCarrier - zMin) / span * pW;
  if (Math.abs(px - carX) <= HIT) return 'carrier';
  if (anCursorKind !== 'sb') return null;
  _anReadCursorPrefs();
  for (let k = 1; k <= anSbN; k++) {
    const d = anSbDelta * k;
    const xL = APAD.l + (rpmCarrier - d - zMin) / span * pW;
    const xR = APAD.l + (rpmCarrier + d - zMin) / span * pW;
    if (Math.abs(px - xL) <= HIT || Math.abs(px - xR) <= HIT) return 'sb';
  }
  return null;
}

/** Vue FFT / démod : spectre entier (pas de zoom auto sur le pic). */
function _anZoomFullSpectrum() {
  anZMin = 0;
  anZMax = _anMaxVal();
}

function _anClampYZoom(z) {
  return Math.max(AN_YZOOM_MIN, Math.min(AN_YZOOM_MAX, z));
}

/** min/max d'un signal sur [i0,i1] — {lo,hi} ou null. */
function _anScanMinMax(sig, i0, i1) {
  if (!sig || !sig.length) return null;
  let lo = Infinity, hi = -Infinity;
  const i1s = Math.min(sig.length - 1, i1);
  for (let i = i0; i <= i1s; i++) {
    const v = sig[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  if (hi === lo) { lo -= 0.05; hi += 0.05; }
  return { lo: lo, hi: hi };
}

/**
 * Plage Y temporelle.
 * Mono : centrée sur (min+max)/2 → offset gravité remplit le graphique.
 * Dual A+B : échelle absolue symétrique ±max(|lo|,|hi|) autour de 0
 *   → gravité opposée reste séparée (+1g / −1g), pas superposée.
 * anYZoom / anYPan : zoom + pan vertical (scrollbar / Shift-glisser / tactile).
 */
function _anTimeYRange(i0, i1) {
  _anEnsureTimeIntegrated();
  const ra = _anVisA() ? _anScanMinMax(_anTimeSigA(), i0, i1) : null;
  const rb = _anVisB() ? _anScanMinMax(_anTimeSigB(), i0, i1) : null;
  const dual = !!(ra && rb);
  // Gravité opposée (±1g) : symétrique 0 seulement en accélération g
  const gravDual = dual && anUnit === 'g';

  let baseMid, fullHalf;
  if (gravDual) {
    const lo = Math.min(ra.lo, rb.lo);
    const hi = Math.max(ra.hi, rb.hi);
    const ext = Math.max(Math.abs(lo), Math.abs(hi), 0.05);
    baseMid = 0;
    fullHalf = ext * 1.12;
  } else {
    const r = ra || rb;
    let lo = r ? r.lo : -1;
    let hi = r ? r.hi : 1;
    if (dual) {
      lo = Math.min(ra.lo, rb.lo);
      hi = Math.max(ra.hi, rb.hi);
    }
    baseMid = (lo + hi) / 2;
    fullHalf = ((hi - lo) / 2) * 1.12;
  }
  if (fullHalf < 1e-6) fullHalf = 1e-6;
  _anYBaseMid = baseMid;
  _anYFullHalf = fullHalf;

  let viewHalf = fullHalf / Math.max(anYZoom, 1e-9);
  if (viewHalf < 1e-6) viewHalf = 1e-6;
  _anClampYPan(viewHalf, fullHalf);
  const mid = baseMid + anYPan;
  return { yMin: mid - viewHalf, yMax: mid + viewHalf, mid: mid, dual: dual,
    baseMid: baseMid, fullHalf: fullHalf, viewHalf: viewHalf };
}

function _anClampYPan(viewHalf, fullHalf) {
  const vh = viewHalf != null ? viewHalf : (_anYFullHalf / Math.max(anYZoom, 1e-9));
  const fh = fullHalf != null ? fullHalf : _anYFullHalf;
  const maxPan = Math.max(0, fh - vh);
  if (anYPan > maxPan) anYPan = maxPan;
  if (anYPan < -maxPan) anYPan = -maxPan;
  if (anYZoom <= 1.001) anYPan = 0;
}

function _anPanByDeltaY(dyPx, pH, span0, pan0) {
  if (!pH || pH <= 0) return;
  // Doigt/souris vers le bas → contenu descend → on regarde plus haut (g ↑)
  anYPan = pan0 + (dyPx / pH) * span0;
  _anClampYPan();
}

function analyseYZoomIn() {
  if (anMode !== 'time' || !anData) return;
  anYZoom = _anClampYZoom(anYZoom * AN_YZOOM_FACTOR);
  _anClampYPan();
  analyseDraw();
}
function analyseYZoomOut() {
  if (anMode !== 'time' || !anData) return;
  anYZoom = _anClampYZoom(anYZoom / AN_YZOOM_FACTOR);
  _anClampYPan();
  analyseDraw();
}
function analyseYZoomReset() {
  anYZoom = 1;
  anYPan = 0;
  if (anMode === 'time') analyseDraw();
}
window.analyseYZoomIn = analyseYZoomIn;
window.analyseYZoomOut = analyseYZoomOut;
window.analyseYZoomReset = analyseYZoomReset;

// ─────────────────────────────────────────────────────────
// DESSIN TEMPOREL
// ─────────────────────────────────────────────────────────
function anDrawTime() {
  _anEnsureTimeIntegrated();
  const _sig = _anTimeSigA();
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
  const yr = _anTimeYRange(i0, i1);
  const yMin = yr.yMin, yMax = yr.yMax, ySpan = yMax - yMin;
  const yDec = (anUnit === 'g') ? 3 : 2;
  function yPix(v) {
    return P.t + pH * (1 - (v - yMin) / ySpan);
  }
  for (let g = 0; g <= 4; g++) {
    const av = yMin + ySpan * g / 4;
    const y = yPix(av);
    if (g !== 0 && g !== 4) {
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pW, y); ctx.stroke();
    }
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'right';
    ctx.fillText(av.toFixed(yDec), P.l - 4, y + 3);
  }
  if (yMin < 0 && yMax > 0) {
    const y0 = yPix(0);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(P.l, y0); ctx.lineTo(P.l + pW, y0); ctx.stroke();
  }
  ctx.save(); ctx.translate(11, P.t + pH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.font = '10px Arial'; ctx.fillStyle = '#333';
  ctx.fillText(_anUnitLabel(), 0, 0); ctx.restore();
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
  const step=Math.max(1,Math.floor((i1-i0)/pW/2));
  function _strokeSig(sig, color, width) {
    if (!sig || !sig.length) return;
    const nS = sig.length;
    const i1s = Math.min(nS - 1, i1);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let first = true;
    for (let i = i0; i <= i1s; i += step) {
      const x = P.l + ((i / fs) - anZMin) / span * pW;
      const y = yPix(sig[i]);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const dualTime = !!(anDataB && anDataB.length);
  if (_anVisA()) _strokeSig(_sig, dualTime ? AN_COLOR_A : _anPrimaryColor(), 1.2);
  const _sigB = _anTimeSigB();
  if (_anVisB() && _sigB && _sigB.length) _strokeSig(_sigB, AN_COLOR_B, 1.2);
  ctx.restore();
  // Légende (mono B → orange « B », pas bleu « A »)
  ctx.font = 'bold 10px Arial';
  ctx.textAlign = 'left';
  if (dualTime) {
    ctx.fillStyle = _anVisA() ? AN_COLOR_A : '#bbb';
    ctx.fillText('A', P.l + 6, P.t + 12);
    ctx.fillStyle = _anVisB() ? AN_COLOR_B : '#bbb';
    ctx.fillText('B', P.l + 28, P.t + 12);
  } else {
    ctx.fillStyle = _anVisA() ? _anPrimaryColor() : '#bbb';
    ctx.fillText(_anPrimaryTag(), P.l + 6, P.t + 12);
  }
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
  function _drawTimeCur(c, color, tag) {
    if (!c) return;
    if (c.t < anZMin || c.t > anZMax) return;
    const x = P.l + (c.t - anZMin) / span * pW;
    anDrawCursor(ctx, x, c.t, c.amp, 's', pH, W, color, tag);
  }
  _drawTimeCur(anTimeC1, '#cc0000', 'C1');
  _drawTimeCur(anTimeC2, '#0055aa', 'C2');
  if (anTimeC1 && anTimeC2) {
    const t0 = Math.min(anTimeC1.t, anTimeC2.t);
    const t1 = Math.max(anTimeC1.t, anTimeC2.t);
    const x0 = P.l + (Math.max(t0, anZMin) - anZMin) / span * pW;
    const x1 = P.l + (Math.min(t1, anZMax) - anZMin) / span * pW;
    if (x1 > x0) {
      const dt = t1 - t0;
      const rpm = dt > 1e-9 ? (60 / dt) : 0;
      ctx.save();
      ctx.fillStyle = 'rgba(42,122,53,0.12)';
      ctx.fillRect(x0, P.t, x1 - x0, pH);
      ctx.fillStyle = '#2a7a35';
      ctx.font = 'bold 11px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Δt=' + dt.toFixed(4) + 's  ' + rpm.toFixed(1) + ' RPM', (x0 + x1) / 2, P.t + pH - 6);
      ctx.restore();
    }
  }
  _anUpdateTimeCursorBar();
}

// ─────────────────────────────────────────────────────────
// DESSIN FFT (A bleu / B orange — g et mm/s)
// ─────────────────────────────────────────────────────────
function _anEnsureFftA() {
  const chunk = _anTimeChunk(anDataDisplay || anData);
  if (!chunk || chunk.length < 64) return;
  const n = chunk.length;
  if (!anMag) {
    anMag = computeFFT(chunk, n, anP.fs);
    _anZoomFullSpectrum();
  }
  if (anUnit === 'mm/s' && !anMagVel) {
    anMagVel = computeVelFFT(chunk, anP.fs, n);
  }
  if (anUnit === 'mm' && !anMagDisp && typeof computeDispFFT === 'function') {
    anMagDisp = computeDispFFT(chunk, anP.fs, n);
  }
}

function _anEnsureFftB() {
  const _sigB = anDataDisplayB || anDataB;
  if (!_sigB || !_sigB.length) {
    anMagB = null; anMagVelB = null; anMagDispB = null; return;
  }
  const chunkB = _anTimeChunk(_sigB);
  if (!chunkB || chunkB.length < 64) {
    anMagB = null; anMagVelB = null; anMagDispB = null; return;
  }
  const nB = chunkB.length;
  if (!anMagB) anMagB = computeFFT(chunkB, nB, anP.fs);
  if (anUnit === 'mm/s' && !anMagVelB) {
    anMagVelB = computeVelFFT(chunkB, anP.fs, nB);
  }
  if (anUnit === 'mm' && !anMagDispB && typeof computeDispFFT === 'function') {
    anMagDispB = computeDispFFT(chunkB, anP.fs, nB);
  }
}

function _anPickMag(magG, magVel, magDisp) {
  if (anUnit === 'mm/s') return magVel || magG;
  if (anUnit === 'mm') return magDisp || magG;
  return magG;
}

function _anStrokeMag(ctx, mag, minB, maxB, rpmPB, zMin, span, pW, pH, aS, color, fill, maxA) {
  if (!mag) return;
  const P = APAD;
  ctx.beginPath();
  let fi = true;
  for (let i = minB; i <= maxB; i++) {
    const x = P.l + (i * rpmPB - zMin) / span * pW;
    const y = P.t + pH - mag[i] * aS;
    if (fi) { ctx.moveTo(x, P.t + pH); ctx.lineTo(x, y); fi = false; }
    else ctx.lineTo(x, y);
  }
  if (!fi) {
    ctx.lineTo(P.l + (maxB * rpmPB - zMin) / span * pW, P.t + pH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  const ppb = pW / (maxB - minB + 1);
  if (ppb >= 1.2) {
    ctx.lineWidth = Math.min(1.5, ppb * 0.7);
    ctx.strokeStyle = color;
    for (let i = minB; i <= maxB; i++) {
      if (mag[i] < maxA * 0.002) continue;
      const x = P.l + (i * rpmPB - zMin) / span * pW;
      const y = P.t + pH - mag[i] * aS;
      ctx.beginPath(); ctx.moveTo(x, P.t + pH); ctx.lineTo(x, y); ctx.stroke();
    }
  } else {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    let ff = true;
    for (let i = minB; i <= maxB; i++) {
      const x = P.l + (i * rpmPB - zMin) / span * pW;
      const y = P.t + pH - mag[i] * aS;
      if (ff) { ctx.moveTo(x, y); ff = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function anDrawFFT() {
  _anEnsureFftA();
  _anEnsureFftB();
  const mag = _anPickMag(anMag, anMagVel, anMagDisp);
  const magB = _anPickMag(anMagB, anMagVelB, anMagDispB);
  const maxRpm = _anMaxVal();
  const yLabel = _anUnitLabel();
  const decimals = (anUnit === 'g') ? 3 : 2;
  const canvas = document.getElementById('an-canvas');
  const wrap = document.getElementById('an-canvas-wrap');
  const W = wrap.offsetWidth || window.innerWidth;
  const H = wrap.offsetHeight || 280;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const zMin = anZMin, zMax = Math.min(anZMax, maxRpm);
  const P = APAD, fs = anP.fs, n = anP.n;
  const nFFT = nextPow2(n);
  const rpmPB = (fs / nFFT) * 60, span = zMax - zMin;
  const minB = Math.max(1, Math.floor(zMin / rpmPB));
  const maxB = Math.min(nFFT / 2 - 1, Math.ceil(zMax / rpmPB));
  const pW = W - P.l - P.r, pH = H - P.t - P.b;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(P.l, P.t, pW, pH);
  let maxA = 0;
  if (_anVisA() && mag) {
    for (let i = minB; i <= maxB; i++) if (mag[i] > maxA) maxA = mag[i];
  }
  if (_anVisB() && magB) {
    const lim = Math.min(maxB, magB.length - 1);
    for (let i = minB; i <= lim; i++) if (magB[i] > maxA) maxA = magB[i];
  }
  if (maxA === 0) maxA = 1;
  const aS = pH / (maxA * 1.1);
  for (let g = 0; g <= 5; g++) {
    const av = maxA * g / 5, y = P.t + pH - av * aS;
    if (g > 0) {
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pW, y); ctx.stroke();
    }
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'right';
    ctx.fillText(av.toFixed(decimals), P.l - 4, y + 3);
  }
  ctx.save(); ctx.translate(11, P.t + pH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.font = '10px Arial'; ctx.fillStyle = '#333';
  ctx.fillText(yLabel, 0, 0); ctx.restore();
  const xt = Math.min(8, Math.floor(pW / 55));
  for (let t2 = 0; t2 <= xt; t2++) {
    const rpm = zMin + span * t2 / xt, x = P.l + (rpm - zMin) / span * pW;
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, P.t + pH); ctx.lineTo(x, P.t + pH + 4); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'center';
    ctx.fillText(rpm >= 1000 ? (rpm / 1000).toFixed(1) + 'k' : rpm.toFixed(0), x, H - 2);
  }
  ctx.fillStyle = '#555'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
  ctx.fillText('Fréquence (RPM)', P.l + pW / 2, H);
  const dualFft = !!magB;
  ctx.save(); ctx.beginPath(); ctx.rect(P.l, P.t, pW, pH); ctx.clip();
  if (_anVisB() && magB) {
    const maxBB = Math.min(maxB, magB.length - 1);
    _anStrokeMag(ctx, magB, minB, maxBB, rpmPB, zMin, span, pW, pH, aS, AN_COLOR_B, AN_FILL_B, maxA);
  }
  if (_anVisA() && mag) {
    _anStrokeMag(ctx, mag, minB, maxB, rpmPB, zMin, span, pW, pH, aS,
      dualFft ? AN_COLOR_A : _anPrimaryColor(),
      dualFft ? AN_FILL_A : _anPrimaryFill(), maxA);
  }
  // Pic sur la 1re sonde visible
  const magPk = _anVisA() && mag ? mag : (_anVisB() && magB ? magB : null);
  if (magPk) {
    const pkB = fftPeakBin(magPk, Math.min(maxB, magPk.length - 1));
    if (pkB >= minB) {
      const xP = P.l + (pkB * rpmPB - zMin) / span * pW;
      ctx.strokeStyle = '#666'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(xP, P.t); ctx.lineTo(xP, P.t + pH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#666'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left';
      ctx.fillText((pkB * rpmPB).toFixed(0) + ' RPM', Math.min(xP + 3, W - 70), P.t + 12);
    }
  }
  ctx.restore();
  // Légende
  ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left';
  if (dualFft) {
    ctx.fillStyle = _anVisA() ? AN_COLOR_A : '#bbb';
    ctx.fillText('A', P.l + 6, P.t + 12);
    ctx.fillStyle = _anVisB() ? AN_COLOR_B : '#bbb';
    ctx.fillText('B', P.l + 28, P.t + 12);
  } else {
    ctx.fillStyle = _anVisA() ? _anPrimaryColor() : '#bbb';
    ctx.fillText(_anPrimaryTag(), P.l + 6, P.t + 12);
  }
  if (anCursorX >= P.l && anCursorX <= P.l + pW && magPk) {
    const rpm = zMin + ((anCursorX - P.l) / pW) * span;
    const bin = Math.round(rpm / rpmPB);
    if (bin >= 1 && bin < magPk.length)
      anDrawCursorFFT(ctx, anCursorX, rpm, magPk[bin], anUnit, pH, W, magPk, rpmPB, zMin, span, pW);
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

  // Auto-échelle Y sur la vue courante (A + B visibles)
  let maxA = 0;
  if (_anVisA()) {
    for (let i = minB; i <= maxB; i++) if (amps[i] > maxA) maxA = amps[i];
  }
  if (_anVisB() && anDemodResultB && anDemodResultB.amps) {
    const ampsB = anDemodResultB.amps;
    const lim = Math.min(maxB, ampsB.length - 1);
    for (let i = minB; i <= lim; i++) if (ampsB[i] > maxA) maxA = ampsB[i];
  }
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

  // ── Spectre enveloppe A (+ B si DOUBLE) ───────────────
  function _strokeDemod(ampsArr, color, fill) {
    if (!ampsArr) return;
    const lim = Math.min(maxB, ampsArr.length - 1);
    ctx.beginPath(); let fi = true;
    for (let i = minB; i <= lim; i++) {
      const x = P.l + (freqsRpm[i] - zMin) / span * pW;
      const y = P.t + pH - ampsArr[i] * aS;
      if (fi) { ctx.moveTo(x, P.t + pH); ctx.lineTo(x, y); fi = false; }
      else ctx.lineTo(x, y);
    }
    if (!fi) {
      const xLast = P.l + (freqsRpm[lim] - zMin) / span * pW;
      ctx.lineTo(xLast, P.t + pH); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.3;
    ctx.beginPath(); fi = true;
    for (let i = minB; i <= lim; i++) {
      const x = P.l + (freqsRpm[i] - zMin) / span * pW;
      const y = P.t + pH - ampsArr[i] * aS;
      if (fi) { ctx.moveTo(x, y); fi = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const dualDemod = !!(anDemodResultB && anDemodResultB.amps);
  if (_anVisB() && dualDemod) {
    _strokeDemod(anDemodResultB.amps, AN_COLOR_B, AN_FILL_B);
  }
  if (_anVisA()) {
    _strokeDemod(amps,
      dualDemod ? AN_COLOR_A : _anPrimaryColor(),
      dualDemod ? AN_FILL_A : _anPrimaryFill());
  }

  ctx.restore(); // fin clip

  // Légende
  ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left';
  if (dualDemod) {
    ctx.fillStyle = _anVisA() ? AN_COLOR_A : '#bbb';
    ctx.fillText('A', P.l + 6, P.t + 12);
    ctx.fillStyle = _anVisB() ? AN_COLOR_B : '#bbb';
    ctx.fillText('B', P.l + 28, P.t + 12);
  } else {
    ctx.fillStyle = _anVisA() ? _anPrimaryColor() : '#bbb';
    ctx.fillText(_anPrimaryTag(), P.l + 6, P.t + 12);
  }

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
let anPanY0      = 0, anYSpan0 = 1;
let anPinD0      = 0, anPinMin0 = 0, anPinMax0 = 0;
let anPinDy0     = 0, anPinYZoom0 = 1;
let _anLongTimer  = null;
let _anLongStart  = 0;
let _anLongAnimId = null;
let _anLongActive = false;
const AN_PAN_THRESHOLD  = 10;
const AN_LONG_PRESS_MS  = 600;
const AN_LONG_PRESS_PX  = 15;

/** RPM sous le doigt (FFT/démod). */
function _anTouchToRpm(clientX) {
  const canvas = document.getElementById('an-canvas');
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const px = (clientX - rect.left) * scaleX;
  const pW = canvas.width - APAD.l - APAD.r;
  if (pW <= 0) return 0;
  return anZMin + ((px - APAD.l) / pW) * (anZMax - anZMin);
}

function _anTouchHitFftFeature(clientX) {
  if (anCursorX < 0 || (anMode !== 'fft' && anMode !== 'demod')) return null;
  const canvas = document.getElementById('an-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const px = (clientX - rect.left) * scaleX;
  const pW = canvas.width - APAD.l - APAD.r;
  const span = anZMax - anZMin;
  const rpmCarrier = anZMin + ((anCursorX - APAD.l) / pW) * span;
  return _anHitCursorFeature(px, rpmCarrier, anZMin, span, pW);
}

anWrap.addEventListener('touchstart', (e) => {
  if (!anData) return;
  // Fermer le hamburger si ouvert
  if (anHamOpen) { anToggleHam(); return; }

  if (e.touches.length === 1) {
    anTouchX0=e.touches[0].clientX; anTouchY0=e.touches[0].clientY;
    anPanMin0=anZMin; anPanMax0=anZMax;
    anPanY0 = anYPan;
    anYSpan0 = (2 * _anYFullHalf) / Math.max(anYZoom, 1e-9);
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
      // FFT/démod : si curseur déjà là + mode Sidebands → grab SB ou porteuse
      const hit = _anTouchHitFftFeature(anTouchX0);
      if (hit === 'sb' && anCursorKind === 'sb') {
        _anCancelLong();
        const span = anZMax - anZMin;
        const pW = (document.getElementById('an-canvas') || {}).width
          ? document.getElementById('an-canvas').width - APAD.l - APAD.r : 1;
        const rpmCarrier = anZMin + ((anCursorX - APAD.l) / Math.max(pW, 1)) * span;
        anTouchMode = 'drag_sb';
        _anMouse.carrierRpm0 = rpmCarrier;
        _anMouse.sbDelta0 = anSbDelta;
        if (navigator.vibrate) navigator.vibrate(20);
        return;
      }
      if (hit === 'carrier') {
        _anCancelLong();
        anTouchMode = 'cursor_locked';
        anSetCursorFromTouch(anTouchX0);
        analyseDraw();
        return;
      }
      // sinon : long press → verrouiller curseur ; glisser → pan
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
    anPinDy0 = Math.abs(e.touches[0].clientY - e.touches[1].clientY) || 1;
    anPinYZoom0 = anYZoom;
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
    function _anStartTouchPan() {
      _anCancelLong();
      // Zoom Y actif + geste surtout vertical → pan Y (Android dual ±1g)
      if (anMode === 'time' && anYZoom > 1.02 && Math.abs(dy) > Math.abs(dx) * 1.15) {
        anTouchMode = 'pan_y';
        anCursorX = -1;
        anPanY0 = anYPan;
        anYSpan0 = (2 * _anYFullHalf) / Math.max(anYZoom, 1e-9);
      } else {
        anTouchMode = 'pan';
        anCursorX = -1;
      }
    }
    if(_anLongTimer && Math.sqrt(dx*dx+dy*dy)>AN_LONG_PRESS_PX){
      if(anTouchMode==='wait') _anStartTouchPan();
      else _anCancelLong();
    }
    if(anTouchMode==='wait'){
      if(Math.abs(dx)>AN_PAN_THRESHOLD || Math.abs(dy)>AN_PAN_THRESHOLD) _anStartTouchPan();
      else return;
    }
    if (anTouchMode === 'drag_sb') {
      const rpmAt = _anTouchToRpm(e.touches[0].clientX);
      const delta = Math.abs(rpmAt - _anMouse.carrierRpm0);
      anSbDelta = Math.max(1, Math.round(delta));
      const sd = document.getElementById('an-sb-delta');
      if (sd) sd.value = String(anSbDelta);
      analyseDraw();
      return;
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
    if(anTouchMode==='cursor' && (Math.abs(dx)>AN_PAN_THRESHOLD || Math.abs(dy)>AN_PAN_THRESHOLD)){
      _anStartTouchPan();
    }
    if(anTouchMode==='pan_y'){
      const pH = canvas.height - APAD.t - APAD.b;
      _anPanByDeltaY(dy, pH, anYSpan0, anPanY0);
      analyseDraw();
    } else if(anTouchMode==='pan'){
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
    const dxF = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
    const dyF = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
    // Temps : pincement surtout vertical → zoom Y (Android)
    if (anMode === 'time' && dyF > dxF * 1.2 && anPinDy0 > 0) {
      anYZoom = _anClampYZoom(anPinYZoom0 * (dyF / anPinDy0));
      analyseDraw();
      return;
    }
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
  if(anTouchMode==='pan' || anTouchMode==='pan_y'){anCursorX=-1;analyseDraw();}
  if(anTouchMode==='wait'&&(anMode==='fft'||anMode==='demod')){
    anSetCursorFromTouch(anTouchX0); analyseDraw();
  }
  // Tap temporel (sans pan / sans long-press sel) → curseur C1/C2
  if (anTouchMode === 'cursor' && anMode === 'time') {
    _anPlaceTimeCursor(anTouchX0);
  }
  if(anTouchMode==='sel'){
    anSelecting=false;
    if(anSelEnd-anSelStart<0.01){anSelStart=-1;anSelEnd=-1;}
    _anInvalidateFft();
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
  if (!canvas) return 0;
  const rect=canvas.getBoundingClientRect();
  // CSS px → buffer canvas (critique Windows / DPR)
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const px = (clientX - rect.left) * scaleX;
  const pW = canvas.width - APAD.l - APAD.r;
  if (pW <= 0) return 0;
  const t = anZMin + ((px - APAD.l) / pW) * (anZMax - anZMin);
  return Math.max(0, Math.min(anP.t, t));
}

/** Tranche temporelle pour FFT/démod : sélection si présente, sinon tout. */
function _anTimeChunk(sig) {
  if (!sig || !sig.length) return sig;
  const nFull = Math.min(anP.n, sig.length);
  if (anSelStart >= 0 && anSelEnd > anSelStart) {
    const i0 = Math.max(0, Math.round(anSelStart * anP.fs));
    const i1 = Math.min(sig.length - 1, Math.round(anSelEnd * anP.fs));
    if (i1 - i0 >= 63) return sig.slice(i0, i1 + 1);
  }
  return sig.slice(0, nFull);
}

function _anInvalidateFft() {
  anMag = null; anMagVel = null; anMagDisp = null;
  anMagB = null; anMagVelB = null; anMagDispB = null;
}
function _anUpdateSelBtn(){
  const hasSel=anSelStart>=0&&anSelEnd>anSelStart;
  const btnFFT=document.getElementById('btn-an-fft-sel');
  const btnClr=document.getElementById('btn-an-sel-clear');
  if(btnFFT) btnFFT.style.display=hasSel?'inline-block':'none';
  if(btnClr) btnClr.style.display=hasSel?'inline-block':'none';
}

// ============================================================
// SOURIS desktop — coexiste avec touch* (Android inchangé)
// Molette zoom · drag pan · clic peak · double-clic reset · barre
// ============================================================
const AN_MOUSE_DRAG_PX = 8;
const AN_WHEEL_FACTOR  = 1.15;
let _anMouse = {
  down: false, mode: 'none', x0: 0, panMin0: 0, panMax0: 0,
  carrierRpm0: 0, sbDelta0: 60,
};
let _anScrollDrag = null; // { axis:'x'|'y', ... }

function _anMinSpan() {
  return anMode === 'time' ? 0.01 : 50;
}

function _anClampZoom(nMin, nMax) {
  const maxVal = _anMaxVal();
  const minSpan = _anMinSpan();
  let a = Math.max(0, nMin);
  let b = Math.min(maxVal, nMax);
  if (b - a < minSpan) {
    const c = (a + b) / 2;
    a = Math.max(0, c - minSpan / 2);
    b = Math.min(maxVal, a + minSpan);
    a = Math.max(0, b - minSpan);
  }
  anZMin = a;
  anZMax = b;
}

function _anZoomAt(clientX, factor) {
  if (!anData) return;
  const canvas = document.getElementById('an-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const pW = canvas.width - APAD.l - APAD.r;
  if (pW <= 0) return;
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const px = (clientX - rect.left) * scaleX;
  const frac = Math.max(0, Math.min(1, (px - APAD.l) / pW));
  const anchor = anZMin + frac * (anZMax - anZMin);
  const newSpan = (anZMax - anZMin) * factor;
  _anClampZoom(anchor - frac * newSpan, anchor + (1 - frac) * newSpan);
  analyseDraw();
}

function _anPanByDeltaX(dx, panMin0, panMax0) {
  const canvas = document.getElementById('an-canvas');
  if (!canvas) return;
  const pW = canvas.width - APAD.l - APAD.r;
  if (pW <= 0) return;
  const maxVal = _anMaxVal();
  const span0 = panMax0 - panMin0;
  const dVal = -(dx / pW) * span0;
  let nMin = panMin0 + dVal;
  let nMax = panMax0 + dVal;
  if (nMin < 0) { nMax -= nMin; nMin = 0; }
  if (nMax > maxVal) { nMin -= (nMax - maxVal); nMax = maxVal; }
  anZMin = Math.max(0, nMin);
  anZMax = Math.min(maxVal, nMax);
}

function _anSnapCursorToPeak() {
  if (anMode === 'time' || anCursorX < 0) return;
  const canvas = document.getElementById('an-canvas');
  if (!canvas) return;
  const P = APAD;
  const pW = canvas.width - P.l - P.r;
  const span = anZMax - anZMin;
  if (pW <= 0 || span <= 0) return;

  if (anMode === 'fft') {
    _anEnsureFftA();
    _anEnsureFftB();
    const mag = (_anVisA() && _anPickMag(anMag, anMagVel, anMagDisp))
      ? _anPickMag(anMag, anMagVel, anMagDisp)
      : (_anVisB() ? _anPickMag(anMagB, anMagVelB, anMagDispB) : null);
    if (!mag) return;
    const fs = anP.fs;
    const nFFT = nextPow2(anP.n);
    const rpmPB = (fs / nFFT) * 60;
    const rpm = anZMin + ((anCursorX - P.l) / pW) * span;
    let bin = Math.round(rpm / rpmPB);
    const win = Math.max(8, Math.round((span / rpmPB) * 0.02));
    let best = bin, bestA = -1;
    const lo = Math.max(1, bin - win);
    const hi = Math.min(mag.length - 1, bin + win);
    for (let i = lo; i <= hi; i++) {
      if (mag[i] > bestA) { bestA = mag[i]; best = i; }
    }
    const snapRpm = best * rpmPB;
    anCursorX = P.l + (snapRpm - anZMin) / span * pW;
    anCursorX = Math.max(P.l, Math.min(P.l + pW, anCursorX));
    return;
  }

  if (anMode === 'demod' && anDemodResult && anDemodResult.freqsRpm) {
    const freqs = anDemodResult.freqsRpm;
    const amps = anDemodResult.amps || anDemodResult.envAmp;
    if (!freqs.length) return;
    const rpmPerBin = freqs.length > 1 ? (freqs[1] - freqs[0]) : 1;
    const curRpm = anZMin + ((anCursorX - P.l) / pW) * span;
    let idx = Math.round(curRpm / rpmPerBin);
    const win = Math.max(4, Math.round((span / rpmPerBin) * 0.02));
    let best = idx, bestA = -1;
    const lo = Math.max(0, idx - win);
    const hi = Math.min(freqs.length - 1, idx + win);
    const ampArr = amps && amps.length ? amps : null;
    for (let i = lo; i <= hi; i++) {
      const a = ampArr ? ampArr[i] : 0;
      if (a > bestA) { bestA = a; best = i; }
    }
    anCursorX = P.l + (freqs[best] - anZMin) / span * pW;
    anCursorX = Math.max(P.l, Math.min(P.l + pW, anCursorX));
  }
}

function _anPlaceCursorClick(clientX) {
  if (anMode === 'time') {
    _anPlaceTimeCursor(clientX);
    return;
  }
  anSetCursorFromTouch(clientX);
  _anSnapCursorToPeak();
  analyseDraw();
}

function _anResetZoom() {
  if (!anData) return;
  anZMin = 0;
  anZMax = _anMaxVal();
  anYZoom = 1;
  anYPan = 0;
  anCursorX = -1;
  if (anMode === 'time') _anClearTimeCursors();
  analyseDraw();
}

function _anSyncHScroll() {
  const bar = document.getElementById('an-hscroll');
  const thumb = document.getElementById('an-hscroll-thumb');
  if (!bar || !thumb) return;
  const hide = !anData || anMode === 'bump_wait' || anMode === 'bump_stream';
  if (hide) {
    bar.style.display = 'none';
    bar.setAttribute('aria-hidden', 'true');
    return;
  }
  const maxVal = _anMaxVal();
  const span = Math.max(anZMax - anZMin, 1e-9);
  const zoomed = maxVal > 0 && span < maxVal * 0.985;
  bar.style.display = zoomed ? 'block' : 'none';
  bar.setAttribute('aria-hidden', zoomed ? 'false' : 'true');
  if (!zoomed) return;
  const track = bar.querySelector('.graph-hscroll-track');
  const tw = (track && track.clientWidth) || 1;
  const thumbW = Math.max(28, (span / maxVal) * tw);
  const maxLeft = Math.max(0, tw - thumbW);
  const left = Math.max(0, Math.min(maxLeft, (anZMin / maxVal) * tw));
  thumb.style.width = thumbW + 'px';
  thumb.style.transform = 'translateX(' + left + 'px)';
}

function _anHScrollSetFromClientX(clientX, thumbW) {
  const track = document.querySelector('#an-hscroll .graph-hscroll-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const tw = rect.width || 1;
  const maxVal = _anMaxVal();
  const span = anZMax - anZMin;
  const twThumb = thumbW || Math.max(28, (span / maxVal) * tw);
  const maxLeft = Math.max(0, tw - twThumb);
  let left = clientX - rect.left - twThumb / 2;
  left = Math.max(0, Math.min(maxLeft, left));
  const nMin = (left / tw) * maxVal;
  _anClampZoom(nMin, nMin + span);
  analyseDraw();
}

function _anSyncVScroll() {
  const bar = document.getElementById('an-vscroll');
  const thumb = document.getElementById('an-vscroll-thumb');
  if (!bar || !thumb) return;
  const hide = !anData || anMode !== 'time' || anYZoom <= 1.02;
  if (hide) {
    bar.style.display = 'none';
    bar.setAttribute('aria-hidden', 'true');
    return;
  }
  bar.style.display = 'block';
  bar.setAttribute('aria-hidden', 'false');
  const track = bar.querySelector('.graph-vscroll-track');
  const th = (track && track.clientHeight) || 1;
  const viewHalf = _anYFullHalf / Math.max(anYZoom, 1e-9);
  const full = Math.max(_anYFullHalf * 2, 1e-9);
  const view = Math.max(viewHalf * 2, 1e-9);
  const thumbH = Math.max(28, (view / full) * th);
  const maxTop = Math.max(0, th - thumbH);
  // Haut de la piste = g max (baseMid+fullHalf) ; bas = g min
  const maxPan = Math.max(0, _anYFullHalf - viewHalf);
  const frac = maxPan > 1e-12 ? (maxPan - anYPan) / (2 * maxPan) : 0.5;
  const top = Math.max(0, Math.min(maxTop, frac * maxTop));
  thumb.style.height = thumbH + 'px';
  thumb.style.transform = 'translateY(' + top + 'px)';
}

function _anVScrollSetFromClientY(clientY, thumbH) {
  const track = document.querySelector('#an-vscroll .graph-vscroll-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const th = rect.height || 1;
  const viewHalf = _anYFullHalf / Math.max(anYZoom, 1e-9);
  const full = Math.max(_anYFullHalf * 2, 1e-9);
  const view = Math.max(viewHalf * 2, 1e-9);
  const tH = thumbH || Math.max(28, (view / full) * th);
  const maxTop = Math.max(0, th - tH);
  let top = clientY - rect.top - tH / 2;
  top = Math.max(0, Math.min(maxTop, top));
  const maxPan = Math.max(0, _anYFullHalf - viewHalf);
  const frac = maxTop > 0 ? top / maxTop : 0.5;
  anYPan = maxPan - frac * (2 * maxPan);
  _anClampYPan(viewHalf, _anYFullHalf);
  analyseDraw();
}

if (anWrap) {
  anWrap.addEventListener('wheel', (e) => {
    if (!anData) return;
    if (anMode === 'bump_wait' || anMode === 'bump_stream') return;
    e.preventDefault();
    // Shift + molette = zoom vertical (temps). Sens : molette bas = zoom in.
    if (anMode === 'time' && e.shiftKey) {
      anYZoom = _anClampYZoom(
        anYZoom * (e.deltaY > 0 ? AN_YZOOM_FACTOR : (1 / AN_YZOOM_FACTOR))
      );
      analyseDraw();
      return;
    }
    // Molette bas = zoom in (sens inversé vs défaut navigateur)
    const factor = e.deltaY > 0 ? (1 / AN_WHEEL_FACTOR) : AN_WHEEL_FACTOR;
    _anZoomAt(e.clientX, factor);
  }, { passive: false });

  anWrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button !== 0 || !anData) return;
    if (anMode === 'bump_wait' || anMode === 'bump_stream') return;
    if (anHamOpen) { anToggleHam(); return; }
    e.preventDefault();
    _anMouse.down = true;
    _anMouse.x0 = e.clientX;
    _anMouse.panMin0 = anZMin;
    _anMouse.panMax0 = anZMax;
    try { anWrap.setPointerCapture(e.pointerId); } catch (err) {}

    // Mode temps (souris) :
    //   clic             → curseur C1/C2 (Δt / RPM)
    //   glisser          → sélection fenêtre FFT
    //   Ctrl+glisser     → pan X
    //   Shift+glisser    → pan Y (si zoom vertical)
    //   Sél / Alt        → sélection dès le départ
    _anMouse.y0 = e.clientY;
    _anMouse.yPan0 = anYPan;
    _anMouse.ySpan0 = (2 * _anYFullHalf) / Math.max(anYZoom, 1e-9);
    if (anMode === 'time') {
      const wantPanY = e.shiftKey && !anSelMode;
      const wantPan = (e.ctrlKey || e.metaKey) && !anSelMode;
      if (wantPanY) {
        _anMouse.mode = 'pan_y';
        anCursorX = -1;
        return;
      }
      if (wantPan) {
        /* pending → pan ci-dessous */
      } else if (anSelMode || e.altKey) {
        _anMouse.mode = 'sel';
        anSelStart = _anTouchToTime(e.clientX);
        anSelEnd = anSelStart;
        anSelecting = true;
        anCursorX = -1;
        analyseDraw();
        return;
      } else {
        _anMouse.mode = 'pending_time';
        return;
      }
    }

    // FFT/demod : drag porteuse / sideband si curseur déjà posé
    if ((anMode === 'fft' || anMode === 'demod') && anCursorX >= 0) {
      const canvas = document.getElementById('an-canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / Math.max(rect.width, 1);
        const px = (e.clientX - rect.left) * scaleX;
        const pW = canvas.width - APAD.l - APAD.r;
        const span = anZMax - anZMin;
        const rpmCarrier = anZMin + ((anCursorX - APAD.l) / pW) * span;
        const hit = _anHitCursorFeature(px, rpmCarrier, anZMin, span, pW);
        if (hit === 'carrier') {
          _anMouse.mode = 'drag_carrier';
          return;
        }
        if (hit === 'sb') {
          _anMouse.mode = 'drag_sb';
          _anMouse.carrierRpm0 = rpmCarrier;
          _anMouse.sbDelta0 = anSbDelta;
          return;
        }
      }
    }

    _anMouse.mode = 'pending';
  });

  anWrap.addEventListener('dblclick', (e) => {
    if (e.pointerType === 'touch') return;
    if (!anData) return;
    e.preventDefault();
    _anResetZoom();
  });
}

window.addEventListener('pointermove', (e) => {
  if (_anScrollDrag) {
    if (_anScrollDrag.axis === 'y') {
      const track = document.querySelector('#an-vscroll .graph-vscroll-track');
      if (!track) return;
      const th = track.clientHeight || 1;
      const dy = e.clientY - _anScrollDrag.y0;
      const viewHalf = _anYFullHalf / Math.max(anYZoom, 1e-9);
      const maxPan = Math.max(0, _anYFullHalf - viewHalf);
      const maxTop = Math.max(0, th - _anScrollDrag.thumbH);
      const dFrac = maxTop > 0 ? dy / maxTop : 0;
      // Haut = g max → pan ↓ quand thumb descend
      anYPan = _anScrollDrag.pan0 - dFrac * (2 * maxPan);
      _anClampYPan(viewHalf, _anYFullHalf);
      analyseDraw();
      return;
    }
    const maxVal = _anMaxVal();
    const span = _anScrollDrag.span;
    const track = document.querySelector('#an-hscroll .graph-hscroll-track');
    if (!track) return;
    const tw = track.clientWidth || 1;
    const dx = e.clientX - _anScrollDrag.x0;
    const dVal = (dx / tw) * maxVal;
    _anClampZoom(_anScrollDrag.z0 + dVal, _anScrollDrag.z0 + dVal + span);
    analyseDraw();
    return;
  }
  if (!_anMouse.down || e.pointerType === 'touch') return;
  const dx = e.clientX - _anMouse.x0;
  const dy = e.clientY - _anMouse.y0;

  if (_anMouse.mode === 'pan_y') {
    const canvas = document.getElementById('an-canvas');
    if (!canvas) return;
    const pH = canvas.height - APAD.t - APAD.b;
    _anPanByDeltaY(dy, pH, _anMouse.ySpan0, _anMouse.yPan0);
    analyseDraw();
    return;
  }

  if (_anMouse.mode === 'pending_time') {
    // Zoom Y : glisser vertical → pan Y (sans Shift)
    if (anYZoom > 1.02 && Math.abs(dy) > Math.abs(dx) * 1.15 && Math.abs(dy) > AN_MOUSE_DRAG_PX) {
      _anMouse.mode = 'pan_y';
      anCursorX = -1;
      const canvas = document.getElementById('an-canvas');
      if (canvas) {
        const pH = canvas.height - APAD.t - APAD.b;
        _anPanByDeltaY(dy, pH, _anMouse.ySpan0, _anMouse.yPan0);
        analyseDraw();
      }
      return;
    }
    if (Math.abs(dx) > AN_MOUSE_DRAG_PX) {
      _anMouse.mode = 'sel';
      anSelecting = true;
      anCursorX = -1;
      const t0 = _anTouchToTime(_anMouse.x0);
      const t = _anTouchToTime(e.clientX);
      anSelStart = Math.max(0, Math.min(t, t0));
      anSelEnd = Math.min(anP.t, Math.max(t, t0));
      analyseDraw();
      return;
    }
  }

  if (_anMouse.mode === 'sel') {
    const t = _anTouchToTime(e.clientX);
    const t0 = _anTouchToTime(_anMouse.x0);
    anSelStart = Math.max(0, Math.min(t, t0));
    anSelEnd = Math.min(anP.t, Math.max(t, t0));
    analyseDraw();
    return;
  }

  if (_anMouse.mode === 'drag_carrier') {
    anSetCursorFromTouch(e.clientX);
    if (anMode === 'fft') _anSnapCursorToPeak();
    analyseDraw();
    return;
  }

  if (_anMouse.mode === 'drag_sb') {
    const canvas = document.getElementById('an-canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(rect.width, 1);
    const px = (e.clientX - rect.left) * scaleX;
    const pW = canvas.width - APAD.l - APAD.r;
    const span = anZMax - anZMin;
    if (pW <= 0 || span <= 0) return;
    const rpmAt = anZMin + ((px - APAD.l) / pW) * span;
    const delta = Math.abs(rpmAt - _anMouse.carrierRpm0);
    anSbDelta = Math.max(1, Math.round(delta));
    const sd = document.getElementById('an-sb-delta');
    if (sd) sd.value = String(anSbDelta);
    analyseDraw();
    return;
  }

  if (_anMouse.mode === 'pending' && Math.abs(dx) > AN_MOUSE_DRAG_PX) {
    _anMouse.mode = 'pan';
    anCursorX = -1;
  }
  if (_anMouse.mode === 'pan') {
    _anPanByDeltaX(dx, _anMouse.panMin0, _anMouse.panMax0);
    analyseDraw();
  }
});

window.addEventListener('pointerup', (e) => {
  if (_anScrollDrag) {
    _anScrollDrag = null;
    return;
  }
  if (!_anMouse.down) return;
  if (_anMouse.mode === 'pending_time') {
    _anPlaceTimeCursor(e.clientX);
  } else if (_anMouse.mode === 'sel') {
    anSelecting = false;
    if (anSelEnd - anSelStart < 0.01) { anSelStart = -1; anSelEnd = -1; }
    _anInvalidateFft();
    _anUpdateSelBtn();
    analyseDraw();
  } else if (_anMouse.mode === 'pending' && e.pointerType !== 'touch') {
    _anPlaceCursorClick(e.clientX);
  }
  _anMouse.down = false;
  _anMouse.mode = 'none';
});

window.addEventListener('pointercancel', () => {
  _anScrollDrag = null;
  _anMouse.down = false;
  _anMouse.mode = 'none';
});

(function _anBindHScroll() {
  const bar = document.getElementById('an-hscroll');
  const thumb = document.getElementById('an-hscroll-thumb');
  if (!bar || !thumb) return;
  const track = bar.querySelector('.graph-hscroll-track');
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _anScrollDrag = { axis: 'x', x0: e.clientX, z0: anZMin, span: anZMax - anZMin };
    try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
  });
  if (track) {
    track.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return;
      e.preventDefault();
      _anHScrollSetFromClientX(e.clientX);
    });
  }
})();

(function _anBindVScroll() {
  const bar = document.getElementById('an-vscroll');
  const thumb = document.getElementById('an-vscroll-thumb');
  if (!bar || !thumb) return;
  const track = bar.querySelector('.graph-vscroll-track');
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const viewHalf = _anYFullHalf / Math.max(anYZoom, 1e-9);
    const full = Math.max(_anYFullHalf * 2, 1e-9);
    const view = Math.max(viewHalf * 2, 1e-9);
    const th = (track && track.clientHeight) || 1;
    const thumbH = Math.max(28, (view / full) * th);
    _anScrollDrag = { axis: 'y', y0: e.clientY, pan0: anYPan, thumbH: thumbH };
    try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
  });
  if (track) {
    track.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return;
      e.preventDefault();
      _anVScrollSetFromClientY(e.clientY);
    });
  }
})();

['an-harm-n', 'an-sb-n', 'an-sb-delta'].forEach(function (id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', function () {
    _anReadCursorPrefs();
    if (anData && (anMode === 'fft' || anMode === 'demod')) analyseDraw();
  });
});


// ============================================================
// BOUTONS CTRL-BAR
// ============================================================

/** Vue Temps | FFT — conserve l'unité (g / mm/s / mm). */
function analyseSetView(view) {
  if (!anData) return;
  if (view === 'time') {
    if (anMode === 'time') { anUpdateBtnStates(); return; }
    anMode = 'time';
    anZMin = 0; anZMax = anP.t || 1;
    anCursorX = -1;
    _anClearTimeCursors();
  } else if (view === 'fft') {
    if (anMode === 'time' && anSelStart >= 0 && anSelEnd > anSelStart) {
      analyseFFTSel();
      return;
    }
    if (anMode === 'fft') { anUpdateBtnStates(); return; }
    anMode = 'fft';
    _anInvalidateFft();
    anCursorX = -1;
    _anClearTimeCursors();
    _anZoomFullSpectrum();
  } else return;
  anUpdateBtnStates();
  analyseDraw();
}
window.analyseSetView = analyseSetView;

/** @deprecated — bascule ; préférer analyseSetView */
function analyseToggleFFT() {
  analyseSetView(anMode === 'time' ? 'fft' : 'time');
}

/** Unité g | mm/s | mm — s'applique à Temps et FFT (6 combos). */
function anSetUnit(unit) {
  if (!anData) return;
  if (unit !== 'g' && unit !== 'mm/s' && unit !== 'mm') return;
  anUnit = unit;
  anCursorX = -1;
  if (anMode === 'demod') {
    // Démod reste en enveloppe g — bascule vers FFT pour voir l'unité
    anMode = 'fft';
    _anInvalidateFft();
    _anZoomFullSpectrum();
  } else if (anMode === 'fft') {
    _anEnsureFftA();
    _anEnsureFftB();
    _anZoomFullSpectrum();
  } else {
    _anEnsureTimeIntegrated();
    anYZoom = 1; anYPan = 0;
  }
  anUpdateBtnStates();
  analyseDraw();
}
window.anSetUnit = anSetUnit;

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
      const sig = _anTimeChunk(anDataDisplay || anData);
      const fs  = anP.fs;
      // demodCompute() est défini dans demod.js
      // Si mode manuel, on passe la bande directement (bypass kurtogram)
      anDemodResult = demodCompute(sig, fs, manFlo, manFhi);
      anDemodResultB = null;
      const sigB = anDataDisplayB || anDataB;
      if (sigB && sigB.length) {
        try {
          const chunkB = _anTimeChunk(sigB);
          // Même bande que A (fLow/fHigh du résultat A) pour comparaison
          const flo = anDemodResult.fLow, fhi = anDemodResult.fHigh;
          anDemodResultB = demodCompute(chunkB, fs, flo, fhi);
        } catch (eB) {
          console.warn('[demod B]', eB);
          anDemodResultB = null;
        }
      }
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
  anMagB=null; anMagVelB=null;
  const sigB=anDataDisplayB||anDataB;
  if(sigB&&sigB.length){
    const i1b=Math.min(sigB.length-1,Math.round(anSelEnd*fs));
    const i0b=Math.max(0,Math.round(anSelStart*fs));
    if(i1b-i0b>=63){
      const chunkB=sigB.slice(i0b,i1b+1);
      anMagB=computeFFT(chunkB,chunkB.length,fs);
      anMagVelB=computeVelFFT(chunkB,fs,chunkB.length);
    }
  }
  anMode='fft'; anUnit='g'; anCursorX=-1;
  _anZoomFullSpectrum();
  anUpdateBtnStates();
  const dur=(anSelEnd-anSelStart).toFixed(3);
  document.getElementById('an-fs').textContent +=
    '  [Sél: '+anSelStart.toFixed(3)+'–'+anSelEnd.toFixed(3)+'s  '+dur+'s  N='+n+']';
  analyseDraw();
}

function analyseSelClear(){
  anSelStart=-1;anSelEnd=-1;anSelecting=false;
  _anInvalidateFft();
  _anUpdateSelBtn(); analyseDraw();
}

// ============================================================
// SAUVEGARDE / CHARGEMENT
// ============================================================

function _anDownloadTxt(sig, baseNom, tag) {
  const n = Math.min(anP.n, sig.length);
  const scale = 32768.0 / anP.g;
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(Math.round(sig[i] * scale));
  const txt = 'G=' + anP.g + '\nF=' + anP.fs + '\nT=' + anP.t +
    '\nPROBE=' + tag + '\n' + JSON.stringify(raw) + '\n';
  const blob = new Blob([txt], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stem = baseNom.replace(/\.txt$/i, '');
  a.href = url; a.download = stem + '_' + tag + '.txt'; a.click();
  URL.revokeObjectURL(url);
}

function analyseSave() {
  if (!anData) { alert('Aucune donnée'); return; }
  const pick = _anAskProbe('Sauvegarde');
  if (!pick) return;
  const nom = prompt('Nom du fichier:', 'acq_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  if (!nom) return;
  if (pick === '2') {
    _anDownloadTxt(anData, nom, 'A');
    if (anDataB) setTimeout(function () { _anDownloadTxt(anDataB, nom, 'B'); }, 250);
    return;
  }
  const p = _anSigForProbe(pick);
  if (!p) return;
  _anDownloadTxt(p.sig, nom, p.tag);
}

function _anDownloadCSV(sig, baseNom, tag) {
  const n = Math.min(anP.n, sig.length);
  const dt = 1.0 / anP.fs;
  const lines = [];
  // Lignes G=/F=/T= → rechargeables aussi par le parseur natif
  lines.push('G=' + anP.g);
  lines.push('F=' + (anP.fsOrig || anP.fs));
  lines.push('T=' + anP.t.toFixed(6));
  lines.push('PROBE=' + tag);
  lines.push('# VibrationAnalyser — Export CSV (rechargeable)');
  lines.push('# Probe: ' + tag);
  lines.push('# Date: ' + new Date().toISOString());
  lines.push('# Fs: ' + anP.fs + ' Hz');
  lines.push('# Duration: ' + anP.t.toFixed(6) + ' s');
  lines.push('# Samples: ' + n);
  lines.push('# Range: +/-' + anP.g + ' g');
  lines.push('# Unit: g (1 g = 9.80665 m/s2)');
  lines.push('Time_s,Accel_g');
  for (let i = 0; i < n; i++) {
    lines.push((i * dt).toFixed(7) + ',' + sig[i].toFixed(6));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stem = baseNom.replace(/\.csv$/i, '');
  a.href = url; a.download = stem + '_' + tag + '.csv'; a.click();
  URL.revokeObjectURL(url);
}

function analyseExportCSV() {
  if (!anData) { alert('Aucune donnée'); return; }
  const pick = _anAskProbe('Export CSV');
  if (!pick) return;
  const nom = prompt('Nom du fichier:', 'export_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  if (!nom) return;
  if (pick === '2') {
    _anDownloadCSV(anData, nom, 'A');
    if (anDataB) setTimeout(function () { _anDownloadCSV(anDataB, nom, 'B'); }, 250);
    return;
  }
  const p = _anSigForProbe(pick);
  if (!p) return;
  _anDownloadCSV(p.sig, nom, p.tag);
}

/**
 * Parse capture native (G=/F=/T= + JSON int16) ou export CSV
 * (# Fs / # Range + Time_s,Accel_g).
 * @returns {{ g, fs, t, samples: Float64Array }|null}
 */
function _anParseCaptureText(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const h = {};
  let dataLine = null;
  let csvMode = false;
  const csvAccel = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;

    // ── En-tête natif ──
    if (l.startsWith('G=')) { h.g = parseFloat(l.slice(2)); continue; }
    if (l.startsWith('F=')) { h.fs = parseFloat(l.slice(2)); continue; }
    if (l.startsWith('T=')) { h.t = parseFloat(l.slice(2)); continue; }
    if (l.startsWith('N=')) { h.n = parseInt(l.slice(2), 10); continue; }
    if (l.startsWith('PROBE=')) continue;

    // ── En-tête export CSV (commentaires #) ──
    if (l.charAt(0) === '#') {
      const fsM = l.match(/#\s*Fs\s*:\s*([\d.]+)/i);
      if (fsM) h.fs = parseFloat(fsM[1]);
      const gM = l.match(/#\s*Range\s*:\s*\+\/?-?\s*([\d.]+)/i);
      if (gM) h.g = parseFloat(gM[1]);
      const tM = l.match(/#\s*Duration\s*:\s*([\d.]+)/i);
      if (tM) h.t = parseFloat(tM[1]);
      const nM = l.match(/#\s*Samples\s*:\s*(\d+)/i);
      if (nM) h.n = parseInt(nM[1], 10);
      continue;
    }

    // Ligne titre CSV
    if (/^Time_s\s*,/i.test(l) || /^time\s*,/i.test(l)) {
      csvMode = true;
      continue;
    }

    // Données natives : tableau JSON int16
    if (l.startsWith('[')) {
      dataLine = l;
      break;
    }

    // Ligne CSV time,accel
    if (csvMode || (l.indexOf(',') >= 0 && /^[-+]?\d/.test(l))) {
      const parts = l.split(',');
      if (parts.length >= 2) {
        const ag = parseFloat(parts[1]);
        if (Number.isFinite(ag)) {
          csvMode = true;
          csvAccel.push(ag);
          continue;
        }
      }
    }

    // Ancien format : une valeur float/int par ligne
    if (!csvMode && !dataLine && !l.includes('=')) {
      const v = parseFloat(l);
      if (!isNaN(v)) {
        // peut être début d'une liste mono-colonne — collecté plus bas
        dataLine = 'mono';
      }
    }
  }

  if (!h.g || !h.fs) return null;

  let samples = null;

  if (csvMode && csvAccel.length > 0) {
    // Export CSV : déjà en g
    samples = new Float64Array(csvAccel.length);
    for (let i = 0; i < csvAccel.length; i++) samples[i] = csvAccel[i];
  } else if (dataLine && dataLine.startsWith('[')) {
    let rawArr;
    try { rawArr = JSON.parse(dataLine); }
    catch (e) { return null; }
    if (!rawArr || !rawArr.length) return null;
    const scale = h.g / 32768.0;
    const isInt16 = Math.abs(rawArr[0]) > 10 || Math.abs(rawArr[Math.min(10, rawArr.length - 1)]) > 10;
    samples = new Float64Array(rawArr.length);
    for (let i = 0; i < rawArr.length; i++) {
      samples[i] = isInt16 ? rawArr[i] * scale : rawArr[i];
    }
  } else {
    // Une valeur par ligne (hors en-têtes)
    const rawArr = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.includes('=') || l.charAt(0) === '#' || l.indexOf(',') >= 0) continue;
      const v = parseFloat(l);
      if (!isNaN(v)) rawArr.push(v);
    }
    if (!rawArr.length) return null;
    const scale = h.g / 32768.0;
    const isInt16 = Math.abs(rawArr[0]) > 10;
    samples = new Float64Array(rawArr.length);
    for (let i = 0; i < rawArr.length; i++) {
      samples[i] = isInt16 ? rawArr[i] * scale : rawArr[i];
    }
  }

  if (!samples || !samples.length) return null;

  // Retrait DC
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  for (let i = 0; i < samples.length; i++) samples[i] -= mean;

  return { g: h.g, fs: h.fs, t: h.t, samples: samples };
}

function _anApplyLoadedCapture(parsed, fileName) {
  const n = parsed.samples.length;
  const _fsReal = (typeof fsCorrected === 'function') ? fsCorrected(parsed.fs) : parsed.fs;
  anData = parsed.samples;
  anP = {
    g: parsed.g,
    fs: _fsReal,
    fsOrig: parsed.fs,
    t: parsed.t || (n / _fsReal),
    n: n
  };
  anUpdateStats();
  if (_wavSource) analysePause();
  analyseResetDualSession();
  anMode = 'time'; anZMin = 0; anZMax = anP.t; anYZoom = 1; anYPan = 0;
  anMag = null; anMagVel = null; anCursorX = -1;
  if (typeof _anClearTimeCursors === 'function') _anClearTimeCursors();
  anUnit = 'g'; anDataDisplay = null; anFilterInfo = '';
  anDemodResult = null;
  anSelStart = -1; anSelEnd = -1; _anUpdateSelBtn();
  anUpdateBtnStates();
  if (typeof showTab === 'function') showTab('analyse');
  analyseDraw();
  if (typeof _anPersistSave === 'function') _anPersistSave();
  if (typeof termAddLine === 'function') {
    termAddLine('[analyse] chargé ' + (fileName || '') + ' N=' + n + ' Fs=' + parsed.fs, 'sys');
  }
}

function analyseLoad() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.txt,.csv,text/plain,text/csv';
  inp.onchange = function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      const parsed = _anParseCaptureText(ev.target.result);
      if (!parsed) {
        alert(
          'Format non reconnu.\n\n' +
          '• Recharge : fichier .txt de « Sauv » (G=/F=/ + données)\n' +
          '• Ou CSV de « CSV » (# Fs / # Range + Time_s,Accel_g)\n\n' +
          'Renommer .csv → .txt ne change pas le contenu.'
        );
        return;
      }
      _anApplyLoadedCapture(parsed, file.name);
    };
    reader.onerror = function () { alert('Lecture fichier impossible'); };
    reader.readAsText(file);
  };
  inp.click();
}

// ── Helpers calcul ────────────────────────────────────────
function anCalcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];return Math.sqrt(s/d.length);}
function anCalcMean(d){if(!d||!d.length)return 0;let s=0;for(let i=0;i<d.length;i++)s+=d[i];return s/d.length;}
function anCalcPeak(d){let m=0;for(let i=0;i<d.length;i++)if(Math.abs(d[i])>m)m=Math.abs(d[i]);return m;}

// ============================================================
// EXPORT WAV + PLAYBACK
// ============================================================

function _wavGetSignalFrom(sig){
  const n=sig.length;
  let maxAbs=0;
  for(let i=0;i<n;i++) if(Math.abs(sig[i])>maxAbs) maxAbs=Math.abs(sig[i]);
  const scale=maxAbs>0?1/maxAbs:1;
  const out=new Float32Array(n);
  for(let i=0;i<n;i++) out[i]=sig[i]*scale;
  return out;
}
function _wavGetSignal(){ return _wavGetSignalFrom(anDataDisplay||anData); }

let _wavCtx=null,_wavSource=null;

function analysePlay(){
  if(!anData){alert('Aucune donnée');return;}
  if(_wavSource){analysePause();return;}
  // Play = une sonde à la fois (pas de mix)
  let pick = 'A';
  if (anDataB && anDataB.length) {
    const raw = prompt('Play — sonde ?\n  A = bleu\n  B = orange', anShowB && !anShowA ? 'B' : 'A');
    if (raw === null) return;
    pick = String(raw).trim().toUpperCase() === 'B' ? 'B' : 'A';
  }
  const p = _anSigForProbe(pick);
  if (!p) return;
  _wavCtx=_wavCtx||new(window.AudioContext||window.webkitAudioContext)();
  const f32=_wavGetSignalFrom(p.sig);
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

function _anDownloadWAV(sig, baseNom, tag, filt) {
  const n = sig.length, fs = anP.fs;
  const f32 = _wavGetSignalFrom(sig), scale = 32767;
  const buf = new ArrayBuffer(44 + n * 2), view = new DataView(buf), u8 = new Uint8Array(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, fs, true);
  view.setUint32(28, fs * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ws(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f32[i] * scale))), true);
  const stem = baseNom.replace(/\.wav$/i, '');
  const fname = stem + '_' + tag + (filt ? '_filtre' : '') + '.wav';
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
}

function analyseExportWAV(){
  if(!anData){alert('Aucune donnée');return;}
  const pick = _anAskProbe('Export WAV');
  if (!pick) return;
  const defNom = 'acq_' + anP.fs + 'Hz';
  const nom = prompt('Nom du fichier WAV:', defNom);
  if (!nom) return;
  if (pick === '2') {
    _anDownloadWAV(anDataDisplay || anData, nom, 'A', !!anDataDisplay);
    if (anDataB) {
      setTimeout(function () {
        _anDownloadWAV(anDataDisplayB || anDataB, nom, 'B', !!anDataDisplayB);
      }, 250);
    }
    return;
  }
  const p = _anSigForProbe(pick);
  if (!p) return;
  _anDownloadWAV(p.sig, nom, p.tag, p.filt);
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
  // FFT 65k ×2 (A+B) bloque le thread → heartbeat WS tombe. Async + hold.
  _anRunFilterAsync(t, f1, f2);
}

function _anRunFilterAsync(t, f1, f2) {
  const st = document.getElementById('an-fs');
  const prev = st ? st.textContent : '';
  if (st) st.textContent = 'Filtre… A';
  if (typeof wsBeginHeavy === 'function') wsBeginHeavy();
  if (typeof termAddLine === 'function') termAddLine('[filtre] calcul A…', 'sys');

  setTimeout(function () {
    try {
      anDataDisplay = applyFilter(anData, anP.fs, t, f1, f2);
    } catch (e) {
      if (typeof termAddLine === 'function') termAddLine('[filtre] !! erreur A: ' + e, 'sys');
    }
    if (typeof wsBeginHeavy === 'function') { /* keep hold */ }
    if (st) st.textContent = anDataB ? 'Filtre… B' : 'Filtre… fin';

    setTimeout(function () {
      try {
        anDataDisplayB = anDataB ? applyFilter(anDataB, anP.fs, t, f1, f2) : null;
      } catch (e) {
        if (typeof termAddLine === 'function') termAddLine('[filtre] !! erreur B: ' + e, 'sys');
        anDataDisplayB = null;
      }
      if (t === 'ph') anFilterInfo = 'PH ' + f1.toFixed(0) + ' Hz';
      else if (t === 'pb') anFilterInfo = 'PB ' + f1.toFixed(0) + ' Hz';
      else anFilterInfo = 'BP ' + f1.toFixed(0) + '-' + f2.toFixed(0) + ' Hz';
      anMag = null; anMagVel = null; anMagDisp = null;
      anMagB = null; anMagVelB = null; anMagDispB = null;
      _anInvalidateTimeIntegrated();
      _anUpdateFilterLabel();
      if (anMode === 'fft') {
        anMode = 'time'; anZMin = 0; anZMax = anP.t; anUpdateBtnStates();
      }
      anCursorX = -1;
      if (typeof wsEndHeavy === 'function') wsEndHeavy();
      if (st && !anFilterInfo) st.textContent = prev;
      analyseDraw();
      if (typeof termAddLine === 'function') termAddLine('[filtre] OK ' + anFilterInfo, 'sys');
    }, 30);
  }, 30);
}

function analyseFilterReset(){
  anDataDisplay=null;anDataDisplayB=null;anFilterInfo='';
  anMag=null;anMagVel=null;anMagDisp=null;
  anMagB=null;anMagVelB=null;anMagDispB=null;
  _anInvalidateTimeIntegrated();
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
