// sync-session.js — SM Analyse synchrone TSA (mono A / mono B / duo AB)
// IDLE → READY → ACQUIRING → FINALIZE → VIEW ↔ ORDER_FFT
//                                          └→ HANDOFF (Brut | TSA | Résiduel → AnalSession)

const SyncSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    ACQUIRING: 'ACQUIRING',
    FINALIZE: 'FINALIZE',
    VIEW: 'VIEW',
    ORDER_FFT: 'ORDER_FFT',
    HANDOFF: 'HANDOFF',
  };

  const ACQ_TIMEOUT_MS = 120000;
  const FINALIZE_TIMEOUT_MS = 45000;

  let _state = S.IDLE;
  let _dual = false;
  let _binA = false;
  let _binB = false;
  let _acqTimer = null;
  let _finalizeTimer = null;
  let _handoffKind = null; // 'brut' | 'tsa' | 'res'

  let _ovRaf = null;
  let _ovStartMs = 0;
  let _ovDurMs = 8000;
  let _ovTransfer = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _isDualWanted() {
    if (typeof DualSession !== 'undefined' && DualSession.available) {
      return DualSession.available();
    }
    if (typeof isDualMode === 'function') return isDualMode();
    return false;
  }

  function _sendSync(cmd) {
    const dual = _dual ||
      (typeof DualSession !== 'undefined' && DualSession.available && DualSession.available());
    if (dual) {
      if (typeof DualSession !== 'undefined' && DualSession.begin) DualSession.begin();
      if (typeof DualSession !== 'undefined' && DualSession.sendBoth) {
        DualSession.sendBoth(cmd);
      } else {
        if (typeof wsSend === 'function') wsSend(cmd);
        if (typeof wsSendB === 'function') wsSendB(cmd);
      }
    } else if (typeof DualSession !== 'undefined' && DualSession.sendBoth) {
      DualSession.sendBoth(cmd);
    } else if (typeof wsSend === 'function') {
      wsSend(cmd);
    }
  }

  function _clearAcqTimer() {
    if (_acqTimer) { clearTimeout(_acqTimer); _acqTimer = null; }
  }

  function _clearFinalizeTimer() {
    if (_finalizeTimer) { clearTimeout(_finalizeTimer); _finalizeTimer = null; }
  }

  function _setBtnRunning(on) {
    const btn = document.getElementById('btn-sync-toggle');
    if (!btn) return;
    if (on) {
      btn.textContent = (typeof t === 'function') ? t('common.stop') : '◼ Arrêter';
      btn.classList.add('bal-btn-stop');
      btn.classList.remove('bal-btn-run');
      btn.disabled = true;
    } else {
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
      btn.disabled = false;
    }
  }

  function _ovDraw(progress) {
    const canvas = document.getElementById('sync-acq-ring');
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

    if (_ovTransfer) {
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
    }

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

  function _ovAnimFrame() {
    if (!_ovRaf && !_ovStartMs) return;
    const elapsed = Date.now() - _ovStartMs;
    const progress = _ovTransfer ? 1 : Math.min(1, elapsed / _ovDurMs);
    _ovDraw(progress);
    _ovRaf = requestAnimationFrame(_ovAnimFrame);
  }

  function _ovShow() {
    const ov = document.getElementById('sync-acq-overlay');
    if (ov) {
      ov.style.display = 'flex';
      ov.setAttribute('aria-hidden', 'false');
    }
    _ovTransfer = false;
    _ovStartMs = Date.now();
    const timing = (typeof SyncModule !== 'undefined' && SyncModule.getAcqTiming)
      ? SyncModule.getAcqTiming() : null;
    _ovDurMs = timing && timing.fs > 0 && timing.n > 0
      ? Math.max(1500, (timing.n / timing.fs) * 1000)
      : 8000;
    if (_ovRaf) cancelAnimationFrame(_ovRaf);
    _ovRaf = requestAnimationFrame(_ovAnimFrame);
  }

  function _ovHide() {
    if (_ovRaf) { cancelAnimationFrame(_ovRaf); _ovRaf = null; }
    _ovStartMs = 0;
    _ovTransfer = false;
    const ov = document.getElementById('sync-acq-overlay');
    if (ov) {
      ov.style.display = 'none';
      ov.setAttribute('aria-hidden', 'true');
    }
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isActive() {
    return _state !== S.IDLE;
  }

  function _setViewChrome(ok) {
    const fftBtn = document.getElementById('btn-sync-fft');
    if (fftBtn) {
      fftBtn.style.display = ok ? 'inline-block' : 'none';
      fftBtn.textContent = (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
    }
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (shapeBtn) shapeBtn.style.display = ok ? 'inline-block' : 'none';
    const anRow = document.getElementById('sync-analyse-row');
    if (anRow) anRow.style.display = ok ? 'flex' : 'none';
  }

  function reset(silent) {
    _clearAcqTimer();
    _clearFinalizeTimer();
    _ovHide();
    _state = S.IDLE;
    _dual = false;
    _binA = _binB = false;
    _handoffKind = null;
    if (typeof SyncModule !== 'undefined') {
      if (SyncModule.setDual) SyncModule.setDual(false);
      SyncModule.clearResult();
      SyncModule.showTrace();
    }
    _setBtnRunning(false);
    _setViewChrome(false);
    if (!silent) _log('[SYNC] reset → IDLE');
  }

  function enter() {
    if (_state === S.READY || _state === S.ACQUIRING) {
      if (_isDualWanted() && typeof DualSession !== 'undefined') {
        DualSession.begin();
        _dual = DualSession.is() || DualSession.available();
        if (typeof SyncModule !== 'undefined' && SyncModule.setDual) {
          SyncModule.setDual(_dual);
        }
      }
      return;
    }
    reset(true);
    _dual = _isDualWanted();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined')
      ? (DualSession.is() || DualSession.available())
      : _dual;

    if (typeof SyncModule !== 'undefined') {
      if (SyncModule.setDual) SyncModule.setDual(_dual);
      SyncModule.clearResult();
      SyncModule.showTrace();
      SyncModule.setStatus(_dual
        ? 'Mode DOUBLE prêt — Démarrer (A+B)'
        : ((typeof t === 'function') ? t('sync.ready') : 'Prêt — Démarrer'));
    }
    _binA = _binB = false;
    _setBtnRunning(false);
    _state = S.READY;
    if (typeof showTab === 'function') showTab('sync');
    _log('[SYNC] ' + (_dual ? 'DOUBLE ' : '') + 'READY');
  }

  function _start() {
    _ovHide();
    _clearFinalizeTimer();
    _handoffKind = null;
    _dual = _isDualWanted();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined')
      ? (DualSession.is() || DualSession.available())
      : _dual;
    _binA = _binB = false;

    if (typeof SyncModule !== 'undefined') {
      if (SyncModule.setDual) SyncModule.setDual(_dual);
      SyncModule.clearResult();
      SyncModule.showTrace();
      SyncModule.setStatus(_dual
        ? 'Acquisition A+B…'
        : ((typeof t === 'function') ? t('sync.acquiring') : 'Acquisition…'));
    }
    _sendSync('SYNC_START\n');
    _state = S.ACQUIRING;
    _setBtnRunning(true);
    _ovShow();
    _clearAcqTimer();
    _acqTimer = setTimeout(function () {
      _acqTimer = null;
      if (_state !== S.ACQUIRING && _state !== S.FINALIZE) return;
      _ovHide();
      _clearFinalizeTimer();
      _log('[SYNC] !! timeout — pas de payload');
      _state = S.READY;
      _setBtnRunning(false);
      if (typeof SyncModule !== 'undefined') {
        SyncModule.setStatus('Timeout — réessayer Démarrer');
      }
    }, ACQ_TIMEOUT_MS);
    _log('[SYNC] ACQUIRING' + (_dual ? ' A+B' : ''));
  }

  function toggleStart() {
    if (_state === S.ACQUIRING || _state === S.FINALIZE) return;
    if (_state === S.READY || _state === S.VIEW || _state === S.ORDER_FFT ||
        _state === S.HANDOFF || _state === S.IDLE) {
      if (_state === S.IDLE) enter();
      _start();
    }
  }

  function _doFinalize() {
    _clearAcqTimer();
    _clearFinalizeTimer();
    _ovHide();
    let ok = false;
    if (typeof SyncModule !== 'undefined' && SyncModule.finalizeFromRaw) {
      ok = SyncModule.finalizeFromRaw();
    }
    _state = S.VIEW;
    _handoffKind = null;
    _setBtnRunning(false);
    _setViewChrome(ok);
    if (typeof showTab === 'function') showTab('sync');
    _log('[SYNC] VIEW' + (ok ? '' : ' (peu de tours)') + (_dual ? ' (dual)' : ''));
  }

  function _tryFinalize() {
    if (_state === S.ACQUIRING) {
      _state = S.FINALIZE;
      _ovTransfer = true;
      _clearFinalizeTimer();
      _finalizeTimer = setTimeout(function () {
        _finalizeTimer = null;
        if (_state !== S.FINALIZE) return;
        _log('[SYNC] !! timeout FINALIZE' +
          (_dual ? (' A=' + (_binA ? 'ok' : '?') + ' B=' + (_binB ? 'ok' : '?')) : ''));
        _doFinalize();
      }, FINALIZE_TIMEOUT_MS);
    }
    if (_state !== S.FINALIZE && _state !== S.ACQUIRING) {
      _state = S.FINALIZE;
    }
    if (_dual) {
      if (!_binA || !_binB) return;
      _log('[SYNC] OK — A+B reçus');
    } else if (!_binA) {
      return;
    }
    _doFinalize();
  }

  function onPayloadReady() {
    _binA = true;
    if (_dual) _log('[SYNC] A reçu' + (_binB ? ' — OK' : ' — attente B…'));
    _tryFinalize();
  }

  function onPayloadReadyB() {
    if (!_dual) return;
    _binB = true;
    _log('[SYNC] B reçu' + (_binA ? ' — OK' : ' — attente A…'));
    _tryFinalize();
  }

  function onStatus(txt) {
    if (typeof SyncModule !== 'undefined' && SyncModule.setStatus) {
      SyncModule.setStatus(txt);
    }
    if (/^Pret/i.test(String(txt || '')) &&
        (_state === S.ACQUIRING || _state === S.FINALIZE) &&
        !_binA && !_binB) {
      _clearAcqTimer();
      _clearFinalizeTimer();
      _ovHide();
      if (_state !== S.VIEW && _state !== S.HANDOFF) {
        _state = S.READY;
        _setBtnRunning(false);
      }
    }
  }

  function _exportForKind(kind) {
    if (typeof SyncModule === 'undefined') return null;
    if (kind === 'brut') return SyncModule.exportBrut ? SyncModule.exportBrut() : null;
    if (kind === 'tsa') return SyncModule.exportTsa ? SyncModule.exportTsa() : null;
    if (kind === 'res') return SyncModule.exportResidual ? SyncModule.exportResidual() : null;
    return null;
  }

  /**
   * VIEW | ORDER_FFT | HANDOFF → HANDOFF.
   * kind = 'brut' | 'tsa' | 'res'
   * Duo : payload A+B → AnalSession.importBuffer dual (overlay Analyse).
   */
  function handoffToAnalyse(kind) {
    if (kind !== 'brut' && kind !== 'tsa' && kind !== 'res') {
      _log('[SYNC] handoff kind invalide: ' + kind);
      return false;
    }
    if (_state !== S.VIEW && _state !== S.ORDER_FFT && _state !== S.HANDOFF) {
      _log('[SYNC] handoff refusé (état=' + _state + ')');
      return false;
    }
    if (typeof AnalSession === 'undefined' || !AnalSession.importBuffer) {
      _log('[SYNC] !! AnalSession.importBuffer manquant');
      return false;
    }
    const payload = _exportForKind(kind);
    if (!payload) {
      _log('[SYNC] !! buffer ' + kind + ' indisponible');
      return false;
    }
    payload.view = 'fft';
    const ok = AnalSession.importBuffer(payload);
    if (!ok) {
      _log('[SYNC] !! importBuffer échoué (' + kind + ')');
      return false;
    }
    _handoffKind = kind;
    _state = S.HANDOFF;
    if (typeof showTab === 'function') showTab('analyse');
    _log('[SYNC] HANDOFF → Analyse (' + kind + ') N=' + payload.n +
      (payload.samplesB ? (' +B N=' + (payload.nB || payload.samplesB.length)) : ''));
    return true;
  }

  function toggleFft() {
    const fftBtn = document.getElementById('btn-sync-fft');
    const shapeBtn = document.getElementById('btn-sync-shape');

    if (_state === S.HANDOFF) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showTrace) {
        SyncModule.showTrace();
      }
      _state = S.VIEW;
      _handoffKind = null;
      if (typeof showTab === 'function') showTab('sync');
      _setViewChrome(true);
      _log('[SYNC] VIEW ← retour HANDOFF');
      return;
    }

    if (_state === S.VIEW) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showOrderFft) {
        SyncModule.showOrderFft();
      }
      _state = S.ORDER_FFT;
      if (fftBtn) fftBtn.textContent = 'Tour TSA';
      if (shapeBtn) shapeBtn.style.display = 'none';
      return;
    }

    if (_state === S.ORDER_FFT) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showTrace) {
        SyncModule.showTrace();
      }
      _state = S.VIEW;
      if (fftBtn) {
        fftBtn.textContent = (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
      }
      if (shapeBtn) shapeBtn.style.display = 'inline-block';
    }
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    toggleFft: toggleFft,
    handoffToAnalyse: handoffToAnalyse,
    openAnalyse: function () { return handoffToAnalyse('brut'); },
    onPayloadReady: onPayloadReady,
    onPayloadReadyB: onPayloadReadyB,
    onStatus: onStatus,
    reset: reset,
    abort: function () { reset(true); },
  };
})();

window.SyncSession = SyncSession;
