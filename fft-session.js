// fft-session.js — Machine d'états : Live FFT (mono + duo)
//
// États :
//   IDLE ──enter──► (nav) ──READY──► (bouton Start) ──STREAMING──► VIEW
//   STREAMING|VIEW ──abort/reset──► IDLE
//
// Menu Terminal : FftSession.enter()  (pas de LIVE_START)
// Bouton page   : FftSession.toggle()

const FftSession = (() => {
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
    const btn = document.getElementById('btn-fft-start');
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
    if (typeof DualSession !== 'undefined') DualSession.stopBoth('r');
    else if (typeof wsSend === 'function') wsSend('r');
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isStreaming() { return _state === S.STREAMING; }
  function isActive() { return _state === S.READY || _state === S.STREAMING; }

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

  function abort(silent) {
    reset(silent === undefined ? true : silent);
  }

  /**
   * Après NAV_ACK : LIVE_START → STREAMING (bouton Start uniquement).
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
    // Si dualFlag false mais ProbeMode AB (failDual / handshake B tardif) → forcer duo
    if (!_dual && typeof DualSession !== 'undefined' && DualSession.available()) {
      _dual = true;
    }
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined')
      ? (DualSession.is() || DualSession.available())
      : _dual;
    if (typeof _fftDualSession !== 'undefined') _fftDualSession = _dual;

    if (typeof _fftWaitShow === 'function') {
      _fftWaitShow(_dual ? 'Live FFT A+B…' : 'Live FFT…');
    }

    if (_dual) {
      if (typeof DualSession !== 'undefined' && DualSession.begin) DualSession.begin();
      if (typeof wsSend === 'function') wsSend('LIVE_START');
      if (typeof wsSendB === 'function') wsSendB('LIVE_START');
    } else if (typeof wsSend === 'function') {
      wsSend('LIVE_START');
    }

    fftRunning = true;
    _state = S.STREAMING;
    _setBtnRunning(true);
    _log('[FFT] ' + (_dual ? 'DOUBLE' : 'mono') + ' — STREAMING');
  }

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

  function _onNavReady(dual) {
    _dual = !!dual;
    // Handshake B raté mais ProbeMode AB → garder le duo pour LIVE_START
    if (!_dual && typeof DualSession !== 'undefined' && DualSession.available()) {
      DualSession.begin();
      _dual = true;
    }
    _state = S.READY;
    fftRunning = false;
    _setBtnRunning(false);
    if (typeof _fftWaitHide === 'function') _fftWaitHide();
    if (typeof showTab === 'function') showTab('fft');
    _log('[FFT] READY' + (_dual ? ' A+B' : '') + ' — appuyer Démarrer');
  }

  /** Menu : ouvrir l'onglet, attendre le bouton (pas de LIVE_START). */
  function enter() {
    if (_state === S.READY || _state === S.STREAMING) {
      if (typeof showTab === 'function') showTab('fft');
      return;
    }
    if (_state !== S.IDLE) reset(true);

    if (typeof _fftWaitShow === 'function') _fftWaitShow('Connexion Live FFT…');

    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('fft', 'WS_GOTO=ANAL_LIVE', {
        label: 'Live FFT',
        onReady: _onNavReady,
        // B lent : rester READY — beginStream enverra quand même LIVE_START à B si AB
        onFail: function () {
          _onNavReady(typeof DualSession !== 'undefined' && DualSession.available());
        },
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('fft', 'WS_GOTO=ANAL_LIVE', {
        onAck: function () { _onNavReady(false); },
        onTimeout: _failNav,
      });
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=ANAL_LIVE');
      setTimeout(function () { _onNavReady(false); }, 400);
    }
  }

  /** @deprecated — utiliser enter() depuis le menu */
  function start() {
    enter();
  }

  function toggle() {
    if (_state === S.STREAMING) stop();
    else if (_state === S.READY || _state === S.VIEW) beginStream(_dual);
    else enter();
  }

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
    enter: enter,
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

function _fftFireLiveStart(dualFlag) {
  FftSession.beginStream(dualFlag);
}
window._fftStartDualLive = _fftFireLiveStart;

function fftToggle() {
  FftSession.toggle();
}
window.fftToggle = fftToggle;
