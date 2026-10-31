// bode-session.js — Machine d'états : Bode brut (mono A / mono B / duo AB)
//
// IDLE → READY → RECORDING → FINALIZE → VIEW
// Start/Stop : BodeModuleSession.toggleStart()
// Entrée menu : DualSession.startModule / NAV_ACK=bode → enter()

const BodeModuleSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    RECORDING: 'RECORDING',
    FINALIZE: 'FINALIZE',
    VIEW: 'VIEW',
  };

  const FINALIZE_TIMEOUT_MS = 45000;

  let _state = S.IDLE;
  let _dual = false;
  let _binA = false;
  let _binB = false;
  let _finalizeTimer = null;

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

  function _sendBode(cmd) {
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

  function _clearFinalizeTimer() {
    if (_finalizeTimer) {
      clearTimeout(_finalizeTimer);
      _finalizeTimer = null;
    }
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
  function isDual() { return _dual; }
  function isRecording() { return _state === S.RECORDING; }
  function isActive() {
    return _state === S.READY || _state === S.RECORDING ||
      _state === S.FINALIZE || _state === S.VIEW;
  }

  function reset(silent) {
    _clearFinalizeTimer();
    if (_state === S.RECORDING) {
      _sendBode('BODE_STOP\n');
    }
    _state = S.IDLE;
    _dual = false;
    _binA = _binB = false;
    if (typeof BodeModule !== 'undefined') {
      BodeModule.stopLiveAnim();
      BodeModule.resetLive();
      if (BodeModule.setDual) BodeModule.setDual(false);
    }
    _setBtnRunning(false);
    if (!silent) _log('[BODE] reset → IDLE');
  }

  function enter() {
    if (_state === S.READY || _state === S.RECORDING) {
      if (_isDualWanted() && typeof DualSession !== 'undefined') {
        DualSession.begin();
        _dual = DualSession.is() || DualSession.available();
        if (typeof BodeModule !== 'undefined' && BodeModule.setDual) {
          BodeModule.setDual(_dual);
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

    if (typeof BodeModule !== 'undefined') {
      if (BodeModule.setDual) BodeModule.setDual(_dual);
      BodeModule.clearResult();
      BodeModule.showPreview();
      BodeModule.resetLive();
      BodeModule.setStatus(_dual
        ? 'Mode DOUBLE prêt — Démarrer (A+B)'
        : ((typeof t === 'function') ? t('bode.ready') : 'Prêt — Démarrer'));
    }
    _binA = _binB = false;
    _setBtnRunning(false);
    _state = S.READY;
    if (typeof showTab === 'function') showTab('bode');
    _log('[BODE] ' + (_dual ? 'DOUBLE ' : '') + 'READY');
  }

  function _start() {
    _clearFinalizeTimer();
    _dual = _isDualWanted();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined')
      ? (DualSession.is() || DualSession.available())
      : _dual;
    _binA = _binB = false;

    if (typeof BodeModule !== 'undefined') {
      if (BodeModule.setDual) BodeModule.setDual(_dual);
      BodeModule.clearResult();
      BodeModule.showPreview();
      BodeModule.resetLive();
      BodeModule.startLiveAnim();
      BodeModule.setStatus(_dual
        ? 'Enregistrement A+B…'
        : ((typeof t === 'function') ? t('bode.recording') : 'Enregistrement…'));
    }
    _sendBode('BODE_START\n');
    _state = S.RECORDING;
    _setBtnRunning(true);
    _log('[BODE] RECORDING' + (_dual ? ' A+B' : ''));
  }

  function _stop() {
    if (typeof BodeModule !== 'undefined') {
      BodeModule.stopLiveAnim();
      BodeModule.setStatus(_dual
        ? 'Envoi buffers A+B…'
        : ((typeof t === 'function') ? t('bode.sending') : 'Envoi buffer…'));
    }
    _binA = _binB = false;
    _sendBode('BODE_STOP\n');
    _state = S.FINALIZE;
    _setBtnRunning(false);
    _clearFinalizeTimer();
    _finalizeTimer = setTimeout(function () {
      _finalizeTimer = null;
      if (_state !== S.FINALIZE) return;
      _log('[BODE] !! timeout FINALIZE' +
        (_dual ? (' A=' + (_binA ? 'ok' : '?') + ' B=' + (_binB ? 'ok' : '?')) : ''));
      _doFinalize();
    }, FINALIZE_TIMEOUT_MS);
    _log('[BODE] FINALIZE — attente binaire' + (_dual ? ' A+B' : ''));
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

  function _doFinalize() {
    _clearFinalizeTimer();
    let ok = false;
    if (typeof BodeModule !== 'undefined' && BodeModule.finalizeFromRaw) {
      ok = BodeModule.finalizeFromRaw();
    }
    _state = S.VIEW;
    _setBtnRunning(false);
    _log('[BODE] VIEW' + (ok ? '' : ' (peu de points)') +
      (_dual ? ' (dual)' : ''));
  }

  function _tryFinalize() {
    if (_state !== S.FINALIZE && _state !== S.RECORDING) {
      if (_state !== S.VIEW) _state = S.FINALIZE;
    }
    if (_state === S.RECORDING) {
      _state = S.FINALIZE;
      _setBtnRunning(false);
    }
    if (_dual) {
      if (!_binA || !_binB) return;
      _log('[BODE] OK — A+B reçus');
    } else if (!_binA) {
      return;
    }
    _doFinalize();
  }

  /** Canal A (ou mono B routé vers handlers A) — après BODE_TACH_END. */
  function onPayloadReady() {
    if (_state !== S.FINALIZE && _state !== S.RECORDING) {
      if (_state !== S.VIEW) _state = S.FINALIZE;
    }
    _binA = true;
    if (_dual) _log('[BODE] A reçu' + (_binB ? ' — OK' : ' — attente B…'));
    _tryFinalize();
  }

  /** Canal B en duo uniquement. */
  function onPayloadReadyB() {
    if (!_dual) return;
    if (_state !== S.FINALIZE && _state !== S.RECORDING) {
      if (_state !== S.VIEW) _state = S.FINALIZE;
    }
    if (_state === S.RECORDING) {
      _state = S.FINALIZE;
      _setBtnRunning(false);
    }
    _binB = true;
    _log('[BODE] B reçu' + (_binA ? ' — OK' : ' — attente A…'));
    _tryFinalize();
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isRecording: isRecording,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    onLive: onLive,
    onPayloadReady: onPayloadReady,
    onPayloadReadyB: onPayloadReadyB,
    reset: reset,
    abort: function () { reset(true); },
  };
})();

window.BodeModuleSession = BodeModuleSession;
