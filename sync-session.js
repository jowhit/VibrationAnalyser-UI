// sync-session.js — SM module Analyse synchrone (TSA)
// IDLE → READY → ACQUIRING → FINALIZE → VIEW ↔ ORDER_FFT

const SyncSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    ACQUIRING: 'ACQUIRING',
    FINALIZE: 'FINALIZE',
    VIEW: 'VIEW',
    ORDER_FFT: 'ORDER_FFT',
  };

  let _state = S.IDLE;
  let _acqTimer = null;

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
      btn.disabled = true; // acq one-shot : pas d'arrêt mid-buffer
    } else {
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
      btn.disabled = false;
    }
  }

  function getState() { return _state; }
  function isActive() {
    return _state !== S.IDLE;
  }

  function reset(silent) {
    _clearAcqTimer();
    _state = S.IDLE;
    if (typeof acqHideProgress === 'function') acqHideProgress();
    if (typeof SyncModule !== 'undefined') {
      SyncModule.clearResult();
      SyncModule.showTrace();
    }
    _setBtnRunning(false);
    const fftBtn = document.getElementById('btn-sync-fft');
    if (fftBtn) fftBtn.style.display = 'none';
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
    if (typeof acqHideProgress === 'function') acqHideProgress();
    if (typeof SyncModule !== 'undefined') {
      SyncModule.clearResult();
      SyncModule.showTrace();
      SyncModule.setStatus((typeof t === 'function') ? t('sync.acquiring') : 'Acquisition…');
    }
    if (typeof wsSend === 'function') wsSend('SYNC_START\n');
    _state = S.ACQUIRING;
    _setBtnRunning(true);
    _clearAcqTimer();
    // Buffer ~45k @ 1k–32k Hz + transfert : marge large, évite bouton bloqué
    _acqTimer = setTimeout(function () {
      _acqTimer = null;
      if (_state !== S.ACQUIRING && _state !== S.FINALIZE) return;
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
    if (_state === S.READY || _state === S.VIEW || _state === S.ORDER_FFT || _state === S.IDLE) {
      if (_state === S.IDLE) enter();
      _start();
    }
  }

  function onPayloadReady() {
    _clearAcqTimer();
    if (typeof acqHideProgress === 'function') acqHideProgress();
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
      fftBtn.textContent = (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
    }
    if (typeof showTab === 'function') showTab('sync');
    _log('[SYNC] VIEW' + (ok ? '' : ' (peu de tours)'));
  }

  /** SYNC_STATUS depuis ESP — recovery si overlay / état coincé. */
  function onStatus(txt) {
    if (typeof SyncModule !== 'undefined' && SyncModule.setStatus) {
      SyncModule.setStatus(txt);
    }
    // Fin acq côté ESP sans payload exploitable
    if (/^Pret/i.test(String(txt || '')) &&
        (_state === S.ACQUIRING || _state === S.FINALIZE)) {
      _clearAcqTimer();
      if (typeof acqHideProgress === 'function') acqHideProgress();
      if (_state !== S.VIEW) {
        _state = S.READY;
        _setBtnRunning(false);
      }
    }
  }

  function toggleFft() {
    if (_state === S.VIEW) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showOrderFft) {
        SyncModule.showOrderFft();
      }
      _state = S.ORDER_FFT;
      const fftBtn = document.getElementById('btn-sync-fft');
      if (fftBtn) fftBtn.textContent = (typeof t === 'function') ? t('sync.trace') : 'Polaire';
    } else if (_state === S.ORDER_FFT) {
      if (typeof SyncModule !== 'undefined' && SyncModule.showTrace) {
        SyncModule.showTrace();
      }
      _state = S.VIEW;
      const fftBtn = document.getElementById('btn-sync-fft');
      if (fftBtn) fftBtn.textContent = (typeof t === 'function') ? t('sync.fft') : 'FFT ordres';
    }
  }

  return {
    S: S,
    getState: getState,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    toggleFft: toggleFft,
    onPayloadReady: onPayloadReady,
    onStatus: onStatus,
    reset: reset,
    abort: function () { reset(true); },
  };
})();

window.SyncSession = SyncSession;
