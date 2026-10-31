// menu.js — Menu contextuel dans la barre de raccourcis du terminal
// Remplace les boutons 1-9 par des boutons dynamiques qui suivent l'arbre de décision ESP32.

const MenuModule = (() => {

  const L = {
    PROBE:       'probe',
    CONN:        'conn',
    LANG:        'lang',
    ROOT:        'root',
    ANALYSE:     'analyse',
    G_RANGE:     'g_range',
    FS:          'fs',
    BUMP_G:      'bump_g',
    BUMP_FS:     'bump_fs',
    BODE_G:      'bode_g',
    BODE_FS:     'bode_fs',
    SYNC_G:      'sync_g',
    SYNC_FS:     'sync_fs',
  };

  let _send = null, _switchTab = null, _navGoto = null;
  let _level = L.ROOT, _path = [];
  let _selectedG = null;
  let _container = null;

  const BUMP_BUFFER_SAMPLES = 45000;
  const BODE_BUFFER_SAMPLES = 45000;
  const SYNC_BUFFER_SAMPLES = 45000;

  function _tt(key, vars) {
    return (typeof t === 'function') ? t(key, vars) : key;
  }

  function _pathText() {
    return _path.map(function (p) {
      return (p && p.indexOf('menu.') === 0) ? _tt(p) : p;
    }).join(' › ');
  }

  function _bumpReadSec(fsHz) {
    const s = BUMP_BUFFER_SAMPLES / fsHz;
    return s >= 10 ? (Math.round(s) + ' s') : (s.toFixed(1) + ' s');
  }

  function _bodeReadSec(fsHz) {
    const s = BODE_BUFFER_SAMPLES / fsHz;
    return s >= 10 ? (Math.round(s) + ' s') : (s.toFixed(1) + ' s');
  }

  function _syncReadSec(fsHz) {
    const s = SYNC_BUFFER_SAMPLES / fsHz;
    return s >= 10 ? (Math.round(s) + ' s') : (s.toFixed(1) + ' s');
  }

  function _probeSet() {
    return (typeof ProbeMode !== 'undefined' && ProbeMode.isSet());
  }

  function init(sendFn, switchTabFn, navGotoFn) {
    _send      = sendFn;
    _switchTab = switchTabFn;
    _navGoto   = navGotoFn || null;
    _container = document.getElementById('menu-tree');
    if (typeof I18n !== 'undefined' && I18n.onChange) {
      I18n.onChange(function () {
        _render(_level);
        if (typeof I18n.applyDom === 'function') I18n.applyDom();
      });
    }
    if (_probeSet()) _render(L.ROOT);
    else showProbeSelect();
  }

  function _render(level) {
    if (level !== L.PROBE && level !== L.CONN && level !== L.LANG && !_probeSet()) {
      showProbeSelect();
      return;
    }
    _level = level;
    if (!_container) return;
    _container.innerHTML = '';

    if (level === L.PROBE) {
      const nav = document.createElement('div');
      nav.className = 'sc-nav';
      const crumb = document.createElement('span');
      crumb.className = 'sc-crumb';
      crumb.textContent = _tt('menu.crumb.chooseProbe');
      nav.appendChild(crumb);
      _container.appendChild(nav);
    } else if (level === L.ROOT || _path.length > 0) {
      const nav = document.createElement('div');
      nav.className = 'sc-nav';

      const back = document.createElement('button');
      back.className = 'sc sc-back';
      back.textContent = _tt('common.back');
      if (level === L.ROOT) {
        back.onclick = () => {
          if (typeof ProbeMode !== 'undefined') ProbeMode.change();
          else showProbeSelect();
        };
      } else {
        back.onclick = _goBack;
      }
      nav.appendChild(back);

      const crumb = document.createElement('span');
      crumb.className = 'sc-crumb';
      crumb.textContent = level === L.ROOT
        ? (_tt('common.probe') + ' ' + (typeof ProbeMode !== 'undefined' ? ProbeMode.get() : '?'))
        : _pathText();
      nav.appendChild(crumb);

      _container.appendChild(nav);
    }

    _getButtons(level).forEach(btn => {
      const el = document.createElement('button');
      el.className = 'sc sc-menu' + (btn.accent ? ' sc-accent-menu' : '');
      if (btn.disabled) {
        el.disabled = true;
        el.classList.add('sc-disabled');
      }
      if (btn.sub) {
        el.innerHTML = '<span class="sc-label">' + btn.label + '</span><span class="sc-sub">' + btn.sub + '</span>';
      } else {
        el.textContent = btn.label;
      }
      el.onclick = () => { if (!btn.disabled) _onChoice(btn); };
      _container.appendChild(el);
    });
  }

  function _getButtons(level) {
    switch (level) {

      case L.PROBE: {
        const aOk = typeof ProbeMode !== 'undefined' && ProbeMode.aOk();
        const bOk = typeof ProbeMode !== 'undefined' && ProbeMode.bOk();
        return [
          { label: _tt('menu.probeA'),  sub: aOk ? _tt('menu.probeA.ok') : _tt('menu.probeA.off'), key: 'probe_a',  disabled: !aOk },
          { label: _tt('menu.probeB'),  sub: bOk ? _tt('menu.probeB.ok') : _tt('menu.probeB.off'), key: 'probe_b',  disabled: !bOk },
          { label: _tt('menu.probeAB'), sub: (aOk && bOk) ? _tt('menu.probeAB.ok') : _tt('menu.probeAB.off'), key: 'probe_ab', accent: true, disabled: !(aOk && bOk) },
          { label: _tt('menu.conn'),    sub: _tt('menu.conn.sub'), key: 'conn_menu' },
        ];
      }

      case L.CONN: {
        if (typeof isEspScanBusy === 'function' && isEspScanBusy()) {
          return [
            { label: _tt('menu.scanCancel'), sub: _tt('menu.scanCancel.sub'), key: 'conn_scan_cancel', accent: true },
          ];
        }
        const aHost = (typeof ESP32_HOST !== 'undefined' && ESP32_HOST) ? ESP32_HOST : _tt('common.undefined');
        const bHost = (typeof ESP32_HOST_B !== 'undefined' && ESP32_HOST_B) ? ESP32_HOST_B : _tt('common.undefined');
        const lang = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang().toUpperCase() : 'FR';
        return [
          { label: _tt('menu.scan'), sub: _tt('menu.scan.sub'), key: 'conn_scan', accent: true },
          { label: _tt('menu.espA'), sub: aHost, key: 'conn_a' },
          { label: _tt('menu.espB'), sub: bHost, key: 'conn_b' },
          { label: _tt('menu.lang'), sub: lang + ' · ' + _tt('menu.lang.sub'), key: 'conn_lang' },
          { label: _tt('pwa.reset'), sub: _tt('pwa.reset.sub'), key: 'conn_pwa_reset' },
          { label: _tt('menu.reset'), sub: _tt('menu.reset.sub'), key: 'conn_reset' },
          { label: _tt('menu.log'), sub: _tt('menu.log.sub'), key: 'conn_copy_log' },
        ];
      }

      case L.LANG: {
        const cur = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : 'fr';
        return [
          { label: _tt('menu.lang.fr'), sub: _tt('menu.lang.fr.sub'), key: 'lang_fr', accent: cur === 'fr' },
          { label: _tt('menu.lang.en'), sub: _tt('menu.lang.en.sub'), key: 'lang_en', accent: cur === 'en' },
        ];
      }

      case L.ROOT: return [
        { label: _tt('menu.eq'),      sub: _tt('menu.eq.sub'),      key: 'eq',      accent: true },
        { label: _tt('menu.analyse'), sub: _tt('menu.analyse.sub'), key: 'analyse' },
      ];

      case L.ANALYSE: return [
        { label: _tt('menu.temporal'), sub: _tt('menu.temporal.sub'), key: 'temporelle' },
        { label: _tt('menu.bump'),     sub: _tt('menu.bump.sub'),     key: 'bump' },
        { label: _tt('menu.bode'),     sub: _tt('menu.bode.sub'),     key: 'bode' },
        { label: _tt('menu.sync'),     sub: _tt('menu.sync.sub'),     key: 'sync' },
        { label: _tt('menu.liveFft'),  sub: _tt('menu.liveFft.sub'),  key: 'live_fft' },
        { label: _tt('menu.phase'),    sub: _tt('menu.phase.sub'),    key: 'harmonique' },
      ];

      case L.G_RANGE: return [
        { label: '± 2 g',  sub: _tt('menu.g.weak'),   key: 'g2',   cmd: '2'  },
        { label: '± 4 g',  sub: '',                   key: 'g4',   cmd: '4'  },
        { label: '± 8 g',  sub: '',                   key: 'g8',   cmd: '8'  },
        { label: '± 16 g', sub: _tt('menu.g.strong'), key: 'g16',  cmd: '16' },
        { label: _tt('menu.g.auto'), sub: _tt('menu.g.auto.sub'), key: 'auto', cmd: ' ', accent: true },
      ];

      case L.FS: return [
        { label: '1 000 Hz',  sub: _tt('menu.fs.max', { hz: '500 Hz' }),  key: 'fs1',  cmd: '1'  },
        { label: '2 000 Hz',  sub: _tt('menu.fs.max', { hz: '1 kHz' }),   key: 'fs2',  cmd: '2'  },
        { label: '4 000 Hz',  sub: _tt('menu.fs.max', { hz: '2 kHz' }),   key: 'fs4',  cmd: '4'  },
        { label: '8 000 Hz',  sub: _tt('menu.fs.max', { hz: '4 kHz' }),   key: 'fs8',  cmd: '8'  },
        { label: '16 000 Hz', sub: '8 kHz ⭐',                             key: 'fs16', cmd: '16', accent: true },
        { label: '24 000 Hz', sub: _tt('menu.fs.max', { hz: '12 kHz' }),  key: 'fs24', cmd: '24' },
        { label: '32 000 Hz', sub: _tt('menu.fs.max', { hz: '16 kHz' }),  key: 'fs32', cmd: '32' },
      ];

      case L.BUMP_G: return [
        { label: '± 2 g',  sub: _tt('menu.g.bump'),   key: 'bg2',  cmd: '2'  },
        { label: '± 4 g',  sub: '',                   key: 'bg4',  cmd: '4'  },
        { label: '± 8 g',  sub: '',                   key: 'bg8',  cmd: '8'  },
        { label: '± 16 g', sub: _tt('menu.g.strong'), key: 'bg16', cmd: '16' },
      ];

      case L.BUMP_FS: return [
        { label: '1 000 Hz',  sub: _tt('menu.fs.read', { sec: _bumpReadSec(1000) }),  key: 'bfs1',  cmd: '1000'  },
        { label: '2 000 Hz',  sub: _tt('menu.fs.read', { sec: _bumpReadSec(2000) }),  key: 'bfs2',  cmd: '2000'  },
        { label: '4 000 Hz',  sub: _tt('menu.fs.read', { sec: _bumpReadSec(4000) }),  key: 'bfs4',  cmd: '4000'  },
        { label: '8 000 Hz',  sub: _tt('menu.fs.read', { sec: _bumpReadSec(8000) }),  key: 'bfs8',  cmd: '8000'  },
        { label: '16 000 Hz', sub: _tt('menu.fs.read', { sec: _bumpReadSec(16000) }) + ' ⭐', key: 'bfs16', cmd: '16000', accent: true },
        { label: '24 000 Hz', sub: _tt('menu.fs.read', { sec: _bumpReadSec(24000) }), key: 'bfs24', cmd: '24000' },
        { label: '32 000 Hz', sub: _tt('menu.fs.read', { sec: _bumpReadSec(32000) }), key: 'bfs32', cmd: '32000' },
      ];

      case L.BODE_G: return [
        { label: '± 2 g',  sub: _tt('menu.g.bump'),   key: 'odg2',  cmd: '2'  },
        { label: '± 4 g',  sub: '',                   key: 'odg4',  cmd: '4'  },
        { label: '± 8 g',  sub: '',                   key: 'odg8',  cmd: '8'  },
        { label: '± 16 g', sub: _tt('menu.g.strong'), key: 'odg16', cmd: '16' },
        { label: _tt('menu.g.auto'), sub: _tt('menu.g.auto.sub'), key: 'odgauto', cmd: 'auto', accent: true },
      ];

      case L.BODE_FS: return [
        { label: '1 000 Hz',  sub: _tt('menu.fs.read', { sec: _bodeReadSec(1000) }),  key: 'odfs1',  cmd: '1000'  },
        { label: '2 000 Hz',  sub: _tt('menu.fs.read', { sec: _bodeReadSec(2000) }),  key: 'odfs2',  cmd: '2000'  },
        { label: '4 000 Hz',  sub: _tt('menu.fs.read', { sec: _bodeReadSec(4000) }),  key: 'odfs4',  cmd: '4000'  },
        { label: '8 000 Hz',  sub: _tt('menu.fs.read', { sec: _bodeReadSec(8000) }),  key: 'odfs8',  cmd: '8000'  },
        { label: '16 000 Hz', sub: _tt('menu.fs.read', { sec: _bodeReadSec(16000) }) + ' ⭐', key: 'odfs16', cmd: '16000', accent: true },
        { label: '24 000 Hz', sub: _tt('menu.fs.read', { sec: _bodeReadSec(24000) }), key: 'odfs24', cmd: '24000' },
        { label: '32 000 Hz', sub: _tt('menu.fs.read', { sec: _bodeReadSec(32000) }), key: 'odfs32', cmd: '32000' },
      ];

      case L.SYNC_G: return [
        { label: '± 2 g',  sub: _tt('menu.g.weak'),   key: 'syg2',  cmd: '2'  },
        { label: '± 4 g',  sub: '',                   key: 'syg4',  cmd: '4'  },
        { label: '± 8 g',  sub: '',                   key: 'syg8',  cmd: '8'  },
        { label: '± 16 g', sub: _tt('menu.g.strong'), key: 'syg16', cmd: '16' },
        { label: _tt('menu.g.auto'), sub: _tt('menu.g.auto.sub'), key: 'sygauto', cmd: 'auto', accent: true },
      ];

      case L.SYNC_FS: return [
        { label: '1 000 Hz',  sub: _tt('menu.fs.read', { sec: _syncReadSec(1000) }),  key: 'syfs1',  cmd: '1000'  },
        { label: '2 000 Hz',  sub: _tt('menu.fs.read', { sec: _syncReadSec(2000) }),  key: 'syfs2',  cmd: '2000'  },
        { label: '4 000 Hz',  sub: _tt('menu.fs.read', { sec: _syncReadSec(4000) }),  key: 'syfs4',  cmd: '4000'  },
        { label: '8 000 Hz',  sub: _tt('menu.fs.read', { sec: _syncReadSec(8000) }),  key: 'syfs8',  cmd: '8000'  },
        { label: '16 000 Hz', sub: _tt('menu.fs.read', { sec: _syncReadSec(16000) }) + ' ⭐', key: 'syfs16', cmd: '16000', accent: true },
        { label: '24 000 Hz', sub: _tt('menu.fs.read', { sec: _syncReadSec(24000) }), key: 'syfs24', cmd: '24000' },
        { label: '32 000 Hz', sub: _tt('menu.fs.read', { sec: _syncReadSec(32000) }), key: 'syfs32', cmd: '32000' },
      ];

      default: return [];
    }
  }

  function _onChoice(btn) {
    switch (_level) {

      case L.PROBE:
        if (btn.key === 'conn_menu') {
          _path = ['menu.crumb.probe', 'menu.crumb.conn'];
          _render(L.CONN);
          break;
        }
        if (typeof ProbeMode === 'undefined') break;
        if (btn.key === 'probe_a' && ProbeMode.set('A')) {
          _path = []; _render(L.ROOT);
        } else if (btn.key === 'probe_b' && ProbeMode.set('B')) {
          _path = []; _render(L.ROOT);
        } else if (btn.key === 'probe_ab' && ProbeMode.set('AB')) {
          _path = []; _render(L.ROOT);
        }
        break;

      case L.CONN:
        if (btn.key === 'conn_scan_cancel') {
          if (typeof cancelEspScan === 'function') cancelEspScan();
          if (typeof termAddLine === 'function') termAddLine(_tt('app.cancelSearch'), 'sys');
          break;
        }
        if (btn.key === 'conn_scan' && typeof findEspAndPrompt === 'function') {
          findEspAndPrompt().finally(function () {
            if (_level === L.CONN) _render(L.CONN);
          });
          _render(L.CONN);
          break;
        }
        if (btn.key === 'conn_lang') {
          _path = ['menu.crumb.probe', 'menu.crumb.conn', 'menu.lang'];
          _render(L.LANG);
          break;
        }
        if (btn.key === 'conn_a' && typeof changeIpA === 'function') changeIpA();
        else if (btn.key === 'conn_b' && typeof changeIpB === 'function') changeIpB();
        else if (btn.key === 'conn_pwa_reset' && typeof resetPwaInstall === 'function') resetPwaInstall();
        else if (btn.key === 'conn_reset' && typeof clearVaSession === 'function') clearVaSession();
        else if (btn.key === 'conn_copy_log' && typeof termCopyLog === 'function') termCopyLog();
        _render(L.CONN);
        break;

      case L.LANG:
        if (btn.key === 'lang_fr' || btn.key === 'lang_en') {
          const code = btn.key === 'lang_en' ? 'en' : 'fr';
          if (typeof I18n !== 'undefined' && I18n.setLang) I18n.setLang(code);
          if (typeof termAddLine === 'function') {
            termAddLine(_tt('app.langSet', { lang: code.toUpperCase() }), 'ok');
          }
          _path = ['menu.crumb.probe', 'menu.crumb.conn'];
          _render(L.CONN);
        }
        break;

      case L.ROOT:
        if (btn.key === 'eq') {
          _path = [];
          _render(L.ROOT);
          if (typeof BalanceSession !== 'undefined' && BalanceSession.isLive &&
              BalanceSession.isLive()) {
            BalanceSession.start();
            break;
          }
          if (typeof BalanceModule !== 'undefined') {
            const paused = (typeof BalanceSession !== 'undefined' && BalanceSession.isPaused &&
                            BalanceSession.isPaused()) ||
              (BalanceModule.isPaused && BalanceModule.isPaused() &&
               BalanceModule.hasProgress && BalanceModule.hasProgress());
            if (paused) {
              if (confirm(_tt('app.sessionPausedConfirm'))) {
                if (typeof BalanceSession !== 'undefined' && BalanceSession.resume) {
                  BalanceSession.resume();
                } else if (typeof BalanceModule.resumeSession === 'function') {
                  BalanceModule.resumeSession();
                }
                return;
              }
              if (typeof BalanceModule.prepareNewFromMenu === 'function' &&
                  !BalanceModule.prepareNewFromMenu()) {
                return;
              }
            }
          }
          if (typeof BalanceSession !== 'undefined' && BalanceSession.start) {
            BalanceSession.start();
          } else if (typeof DualSession !== 'undefined' && DualSession.available()) {
            DualSession.startModule('balance', 'WS_GOTO=EQ', { label: _tt('menu.eq') });
          } else if (_navGoto) {
            _navGoto('balance', 'WS_GOTO=EQ');
          } else {
            _send('WS_GOTO=EQ\n');
            setTimeout(() => _switchTab('balance'), 200);
          }
        } else if (btn.key === 'analyse') {
          _path = ['menu.crumb.analyse']; _render(L.ANALYSE);
        }
        break;

      case L.ANALYSE:
        if (btn.key === 'temporelle') {
          _path = ['menu.crumb.analyse', 'menu.crumb.temporal']; _render(L.G_RANGE);

        } else if (btn.key === 'bump') {
          _selectedG = null;
          _path = ['menu.crumb.analyse', 'menu.crumb.bump', 'menu.crumb.gRange'];
          _render(L.BUMP_G);

        } else if (btn.key === 'bode') {
          // SM : L.ANALYSE → L.BODE_G → L.BODE_FS → WS_GOTO → BodeModuleSession
          _selectedG = null;
          _path = ['menu.crumb.analyse', 'menu.crumb.bode', 'menu.crumb.gRange'];
          _render(L.BODE_G);

        } else if (btn.key === 'sync') {
          // SM : L.ANALYSE → L.SYNC_G → L.SYNC_FS → WS_GOTO → SyncSession
          _selectedG = null;
          _path = ['menu.crumb.analyse', 'menu.crumb.sync', 'menu.crumb.gRange'];
          _render(L.SYNC_G);

        } else if (btn.key === 'live_fft') {
          _path = []; _render(L.ROOT);
          // enter = page prête ; Start = LIVE_START
          if (typeof FftSession !== 'undefined' && FftSession.enter) FftSession.enter();
          else if (typeof FftSession !== 'undefined' && FftSession.start) FftSession.start();
          else if (typeof fftToggle === 'function') fftToggle();

        } else if (btn.key === 'harmonique') {
          _path = []; _render(L.ROOT);
          // enter = page prête ; Start = HARM_START
          if (typeof PhaseSession !== 'undefined' && PhaseSession.enter) PhaseSession.enter();
          else if (typeof PhaseSession !== 'undefined' && PhaseSession.start) PhaseSession.start();
          else if (typeof HarmonicModule !== 'undefined' && HarmonicModule.harmToggle) {
            HarmonicModule.harmToggle();
          }
        }
        break;

      case L.G_RANGE:
        _selectedG = btn.cmd;
        _path = ['menu.crumb.analyse', 'menu.crumb.temporal', btn.label];
        _render(L.FS);
        break;

      case L.BUMP_G:
        _selectedG = btn.cmd;
        _path = ['menu.crumb.analyse', 'menu.crumb.bump', btn.label, 'menu.crumb.fs'];
        _render(L.BUMP_FS);
        break;

      case L.BODE_G:
        _selectedG = btn.cmd;
        _path = ['menu.crumb.analyse', 'menu.crumb.bode', btn.label, 'menu.crumb.fs'];
        _render(L.BODE_FS);
        break;

      case L.SYNC_G:
        _selectedG = btn.cmd;
        _path = ['menu.crumb.analyse', 'menu.crumb.sync', btn.label, 'menu.crumb.fs'];
        _render(L.SYNC_FS);
        break;

      case L.FS: {
        const g  = _selectedG || '16';
        const fs = btn.cmd;

        // Arme la page Analyse — l'acq part au bouton Démarrer
        const _armTempo = () => {
          if (typeof AnalSession !== 'undefined' && AnalSession.arm) {
            AnalSession.arm({ g: g, fs: fs });
          } else if (typeof AnalSession !== 'undefined' && AnalSession.start) {
            AnalSession.start({ g: g, fs: fs });
          } else if (typeof startAnalTemporal === 'function') {
            startAnalTemporal(g, fs);
          }
        };
        const _tempoReady = () => {
          _armTempo();
          setTimeout(() => {
            if (_switchTab) _switchTab('analyse');
            if (typeof AnalSession !== 'undefined' && AnalSession.syncUi) {
              AnalSession.syncUi();
            }
          }, 300);
        };
        // Duo : même chemin que Bump (A+B NAV_ACK) — évite Start sans B armé
        if (typeof DualSession !== 'undefined' && DualSession.available &&
            DualSession.available() && DualSession.startModule) {
          DualSession.startModule('analyse', 'WS_GOTO=ANAL_TEMP', {
            label: 'Temporel',
            onReady: _tempoReady,
            onFail: _tempoReady,
          });
        } else if (_navGoto) {
          _navGoto('analyse', 'WS_GOTO=ANAL_TEMP', {
            onAck: _tempoReady,
            onTimeout: () => {
              console.warn('NAV timeout pour ANAL_TEMP');
              _tempoReady();
            }
          });
        } else {
          _send('WS_GOTO=ANAL_TEMP\n');
          setTimeout(_tempoReady, 500);
        }

        _path = [];
        _selectedG = null;
        _render(L.ROOT);
        break;
      }

      case L.BUMP_FS: {
        const g = _selectedG || '2';
        const fs = btn.cmd || '4000';
        const cmd = 'WS_GOTO=ANAL_BUMP G=' + g + ' FS=' + fs;
        const bumpReady = () => {
          if (typeof BumpSession !== 'undefined' && BumpSession.enter) BumpSession.enter();
          else if (typeof bumpStart === 'function') bumpStart();
          else if (typeof analyseArmDual === 'function') analyseArmDual();
          setTimeout(() => {
            if (typeof showTab === 'function') showTab('analyse');
            else if (_switchTab) _switchTab('analyse');
          }, 50);
        };
        if (typeof DualSession !== 'undefined') {
          DualSession.startModule('analyse', cmd, {
            label: 'Bump G=' + g + ' FS=' + fs,
            onReady: bumpReady,
            onFail: bumpReady,
          });
        } else if (_navGoto) {
          _navGoto('analyse', cmd, {
            onAck: bumpReady,
            onTimeout: bumpReady,
          });
        } else {
          _send(cmd + '\n');
          setTimeout(bumpReady, 250);
        }
        _path = [];
        _selectedG = null;
        _render(L.ROOT);
        break;
      }

      case L.BODE_FS: {
        const g = _selectedG || '2';
        const fs = btn.cmd || '4000';
        const cmd = 'WS_GOTO=ANAL_BODE G=' + g + ' FS=' + fs;
        const bodeReady = () => {
          if (typeof BodeModule !== 'undefined' && BodeModule.setConfig) {
            BodeModule.setConfig(g, fs, BODE_BUFFER_SAMPLES);
          }
          if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.enter) {
            BodeModuleSession.enter();
          } else if (typeof showTab === 'function') {
            showTab('bode');
          }
        };
        if (_navGoto) {
          _navGoto('bode', cmd, { onAck: bodeReady, onTimeout: bodeReady });
        } else {
          _send(cmd + '\n');
          setTimeout(bodeReady, 300);
        }
        _path = [];
        _selectedG = null;
        _render(L.ROOT);
        break;
      }

      case L.SYNC_FS: {
        const g = _selectedG || '2';
        const fs = btn.cmd || '4000';
        const cmd = 'WS_GOTO=ANAL_SYNC G=' + g + ' FS=' + fs;
        const syncReady = () => {
          if (typeof SyncModule !== 'undefined' && SyncModule.setConfig) {
            SyncModule.setConfig(g, fs, SYNC_BUFFER_SAMPLES);
          }
          if (typeof SyncSession !== 'undefined' && SyncSession.enter) {
            SyncSession.enter();
          } else if (typeof showTab === 'function') {
            showTab('sync');
          }
        };
        if (_navGoto) {
          _navGoto('sync', cmd, { onAck: syncReady, onTimeout: syncReady });
        } else {
          _send(cmd + '\n');
          setTimeout(syncReady, 300);
        }
        _path = [];
        _selectedG = null;
        _render(L.ROOT);
        break;
      }
    }
  }

  function _goBack() {
    if (_level === L.CONN && typeof isEspScanBusy === 'function' && isEspScanBusy()) {
      if (typeof cancelEspScan === 'function') cancelEspScan();
      if (typeof termAddLine === 'function') termAddLine(_tt('app.cancelSearch'), 'sys');
    }
    if      (_level === L.LANG)    { _path = ['menu.crumb.probe', 'menu.crumb.conn']; _render(L.CONN); }
    else if (_level === L.CONN)    { _path = ['menu.crumb.probe']; _render(L.PROBE); }
    else if (_level === L.ANALYSE) { _path = []; _render(L.ROOT); }
    else if (_level === L.G_RANGE) { _path = ['menu.crumb.analyse']; _render(L.ANALYSE); }
    else if (_level === L.FS)      { _path = ['menu.crumb.analyse', 'menu.crumb.temporal']; _render(L.G_RANGE); }
    else if (_level === L.BUMP_G)  { _path = ['menu.crumb.analyse']; _render(L.ANALYSE); }
    else if (_level === L.BUMP_FS) { _path = ['menu.crumb.analyse', 'menu.crumb.bump', 'menu.crumb.gRange']; _render(L.BUMP_G); }
    else if (_level === L.BODE_G)  { _path = ['menu.crumb.analyse']; _render(L.ANALYSE); }
    else if (_level === L.BODE_FS) { _path = ['menu.crumb.analyse', 'menu.crumb.bode', 'menu.crumb.gRange']; _render(L.BODE_G); }
    else if (_level === L.SYNC_G)  { _path = ['menu.crumb.analyse']; _render(L.ANALYSE); }
    else if (_level === L.SYNC_FS) { _path = ['menu.crumb.analyse', 'menu.crumb.sync', 'menu.crumb.gRange']; _render(L.SYNC_G); }
    else                           { _path = []; _render(L.ROOT); }
  }

  function showProbeSelect() {
    _path = ['menu.crumb.probe'];
    _selectedG = null;
    _render(L.PROBE);
  }

  function refreshProbeIfShown() {
    if (_level === L.PROBE) _render(L.PROBE);
    else if (_level === L.CONN) _render(L.CONN);
    else if (_level === L.LANG) _render(L.LANG);
  }

  function reset() {
    _path = [];
    _selectedG = null;
    if (_probeSet()) _render(L.ROOT);
    else showProbeSelect();
  }

  return { init, reset, showProbeSelect, refreshProbeIfShown };
})();
