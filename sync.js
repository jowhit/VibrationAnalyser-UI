// sync.js — TSA : moyenne tours 0–360° + FFT ordres (JS only)

const SyncModule = (() => {
  const COL = '#0033cc';
  const GRID = 256;
  const TACH_STALE_MS = 1500;
  const MAX_ORDER = 32;

  let _initialized = false;
  let _view = 'trace'; // 'trace' | 'fft_order'
  let _shape = 'polar'; // 'polar' | 'linear' (vue tour moyen)
  let _gRange = 2;
  let _fs = 4000;
  let _nCfg = 45000;

  let _traceCanvas, _traceCtx;
  let _fftCanvas, _fftCtx;
  let _avg = null;      // Float32Array GRID (g) — TSA
  let _avgBrut = null;  // moyenne angulaire tours AC
  let _avgRes = null;   // moyenne angulaire résidus
  let _orderMag = null; // Float32Array MAX_ORDER+1
  let _nRevs = 0;
  let _meanRpm = 0;
  let _rpm = 0;
  let _lastTachMs = 0;
  /** 'brut' | 'tsa' | 'res' — source affichée / FFT / handoff */
  let _source = 'tsa';
  let _stats = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };

  let _rawSamples = null;
  let _rawMeta = null;
  let _tachUs = [];
  /** Int16 résiduel temporel concaténé (tours valides) + indices tach sample */
  let _residualRaw = null;
  let _residualTachIdx = null;

  // Vue linéaire : zoom + curseur (degrés)
  let _linZMin = 0;
  let _linZMax = 360;
  let _linCursorDeg = null;
  let _linPad = { l: 48, r: 12, t: 18, b: 28 };
  let _linPtr = null; // { x0, z0, z1 } pan

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
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (shapeBtn) {
      shapeBtn.addEventListener('click', function () {
        toggleShape();
      });
    }
    ['brut', 'tsa', 'res'].forEach(function (src) {
      const b = document.getElementById('btn-sync-src-' + src);
      if (b) {
        b.addEventListener('click', function () { setSource(src); });
      }
    });
    _bindLinearInteractions();
    window.addEventListener('resize', resize);
    _applyLayout();
    resize();
  }

  function _activeAvg() {
    if (_source === 'brut') return _avgBrut || _avg;
    if (_source === 'res') return _avgRes || _avg;
    return _avg;
  }

  function _sourceLabel() {
    if (_source === 'brut') return 'Brut';
    if (_source === 'res') return 'Résiduel';
    return 'TSA';
  }

  function setSource(src) {
    if (src !== 'brut' && src !== 'tsa' && src !== 'res') return;
    _source = src;
    _orderMag = null;
    _updateSourceBtns();
    _updateInfoLine();
    if (_view === 'fft_order') _computeOrderFft();
    resize();
    _updateCursorLine();
  }

  function getSource() { return _source; }

  function _updateSourceBtns() {
    const row = document.getElementById('sync-src-row');
    const has = !!_avg;
    if (row) row.style.display = has ? 'flex' : 'none';
    ['brut', 'tsa', 'res'].forEach(function (src) {
      const b = document.getElementById('btn-sync-src-' + src);
      if (b) b.classList.toggle('active', _source === src);
    });
  }

  function _updateShapeBtn() {
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (!shapeBtn) return;
    const show = _view === 'trace' && !!_activeAvg();
    shapeBtn.style.display = show ? 'inline-block' : 'none';
    // Label = action (passer à l'autre vue)
    shapeBtn.textContent = _shape === 'polar' ? 'Linéaire' : 'Polaire';
  }

  function toggleShape() {
    if (_view !== 'trace' || !_activeAvg()) return;
    _shape = (_shape === 'polar') ? 'linear' : 'polar';
    if (_shape === 'linear') {
      _linZMin = 0;
      _linZMax = 360;
      _linCursorDeg = null;
    }
    _applyLayout();
    _updateShapeBtn();
    resize();
    _updateCursorLine();
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

  function getAcqTiming() {
    return { fs: _fs, n: _nCfg, g: _gRange };
  }

  function _applyLayout() {
    const tw = document.getElementById('sync-trace-wrap');
    const fw = document.getElementById('sync-fft-wrap');
    if (tw) {
      tw.style.display = _view === 'trace' ? 'flex' : 'none';
      tw.classList.toggle('sync-trace-wrap--linear', _view === 'trace' && _shape === 'linear');
    }
    if (fw) fw.style.display = _view === 'fft_order' ? 'flex' : 'none';
    _updateShapeBtn();
  }

  function showTrace() {
    _view = 'trace';
    _applyLayout();
    resize();
    _updateCursorLine();
  }

  function showOrderFft() {
    _view = 'fft_order';
    if (!_orderMag && _activeAvg()) _computeOrderFft();
    _applyLayout();
    resize();
  }

  function getView() { return _view; }
  function getShape() { return _shape; }

  /**
   * Payload pour AnalSession.importBuffer — buffer Sync brut + indices tach.
   * Ne consomme pas / ne vide pas les données Sync.
   */
  function exportRaw() {
    if (!_rawSamples || !_rawSamples.length) return null;
    const fs = (_rawMeta && _rawMeta.fs) || _fs;
    const g = (_rawMeta && _rawMeta.g) || _gRange;
    const t0 = (_rawMeta && _rawMeta.t0) || 0;
    const n = _rawSamples.length;
    if (!(fs > 0) || !(g > 0)) return null;
    const tachIdx = [];
    if (_tachUs && _tachUs.length) {
      const periodUs = 1000000 / fs;
      const t0u = t0 >>> 0;
      for (let i = 0; i < _tachUs.length; i++) {
        const tu = _tachUs[i] >>> 0;
        const rel = (tu - t0u) >>> 0;
        const si = Math.floor(rel / periodUs);
        if (si >= 0 && si < n) tachIdx.push(si);
      }
    }
    return {
      g: g,
      fs: fs,
      n: n,
      t: n / fs,
      samples: _rawSamples,
      tachIdx: tachIdx,
      source: 'sync',
    };
  }

  /**
   * Buffer temporel résiduel (int16) pour handoff Analyse.
   */
  function exportResidual() {
    if (!_residualRaw || !_residualRaw.length) return null;
    const fs = (_rawMeta && _rawMeta.fs) || _fs;
    const g = (_rawMeta && _rawMeta.g) || _gRange;
    if (!(fs > 0) || !(g > 0)) return null;
    const n = _residualRaw.length;
    return {
      g: g,
      fs: fs,
      n: n,
      t: n / fs,
      samples: _residualRaw,
      tachIdx: (_residualTachIdx && _residualTachIdx.length)
        ? _residualTachIdx.slice()
        : [],
      source: 'sync-res',
    };
  }

  /** Export selon source UI (Résiduel → residual, sinon brut). */
  function exportForAnalyse() {
    if (_source === 'res') return exportResidual();
    return exportRaw();
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
    _avgBrut = r.avgBrut;
    _avgRes = r.avgRes;
    _residualRaw = r.residualRaw;
    _residualTachIdx = r.residualTachIdx;
    _stats = r.stats || { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
    _nRevs = r.nRevs;
    _meanRpm = r.meanRpm;
    _orderMag = null;
    _source = 'tsa';
    if (_meanRpm > 0) updateRpmBar(_meanRpm);

    _updateInfoLine();
    _updateSourceBtns();
    showTrace();
    _updateShapeBtn();
    setStatus(_nRevs
      ? ('TSA — ' + _nRevs + ' tours  R%=' + _stats.rPct.toFixed(1))
      : 'Pas assez de tours tach');
    return _nRevs > 0;
  }

  function _updateInfoLine() {
    const info = document.getElementById('sync-mod-info');
    if (!info) return;
    const fs = (_rawMeta && _rawMeta.fs) || _fs;
    if (!_nRevs) {
      info.textContent = '—';
      return;
    }
    info.textContent =
      _sourceLabel() +
      '  Tours=' + _nRevs +
      '  RPM=' + Math.round(_meanRpm) +
      '  RMS_b=' + _stats.rmsBrut.toFixed(4) +
      '  RMS_t=' + _stats.rmsTsa.toFixed(4) +
      '  RMS_r=' + _stats.rmsRes.toFixed(4) +
      '  R%=' + _stats.rPct.toFixed(1) +
      '  FS=' + Math.round(fs);
  }

  function _rmsArr(arr) {
    if (!arr || !arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / arr.length);
  }

  function _removeDc(buf) {
    let m = 0;
    for (let i = 0; i < buf.length; i++) m += buf[i];
    m /= buf.length;
    for (let i = 0; i < buf.length; i++) buf[i] -= m;
    return buf;
  }

  /**
   * Rééchantillonne chaque tour sur GRID, TSA inchangé, + résidus + residualRaw.
   */
  function _computeTsa(samples, fs, gRange, t0u32, tachAbs) {
    const N = samples.length;
    const periodUs = 1000000 / fs;
    const scale = gRange / 16384; // cohérent Harmonic / Bode (lsbPerG = 16384/g)
    const out = {
      avg: null, avgBrut: null, avgRes: null,
      residualRaw: null, residualTachIdx: null,
      nRevs: 0, meanRpm: 0,
      stats: { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 },
    };
    if (!tachAbs || tachAbs.length < 2) return out;

    const pairs = [];
    for (let i = 0; i < tachAbs.length; i++) {
      const tu = tachAbs[i] >>> 0;
      const rel = (tu - (t0u32 >>> 0)) >>> 0;
      const si = Math.floor(rel / periodUs);
      if (si >= 0 && si < N) pairs.push({ si: si, us: tu });
    }
    pairs.sort(function (a, b) { return a.si - b.si; });

    const revs = [];   // Float32Array GRID (avec DC)
    const wins = [];   // { i0, nWin }
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

      const rev = new Float32Array(GRID);
      for (let g = 0; g < GRID; g++) {
        const pos = (g / GRID) * nWin;
        const iA = Math.floor(pos);
        const iB = Math.min(nWin - 1, iA + 1);
        const f = pos - iA;
        const vA = samples[i0 + iA] * scale;
        const vB = samples[i0 + iB] * scale;
        const v = vA + (vB - vA) * f;
        rev[g] = v;
        sum[g] += v;
      }
      revs.push(rev);
      wins.push({ i0: i0, nWin: nWin });
      nOk++;
      rpmSum += rpm;
    }

    if (!nOk) return out;

    // TSA = moyenne puis retrait DC (comportement historique inchangé)
    const avg = new Float32Array(GRID);
    for (let g = 0; g < GRID; g++) avg[g] = sum[g] / nOk;
    _removeDc(avg);

    // Brut = moyenne des tours AC (DC retiré par tour)
    const sumBrut = new Float64Array(GRID);
    const sumRes = new Float64Array(GRID);
    const resRevs = [];
    for (let k = 0; k < nOk; k++) {
      const ac = new Float32Array(GRID);
      let m = 0;
      for (let g = 0; g < GRID; g++) m += revs[k][g];
      m /= GRID;
      for (let g = 0; g < GRID; g++) {
        ac[g] = revs[k][g] - m;
        sumBrut[g] += ac[g];
        const r = ac[g] - avg[g];
        sumRes[g] += r;
        ac[g] = r; // réutilise pour stocker résidu tour
      }
      resRevs.push(ac);
    }
    const avgBrut = new Float32Array(GRID);
    const avgRes = new Float32Array(GRID);
    for (let g = 0; g < GRID; g++) {
      avgBrut[g] = sumBrut[g] / nOk;
      avgRes[g] = sumRes[g] / nOk;
    }
    _removeDc(avgBrut);
    _removeDc(avgRes);

    // Buffer temporel : brut / TSA / résiduel concaténés (fenêtres valides)
    let totN = 0;
    for (let k = 0; k < nOk; k++) totN += wins[k].nWin;
    const brutF = new Float32Array(totN);
    const tsaF = new Float32Array(totN);
    const resF = new Float32Array(totN);
    const resI16 = new Int16Array(totN);
    const tachIdx = [];
    let o = 0;
    for (let k = 0; k < nOk; k++) {
      tachIdx.push(o);
      const i0 = wins[k].i0;
      const nWin = wins[k].nWin;
      const resRev = resRevs[k];
      for (let i = 0; i < nWin; i++) {
        const rawG = samples[i0 + i] * scale;
        brutF[o + i] = rawG;
        // TSA remappé angle → sample
        const pos = (i / nWin) * GRID;
        const iA = Math.floor(pos);
        const iB = Math.min(GRID - 1, iA + 1);
        const f = pos - iA;
        const tsaV = avg[iA] + (avg[iB] - avg[iA]) * f;
        tsaF[o + i] = tsaV;
        const resV = resRev[iA] + (resRev[iB] - resRev[iA]) * f;
        resF[o + i] = resV;
        let q = Math.round(resV / scale);
        if (q > 32767) q = 32767;
        if (q < -32768) q = -32768;
        resI16[o + i] = q;
      }
      o += nWin;
    }
    tachIdx.push(totN);

    const rmsBrut = _rmsArr(brutF);
    const rmsTsa = _rmsArr(tsaF);
    const rmsRes = _rmsArr(resF);
    const rPct = rmsBrut > 1e-12 ? (100 * rmsRes / rmsBrut) : 0;

    out.avg = avg;
    out.avgBrut = avgBrut;
    out.avgRes = avgRes;
    out.residualRaw = resI16;
    out.residualTachIdx = tachIdx;
    out.nRevs = nOk;
    out.meanRpm = rpmSum / nOk;
    out.stats = { rmsBrut: rmsBrut, rmsTsa: rmsTsa, rmsRes: rmsRes, rPct: rPct };
    return out;
  }

  function _computeOrderFft() {
    const avg = _activeAvg();
    if (!avg) return;
    const n = avg.length;
    _orderMag = new Float32Array(MAX_ORDER + 1);
    for (let k = 1; k <= MAX_ORDER && k < n / 2; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const ang = 2 * Math.PI * k * i / n;
        re += avg[i] * Math.cos(ang);
        im -= avg[i] * Math.sin(ang);
      }
      re /= n;
      im /= n;
      _orderMag[k] = 2 * Math.sqrt(re * re + im * im);
    }
  }

  function _ampMax() {
    let aMax = 0.1;
    const avg = _activeAvg();
    if (avg) {
      for (let i = 0; i < avg.length; i++) {
        const a = Math.abs(avg[i]);
        if (a > aMax) aMax = a;
      }
      aMax *= 1.15;
    }
    return aMax;
  }

  function _updateCursorLine() {
    const el = document.getElementById('sync-cursor-line');
    if (!el) return;
    const avg = _activeAvg();
    if (_view !== 'trace' || _shape !== 'linear' || !avg) {
      el.textContent = '—';
      return;
    }
    if (_linCursorDeg == null) {
      el.textContent = 'Toucher / molette — zoom & curseur (°)';
      return;
    }
    const n = avg.length;
    const idx = Math.max(0, Math.min(n - 1, Math.round((_linCursorDeg / 360) * n) % n));
    const g = avg[idx];
    el.textContent = 'Curseur  ' + _linCursorDeg.toFixed(1) + '°  |  ' +
      g.toFixed(4) + ' g  |  ' + _sourceLabel() + '  |  zoom ' +
      _linZMin.toFixed(0) + '–' + _linZMax.toFixed(0) + '°';
  }

  function _bindLinearInteractions() {
    if (!_traceCanvas) return;
    const cnv = _traceCanvas;

    function degFromClientX(clientX) {
      const rect = cnv.getBoundingClientRect();
      if (rect.width < 8) return null;
      const x = (clientX - rect.left) * (cnv.width / rect.width);
      const gW = cnv.width - _linPad.l - _linPad.r;
      let t = (x - _linPad.l) / gW;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      return _linZMin + t * (_linZMax - _linZMin);
    }

    cnv.addEventListener('pointerdown', function (e) {
      if (_view !== 'trace' || _shape !== 'linear' || !_activeAvg()) return;
      e.preventDefault();
      try { cnv.setPointerCapture(e.pointerId); } catch (err) {}
      _linPtr = { x0: e.clientX, z0: _linZMin, z1: _linZMax };
      _linCursorDeg = degFromClientX(e.clientX);
      _drawTrace();
      _updateCursorLine();
    });
    cnv.addEventListener('pointermove', function (e) {
      if (_view !== 'trace' || _shape !== 'linear' || !_activeAvg()) return;
      if (_linPtr && (e.buttons || e.pointerType === 'touch')) {
        e.preventDefault();
        const rect = cnv.getBoundingClientRect();
        const gW = Math.max(1, rect.width - (_linPad.l + _linPad.r) * (rect.width / cnv.width));
        const span0 = _linPtr.z1 - _linPtr.z0;
        const dDeg = -((e.clientX - _linPtr.x0) / gW) * span0;
        let z0 = _linPtr.z0 + dDeg;
        let z1 = _linPtr.z1 + dDeg;
        if (z0 < 0) { z1 -= z0; z0 = 0; }
        if (z1 > 360) { z0 -= (z1 - 360); z1 = 360; }
        if (z0 < 0) z0 = 0;
        _linZMin = z0;
        _linZMax = z1;
        _linCursorDeg = degFromClientX(e.clientX);
        _drawTrace();
        _updateCursorLine();
      }
    });
    cnv.addEventListener('pointerup', function () { _linPtr = null; });
    cnv.addEventListener('pointercancel', function () { _linPtr = null; });

    cnv.addEventListener('wheel', function (e) {
      if (_view !== 'trace' || _shape !== 'linear' || !_activeAvg()) return;
      e.preventDefault();
      const deg = degFromClientX(e.clientX);
      if (deg == null) return;
      const span = _linZMax - _linZMin;
      const factor = e.deltaY > 0 ? 1.15 : (1 / 1.15);
      let newSpan = span * factor;
      if (newSpan < 8) newSpan = 8;
      if (newSpan > 360) newSpan = 360;
      const t = (deg - _linZMin) / (span || 1);
      let z0 = deg - t * newSpan;
      let z1 = z0 + newSpan;
      if (z0 < 0) { z1 -= z0; z0 = 0; }
      if (z1 > 360) { z0 -= (z1 - 360); z1 = 360; }
      if (z0 < 0) z0 = 0;
      _linZMin = z0;
      _linZMax = z1;
      _linCursorDeg = deg;
      _drawTrace();
      _updateCursorLine();
    }, { passive: false });

    cnv.addEventListener('dblclick', function () {
      if (_view !== 'trace' || _shape !== 'linear') return;
      _linZMin = 0;
      _linZMax = 360;
      _drawTrace();
      _updateCursorLine();
    });
  }

  function _drawLinear() {
    if (!_traceCtx || !_traceCanvas) return;
    const c = _traceCtx;
    const W = _traceCanvas.width, H = _traceCanvas.height;
    if (W < 10 || H < 10) return;
    const P = _linPad;
    const gW = W - P.l - P.r, gH = H - P.t - P.b;
    const z0 = _linZMin, z1 = _linZMax;
    const span = Math.max(1e-6, z1 - z0);
    const aMax = _ampMax();

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#555';
    c.strokeRect(P.l, P.t, gW, gH);
    c.fillStyle = '#444';
    c.font = '11px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText(_sourceLabel() + ' — tour moyen (linéaire °)', P.l, 12);

    function xOf(deg) { return P.l + ((deg - z0) / span) * gW; }
    function yOf(g) { return P.t + gH / 2 - (g / aMax) * (gH / 2); }

    // Grille Y
    for (let i = 0; i <= 4; i++) {
      const gv = -aMax + (2 * aMax * i / 4);
      const y = yOf(gv);
      if (i !== 2) {
        c.strokeStyle = '#eee';
        c.beginPath(); c.moveTo(P.l, y); c.lineTo(P.l + gW, y); c.stroke();
      }
      c.fillStyle = '#666';
      c.font = '9px Arial';
      c.textAlign = 'right';
      c.fillText(gv.toFixed(3), P.l - 4, y + 3);
    }
    c.strokeStyle = '#bbb';
    c.beginPath(); c.moveTo(P.l, yOf(0)); c.lineTo(P.l + gW, yOf(0)); c.stroke();

    c.save();
    c.translate(12, P.t + gH / 2);
    c.rotate(-Math.PI / 2);
    c.textAlign = 'center';
    c.font = '10px Arial';
    c.fillStyle = '#333';
    c.fillText('g', 0, 0);
    c.restore();

    // Ticks X degrés
    const nTick = Math.min(8, Math.max(2, Math.floor(gW / 50)));
    for (let t = 0; t <= nTick; t++) {
      const deg = z0 + span * t / nTick;
      const x = xOf(deg);
      c.strokeStyle = '#eee';
      c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, P.t + gH); c.stroke();
      c.fillStyle = '#333';
      c.font = '9px Arial';
      c.textAlign = 'center';
      c.fillText(deg.toFixed(0) + '°', x, H - 6);
    }
    c.fillStyle = '#555';
    c.font = '10px Arial';
    c.textAlign = 'center';
    c.fillText('Angle (°)', P.l + gW / 2, H);

    const avg = _activeAvg();
    if (!avg) {
      c.fillStyle = '#aaa';
      c.textAlign = 'center';
      c.fillText('—', P.l + gW / 2, P.t + gH / 2);
      return;
    }

    c.save();
    c.beginPath(); c.rect(P.l, P.t, gW, gH); c.clip();
    // Marqueur 0° (tach) si dans la fenêtre
    if (0 >= z0 && 0 <= z1) {
      const xT = xOf(0);
      c.strokeStyle = '#e07000';
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(xT, P.t); c.lineTo(xT, P.t + gH); c.stroke();
    }

    const n = avg.length;
    const i0 = Math.max(0, Math.floor((z0 / 360) * n));
    const i1 = Math.min(n - 1, Math.ceil((z1 / 360) * n));
    c.strokeStyle = COL;
    c.lineWidth = 1.6;
    c.beginPath();
    let first = true;
    for (let i = i0; i <= i1; i++) {
      const deg = (i / n) * 360;
      const x = xOf(deg);
      const y = yOf(avg[i]);
      if (first) { c.moveTo(x, y); first = false; }
      else c.lineTo(x, y);
    }
    c.stroke();

    if (_linCursorDeg != null && _linCursorDeg >= z0 && _linCursorDeg <= z1) {
      const xc = xOf(_linCursorDeg);
      c.strokeStyle = '#cc3300';
      c.lineWidth = 1.2;
      c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(xc, P.t); c.lineTo(xc, P.t + gH); c.stroke();
      c.setLineDash([]);
      const idx = Math.max(0, Math.min(n - 1, Math.round((_linCursorDeg / 360) * n) % n));
      c.fillStyle = '#cc3300';
      c.beginPath();
      c.arc(xc, yOf(avg[idx]), 3.5, 0, 2 * Math.PI);
      c.fill();
    }
    c.restore();
  }

  /**
   * Polaire TSA : angle = position tach (0° en haut, sens horaire comme Balance/Phase),
   * rayon = amplitude g autour d'un cercle de base (signal bipolaire).
   */
  function _drawPolar() {
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
    c.fillText(_sourceLabel() + ' — tour moyen (polaire °)', 8, 14);

    const aMax = _ampMax();
    const avg = _activeAvg();

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

    if (!avg) {
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
    const n = avg.length;
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const deg = (idx / n) * 360;
      // Convention Balance/Phase : 0° en haut, sens horaire
      const angRad = (deg - 90) * Math.PI / 180;
      const rr = r0 + (avg[idx] / aMax) * rSpan;
      const px = cx + rr * Math.cos(angRad);
      const py = cy + rr * Math.sin(angRad);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();

    // Point 0° sur la courbe
    const rStart = r0 + (avg[0] / aMax) * rSpan;
    c.beginPath();
    c.arc(cx, cy - rStart, 4, 0, 2 * Math.PI);
    c.fillStyle = '#e07000';
    c.fill();
  }

  function _drawTrace() {
    if (_shape === 'linear') _drawLinear();
    else _drawPolar();
  }

  function _drawOrderFft() {
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
    c.fillText('Spectre d\'ordres — ' + _sourceLabel() + ' (g)', padL, 12);

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

  function _drawFft() {
    _drawOrderFft();
  }

  function resize() {
    if (_view === 'trace' && _traceCanvas) {
      const wrap = document.getElementById('sync-trace-wrap');
      if (wrap && wrap.clientWidth > 0) {
        if (_shape === 'linear') {
          _traceCanvas.width = wrap.clientWidth;
          _traceCanvas.height = Math.max(160, wrap.clientHeight || 220);
        } else {
          const sz = Math.max(160, Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth));
          _traceCanvas.width = sz;
          _traceCanvas.height = sz;
        }
      }
      _drawTrace();
    } else if (_fftCanvas) {
      const wrap = document.getElementById('sync-fft-wrap');
      if (wrap && wrap.clientWidth > 0) {
        _fftCanvas.width = wrap.clientWidth;
        _fftCanvas.height = Math.max(160, wrap.clientHeight || 220);
      }
      if (_view === 'fft_order' && !_orderMag && _activeAvg()) _computeOrderFft();
      _drawFft();
    }
  }

  function clearResult() {
    _avg = null;
    _avgBrut = null;
    _avgRes = null;
    _orderMag = null;
    _nRevs = 0;
    _meanRpm = 0;
    _rawSamples = null;
    _tachUs = [];
    _rawMeta = null;
    _residualRaw = null;
    _residualTachIdx = null;
    _source = 'tsa';
    _stats = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
    _view = 'trace';
    _linZMin = 0;
    _linZMax = 360;
    _linCursorDeg = null;
    const info = document.getElementById('sync-mod-info');
    if (info) info.textContent = '—';
    _updateShapeBtn();
    _updateSourceBtns();
    _updateCursorLine();
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
    getAcqTiming: getAcqTiming,
    showTrace: showTrace,
    showOrderFft: showOrderFft,
    exportRaw: exportRaw,
    exportResidual: exportResidual,
    exportForAnalyse: exportForAnalyse,
    setSource: setSource,
    getSource: getSource,
    toggleShape: toggleShape,
    getShape: getShape,
    getView: getView,
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
