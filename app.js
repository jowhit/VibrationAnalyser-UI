// app.js — WebSocket, routing, navigation

const ESP_MDNS_HOST = 'vibanalyseur.local';

function _isEspIpv4(host) {
  if (!host || host === 'localhost' || host === '127.0.0.1') return false;
  if (host === '192.168.4.1') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = parseInt(m[i], 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function _isMdnsHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === ESP_MDNS_HOST || h === 'vibanalyseur.local';
}

/** La page est servie par l'ESP32 lui-même (pas par GitHub Pages). */
function _pageServedByEsp() {
  const h = (window.location.hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '192.168.4.1' || _isEspIpv4(h) || _isMdnsHost(h);
}

/** Hôte WebSocket : IP mémorisée. L'origine de la page n'est l'ESP que s'il sert l'UI. */
function resolveEspHost() {
  try {
    const p = new URLSearchParams(window.location.search);
    const q = (p.get('host') || p.get('esp32host') || '').trim().toLowerCase();
    if (q && _isEspIpv4(q)) return q;
    if (q && _isMdnsHost(q)) return ESP_MDNS_HOST;
  } catch (e) {}
  const storedIp = (localStorage.getItem('esp32ip') || '').trim();
  if (storedIp && _isEspIpv4(storedIp)) return storedIp;
  const stored = (localStorage.getItem('esp32host') || '').trim().toLowerCase();
  if (stored && _isEspIpv4(stored)) return stored;
  if (stored && _isMdnsHost(stored)) return ESP_MDNS_HOST;
  if (_pageServedByEsp()) {
    const pageHost = (window.location.hostname || '').trim().toLowerCase();
    if (_isEspIpv4(pageHost)) return pageHost;
    if (_isMdnsHost(pageHost)) return ESP_MDNS_HOST;
  }
  return '';
}

/** IP optionnelle (secours manuel ou affichage). */
function resolveEspIp() {
  try {
    const p = new URLSearchParams(window.location.search);
    const q = (p.get('esp32ip') || p.get('ip') || '').trim();
    if (q && _isEspIpv4(q)) return q;
  } catch (e) {}
  const host = (window.location.hostname || '').trim();
  if (_isEspIpv4(host)) return host;
  const stored = (localStorage.getItem('esp32ip') || '').trim();
  if (stored && _isEspIpv4(stored)) return stored;
  return '';
}

function _updateHostLabel() {
  const lbl = document.getElementById('ip-label');
  if (!lbl) return;
  if (_isEspIpv4(ESP32_HOST)) lbl.textContent = ESP32_HOST;
  else if (ESP32_IP) lbl.textContent = ESP32_IP + ' · mDNS';
  else lbl.textContent = ESP32_HOST;
}

function syncHostFromPage() {
  const host = resolveEspHost();
  const ip = resolveEspIp();
  const changed = (host !== ESP32_HOST);
  ESP32_HOST = host;
  if (host) localStorage.setItem('esp32host', ESP32_HOST);
  if (ip) {
    ESP32_IP = ip;
    localStorage.setItem('esp32ip', ESP32_IP);
  }
  _updateHostLabel();
  if (changed && typeof termAddLine === 'function') {
    termAddLine('-- ESP: ' + ESP32_HOST + (ESP32_IP && ESP32_IP !== ESP32_HOST ? ' (' + ESP32_IP + ')' : '') + ' --', 'sys');
  }
  return true;
}

/** Ping HTTP /ping — teste si l'ESP est joignable sur ce réseau. */
async function pingEspHost(host, timeoutMs) {
  if (!host) return false;
  const ms = timeoutMs || 2500;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch('http://' + host + '/ping', {
      signal: ctrl.signal, mode: 'cors', cache: 'no-store'
    });
    clearTimeout(tid);
    return r.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Trouve l'hôte joignable : IP mémorisée d'abord (Android), puis mDNS (iOS).
 * Sur Android, vibanalyseur.local ne résout souvent pas — l'IP est prioritaire.
 */
async function discoverEspHost() {
  const pageIp = resolveEspIp();
  const storedIp = (localStorage.getItem('esp32ip') || '').trim();
  const seen = {};
  const candidates = [];

  function add(h) {
    if (!h || seen[h]) return;
    seen[h] = true;
    candidates.push(h);
  }

  if (pageIp) add(pageIp);
  if (storedIp) add(storedIp);
  if (_isEspIpv4(ESP32_HOST)) add(ESP32_HOST);
  add(ESP_MDNS_HOST);

  for (let i = 0; i < candidates.length; i++) {
    const h = candidates[i];
    if (await pingEspHost(h)) {
      if (_isEspIpv4(h)) {
        ESP32_IP = h;
        localStorage.setItem('esp32ip', h);
      }
      return h;
    }
  }

  if (storedIp && _isEspIpv4(storedIp)) return storedIp;
  if (pageIp) return pageIp;
  return ESP_MDNS_HOST;
}

(function _initEspFromUrl() {
  const host = resolveEspHost();
  if (host) localStorage.setItem('esp32host', host);
  const ip = resolveEspIp();
  if (ip) localStorage.setItem('esp32ip', ip);
  try {
    if (window.history && window.history.replaceState && window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  } catch (e) {}
})();

let ESP32_HOST = resolveEspHost();
let ESP32_IP = resolveEspIp() || '';
let ws = null;
let _wsFailCount = 0;
let _wsConnecting = false;
let _wsReconnectTimer = null;
let _wsBackoffMs = 3000;
const WS_RECONNECT_BASE_MS = 3000;
const WS_RECONNECT_MAX_MS = 30000;
const WS_FAIL_BEFORE_IP_PROMPT = 5;

function _isSetupPortalPage() {
  const h = (window.location.hostname || '').trim();
  return h === '192.168.4.1';
}

function _scheduleWsReconnect() {
  if (_isSetupPortalPage()) return;
  if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
  _wsReconnectTimer = setTimeout(() => {
    _wsReconnectTimer = null;
    wsConnect();
  }, _wsBackoffMs);
  _wsBackoffMs = Math.min(Math.round(_wsBackoffMs * 1.6), WS_RECONNECT_MAX_MS);
}

// État réception binaire
// Modes : 'text' | 'fft_hdr' | 'fft_bin' | 'an_hdr' | 'an_bin'
//          'bal_hdr' | 'bal_bin' | 'harm_hdr' | 'harm_bin'
let rxState   = 'text';
let rxHeaders = {};

// Tracker blocs texte multi-lignes (filtre terminal)
let _eqParsing   = false;

let _heartbeatTimer = null;
let _lastAliveMs = 0;
const WS_HEARTBEAT_MS = 5000;
const WS_ALIVE_TIMEOUT_MS = 12000;

function _markWsAlive() {
  _lastAliveMs = Date.now();
}

function _startHeartbeat() {
  _stopHeartbeat();
  _markWsAlive();
  _heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - _lastAliveMs > WS_ALIVE_TIMEOUT_MS) {
      termAddLine('-- ESP injoignable (timeout) --', 'sys');
      ws.close();
      return;
    }
    ws.send('WS_PING\n');
  }, WS_HEARTBEAT_MS);
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}
let _activeTab = localStorage.getItem('lastTab') || 'term';

// Navigation ESP : attente NAV_ACK après WS_GOTO
let _navPending = false;
let _navTimeoutId = null;
let _navOpts = null;
const NAV_ACK_TIMEOUT_MS = 2500;

function _normalizeHostInput(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/\/.*$/, '');
  s = s.replace(/:81$/, '');
  return s;
}

function applyEspHost(host, reconnect) {
  if (!host) return;
  const next = _normalizeHostInput(host).toLowerCase();
  if (!next) return;
  if (!_isMdnsHost(next) && !_isEspIpv4(next)) {
    if (typeof termAddLine === 'function') {
      termAddLine('!! Adresse invalide — IP ou vibanalyseur.local', 'sys');
    }
    return;
  }
  const useHost = _isMdnsHost(next) ? ESP_MDNS_HOST : next;
  const changed = (useHost !== ESP32_HOST);
  ESP32_HOST = useHost;
  localStorage.setItem('esp32host', ESP32_HOST);
  if (_isEspIpv4(useHost)) {
    ESP32_IP = useHost;
    localStorage.setItem('esp32ip', ESP32_IP);
  }
  _updateHostLabel();
  if (changed && typeof termAddLine === 'function') {
    termAddLine('-- ESP: ' + ESP32_HOST + ' --', 'sys');
  }
  if (reconnect && ws && ws.readyState === WebSocket.OPEN) return;
  if (reconnect) {
    if (ws) { try { ws.close(); } catch (e) {} }
    setTimeout(wsConnect, 400);
  }
}

function applyEspIp(ip, reconnect) {
  if (!ip) return;
  const next = _normalizeHostInput(ip);
  if (!next || !_isEspIpv4(next)) return;
  const changed = (next !== ESP32_HOST);
  ESP32_IP = next;
  ESP32_HOST = next;
  localStorage.setItem('esp32ip', ESP32_IP);
  localStorage.setItem('esp32host', ESP32_HOST);
  _updateHostLabel();
  if (changed && typeof termAddLine === 'function') {
    termAddLine('-- IP ESP: ' + ESP32_IP + ' --', 'sys');
  }
  if (reconnect && ws && ws.readyState === WebSocket.OPEN) return;
  if (reconnect) {
    if (ws) { try { ws.close(); } catch (e) {} }
    setTimeout(wsConnect, 400);
  }
}

function hideIpBanner() {
  const el = document.getElementById('ip-banner');
  if (el) el.style.display = 'none';
}

function usePageHostIp() {
  const pageHost = (window.location.hostname || '').trim().toLowerCase();
  if (_isMdnsHost(pageHost)) {
    applyEspHost(ESP_MDNS_HOST, true);
  } else if (_isEspIpv4(pageHost)) {
    applyEspIp(pageHost, true);
  } else {
    applyEspHost(ESP_MDNS_HOST, true);
  }
  _wsFailCount = 0;
  hideIpBanner();
}

function ipBannerReconnect() {
  const inp = document.getElementById('ip-banner-input');
  if (!inp || !inp.value.trim()) {
    wsConnect();
    return;
  }
  const v = inp.value.trim();
  if (_isEspIpv4(v)) applyEspIp(v, true);
  else applyEspHost(v, true);
  _wsFailCount = 0;
  hideIpBanner();
}

function showIpReconnectBanner() {
  syncHostFromPage();
  const el = document.getElementById('ip-banner');
  if (!el) return;
  el.style.display = 'block';
  const inp = document.getElementById('ip-banner-input');
  if (inp) inp.value = ESP32_IP || ESP32_HOST || '';
  const hint = document.getElementById('ip-banner-hint');
  if (hint) {
    var mixed = window.location.protocol === 'https:';
    hint.innerHTML = mixed
      ? 'IP mémorisée dans ce navigateur. Connexion <b>ws://IP:81</b>. Une page HTTPS peut bloquer ce WebSocket non chiffré.'
      : 'Entre l\'IP de l\'ESP32. Connexion <b>ws://IP:81</b>. L\'interface reste utilisable sans capteur.';
  }
}

function _wsConnectTo(host) {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ESP32_HOST = host;
  localStorage.setItem('esp32host', host);
  if (_isEspIpv4(host)) {
    ESP32_IP = host;
    localStorage.setItem('esp32ip', host);
  }
  _updateHostLabel();
  hideIpBanner();
  const url = 'ws://' + host + ':81';
  termAddLine('Connexion: ' + url, 'sys');
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    _wsFailCount = 0;
    _wsBackoffMs = WS_RECONNECT_BASE_MS;
    hideIpBanner();
    _markWsAlive();
    setDot('ok', ESP32_HOST);
    termAddLine('-- connecte --', 'sys');
    _startHeartbeat();
    if (_activeTab === 'calc' || _activeTab === 'demod') showTab(_activeTab);
    if (typeof BalanceModule !== 'undefined') BalanceModule.init(wsSend);
    setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('WS_GOTO=SYNC\n'); }, 300);
  };

  ws.onclose = (e) => {
    setDot('off', 'Deconnecte');
    _stopHeartbeat();
    rxState = 'text'; rxHeaders = {}; _eqParsing = false;
    _wsFailCount++;
    if (!ESP32_HOST || _wsFailCount >= WS_FAIL_BEFORE_IP_PROMPT) {
      termAddLine('-- ESP déconnecté — entre l\'IP si besoin --', 'sys');
      showIpReconnectBanner();
      if (window.location.protocol === 'https:') return;
    } else {
      termAddLine('-- deconnecte code=' + e.code + ' retry ' + Math.round(_wsBackoffMs / 1000) + 's --', 'sys');
    }
    if (ESP32_HOST) _scheduleWsReconnect();
  };

  ws.onerror = () => setDot('err', 'Erreur');

  ws.onmessage = (e) => {
    _markWsAlive();
    if (typeof e.data === 'string') handleText(e.data);
    else if (e.data instanceof ArrayBuffer) handleBinary(e.data);
  };
}

async function wsConnect() {
  if (_isSetupPortalPage()) return;
  if (_wsConnecting) return;
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  syncHostFromPage();
  if (!ESP32_HOST) {
    setDot('off', 'ESP déconnecté');
    showIpReconnectBanner();
    if (typeof termAddLine === 'function') {
      termAddLine('-- pas d\'IP ESP32 — interface locale seulement --', 'sys');
    }
    return;
  }

  var host = ESP32_HOST;
  if (_pageServedByEsp() && window.location.protocol !== 'https:') {
    _wsConnecting = true;
    try { host = await discoverEspHost(); } catch (e) {}
    _wsConnecting = false;
  } else if (window.location.protocol === 'https:') {
    termAddLine('-- page HTTPS, WebSocket ws://' + host + ':81 --', 'sys');
  }

  if (!host) {
    setDot('off', 'ESP déconnecté');
    showIpReconnectBanner();
    return;
  }
  _wsConnectTo(host);
}

function handleText(raw) {
  raw.split('\n').forEach(line => {
    line = line.trim();
    if (!line) return;

    // ── PONG ──────────────────────────────────────────────────
    if (line === 'WS_PONG' || line === 'PONG') {
      _markWsAlive();
      return;
    }

    if (line.startsWith('WIFI_READY=')) {
      const v = line.slice(11).trim();
      if (_isEspIpv4(v)) {
        applyEspIp(v, true);
      } else if (_isMdnsHost(v)) {
        discoverEspHost().then((h) => { if (h) _wsConnectTo(h); });
      }
      return;
    }
    if (line.startsWith('WIFI_IP=')) {
      const ip = line.slice(8).trim();
      if (_isEspIpv4(ip) && ip !== ESP32_IP) {
        applyEspIp(ip, true);
      } else if (_isEspIpv4(ip)) {
        applyEspIp(ip, false);
      }
      return;
    }
    if (line.startsWith('WiFi reconnecte - IP ')) {
      applyEspIp(line.slice(22), true);
      return;
    }

    // ── NAV_ACK / SYS_STATE (texte, avant modes binaires) ────
    if (line.startsWith('NAV_ACK=')) {
      const mod = line.slice(8).trim();
      if (_navPending) {
        if (_navTimeoutId) { clearTimeout(_navTimeoutId); _navTimeoutId = null; }
        _navPending = false;
        const o = _navOpts;
        _navOpts = null;
        if (mod === 'bumptest') {
          showTab('analyse');
          if (typeof bumpStart === 'function') bumpStart();
        } else if (mod) {
          showTab(mod);
          if (mod === 'balance' && typeof BalanceModule !== 'undefined' && typeof BalanceModule.enterBalance === 'function') {
            BalanceModule.enterBalance();
          }
        }
        if (o && typeof o.onAck === 'function') o.onAck();
      }
      return;
    }
    if (line.startsWith('SYS_STATE=')) {
      const mod = line.slice(10).trim();
      if (mod === 'bumptest') {
        showTab('analyse');
        if (typeof bumpStart === 'function') bumpStart();
      } else if (mod) {
        showTab(mod);
      }
      return;
    }
    if (line.startsWith('BUMP_STATUS=')) {
      const txt = line.slice(12).trim();
      if (typeof bumpSetStatus === 'function') bumpSetStatus(txt);
      return;
    }
    if (line.startsWith('BUMP_LIVE=')) {
      const v = parseInt(line.slice(10), 10);
      if (typeof bumpReceiveLive === 'function') bumpReceiveLive(v);
      return;
    }
    if (line.startsWith('BUMP_CFG=')) {
      const payload = line.slice(9).trim();
      const g = /G=(\d+)/.exec(payload);
      const f = /FS=(\d+)/.exec(payload);
      const n = /N=(\d+)/.exec(payload);
      if (typeof bumpSetConfig === 'function') {
        bumpSetConfig(g ? g[1] : '', f ? f[1] : '', n ? n[1] : '');
      }
      return;
    }

    // ── BAL_TOUR → mode binaire balance (doit être avant BAL_ général) ──
    if (line === 'BAL_TOUR') {
      rxState = 'bal_hdr'; rxHeaders = {};
      return;
    }
    if (rxState === 'bal_hdr') {
      if (line.startsWith('RPM='))   { rxHeaders.rpm   = parseFloat(line.slice(4));  return; }
      if (line.startsWith('N='))     { rxHeaders.n     = parseInt(line.slice(2));    return; }
      if (line.startsWith('RANGE=')) {
        rxHeaders.range = parseInt(line.slice(6));
        rxState = 'bal_bin';
        return;
      }
      return;
    }

    // ── HARM_BIN → mode binaire harmonique (doit être avant BAL_ général) ──
    if (line === 'HARM_BIN') {
      rxState = 'harm_hdr'; rxHeaders = {};
      if (typeof HarmonicModule !== 'undefined') HarmonicModule.setRunning(true);
      return;
    }
    if (rxState === 'harm_hdr') {
      if (line.startsWith('G='))   { rxHeaders.g   = parseInt(line.slice(2));   return; }
      if (line.startsWith('F='))   { rxHeaders.fs  = parseFloat(line.slice(2)); return; }
      if (line.startsWith('RPM=')) { rxHeaders.rpm = parseFloat(line.slice(4)); return; }
      if (line.startsWith('N='))   {
        rxHeaders.n = parseInt(line.slice(2));
        rxState = 'harm_bin';
        return;
      }
      return;
    }

    // ── BalanceModule — tous les messages BAL_ et EQ_ ─────────
    if (typeof BalanceModule !== 'undefined' &&
        (line.startsWith('BAL_') || line.startsWith('EQ_') || _eqParsing)) {
      BalanceModule.onData(line);
      // Diagnostic jitter équilibrage (voir BalancingCore) — doit apparaître au terminal
      if (line.startsWith('BAL_JIT') || line.startsWith('BAL_JITTER_LOG')) {
        termAddLine(line);
        return;
      }
      // Filtrer du terminal les messages fréquents
      if (line.startsWith('BAL_RPM=') ||
          line.startsWith('BAL_STATE=') ||
          line.startsWith('BAL_ERR=') ||
          line.startsWith('BAL_COEFF_') ||
          line === 'EQ_RESULT' || line === 'EQ_RUNX' || line === 'EQ_END' ||
          _eqParsing) {
        if (line === 'EQ_RESULT' || line === 'EQ_RUNX') _eqParsing = true;
        if (line === 'EQ_END')                           _eqParsing = false;
        return;
      }
      return;
    }

    // ── ACQ_PROGRESS → compte à rebours acquisition ───────────
    if (line.startsWith('ACQ_PROGRESS=')) {
      if (typeof acqShowProgress === 'function') acqShowProgress(line.slice(13));
      return;
    }

    // ── LIVE_FFT_BLOC → Live FFT ──────────────────────────────
    if (line === 'LIVE_FFT_BLOC') {
      rxState = 'fft_hdr'; rxHeaders = {}; return;
    }
    // ── BINARY_MODE → Analyse temporelle ──────────────────────
    if (line === 'BINARY_MODE') {
      rxState = 'an_hdr'; rxHeaders = {};
      if (typeof acqSetTransferPhase === 'function') acqSetTransferPhase();
      return;
    }

    // ── CRC header (tous modes binaires) ────────────────────
    if (line.startsWith('CRC=') && rxState !== 'text') {
      rxHeaders.crc = parseInt(line.slice(4));
      return;
    }

    // ── Lecture headers binaires communs ──────────────────────
    if (rxState === 'fft_hdr' || rxState === 'an_hdr') {
      if (line.startsWith('G=')) { rxHeaders.g  = parseFloat(line.slice(2)); return; }
      if (line.startsWith('F=')) { rxHeaders.fs = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T=')) { rxHeaders.t  = parseFloat(line.slice(2)); return; }
      if (line.startsWith('N=')) {
        rxHeaders.n = parseInt(line.slice(2));
        rxState = rxState === 'fft_hdr' ? 'fft_bin' : 'an_bin';
        return;
      }
    }

    termAddLine(line);
  });
}

function _crc16(buf) {
  var crc = 0xFFFF;
  var bytes = new Uint8Array(buf);
  for (var i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (var b = 0; b < 8; b++)
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

function _crcCheck(buf, expected) {
  if (expected === undefined) return true;
  var got = _crc16(buf);
  if (got !== expected) {
    termAddLine('!! CRC ERREUR: attendu=' + expected + ' recu=' + got, 'sys');
    return false;
  }
  return true;
}

function handleBinary(buf) {
  const h = rxHeaders;

  if (!_crcCheck(buf, h.crc)) {
    rxState = 'text';
    return;
  }

  if (rxState === 'fft_bin') {
    rxState = 'text';
    fftReceiveBloc(h.g, h.fs, h.n, new Int16Array(buf));

  } else if (rxState === 'an_bin') {
    rxState = 'text';
    analyseReceiveBloc(h.g, h.fs, h.t || (h.n / h.fs), h.n, new Int16Array(buf));

  } else if (rxState === 'bal_bin') {
    rxState = 'text';
    if (typeof BalanceModule !== 'undefined') {
      BalanceModule.onTourBinary(h.rpm, h.range, h.n, new Int16Array(buf));
    }

  } else if (rxState === 'harm_bin') {
    rxState = 'text';
    if (typeof HarmonicModule !== 'undefined') {
      HarmonicModule.onHarmBinary(h.g, h.fs, h.rpm, h.n, new Int16Array(buf));
    }
  }
}

function wsSend(cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    termAddLine('!! non connecte', 'sys'); return;
  }
  const clean = cmd.replace(/\n+$/, '');
  ws.send(clean + '\n');
  if (clean.trim() && clean !== 'WS_PING') termAddLine('>> ' + clean, 'sent');
}

// ── Navigation ──────────────────────────────────────────────
const ALL_TABS = ['term', 'fft', 'analyse', 'calc', 'balance', 'harmonic', 'demod'];

function showTab(name) {
  _activeTab = name;
  localStorage.setItem('lastTab', name);
  ALL_TABS.forEach(n => {
    const el = document.getElementById('page-' + n);
    if (el) el.style.display = (n === name) ? 'flex' : 'none';
  });
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', ALL_TABS[i] === name);
  });
  if (name === 'fft')      setTimeout(fftDraw,     50);
  if (name === 'analyse')  setTimeout(analyseDraw,  50);
  if (name === 'balance')  setTimeout(() => {
    if (typeof BalanceModule  !== 'undefined') BalanceModule.resize();
  }, 50);
  if (name === 'harmonic') setTimeout(() => {
    if (typeof HarmonicModule !== 'undefined') HarmonicModule.resize();
  }, 50);
  if (name === 'demod') setTimeout(() => {
    if (typeof demodDraw !== 'undefined') demodDraw();
  }, 50);
}

/**
 * Envoie WS_GOTO=… et n’appelle showTab qu’après NAV_ACK (timeout 2,5 s).
 * @param {string} tab - id onglet (cf. showTab)
 * @param {string} cmdLine - ex. 'WS_GOTO=EQ' sans \\n final
 * @param {{ onAck?: function, onTimeout?: function }} [opts]
 */
function wsGoto(tab, cmdLine, opts) {
  if (_navPending) {
    termAddLine('!! navigation en cours', 'sys');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    termAddLine('!! non connecte', 'sys');
    return;
  }
  const clean = cmdLine.replace(/\n+$/, '');
  if (clean.startsWith('WS_GOTO=ANAL_TEMP ') || clean.startsWith('WS_GOTO=ANAL_LIVE ')) {
    termAddLine('!! format invalide: WS_GOTO sans parametres', 'sys');
    return;
  }
  _navPending = true;
  _navOpts = opts || null;
  ws.send(clean + '\n');
  if (clean.trim() && clean !== 'WS_PING') termAddLine('>> ' + clean, 'sent');
  _navTimeoutId = setTimeout(() => {
    _navTimeoutId = null;
    _navPending = false;
    const o = _navOpts;
    _navOpts = null;
    termAddLine('!! NAV timeout (pas de NAV_ACK)', 'sys');
    if (o && typeof o.onTimeout === 'function') o.onTimeout();
  }, NAV_ACK_TIMEOUT_MS);
}
window.wsGoto = wsGoto;

function setDot(state, label) {
  document.getElementById('dot').className =
    state === 'ok' ? 'ok' : state === 'err' ? 'err' : '';
  document.getElementById('ip-label').textContent = label;
}

function changeIP() {
  const h = prompt('IP de l\'ESP32 (ws://IP:81) :', ESP32_IP || ESP32_HOST || '');
  if (h === null) return;
  const v = h.trim();
  _wsFailCount = 0;
  if (!v) {
    showIpReconnectBanner();
    return;
  }
  if (_isEspIpv4(_normalizeHostInput(v))) applyEspIp(v, true);
  else applyEspHost(v, true);
}
window.ipBannerReconnect = ipBannerReconnect;
window.usePageHostIp = usePageHostIp;

/**
 * Efface les données de session côté navigateur (équilibrage, onglet mémorisé),
 * remet l’équilibrage côté ESP (BAL_RESET) et revient au terminal.
 */
function clearVaSession() {
  if (!confirm('Effacer la session mémorisée et revenir au terminal ?')) return;
  try {
    localStorage.removeItem('va_balance_v1');
    localStorage.setItem('lastTab', 'term');
    if (typeof anPersistClear === 'function') anPersistClear();
  } catch (e) {}
  if (typeof BalanceModule !== 'undefined' && typeof BalanceModule.clearSession === 'function') {
    BalanceModule.clearSession();
  }
  _activeTab = 'term';
  showTab('term');
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend('BAL_RESET');
    wsGoto('term', 'WS_GOTO=term');
  }
}
window.clearVaSession = clearVaSession;

window.addEventListener('resize', () => { fftDraw(); analyseDraw(); });

document.addEventListener('DOMContentLoaded', () => {
  syncHostFromPage();
  var lastTab = localStorage.getItem('lastTab') || 'term';
  if (typeof _anPersistRestore === 'function' && _anPersistRestore()) {
    anUpdateStats();
    anApplyLayoutByMode();
    anUpdateBtnStates();
    if (lastTab === 'analyse') setTimeout(analyseDraw, 60);
  }
  showTab(lastTab);
  if (typeof MenuModule     !== 'undefined') MenuModule.init(wsSend, showTab, wsGoto);
  if (typeof HarmonicModule !== 'undefined') HarmonicModule.init();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  // Reconnexion WS si nécessaire
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    wsConnect();
  }

  // Android vide les canvas quand la page est en arrière-plan → redessiner
  setTimeout(() => {
    if (_activeTab === 'analyse' && typeof analyseDraw === 'function') {
      analyseDraw();
    }
    if (_activeTab === 'fft' && typeof fftDraw === 'function') {
      fftDraw();
    }
    if (_activeTab === 'balance' && typeof BalanceModule !== 'undefined') {
      BalanceModule.resize();
    }
    if (_activeTab === 'harmonic' && typeof HarmonicModule !== 'undefined') {
      HarmonicModule.resize();
    }
    if (_activeTab === 'demod' && typeof demodDraw === 'function') {
      demodDraw();
    }
  }, 80);
});

if (!_isSetupPortalPage()) wsConnect();