// menu.js — Menu contextuel dans la barre de raccourcis du terminal
// Remplace les boutons 1-9 par des boutons dynamiques qui suivent l'arbre de décision ESP32.

const MenuModule = (() => {

  const L = {
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

  // ──────────────────────────────────────────────────────
  // Init — appelé depuis app.js au DOMContentLoaded
  // ──────────────────────────────────────────────────────
  function init(sendFn, switchTabFn, navGotoFn) {
    _send      = sendFn;
    _switchTab = switchTabFn;
    _navGoto   = navGotoFn || null;
    _container = document.getElementById('menu-tree');
    _render(L.ROOT);
  }

  // ──────────────────────────────────────────────────────
  // Rendu — reconstruit les boutons à chaque changement de niveau
  // ──────────────────────────────────────────────────────
  function _render(level) {
    _level = level;
    if (!_container) return;
    _container.innerHTML = '';

    // ── Fil d'Ariane + Retour ──────────────────────────
    if (_path.length > 0) {
      const nav = document.createElement('div');
      nav.className = 'sc-nav';

      const back = document.createElement('button');
      back.className = 'sc sc-back';
      back.textContent = '← Retour';
      back.onclick = _goBack;
      nav.appendChild(back);

      const crumb = document.createElement('span');
      crumb.className = 'sc-crumb';
      crumb.textContent = _path.join(' › ');
      nav.appendChild(crumb);

      _container.appendChild(nav);
    }

    // ── Boutons du niveau courant ──────────────────────
    _getButtons(level).forEach(btn => {
      const el = document.createElement('button');
      el.className = 'sc sc-menu' + (btn.accent ? ' sc-accent-menu' : '');
      if (btn.sub) {
        el.innerHTML = `<span class="sc-label">${btn.label}</span><span class="sc-sub">${btn.sub}</span>`;
      } else {
        el.textContent = btn.label;
      }
      el.onclick = () => _onChoice(btn);
      _container.appendChild(el);
    });
  }

  // ──────────────────────────────────────────────────────
  // Définition des boutons par niveau
  // ──────────────────────────────────────────────────────
  function _getButtons(level) {
    switch (level) {

      // ── Racine ──────────────────────────────────────
      case L.ROOT: return [
        { label: '⚖ Équilibrage', sub: '1 ou 2 plans',       key: 'eq',      accent: true },
        { label: '📊 Analyse',    sub: 'Temp · FFT · Live',  key: 'analyse'              },
      ];

      // ── Sous-menu Analyse type ───────────────────────
      case L.ANALYSE: return [
        { label: '〜 Temporel',   sub: 'Brut + FFT',      key: 'temporelle'              },
        { label: '🔨 Bump Test',  sub: 'Impulsionnel',    key: 'bump'                    },
        { label: '📈 Live FFT',   sub: 'Spectre continu', key: 'live_fft'                },
        { label: '🔁 Harmonique', sub: '1X 2X 3X phase',  key: 'harmonique'              },
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

      case L.ROOT:
        if (btn.key === 'eq') {
          _path = [];
          _render(L.ROOT);
          if (_navGoto) _navGoto('balance', 'WS_GOTO=EQ');
          else { _send('WS_GOTO=EQ\n'); setTimeout(() => _switchTab('balance'), 200); }
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
          if (_navGoto) {
            _navGoto('fft', 'WS_GOTO=ANAL_LIVE', {
              onAck: () => {
                if (typeof _fftStartDualLive === 'function') _fftStartDualLive();
                else _send('LIVE_START\n');
                fftRunning = true;
                const b = document.getElementById('btn-fft-start');
                if (b) { b.textContent = '■ Stop'; b.classList.add('running'); }
              },
            });
          } else {
            _send('WS_GOTO=ANAL_LIVE\n');
            setTimeout(() => {
              if (typeof _fftStartDualLive === 'function') _fftStartDualLive();
              else _send('LIVE_START\n');
              fftRunning = true;
            }, 200);
            setTimeout(() => _switchTab('fft'), 200);
          }

        } else if (btn.key === 'harmonique') {
          _path = []; _render(L.ROOT);
          if (_navGoto) _navGoto('harmonic', 'WS_GOTO=ANAL_HARM');
          else { _send('WS_GOTO=ANAL_HARM\n'); setTimeout(() => _switchTab('harmonic'), 200); }
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
        
        // 1. Navigation pure vers l'onglet analyse
        if (_navGoto) {
          _navGoto('analyse', 'WS_GOTO=ANAL_TEMP', {
            onAck: () => {
              if (typeof startAnalTemporal === 'function') {
                startAnalTemporal(g, fs);
              } else {
                _send('ANAL_START G=' + g + ' FS=' + fs + '\n');
              }
              // DOUBLE : compteur démarre sur ACQ_PROGRESS (après FIRE), pas pendant ARM
              const dual = (typeof isDualMode === 'function' && isDualMode());
              if (!dual && typeof acqStartTemporal === 'function') {
                acqStartTemporal({ g: g, fs: fs, autoRange: (g === ' ' || g === '') });
              }
              setTimeout(() => _switchTab('analyse'), 300);
            },
            onTimeout: () => {
              console.warn('NAV timeout pour ANAL_TEMP');
              _switchTab('analyse');
            }
          });
        } else {
          // Fallback si pas de navGoto
          _send('WS_GOTO=ANAL_TEMP\n');
          setTimeout(() => {
            if (typeof startAnalTemporal === 'function') startAnalTemporal(g, fs);
            else _send('ANAL_START G=' + g + ' FS=' + fs + '\n');
            if (typeof acqStartTemporal === 'function') {
              acqStartTemporal({ g: g, fs: fs, autoRange: (g === ' ' || g === '') });
            }
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
        if (_navGoto) {
          _navGoto('analyse', cmd, {
            onAck: () => {
              // DOUBLE : même config sur B (NAV_ACK déjà reçu de A)
              if (typeof isDualMode === 'function' && isDualMode() &&
                  typeof wsSendB === 'function') {
                if (typeof termAddLine === 'function') {
                  termAddLine('[DOUBLE] Bump A+B  G=' + g + ' FS=' + fs, 'sys');
                }
                wsSendB(cmd);
              }
              setTimeout(() => _switchTab('analyse'), 150);
            },
            onTimeout: () => _switchTab('analyse'),
          });
        } else {
          _send(cmd + '\n');
          if (typeof isDualMode === 'function' && isDualMode() && typeof wsSendB === 'function') {
            wsSendB(cmd);
          }
          setTimeout(() => _switchTab('analyse'), 250);
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
    if      (_level === L.ANALYSE) { _path = [];                        _render(L.ROOT);    }
    else if (_level === L.G_RANGE) { _path = ['Analyse'];               _render(L.ANALYSE); }
    else if (_level === L.FS)      { _path = ['Analyse', 'Temporel'];   _render(L.G_RANGE); }
    else if (_level === L.BUMP_G)  { _path = ['Analyse'];               _render(L.ANALYSE); }
    else if (_level === L.BUMP_FS) { _path = ['Analyse', 'Bump', 'Plage G']; _render(L.BUMP_G); }
    else                           { _path = [];                        _render(L.ROOT);    }
  }

  function reset() { _path = []; _selectedG = null; _render(L.ROOT); }

  return { init, reset };
})();