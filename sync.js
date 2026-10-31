// sync.js — TSA : moyenne tours 0–360° + FFT ordres (JS only)
// Mono A / mono B / duo AB (overlay bleu/orange).

const SyncModule = (() => {
  const COL = '#0033cc';
  const COL_B = '#e67e22';
  const GRID = 256;
  const TACH_STALE_MS = 1500;
  const MAX_ORDER = 32;

  let _initialized = false;
  let _view = 'trace'; // 'trace' | 'fft_order'
  let _shape = 'polar'; // 'polar' | 'linear' (vue tour moyen)
  let _gRange = 2;
  let _fs = 4000;
  let _nCfg = 45000;
  let _dual = false;
  let _showA = true;
  let _showB = true;

  let _traceCanvas, _traceCtx;
  let _fftCanvas, _fftCtx;
  let _avg = null;      // Float32Array GRID (g) — TSA A
  let _avgB = null;     // TSA B (duo)
  let _orderMag = null; // Float32Array MAX_ORDER+1
  let _orderMagB = null;
  let _nRevs = 0;
  let _nRevsB = 0;
  let _meanRpm = 0;
  let _rpm = 0;
  let _lastTachMs = 0;
  let _stats = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
  let _statsB = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };

  let _rawSamples = null;
  let _rawMeta = null;
  let _tachUs = [];
  let _tsaRaw = null;
  let _tsaTachIdx = null;
  let _residualRaw = null;
  let _residualTachIdx = null;

  let _rawSamplesB = null;
  let _rawMetaB = null;
  let _tachUsB = [];
  let _tsaRawB = null;
  let _tsaTachIdxB = null;
  let _residualRawB = null;
  let _residualTachIdxB = null;

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
    const bindAn = function (id, kind) {
      const b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function () {
        if (typeof SyncSession !== 'undefined' && SyncSession.handoffToAnalyse) {
          SyncSession.handoffToAnalyse(kind);
        }
      });
    };
    bindAn('btn-sync-an-brut', 'brut');
    bindAn('btn-sync-an-tsa', 'tsa');
    bindAn('btn-sync-an-res', 'res');
    const visA = document.getElementById('btn-sync-vis-a');
    const visB = document.getElementById('btn-sync-vis-b');
    if (visA) visA.addEventListener('click', function () { toggleVis('A'); });
    if (visB) visB.addEventListener('click', function () { toggleVis('B'); });
    _bindLinearInteractions();
    window.addEventListener('resize', resize);
    _applyLayout();
    resize();
  }

  function setDual(on) {
    _dual = !!on;
    if (!_dual) { _showA = true; _showB = true; }
    _syncVisUi();
  }

  function toggleVis(ch) {
    if (ch === 'A') _showA = !_showA;
    else if (ch === 'B') _showB = !_showB;
    if (!_showA && !_showB) {
      if (ch === 'A') _showB = true;
      else _showA = true;
    }
    _syncVisUi();
    if (_view === 'trace') _drawTrace();
    else _drawFft();
    _updateCursorLine();
  }

  function _syncVisUi() {
    const row = document.getElementById('sync-vis-row');
    if (row) row.style.display = _dual ? 'flex' : 'none';
    const visA = document.getElementById('btn-sync-vis-a');
    const visB = document.getElementById('btn-sync-vis-b');
    if (visA) visA.classList.toggle('active', _showA);
    if (visB) visB.classList.toggle('active', _showB);
  }

  function _hasTrace() {
    return !!((_showA && _avg) || (_dual && _showB && _avgB));
  }

  function _updateAnalyseBtns(on) {
    const row = document.getElementById('sync-analyse-row');
    if (row) row.style.display = on ? 'flex' : 'none';
  }

  function _updateShapeBtn() {
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (!shapeBtn) return;
    const show = _view === 'trace' && _hasTrace();
    shapeBtn.style.display = show ? 'inline-block' : 'none';
    shapeBtn.textContent = _shape === 'polar' ? 'Linéaire' : 'Polaire';
  }

  function toggleShape() {
    if (_view !== 'trace' || !_hasTrace()) return;
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
    if ((_avg && !_orderMag) || (_avgB && !_orderMagB)) _computeOrderFft();
    _applyLayout();
    resize();
  }

  function getView() { return _view; }
  function getShape() { return _shape; }

  function _payloadMeta() {
    const fs = (_rawMeta && _rawMeta.fs) || (_rawMetaB && _rawMetaB.fs) || _fs;
    const g = (_rawMeta && _rawMeta.g) || (_rawMetaB && _rawMetaB.g) || _gRange;
    if (!(fs > 0) || !(g > 0)) return null;
    return { fs: fs, g: g };
  }

  function _makePayload(samples, tachIdx, sourceTag, samplesB, tachIdxB) {
    const meta = _payloadMeta();
    if (!meta || !samples || !samples.length) return null;
    const n = samples.length;
    const out = {
      g: meta.g,
      fs: meta.fs,
      n: n,
      t: n / meta.fs,
      samples: samples,
      tachIdx: tachIdx || [],
      source: sourceTag,
      view: 'fft',
    };
    if (samplesB && samplesB.length) {
      out.samplesB = samplesB;
      out.tachIdxB = tachIdxB || [];
      out.nB = samplesB.length;
      out.tB = samplesB.length / meta.fs;
    }
    return out;
  }

  function _tachIdxFromUs(samples, tachUs, meta, rawMeta) {
    if (!samples || !meta) return [];
    const t0 = (rawMeta && rawMeta.t0) || 0;
    const n = samples.length;
    const tachIdx = [];
    const periodUs = 1000000 / meta.fs;
    const t0u = t0 >>> 0;
    for (let i = 0; i < (tachUs || []).length; i++) {
      const tu = tachUs[i] >>> 0;
      const si = Math.floor(((tu - t0u) >>> 0) / periodUs);
      if (si >= 0 && si < n) tachIdx.push(si);
    }
    return tachIdx;
  }

  /** 1) Brut = acquisition Sync entière (temporel pur). */
  function exportBrut() {
    const meta = _payloadMeta();
    if (!meta) return null;
    // Primaire = A si présent, sinon B (timeout partiel dual)
    const pri = (_rawSamples && _rawSamples.length) ? _rawSamples : null;
    const sec = (_rawSamplesB && _rawSamplesB.length) ? _rawSamplesB : null;
    if (!pri && !sec) return null;
    if (pri) {
      return _makePayload(
        pri, _tachIdxFromUs(pri, _tachUs, meta, _rawMeta), 'sync-brut',
        (_dual && sec) ? sec : null,
        (_dual && sec) ? _tachIdxFromUs(sec, _tachUsB, meta, _rawMetaB) : null
      );
    }
    return _makePayload(
      sec, _tachIdxFromUs(sec, _tachUsB, meta, _rawMetaB), 'sync-brut',
      null, null
    );
  }

  /** 2) TSA = moyenne angulaire remappée sur chaque tour, concaténée. */
  function exportTsa() {
    const pri = _tsaRaw;
    const sec = _tsaRawB;
    if (pri && pri.length) {
      return _makePayload(pri, _tsaTachIdx, 'sync-tsa',
        (_dual && sec) ? sec : null, (_dual && sec) ? _tsaTachIdxB : null);
    }
    if (sec && sec.length) return _makePayload(sec, _tsaTachIdxB, 'sync-tsa', null, null);
    return null;
  }

  /** 3) Résiduel = (tour_k − TSA) pour chaque tour, concaténé. */
  function exportResidual() {
    const pri = _residualRaw;
    const sec = _residualRawB;
    if (pri && pri.length) {
      return _makePayload(pri, _residualTachIdx, 'sync-res',
        (_dual && sec) ? sec : null, (_dual && sec) ? _residualTachIdxB : null);
    }
    if (sec && sec.length) {
      return _makePayload(sec, _residualTachIdxB, 'sync-res', null, null);
    }
    return null;
  }

  /** Compat anciens appels. */
  function exportRaw() { return exportBrut(); }

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
    _tsaRaw = null;
    _tsaTachIdx = null;
    _residualRaw = null;
    _residualTachIdx = null;
    if (_rawMeta.g) _gRange = _rawMeta.g;
    if (_rawMeta.fs) _fs = _rawMeta.fs;
  }

  function beginBinaryB(meta) {
    _rawMetaB = Object.assign({}, meta || {});
    _rawSamplesB = null;
    _tachUsB = [];
    _tsaRawB = null;
    _tsaTachIdxB = null;
    _residualRawB = null;
    _residualTachIdxB = null;
    if (_rawMetaB.g) _gRange = _rawMetaB.g;
    if (_rawMetaB.fs) _fs = _rawMetaB.fs;
  }

  function onSamples(int16arr) {
    _rawSamples = int16arr;
  }

  function onSamplesB(int16arr) {
    _rawSamplesB = int16arr;
  }

  function onTachUs(list) {
    _tachUs = list || [];
  }

  function onTachUsB(list) {
    _tachUsB = list || [];
  }

  function finalizeFromRaw() {
    const hasA = _rawSamples && _rawSamples.length;
    const hasB = _dual && _rawSamplesB && _rawSamplesB.length;
    if (!hasA && !hasB) {
      setStatus('Buffer vide');
      return false;
    }
    _avg = null;
    _avgB = null;
    _orderMag = null;
    _orderMagB = null;
    _nRevs = 0;
    _nRevsB = 0;

    if (hasA) {
      const fs = (_rawMeta && _rawMeta.fs) || _fs;
      const g = (_rawMeta && _rawMeta.g) || _gRange;
      const t0 = (_rawMeta && _rawMeta.t0) || 0;
      const r = _computeTsa(_rawSamples, fs, g, t0, _tachUs);
      _avg = r.avg;
      _tsaRaw = r.tsaRaw;
      _tsaTachIdx = r.tsaTachIdx;
      _residualRaw = r.residualRaw;
      _residualTachIdx = r.residualTachIdx;
      _stats = r.stats || { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
      _nRevs = r.nRevs;
      _meanRpm = r.meanRpm;
    }
    if (hasB) {
      const fsB = (_rawMetaB && _rawMetaB.fs) || _fs;
      const gB = (_rawMetaB && _rawMetaB.g) || _gRange;
      const t0B = (_rawMetaB && _rawMetaB.t0) || 0;
      const rB = _computeTsa(_rawSamplesB, fsB, gB, t0B, _tachUsB);
      _avgB = rB.avg;
      _tsaRawB = rB.tsaRaw;
      _tsaTachIdxB = rB.tsaTachIdx;
      _residualRawB = rB.residualRaw;
      _residualTachIdxB = rB.residualTachIdx;
      _statsB = rB.stats || { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
      _nRevsB = rB.nRevs;
      if (!_meanRpm && rB.meanRpm > 0) _meanRpm = rB.meanRpm;
    }
    if (_meanRpm > 0) updateRpmBar(_meanRpm);

    const ok = (_nRevs > 0) || (_nRevsB > 0);
    _updateInfoLine();
    showTrace();
    _updateShapeBtn();
    _updateAnalyseBtns(ok);
    setStatus(ok
      ? (_dual
        ? ('TSA DOUBLE — A:' + _nRevs + ' B:' + _nRevsB + ' tours')
        : ('TSA — ' + _nRevs + ' tours  R%=' + _stats.rPct.toFixed(1)))
      : 'Pas assez de tours tach');
    return ok;
  }

  function _updateInfoLine() {
    const info = document.getElementById('sync-mod-info');
    if (!info) return;
    const fs = (_rawMeta && _rawMeta.fs) || (_rawMetaB && _rawMetaB.fs) || _fs;
    if (!_nRevs && !_nRevsB) {
      info.textContent = '—';
      return;
    }
    if (_dual) {
      info.textContent =
        'TSA DOUBLE  A: tours=' + _nRevs + ' R%=' + _stats.rPct.toFixed(1) +
        '  |  B: tours=' + _nRevsB + ' R%=' + _statsB.rPct.toFixed(1) +
        '  RPM=' + Math.round(_meanRpm) +
        '  FS=' + Math.round(fs);
      return;
    }
    info.textContent =
      'TSA  Tours=' + _nRevs +
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
   * TSA angulaire + buffers temporels TSA/résiduel pour Analyse.
   * Soustraction : pour chaque tour k, res_k(θ) = AC(tour_k)(θ) − TSA(θ).
   */
  function _computeTsa(samples, fs, gRange, t0u32, tachAbs) {
    const N = samples.length;
    const periodUs = 1000000 / fs;
    const scale = gRange / 16384;
    const out = {
      avg: null,
      tsaRaw: null, tsaTachIdx: null,
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

    const revs = [];
    const wins = [];
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
        const v = samples[i0 + iA] * scale +
          (samples[i0 + iB] * scale - samples[i0 + iA] * scale) * f;
        rev[g] = v;
        sum[g] += v;
      }
      revs.push(rev);
      wins.push({ i0: i0, nWin: nWin });
      nOk++;
      rpmSum += rpm;
    }

    if (!nOk) return out;

    const avg = new Float32Array(GRID);
    for (let g = 0; g < GRID; g++) avg[g] = sum[g] / nOk;
    _removeDc(avg);

    const resRevs = [];
    for (let k = 0; k < nOk; k++) {
      let m = 0;
      for (let g = 0; g < GRID; g++) m += revs[k][g];
      m /= GRID;
      const res = new Float32Array(GRID);
      for (let g = 0; g < GRID; g++) {
        res[g] = (revs[k][g] - m) - avg[g];
      }
      resRevs.push(res);
    }

    let totN = 0;
    for (let k = 0; k < nOk; k++) totN += wins[k].nWin;
    const brutF = new Float32Array(totN);
    const tsaF = new Float32Array(totN);
    const resF = new Float32Array(totN);
    const tsaI16 = new Int16Array(totN);
    const resI16 = new Int16Array(totN);
    const tachIdx = [];
    let o = 0;

    function quantize(gVal) {
      let q = Math.round(gVal / scale);
      if (q > 32767) q = 32767;
      if (q < -32768) q = -32768;
      return q;
    }

    for (let k = 0; k < nOk; k++) {
      tachIdx.push(o);
      const i0 = wins[k].i0;
      const nWin = wins[k].nWin;
      const resRev = resRevs[k];
      for (let i = 0; i < nWin; i++) {
        const rawG = samples[i0 + i] * scale;
        brutF[o + i] = rawG;
        const pos = (i / nWin) * GRID;
        const iA = Math.floor(pos);
        const iB = Math.min(GRID - 1, iA + 1);
        const f = pos - iA;
        const tsaV = avg[iA] + (avg[iB] - avg[iA]) * f;
        const resV = resRev[iA] + (resRev[iB] - resRev[iA]) * f;
        tsaF[o + i] = tsaV;
        resF[o + i] = resV;
        tsaI16[o + i] = quantize(tsaV);
        resI16[o + i] = quantize(resV);
      }
      o += nWin;
    }
    tachIdx.push(totN);

    const rmsBrut = _rmsArr(brutF);
    const rmsTsa = _rmsArr(tsaF);
    const rmsRes = _rmsArr(resF);

    out.avg = avg;
    out.tsaRaw = tsaI16;
    out.tsaTachIdx = tachIdx.slice();
    out.residualRaw = resI16;
    out.residualTachIdx = tachIdx.slice();
    out.nRevs = nOk;
    out.meanRpm = rpmSum / nOk;
    out.stats = {
      rmsBrut: rmsBrut,
      rmsTsa: rmsTsa,
      rmsRes: rmsRes,
      rPct: rmsBrut > 1e-12 ? (100 * rmsRes / rmsBrut) : 0,
    };
    return out;
  }

  function _fftFromAvg(avg) {
    if (!avg) return null;
    const n = avg.length;
    const mag = new Float32Array(MAX_ORDER + 1);
    for (let k = 1; k <= MAX_ORDER && k < n / 2; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const ang = 2 * Math.PI * k * i / n;
        re += avg[i] * Math.cos(ang);
        im -= avg[i] * Math.sin(ang);
      }
      re /= n;
      im /= n;
      mag[k] = 2 * Math.sqrt(re * re + im * im);
    }
    return mag;
  }

  function _computeOrderFft() {
    if (_avg) _orderMag = _fftFromAvg(_avg);
    if (_avgB) _orderMagB = _fftFromAvg(_avgB);
  }

  function _ampMax() {
    let aMax = 0.1;
    function scan(avg) {
      if (!avg) return;
      for (let i = 0; i < avg.length; i++) {
        const a = Math.abs(avg[i]);
        if (a > aMax) aMax = a;
      }
    }
    if (_showA) scan(_avg);
    if (_dual && _showB) scan(_avgB);
    return aMax * 1.15;
  }

  function _primaryAvg() {
    if (_showA && _avg) return _avg;
    if (_dual && _showB && _avgB) return _avgB;
    return _avg || _avgB;
  }

  function _updateCursorLine() {
    const el = document.getElementById('sync-cursor-line');
    if (!el) return;
    const avg = _primaryAvg();
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
    let txt = 'Curseur  ' + _linCursorDeg.toFixed(1) + '°';
    if (_showA && _avg) txt += '  |  A ' + _avg[idx].toFixed(4) + ' g';
    if (_dual && _showB && _avgB) {
      const idxB = Math.max(0, Math.min(_avgB.length - 1,
        Math.round((_linCursorDeg / 360) * _avgB.length) % _avgB.length));
      txt += '  |  B ' + _avgB[idxB].toFixed(4) + ' g';
    }
    txt += '  |  zoom ' + _linZMin.toFixed(0) + '–' + _linZMax.toFixed(0) + '°';
    el.textContent = txt;
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
      if (_view !== 'trace' || _shape !== 'linear' || !_hasTrace()) return;
      e.preventDefault();
      try { cnv.setPointerCapture(e.pointerId); } catch (err) {}
      _linPtr = { x0: e.clientX, z0: _linZMin, z1: _linZMax };
      _linCursorDeg = degFromClientX(e.clientX);
      _drawTrace();
      _updateCursorLine();
    });
    cnv.addEventListener('pointermove', function (e) {
      if (_view !== 'trace' || _shape !== 'linear' || !_hasTrace()) return;
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
      if (_view !== 'trace' || _shape !== 'linear' || !_hasTrace()) return;
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
    c.fillText('TSA — tour moyen (linéaire °)', P.l, 12);

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

    if (!_hasTrace()) {
      c.fillStyle = '#aaa';
      c.textAlign = 'center';
      c.fillText('—', P.l + gW / 2, P.t + gH / 2);
      return;
    }

    c.save();
    c.beginPath(); c.rect(P.l, P.t, gW, gH); c.clip();
    if (0 >= z0 && 0 <= z1) {
      const xT = xOf(0);
      c.strokeStyle = '#e07000';
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(xT, P.t); c.lineTo(xT, P.t + gH); c.stroke();
    }

    function strokeAvg(avg, color) {
      if (!avg) return;
      const n = avg.length;
      const i0 = Math.max(0, Math.floor((z0 / 360) * n));
      const i1 = Math.min(n - 1, Math.ceil((z1 / 360) * n));
      c.strokeStyle = color;
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
    }
    if (_showA) strokeAvg(_avg, COL);
    if (_dual && _showB) strokeAvg(_avgB, COL_B);

    if (_linCursorDeg != null && _linCursorDeg >= z0 && _linCursorDeg <= z1) {
      const xc = xOf(_linCursorDeg);
      c.strokeStyle = '#cc3300';
      c.lineWidth = 1.2;
      c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(xc, P.t); c.lineTo(xc, P.t + gH); c.stroke();
      c.setLineDash([]);
      const avg = _primaryAvg();
      if (avg) {
        const n = avg.length;
        const idx = Math.max(0, Math.min(n - 1, Math.round((_linCursorDeg / 360) * n) % n));
        c.fillStyle = '#cc3300';
        c.beginPath();
        c.arc(xc, yOf(avg[idx]), 3.5, 0, 2 * Math.PI);
        c.fill();
      }
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
    c.fillText('TSA — tour moyen (polaire °)', 8, 14);

    const aMax = _ampMax();

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

    if (!_hasTrace()) {
      c.fillStyle = '#aaa';
      c.font = '13px "Courier New", monospace';
      c.textAlign = 'center';
      c.fillText('—', cx, cy + 4);
      return;
    }

    const r0 = R * 0.5;
    const rSpan = R * 0.5;

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

    function strokePolar(avg, color) {
      if (!avg) return;
      c.strokeStyle = color;
      c.lineWidth = 1.8;
      c.beginPath();
      const n = avg.length;
      for (let i = 0; i <= n; i++) {
        const idx = i % n;
        const deg = (idx / n) * 360;
        const angRad = (deg - 90) * Math.PI / 180;
        const rr = r0 + (avg[idx] / aMax) * rSpan;
        const px = cx + rr * Math.cos(angRad);
        const py = cy + rr * Math.sin(angRad);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
    }
    if (_showA) strokePolar(_avg, COL);
    if (_dual && _showB) strokePolar(_avgB, COL_B);

    const avg0 = _primaryAvg();
    if (avg0) {
      const rStart = r0 + (avg0[0] / aMax) * rSpan;
      c.beginPath();
      c.arc(cx, cy - rStart, 4, 0, 2 * Math.PI);
      c.fillStyle = '#e07000';
      c.fill();
    }
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
    c.fillText('Spectre d\'ordres TSA (g)', padL, 12);

    const magA = (_showA && _orderMag) ? _orderMag : null;
    const magB = (_dual && _showB && _orderMagB) ? _orderMagB : null;
    if (!magA && !magB) {
      c.fillStyle = '#aaa';
      c.textAlign = 'center';
      c.fillText('—', padL + gW / 2, padT + gH / 2);
      return;
    }

    let aMax = 0;
    for (let k = 1; k <= MAX_ORDER; k++) {
      if (magA && magA[k] > aMax) aMax = magA[k];
      if (magB && magB[k] > aMax) aMax = magB[k];
    }
    if (!(aMax > 0)) aMax = 0.1;
    aMax *= 1.15;

    const barW = gW / MAX_ORDER;
    const dualBars = !!(magA && magB);
    for (let k = 1; k <= MAX_ORDER; k++) {
      const x0 = padL + (k - 0.5) * barW;
      if (magA) {
        const h = (magA[k] / aMax) * gH;
        const w = dualBars ? barW * 0.32 : barW * 0.7;
        const x = dualBars ? (x0 - barW * 0.35) : (x0 - barW * 0.35);
        c.fillStyle = COL;
        c.fillRect(x, padT + gH - h, w, h);
      }
      if (magB) {
        const h = (magB[k] / aMax) * gH;
        const w = dualBars ? barW * 0.32 : barW * 0.7;
        const x = dualBars ? (x0 + barW * 0.02) : (x0 - barW * 0.35);
        c.fillStyle = COL_B;
        c.fillRect(x, padT + gH - h, w, h);
      }
      if (k === 1 || k % 4 === 0 || k === MAX_ORDER) {
        c.fillStyle = '#888';
        c.font = '9px "Courier New", monospace';
        c.textAlign = 'center';
        c.fillText(String(k) + 'X', x0, H - 8);
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
      if (_view === 'fft_order' && ((_avg && !_orderMag) || (_avgB && !_orderMagB))) {
        _computeOrderFft();
      }
      _drawFft();
    }
  }

  function clearResult() {
    _avg = null;
    _avgB = null;
    _orderMag = null;
    _orderMagB = null;
    _nRevs = 0;
    _nRevsB = 0;
    _meanRpm = 0;
    _rawSamples = null;
    _rawSamplesB = null;
    _tachUs = [];
    _tachUsB = [];
    _rawMeta = null;
    _rawMetaB = null;
    _tsaRaw = null;
    _tsaTachIdx = null;
    _residualRaw = null;
    _residualTachIdx = null;
    _tsaRawB = null;
    _tsaTachIdxB = null;
    _residualRawB = null;
    _residualTachIdxB = null;
    _stats = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
    _statsB = { rmsBrut: 0, rmsTsa: 0, rmsRes: 0, rPct: 0 };
    _view = 'trace';
    _linZMin = 0;
    _linZMax = 360;
    _linCursorDeg = null;
    const info = document.getElementById('sync-mod-info');
    if (info) info.textContent = '—';
    _updateShapeBtn();
    _updateAnalyseBtns(false);
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
    setDual: setDual,
    toggleVis: toggleVis,
    getAcqTiming: getAcqTiming,
    showTrace: showTrace,
    showOrderFft: showOrderFft,
    exportRaw: exportRaw,
    exportBrut: exportBrut,
    exportTsa: exportTsa,
    exportResidual: exportResidual,
    toggleShape: toggleShape,
    getShape: getShape,
    getView: getView,
    setStatus: setStatus,
    onTachPeriod: onTachPeriod,
    updateRpmBar: updateRpmBar,
    beginBinary: beginBinary,
    beginBinaryB: beginBinaryB,
    onSamples: onSamples,
    onSamplesB: onSamplesB,
    onTachUs: onTachUs,
    onTachUsB: onTachUsB,
    finalizeFromRaw: finalizeFromRaw,
    clearResult: clearResult,
    resize: resize,
  };
})();

window.SyncModule = SyncModule;
