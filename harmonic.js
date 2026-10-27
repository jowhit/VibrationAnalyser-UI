// ═══════════════════════════════════════════════════════════════
// harmonic.js  —  Onglet Harmonique
// Architecture : ESP32 envoie HARM_BIN (binaire brut)
// JS fait : DFT multi-harmoniques → polaire + speedomètre
//
// Start/Stop : PhaseSession (phase-session.js) — entrée unique Terminal.
//   Start → WS_GOTO=ANAL_HARM → ESP boucle HARM_BIN
//   Stop  → WS_GOTO=HARM_STOP → dernière trame gelée (VIEW)
// ═══════════════════════════════════════════════════════════════

const HarmonicModule = (() => {

  // Canaux A/B : même structure (pas de chemin « mono + patch B »).
  // _dualSession = true dès le Start en mode DOUBLE → UI A+B immédiate.
  // > cycle estimation+sync+acq (~2–3 s) ; 1.5 s trop court → RPM clignote à 0
  const HARM_TACH_STALE_MS = 5000;
  const HARM_COL_A = '#0033cc';
  const HARM_COL_B = '#e67e22';

  let _harmonics  = [];
  let _harmonicsB = [];
  let _rpm        = 0;
  let _rpmB       = 0;
  let _fs         = 0;
  let _running    = false;
  let _dualSession = false;
  let _lastFrameMs = 0;
  let _staleTimer  = null;

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
  let _ptHasDataB = false;
  let _ptPhaseB = 0;
  let _ptAmpGB = 0;
  let _ptIsSaturatedB = false;

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
    if (btn) {
      btn.addEventListener('click', function () {
        if (typeof PhaseSession !== 'undefined' && PhaseSession.toggle) PhaseSession.toggle();
        else harmToggle();
      });
    }

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
  // Session dual / tach stale / start-stop symétrique
  // ============================================================
  function _harmDualAvailable() {
    if (typeof DualSession !== 'undefined') return DualSession.available();
    return (typeof isDualMode === 'function' && isDualMode() && typeof wsSendB === 'function');
  }

  /** UI dual = session lancée en DOUBLE (pas « B a déjà envoyé une trame »). */
  function _isDualUi() {
    return _dualSession || (typeof DualSession !== 'undefined' && DualSession.is());
  }

  function _clearLiveData() {
    _harmonics = [];
    _harmonicsB = [];
    _rpm = 0;
    _rpmB = 0;
    _ptHasData = false;
    _ptHasDataB = false;
    _ptPhase = 0;
    _ptPhaseB = 0;
    _ptAmpG = 0;
    _ptAmpGB = 0;
    _ptIsSaturated = false;
    _ptIsSaturatedB = false;
    _ptHistory = [];
  }

  function _noteFrame() {
    _lastFrameMs = Date.now();
  }

  function _stopStaleWatch() {
    if (_staleTimer) {
      clearInterval(_staleTimer);
      _staleTimer = null;
    }
  }

  function _startStaleWatch() {
    _stopStaleWatch();
    _lastFrameMs = Date.now();
    _staleTimer = setInterval(function () {
      if (!_running) return;
      if (!_lastFrameMs) return;
      if (Date.now() - _lastFrameMs < HARM_TACH_STALE_MS) return;
      // Perte tach / plus de trames : RPM=0 + graphiques tombent (spec 1.5 s)
      _rpm = 0;
      _rpmB = 0;
      _harmonics = [];
      _harmonicsB = [];
      _ptHasData = false;
      _ptHasDataB = false;
      _harmUpdateRpmBar();
      if (_phaseTrackingMode) {
        _drawPhaseCircle();
        _updatePhaseUI();
      } else {
        _updateInfo();
        _drawPolar();
        _drawSpeed();
      }
    }, 250);
  }

  function _startBothEsp() {
    _dualSession = (typeof DualSession !== 'undefined')
      ? DualSession.begin()
      : _harmDualAvailable();
    // Nouveau Start : efface le gel précédent
    _clearLiveData();
    _harmUpdateRpmBar();
    _drawPolar();
    _drawSpeed();
    // GOTO B géré par DualSession.startModule / harmToggle — pas de double envoi ici
  }

  /** Menu / DualSession : A+B prêts (NAV_ACK des deux). */
  function onDualReady(dual) {
    _dualSession = !!dual;
    if (_dualSession && typeof DualSession !== 'undefined') DualSession.begin();
    _clearLiveData();
    // Ne PAS setRunning(true) ici : sinon bouton rouge « Arrêter » alors
    // qu’aucune trame n’arrive encore (estimation RPM / pas de tach).
    // La 1ʳᵉ HARM_BIN dans onHarmBinary* appelle setRunning(true).
    setRunning(false);
    _harmUpdateRpmBar();
    _drawPolar();
    _drawSpeed();
    if (_phaseTrackingMode) {
      _drawPhaseCircle();
      _updatePhaseUI();
    }
  }

  function abortStart() {
    _abortSession();
  }

  /** Stop = pause : garde polaire / phase / RPM affichés. Appelé par PhaseSession.stop. */
  function pauseSession() {
    _stopStaleWatch();
    // Ne pas _clearLiveData — gel de la dernière trame (mono et duo)
    if (typeof DualSession !== 'undefined') DualSession.end();
    _running = false;
    _harmUpdateRpmBar();
    _updateInfo();
    _drawPolar();
    _drawSpeed();
    if (_phaseTrackingMode) {
      _drawPhaseCircle();
      _updatePhaseUI();
    }
  }

  /** Abandon (timeout / leave) : tout effacer. */
  function _abortSession() {
    _stopStaleWatch();
    _clearLiveData();
    _dualSession = false;
    if (typeof DualSession !== 'undefined') DualSession.end();
    _running = false;
    _harmUpdateRpmBar();
    _updateInfo();
    _drawPolar();
    _drawSpeed();
    if (_phaseTrackingMode) {
      _drawPhaseCircle();
      _updatePhaseUI();
    }
  }

  /** @deprecated — passer par PhaseSession.toggle() */
  function harmToggle() {
    if (typeof PhaseSession !== 'undefined' && PhaseSession.toggle) {
      PhaseSession.toggle();
      return;
    }
  }

  // ============================================================
  // setRunning — flag live + stale-watch (bouton = PhaseSession)
  // ============================================================
  function setRunning(on) {
    _running = on;
    // Stale-watch seulement après 1ʳᵉ trame (estimation RPM peut > 1.5 s)
    if (!on) _stopStaleWatch();
    if (typeof PhaseSession === 'undefined') _updateBtn();
  }

  /** @deprecated — préférer DualSession.startModule + onDualReady */
  function beginFromMenu() {
    onDualReady((typeof DualSession !== 'undefined') && DualSession.available());
  }

  function _updateBtn() {
    const btn = document.getElementById('btn-harm-toggle');
    if (!btn) return;
    if (_running) {
      btn.textContent = (typeof t === 'function') ? t('common.stop') : '◼ Arrêter';
      btn.classList.add('bal-btn-stop');
      btn.classList.remove('bal-btn-run');
    } else {
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
    }
  }

  // ============================================================
  // onHarmBinary — réception blob binaire depuis app.js
  // ============================================================
  function _harmUpdateRpmBar() {
    var rpmEl = document.getElementById('harm-rpm-val');
    var dotEl = document.getElementById('harm-rpm-dot');
    // Tach commun : une seule valeur ; 0 si perdu
    var rpmShow = Math.max(_rpm || 0, _rpmB || 0);
    if (rpmEl) rpmEl.textContent = String(Math.round(rpmShow || 0));
    if (dotEl) {
      dotEl.className = 'bal-rpm-dot ' + (rpmShow > 0 ? 'bal-rpm-dot--ok' : 'bal-rpm-dot--lost');
    }
  }

  function onHarmBinary(gRange, fs, rpm, n, samples) {
    if (typeof PhaseSession !== 'undefined' && PhaseSession.onFrame) PhaseSession.onFrame();
    if (!_running) setRunning(true);
    if (!_staleTimer) _startStaleWatch();
    _noteFrame();
    _rpm = (typeof rpm === 'number' && isFinite(rpm)) ? rpm : 0;
    _fs  = fs;
    _harmUpdateRpmBar();

    if (_phaseTrackingMode) {
      var pt = _phaseTracking(samples, gRange, fs, rpm, n);
      _updatePhaseTrackingDisplay(pt, false);
    } else {
      _harmonics = _multiHarmonicDFT(samples, gRange, fs, rpm, n);
      _updateInfo();
      _drawPolar();
      _drawSpeed();
    }
  }

  function onHarmBinaryB(gRange, fs, rpm, n, samples) {
    if (!_dualSession) return; // ignore B hors session DOUBLE
    if (typeof PhaseSession !== 'undefined' && PhaseSession.onFrame) PhaseSession.onFrame();
    if (!_running) setRunning(true);
    if (!_staleTimer) _startStaleWatch();
    _noteFrame();
    _rpmB = (typeof rpm === 'number' && isFinite(rpm)) ? rpm : 0;
    if (!_fs) _fs = fs;
    _harmUpdateRpmBar();

    if (_phaseTrackingMode) {
      var pt = _phaseTracking(samples, gRange, fs, rpm, n);
      _updatePhaseTrackingDisplay(pt, true);
    } else {
      _harmonicsB = _multiHarmonicDFT(samples, gRange, fs, rpm, n);
      _updateInfo();
      _drawPolar();
      _drawSpeed();
    }
  }

  function _updatePhaseTrackingDisplay(pt, isB) {
    if (isB) {
      _ptHasDataB = true;
      _ptPhaseB = pt.phase;
      _ptAmpGB = pt.amp_g;
      _ptIsSaturatedB = pt.isSaturated;
    } else {
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
    }
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
    if (_harmonics.length === 0 && _harmonicsB.length === 0) {
      el.textContent = '—'; return;
    }
    let html = '<b>RPM:</b> ' + Math.round(_rpm || _rpmB || 0) +
               '  <b>Fs:</b> ' + Math.round(_fs) + ' Hz';
    if (_isDualUi()) html += '  <b style="color:' + HARM_COL_B + '">DOUBLE</b>';
    html += '<br>';
    function _line(tag, col, h) {
      if (!h) return '';
      return '<span style="color:' + col + ';font-weight:bold">' + tag + '</span> ' +
        h.order + 'X  ' + h.amp_g.toFixed(3) + ' g  ' + h.vel.toFixed(1) + ' mm/s  ' +
        '<span style="color:#666">@ ' + h.phase.toFixed(0) + '°</span><br>';
    }
    if (_harmonics[0]) html += _line('A', HARM_COL_A, _harmonics[0]);
    else if (_isDualUi()) html += '<span style="color:' + HARM_COL_A + '">A …</span><br>';
    if (_harmonicsB[0]) html += _line('B', HARM_COL_B, _harmonicsB[0]);
    else if (_isDualUi()) html += '<span style="color:' + HARM_COL_B + '">B …</span><br>';
    if (_harmonics[0] && _harmonicsB[0]) {
      let dph = _harmonicsB[0].phase - _harmonics[0].phase;
      while (dph > 180) dph -= 360;
      while (dph < -180) dph += 360;
      html += '<span style="color:#555">Δφ B−A: ' + dph.toFixed(0) + '°</span><br>';
    }
    const disp = _harmonics.slice(1, 4);
    disp.forEach(h => {
      html += h.order + 'X A  ' + h.amp_g.toFixed(3) + ' g  (' + h.amp_pct.toFixed(0) + '%)<br>';
    });
    el.innerHTML = html;
  }

  // ── GRAPHIQUE POLAIRE (1X A + B) ─────────────────────────────
  const HARM_COLORS = ['#1a6fc4', '#2a8a3e', '#c45a00', '#8e24aa'];

  function _drawPolarPhasor(c, cx, cy, R, maxAmp, h, col, label) {
    if (!h || !(h.amp_g > 0)) return;
    const ratio = Math.min(h.amp_g / maxAmp, 1.0);
    const rr = ratio * R;
    const angRad = (h.phase - 90) * Math.PI / 180;
    const px = cx + rr * Math.cos(angRad);
    const py = cy + rr * Math.sin(angRad);
    c.strokeStyle = col; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(px, py); c.stroke();
    c.beginPath(); c.arc(px, py, 7, 0, 2 * Math.PI);
    c.fillStyle = col; c.fill();
    c.fillStyle = col; c.font = 'bold 11px "Courier New", monospace';
    c.textAlign = 'left';
    c.fillText(label, px + 10, py - 2);
    c.font = '9px "Courier New", monospace';
    c.fillText(h.phase.toFixed(0) + '°', px + 10, py + 9);
  }

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

    let maxAmp = 0.1;
    if (_harmonics[0] && _harmonics[0].amp_g > maxAmp) maxAmp = _harmonics[0].amp_g;
    if (_harmonicsB[0] && _harmonicsB[0].amp_g > maxAmp) maxAmp = _harmonicsB[0].amp_g;
    maxAmp *= 1.25;

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

    if (_harmonics.length === 0 && _harmonicsB.length === 0) {
      c.fillStyle = '#aaa'; c.font = '13px "Courier New", monospace';
      c.textAlign = 'center';
      c.fillText('En attente de données', cx, cy + 4);
      return;
    }

    _drawPolarPhasor(c, cx, cy, R, maxAmp, _harmonics[0], HARM_COL_A, 'A');
    _drawPolarPhasor(c, cx, cy, R, maxAmp, _harmonicsB[0], HARM_COL_B, 'B');

    c.font = '9px "Courier New", monospace';
    c.textAlign = 'left';
    if (_harmonics[0]) {
      c.fillStyle = HARM_COL_A;
      c.fillText('A 1X: ' + _harmonics[0].amp_g.toFixed(3) + 'g', 8, H - 20);
    } else if (_isDualUi()) {
      c.fillStyle = HARM_COL_A;
      c.fillText('A …', 8, H - 20);
    }
    if (_harmonicsB[0]) {
      c.fillStyle = HARM_COL_B;
      c.fillText('B 1X: ' + _harmonicsB[0].amp_g.toFixed(3) + 'g', 8, H - 8);
    } else if (_isDualUi()) {
      c.fillStyle = HARM_COL_B;
      c.fillText('B …', 8, H - 8);
    }
  }

  // ── SPEEDOMÈTRE — barres 1X–4X (A plein / B orange à côté) ──
  function _drawSpeed() {
    if (!_speedCtx || !_speedCanvas) return;
    const c = _speedCtx;
    const W = _speedCanvas.width, H = _speedCanvas.height;
    if (W === 0 || H === 0) return;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#f8f8f8';
    c.fillRect(0, 0, W, H);

    const dual = _isDualUi();
    const N = 4, padL = 10, padR = 10, padT = 22, padB = 30;
    const gW = W - padL - padR;
    const gH = H - padT - padB;
    const slot = Math.floor(gW / N);
    const barW = dual ? Math.floor(slot / 2) - 3 : Math.floor(slot) - 4;

    c.fillStyle = '#444'; c.font = 'bold 11px Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText(dual ? 'Amplitudes A / B' : 'Amplitudes harmoniques', W / 2, 14);

    const dispA = _harmonics.slice(0, 4);
    const dispB = _harmonicsB.slice(0, 4);
    if (dispA.length === 0 && dispB.length === 0) {
      c.fillStyle = '#aaa'; c.font = '12px Arial, sans-serif';
      c.textAlign = 'center'; c.fillText('—', W / 2, H / 2 + 10); return;
    }

    let maxAmp = 0.001;
    dispA.forEach(h => { if (h && h.amp_g > maxAmp) maxAmp = h.amp_g; });
    dispB.forEach(h => { if (h && h.amp_g > maxAmp) maxAmp = h.amp_g; });

    c.strokeStyle = '#ccc'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, padT + gH); c.lineTo(W - padR, padT + gH); c.stroke();

    function _bar(h, bx, col) {
      if (!h) {
        c.strokeStyle = '#ddd'; c.lineWidth = 1;
        c.strokeRect(bx, padT, barW, gH);
        return;
      }
      const ratio = Math.min(h.amp_g / maxAmp, 1.0);
      const bh = Math.max(ratio * gH, 2);
      const by = padT + gH - bh;
      c.fillStyle = col; c.fillRect(bx, by, barW, bh);
      c.strokeStyle = col; c.lineWidth = 1; c.strokeRect(bx, by, barW, bh);
      c.fillStyle = '#222'; c.font = 'bold 9px "Courier New", monospace';
      c.textAlign = 'center';
      if (by - 11 > padT) c.fillText(h.amp_g.toFixed(2), bx + barW / 2, by - 3);
    }

    for (let i = 0; i < N; i++) {
      const base = padL + i * slot + Math.floor((slot - (dual ? barW * 2 + 2 : barW)) / 2);
      _bar(dispA[i], base, HARM_COL_A);
      if (dual) _bar(dispB[i], base + barW + 2, HARM_COL_B);
      c.fillStyle = '#444'; c.font = 'bold 11px Arial'; c.textAlign = 'center';
      c.fillText((i + 1) + 'X', padL + i * slot + slot / 2, padT + gH + 20);
    }
  }

  // ============================================================
  // _phaseTracking — DFT 1X sur samples non saturés
  // ============================================================
  function _phaseTracking(samples, gRange, fs, rpm, N) {
    var lsbPerG = 16384 / gRange;
    var fund    = (rpm > 0) ? (rpm / 60) : 0;

    // Saturation
    var satCount = 0;
    for (var i = 0; i < N; i++) {
      if (Math.abs(samples[i]) >= PT_SAT_THRESHOLD) satCount++;
    }
    var halfPeriodSamples = (fund > 0) ? (fs / fund / 2) : N;
    if (!(halfPeriodSamples > 0)) halfPeriodSamples = N;
    var satPct = Math.min((satCount / halfPeriodSamples) * 100, 100);
    var isSaturated = satPct >= PT_SAT_WARN_PCT;

    if (!(fund > 0) || !(fs > 0) || !(N > 1)) {
      return { phase: 0, amp_g: 0, satPct: satPct, isSaturated: isSaturated };
    }

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

    if (!_ptHasData && !_ptHasDataB) {
      c.fillStyle = '#aaa'; c.font = '13px "Courier New", monospace';
      c.textAlign = 'center'; c.fillText('En attente...', cx, cy + 4);
      return;
    }

    function _arrow(phase, col, sat) {
      var useCol = sat ? '#c45a00' : col;
      var angRad = (phase - 90) * Math.PI / 180;
      var tipX = cx + R * 0.85 * Math.cos(angRad);
      var tipY = cy + R * 0.85 * Math.sin(angRad);
      c.strokeStyle = useCol; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(tipX, tipY); c.stroke();
      var headLen = 10, headAng = 0.4;
      c.fillStyle = useCol; c.beginPath();
      c.moveTo(tipX, tipY);
      c.lineTo(tipX - headLen * Math.cos(angRad - headAng),
               tipY - headLen * Math.sin(angRad - headAng));
      c.lineTo(tipX - headLen * Math.cos(angRad + headAng),
               tipY - headLen * Math.sin(angRad + headAng));
      c.closePath(); c.fill();
    }

    if (_ptHasData) _arrow(_ptPhase, HARM_COL_A, _ptIsSaturated);
    if (_ptHasDataB) _arrow(_ptPhaseB, HARM_COL_B, _ptIsSaturatedB);

    // Angle A (et B si dual) au centre
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (_ptHasData && _ptHasDataB) {
      c.fillStyle = HARM_COL_A; c.font = 'bold 18px "Courier New", monospace';
      c.fillText('A ' + Math.round(_ptPhase) + '°', cx, cy - 12);
      c.fillStyle = HARM_COL_B; c.font = 'bold 18px "Courier New", monospace';
      c.fillText('B ' + Math.round(_ptPhaseB) + '°', cx, cy + 14);
    } else if (_ptHasData) {
      c.fillStyle = HARM_COL_A; c.font = 'bold 32px "Courier New", monospace';
      c.fillText(Math.round(_ptPhase) + '°', cx, cy);
    } else {
      c.fillStyle = HARM_COL_B; c.font = 'bold 32px "Courier New", monospace';
      c.fillText(Math.round(_ptPhaseB) + '°', cx, cy);
    }
    c.textBaseline = 'alphabetic';
    // Pas de trace historique sur le cercle — flèche nette uniquement
  }

  // ============================================================
  // _updatePhaseUI — texte amplitude/saturation + historique
  // ============================================================
  function _updatePhaseUI() {
    var ampEl  = document.getElementById('pt-amp-line');
    var satEl  = document.getElementById('pt-sat-badge');
    var histEl = document.getElementById('pt-history');
    _harmUpdateRpmBar();

    if ((_ptHasData || _ptHasDataB) && ampEl) {
      var parts = [];
      var rpmShow = Math.round(Math.max(_rpm || 0, _rpmB || 0));
      parts.push('<b>RPM</b> ' + rpmShow);
      if (_ptHasData) {
        parts.push(_ptIsSaturated
          ? '<span style="color:#c45a00;">A Sat ' + _ptSatPct.toFixed(0) + '%</span>'
          : '<span style="color:' + HARM_COL_A + '">A ' + _ptAmpG.toFixed(3) + ' g</span>');
      }
      if (_ptHasDataB) {
        parts.push(_ptIsSaturatedB
          ? '<span style="color:#c45a00;">B Sat</span>'
          : '<span style="color:' + HARM_COL_B + '">B ' + _ptAmpGB.toFixed(3) + ' g</span>');
      }
      ampEl.innerHTML = parts.join('  |  ');
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
    if (btnC) btnC.classList.toggle('bal-mode-toggle--active', view === 'classic');
    if (btnP) btnP.classList.toggle('bal-mode-toggle--active', view === 'phase');

    _harmUpdateRpmBar();
    if (_phaseTrackingMode) _updatePhaseUI();
    _applyCanvasVisibility();
    setTimeout(_resize, 30);
  }

  // onData — compatibilité
  function onData(line) {}

  function resize()  { _resize(); }
  function getRPM()  { return _rpm; }

  return {
    init, onData, onHarmBinary, onHarmBinaryB,
    resize, getRPM, setRunning, beginFromMenu, onDualReady, abortStart,
    pauseSession, harmToggle, switchView,
  };
})();
