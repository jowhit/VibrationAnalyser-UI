// anal-session.js — Machine d'états : acquisition temporelle (mono + duo)
//
// États :
//   IDLE → ARMING (duo) → ACQUIRING → TRANSFERRING → READY
//   IDLE → ACQUIRING (mono) → TRANSFERRING → READY
//   * → ERROR | IDLE (abort / changement de module)
//
// Entrée unique : AnalSession.start({ g, fs })
// Menu terminal et tout autre chemin DOIVENT passer par ici.

const AnalSession = (() => {
  const S = {
    IDLE: 'IDLE',
    /** Params G/Fs choisis — attend bouton Démarrer (pas d'acq auto). */
    ARMED: 'ARMED',
    ARMING: 'ARMING',
    ACQUIRING: 'ACQUIRING',
    TRANSFERRING: 'TRANSFERRING',
    READY: 'READY',
    ERROR: 'ERROR',
  };

  let _state = S.IDLE;
  let _dual = false;
  let _g = '';
  let _fs = '';
  let _timer = null;
  let _armA = false;
  let _armB = false;
  let _capA = false;
  let _capB = false;
  let _binA = false;
  let _binB = false;

  function _log(msg) {
    if (typeof termAddLine === 'function') termAddLine(msg, 'sys');
  }

  function _clearTimer() {
    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
    }
  }

  function _setState(next) {
    if (_state === next) return;
    _state = next;
  }

  function _isDualWanted() {
    if (typeof DualSession !== 'undefined') return DualSession.available();
    if (typeof isDualMode === 'function') return isDualMode();
    return false;
  }

  function _params() {
    return 'G=' + _g + ' FS=' + _fs;
  }

  function getState() { return _state; }
  function isDual() { return _dual; }
  function isActive() {
    return _state === S.ARMED || _state === S.ARMING ||
      _state === S.ACQUIRING || _state === S.TRANSFERRING;
  }

  function _showTempoStart(on) {
    const btn = document.getElementById('btn-an-tempo-start');
    const bar = document.getElementById('an-tempo-cmdbar');
    if (bar) bar.style.display = on ? 'flex' : 'none';
    if (btn) {
      btn.disabled = !on;
      btn.textContent = (typeof t === 'function') ? t('common.start') : '▶ Démarrer';
      btn.classList.add('bal-btn-run');
      btn.classList.remove('bal-btn-stop');
    }
  }

  /** Reset propre (wsGoto / changement module / erreur). */
  function reset(silent) {
    _clearTimer();
    const was = _state;
    _state = S.IDLE;
    _dual = false;
    _armA = _armB = false;
    _capA = _capB = false;
    _binA = _binB = false;
    _showTempoStart(false);
    if (!silent && was !== S.IDLE && was !== S.READY && typeof acqHideProgress === 'function') {
      acqHideProgress();
    }
  }

  /**
   * Après choix G/Fs au menu : page Analyse prête, acq au bouton.
   * @param {{ g: string|number, fs: string|number }} opts
   */
  function arm(opts) {
    opts = opts || {};
    reset(true);
    _g = (opts.g != null && opts.g !== '') ? String(opts.g) : '16';
    _fs = (opts.fs != null && opts.fs !== '') ? String(opts.fs) : '16';
    _setState(S.ARMED);
    const bumpPanel = document.getElementById('an-bump-panel');
    if (bumpPanel) bumpPanel.style.display = 'none';
    if (typeof anMode !== 'undefined') anMode = 'time';
    _showTempoStart(true);
    const el = document.getElementById('an-fs');
    if (el) {
      const gLbl = (_g === ' ' || _g === '') ? 'AUTO' : ('±' + _g + 'g');
      el.textContent = 'Prêt — ' + gLbl + '  FS=' + _fs + ' — Démarrer';
    }
    if (typeof showTab === 'function') showTab('analyse');
    _log('[TEMPO] ARMED — appuyer Démarrer');
  }

  function toggleStart() {
    // Démarrer uniquement après arm() via Terminal — jamais depuis READY
    // (évite de relancer une acq pendant le traitement / affichage).
    if (_state === S.ARMED) {
      start({ g: _g, fs: _fs });
    }
  }

  function abort(msg) {
    if (_state === S.IDLE || _state === S.READY) return;
    _clearTimer();
    _log('[TEMPO] !! ' + msg);
    if (typeof acqHideProgress === 'function') acqHideProgress();
    _setState(S.ERROR);
    _dual = false;
    _timer = setTimeout(function () { reset(true); }, 50);
  }

  function _fireNow() {
    if (_state !== S.ARMING) return;
    _clearTimer();
    _capA = false;
    _capB = false;
    _setState(S.ACQUIRING);
    _log('[DOUBLE] FIRE A+B (capture sync)');
    // B puis A : A est souvent le plus réactif WiFi — réduit l'écart de départ
    if (typeof DualSession !== 'undefined' && DualSession.sendBoth) {
      if (typeof wsSendB === 'function') wsSendB('ANAL_FIRE');
      if (typeof wsSend === 'function') wsSend('ANAL_FIRE');
    } else {
      if (typeof wsSend === 'function') wsSend('ANAL_FIRE');
    }
    _timer = setTimeout(function () {
      abort('timeout capture (pas de CAP_OK) — firmware à jour sur A et B ?');
    }, 60000);
  }

  function _sendBoth() {
    if (_state !== S.ACQUIRING) return;
    if (!_capA || !_capB) return;
    _clearTimer();
    _binA = false;
    _binB = false;
    _setState(S.TRANSFERRING);
    _log('[DOUBLE] SEND A+B (parallèle)');
    if (typeof acqSetTransferPhase === 'function') acqSetTransferPhase();
    // Même ordre B→A pour le transfert (parallèle sur 2 WS)
    if (typeof wsSendB === 'function') wsSendB('ANAL_SEND');
    if (typeof wsSend === 'function') wsSend('ANAL_SEND');
    _timer = setTimeout(function () {
      abort('timeout transfert A+B');
    }, 60000);
  }

  function _markReadyIfComplete() {
    if (_state !== S.TRANSFERRING) return;
    if (_dual) {
      if (!_binA || !_binB) return;
      _clearTimer();
      _log('[DOUBLE] OK — A+B reçus');
      _setState(S.READY);
      // Pas de Démarrer après transfert — seulement via Terminal → arm()
      _showTempoStart(false);
      return;
    }
    if (!_binA) return;
    _clearTimer();
    _setState(S.READY);
    _showTempoStart(false);
  }

  /**
   * Entrée unique acquisition temporelle.
   * @param {{ g: string|number, fs: string|number }} opts
   */
  function start(opts) {
    opts = opts || {};
    const g = (opts.g != null && opts.g !== '') ? String(opts.g) : (_g || '16');
    const fs = (opts.fs != null && opts.fs !== '') ? String(opts.fs) : (_fs || '16');

    const keepArmed = (_state === S.ARMED);
    reset(true);
    _g = g;
    _fs = fs;
    _showTempoStart(false);

    if (typeof analyseArmDual === 'function') analyseArmDual();
    _dual = _isDualWanted();
    // begin() peut avoir échoué si wsGoto a end() — réaffirmer
    if (_dual && typeof DualSession !== 'undefined') DualSession.begin();

    const params = _params();
    if (keepArmed) _log('[TEMPO] Start ' + params);

    if (!_dual) {
      _setState(S.ACQUIRING);
      if (typeof wsSend === 'function') wsSend('ANAL_START ' + params);
      if (typeof acqStartTemporal === 'function') {
        acqStartTemporal({
          g: g,
          fs: fs,
          autoRange: (g === ' ' || g === ''),
        });
      }
      return;
    }

    // Duo : ARM → FIRE → SEND (overlay démarre sur ACQ_PROGRESS après FIRE)
    _armA = false;
    _armB = false;
    _setState(S.ARMING);
    _log('[DOUBLE] ARM A+B — ' + params);
    const armCmd = 'ANAL_ARM ' + params;
    if (typeof wsSend === 'function') wsSend(armCmd);
    if (typeof wsSendB === 'function') wsSendB(armCmd);
    _timer = setTimeout(function () {
      if (_state !== S.ARMING) return;
      if (_armA || _armB) {
        _log('[DOUBLE] !! un seul ARM_OK — FIRE quand même');
        _fireNow();
      } else {
        abort('timeout ARM — flashe le firmware (pas seulement LittleFS) sur A et B');
      }
    }, 25000);
  }

  function onArmOk(fromB) {
    if (_state !== S.ARMING) return;
    if (fromB) _armB = true;
    else _armA = true;
    _log('[' + (fromB ? 'B' : 'A') + '] ARM_OK');
    if (_armA && _armB) _fireNow();
  }

  function onCapOk(fromB) {
    if (_state !== S.ACQUIRING) return;
    if (fromB) _capB = true;
    else _capA = true;
    _log('[' + (fromB ? 'B' : 'A') + '] CAP_OK');
    _sendBoth();
  }

  function onBinaryA() {
    if (_state === S.ACQUIRING && !_dual) {
      // Mono : le binaire arrive après ANAL_START (pas de phase SEND explicite côté JS)
      _setState(S.TRANSFERRING);
    }
    if (_state !== S.TRANSFERRING && _state !== S.ACQUIRING) return;
    if (_state === S.ACQUIRING && _dual) return; // duo : attendre SEND
    if (_state === S.ACQUIRING) _setState(S.TRANSFERRING);
    _binA = true;
    if (_dual) {
      _log('[DOUBLE] A reçu' + (_binB ? ' — OK' : ' — attente B…'));
    }
    _markReadyIfComplete();
  }

  function onBinaryB() {
    if (!_dual) return;
    if (_state !== S.TRANSFERRING) return;
    _binB = true;
    _log('[DOUBLE] B reçu' + (_binA ? ' — OK' : ' — attente A…'));
    _markReadyIfComplete();
  }

  /** Compat : ancienne API startAnalTemporal(g, fs). */
  function startAnalTemporal(g, fs) {
    start({ g: g, fs: fs });
  }

  return {
    S: S,
    getState: getState,
    isDual: isDual,
    isActive: isActive,
    arm: arm,
    toggleStart: toggleStart,
    start: start,
    startAnalTemporal: startAnalTemporal,
    reset: reset,
    abort: abort,
    onArmOk: onArmOk,
    onCapOk: onCapOk,
    onBinaryA: onBinaryA,
    onBinaryB: onBinaryB,
  };
})();

window.AnalSession = AnalSession;
window.startAnalTemporal = function (g, fs) {
  AnalSession.startAnalTemporal(g, fs);
};
window._dualOnBinaryA = function () { AnalSession.onBinaryA(); };
window._dualOnBinaryB = function () { AnalSession.onBinaryB(); };
