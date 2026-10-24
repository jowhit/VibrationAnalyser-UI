// phase-session.js — Machine d'états : Phase / Harmonique (mono + duo)
//
// États :
//   IDLE ──start──► (WS_GOTO=ANAL_HARM) ──beginLive──► STREAMING ──stop──► VIEW
//   STREAMING|VIEW ──reset/abort──► IDLE
//   VIEW ──start──► (nav) …
//
// Deux vues UI (HarmonicModule.switchView) : Harmonique | Suivi Phase
// — même session ESP, même SM.
//
// Entrée unique : PhaseSession.start()  (menu Terminal)
// Bouton page   : PhaseSession.toggle()
// Onglet Phase  : viewer only (pas de WS_GOTO)

const PhaseSession = (() => {
  const S = {
    IDLE: 'IDLE',
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
      btn.textContent = '◼ Arrêter';
      btn.classList.add('bal-btn-stop');
      btn.classList.remove('bal-btn-run', 'running');
    } else {
      btn.textContent = '▶ Démarrer';
      btn.classList.remove('bal-btn-stop');
      btn.classList.add('bal-btn-run');
    }
  }

  /** Stop ESP sans wsGoto (évite reset récursif dans wsGoto). */
  function _stopEsp() {
    if (typeof DualSession !== 'undefined') {
      DualSession.sendBoth('WS_GOTO=HARM_STOP');
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=HARM_STOP');
    }
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isStreaming() { return _state === S.STREAMING; }
  function isActive() { return _state === S.STREAMING || _state === S.VIEW; }

  /** * → IDLE. Stop ESP si STREAMING. */
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
   * Après NAV_ACK ANAL_HARM : session prête (estimation RPM côté ESP).
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

    _state = S.STREAMING;
    _setBtnRunning(true);
    _log('[PHASE] ' + (_dual ? 'DOUBLE' : 'mono') + ' — STREAMING');
  }

  /** STREAMING|VIEW → VIEW (garde polaire / phase gelés). */
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

  /**
   * Entrée unique (menu Terminal). Relance depuis IDLE.
   */
  function start() {
    if (_state !== S.IDLE) reset(true);

    const ready = function (dual) {
      beginLive(dual);
    };

    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('harmonic', 'WS_GOTO=ANAL_HARM', {
        label: 'Phase',
        onReady: ready,
        onFail: _failNav,
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('harmonic', 'WS_GOTO=ANAL_HARM', {
        onAck: function () { ready(false); },
        onTimeout: _failNav,
      });
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=ANAL_HARM');
      setTimeout(function () { ready(false); }, 400);
    }
  }

  function toggle() {
    if (_state === S.STREAMING) stop();
    else start();
  }

  /** Trame HARM_BIN — seulement en STREAMING. */
  function onFrame() {
    if (_state !== S.STREAMING) return;
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isStreaming: isStreaming,
    isActive: isActive,
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
