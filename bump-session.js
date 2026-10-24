// bump-session.js — Machine d'états : Bump Test (mono + duo)
//
// États :
//   IDLE → READY → STREAMING → WAIT_BINARY → VIEW
//   * → IDLE (exit / wsGoto)
//
// Entrée unique : BumpSession.enter()
// Start/Stop     : BumpSession.toggleStart()
// Menu + NAV_ACK bumptest DOIVENT passer par enter().

const BumpSession = (() => {
  const S = {
    IDLE: 'IDLE',
    READY: 'READY',
    STREAMING: 'STREAMING',
    WAIT_BINARY: 'WAIT_BINARY',
    VIEW: 'VIEW',
  };

  let _state = S.IDLE;
  let _dual = false;
  let _binA = false;
  let _binB = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _isDualWanted() {
    if (typeof DualSession !== 'undefined') return DualSession.available();
    if (typeof isDualMode === 'function') return isDualMode();
    return false;
  }

  function _sendBump(cmd) {
    if (typeof DualSession !== 'undefined' && DualSession.sendBoth) {
      DualSession.sendBoth(cmd);
    } else if (typeof wsSend === 'function') {
      wsSend(cmd);
    }
  }

  function _setBtnIdle() {
    const btn = document.getElementById('btn-bump-start');
    if (!btn) return;
    btn.textContent = '▶ Démarrer';
    btn.classList.add('bal-btn-run');
    btn.classList.remove('bal-btn-stop');
  }

  function _setBtnStop() {
    const btn = document.getElementById('btn-bump-start');
    if (!btn) return;
    btn.textContent = '◼ Arrêter';
    btn.classList.add('bal-btn-stop');
    btn.classList.remove('bal-btn-run');
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isStreaming() { return _state === S.STREAMING; }
  function isActive() {
    return _state === S.READY || _state === S.STREAMING || _state === S.WAIT_BINARY;
  }

  function reset(silent) {
    if (_state === S.STREAMING) {
      _sendBump('BUMP_STOP');
    }
    _state = S.IDLE;
    _dual = false;
    _binA = _binB = false;
    if (typeof bumpLiveRunning !== 'undefined') bumpLiveRunning = false;
    if (typeof _bumpStopAnim === 'function') _bumpStopAnim();
    if (typeof _bumpResetLive === 'function') _bumpResetLive();
    if (!silent && typeof bumpSetStatus === 'function') {
      /* leave status as-is on silent module switch */
    }
  }

  /** Entrée module (menu / NAV_ACK=bumptest) — panneau prêt, pas encore de stream. */
  function enter() {
    // NAV_ACK + DualSession.onReady appellent souvent enter() 2× — ignorer le doublon
    if (_state === S.READY || _state === S.STREAMING) return;

    reset(true);
    if (typeof analyseArmDual === 'function') analyseArmDual();
    else if (typeof analyseResetDualSession === 'function') analyseResetDualSession();

    _dual = _isDualWanted();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined') ? DualSession.is() : _dual;

    if (typeof anShowA !== 'undefined') anShowA = true;
    if (typeof anShowB !== 'undefined') anShowB = true;

    anMode = 'bump_wait';
    bumpLiveRunning = false;
    if (typeof _bumpResetLive === 'function') _bumpResetLive();
    if (typeof _bumpStopAnim === 'function') _bumpStopAnim();
    _setBtnIdle();

    _binA = _binB = false;
    _state = S.READY;

    if (typeof _bumpStatusLines !== 'undefined') {
      _bumpStatusLines = [
        _dual ? 'Mode DOUBLE prêt — Démarrer (A+B)' : 'Mode prêt — appuyez Démarrer',
        '',
      ];
    }
    const fsEl = document.getElementById('an-fs');
    if (fsEl && typeof _bumpCfgFs !== 'undefined' && typeof _bumpWindowT === 'function') {
      fsEl.textContent = 'Bump live' + (_dual ? ' DOUBLE' : '') +
        '  FS=' + _bumpCfgFs + ' Hz  Fenetre=' + _bumpWindowT().toFixed(3) +
        ' s  ±' + bumpLiveG + 'g';
    }
    if (typeof anApplyLayoutByMode === 'function') anApplyLayoutByMode();
    const title = document.getElementById('an-bump-title');
    if (title) title.textContent = _dual ? 'MODE BUMP TEST — DOUBLE' : 'MODE BUMP TEST';
    if (typeof bumpSetStatus === 'function') bumpSetStatus('');
    if (typeof showTab === 'function') showTab('analyse');
    if (typeof analyseDraw === 'function') analyseDraw();
    _log('[BUMP] ' + (_dual ? 'DOUBLE prêt' : 'prêt') + ' — ' + S.READY);
  }

  function _startStream() {
    anMag = null; anMagVel = null; anDemodResult = null;
    anData = null; anDataB = null;
    if (typeof analyseArmDual === 'function') analyseArmDual();
    _dual = _isDualWanted();
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();
    _dual = (typeof DualSession !== 'undefined') ? DualSession.is() : _dual;

    _binA = _binB = false;
    _sendBump('BUMP_START');
    bumpLiveRunning = true;
    anMode = 'bump_stream';
    _state = S.STREAMING;
    _setBtnStop();
    if (typeof bumpSetStatus === 'function') {
      bumpSetStatus(_dual
        ? 'Streaming A+B — frappez puis Arrêter'
        : 'Streaming démarré — frappez puis Arrêter');
    }
    if (typeof _bumpResetLive === 'function') _bumpResetLive();
    if (typeof _bumpStartAnim === 'function') _bumpStartAnim();
  }

  function _stopStream() {
    if (_dual && typeof analyseArmDual === 'function') analyseArmDual();
    _sendBump('BUMP_STOP');
    bumpLiveRunning = false;
    if (typeof _bumpStopAnim === 'function') _bumpStopAnim();
    _binA = _binB = false;
    _state = S.WAIT_BINARY;
    _setBtnIdle();
    if (typeof bumpSetStatus === 'function') {
      bumpSetStatus(_dual
        ? 'Arrêt A+B — envoi buffers…'
        : 'Arrêt — envoi buffer complet…');
    }
  }

  /** Bouton Démarrer / Arrêter. */
  function toggleStart() {
    if (_state === S.STREAMING) {
      _stopStream();
      return;
    }
    if (_state === S.READY || _state === S.VIEW || _state === S.WAIT_BINARY) {
      _startStream();
      return;
    }
    // Pas encore entré dans le module
    enter();
    _startStream();
  }

  function _tryView() {
    if (_state !== S.WAIT_BINARY) return;
    if (_dual) {
      if (!_binA || !_binB) return;
      _log('[BUMP] OK — A+B reçus');
    } else if (!_binA) {
      return;
    }
    _state = S.VIEW;
    if (typeof bumpSetStatus === 'function') {
      bumpSetStatus(_dual ? 'Buffers A+B reçus' : 'Buffer reçu');
    }
  }

  function onBinaryA() {
    if (_state !== S.WAIT_BINARY) {
      // Binaire hors stop (rare) : accepter si on streamait encore
      if (_state === S.STREAMING) {
        _state = S.WAIT_BINARY;
        bumpLiveRunning = false;
        if (typeof _bumpStopAnim === 'function') _bumpStopAnim();
      } else {
        return;
      }
    }
    _binA = true;
    if (_dual) _log('[BUMP] A reçu' + (_binB ? ' — OK' : ' — attente B…'));
    _tryView();
  }

  function onBinaryB() {
    if (!_dual) return;
    if (_state !== S.WAIT_BINARY) return;
    _binB = true;
    _log('[BUMP] B reçu' + (_binA ? ' — OK' : ' — attente A…'));
    _tryView();
  }

  function onLive() {
    if (_state === S.READY) {
      _state = S.STREAMING;
      bumpLiveRunning = true;
      anMode = 'bump_stream';
    }
  }

  function exit() {
    const dual = _dual || ((typeof DualSession !== 'undefined') && DualSession.is());
    if (_state === S.STREAMING) {
      if (typeof DualSession !== 'undefined' && dual) DualSession.sendBoth('BUMP_STOP');
      else if (typeof wsSend === 'function') wsSend('BUMP_STOP\n');
    }
    if (typeof DualSession !== 'undefined' && dual) DualSession.stopBoth('r');
    else if (typeof wsSend === 'function') wsSend('r\n');
    reset(true);
    if (typeof analyseResetDualSession === 'function') analyseResetDualSession();
    anMode = 'time';
    if (typeof anApplyLayoutByMode === 'function') anApplyLayoutByMode();
    if (typeof analyseDraw === 'function') analyseDraw();
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isStreaming: isStreaming,
    isActive: isActive,
    enter: enter,
    toggleStart: toggleStart,
    onBinaryA: onBinaryA,
    onBinaryB: onBinaryB,
    onLive: onLive,
    exit: exit,
    reset: reset,
  };
})();

window.BumpSession = BumpSession;

// Compat : anciens noms globaux
function bumpStart() {
  BumpSession.enter();
}
function bumpSendStart() {
  BumpSession.toggleStart();
}
function bumpExit() {
  BumpSession.exit();
}
window.bumpStart = bumpStart;
window.bumpSendStart = bumpSendStart;
window.bumpExit = bumpExit;
