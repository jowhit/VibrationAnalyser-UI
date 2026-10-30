// sync.js — TSA : moyenne tours 0–360° + FFT ordres (JS only)

const SyncModule = (() => {
  const COL = '#0033cc';
  const GRID = 256;
  const TACH_STALE_MS = 1500;
  const MAX_ORDER = 32;

  let _initialized = false;
  let _view = 'trace'; // 'trace' | 'fft'
  let _gRange = 2;
  let _fs = 4000;
  let _nCfg = 45000;

  let _traceCanvas, _traceCtx;
  let _fftCanvas, _fftCtx;
  let _avg = null;      // Float32Array GRID (g)
  let _orderMag = null; // Float32Array MAX_ORDER+1
  let _nRevs = 0;
  let _meanRpm = 0;
  let _rpm = 0;
  let _lastTachMs = 0;

  let _rawSamples = null;
  let _rawMeta = null;
  let _tachUs = [];

  function init() {
    if (_initialized) return;
    _initialized = true;
    _traceCanvas = document.getElementById('sync-trace-canvas');
    _traceCtx = _traceCanvas ? _traceCanvas.getContext('2d') : null;
    _fftCanvas = document.getElementById('sync-fft-canvas');
    _fftCtx = _fftCanvas ? _fftCanvas.getContext('2d') : null;

    const btn = document.getElementById('btn-sync-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        if (typeof SyncSession !== 'undefined' && SyncSession.toggleStart) {
          SyncSession.toggleStart();
        }
      });
    }
    const fftBtn = document.getElementById('btn-sync-fft');
    if (fftBtn) {
      fftBtn.addEventListener('click', function () {
        if (typeof SyncSession !== 'undefined' && SyncSession.toggleFft) {
          SyncSession.toggleFft();
        }
      });
    }
    window.addEventListener('resize', resize);
    _applyLayout();
    resize();
  }

  function setConfig(g, fs, n) {
    const gs = String(g == null ? '' : g).trim().toLowerCase();
    const autoG = (gs === 'auto' || gs === '' || gs === ' ');
    const gg = parseInt(g, 10);
    const ff = parseInt(fs, 10);
    const nn = parseInt(n, 10);
    if (!autoG && (gg === 2 || gg === 4 || gg === 8 || gg === 16)) _gRange = gg;
    if (ff > 0) _fs = ff;
    if (nn > 0) _nCfg = nn;
    const el = document.getElementById('sync-cfg-line');
    if (el) {
      const T = _nCfg / _fs;
      const gLbl = autoG ? 'AUTO' : ('±' + _gRange + 'g');
      el.textContent = 'FS=' + _fs + ' Hz  T=' + T.toFixed(3) + ' s  ' + gLbl;
    }
  }

  function _applyLayout() {
    const tw = document.getElementById('sync-trace-wrap');
    const fw = document.getElementById('sync-fft-wrap');
    if (tw) tw.style.display = _view === 'trace' ? 'flex' : 'none';
    if (fw) fw.style.display = _view === 'fft' ? 'flex' : 'none';
  }

  function showTrace() {
    _view = 'trace';
    _applyLayout();
    resize();
  }

  function showOrderFft() {
    _view = 'fft';
    if (!_orderMag && _avg) _computeOrderFft();
    _applyLayout();
    resize();
  }

  function setStatus(text) {
    const el = document.getElementById('sync-status');
    if (el) el.textContent = text || '—';
  }

  function updateRpmBar(rpm) {
    _rpm = rpm || 0;
    _lastTachMs = Date.now();
    const el = document.getElementById('sync-rpm-val');
    const dot = document.getElementById('sync-rpm-dot');
    if (el) el.textContent = String(Math.round(_rpm));
    if (dot) {
      dot.className = 'bal-rpm-dot ' + (_rpm > 0 ? 'bal-rpm-dot--ok' : 'bal-rpm-dot--lost');
    }
  }

  function onTachPeriod(periodUs) {
    if (!(periodUs > 0)) return;
    const rpm = 60000000 / periodUs;
    if (rpm > 30 && rpm < 120000) updateRpmBar(rpm);
  }

  function beginBinary(meta) {
    _rawMeta = Object.assign({}, meta || {});
    _rawSamples = null;
    _tachUs = [];
    if (_rawMeta.g) _gRange = _rawMeta.g;
    if (_rawMeta.fs) _fs = _rawMeta.fs;
  }

  function onSamples(int16arr) {
    _rawSamples = int16arr;
  }

  function onTachUs(list) {
    _tachUs = list || [];
  }

  function finalizeFromRaw() {
    if (!_rawSamples || !_rawSamples.length) {
      setStatus('Buffer vide');
      return false;
    }
    const fs = (_rawMeta && _rawMeta.fs) || _fs;
    const g = (_rawMeta && _rawMeta.g) || _gRange;
    const t0 = (_rawMeta && _rawMeta.t0) || 0;
    const r = _computeTsa(_rawSamples, fs, g, t0, _tachUs);
    _avg = r.avg;
    _nRevs = r.nRevs;
    _meanRpm = r.meanRpm;
    _orderMag = null;
    if (_meanRpm > 0) updateRpmBar(_meanRpm);

    const info = document.getElementById('sync-mod-info');
    if (info) {
      info.textContent = 'Tours=' + _nRevs +
        '  RPM moy=' + Math.round(_meanRpm) +
        '  N=' + _rawSamples.length +
        '  FS=' + Math.round(fs);
    }
    showTrace();
    setStatus(_nRevs
      ? ('TSA — ' + _nRevs + ' tours moyennés')
      : 'Pas assez de tours tach');
    return _nRevs > 0;
  }

  /**
   * Rééchantillonne chaque tour sur GRID points (0–360°) puis moyenne.
   */
  function _computeTsa(samples, fs, gRange, t0u32, tachAbs) {
    const N = samples.length;
    const periodUs = 1000000 / fs;
    const scale = gRange / 16384; // cohérent Harmonic / Bode (lsbPerG = 16384/g)
    const out = { avg: null, nRevs: 0, meanRpm: 0 };
    if (!tachAbs || tachAbs.length < 2) return out;

    const pairs = [];
    for (let i = 0; i < tachAbs.length; i++) {
      const tu = tachAbs[i] >>> 0;
      const rel = (tu - (t0u32 >>> 0)) >>> 0;
      const si = Math.floor(rel / periodUs);
      if (si >= 0 && si < N) pairs.push({ si: si, us: tu });
    }
    pairs.sort(function (a, b) { return a.si - b.si; });

    const sum = new Float64Array(GRID);
    let nOk = 0;
    let rpmSum = 0;

    for (let k = 0; k < pairs.length - 1; k++) {
      const i0 = pairs[k].si;
      const i1 = pairs[k + 1].si;
      const nWin = i1 - i0;
      if (nWin < 8) continue;
      const dtUs = (pairs[k + 1].us - pairs[k].us) >>> 0;
      if (dtUs < 500) continue;
      const rpm = 60000000 / dtUs;
      if (!(rpm > 60 && rpm < 100000)) continue;

      // Interpoler linéairement sur grille angulaire
      for (let g = 0; g < GRID; g++) {
        const pos = (g / GRID) * nWin;
        const iA = Math.floor(pos);
        const iB = Math.min(nWin - 1, iA + 1);
        const f = pos - iA;
        const vA = samples[i0 + iA] * scale;
        const vB = samples[i0 + iB] * scale;
        sum[g] += vA + (vB - vA) * f;
      }
      nOk++;
      rpmSum += rpm;
    }

    if (!nOk) return out;
    const avg = new Float32Array(GRID);
    for (let g = 0; g < GRID; g++) avg[g] = sum[g] / nOk;
    // Retirer DC
    let mean = 0;
    for (let g = 0; g < GRID; g++) mean += avg[g];
    mean /= GRID;
    for (let g = 0; g < GRID; g++) avg[g] -= mean;

    out.avg = avg;
    out.nRevs = nOk;
    out.meanRpm = rpmSum / nOk;
    return out;
  }

  function _computeOrderFft() {
    if (!_avg) return;
    const n = _avg.length;
    _orderMag = new Float32Array(MAX_ORDER + 1);
    for (let k = 1; k <= MAX_ORDER && k < n / 2; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const ang = 2 * Math.PI * k * i / n;
        re += _avg[i] * Math.cos(ang);
        im -= _avg[i] * Math.sin(ang);
      }
      re /= n;
      im /= n;
      _orderMag[k] = 2 * Math.sqrt(re * re + im * im);
    }
  }

  /**
   * Polaire TSA : angle = position tach (0° en haut, sens horaire comme Balance/Phase),
   * rayon = amplitude g autour d'un cercle de base (signal bipolaire).
   */
  function _drawTrace() {
    if (!_traceCtx || !_traceCanvas) return;
    const c = _traceCtx;
    const W = _traceCanvas.width, H = _traceCanvas.height;
    if (W < 10 || H < 10) return;

    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.38;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);

    c.fillStyle = '#444';
    c.font = '11px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText('TSA — tour moyen (polaire °)', 8, 14);

    let aMax = 0.1;
    if (_avg) {
      for (let i = 0; i < _avg.length; i++) {
        const a = Math.abs(_avg[i]);
        if (a > aMax) aMax = a;
      }
      aMax *= 1.15;
    }

    // Cercles de référence (échelle ±aMax autour du rayon milieu)
    [0.25, 0.5, 0.75, 1.0].forEach(function (f) {
      c.strokeStyle = f === 1.0 ? '#999' : '#ddd';
      c.setLineDash(f === 1.0 ? [] : [4, 5]);
      c.lineWidth = f === 1.0 ? 1.2 : 0.8;
      c.beginPath();
      c.arc(cx, cy, R * f, 0, 2 * Math.PI);
      c.stroke();
      c.setLineDash([]);
    });
    c.fillStyle = '#aaa';
    c.font = '8px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText('±' + aMax.toFixed(3) + 'g', cx + R + 2, cy - 2);

    // Axes + labels degrés (0° haut, 90° droite)
    c.strokeStyle = '#ccc';
    c.lineWidth = 0.8;
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) {
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + d[0] * R * 1.06, cy + d[1] * R * 1.06);
      c.stroke();
    });
    c.fillStyle = '#666';
    c.font = '10px "Courier New", monospace';
    c.textAlign = 'center';
    c.fillText('0°', cx, cy - R - 10);
    c.fillText('180°', cx, cy + R + 13);
    c.textAlign = 'left';
    c.fillText('90°', cx + R + 5, cy + 4);
    c.textAlign = 'right';
    c.fillText('270°', cx - R - 5, cy + 4);

    c.beginPath();
    c.arc(cx, cy, 3, 0, 2 * Math.PI);
    c.fillStyle = '#bbb';
    c.fill();

    if (!_avg) {
      c.fillStyle = '#aaa';
      c.font = '13px "Courier New", monospace';
      c.textAlign = 'center';
      c.fillText('—', cx, cy + 4);
      return;
    }

    // Cercle de base (0 g) à R/2 ; signal ±aMax → [0 .. R]
    const r0 = R * 0.5;
    const rSpan = R * 0.5;

    // Marqueur tach (0°)
    c.strokeStyle = '#e07000';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cx, cy - R * 0.92);
    c.lineTo(cx, cy - R * 1.08);
    c.stroke();
    c.fillStyle = '#e07000';
    c.font = '9px "Courier New", monospace';
    c.textAlign = 'center';
    c.fillText('tach', cx, cy - R - 22);

    c.strokeStyle = COL;
    c.lineWidth = 1.8;
    c.beginPath();
    const n = _avg.length;
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const deg = (idx / n) * 360;
      // Convention Balance/Phase : 0° en haut, sens horaire
      const angRad = (deg - 90) * Math.PI / 180;
      const rr = r0 + (_avg[idx] / aMax) * rSpan;
      const px = cx + rr * Math.cos(angRad);
      const py = cy + rr * Math.sin(angRad);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();

    // Point 0° sur la courbe
    const rStart = r0 + (_avg[0] / aMax) * rSpan;
    c.beginPath();
    c.arc(cx, cy - rStart, 4, 0, 2 * Math.PI);
    c.fillStyle = '#e07000';
    c.fill();
  }

  function _drawFft() {
    if (!_fftCtx || !_fftCanvas) return;
    const c = _fftCtx;
    const W = _fftCanvas.width, H = _fftCanvas.height;
    if (W < 10 || H < 10) return;
    const padL = 48, padR = 10, padT = 18, padB = 28;
    const gW = W - padL - padR, gH = H - padT - padB;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fafafa';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#ddd';
    c.strokeRect(padL, padT, gW, gH);
    c.fillStyle = '#444';
    c.font = '11px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText('Spectre d\'ordres (g)', padL, 12);

    if (!_orderMag) {
      c.fillStyle = '#aaa';
      c.textAlign = 'center';
      c.fillText('—', padL + gW / 2, padT + gH / 2);
      return;
    }

    let aMax = 0;
    for (let k = 1; k <= MAX_ORDER; k++) {
      if (_orderMag[k] > aMax) aMax = _orderMag[k];
    }
    if (!(aMax > 0)) aMax = 0.1;
    aMax *= 1.15;

    const barW = gW / MAX_ORDER;
    for (let k = 1; k <= MAX_ORDER; k++) {
      const h = (_orderMag[k] / aMax) * gH;
      const x = padL + (k - 0.5) * barW - barW * 0.35;
      const y = padT + gH - h;
      c.fillStyle = COL;
      c.fillRect(x, y, barW * 0.7, h);
      if (k === 1 || k % 4 === 0 || k === MAX_ORDER) {
        c.fillStyle = '#888';
        c.font = '9px "Courier New", monospace';
        c.textAlign = 'center';
        c.fillText(String(k) + 'X', padL + (k - 0.5) * barW, H - 8);
      }
    }
    c.fillStyle = '#666';
    c.font = '10px "Courier New", monospace';
    c.textAlign = 'right';
    c.fillText(aMax.toFixed(3), padL - 4, padT + 4);
    c.fillText('0', padL - 4, padT + gH + 3);
  }

  function resize() {
    if (_view === 'trace' && _traceCanvas) {
      const wrap = document.getElementById('sync-trace-wrap');
      if (wrap && wrap.clientWidth > 0) {
        // Carré centré (polaire), comme Harmonic
        const sz = Math.max(160, Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth));
        _traceCanvas.width = sz;
        _traceCanvas.height = sz;
      }
      _drawTrace();
    } else if (_fftCanvas) {
      const wrap = document.getElementById('sync-fft-wrap');
      if (wrap && wrap.clientWidth > 0) {
        _fftCanvas.width = wrap.clientWidth;
        _fftCanvas.height = Math.max(160, wrap.clientHeight || 220);
      }
      if (!_orderMag && _avg) _computeOrderFft();
      _drawFft();
    }
  }

  function clearResult() {
    _avg = null;
    _orderMag = null;
    _nRevs = 0;
    _meanRpm = 0;
    _rawSamples = null;
    _tachUs = [];
    _rawMeta = null;
    const info = document.getElementById('sync-mod-info');
    if (info) info.textContent = '—';
  }

  setInterval(function () {
    if (_lastTachMs && Date.now() - _lastTachMs > TACH_STALE_MS) {
      if (_rpm !== 0 && !(typeof SyncSession !== 'undefined' &&
          SyncSession.getState && SyncSession.getState() === 'VIEW')) {
        updateRpmBar(0);
      }
    }
  }, 250);

  return {
    init: init,
    setConfig: setConfig,
    showTrace: showTrace,
    showOrderFft: showOrderFft,
    setStatus: setStatus,
    onTachPeriod: onTachPeriod,
    updateRpmBar: updateRpmBar,
    beginBinary: beginBinary,
    onSamples: onSamples,
    onTachUs: onTachUs,
    finalizeFromRaw: finalizeFromRaw,
    clearResult: clearResult,
    resize: resize,
  };
})();

window.SyncModule = SyncModule;
