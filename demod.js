// demod.js — Démodulation d'enveloppe (DSP uniquement, pas de rendu)
// Dépendances : fftRaw() et nextPow2() de fft.js
// Le rendu est assuré par analyse.js (anDrawDemod)

const DEMOD_HZ_PER_RPM = 60.0;
const DEMOD_FMAX_RPM   = 60000;

// ════════════════════════════════════════════════════════════
// 1.  PRIMITIVES DSP
// ════════════════════════════════════════════════════════════

/**
 * Filtre passe-bande domaine fréquentiel avec transitions cosinus.
 * Évite le ringing de Gibbs (même approche que applyFilter dans analyse.js).
 */
function demodBandpass(sig, fs, fLow, fHigh) {
  const n = sig.length, nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i = 0; i < n; i++) re[i] = sig[i];
  fftRaw(re, im, nFFT);

  const df    = fs / nFFT;
  const trans = Math.max(df * 4, (fHigh - fLow) * 0.04); // 4% de transition

  for (let k = 0; k <= nFFT / 2; k++) {
    const fk = k * df;
    let w = 0;
    if      (fk >= fLow + trans && fk <= fHigh - trans) w = 1;
    else if (fk >  fLow - trans && fk <  fLow  + trans) w = 0.5*(1 - Math.cos(Math.PI*(fk-(fLow -trans))/(2*trans)));
    else if (fk >  fHigh- trans && fk <  fHigh + trans) w = 0.5*(1 + Math.cos(Math.PI*(fk-(fHigh-trans))/(2*trans)));
    re[k] *= w; im[k] *= w;
    if (k > 0 && k < nFFT / 2) { re[nFFT-k] *= w; im[nFFT-k] *= w; }
  }
  re[nFFT/2] = im[nFFT/2] = 0;

  for (let i = 0; i < nFFT; i++) im[i] = -im[i]; // conjuguée → IFFT
  fftRaw(re, im, nFFT);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] / nFFT;
  return out;
}

/**
 * Filtre passe-haut domaine fréquentiel.
 */
function demodHighpass(sig, fs, fCut) {
  const n = sig.length, nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i = 0; i < n; i++) re[i] = sig[i];
  fftRaw(re, im, nFFT);

  const df = fs / nFFT, trans = Math.max(df * 4, fCut * 0.3);
  for (let k = 0; k <= nFFT / 2; k++) {
    const fk = k * df;
    const w  = fk <= fCut - trans ? 0
             : fk >= fCut + trans ? 1
             : 0.5*(1 + Math.sin(Math.PI*(fk - fCut) / (2*trans)));
    re[k] *= w; im[k] *= w;
    if (k > 0 && k < nFFT / 2) { re[nFFT-k] *= w; im[nFFT-k] *= w; }
  }
  re[nFFT/2] = im[nFFT/2] = 0;

  for (let i = 0; i < nFFT; i++) im[i] = -im[i];
  fftRaw(re, im, nFFT);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] / nFFT;
  return out;
}

/**
 * Enveloppe via transformée de Hilbert (signal analytique).
 * FFT → fréquences positives ×2 / fréquences négatives = 0 → IFFT → module.
 */
function demodHilbertEnvelope(sig) {
  const n = sig.length, nFFT = nextPow2(n);
  const re = new Float64Array(nFFT), im = new Float64Array(nFFT);
  for (let i = 0; i < n; i++) re[i] = sig[i];
  fftRaw(re, im, nFFT);

  // Spectre unilatéral × 2
  for (let k = 1; k < nFFT / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = nFFT/2 + 1; k < nFFT; k++) { re[k] = 0; im[k] = 0; }

  for (let i = 0; i < nFFT; i++) im[i] = -im[i]; // conjuguée → IFFT
  fftRaw(re, im, nFFT);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++)
    env[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]) / nFFT;
  return env;
}

/**
 * Kurtosis (moment d'ordre 4 normalisé).
 * = 3 pour gaussien ; élevé pour signaux impulsionnels (défauts roulements).
 */
function demodKurtosis(sig) {
  const n = sig.length;
  if (n < 8) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sig[i];
  mean /= n;
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = sig[i] - mean, d2 = d*d;
    m2 += d2; m4 += d2*d2;
  }
  m2 /= n; m4 /= n;
  return m2 > 1e-30 ? m4 / (m2*m2) : 0;
}

/**
 * Kurtogram robuste : teste à la fois des bandes LARGES (comme la version Python
 * qui peut trouver 600–14 000 Hz) et des bandes ÉTROITES (résonances spécifiques).
 *
 * La version Python trouvait 600–14 000 Hz parce qu'elle testait des bandes très
 * larges couvrant presque toute la bande utile, pas seulement des bandes étroites.
 *
 * @param {Float64Array} sig  signal (peut être sous-échantillonné pour accélération)
 * @param {number}       fs   fréquence d'échantillonnage
 * @returns {{ fLow, fHigh, center, kurt }} ou null
 */
function demodKurtogramSweep(sig, fs) {
  const fNyq = fs / 2;
  const candidates = []; // [fLow, fHigh]

  // ── A) Bandes LARGES — priorité haute (comme Python) ─────────────────────
  // Combinaison de fréquences basses coupures × fréquences hautes coupures
  // Couvre des cas comme [600, 14000] Hz
  const lowCuts  = [50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000];
  const highCuts = [
    fNyq * 0.95, fNyq * 0.9, fNyq * 0.85, fNyq * 0.8,
    fNyq * 0.7,  fNyq * 0.6, fNyq * 0.5,  fNyq * 0.4,
  ];
  for (const fl of lowCuts) {
    for (const fh of highCuts) {
      if (fl >= fh - 200 || fl >= fNyq * 0.35) continue;
      candidates.push([fl, Math.min(fh, fNyq * 0.97)]);
    }
  }

  // ── B) Bandes ÉTROITES — résonances mécaniques / structurales ────────────
  // Sweep par pas ~1.3 (plus fin que √2) de 100 Hz à 0.9×Nyquist
  const bwList = [200, 500, 1000, 2000, 4000, 8000];
  const step   = 1.30;
  for (let fc = 100; fc < fNyq * 0.88; fc *= step) {
    for (const bw of bwList) {
      const fL = Math.max(20, fc - bw / 2);
      const fH = Math.min(fNyq * 0.97, fc + bw / 2);
      if (fH - fL > 80) candidates.push([fL, fH]);
    }
  }

  let best = null, bestKurt = 0;

  for (const [fL, fH] of candidates) {
    if (fH <= fL + 50 || fH > fNyq * 0.98 || fL < 0) continue;
    try {
      const filt = demodBandpass(sig, fs, fL, fH);
      const env  = demodHilbertEnvelope(filt);
      const kurt = demodKurtosis(env);
      if (kurt > bestKurt) {
        bestKurt = kurt;
        best = { fLow: fL, fHigh: fH, center: (fL + fH) / 2, kurt };
      }
    } catch(e) { /* bande invalide — ignorer */ }
  }

  return best; // null si aucun résultat utile
}

/** RMS d'un signal. */
function demodRMS(sig) {
  let s = 0;
  for (let i = 0; i < sig.length; i++) s += sig[i]*sig[i];
  return Math.sqrt(s / sig.length);
}

/** Facteur de crête (peak / RMS). */
function demodCrest(sig) {
  const rms = demodRMS(sig);
  if (!rms) return 0;
  let pk = 0;
  for (let i = 0; i < sig.length; i++) { const a = Math.abs(sig[i]); if (a > pk) pk = a; }
  return pk / rms;
}


// ════════════════════════════════════════════════════════════
// 2.  PIPELINE PRINCIPAL
// ════════════════════════════════════════════════════════════

/**
 * Pipeline complet :
 *   1. Si manFlo/manFhi fournis → bypass kurtogram, bande imposée par l'utilisateur
 *   2. Sinon → kurtogram automatique (kurtosis sur signal filtré, comme Python)
 *   3. Bandpass → Hilbert env → Highpass 5 Hz → FFT Hanning → spectre RPM
 *
 * @param {Float64Array} sig     signal en g
 * @param {number}       fs      fréquence d'échantillonnage (Hz)
 * @param {number|null}  manFlo  bande manuelle bas (Hz), null = mode auto
 * @param {number|null}  manFhi  bande manuelle haut (Hz), null = mode auto
 */
function demodCompute(sig, fs, manFlo = null, manFhi = null) {
  let fLow, fHigh, band;

  if (manFlo !== null && manFhi !== null) {
    // ── Mode Manuel : bande imposée, pas de kurtogram ──────
    fLow  = manFlo;
    fHigh = manFhi;
    band  = null;
  } else {
    // ── Mode Auto : kurtogram sur signal filtré ─────────────
    const sweepLen = Math.min(sig.length, 16384);
    const sweepSig = sweepLen < sig.length ? sig.subarray(0, sweepLen) : sig;
    band  = demodKurtogramSweep(sweepSig, fs);
    fLow  = band ? band.fLow  : 500;
    fHigh = band ? band.fHigh : fs * 0.45;
  }

  // ── Pipeline sur signal complet ──────────────────────────
  const filt = demodBandpass(sig, fs, fLow, fHigh);
  let   env  = demodHilbertEnvelope(filt);
  env        = demodHighpass(env, fs, 5.0); // retire DC + dérive lente

  const rmsEnv   = demodRMS(env);
  const crestEnv = demodCrest(env);

  // ── FFT enveloppe avec fenêtre Hanning + normalisation cohérente ──
  const n    = env.length;
  const nFFT = nextPow2(n);
  const re   = new Float64Array(nFFT), im = new Float64Array(nFFT);
  let cohGain = 0;
  for (let i = 0; i < n; i++) {
    const w  = 0.5*(1 - Math.cos(2*Math.PI*i/(n-1)));
    re[i]    = env[i] * w;
    cohGain += w;
  }
  cohGain /= n;
  fftRaw(re, im, nFFT);

  // ── Axe RPM ──────────────────────────────────────────────
  const fmaxRpm   = Math.min(DEMOD_FMAX_RPM, (fs/2) * DEMOD_HZ_PER_RPM);
  const rpmPerBin = (fs / nFFT) * DEMOD_HZ_PER_RPM;
  const nBins     = Math.min(nFFT/2, Math.floor(fmaxRpm / rpmPerBin) + 1);
  const freqsRpm  = new Float64Array(nBins);
  const amps      = new Float64Array(nBins);

  for (let k = 0; k < nBins; k++) {
    freqsRpm[k] = k * rpmPerBin;
    const a   = Math.sqrt(re[k]*re[k] + im[k]*im[k]) * 2.0 / n;
    amps[k]   = cohGain > 0 ? a / cohGain : a;
  }

  return { freqsRpm, amps, fLow, fHigh, rmsEnv, crestEnv, band, fs };
}
