// bode.js — Module Bode brut : preview live + post-STOP 1X vs RPM (JS only)
// Mono A / mono B / duo AB (overlay bleu/orange).

const BodeModule = (() => {
  const COL_A = '#0033cc';
  const COL_B = '#e67e22';
  const BODE_LIVE_HZ = 50;
  const TACH_STALE_MS = 1500;

  let _initialized = false;
  let _mode = 'preview'; // 'preview' | 'bode'
  let _gRange = 2;
  let _fs = 4000;
  let _nCfg = 45000;
  let _dual = false;
  let _showA = true;
  let _showB = true;

  // Preview live
  let _liveCanvas, _liveCtx;
  let _liveWin = null;
  let _liveHead = 0;
  let _liveFilled = false;
  let _liveWinB = null;
  let _liveHeadB = 0;
  let _liveFilledB = false;
  let _liveRaf = null;
  let _liveRunning = false;

  // Final Bode
  let _phaseCanvas, _phaseCtx;
  let _ampCanvas, _ampCtx;
  let _ptsA = []; // { rpm, amp, phase, canal }
  let _ptsB = [];
  let _rpm = 0;
  let _lastTachMs = 0;
  let _lastRange = null;
  let _cursorRpm = null;
  let _plotGeom = { padL: 52, padR: 12, padTThin: 16, padBThin: 6, padT: 18, padB: 24 };

  // Raw payload (post-STOP)
  let _rawSamples = null;
  let _rawMeta = null;
  let _tachUs = [];
  let _rawSamplesB = null;
  let _rawMetaB = null;
  let _tachUsB = [];

  function init() {
    if (_initialized) return;
    _initialized = true;
    _liveCanvas = document.getElementById('bode-live-canvas');
    _liveCtx = _liveCanvas ? _liveCanvas.getContext('2d') : null;
    _phaseCanvas = document.getElementById('bode-mod-phase-canvas');
    _phaseCtx = _phaseCanvas ? _phaseCanvas.getContext('2d') : null;
    _ampCanvas = document.getElementById('bode-mod-amp-canvas');
    _ampCtx = _ampCanvas ? _ampCanvas.getContext('2d') : null;

    const btn = document.getElementById('btn-bode-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.toggleStart) {
          BodeModuleSession.toggleStart();
        }
      });
    }
    _bindCursorEvents(_phaseCanvas);
    _bindCursorEvents(_ampCanvas);
    const visA = document.getElementById('btn-bode-vis-a');
    const visB = document.getElementById('btn-bode-vis-b');
    if (visA) visA.addEventListener('click', function () { toggleVis('A'); });
    if (visB) visB.addEventListener('click', function () { toggleVis('B'); });
    window.addEventListener('resize', resize);
    _applyLayout();
    resize();
  }

  function setDual(on) {
    _dual = !!on;
    if (!_dual) {
      _showA = true;
      _showB = true;
    }
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
    if (_mode === 'preview') _drawLive();
    else _drawBodeCharts();
    _updateCursorReadout();
  }

  function _syncVisUi() {
    const row = document.getElementById('bode-vis-row');
    if (row) row.style.display = _dual ? 'flex' : 'none';
    const visA = document.getElementById('btn-bode-vis-a');
    const visB = document.getElementById('btn-bode-vis-b');
    if (visA) visA.classList.toggle('active', _showA);
    if (visB) visB.classList.toggle('active', _showB);
  }

  function _visiblePts() {
    const out = [];
    if (_showA && _ptsA.length) {
      for (let i = 0; i < _ptsA.length; i++) out.push(_ptsA[i]);
    }
    if (_dual && _showB && _ptsB.length) {
      for (let i = 0; i < _ptsB.length; i++) out.push(_ptsB[i]);
    }
    return out;
  }

  function _bindCursorEvents(canvas) {
    if (!canvas) return;
    canvas.style.touchAction = 'none';
    const onPtr = function (e) {
      if (_mode !== 'bode' || !_visiblePts().length) return;
      e.preventDefault();
      _setCursorFromClientX(canvas, e.clientX);
    };
    canvas.addEventListener('pointerdown', function (e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      onPtr(e);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (e.buttons || e.pointerType === 'touch') onPtr(e);
    });
  }

  function _setCursorFromClientX(canvas, clientX) {
    if (!_lastRange || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8) return;
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const g = _plotGeom;
    const gW = canvas.width - g.padL - g.padR;
    if (gW < 8) return;
    let t = (x - g.padL) / gW;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    _cursorRpm = _lastRange.rMin + t * (_lastRange.rMax - _lastRange.rMin);
    _drawBodeCharts();
    _updateCursorReadout();
  }

  function _nearestPt(rpm) {
    const pts = _visiblePts();
    if (!pts.length || !(rpm > 0 || rpm === 0)) return null;
    let best = pts[0], bestD = Math.abs(pts[0].rpm - rpm);
    for (let i = 1; i < pts.length; i++) {
      const d = Math.abs(pts[i].rpm - rpm);
      if (d < bestD) { bestD = d; best = pts[i]; }
    }
    return best;
  }

  function _peakPt() {
    const pts = _visiblePts();
    if (!pts.length) return null;
    let peak = pts[0];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].amp > peak.amp) peak = pts[i];
    }
    return peak;
  }

  function _fmtAmp(a) {
    if (!(a > 0)) return '0';
    if (a >= 10) return a.toFixed(2);
    if (a >= 1) return a.toFixed(3);
    return a.toFixed(4);
  }

  function _updateCursorReadout() {
    const el = document.getElementById('bode-cursor-line');
    if (!el) return;
    const pt = _nearestPt(_cursorRpm);
    if (!pt) {
      el.textContent = 'Toucher le graphe → curseur RPM';
      return;
    }
    const hz = pt.rpm / 60;
    const ch = pt.canal ? ('[' + pt.canal + '] ') : '';
    el.textContent =
      ch + 'Curseur  RPM=' + Math.round(pt.rpm) +
      '  (' + hz.toFixed(2) + ' Hz)' +
      '  |  Amp=' + _fmtAmp(pt.amp) + ' g' +
      '  |  Phase=' + pt.phase.toFixed(1) + '°';
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
    const el = document.getElementById('bode-cfg-line');
    if (el) {
      const T = (_nCfg / _fs);
      const gLbl = autoG ? 'AUTO' : ('±' + _gRange + 'g');
      el.textContent = 'FS=' + _fs + ' Hz  Fenêtre max=' + T.toFixed(3) + ' s  ' + gLbl;
    }
  }

  function _applyLayout() {
    const prev = document.getElementById('bode-preview-wrap');
    const bode = document.getElementById('bode-result-wrap');
    if (prev) prev.style.display = _mode === 'preview' ? 'flex' : 'none';
    if (bode) bode.style.display = _mode === 'bode' ? 'flex' : 'none';
  }

  function showPreview() {
    _mode = 'preview';
    _applyLayout();
    resize();
  }

  function showBodeResult() {
    _mode = 'bode';
    _applyLayout();
    resize();
    _drawBodeCharts();
  }

  function resetLive() {
    _liveWin = null;
    _liveHead = 0;
    _liveFilled = false;
    _liveWinB = null;
    _liveHeadB = 0;
    _liveFilledB = false;
  }

  function startLiveAnim() {
    _liveRunning = true;
    if (_liveRaf) return;
    const tick = function () {
      if (!_liveRunning || _mode !== 'preview') {
        _liveRaf = null;
        return;
      }
      _drawLive();
      _liveRaf = requestAnimationFrame(tick);
    };
    _liveRaf = requestAnimationFrame(tick);
  }

  function stopLiveAnim() {
    _liveRunning = false;
    if (_liveRaf) {
      cancelAnimationFrame(_liveRaf);
      _liveRaf = null;
    }
  }

  function updateRpmBar(rpm) {
    _rpm = rpm || 0;
    _lastTachMs = Date.now();
    const el = document.getElementById('bode-rpm-val');
    const dot = document.getElementById('bode-rpm-dot');
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

  function _pushLive(rawVal, isB) {
    const T = _nCfg / _fs;
    const target = Math.max(32, Math.floor(T * BODE_LIVE_HZ));
    const gVal = (Number(rawVal) || 0) * (_gRange / 32768.0);
    if (isB) {
      if (!_liveWinB || _liveWinB.length !== target) {
        _liveWinB = new Float32Array(target);
        _liveHeadB = 0;
        _liveFilledB = false;
      }
      _liveWinB[_liveHeadB] = gVal;
      _liveHeadB = (_liveHeadB + 1) % _liveWinB.length;
      if (_liveHeadB === 0) _liveFilledB = true;
    } else {
      if (!_liveWin || _liveWin.length !== target) {
        _liveWin = new Float32Array(target);
        _liveHead = 0;
        _liveFilled = false;
      }
      _liveWin[_liveHead] = gVal;
      _liveHead = (_liveHead + 1) % _liveWin.length;
      if (_liveHead === 0) _liveFilled = true;
    }
  }

  function onLive(rawVal) {
    _pushLive(rawVal, false);
    if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.onLive) {
      BodeModuleSession.onLive();
    }
  }

  function onLiveB(rawVal) {
    _pushLive(rawVal, true);
    if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.onLive) {
      BodeModuleSession.onLive();
    }
  }

  function setStatus(text) {
    const el = document.getElementById('bode-status');
    if (el) el.textContent = text || '—';
  }

  function _strokeLiveWin(c, win, head, filled, color, W, H, ymax) {
    if (!win || !win.length) return;
    const n = win.length;
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const idx = filled ? (head + i) % n : i;
      if (!filled && i >= head) break;
      const v = win[idx];
      const x = (i / Math.max(1, n - 1)) * W;
      const y = H / 2 - (v / ymax) * (H * 0.45);
      if (!started) { c.moveTo(x, y); started = true; }
      else c.lineTo(x, y);
    }
    if (started) c.stroke();
  }

  function _drawLive() {
    if (!_liveCtx || !_liveCanvas) return;
    if (!_liveWin && !_liveWinB) return;
    const c = _liveCtx;
    const W = _liveCanvas.width, H = _liveCanvas.height;
    if (W < 8 || H < 8) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, W, H);
    const ymax = Math.max(0.2, _gRange * 1.05);
    c.strokeStyle = '#ddd';
    c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
    if (_showA) _strokeLiveWin(c, _liveWin, _liveHead, _liveFilled, COL_A, W, H, ymax);
    if (_dual && _showB) {
      _strokeLiveWin(c, _liveWinB, _liveHeadB, _liveFilledB, COL_B, W, H, ymax);
    }
  }

  // ── Binary payload ──────────────────────────────────────────
  function beginBinary(meta) {
    _rawMeta = Object.assign({}, _rawMeta || {}, meta || {});
    _rawSamples = null;
    _tachUs = [];
    if (_rawMeta.g) _gRange = _rawMeta.g;
    if (_rawMeta.fs) _fs = _rawMeta.fs;
  }

  function beginBinaryB(meta) {
    _rawMetaB = Object.assign({}, _rawMetaB || {}, meta || {});
    _rawSamplesB = null;
    _tachUsB = [];
    if (_rawMetaB.g) _gRange = _rawMetaB.g;
    if (_rawMetaB.fs) _fs = _rawMetaB.fs;
  }

  /** Met à jour meta après beginBinary (ex. T0 reçu tard). */
  function patchMeta(partial) {
    _rawMeta = Object.assign({}, _rawMeta || {}, partial || {});
    if (_rawMeta.g) _gRange = _rawMeta.g;
    if (_rawMeta.fs) _fs = _rawMeta.fs;
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
    _ptsA = [];
    _ptsB = [];
    if (hasA) {
      const fs = (_rawMeta && _rawMeta.fs) || _fs;
      const g = (_rawMeta && _rawMeta.g) || _gRange;
      const t0 = (_rawMeta && _rawMeta.t0) || 0;
      _ptsA = _computeBode1X(_rawSamples, fs, g, t0, _tachUs, 'A');
    }
    if (hasB) {
      const fsB = (_rawMetaB && _rawMetaB.fs) || _fs;
      const gB = (_rawMetaB && _rawMetaB.g) || _gRange;
      const t0B = (_rawMetaB && _rawMetaB.t0) || 0;
      _ptsB = _computeBode1X(_rawSamplesB, fsB, gB, t0B, _tachUsB, 'B');
    }
    const peak = _peakPt();
    _cursorRpm = peak ? peak.rpm : null;
    const nPts = _ptsA.length + _ptsB.length;
    const info = document.getElementById('bode-mod-info');
    if (info) {
      const fs = (_rawMeta && _rawMeta.fs) || (_rawMetaB && _rawMetaB.fs) || _fs;
      info.textContent =
        (_dual ? 'DOUBLE  ' : '') +
        'A: N=' + (hasA ? _rawSamples.length : 0) + ' pts=' + _ptsA.length +
        (_dual
          ? ('  |  B: N=' + (hasB ? _rawSamplesB.length : 0) + ' pts=' + _ptsB.length)
          : ('  tach=' + _tachUs.length)) +
        '  FS=' + fs +
        (peak ? ('  |  Pic amp @ ' + Math.round(peak.rpm) + ' RPM') : '');
    }
    showBodeResult();
    _updateCursorReadout();
    const saveBtn = document.getElementById('btn-bode-save');
    if (saveBtn) saveBtn.style.display = nPts ? 'inline-block' : 'none';
    setStatus(nPts
      ? ('Bode 1X — ' + nPts + ' points' + (_dual ? ' (A+B)' : ''))
      : 'Pas assez de tours tach');
    return nPts > 0;
  }

  /**
   * Order tracking 1X : une fenêtre par tour (pulse → pulse).
   */
  function _computeBode1X(samples, fs, gRange, t0u32, tachAbs, canal) {
    const N = samples.length;
    const periodUs = 1000000 / fs;
    const lsbPerG = 16384 / gRange; // cohérent HarmonicModule
    const ch = canal || 'A';
    const out = [];
    if (!tachAbs || tachAbs.length < 2) return out;

    // Paires (sampleIndex, tachUs) — garder us et index alignés
    const pairs = [];
    for (let i = 0; i < tachAbs.length; i++) {
      const tu = tachAbs[i] >>> 0;
      const rel = (tu - (t0u32 >>> 0)) >>> 0;
      const si = Math.floor(rel / periodUs);
      if (si >= 0 && si < N) pairs.push({ si: si, us: tu });
    }
    pairs.sort(function (a, b) { return a.si - b.si; });

    for (let k = 0; k < pairs.length - 1; k++) {
      const i0 = pairs[k].si;
      const i1 = pairs[k + 1].si;
      const nWin = i1 - i0;
      if (nWin < 8) continue;
      const dtUs = (pairs[k + 1].us - pairs[k].us) >>> 0;
      if (dtUs < 500) continue;
      const rpm = 60000000 / dtUs;
      if (!(rpm > 60 && rpm < 100000)) continue;

      let mean = 0;
      for (let i = i0; i < i1; i++) mean += samples[i];
      mean /= nWin;

      let sumCos = 0, sumSin = 0;
      for (let i = 0; i < nWin; i++) {
        const val_g = (samples[i0 + i] - mean) / lsbPerG;
        const ang = 2 * Math.PI * i / nWin; // exactement 1 cycle / tour
        sumCos += val_g * Math.cos(ang);
        sumSin += val_g * Math.sin(ang);
      }
      sumCos /= nWin;
      sumSin /= nWin;
      const amp = 2 * Math.sqrt(sumCos * sumCos + sumSin * sumSin);
      // Phase wrapée 0–360° (pas d'unwrap continu → axe Y auto-scale réel)
      let phase = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
      if (phase < 0) phase += 360;
      if (phase >= 360) phase -= 360;
      out.push({ rpm: rpm, amp: amp, phase: phase, canal: ch });
    }

    out.sort(function (a, b) { return a.rpm - b.rpm; });
    return out;
  }

  function _axisRange(pts) {
    if (!pts.length) return { rMin: 0, rMax: 1000, aMax: 1, pMin: 0, pMax: 90 };
    let rMin = Infinity, rMax = -Infinity, aMax = 0, pMin = Infinity, pMax = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.rpm < rMin) rMin = p.rpm;
      if (p.rpm > rMax) rMax = p.rpm;
      if (p.amp > aMax) aMax = p.amp;
      if (p.phase < pMin) pMin = p.phase;
      if (p.phase > pMax) pMax = p.phase;
    }
    if (!(rMax > rMin)) { rMin = Math.max(0, rMin - 50); rMax = rMin + 100; }
    if (!(aMax > 0)) aMax = 1;
    // Auto-scale phase : zoom sur la plage réelle (pas forcé 0–360)
    let pSpan = pMax - pMin;
    if (!(pSpan > 0) || !isFinite(pSpan)) {
      pMin = Math.max(0, (pMin || 0) - 20);
      pMax = Math.min(360, pMin + 40);
      pSpan = pMax - pMin;
    }
    // Span mini ~20° pour lisibilité
    if (pSpan < 20) {
      const mid = (pMin + pMax) / 2;
      pMin = mid - 10;
      pMax = mid + 10;
      pSpan = 20;
    }
    const rPad = (rMax - rMin) * 0.05 || 20;
    const pPad = Math.max(pSpan * 0.08, 5);
    let y0 = pMin - pPad;
    let y1 = pMax + pPad;
    // Garder dans [0, 360] si possible, sans forcer tout l'intervalle
    if (y0 < 0 && y1 <= 360) { y1 -= y0; y0 = 0; }
    if (y1 > 360 && y0 >= 0) { y0 -= (y1 - 360); y1 = 360; }
    if (y0 < 0) y0 = 0;
    if (y1 > 360) y1 = 360;
    if (!(y1 > y0)) { y0 = 0; y1 = 90; }
    return {
      rMin: Math.max(0, rMin - rPad),
      rMax: rMax + rPad,
      aMax: aMax * 1.15,
      pMin: y0,
      pMax: y1
    };
  }

  function _drawChart(ctx, canvas, title, yUnit, series, range, yNormOf, yTickVal, thin) {
    if (!ctx || !canvas) return;
    const W = canvas.width, H = canvas.height;
    if (W < 10 || H < 10) return;
    const g = _plotGeom;
    const padL = g.padL, padR = g.padR;
    const padT = thin ? g.padTThin : g.padT;
    const padB = thin ? g.padBThin : g.padB;
    const gW = W - padL - padR, gH = H - padT - padB;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ddd';
    ctx.strokeRect(padL, padT, gW, gH);
    ctx.fillStyle = '#444';
    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(title, padL, 12);

    ctx.save();
    ctx.translate(11, padT + gH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#666';
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(yUnit, 0, 0);
    ctx.restore();

    function xOf(rpm) {
      return padL + ((rpm - range.rMin) / (range.rMax - range.rMin || 1)) * gW;
    }
    function yPix(norm) {
      return padT + (1 - norm) * gH;
    }

    const nTickX = 4;
    for (let t = 0; t <= nTickX; t++) {
      const rpm = range.rMin + (range.rMax - range.rMin) * t / nTickX;
      const x = xOf(rpm);
      ctx.strokeStyle = '#eee';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + gH); ctx.stroke();
      if (!thin) {
        ctx.fillStyle = '#888';
        ctx.font = '10px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(Math.round(rpm)), x, H - 6);
      }
    }
    if (!thin) {
      ctx.fillStyle = '#888';
      ctx.font = '10px "Courier New", monospace';
      ctx.textAlign = 'right';
      ctx.fillText('RPM', W - padR, H - 6);
    }

    const nTickY = thin ? 3 : 4;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'right';
    for (let t = 0; t <= nTickY; t++) {
      const yn = t / nTickY;
      const y = yPix(yn);
      ctx.strokeStyle = '#f0f0f0';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + gW, y); ctx.stroke();
      const val = yTickVal(yn);
      ctx.fillStyle = '#666';
      ctx.fillText(val, padL - 4, y + 3);
    }

    let any = false;
    for (let s = 0; s < series.length; s++) {
      const pts = series[s].pts;
      if (!pts || !pts.length) continue;
      any = true;
      ctx.strokeStyle = series[s].color || COL_A;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const px = xOf(pts[i].rpm);
        const py = yPix(yNormOf(pts[i]));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    if (!any) {
      ctx.fillStyle = '#aaa';
      ctx.textAlign = 'center';
      ctx.fillText('—', padL + gW / 2, padT + gH / 2);
      return;
    }

    if (_cursorRpm != null && _cursorRpm >= range.rMin && _cursorRpm <= range.rMax) {
      const cx = xOf(_cursorRpm);
      ctx.strokeStyle = '#cc3300';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + gH); ctx.stroke();
      ctx.setLineDash([]);
      const npt = _nearestPt(_cursorRpm);
      if (npt) {
        const py = yPix(yNormOf(npt));
        ctx.fillStyle = '#cc3300';
        ctx.beginPath();
        ctx.arc(xOf(npt.rpm), py, 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  function _drawBodeCharts() {
    const vis = _visiblePts();
    const range = _axisRange(vis.length ? vis : _ptsA);
    _lastRange = range;
    const pSpan = range.pMax - range.pMin || 1;
    const series = [];
    if (_showA && _ptsA.length) series.push({ pts: _ptsA, color: COL_A });
    if (_dual && _showB && _ptsB.length) series.push({ pts: _ptsB, color: COL_B });
    _drawChart(
      _phaseCtx, _phaseCanvas,
      'Phase 1X', '°',
      series, range,
      function (p) { return (p.phase - range.pMin) / pSpan; },
      function (yn) {
        const v = range.pMin + yn * pSpan;
        return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '°';
      },
      true
    );
    _drawChart(
      _ampCtx, _ampCanvas,
      'Amp 1X', 'g',
      series, range,
      function (p) { return p.amp / range.aMax; },
      function (yn) {
        return _fmtAmp(yn * range.aMax);
      },
      false
    );
  }

  function resize() {
    if (_mode === 'preview' && _liveCanvas) {
      const wrap = document.getElementById('bode-live-wrap');
      if (wrap && wrap.clientWidth > 0) {
        _liveCanvas.width = wrap.clientWidth;
        _liveCanvas.height = Math.max(120, wrap.clientHeight || 180);
      }
      _drawLive();
    } else {
      const pw = document.getElementById('bode-mod-phase-wrap');
      const aw = document.getElementById('bode-mod-amp-wrap');
      if (pw && _phaseCanvas && pw.clientWidth > 0) {
        _phaseCanvas.width = pw.clientWidth;
        _phaseCanvas.height = Math.max(60, pw.clientHeight || 80);
      }
      if (aw && _ampCanvas && aw.clientWidth > 0) {
        _ampCanvas.width = aw.clientWidth;
        _ampCanvas.height = Math.max(120, aw.clientHeight || 200);
      }
      _drawBodeCharts();
    }
  }

  function clearResult() {
    _ptsA = [];
    _ptsB = [];
    _rawSamples = null;
    _rawSamplesB = null;
    _tachUs = [];
    _tachUsB = [];
    _rawMeta = null;
    _rawMetaB = null;
    _cursorRpm = null;
    _lastRange = null;
    const el = document.getElementById('bode-cursor-line');
    if (el) el.textContent = '—';
    const saveBtn = document.getElementById('btn-bode-save');
    if (saveBtn) saveBtn.style.display = 'none';
  }

  /** Export CSV courbe Bode 1X (RPM, amp g, phase ° [, Canal]). */
  function saveFile() {
    const all = [];
    for (let i = 0; i < _ptsA.length; i++) all.push(_ptsA[i]);
    for (let i = 0; i < _ptsB.length; i++) all.push(_ptsB[i]);
    if (!all.length) {
      alert('Aucune courbe Bode — arrêter un enregistrement d\'abord');
      return;
    }
    const nom = prompt(
      'Nom du fichier Bode:',
      'bode_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    );
    if (!nom) return;
    const dualCsv = _dual || _ptsB.length > 0;
    const lines = [];
    lines.push('# VibrationAnalyser — Bode 1X');
    lines.push('# Date: ' + new Date().toISOString());
    if (_rawMeta) {
      lines.push('# G: ±' + (_rawMeta.g || _gRange) + ' g');
      lines.push('# Fs: ' + (_rawMeta.fs || _fs) + ' Hz');
      lines.push('# N_A: ' + (_rawMeta.n || (_rawSamples && _rawSamples.length) || 0));
    }
    if (_rawMetaB) {
      lines.push('# N_B: ' + (_rawMetaB.n || (_rawSamplesB && _rawSamplesB.length) || 0));
    }
    lines.push('# Points: ' + all.length + (dualCsv ? ' (A+B)' : ''));
    lines.push(dualCsv ? 'RPM,Amp_g,Phase_deg,Canal' : 'RPM,Amp_g,Phase_deg');
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      let row = p.rpm.toFixed(2) + ',' + p.amp.toFixed(6) + ',' + p.phase.toFixed(2);
      if (dualCsv) row += ',' + (p.canal || 'A');
      lines.push(row);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nom.replace(/\.csv$/i, '') + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Parse CSV Bode (Sauv) → { ptsA, ptsB }. null si format inconnu. */
  function parseBodeCsv(text) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/);
    let headerSeen = false;
    let looksBode = /Bode\s*1X/i.test(text) || /Amp_g\s*,\s*Phase/i.test(text);
    let hasCanal = false;
    const ptsA = [];
    const ptsB = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (raw.charAt(0) === '#') {
        if (/Bode/i.test(raw)) looksBode = true;
        continue;
      }
      if (/^RPM\s*,\s*Amp/i.test(raw)) {
        headerSeen = true;
        looksBode = true;
        hasCanal = /Canal/i.test(raw);
        continue;
      }
      if (!headerSeen && !looksBode) continue;
      const parts = raw.split(/[,;\t]/);
      if (parts.length < 3) continue;
      const rpm = parseFloat(parts[0]);
      const amp = parseFloat(parts[1]);
      const phase = parseFloat(parts[2]);
      if (!(rpm >= 0) || !isFinite(amp) || !isFinite(phase)) continue;
      let ch = 'A';
      if (hasCanal && parts[3]) {
        const c = String(parts[3]).trim().toUpperCase();
        if (c === 'B') ch = 'B';
      }
      const pt = { rpm: rpm, amp: amp, phase: phase, canal: ch };
      if (ch === 'B') ptsB.push(pt);
      else ptsA.push(pt);
    }
    if ((!ptsA.length && !ptsB.length) || !looksBode) return null;
    ptsA.sort(function (a, b) { return a.rpm - b.rpm; });
    ptsB.sort(function (a, b) { return a.rpm - b.rpm; });
    return { ptsA: ptsA, ptsB: ptsB };
  }

  /** Charge une courbe Bode sauvegardée (sans re-passer par Analyse). */
  function loadFromText(text, fileName) {
    const parsed = parseBodeCsv(text);
    if (!parsed) return false;
    stopLiveAnim();
    _ptsA = parsed.ptsA || [];
    _ptsB = parsed.ptsB || [];
    _dual = _ptsB.length > 0;
    _showA = true;
    _showB = true;
    _syncVisUi();
    _rawSamples = null;
    _rawSamplesB = null;
    _tachUs = [];
    _tachUsB = [];
    _cursorRpm = null;
    _mode = 'bode';
    _applyLayout();
    const n = _ptsA.length + _ptsB.length;
    const saveBtn = document.getElementById('btn-bode-save');
    if (saveBtn) saveBtn.style.display = '';
    setStatus('Chargé' + (fileName ? (': ' + fileName) : '') + ' — ' + n + ' pts');
    const cfg = document.getElementById('bode-cfg-line');
    if (cfg) cfg.textContent = 'Bode chargé — ' + n + ' points 1X';
    showBodeResult();
    return true;
  }

  function loadFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,.txt,text/csv,text/plain';
    inp.onchange = function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (ev) {
        if (!loadFromText(ev.target.result, file.name)) {
          alert(
            'Format Bode non reconnu.\n\n' +
            'Attendu : CSV « Sauv » Bode (# VibrationAnalyser — Bode 1X + RPM,Amp_g,Phase_deg)'
          );
        } else if (typeof showTab === 'function') {
          showTab('bode');
        }
      };
      reader.onerror = function () { alert('Lecture fichier impossible'); };
      reader.readAsText(file);
    };
    inp.click();
  }

  // Stale RPM
  setInterval(function () {
    if (_lastTachMs && Date.now() - _lastTachMs > TACH_STALE_MS) {
      if (_rpm !== 0) updateRpmBar(0);
    }
  }, 250);

  return {
    init: init,
    setConfig: setConfig,
    setDual: setDual,
    toggleVis: toggleVis,
    showPreview: showPreview,
    showBodeResult: showBodeResult,
    resetLive: resetLive,
    startLiveAnim: startLiveAnim,
    stopLiveAnim: stopLiveAnim,
    onLive: onLive,
    onLiveB: onLiveB,
    onTachPeriod: onTachPeriod,
    updateRpmBar: updateRpmBar,
    setStatus: setStatus,
    beginBinary: beginBinary,
    beginBinaryB: beginBinaryB,
    patchMeta: patchMeta,
    onSamples: onSamples,
    onSamplesB: onSamplesB,
    onTachUs: onTachUs,
    onTachUsB: onTachUsB,
    finalizeFromRaw: finalizeFromRaw,
    clearResult: clearResult,
    saveFile: saveFile,
    parseBodeCsv: parseBodeCsv,
    loadFromText: loadFromText,
    loadFile: loadFile,
    resize: resize,
  };
})();

window.bodeSave = function () {
  if (typeof BodeModule !== 'undefined' && BodeModule.saveFile) BodeModule.saveFile();
};

window.bodeLoad = function () {
  if (typeof BodeModule !== 'undefined' && BodeModule.loadFile) BodeModule.loadFile();
};

window.BodeModule = BodeModule;
