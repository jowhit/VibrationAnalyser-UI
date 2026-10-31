// sync-session.js — SM module Analyse synchrone (TSA)
// IDLE → READY → ACQUIRING → FINALIZE → VIEW ↔ ORDER_FFT
//                                          └→ HANDOFF (buffer → AnalSession)

const SyncSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    ACQUIRING: 'ACQUIRING',
    FINALIZE: 'FINALIZE',
    VIEW: 'VIEW',
    ORDER_FFT: 'ORDER_FFT',
    /** Buffer envoyé à AnalSession — ESP Sync intact, UI Analyse */
    HANDOFF: 'HANDOFF',
  };

  let _state = S.IDLE;
  let _acqTimer = null;

  // Overlay rotatif dédié (#page-sync) — ne touche pas an-acq-overlay
  let _ovRaf = null;
  let _ovStartMs = 0;
  let _ovDurMs = 8000;
  let _ovTransfer = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _clearAcqTimer() {
    if (_acqTimer) { clearTimeout(_acqTimer); _acqTimer = null; }
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

  function _ovUpdateLabel(progress) {
    const lbl = document.getElementById('sync-acq-label');
    if (!lbl) return;
    if (_ovTransfer) {
      lbl.textContent = 'Transfert des données…';
      return;
    }
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    const remain = Math.max(0, _ovDurMs - (Date.now() - _ovStartMs));
    lbl.textContent = remain <= 0
      ? 'Finalisation…'
      : ('Acquisition ' + pct + '%  ' + (remain / 1000).toFixed(1) + 's');
  }

  function _ovAnimFrame() {
    if (_state !== S.ACQUIRING && _state !== S.FINALIZE) {
      _ovHide();
      return;
    }
    const elapsed = Date.now() - _ovStartMs;
    if (!_ovTransfer && elapsed >= _ovDurMs) _ovTransfer = true;
    const progress = _ovTransfer ? 1 : Math.min(1, elapsed / _ovDurMs);
    _ovDraw(progress);
    _ovUpdateLabel(progress);
    _ovRaf = requestAnimationFrame(_ovAnimFrame);
  }

  function _ovShow() {
    let fs = 4000, n = 45000;
    if (typeof SyncModule !== 'undefined' && SyncModule.getAcqTiming) {
      const tmg = SyncModule.getAcqTiming();
      if (tmg) {
        if (tmg.fs > 0) fs = tmg.fs;
        if (tmg.n > 0) n = tmg.n;
      }
    }
    _ovDurMs = Math.max(800, Math.round(n * 1000 / fs) + 600);
    _ovStartMs = Date.now();
    _ovTransfer = false;
    const ov = document.getElementById('sync-acq-overlay');
    if (ov) {
      ov.style.display = 'flex';
      ov.setAttribute('aria-hidden', 'false');
    }
    if (_ovRaf) cancelAnimationFrame(_ovRaf);
    _ovRaf = requestAnimationFrame(_ovAnimFrame);
  }

  function _ovHide() {
    _ovTransfer = false;
    if (_ovRaf) { cancelAnimationFrame(_ovRaf); _ovRaf = null; }
    const ov = document.getElementById('sync-acq-overlay');
    if (ov) {
      ov.style.display = 'none';
      ov.setAttribute('aria-hidden', 'true');
    }
    const ring = document.getElementById('sync-acq-ring');
    if (ring) {
      const ctx = ring.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, ring.width, ring.height);
    }
  }

  function getState() { return _state; }
  function isActive() {
    return _state !== S.IDLE;
  }

  function reset(silent) {
    _clearAcqTimer();
    _ovHide();
    _state = S.IDLE;
    if (typeof SyncModule !== 'undefined') {
      SyncModule.clearResult();
      SyncModule.showTrace();
    }
    _setBtnRunning(false);
    const fftBtn = document.getElementById('btn-sync-fft');
    if (fftBtn) fftBtn.style.display = 'none';
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (shapeBtn) shapeBtn.style.display = 'none';
    const srcRow = document.getElementById('sync-src-row');
    if (srcRow) srcRow.style.display = 'none';
    if (!silent) _log('[SYNC] reset → IDLE');
  }

  function enter() {
    if (_state === S.READY || _state === S.ACQUIRING) return;
    reset(true);
    if (typeof SyncModule !== 'undefined') {
      SyncModule.clearResult();
      SyncModule.showTrace();
      SyncModule.setStatus((typeof t === 'function') ? t('sync.ready') : 'Prêt — Démarrer');
    }
    _setBtnRunning(false);
    _state = S.READY;
    if (typeof showTab === 'function') showTab('sync');
    _log('[SYNC] READY');
  }

  function _start() {
    _ovHide();
    if (typeof SyncModule !== 'undefined') {
      SyncModule.clearResult();
      SyncModule.showTrace();
      SyncModule.setStatus((typeof t === 'function') ? t('sync.acquiring') : 'Acquisition…');
    }
    if (typeof wsSend === 'function') wsSend('SYNC_START\n');
    _state = S.ACQUIRING;
    _setBtnRunning(true);
    _ovShow();
    _clearAcqTimer();
    _acqTimer = setTimeout(function () {
      _acqTimer = null;
      if (_state !== S.ACQUIRING && _state !== S.FINALIZE) return;
      _ovHide();
      _log('[SYNC] !! timeout — pas de payload');
      _state = S.READY;
      _setBtnRunning(false);
      if (typeof SyncModule !== 'undefined') {
        SyncModule.setStatus('Timeout — réessayer Démarrer');
      }
    }, 120000);
    _log('[SYNC] ACQUIRING');
  }

  function toggleStart() {
    if (_state === S.ACQUIRING || _state === S.FINALIZE) return;
    if (_state === S.READY || _state === S.VIEW || _state === S.ORDER_FFT ||
        _state === S.HANDOFF || _state === S.IDLE) {
      if (_state === S.IDLE) enter();
      _start();
    }
  }

  function onPayloadReady() {
    _clearAcqTimer();
    _ovHide();
    if (_state !== S.FINALIZE && _state !== S.ACQUIRING) {
      _state = S.FINALIZE;
    }
    let ok = false;
    if (typeof SyncModule !== 'undefined' && SyncModule.finalizeFromRaw) {
      ok = SyncModule.finalizeFromRaw();
    }
    _state = S.VIEW;
    _setBtnRunning(false);
    const fftBtn = document.getElementById('btn-sync-fft');
    if (fftBtn) {
      fftBtn.style.display = ok ? 'inline-block' : 'none';
      fftBtn.textContent = _fftBtnLabel(S.VIEW);
    }
    const shapeBtn = document.getElementById('btn-sync-shape');
    if (shapeBtn) shapeBtn.style.display = ok ? 'inline-block' : 'none';
    const srcRow = document.getElementById('sync-src-row');
    if (srcRow) srcRow.style.display = ok ? 'flex' : 'none';
    if (typeof showTab === 'function') showTab('sync');
    _log('[SYNC] VIEW' + (ok ? '' : ' (peu de tours)'));
  }

  function _fftBtnLabel(forState) {
    if (forState === S.VIEW) {
      return (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
    }
    if (forState === S.ORDER_FFT) return '→ Analyse';
    return (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
  }

  function onStatus(txt) {
    if (typeof SyncModule !== 'undefined' && SyncModule.setStatus) {
      SyncModule.setStatus(txt);
    }
    if (/^Pret/i.test(String(txt || '')) &&
        (_state === S.ACQUIRING || _state === S.FINALIZE)) {
      _clearAcqTimer();
      _ovHide();
      if (_state !== S.VIEW && _state !== S.HANDOFF) {
        _state = S.READY;
        _setBtnRunning(false);
      }
    }
  }

  /**
   * Handoff SM : Sync → AnalSession.importBuffer (pas de WS_GOTO).
   * VIEW | ORDER_FFT → HANDOFF
   */
  function openAnalyse() {
    if (_state !== S.VIEW && _state !== S.ORDER_FFT && _state !== S.HANDOFF) {
      _log('[SYNC] openAnalyse refusé (état=' + _state + ')');
      return false;
    }
    if (typeof SyncModule === 'undefined') {
      _log('[SYNC] !! SyncModule manquant');
      return false;
    }
    const exportFn = SyncModule.exportForAnalyse || SyncModule.exportRaw;
    if (!exportFn) {
      _log('[SYNC] !! export manquant');
      return false;
    }
    const payload = exportFn.call(SyncModule);
    if (!payload) {
      _log('[SYNC] !! pas de buffer à exporter');
      return false;
    }
    const src = (typeof SyncModule.getSource === 'function')
      ? SyncModule.getSource()
      : 'tsa';
    payload.source = (src === 'res') ? 'sync-res' : 'sync';
    payload.view = 'fft';
    if (typeof AnalSession === 'undefined' || !AnalSession.importBuffer) {
      _log('[SYNC] !! AnalSession.importBuffer manquant');
      return false;
    }
    const ok = AnalSession.importBuffer(payload);
    if (!ok) return false;
    _state = S.HANDOFF;
    _log('[SYNC] HANDOFF → AnalSession (' + payload.source + ')');
    return true;
  }

  /** Cycle UI : Tour ↔ Ordres ; depuis Ordres → Analyse (handoff). */
  function toggleFft() {
    const fftBtn = document.getElementById('btn-sync-fft');
    const shapeBtn = document.getElementById('btn-sync-shape');

    if (_state === S.VIEW) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showOrderFft) {
        SyncModule.showOrderFft();
      }
      _state = S.ORDER_FFT;
      if (fftBtn) fftBtn.textContent = _fftBtnLabel(S.ORDER_FFT);
      if (shapeBtn) shapeBtn.style.display = 'none';
      return;
    }
    if (_state === S.ORDER_FFT) {
      openAnalyse();
      return;
    }
    if (_state === S.HANDOFF) {
      // Retour page Sync sans perdre le buffer TSA
      if (typeof SyncModule !== 'undefined' && SyncModule.showTrace) {
        SyncModule.showTrace();
      }
      _state = S.VIEW;
      if (typeof showTab === 'function') showTab('sync');
      if (fftBtn) {
        fftBtn.style.display = 'inline-block';
        fftBtn.textContent = _fftBtnLabel(S.VIEW);
      }
      if (shapeBtn) shapeBtn.style.display = 'inline-block';
      const srcRow = document.getElementById('sync-src-row');
      if (srcRow) srcRow.style.display = 'flex';
      _log('[SYNC] VIEW ← retour HANDOFF');
    }
  }

  return {
    S: S,
    getState: getState,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    toggleFft: toggleFft,
    openAnalyse: openAnalyse,
    onPayloadReady: onPayloadReady,
    onStatus: onStatus,
    reset: reset,
    abort: function () { reset(true); },
  };
})();

window.SyncSession = SyncSession;
