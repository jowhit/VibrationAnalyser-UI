// phase-session.js — Machine d'états : Phase / Harmonique (mono + duo)
//
// États :
//   IDLE ──enter──► (WS_GOTO=ANAL_HARM) ──READY──► (HARM_START) ──STREAMING──► VIEW
//
// Menu Terminal : PhaseSession.enter()  (ESP en attente bouton)
// Bouton page   : PhaseSession.toggle()

const PhaseSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    STREAMING: 'STREAMING',
    VIEW: 'VIEW',
  };

  let _state = S.IDLE;
  let _dual = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _setBtnRunning(on) {
    const btn = document.getElementById('btn-harm-toggle');
    if (!btn) return;
    if (on) {
      btn.textContent = (typeof t === 'function') ? t('common.stop') : '◼ Arrêter';
      btn.classList.add('bal-btn-stop');
      btn.classList.remove('bal-btn-run', 'running');
    } else {
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
    }
  }

  function _stopEsp() {
    if (typeof DualSession !== 'undefined') {
      DualSession.sendBoth('WS_GOTO=HARM_STOP');
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=HARM_STOP');
    }
  }

  function _sendStart() {
    if (typeof DualSession !== 'undefined' && DualSession.is && DualSession.is()) {
      DualSession.sendBoth('HARM_START');
    } else if (typeof DualSession !== 'undefined' && DualSession.sendBoth && _dual) {
      DualSession.sendBoth('HARM_START');
    } else if (typeof wsSend === 'function') {
      wsSend('HARM_START');
    }
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isStreaming() { return _state === S.STREAMING; }
  function isActive() {
    return _state === S.READY || _state === S.STREAMING || _state === S.VIEW;
  }

  function reset(silent) {
    if (_state === S.STREAMING) _stopEsp();
    _state = S.IDLE;
    _dual = false;
    if (typeof HarmonicModule !== 'undefined' &&
        typeof HarmonicModule.abortStart === 'function') {
      HarmonicModule.abortStart();
    }
    _setBtnRunning(false);
    if (!silent) _log('[PHASE] reset → IDLE');
  }

  function abort(silent) {
    reset(silent === undefined ? true : silent);
  }

  /**
   * Démarre le live ESP (après HARM_START).
   * @param {boolean} [dualFlag]
   */
  function beginLive(dualFlag) {
    if (typeof dualFlag === 'boolean') {
      _dual = dualFlag;
    } else {
      _dual = (typeof DualSession !== 'undefined') ? DualSession.available() : false;
    }
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined') ? DualSession.is() : _dual;

    if (typeof HarmonicModule !== 'undefined' &&
        typeof HarmonicModule.onDualReady === 'function') {
      HarmonicModule.onDualReady(_dual);
    }

    _sendStart();
    _state = S.STREAMING;
    _setBtnRunning(true);
    _log('[PHASE] ' + (_dual ? 'DOUBLE' : 'mono') + ' — STREAMING');
  }

  function stop() {
    if (_state === S.IDLE) return;
    if (_state === S.STREAMING) _stopEsp();

    if (typeof HarmonicModule !== 'undefined' &&
        typeof HarmonicModule.pauseSession === 'function') {
      HarmonicModule.pauseSession();
    } else if (typeof HarmonicModule !== 'undefined' &&
               typeof HarmonicModule.setRunning === 'function') {
      HarmonicModule.setRunning(false);
    }

    _state = S.VIEW;
    _setBtnRunning(false);
    _log('[PHASE] stop — VIEW');
  }

  function _failNav() {
    _state = S.IDLE;
    _dual = false;
    if (typeof HarmonicModule !== 'undefined' &&
        typeof HarmonicModule.abortStart === 'function') {
      HarmonicModule.abortStart();
    }
    _setBtnRunning(false);
    _log('!! Phase: NAV timeout');
  }

  function _onNavReady(dual) {
    _dual = !!dual;
    _state = S.READY;
    _setBtnRunning(false);
    if (typeof showTab === 'function') showTab('harmonic');
    _log('[PHASE] READY — appuyer Démarrer');
  }

  /** Menu : page Phase prête, ESP en ATTENTE (pas d'acq). */
  function enter() {
    if (_state === S.READY || _state === S.STREAMING) {
      if (typeof showTab === 'function') showTab('harmonic');
      return;
    }
    if (_state !== S.IDLE) reset(true);

    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('harmonic', 'WS_GOTO=ANAL_HARM', {
        label: 'Phase',
        onReady: _onNavReady,
        onFail: _failNav,
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('harmonic', 'WS_GOTO=ANAL_HARM', {
        onAck: function () { _onNavReady(false); },
        onTimeout: _failNav,
      });
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=ANAL_HARM');
      setTimeout(function () { _onNavReady(false); }, 400);
    }
  }

  /** @deprecated — menu doit appeler enter() */
  function start() {
    enter();
  }

  function toggle() {
    if (_state === S.STREAMING) stop();
    else if (_state === S.READY || _state === S.VIEW) beginLive(_dual);
    else enter();
  }

  function onFrame() {
    if (_state !== S.STREAMING) return;
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isStreaming: isStreaming,
    isActive: isActive,
    enter: enter,
    start: start,
    beginLive: beginLive,
    stop: stop,
    toggle: toggle,
    onFrame: onFrame,
    reset: reset,
    abort: abort,
  };
})();

window.PhaseSession = PhaseSession;
