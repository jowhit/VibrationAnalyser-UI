// fft-session.js — Machine d'états : Live FFT (mono + duo)
//
// États :
//   IDLE ──start──► (nav) ──beginStream──► STREAMING ──stop──► VIEW
//   STREAMING|VIEW ──abort/reset──► IDLE
//   VIEW ──start──► (nav) …   (relance)
//
// Événements (seuls transitions autorisées) :
//   start / beginStream / stop / abort / reset / onFrame
// Entrée unique menu : FftSession.start()
// Bouton page        : FftSession.toggle()

const FftSession = (() => {
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
    const btn = document.getElementById('btn-fft-start');
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

  function _stopEsp() {
    if (typeof DualSession !== 'undefined') DualSession.stopBoth('r');
    else if (typeof wsSend === 'function') wsSend('r');
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isStreaming() { return _state === S.STREAMING; }
  function isActive() { return _state === S.STREAMING; }

  /** * → IDLE (changement module / sonde). Stop ESP si STREAMING. */
  function reset(silent) {
    if (_state === S.STREAMING) _stopEsp();
    _state = S.IDLE;
    _dual = false;
    if (typeof fftRunning !== 'undefined') fftRunning = false;
    if (typeof _fftDualSession !== 'undefined') _fftDualSession = false;
    if (typeof _fftWaitHide === 'function') _fftWaitHide();
    _setBtnRunning(false);
    if (!silent) _log('[FFT] reset → IDLE');
  }

  /** Alias leave (même transition * → IDLE). silent par défaut. */
  function abort(silent) {
    reset(silent === undefined ? true : silent);
  }

  /**
   * Après NAV_ACK : LIVE_START → STREAMING.
   * @param {boolean} [dualFlag]
   */
  function beginStream(dualFlag) {
    fftMag = null; fftMagVel = null;
    fftMagB = null; fftMagVelB = null;

    if (typeof dualFlag === 'boolean') {
      _dual = dualFlag;
    } else {
      _dual = (typeof DualSession !== 'undefined') ? DualSession.available() : false;
    }
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined') ? DualSession.is() : _dual;
    if (typeof _fftDualSession !== 'undefined') _fftDualSession = _dual;

    if (typeof _fftWaitShow === 'function') {
      _fftWaitShow(_dual ? 'Live FFT A+B…' : 'Live FFT…');
    }

    if (_dual && typeof DualSession !== 'undefined') {
      DualSession.sendBoth('LIVE_START');
    } else if (typeof wsSend === 'function') {
      wsSend('LIVE_START');
    }

    fftRunning = true;
    _state = S.STREAMING;
    _setBtnRunning(true);
    _log('[FFT] ' + (_dual ? 'DOUBLE' : 'mono') + ' — STREAMING');
  }

  /** STREAMING|VIEW → VIEW (garde le spectre). IDLE : no-op. */
  function stop() {
    if (_state === S.IDLE) return;
    if (_state === S.STREAMING) _stopEsp();

    fftRunning = false;
    if (typeof _fftWaitHide === 'function') _fftWaitHide();
    _state = S.VIEW;
    _setBtnRunning(false);
    if (typeof fftDraw === 'function') fftDraw();
    _log('[FFT] stop — VIEW');
  }

  function _failNav() {
    if (typeof _fftWaitHide === 'function') _fftWaitHide();
    _state = S.IDLE;
    fftRunning = false;
    _setBtnRunning(false);
    _log('!! Live FFT: NAV timeout');
  }

  /**
   * Entrée unique. Toute relance part de IDLE :
   * STREAMING|VIEW → abort → IDLE → nav → STREAMING.
   */
  function start() {
    if (_state !== S.IDLE) reset(true);

    if (typeof _fftWaitShow === 'function') _fftWaitShow('Connexion Live FFT…');

    const ready = function (dual) {
      beginStream(dual);
    };

    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('fft', 'WS_GOTO=ANAL_LIVE', {
        label: 'Live FFT',
        onReady: ready,
        onFail: _failNav,
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('fft', 'WS_GOTO=ANAL_LIVE', {
        onAck: function () { ready(false); },
        onTimeout: _failNav,
      });
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=ANAL_LIVE');
      setTimeout(function () { ready(false); }, 400);
    }
  }

  function toggle() {
    if (_state === S.STREAMING) stop();
    else start();
  }

  /** Événement trame : accepté seulement en STREAMING. */
  function onFrame() {
    if (_state !== S.STREAMING) return;
    fftRunning = true;
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isStreaming: isStreaming,
    isActive: isActive,
    start: start,
    beginStream: beginStream,
    stop: stop,
    toggle: toggle,
    onFrame: onFrame,
    reset: reset,
    abort: abort,
  };
})();

window.FftSession = FftSession;

// Compat anciennes API
function _fftFireLiveStart(dualFlag) {
  FftSession.beginStream(dualFlag);
}
window._fftStartDualLive = _fftFireLiveStart;

function fftToggle() {
  FftSession.toggle();
}
window.fftToggle = fftToggle;
