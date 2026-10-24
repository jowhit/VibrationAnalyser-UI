// balance-session.js — Machine d'états : Équilibrage (mono + duo)
//
// États :
//   IDLE ──start──► (WS_GOTO=EQ) ──beginLive──► LIVE
//   LIVE ──pause──► PAUSED ──resume──► (EQ_RESUME) ──► LIVE
//   * ──markIdle (clear/discard)──► IDLE
//
// Procédure 1P/2P (runs, masses, ICM) = BalanceModule.
// Ici = cycle de session ESP + entrée unique Terminal.
//
// Entrée : BalanceSession.start() / .resume()
// Onglet Equilibrage = viewer only

const BalanceSession = (() => {
  const S = {
    IDLE: 'IDLE',
    LIVE: 'LIVE',
    PAUSED: 'PAUSED',
  };

  let _state = S.IDLE;
  let _dual = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isLive() { return _state === S.LIVE; }
  function isPaused() { return _state === S.PAUSED; }
  function isActive() { return _state === S.LIVE || _state === S.PAUSED; }

  function markIdle() {
    _state = S.IDLE;
    _dual = false;
  }

  function markPaused() {
    _state = S.PAUSED;
  }

  function markLive(dualFlag) {
    if (typeof dualFlag === 'boolean') _dual = dualFlag;
    else if (typeof DualSession !== 'undefined') _dual = !!DualSession.is();
    _state = S.LIVE;
  }

  /**
   * Après NAV_ACK EQ : armer UI + tach.
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

    if (typeof BalanceModule !== 'undefined' &&
        typeof BalanceModule.enterBalance === 'function') {
      BalanceModule.enterBalance();
    }

    _state = S.LIVE;
    _log('[BAL] ' + (_dual ? 'DOUBLE' : 'mono') + ' — LIVE');
  }

  /** Après EQ_RESUME : UI sans second BAL_INIT. */
  function beginResumeLive(dualFlag) {
    if (typeof dualFlag === 'boolean') _dual = dualFlag;
    else if (typeof DualSession !== 'undefined') _dual = !!DualSession.is();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    if (typeof BalanceModule !== 'undefined' &&
        typeof BalanceModule.enterBalance === 'function') {
      BalanceModule.enterBalance({ skipInit: true });
    }
    _state = S.LIVE;
  }

  /** Quitte vers un autre module : pause si progression. */
  function pause() {
    if (_state === S.PAUSED) return true;
    if (_state !== S.LIVE) return false;

    const bal = (typeof BalanceModule !== 'undefined') ? BalanceModule : null;
    const has = bal && typeof bal.hasProgress === 'function' && bal.hasProgress();
    if (has && typeof bal.pauseForLeave === 'function') {
      bal.pauseForLeave();
      _state = S.PAUSED;
      _log('[BAL] pause — PAUSED');
      return true;
    }
    _state = S.IDLE;
    _dual = false;
    return false;
  }

  /** ProbeMode / wsGoto leave : pause si LIVE+progress. */
  function reset(silent) {
    if (_state === S.LIVE) pause();
    if (!silent && _state === S.IDLE) _log('[BAL] reset → IDLE');
  }

  function abort(silent) {
    reset(silent === undefined ? true : silent);
  }

  function _failNav() {
    _state = S.IDLE;
    _dual = false;
    _log('!! Équilibrage: NAV timeout');
  }

  /** Nouvelle procédure (menu Terminal). */
  function start() {
    if (_state === S.LIVE) {
      if (typeof showTab === 'function') showTab('balance');
      return;
    }
    if (_state === S.PAUSED) markIdle();

    const ready = function (dual) {
      beginLive(dual);
    };

    if (typeof DualSession !== 'undefined') {
      DualSession.startModule('balance', 'WS_GOTO=EQ', {
        label: 'Équilibrage',
        onReady: ready,
        onFail: _failNav,
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('balance', 'WS_GOTO=EQ', {
        onAck: function () { ready(false); },
        onTimeout: _failNav,
      });
    } else if (typeof wsSend === 'function') {
      wsSend('WS_GOTO=EQ');
      setTimeout(function () { ready(false); }, 400);
    }
  }

  /** Reprise — délègue nav à BalanceModule, synchronise LIVE à onReady. */
  function resume() {
    if (typeof BalanceModule === 'undefined' ||
        typeof BalanceModule.resumeSession !== 'function') {
      _log('!! Équilibrage: rien à reprendre');
      return;
    }
    BalanceModule.resumeSession({
      onLive: function (dual) {
        beginResumeLive(dual);
        _log('[BAL] resume — LIVE');
      },
      onFail: function () {
        _state = S.PAUSED;
        _log('!! Équilibrage: reprise échouée');
      },
    });
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isLive: isLive,
    isPaused: isPaused,
    isActive: isActive,
    start: start,
    resume: resume,
    pause: pause,
    beginLive: beginLive,
    beginResumeLive: beginResumeLive,
    reset: reset,
    abort: abort,
    markIdle: markIdle,
    markPaused: markPaused,
    markLive: markLive,
  };
})();

window.BalanceSession = BalanceSession;
