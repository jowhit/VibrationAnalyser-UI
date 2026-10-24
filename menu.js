// menu.js — Menu contextuel dans la barre de raccourcis du terminal
// Remplace les boutons 1-9 par des boutons dynamiques qui suivent l'arbre de décision ESP32.

const MenuModule = (() => {

  const L = {
    PROBE:       'probe',        // choix sonde A / B / A+B
    CONN:        'conn',         // IP ESP A/B + reset session
    ROOT:        'root',
    ANALYSE:     'analyse',      // sous-menu Analyse type
    G_RANGE:     'g_range',      // choix plage ±g
    FS:          'fs',           // choix fréquence échantillonnage
    BUMP_G:      'bump_g',
    BUMP_FS:     'bump_fs',
  };

  let _send = null, _switchTab = null, _navGoto = null;
  let _level = L.ROOT, _path = [];
  let _selectedG = null;
  let _container = null;

  const BUMP_BUFFER_SAMPLES = 45000;

  function _bumpReadSec(fsHz) {
    const s = BUMP_BUFFER_SAMPLES / fsHz;
    return s >= 10 ? (Math.round(s) + ' s') : (s.toFixed(1) + ' s');
  }

  function _probeSet() {
    return (typeof ProbeMode !== 'undefined' && ProbeMode.isSet());
  }

  // ──────────────────────────────────────────────────────
  // Init — appelé depuis app.js au DOMContentLoaded
  // ──────────────────────────────────────────────────────
  function init(sendFn, switchTabFn, navGotoFn) {
    _send      = sendFn;
    _switchTab = switchTabFn;
    _navGoto   = navGotoFn || null;
    _container = document.getElementById('menu-tree');
    if (_probeSet()) _render(L.ROOT);
    else showProbeSelect();
  }

  // ──────────────────────────────────────────────────────
  // Rendu — reconstruit les boutons à chaque changement de niveau
  // ──────────────────────────────────────────────────────
  function _render(level) {
    // Pas de modules tant que la sonde n'est pas choisie (Connexion OK sans sonde)
    if (level !== L.PROBE && level !== L.CONN && !_probeSet()) {
      showProbeSelect();
      return;
    }
    _level = level;
    if (!_container) return;
    _container.innerHTML = '';

    // ── Fil d'Ariane + Retour ──────────────────────────
    // PROBE : titre seul (pas de retour — rien derrière)
    // ROOT  : Retour → choix sonde
    // sinon : Retour dans l'arbre Analyse
    if (level === L.PROBE) {
      const nav = document.createElement('div');
      nav.className = 'sc-nav';
      const crumb = document.createElement('span');
      crumb.className = 'sc-crumb';
      crumb.textContent = 'Choisir sonde';
      nav.appendChild(crumb);
      _container.appendChild(nav);
    } else if (level === L.ROOT || _path.length > 0) {
      const nav = document.createElement('div');
      nav.className = 'sc-nav';

      const back = document.createElement('button');
      back.className = 'sc sc-back';
      back.textContent = '← Retour';
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
        ? ('Sonde ' + (typeof ProbeMode !== 'undefined' ? ProbeMode.get() : '?'))
        : _path.join(' › ');
      nav.appendChild(crumb);

      _container.appendChild(nav);
    }

    // ── Boutons du niveau courant ──────────────────────
    _getButtons(level).forEach(btn => {
      const el = document.createElement('button');
      el.className = 'sc sc-menu' + (btn.accent ? ' sc-accent-menu' : '');
      if (btn.disabled) {
        el.disabled = true;
        el.classList.add('sc-disabled');
      }
      if (btn.sub) {
        el.innerHTML = `<span class="sc-label">${btn.label}</span><span class="sc-sub">${btn.sub}</span>`;
      } else {
        el.textContent = btn.label;
      }
      el.onclick = () => { if (!btn.disabled) _onChoice(btn); };
      _container.appendChild(el);
    });
  }

  // ──────────────────────────────────────────────────────
  // Définition des boutons par niveau
  // ──────────────────────────────────────────────────────
  function _getButtons(level) {
    switch (level) {

      case L.PROBE: {
        const aOk = typeof ProbeMode !== 'undefined' && ProbeMode.aOk();
        const bOk = typeof ProbeMode !== 'undefined' && ProbeMode.bOk();
        return [
          { label: 'Sonde A',  sub: aOk ? 'ESP A connecté' : 'ESP A hors ligne', key: 'probe_a',  disabled: !aOk },
          { label: 'Sonde B',  sub: bOk ? 'ESP B connecté' : 'ESP B hors ligne', key: 'probe_b',  disabled: !bOk },
          { label: 'A + B',    sub: (aOk && bOk) ? 'Mode duo' : 'A et B requis', key: 'probe_ab', accent: true, disabled: !(aOk && bOk) },
          { label: '🔌 Connexion', sub: 'IP · reset · copier log', key: 'conn_menu' },
        ];
      }

      case L.CONN: {
        const aHost = (typeof ESP32_HOST !== 'undefined' && ESP32_HOST) ? ESP32_HOST : 'non défini';
        const bHost = (typeof ESP32_HOST_B !== 'undefined' && ESP32_HOST_B) ? ESP32_HOST_B : 'non défini';
        return [
          { label: 'ESP A', sub: aHost, key: 'conn_a' },
          { label: 'ESP B', sub: bHost, key: 'conn_b' },
          { label: 'Reset', sub: 'NVS + éq.', key: 'conn_reset' },
          { label: '📋 Log', sub: 'Copier terminal', key: 'conn_copy_log', accent: true },
        ];
      }

      // ── Racine ──────────────────────────────────────
      case L.ROOT: return [
        { label: 'Equilibrage',   sub: '1 ou 2 plans',       key: 'eq',      accent: true },
        { label: '📊 Analyse',    sub: 'Temp · FFT · Live',  key: 'analyse'              },
      ];

      // ── Sous-menu Analyse type ───────────────────────
      case L.ANALYSE: return [
        { label: '〜 Temporel',   sub: 'Brut + FFT',      key: 'temporelle'              },
        { label: '🔨 Bump Test',  sub: 'Impulsionnel',    key: 'bump'                    },
        { label: '📈 Live FFT',   sub: 'Spectre continu', key: 'live_fft'                },
        { label: 'Phase',         sub: 'Harmonique · Suivi', key: 'harmonique'            },
      ];

      // ── Choix plage ±g ───────────────────────────────
      case L.G_RANGE: return [
        { label: '± 2 g',   sub: 'Faible',   key: 'g2',   cmd: '2'  },
        { label: '± 4 g',   sub: '',          key: 'g4',   cmd: '4'  },
        { label: '± 8 g',   sub: '',          key: 'g8',   cmd: '8'  },
        { label: '± 16 g',  sub: 'Fort',      key: 'g16',  cmd: '16' },
        { label: '✨ Auto',  sub: 'Détection', key: 'auto', cmd: ' ', accent: true },
      ];

      // ── Choix fréquence d'échantillonnage ────────────
      case L.FS: return [
        { label: '1 000 Hz',  sub: '500 Hz max',  key: 'fs1',  cmd: '1'  },
        { label: '2 000 Hz',  sub: '1 kHz max',   key: 'fs2',  cmd: '2'  },
        { label: '4 000 Hz',  sub: '2 kHz max',   key: 'fs4',  cmd: '4'  },
        { label: '8 000 Hz',  sub: '4 kHz max',   key: 'fs8',  cmd: '8'  },
        { label: '16 000 Hz', sub: '8 kHz ⭐',    key: 'fs16', cmd: '16', accent: true },
        { label: '24 000 Hz', sub: '12 kHz max',  key: 'fs24', cmd: '24' },
        { label: '32 000 Hz', sub: '16 kHz max',  key: 'fs32', cmd: '32' },
      ];

      case L.BUMP_G: return [
        { label: '± 2 g',  sub: 'Bump', key: 'bg2',  cmd: '2'  },
        { label: '± 4 g',  sub: '',      key: 'bg4',  cmd: '4'  },
        { label: '± 8 g',  sub: '',      key: 'bg8',  cmd: '8'  },
        { label: '± 16 g', sub: 'Fort',  key: 'bg16', cmd: '16' },
      ];

      case L.BUMP_FS: return [
        { label: '1 000 Hz',  sub: 'lecture ' + _bumpReadSec(1000),  key: 'bfs1',  cmd: '1000'  },
        { label: '2 000 Hz',  sub: 'lecture ' + _bumpReadSec(2000),  key: 'bfs2',  cmd: '2000'  },
        { label: '4 000 Hz',  sub: 'lecture ' + _bumpReadSec(4000),  key: 'bfs4',  cmd: '4000'  },
        { label: '8 000 Hz',  sub: 'lecture ' + _bumpReadSec(8000),  key: 'bfs8',  cmd: '8000'  },
        { label: '16 000 Hz', sub: 'lecture ' + _bumpReadSec(16000) + ' ⭐', key: 'bfs16', cmd: '16000', accent: true },
        { label: '24 000 Hz', sub: 'lecture ' + _bumpReadSec(24000), key: 'bfs24', cmd: '24000' },
        { label: '32 000 Hz', sub: 'lecture ' + _bumpReadSec(32000), key: 'bfs32', cmd: '32000' },
      ];

      default: return [];
    }
  }

  // ──────────────────────────────────────────────────────
  // Gestion des choix
  // ──────────────────────────────────────────────────────
  function _onChoice(btn) {
    switch (_level) {

      case L.PROBE:
        if (btn.key === 'conn_menu') {
          _path = ['Sonde', 'Connexion'];
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
        if (btn.key === 'conn_a' && typeof changeIpA === 'function') changeIpA();
        else if (btn.key === 'conn_b' && typeof changeIpB === 'function') changeIpB();
        else if (btn.key === 'conn_reset' && typeof clearVaSession === 'function') clearVaSession();
        else if (btn.key === 'conn_copy_log' && typeof termCopyLog === 'function') termCopyLog();
        _render(L.CONN);
        break;

      case L.ROOT:
        if (btn.key === 'eq') {
          _path = [];
          _render(L.ROOT);
          // Entrée unique BalanceSession
          if (typeof BalanceSession !== 'undefined' && BalanceSession.isLive &&
              BalanceSession.isLive()) {
            BalanceSession.start(); // déjà LIVE → réaffiche l'onglet
            break;
          }
          if (typeof BalanceModule !== 'undefined') {
            const paused = (typeof BalanceSession !== 'undefined' && BalanceSession.isPaused &&
                            BalanceSession.isPaused()) ||
              (BalanceModule.isPaused && BalanceModule.isPaused() &&
               BalanceModule.hasProgress && BalanceModule.hasProgress());
            if (paused) {
              if (confirm('Session d\'équilibrage en pause.\n\nOK = Reprendre\nAnnuler = choisir…')) {
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
            DualSession.startModule('balance', 'WS_GOTO=EQ', { label: 'Équilibrage' });
          } else if (_navGoto) {
            _navGoto('balance', 'WS_GOTO=EQ');
          } else {
            _send('WS_GOTO=EQ\n');
            setTimeout(() => _switchTab('balance'), 200);
          }
        } else if (btn.key === 'analyse') {
          _path = ['Analyse']; _render(L.ANALYSE);
        }
        break;

      case L.ANALYSE:
        if (btn.key === 'temporelle') {
          _path = ['Analyse', 'Temporel']; _render(L.G_RANGE);

        } else if (btn.key === 'bump') {
          _selectedG = null;
          _path = ['Analyse', 'Bump', 'Plage G'];
          _render(L.BUMP_G);

        } else if (btn.key === 'live_fft') {
          _path = []; _render(L.ROOT);
          // Entrée unique machine d'états
          if (typeof FftSession !== 'undefined' && FftSession.start) FftSession.start();
          else if (typeof fftToggle === 'function') fftToggle();

        } else if (btn.key === 'harmonique') {
          _path = []; _render(L.ROOT);
          // Entrée unique machine d'états
          if (typeof PhaseSession !== 'undefined' && PhaseSession.start) PhaseSession.start();
          else if (typeof HarmonicModule !== 'undefined' && HarmonicModule.harmToggle) {
            HarmonicModule.harmToggle();
          }
        }
        break;

      case L.G_RANGE:
        _selectedG = btn.cmd;
        _path = ['Analyse', 'Temporel', btn.label];
        _render(L.FS);
        break;

      case L.BUMP_G:
        _selectedG = btn.cmd;
        _path = ['Analyse', 'Bump', btn.label, 'Fs'];
        _render(L.BUMP_FS);
        break;

      case L.FS: {
        const g  = _selectedG || '16';
        const fs = btn.cmd;

        // Entrée unique : AnalSession.start (mono + duo) — plus de if dual ici
        const _startTempo = () => {
          if (typeof AnalSession !== 'undefined' && AnalSession.start) {
            AnalSession.start({ g: g, fs: fs });
          } else if (typeof startAnalTemporal === 'function') {
            startAnalTemporal(g, fs);
          } else {
            _send('ANAL_START G=' + g + ' FS=' + fs + '\n');
          }
        };
        if (_navGoto) {
          _navGoto('analyse', 'WS_GOTO=ANAL_TEMP', {
            onAck: () => {
              _startTempo();
              setTimeout(() => _switchTab('analyse'), 300);
            },
            onTimeout: () => {
              console.warn('NAV timeout pour ANAL_TEMP');
              _switchTab('analyse');
            }
          });
        } else {
          _send('WS_GOTO=ANAL_TEMP\n');
          setTimeout(() => {
            _startTempo();
            _switchTab('analyse');
          }, 500);
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
        // Toujours armer le panneau Bump (an-bump-panel) — sinon onglet Analyse vide
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
          // B reçoit le GOTO en parallèle de A (pas après NAV_ACK) — mode AB seulement
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
    }
  }

  // ──────────────────────────────────────────────────────
  // Navigation Retour
  // ──────────────────────────────────────────────────────
  function _goBack() {
    if      (_level === L.CONN)    { _path = ['Sonde'];                 _render(L.PROBE);   }
    else if (_level === L.ANALYSE) { _path = [];                        _render(L.ROOT);    }
    else if (_level === L.G_RANGE) { _path = ['Analyse'];               _render(L.ANALYSE); }
    else if (_level === L.FS)      { _path = ['Analyse', 'Temporel'];   _render(L.G_RANGE); }
    else if (_level === L.BUMP_G)  { _path = ['Analyse'];               _render(L.ANALYSE); }
    else if (_level === L.BUMP_FS) { _path = ['Analyse', 'Bump', 'Plage G']; _render(L.BUMP_G); }
    else                           { _path = [];                        _render(L.ROOT);    }
  }

  function showProbeSelect() {
    _path = ['Sonde'];
    _selectedG = null;
    _render(L.PROBE);
  }

  /** Re-dessine les boutons sonde quand A/B connecte/déconnecte. */
  function refreshProbeIfShown() {
    if (_level === L.PROBE) _render(L.PROBE);
    else if (_level === L.CONN) _render(L.CONN);
  }

  function reset() {
    _path = [];
    _selectedG = null;
    if (_probeSet()) _render(L.ROOT);
    else showProbeSelect();
  }

  return { init, reset, showProbeSelect, refreshProbeIfShown };
})();
