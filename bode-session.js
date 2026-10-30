// bode-session.js — Machine d'états : module Bode brut (mono v1)
//
// IDLE → READY → RECORDING → FINALIZE → VIEW
// Start/Stop : BodeModuleSession.toggleStart()
// Entrée menu : après NAV_ACK=bode → enter()

const BodeModuleSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    RECORDING: 'RECORDING',
    FINALIZE: 'FINALIZE',
    VIEW: 'VIEW',
  };

  let _state = S.IDLE;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _setBtnRunning(on) {
    const btn = document.getElementById('btn-bode-toggle');
    if (!btn) return;
    if (on) {
      btn.textContent = (typeof t === 'function') ? t('common.stop') : '◼ Arrêter';
      btn.classList.add('bal-btn-stop');
      btn.classList.remove('bal-btn-run');
    } else {
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
    }
  }

  function getState() { return _state; }
  function isRecording() { return _state === S.RECORDING; }
  function isActive() {
    return _state === S.READY || _state === S.RECORDING ||
      _state === S.FINALIZE || _state === S.VIEW;
  }

  function reset(silent) {
    if (_state === S.RECORDING && typeof wsSend === 'function') {
      wsSend('BODE_STOP\n');
    }
    _state = S.IDLE;
    if (typeof BodeModule !== 'undefined') {
      BodeModule.stopLiveAnim();
      BodeModule.resetLive();
    }
    _setBtnRunning(false);
    if (!silent) _log('[BODE] reset → IDLE');
  }

  function enter() {
    if (_state === S.READY || _state === S.RECORDING) return;
    reset(true);
    if (typeof BodeModule !== 'undefined') {
      BodeModule.clearResult();
      BodeModule.showPreview();
      BodeModule.resetLive();
      BodeModule.setStatus((typeof t === 'function') ? t('bode.ready') : 'Prêt — Démarrer');
    }
    _setBtnRunning(false);
    _state = S.READY;
    if (typeof showTab === 'function') showTab('bode');
    _log('[BODE] READY');
  }

  function _start() {
    if (typeof BodeModule !== 'undefined') {
      BodeModule.clearResult();
      BodeModule.showPreview();
      BodeModule.resetLive();
      BodeModule.startLiveAnim();
      BodeModule.setStatus((typeof t === 'function') ? t('bode.recording') : 'Enregistrement…');
    }
    if (typeof wsSend === 'function') wsSend('BODE_START\n');
    _state = S.RECORDING;
    _setBtnRunning(true);
    _log('[BODE] RECORDING');
  }

  function _stop() {
    if (typeof BodeModule !== 'undefined') {
      BodeModule.stopLiveAnim();
      BodeModule.setStatus((typeof t === 'function') ? t('bode.sending') : 'Envoi buffer…');
    }
    if (typeof wsSend === 'function') wsSend('BODE_STOP\n');
    _state = S.FINALIZE;
    _setBtnRunning(false);
    _log('[BODE] FINALIZE — attente binaire');
  }

  function toggleStart() {
    if (_state === S.RECORDING) _stop();
    else if (_state === S.READY || _state === S.VIEW || _state === S.IDLE) {
      if (_state === S.IDLE) enter();
      _start();
    }
  }

  function onLive() {
    if (_state === S.READY) {
      _state = S.RECORDING;
      _setBtnRunning(true);
    }
  }

  /** Après BODE_TACH_END + samples reçus. */
  function onPayloadReady() {
    if (_state !== S.FINALIZE && _state !== S.RECORDING) {
      // binaire hors séquence : accepter si on attendait
      if (_state !== S.VIEW) _state = S.FINALIZE;
    }
    let ok = false;
    if (typeof BodeModule !== 'undefined' && BodeModule.finalizeFromRaw) {
      ok = BodeModule.finalizeFromRaw();
    }
    _state = S.VIEW;
    _setBtnRunning(false);
    _log('[BODE] VIEW' + (ok ? '' : ' (peu de points)'));
  }

  return {
    S: S,
    getState: getState,
    isRecording: isRecording,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    onLive: onLive,
    onPayloadReady: onPayloadReady,
    reset: reset,
    abort: function () { reset(true); },
  };
})();

window.BodeModuleSession = BodeModuleSession;
