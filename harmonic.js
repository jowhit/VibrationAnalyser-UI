// ═══════════════════════════════════════════════════════════════
// harmonic.js  —  Onglet Harmonique
// Architecture : ESP32 envoie HARM_BIN (binaire brut)
// JS fait : DFT multi-harmoniques → polaire + speedomètre
//
// Start/Stop :
//   Start → WS_GOTO=ANAL_HARM → ESP commence, envoie en boucle
//   Stop  → WS_GOTO=HARM_STOP → ESP s'arrête, bouton revient en Start
// ═══════════════════════════════════════════════════════════════

const HarmonicModule = (() => {

  let _harmonics  = [];
  let _rpm        = 0;
  let _fs         = 0;
  let _running    = false;

  let _polarCanvas, _polarCtx;
  let _speedCanvas, _speedCtx;
  let _initialized = false;

  // ── Un seul visage calculé par trame : false = Harmonique, true = Suivi phase ──
  let _phaseTrackingMode = false;

  // ── Suivi de phase (préfixe _pt — pas partagé avec le calcul harmonique) ──
  const PT_SAT_THRESHOLD = 32700;
  const PT_SAT_WARN_PCT  = 5;
  const PT_HISTORY_SIZE  = 8;

  let _ptCanvas, _ptCtx;
  let _ptHistory = [];
  let _ptHasData = false;
  let _ptPhase = 0;
  let _ptAmpG = 0;
  let _ptSatPct = 0;
  let _ptIsSaturated = false;

  function _applyCanvasVisibility() {
    if (_polarCanvas) _polarCanvas.style.display = _phaseTrackingMode ? 'none' : '';
    if (_speedCanvas) _speedCanvas.style.display = _phaseTrackingMode ? 'none' : '';
    if (_ptCanvas) _ptCanvas.style.display = _phaseTrackingMode ? '' : 'none';
  }

  // ── INIT ────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _polarCanvas = document.getElementById('harm-polar-canvas');
    _polarCtx    = _polarCanvas ? _polarCanvas.getContext('2d') : null;
    _speedCanvas = document.getElementById('harm-speed-canvas');
    _speedCtx    = _speedCanvas ? _speedCanvas.getContext('2d') : null;
    _ptCanvas    = document.getElementById('pt-canvas');
    _ptCtx       = _ptCanvas ? _ptCanvas.getContext('2d') : null;

    const btn = document.getElementById('btn-harm-toggle');
    if (btn) btn.addEventListener('click', harmToggle);

    _applyCanvasVisibility();
    window.addEventListener('resize', _resize);
    _resize();
    _updateBtn();
  }

  function _resize() {
    _applyCanvasVisibility();

    if (!_phaseTrackingMode) {
      const wrap = document.getElementById('harm-polar-wrap');
      if (wrap && _polarCanvas) {
        if (wrap.clientWidth === 0) { setTimeout(_resize, 60); return; }
        var sz = Math.min(wrap.clientWidth,
                          wrap.clientHeight > 0 ? wrap.clientHeight : wrap.clientWidth,
                          400);
        _polarCanvas.width  = sz;
        _polarCanvas.height = sz;
      }

      const swrap = document.getElementById('harm-speed-wrap');
      if (swrap && _speedCanvas) {
        _speedCanvas.width  = swrap.clientWidth  || 320;
        _speedCanvas.height = swrap.clientHeight || 150;
      }

      _drawPolar();
      _drawSpeed();
    } else {
      var ptWrap = document.getElementById('pt-canvas-wrap');
      if (ptWrap && _ptCanvas) {
        if (ptWrap.clientWidth === 0) { setTimeout(_resize, 60); return; }
        var pw = ptWrap.clientWidth  || 300;
        var ph = ptWrap.clientHeight || pw;
        var psz = Math.min(pw, ph);
        if (psz > 0) { _ptCanvas.width = psz; _ptCanvas.height = psz; }
      }
      _drawPhaseCircle();
    }
  }

  // ============================================================
  // harmToggle — bouton Start / Stop
  // ============================================================
  function harmToggle() {
    const go = typeof window.wsGoto === 'function' ? window.wsGoto : null;
    if (_running) {
      if (go) {
        go('harmonic', 'WS_GOTO=HARM_STOP', {
          onAck: () => setRunning(false),
          onTimeout: () => setRunning(false),
        });
      } else {
        wsSend('WS_GOTO=HARM_STOP');
        setRunning(false);
      }
    } else {
      if (go) {
        go('harmonic', 'WS_GOTO=ANAL_HARM', {
          onAck: () => setRunning(true),
          onTimeout: () => setRunning(false),
        });
      } else {
        wsSend('WS_GOTO=ANAL_HARM');
        setRunning(true);
      }
    }
  }

  // ============================================================
  // setRunning — met à jour l'état et le bouton
  // ============================================================
  function setRunning(on) {
    _running = on;
    _updateBtn();
  }

  function _updateBtn() {
    const btn = document.getElementById('btn-harm-toggle');
    if (!btn) return;
    if (_running) {
      btn.textContent = '◼ Stop';
      btn.classList.add('running');
      btn.classList.remove('btn-primary');
    } else {
      btn.textContent = '▶ Start';
      btn.classList.remove('running');
      btn.classList.add('btn-primary');
    }
  }

  // ============================================================
  // onHarmBinary — réception blob binaire depuis app.js
  // ============================================================
  function onHarmBinary(gRange, fs, rpm, n, samples) {
    if (!_running) setRunning(true);
    _rpm = rpm;
    _fs  = fs;

    // RPM dans la barre
    var rpmEl = document.getElementById('harm-rpm-val');
    var dotEl = document.getElementById('harm-rpm-dot');
    if (rpmEl) rpmEl.textContent = Math.round(rpm);
    if (dotEl) dotEl.className = rpm > 0 ? 'ok' : '';

    if (_phaseTrackingMode) {
      var pt = _phaseTracking(samples, gRange, fs, rpm, n);
      _updatePhaseTrackingDisplay(pt);
    } else {
      var result = _multiHarmonicDFT(samples, gRange, fs, rpm, n);
      _updateHarmonicDisplay(result);
    }
  }

  function _updateHarmonicDisplay(result) {
    _harmonics = result;
    _updateInfo();
    _drawPolar();
    _drawSpeed();
  }

  function _updatePhaseTrackingDisplay(pt) {
    _ptHasData = true;
    _ptPhase = pt.phase;
    _ptAmpG = pt.amp_g;
    _ptSatPct = pt.satPct;
    _ptIsSaturated = pt.isSaturated;
    _ptHistory.push({
      phase: _ptPhase,
      amp_g: _ptAmpG,
      satPct: _ptSatPct,
      isSaturated: _ptIsSaturated
    });
    if (_ptHistory.length > PT_HISTORY_SIZE) _ptHistory.shift();
    _drawPhaseCircle();
    _updatePhaseUI();
  }

  // ============================================================
  // _multiHarmonicDFT — DFT directe pour ordres 1X–10X
  // ============================================================
  function _multiHarmonicDFT(samples, gRange, fs, rpm, N) {
    const lsbPerG = 16384 / gRange;
    const fund    = rpm / 60;
    const MAX_ORDER = 10;

    let mean = 0;
    for (let i = 0; i < N; i++) mean += samples[i];
    mean /= N;

    const result = [];

    for (let h = 1; h <= MAX_ORDER; h++) {
      const freq = fund * h;
      if (freq >= fs / 2) break;

      let sumCos = 0, sumSin = 0;
      for (let n = 0; n < N; n++) {
        const val_g = (samples[n] - mean) / lsbPerG;
        const angle = 2 * Math.PI * freq * n / fs;
        sumCos += val_g * Math.cos(angle);
        sumSin += val_g * Math.sin(angle);
      }
      sumCos /= N;
      sumSin /= N;

      const amp_g = 2 * Math.sqrt(sumCos * sumCos + sumSin * sumSin);
      let phase   = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
      if (phase < 0) phase += 360;

      const vel = freq > 0 ? (amp_g * 9.81 * 1000) / (2 * Math.PI * freq) : 0;

      result.push({ order: h, amp_g, amp_pct: 0, phase, freq, vel });
    }

    if (result.length > 0 && result[0].amp_g > 0) {
      result[0].amp_pct = 100;
      for (let h = 1; h < result.length; h++) {
        result[h].amp_pct = result[h].amp_g / result[0].amp_g * 100;
      }
    }

    return result;
  }

  // ── INFO TEXTE ───────────────────────────────────────────────
  function _updateInfo() {
    const el = document.getElementById('harm-info');
    if (!el) return;
    if (_harmonics.length === 0) { el.textContent = '—'; return; }
    const disp = _harmonics.slice(0, 4);
    let html = '<b>RPM:</b> ' + Math.round(_rpm) +
               '  <b>Fs:</b> ' + Math.round(_fs) + ' Hz<br>';
    disp.forEach(h => {
      html += '<span class="hm-order-label" data-o="' + h.order + '">' +
              h.order + 'X</span> ' +
              h.amp_g.toFixed(3) + ' g  ' +
              h.vel.toFixed(1)   + ' mm/s  ' +
              '<span style="color:#666">@ ' + h.phase.toFixed(0) + '°</span>';
      if (h.order > 1) html += '  <span style="color:#888">(' + h.amp_pct.toFixed(0) + '%)</span>';
      html += '<br>';
    });
    el.innerHTML = html;
  }

  // ── GRAPHIQUE POLAIRE (1X) ───────────────────────────────────
  const HARM_COLORS = ['#1a6fc4', '#2a8a3e', '#c45a00', '#8e24aa'];

  function _drawPolar() {
    if (!_polarCtx || !_polarCanvas) return;
    const c = _polarCtx;
    const W = _polarCanvas.width, H = _polarCanvas.height;
    if (W === 0 || H === 0) return;

    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) * 0.38;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);

    const maxAmp = (_harmonics.length > 0 && _harmonics[0].amp_g > 0)
      ? _harmonics[0].amp_g * 1.25 : 0.1;

    [0.25, 0.5, 0.75, 1.0].forEach(f => {
      c.strokeStyle = f === 1.0 ? '#999' : '#ddd';
      c.setLineDash(f === 1.0 ? [] : [4, 5]);
      c.lineWidth   = f === 1.0 ? 1.2 : 0.8;
      c.beginPath(); c.arc(cx, cy, R * f, 0, 2 * Math.PI); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#aaa'; c.font = '8px "Courier New", monospace';
      c.textAlign = 'left';
      c.fillText((maxAmp * f).toFixed(3) + 'g', cx + R * f + 2, cy - 2);
    });

    c.strokeStyle = '#ccc'; c.lineWidth = 0.8;
    [[0,-1],[1,0],[0,1],[-1,0]].forEach(([dx, dy]) => {
      c.beginPath(); c.moveTo(cx, cy);
      c.lineTo(cx + dx * R * 1.06, cy + dy * R * 1.06); c.stroke();
    });

    c.fillStyle = '#666'; c.font = '10px "Courier New", monospace';
    c.textAlign = 'center'; c.fillText('0°',    cx,     cy - R - 10);
    c.textAlign = 'center'; c.fillText('180°',  cx,     cy + R + 13);
    c.textAlign = 'left';   c.fillText('90°',   cx+R+5, cy + 4);
    c.textAlign = 'right';  c.fillText('270°',  cx-R-5, cy + 4);

    c.beginPath(); c.arc(cx, cy, 3, 0, 2 * Math.PI);
    c.fillStyle = '#bbb'; c.fill();

    if (_harmonics.length === 0) {
      c.fillStyle = '#aaa'; c.font = '13px "Courier New", monospace';
      c.textAlign = 'center';
      c.fillText('En attente de données', cx, cy + 4);
      return;
    }

    const h1  = _harmonics[0];
    const col = HARM_COLORS[0];
    const ratio  = Math.min(h1.amp_g / maxAmp, 1.0);
    const rr     = ratio * R;
    const angRad = (h1.phase - 90) * Math.PI / 180;
    const px = cx + rr * Math.cos(angRad);
    const py = cy + rr * Math.sin(angRad);

    c.strokeStyle = col + '55'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(px, py); c.stroke();

    c.beginPath(); c.arc(px, py, 11, 0, 2 * Math.PI);
    c.strokeStyle = col + '44'; c.lineWidth = 1; c.stroke();

    c.beginPath(); c.arc(px, py, 7, 0, 2 * Math.PI);
    c.fillStyle = col; c.fill();

    c.fillStyle = col; c.font = 'bold 11px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText('1X', px + 10, py - 2);
    c.font = '9px "Courier New", monospace';
    c.fillStyle = col + 'bb';
    c.fillText(h1.phase.toFixed(0) + '°', px + 10, py + 9);

    c.fillStyle = col; c.font = '9px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText('1X: ' + h1.amp_g.toFixed(3) + 'g', W - 90, H - 20);
  }

  // ── SPEEDOMÈTRE — barres 1X–4X ──────────────────────────────
  function _drawSpeed() {
    if (!_speedCtx || !_speedCanvas) return;
    const c = _speedCtx;
    const W = _speedCanvas.width, H = _speedCanvas.height;
    if (W === 0 || H === 0) return;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#f8f8f8';
    c.fillRect(0, 0, W, H);

    const N = 4, padL = 10, padR = 10, padT = 22, padB = 30;
    const gW = W - padL - padR;
    const gH = H - padT - padB;
    const barW   = Math.floor(gW / N) - 4;
    const barGap = Math.floor(gW / N);

    c.fillStyle = '#444'; c.font = 'bold 11px Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('Amplitudes harmoniques', W / 2, 14);

    const disp = _harmonics.slice(0, 4);

    if (disp.length === 0) {
      c.fillStyle = '#aaa'; c.font = '12px Arial, sans-serif';
      c.textAlign = 'center'; c.fillText('—', W / 2, H / 2 + 10); return;
    }

    const maxAmp = Math.max(...disp.map(h => h.amp_g), 0.001);

    c.strokeStyle = '#ccc'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, padT + gH); c.lineTo(W - padR, padT + gH); c.stroke();

    for (let i = 0; i < N; i++) {
      const h   = disp[i];
      const col = HARM_COLORS[i] || '#bbb';
      const bx  = padL + i * barGap + Math.floor((barGap - barW) / 2);

      if (!h) {
        c.strokeStyle = '#ddd'; c.lineWidth = 1;
        c.strokeRect(bx, padT, barW, gH);
        c.fillStyle = '#ccc'; c.font = '10px Arial'; c.textAlign = 'center';
        c.fillText((i+1) + 'X', bx + barW / 2, padT + gH + 14);
        continue;
      }

      const ratio = Math.min(h.amp_g / maxAmp, 1.0);
      const bh    = Math.max(ratio * gH, 2);
      const by    = padT + gH - bh;

      const grad = c.createLinearGradient(0, by, 0, by + bh);
      grad.addColorStop(0, col); grad.addColorStop(1, col + '55');
      c.fillStyle = grad; c.fillRect(bx, by, barW, bh);
      c.strokeStyle = col + 'aa'; c.lineWidth = 1;
      c.strokeRect(bx, by, barW, bh);

      c.fillStyle = '#222'; c.font = 'bold 10px "Courier New", monospace';
      c.textAlign = 'center';
      const vy = by - 13;
      if (vy > padT) {
        c.fillText(h.amp_g.toFixed(3), bx + barW / 2, vy);
      } else {
        c.fillStyle = '#fff';
        c.fillText(h.amp_g.toFixed(3), bx + barW / 2, by + 12);
      }

      c.fillStyle = col; c.font = '9px "Courier New", monospace';
      c.textAlign = 'center';
      c.fillText(h.vel.toFixed(1) + ' mm/s', bx + barW / 2, padT + gH + 12);

      c.fillStyle = '#444'; c.font = 'bold 11px Arial'; c.textAlign = 'center';
      c.fillText((i+1) + 'X', bx + barW / 2, padT + gH + 24);

      if (bh > 18 && h.freq > 0) {
        c.fillStyle = '#ffffff99'; c.font = '8px "Courier New", monospace';
        c.textAlign = 'center';
        c.fillText(h.freq.toFixed(1) + 'Hz', bx + barW / 2, padT + gH - 4);
      }
    }
  }

  // ============================================================
  // _phaseTracking — DFT 1X sur samples non saturés
  // ============================================================
  function _phaseTracking(samples, gRange, fs, rpm, N) {
    var lsbPerG = 16384 / gRange;
    var fund    = rpm / 60;

    // Saturation
    var satCount = 0;
    for (var i = 0; i < N; i++) {
      if (Math.abs(samples[i]) >= PT_SAT_THRESHOLD) satCount++;
    }
    var halfPeriodSamples = fs / fund / 2;
    var satPct = Math.min((satCount / halfPeriodSamples) * 100, 100);
    var isSaturated = satPct >= PT_SAT_WARN_PCT;

    // DFT 1X sur samples non saturés
    var mean = 0, totalValid = 0;
    for (var i = 0; i < N; i++) {
      if (Math.abs(samples[i]) < PT_SAT_THRESHOLD) { mean += samples[i]; totalValid++; }
    }
    if (totalValid > 0) mean /= totalValid;

    var sumCos = 0, sumSin = 0, validCount = 0;
    for (var i = 0; i < N; i++) {
      if (Math.abs(samples[i]) >= PT_SAT_THRESHOLD) continue;
      var val_g = (samples[i] - mean) / lsbPerG;
      var angle = 2 * Math.PI * fund * i / fs;
      sumCos += val_g * Math.cos(angle);
      sumSin += val_g * Math.sin(angle);
      validCount++;
    }
    if (validCount > 0) { sumCos /= validCount; sumSin /= validCount; }

    var phase = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
    if (phase < 0) phase += 360;

    var amp_g = 0;
    if (!isSaturated && validCount > 0) {
      amp_g = 2 * Math.sqrt(sumCos * sumCos + sumSin * sumSin) * (N / validCount);
    }

    return { phase: phase, amp_g: amp_g, satPct: satPct, isSaturated: isSaturated };
  }

  // ============================================================
  // _drawPhaseCircle — cercle 360° avec flèche
  // ============================================================
  function _drawPhaseCircle() {
    if (!_ptCtx || !_ptCanvas) return;
    var c = _ptCtx;
    var W = _ptCanvas.width, H = _ptCanvas.height;
    if (W === 0 || H === 0) return;
    var cx = W / 2, cy = H / 2;
    var R  = Math.min(W, H) * 0.38;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);

    // Cercle principal
    c.strokeStyle = '#999'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(cx, cy, R, 0, 2 * Math.PI); c.stroke();

    // Graduations 30°
    for (var deg = 0; deg < 360; deg += 30) {
      var rad = (deg - 90) * Math.PI / 180;
      var isMajor = (deg % 90 === 0);
      var r1 = R * (isMajor ? 0.88 : 0.93);
      c.strokeStyle = isMajor ? '#888' : '#bbb';
      c.lineWidth = isMajor ? 1.2 : 0.7;
      c.beginPath();
      c.moveTo(cx + r1 * Math.cos(rad), cy + r1 * Math.sin(rad));
      c.lineTo(cx + R  * Math.cos(rad), cy + R  * Math.sin(rad));
      c.stroke();
    }

    // Labels cardinaux
    c.fillStyle = '#666'; c.font = '11px "Courier New", monospace';
    c.textAlign = 'center'; c.fillText('0°',    cx,     cy - R - 10);
    c.textAlign = 'center'; c.fillText('180°',  cx,     cy + R + 14);
    c.textAlign = 'left';   c.fillText('90°',   cx+R+6, cy + 4);
    c.textAlign = 'right';  c.fillText('270°',  cx-R-6, cy + 4);

    // Centre
    c.beginPath(); c.arc(cx, cy, 3, 0, 2 * Math.PI);
    c.fillStyle = '#ccc'; c.fill();

    if (!_ptHasData) {
      c.fillStyle = '#aaa'; c.font = '13px "Courier New", monospace';
      c.textAlign = 'center'; c.fillText('En attente...', cx, cy + 4);
      return;
    }

    var col = _ptIsSaturated ? '#c45a00' : '#1a6fc4';
    var angRad = (_ptPhase - 90) * Math.PI / 180;
    var tipX = cx + R * 0.85 * Math.cos(angRad);
    var tipY = cy + R * 0.85 * Math.sin(angRad);

    // Flèche
    c.strokeStyle = col; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(tipX, tipY); c.stroke();

    // Pointe
    var headLen = 10, headAng = 0.4;
    c.fillStyle = col; c.beginPath();
    c.moveTo(tipX, tipY);
    c.lineTo(tipX - headLen * Math.cos(angRad - headAng),
             tipY - headLen * Math.sin(angRad - headAng));
    c.lineTo(tipX - headLen * Math.cos(angRad + headAng),
             tipY - headLen * Math.sin(angRad + headAng));
    c.closePath(); c.fill();

    // Angle en grand au centre
    c.fillStyle = col; c.font = 'bold 32px "Courier New", monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(Math.round(_ptPhase) + '°', cx, cy);
    c.textBaseline = 'alphabetic';

    // Historique : traces légères des mesures précédentes
    for (var i = 0; i < _ptHistory.length - 1; i++) {
      var hp = _ptHistory[i];
      var hRad = (hp.phase - 90) * Math.PI / 180;
      var hx = cx + R * 0.7 * Math.cos(hRad);
      var hy = cy + R * 0.7 * Math.sin(hRad);
      var alpha = 0.15 + 0.1 * (i / PT_HISTORY_SIZE);
      c.beginPath(); c.arc(hx, hy, 3, 0, 2 * Math.PI);
      c.fillStyle = (hp.isSaturated ? 'rgba(196,90,0,' : 'rgba(26,111,196,') + alpha.toFixed(2) + ')';
      c.fill();
    }
  }

  // ============================================================
  // _updatePhaseUI — texte amplitude/saturation + historique
  // ============================================================
  function _updatePhaseUI() {
    var ampEl  = document.getElementById('pt-amp-line');
    var satEl  = document.getElementById('pt-sat-badge');
    var histEl = document.getElementById('pt-history');

    if (_ptHasData && ampEl) {
      if (_ptIsSaturated) {
        ampEl.innerHTML = '<span style="color:#c45a00;">Sat: ' +
          _ptSatPct.toFixed(0) + '%</span>';
      } else {
        ampEl.textContent = 'Amp: ' + _ptAmpG.toFixed(3) + ' g';
      }
    }

    if (satEl) {
      if (_ptHasData && _ptIsSaturated) {
        satEl.textContent = 'SAT ' + _ptSatPct.toFixed(0) + '%';
        satEl.style.display = '';
      } else {
        satEl.style.display = 'none';
      }
    }

    if (histEl) {
      var html = '';
      for (var i = 0; i < _ptHistory.length; i++) {
        var h = _ptHistory[i];
        var isLast = (i === _ptHistory.length - 1);
        var cls = 'pt-hist-entry' + (isLast ? ' pt-latest' : '') + (h.isSaturated ? ' pt-sat' : '');
        var val = h.isSaturated
          ? (Math.round(h.phase) + '° ' + h.satPct.toFixed(0) + '%')
          : (Math.round(h.phase) + '° ' + h.amp_g.toFixed(2) + 'g');
        html += '<span class="' + cls + '">' + val + '</span>';
      }
      histEl.innerHTML = html || '—';
    }
  }

  // ============================================================
  // switchView — bascule entre 'classic' et 'phase'
  // ============================================================
  function switchView(view) {
    _phaseTrackingMode = (view === 'phase');
    var classicEl = document.getElementById('harm-classic-view');
    var phaseEl   = document.getElementById('harm-phase-view');
    var btnC = document.getElementById('btn-harm-view-classic');
    var btnP = document.getElementById('btn-harm-view-phase');

    if (classicEl) classicEl.style.display = view === 'classic' ? 'flex' : 'none';
    if (phaseEl)   phaseEl.style.display   = view === 'phase'   ? 'flex' : 'none';
    if (btnC) btnC.classList.toggle('harm-view-active', view === 'classic');
    if (btnP) btnP.classList.toggle('harm-view-active', view === 'phase');

    _applyCanvasVisibility();
    setTimeout(_resize, 30);
  }

  // onData — compatibilité
  function onData(line) {}

  function resize()  { _resize(); }
  function getRPM()  { return _rpm; }

  return { init, onData, onHarmBinary, resize, getRPM, setRunning, harmToggle, switchView };
})();
