// fft.js — Live FFT : raies fines, pan 1 doigt, zoom X pinch
// DOUBLE : spectre A (bleu) + B (orange) superposés
let fftMag = null;
let fftMagB = null;
let fftMagVel = null;
let fftMagVelB = null;
let fftP   = { g:2, fs:1000, n:4096 };
let fftZMin = 60, fftZMax = 3000;   // min = 60 RPM (filtre passe-haut)
let fftAutoScale = true;
let fftRunning   = false;
let _fftDualSession = false; // session DOUBLE (UI A+B dès le Start)
let fftCursorBin = -1;
const FPAD = { l:52, r:12, t:14, b:30 };
const FFT_COLOR_A = '#0033cc';
const FFT_COLOR_B = '#e67e22';
const FFT_FILL_A  = 'rgba(0,51,204,0.07)';
const FFT_FILL_B  = 'rgba(230,126,34,0.07)';

/** Sonde affichée dans le slot primaire (fftMag) — mono B = données B routées ici. */
function _fftPrimaryTag() {
  if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) return 'B';
  return 'A';
}
function _fftPrimaryColor() {
  return _fftPrimaryTag() === 'B' ? FFT_COLOR_B : FFT_COLOR_A;
}
function _fftPrimaryFill() {
  return _fftPrimaryTag() === 'B' ? FFT_FILL_B : FFT_FILL_A;
}

// ── Filtre passe-haut permanent ───────────────────────────────
// Tous les spectres (g et mm/s) sont filtrés sous HP_RPM_MIN
const HP_RPM_MIN = 60;   // RPM
const HP_HZ_MIN  = HP_RPM_MIN / 60.0;  // Hz = 1.0 Hz

// ── Unité FFT ─────────────────────────────────────────────────
let fftUnit = 'g';       // 'g' | 'mm/s'
let _fftLastSigA = null; // pour status RMS

function fftMaxRpmG(fs)   { return (fs / 2) * 60; }
function fftMaxRpmVel(fs) { return Math.min((fs / 2) * 60, 60000); }

function _fftFillSig(g, n, raw) {
  const scale = g / 32768.0;
  const sig = new Float64Array(n);
  const lim = Math.min(n, raw.length);
  for (let i = 0; i < lim; i++) sig[i] = raw[i] * scale;
  return sig;
}

function _fftUpdateStatus(sig) {
  if (!fftMag) return;
  const fs = fftP.fs, n = fftP.n;
  const mag = fftUnit === 'g' ? fftMag : (fftMagVel || fftMag);
  const nFFT = nextPow2(n);
  const rpmPB = (fs / nFFT) * 60;
  const minBinHP = Math.max(1, Math.ceil(HP_RPM_MIN / rpmPB));
  const maxBin = Math.min(mag.length - 1,
    Math.floor((fftUnit === 'mm/s' ? fftMaxRpmVel(fs) : fftMaxRpmG(fs)) / rpmPB));
  const pk = fftPeakInfo(mag, fs, n, minBinHP);
  let statusStr;
  const tag = _fftPrimaryTag();
  if (fftUnit === 'mm/s' && sig) {
    const rmsIso = calcRmsIso(sig, fs, n);
    statusStr = 'Pic ' + tag + ': ' + pk.rpm.toFixed(0) + ' RPM  ' + pk.amp.toFixed(3) + ' mm/s' +
                '   |   RMS ISO: ' + rmsIso.toFixed(3) + ' mm/s';
  } else {
    const rmsG = fftSpecRMS(fftMag, minBinHP, maxBin);
    statusStr = 'Pic ' + tag + ': ' + pk.rpm.toFixed(0) + ' RPM  ' + pk.amp.toFixed(4) + ' g' +
                '   |   RMS: ' + rmsG.toFixed(4) + ' g';
  }
  if (_fftDualSession || fftMagB) statusStr += '   |   A+B';
  const st = document.getElementById('fft-status');
  if (st) st.textContent = statusStr;
  const meta = document.getElementById('fft-meta');
  if (meta) {
    meta.textContent = 'Fs=' + fs + 'Hz  N=' + n + '  ±' + fftP.g + 'g' +
      ((_fftDualSession || fftMagB) ? '  A+B' : ('  sonde ' + tag));
  }
}

// ── Réception bloc A ─────────────────────────────────────────
function fftReceiveBloc(g, fs, n, raw) {
  fftP = { g, fs, n };
  const sig = _fftFillSig(g, n, raw);
  _fftLastSigA = sig;
  fftMag    = computeFFT(sig, n, fs);
  fftMagVel = computeVelFFT(sig, fs, n);

  if (fftAutoScale) {
    const useMag = fftUnit === 'g' ? fftMag : fftMagVel;
    const maxRpm = fftUnit === 'g' ? fftMaxRpmG(fs) : fftMaxRpmVel(fs);
    const rpmPB  = (fs / nextPow2(n)) * 60;
    const minBinHP = Math.max(1, Math.ceil(HP_RPM_MIN / rpmPB));
    const maxBin   = Math.min(nextPow2(n) / 2 - 1, Math.floor(maxRpm / rpmPB));
    const pk = fftPeakBin(useMag, maxBin, minBinHP);
    fftZMin = HP_RPM_MIN;
    fftZMax = Math.min(Math.max(600, pk * rpmPB * 4), maxRpm);
  }

  showTab('fft');
  _fftWaitHide();
  fftDraw();
  _fftUpdateStatus(sig);
}

/** Réception ESP B (mode DOUBLE) — jamais via le slot primaire. */
function fftReceiveBlocB(g, fs, n, raw) {
  // Accepte B si session dual / ProbeMode AB / live déjà lancé
  if (!_fftDualSession) {
    if (typeof ProbeMode !== 'undefined' && ProbeMode.isDual()) {
      _fftDualSession = true;
    } else if (typeof DualSession !== 'undefined' && DualSession.is()) {
      _fftDualSession = true;
    } else if (fftRunning) {
      _fftDualSession = true;
    } else {
      return;
    }
  }
  // Même N que A si déjà reçu → axes RPM alignés
  const nUse = (fftP && fftP.n) ? Math.min(fftP.n, n, raw.length) : Math.min(n, raw.length);
  const fsUse = fs || (fftP && fftP.fs) || 1000;
  const sig = _fftFillSig(g, nUse, raw);
  fftMagB    = computeFFT(sig, nUse, fsUse);
  fftMagVelB = computeVelFFT(sig, fsUse, nUse);
  showTab('fft');
  if (fftMag) _fftWaitHide();
  fftDraw();
  _fftUpdateStatus(_fftLastSigA);
}
window.fftReceiveBlocB = fftReceiveBlocB;

// ── Prochaine puissance de 2 ──────────────────────────────────
function nextPow2(n) { let p=1; while(p<n) p<<=1; return p; }

// ── FFT Cooley-Tukey (Hanning + zero-pad) ────────────────────
// Filtre passe-haut : bins sous HP_HZ_MIN remis à zéro (si fs fourni)
function computeFFT(sig, n, fs) {
  const nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i=0;i<n;i++) re[i]=sig[i]*0.5*(1-Math.cos(2*Math.PI*i/(n-1)));
  fftRaw(re, im, nFFT);
  const half = nFFT/2;
  const mag  = new Float64Array(half);
  const df      = fs ? (fs / nFFT) : 0;
  const binCoup = fs ? Math.ceil(HP_HZ_MIN / df) : 1;
  for (let i=0; i<half; i++) {
    if (i < binCoup) { mag[i] = 0; continue; }  // filtre passe-haut
    mag[i] = Math.sqrt(re[i]*re[i]+im[i]*im[i])/(n/2);
  }
  return mag;
}

// ── FFT Cooley-Tukey in-place ────────────────────────────────
function fftRaw(re, im, n) {
  let j=0;
  for (let i=1;i<n;i++){
    let b=n>>1; for(;j&b;b>>=1)j^=b; j^=b;
    if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
  }
  for (let len=2;len<=n;len<<=1){
    const a=-2*Math.PI/len, wR=Math.cos(a), wI=Math.sin(a);
    for (let i=0;i<n;i+=len){
      let cR=1,cI=0;
      for (let k=0;k<len/2;k++){
        const uR=re[i+k],uI=im[i+k],vR=re[i+k+len/2],vI=im[i+k+len/2];
        const tR=cR*vR-cI*vI,tI=cR*vI+cI*vR;
        re[i+k]=uR+tR;im[i+k]=uI+tI;re[i+k+len/2]=uR-tR;im[i+k+len/2]=uI-tI;
        const nr=cR*wR-cI*wI;cI=cR*wI+cI*wR;cR=nr;
      }
    }
  }
}

// ── Intégration fréquentielle → spectre vitesse mm/s ─────────
// Filtre passe-haut à HP_HZ_MIN (1 Hz = 60 RPM) intégré dans l'intégration
function computeVelFFT(sig_g, fs, n) {
  const nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i = 0; i < n; i++) re[i] = sig_g[i] * 9.80665;
  fftRaw(re, im, nFFT);
  const df = fs / nFFT;
  const vr = new Float64Array(nFFT), vi = new Float64Array(nFFT);
  for (let k = 1; k < nFFT / 2; k++) {
    const fk = k * df;
    // Filtre passe-haut : zéro tous les bins sous HP_HZ_MIN
    if (fk < HP_HZ_MIN) { vr[k]=vi[k]=vr[nFFT-k]=vi[nFFT-k]=0; continue; }
    const w = 2 * Math.PI * fk;
    vr[k] = im[k]/w; vi[k] = -re[k]/w;
    vr[nFFT-k] = vr[k]; vi[nFFT-k] = -vi[k];
  }
  vr[nFFT/2] = 0; vi[nFFT/2] = 0;
  for (let i = 0; i < nFFT; i++) vi[i] = -vi[i];
  fftRaw(vr, vi, nFFT);
  let mean = 0;
  for (let i = 0; i < n; i++) { vr[i] /= nFFT; mean += vr[i]; }
  mean /= n;
  const velMm = new Float64Array(n);
  for (let i = 0; i < n; i++) velMm[i] = (vr[i] - mean) * 1000.0;
  return computeFFT(velMm, n);   // pas de fs ici (déjà filtré)
}

// ── RMS ISO (bandpass 10 Hz – min(10 kHz, 0.49·fs)) ─────────
function calcRmsIso(sig_g, fs, n) {
  const nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i = 0; i < n; i++) re[i] = sig_g[i] * 9.80665;
  fftRaw(re, im, nFFT);
  const df = fs / nFFT;
  const fLow = 10.0, fHigh = Math.min(10000.0, 0.49 * fs);
  const vr = new Float64Array(nFFT), vi = new Float64Array(nFFT);
  for (let k = 1; k < nFFT / 2; k++) {
    const fk = k * df;
    if (fk < fLow || fk > fHigh) { vr[k]=vi[k]=vr[nFFT-k]=vi[nFFT-k]=0; continue; }
    const w = 2 * Math.PI * fk;
    vr[k] = im[k]/w; vi[k] = -re[k]/w;
    vr[nFFT-k] = vr[k]; vi[nFFT-k] = -vi[k];
  }
  for (let i = 0; i < nFFT; i++) vi[i] = -vi[i];
  fftRaw(vr, vi, nFFT);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const v = vr[i] / nFFT * 1000.0; sumSq += v * v; }
  return Math.sqrt(sumSq / n);
}

/** Trace un spectre avec SON propre axe RPM (évite B fantôme si N≠A). */
function _fftStrokeMag(ctx, mag, fs, zMin, zMax, span, pW, pH, aS, color, fill, maxA) {
  if (!mag || !mag.length) return;
  const P = FPAD;
  const nFFT = mag.length * 2;
  const rpmPB = (fs / nFFT) * 60;
  const minBin = Math.max(1, Math.ceil(zMin / rpmPB));
  const maxBin = Math.min(mag.length - 1, Math.ceil(zMax / rpmPB));
  if (maxBin < minBin) return;

  ctx.beginPath();
  let fi = true;
  for (let i = minBin; i <= maxBin; i++) {
    const x = P.l + (i * rpmPB - zMin) / span * pW;
    const y = P.t + pH - mag[i] * aS;
    if (fi) { ctx.moveTo(x, P.t + pH); ctx.lineTo(x, y); fi = false; }
    else ctx.lineTo(x, y);
  }
  if (!fi) {
    ctx.lineTo(P.l + (maxBin * rpmPB - zMin) / span * pW, P.t + pH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  const ppb = pW / (maxBin - minBin + 1);
  if (ppb >= 1.2) {
    ctx.lineWidth = Math.min(1.5, ppb * 0.7);
    ctx.strokeStyle = color;
    const thr = maxA * 0.0005;
    for (let i = minBin; i <= maxBin; i++) {
      if (mag[i] < thr) continue;
      const x = P.l + (i * rpmPB - zMin) / span * pW;
      const y = P.t + pH - mag[i] * aS;
      ctx.beginPath(); ctx.moveTo(x, P.t + pH); ctx.lineTo(x, y); ctx.stroke();
    }
  } else {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    let ff = true;
    for (let i = minBin; i <= maxBin; i++) {
      const x = P.l + (i * rpmPB - zMin) / span * pW;
      const y = P.t + pH - mag[i] * aS;
      if (ff) { ctx.moveTo(x, y); ff = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function _fftMaxInView(mag, fs, zMin, zMax) {
  if (!mag || !mag.length) return 0;
  const nFFT = mag.length * 2;
  const rpmPB = (fs / nFFT) * 60;
  const minBin = Math.max(1, Math.ceil(zMin / rpmPB));
  const maxBin = Math.min(mag.length - 1, Math.ceil(zMax / rpmPB));
  let m = 0;
  for (let i = minBin; i <= maxBin; i++) if (mag[i] > m) m = mag[i];
  return m;
}

// ── Dessin spectre (A bleu / B orange — g et mm/s) ───────────
function fftDraw() {
  if (!fftMag) return;
  const canvas = document.getElementById('fft-canvas');
  const wrap   = document.getElementById('fft-canvas-wrap');
  const W = wrap.offsetWidth || window.innerWidth;
  const H = wrap.offsetHeight || 300;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const isVel = (fftUnit === 'mm/s');
  const mag   = isVel ? (fftMagVel || fftMag) : fftMag;
  const magB  = isVel ? fftMagVelB : fftMagB;
  const fs = fftP.fs, n = fftP.n;
  const maxRpm = isVel ? fftMaxRpmVel(fs) : fftMaxRpmG(fs);
  const yLabel = isVel ? 'Vitesse (mm/s)' : 'Amplitude (g)';
  const decimals = isVel ? 2 : 3;

  const zMin  = Math.max(fftZMin, HP_RPM_MIN);
  const zMax  = Math.min(fftZMax, maxRpm);
  const _nFFT = (fftMag ? fftMag.length * 2 : nextPow2(n));
  const P = FPAD, rpmPB = (fs / _nFFT) * 60;
  const minB = Math.max(1, Math.ceil(zMin / rpmPB));
  const maxB = Math.min(_nFFT / 2 - 1, Math.ceil(zMax / rpmPB));
  const pW = W - P.l - P.r, pH = H - P.t - P.b, span = zMax - zMin;
  // magB suffit : après Stop on garde la dernière trame B même si session close
  const dual = !!magB;

  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
  ctx.strokeRect(P.l, P.t, pW, pH);

  let maxA = _fftMaxInView(mag, fs, zMin, zMax);
  if (magB) maxA = Math.max(maxA, _fftMaxInView(magB, fs, zMin, zMax));
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
  for (let t = 0; t <= xt; t++) {
    const rpm = zMin + span * t / xt, x = P.l + (rpm - zMin) / span * pW;
    if (t > 0 && t < xt) {
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t + pH); ctx.stroke();
    }
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, P.t + pH); ctx.lineTo(x, P.t + pH + 4); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = '9px Arial'; ctx.textAlign = 'center';
    ctx.fillText(rpm >= 1000 ? (rpm / 1000).toFixed(1) + 'k' : rpm.toFixed(0), x, H - 2);
  }
  ctx.fillStyle = '#555'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
  ctx.fillText('Frequence (RPM)', P.l + pW / 2, H);

  ctx.save(); ctx.beginPath(); ctx.rect(P.l, P.t, pW, pH); ctx.clip();
  // Duo : B sous A. Mono B : slot primaire en orange « B ».
  if (magB) {
    _fftStrokeMag(ctx, magB, fs, zMin, zMax, span, pW, pH, aS, FFT_COLOR_B, FFT_FILL_B, maxA);
  }
  _fftStrokeMag(ctx, mag, fs, zMin, zMax, span, pW, pH, aS,
    dual ? FFT_COLOR_A : _fftPrimaryColor(),
    dual ? FFT_FILL_A : _fftPrimaryFill(), maxA);
  ctx.restore();

  if (fftCursorBin >= minB && fftCursorBin <= maxB) {
    _fftDrawHarmonics(ctx, mag, fftCursorBin, rpmPB, zMin, span,
                      pW, pH, P, W, aS, minB, maxB);
  }

  const pkB = fftPeakBin(mag, maxB, minB);
  if (pkB >= minB) {
    const xP = P.l + (pkB * rpmPB - zMin) / span * pW;
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(xP, P.t); ctx.lineTo(xP, P.t + pH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#666'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left';
    ctx.fillText((pkB * rpmPB).toFixed(0) + ' RPM', Math.min(xP + 3, W - 70), P.t + 12);
  }

  ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left';
  if (dual) {
    ctx.fillStyle = FFT_COLOR_A; ctx.fillText('A', P.l + 6, P.t + 12);
    ctx.fillStyle = FFT_COLOR_B; ctx.fillText('B', P.l + 28, P.t + 12);
  } else {
    const tag = _fftPrimaryTag();
    ctx.fillStyle = _fftPrimaryColor();
    ctx.fillText(tag, P.l + 6, P.t + 12);
  }
}

// ── Touch FFT ────────────────────────────────────────────────
const fftWrap = document.getElementById('fft-canvas-wrap');
let tMode  = 'none';
let panX0  = 0, panMin0 = 0, panMax0 = 0;
let pinD0  = 0, pinMin0 = 0, pinMax0 = 0;
let tX0    = 0, tY0 = 0;

let _fftLongTimer  = null;
let _fftLongAnimId = null;
let _fftLongStart  = 0;
let _fftLongActive = false;
const FFT_LONG_MS  = 600;
const FFT_LONG_PX  = 15;

fftWrap.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    tX0 = e.touches[0].clientX;
    tY0 = e.touches[0].clientY;
    panMin0 = fftZMin; panMax0 = fftZMax;
    tMode = 'wait';

    _fftLongStart  = performance.now();
    _fftLongActive = true;
    _fftLongTimer  = setTimeout(() => {
      _fftLongTimer  = null;
      _fftLongActive = false;
      _fftCancelLongAnim();
      if (navigator.vibrate) navigator.vibrate(40);
      tMode = 'cursor_locked';
      if (fftMag) { fftSetCursor(tX0); fftDraw(); }
    }, FFT_LONG_MS);

    _fftLongAnimId = requestAnimationFrame(_fftDrawLongArc);

  } else if (e.touches.length === 2) {
    _fftCancelLong();
    tMode  = 'pinch';
    pinD0  = fftDist(e); pinMin0 = fftZMin; pinMax0 = fftZMax;
  }
}, { passive: true });

fftWrap.addEventListener('touchmove', (e) => {
  if (!fftMag) return;
  const maxRpm = fftUnit === 'mm/s' ? fftMaxRpmVel(fftP.fs) : fftMaxRpmG(fftP.fs);

  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - tX0;
    const dy = e.touches[0].clientY - tY0;

    if (_fftLongActive && Math.sqrt(dx*dx + dy*dy) > FFT_LONG_PX) {
      _fftCancelLong();
      if (tMode === 'wait') tMode = 'pan';
    }

    if (tMode === 'wait') {
      if (Math.abs(dx) > FFT_LONG_PX) {
        _fftCancelLong();
        tMode = 'pan';
      } else {
        return;
      }
    }

    if (tMode === 'cursor_locked') {
      fftSetCursor(e.touches[0].clientX);
      fftDraw();
      return;
    }

    if (tMode === 'pan') {
      const canvas = document.getElementById('fft-canvas');
      const pW   = canvas.width - FPAD.l - FPAD.r;
      const span = panMax0 - panMin0;
      const dRpm = -(dx / pW) * span;
      const nMin = Math.max(HP_RPM_MIN, panMin0 + dRpm);  // jamais sous HP_RPM_MIN
      const nMax = nMin + span;
      if (nMax <= maxRpm) { fftZMin=nMin; fftZMax=nMax; }
      fftAutoScale = false;
      fftDraw();
    }

  } else if (tMode === 'pinch' && e.touches.length === 2) {
    const r = pinD0 / fftDist(e);
    const c = (pinMin0+pinMax0)/2, h = (pinMax0-pinMin0)/2*r;
    fftZMin = Math.max(HP_RPM_MIN, c-h);  // jamais sous HP_RPM_MIN
    fftZMax = Math.min(maxRpm, c+h);
    if (fftZMax - fftZMin < 100) fftZMax = fftZMin + 100;
    fftAutoScale = false;
    fftDraw();
  }
}, { passive: true });

fftWrap.addEventListener('touchend', () => {
  _fftCancelLong();
  if (tMode === 'wait' && fftMag) {
    fftSetCursor(tX0);
    fftDraw();
  }
  tMode = 'none';
}, { passive: true });

// ── Long press helpers ────────────────────────────────────────
function _fftCancelLong() {
  if (_fftLongTimer) { clearTimeout(_fftLongTimer); _fftLongTimer = null; }
  _fftLongActive = false;
  _fftCancelLongAnim();
}
function _fftCancelLongAnim() {
  if (_fftLongAnimId) { cancelAnimationFrame(_fftLongAnimId); _fftLongAnimId = null; }
}

function _fftDrawLongArc() {
  if (!_fftLongActive) return;
  const elapsed  = performance.now() - _fftLongStart;
  const progress = Math.min(elapsed / FFT_LONG_MS, 1);
  const canvas   = document.getElementById('fft-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx     = (tX0 - rect.left) * scaleX;
  const cy     = (tY0 - rect.top)  * scaleY;
  const R      = 20;
  fftDraw();
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2*Math.PI); ctx.stroke();
  ctx.strokeStyle = '#0066cc';
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI/2, -Math.PI/2 + 2*Math.PI*progress);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,100,200,0.4)';
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2*Math.PI); ctx.fill();
  ctx.restore();
  _fftLongAnimId = requestAnimationFrame(_fftDrawLongArc);
}

// ── Placement curseur ─────────────────────────────────────────
function _fftDrawHarmonics(ctx, mag, bin1, rpmPB, zMin, span,
                            pW, pH, P, W, aS, minB, maxB) {
  const harmonics = [
    { mult: 1, color: '#cc0000', dash: [3,2], label: '1x' },
    { mult: 2, color: '#7700cc', dash: [5,2], label: '2x' },
    { mult: 3, color: '#cc5500', dash: [5,2], label: '3x' },
  ];

  harmonics.forEach(({ mult, color, dash, label }) => {
    const bin = bin1 * mult;
    if (bin < 1 || bin > maxB) return;
    const rpm = bin * rpmPB;
    if (rpm < zMin || rpm > zMin + span) return;

    const x  = P.l + (rpm - zMin) / span * pW;
    const y  = P.t + pH - mag[bin] * aS;

    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t + pH); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, mult === 1 ? 4 : 3, 0, 2*Math.PI); ctx.fill();

    const amp   = mag[bin].toFixed(mult === 1 ? 4 : 3);
    const lines = [label + ' ' + rpm.toFixed(0) + ' RPM', amp];
    ctx.font = (mult === 1 ? 'bold ' : '') + '9px Arial';
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
    const bw = tw + 6, bh = lines.length * 12 + 3;
    const yOff = mult === 1 ? P.t + 16 : mult === 2 ? P.t + 40 : P.t + 64;
    const bx   = (x + bw + 4 > W - P.r) ? x - bw - 4 : x + 3;

    ctx.fillStyle = 'rgba(255,255,220,0.92)';
    ctx.fillRect(bx, yOff, bw, bh);
    ctx.strokeStyle = color; ctx.lineWidth = 0.7;
    ctx.strokeRect(bx, yOff, bw, bh);
    ctx.fillStyle = color; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + 3, yOff + 10 + i * 12));
  });
}

function fftSetCursor(clientX) {
  const canvas = document.getElementById('fft-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const tx     = (clientX - rect.left) * scaleX;
  const pW     = canvas.width - FPAD.l - FPAD.r;
  const maxRpm = fftUnit === 'mm/s' ? fftMaxRpmVel(fftP.fs) : fftMaxRpmG(fftP.fs);
  const zMin   = Math.max(fftZMin, HP_RPM_MIN);
  const zMax   = Math.min(fftZMax, maxRpm);
  const span   = zMax - zMin;
  const nFFT   = nextPow2(fftP.n);
  const rpmPB  = (fftP.fs / nFFT) * 60;
  const bin    = Math.round((zMin + ((tx - FPAD.l) / pW) * span) / rpmPB);
  const maxB   = Math.floor(nFFT / 2) - 1;
  if (bin < 1 || bin > maxB) return;
  fftCursorBin = bin;
  const mag  = (fftUnit === 'mm/s' && fftMagVel) ? fftMagVel : fftMag;
  const u    = fftUnit;
  const rpm1 = (bin * rpmPB).toFixed(1);
  const hz1  = (bin * fftP.fs / nFFT).toFixed(2);
  const a1   = bin < mag.length ? mag[bin].toFixed(4) : '---';
  const bin2 = bin * 2, bin3 = bin * 3;
  const a2   = (bin2 < mag.length) ? mag[bin2].toFixed(4) : '---';
  const a3   = (bin3 < mag.length) ? mag[bin3].toFixed(4) : '---';
  document.getElementById('fft-cursor-info').textContent =
    '1x: ' + rpm1 + ' RPM  ' + hz1 + ' Hz  ' + a1 + ' ' + u +
    '   |   2x: ' + (bin2*rpmPB).toFixed(0) + ' RPM  ' + a2 + ' ' + u +
    '   |   3x: ' + (bin3*rpmPB).toFixed(0) + ' RPM  ' + a3 + ' ' + u;
}

function fftDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

// ── Helpers spectres ──────────────────────────────────────────
// minStart optionnel : bin de départ pour chercher le pic (défaut 1)
function fftPeakBin(mag, maxB, minStart) {
  const start = minStart || 1;
  let b=0, v=0;
  for (let i=start; i<=maxB; i++) if (mag[i]>v) { v=mag[i]; b=i; }
  return b;
}
function fftPeakInfo(mag, fs, n, minStart) {
  const nFFT = mag.length * 2;
  const fr   = fs / nFFT;
  const start = minStart || 1;
  let b=0, v=0;
  for (let i=start; i<mag.length; i++) if (mag[i]>v) { v=mag[i]; b=i; }
  return { hz: b*fr, rpm: b*fr*60, amp: v };
}
function fftSpecRMS(mag, minBin, maxBin) {
  let s = 0;
  for (let i = minBin; i <= maxBin; i++) s += mag[i] * mag[i];
  return Math.sqrt(s * 2);
}

// ── Attente 1ère trame (même overlay / anneau que temporel) ───
let _fftWaitRaf = null;
let _fftWaitActive = false;

function _fftWaitShow(msg) {
  _fftWaitActive = true;
  const ov = document.getElementById('fft-wait-overlay');
  const lbl = document.getElementById('fft-wait-label');
  if (lbl) lbl.textContent = msg || 'Live FFT…';
  if (ov) { ov.style.display = 'flex'; ov.setAttribute('aria-hidden', 'false'); }
  const st = document.getElementById('fft-status');
  if (st) st.textContent = msg || 'En attente 1ère trame…';
  if (_fftWaitRaf) cancelAnimationFrame(_fftWaitRaf);
  _fftWaitRaf = requestAnimationFrame(_fftWaitAnim);
}

function _fftWaitHide() {
  _fftWaitActive = false;
  if (_fftWaitRaf) { cancelAnimationFrame(_fftWaitRaf); _fftWaitRaf = null; }
  const ov = document.getElementById('fft-wait-overlay');
  if (ov) { ov.style.display = 'none'; ov.setAttribute('aria-hidden', 'true'); }
  const ring = document.getElementById('fft-wait-ring');
  if (ring) {
    const ctx = ring.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, ring.width, ring.height);
  }
}

function _fftWaitAnim() {
  if (!_fftWaitActive) return;
  const canvas = document.getElementById('fft-wait-ring');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2, R = 46;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    // Même rendu que phase « transfert » temporelle
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
  }
  _fftWaitRaf = requestAnimationFrame(_fftWaitAnim);
}

// ── Contrôles boutons ─────────────────────────────────────────
/**
 * LIVE_START sur A (+ B si dual).
 * @param {boolean} [dualFlag] — passé par DualSession.onReady (fiable après wsGoto reset)
 */
function _fftFireLiveStart(dualFlag) {
  fftMag = null; fftMagVel = null;
  fftMagB = null; fftMagVelB = null;
  if (typeof dualFlag === 'boolean') {
    _fftDualSession = dualFlag;
    if (dualFlag && typeof DualSession !== 'undefined') DualSession.begin();
  } else {
    _fftDualSession = (typeof DualSession !== 'undefined') ? DualSession.is() : false;
  }
  _fftWaitShow(_fftDualSession ? 'Live FFT A+B…' : 'Live FFT…');
  // A+B ensemble — B a déjà reçu WS_GOTO=ANAL_LIVE avant le NAV_ACK de A
  if (_fftDualSession && typeof DualSession !== 'undefined') {
    DualSession.sendBoth('LIVE_START');
  } else {
    wsSend('LIVE_START');
  }
}
window._fftStartDualLive = _fftFireLiveStart;

function fftToggle() {
  const btn = document.getElementById('btn-fft-start');
  if (!fftRunning) {
    const ready = function (dual) {
      _fftFireLiveStart(dual);
      fftRunning = true;
      if (btn) {
        btn.textContent = '■ Stop';
        btn.classList.add('running');
      }
    };
    _fftWaitShow('Connexion Live FFT…');
    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('fft', 'WS_GOTO=ANAL_LIVE', {
        label: 'Live FFT',
        onReady: ready,
        onFail: function () {
          _fftWaitHide();
          if (typeof termAddLine === 'function') {
            termAddLine('!! Live FFT: NAV timeout', 'sys');
          }
        },
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('fft', 'WS_GOTO=ANAL_LIVE', {
        onAck: function () { ready(false); },
        onTimeout: function () {
          _fftWaitHide();
          if (typeof termAddLine === 'function') {
            termAddLine('!! Live FFT: NAV timeout', 'sys');
          }
        },
      });
    } else {
      wsSend('WS_GOTO=ANAL_LIVE');
      setTimeout(function () { ready(false); }, 400);
    }
  } else {
    if (typeof DualSession !== 'undefined') DualSession.stopBoth('r');
    else wsSend('r');
    fftRunning = false;
    _fftWaitHide();
    // Garder fftMag / fftMagB : gel de la dernière trame pour zoom / pan après Stop
    // (effacés au prochain Start dans _fftFireLiveStart)
    if (btn) {
      btn.textContent = '▶ Live FFT';
      btn.classList.remove('running');
    }
    fftDraw();
  }
}
function fftManualZoom(f) {
  fftAutoScale = false;
  const maxRpm = fftUnit === 'mm/s' ? fftMaxRpmVel(fftP.fs) : fftMaxRpmG(fftP.fs);
  const c = (fftZMin+fftZMax)/2, h = (fftZMax-fftZMin)/2*f;
  fftZMin = Math.max(HP_RPM_MIN, c-h);  // jamais sous HP_RPM_MIN
  fftZMax = Math.min(maxRpm, c+h);
  if (fftZMax - fftZMin < 100) fftZMax = fftZMin + 100;
  fftDraw();
}
function fftToggleUnit() {
  fftUnit = (fftUnit === 'g') ? 'mm/s' : 'g';
  const btn = document.getElementById('btn-fft-unit');
  btn.textContent = fftUnit;
  btn.classList.toggle('active', fftUnit === 'mm/s');
  fftCursorBin = -1;
  if (fftAutoScale && fftMag) {
    const mag    = fftUnit === 'g' ? fftMag : (fftMagVel || fftMag);
    const maxRpm = fftUnit === 'mm/s' ? fftMaxRpmVel(fftP.fs) : fftMaxRpmG(fftP.fs);
    const nFFT   = nextPow2(fftP.n);
    const rpmPB  = (fftP.fs / nFFT) * 60;
    const minBinHP = Math.max(1, Math.ceil(HP_RPM_MIN / rpmPB));
    const maxBin = Math.min(nFFT/2-1, Math.floor(maxRpm / rpmPB));
    const pk = fftPeakBin(mag, maxBin, minBinHP);
    fftZMin = HP_RPM_MIN;
    fftZMax = Math.min(Math.max(600, pk*rpmPB*4), maxRpm);
  } else {
    fftZMin = Math.max(fftZMin, HP_RPM_MIN);
    if (fftUnit === 'mm/s') fftZMax = Math.min(fftZMax, fftMaxRpmVel(fftP.fs));
  }
  fftDraw();
}