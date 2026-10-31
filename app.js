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

// ── Inversion d'axe par IP (même FW A/B — décision côté browser) ──
// Auto : dernier octet 84 toujours inversé (boîtier retourné).
// Manuel : localStorage (invert 85, invertA, …) en plus.
const INVERT_LS_KEY = 'esp_invert_ips';
/** Octets finaux toujours inversés — même firmware, flip JS uniquement. */
const INVERT_AUTO_LAST_OCTETS = ['84'];

function _invertLoad() {
  try {
    const raw = localStorage.getItem(INVERT_LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (e) { return []; }
}

function _invertSave(list) {
  try { localStorage.setItem(INVERT_LS_KEY, JSON.stringify(list)); } catch (e) {}
}

/** "84" → ".84" ; ".84" / "10.42.0.84" inchangés. */
function _invertNormToken(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return '';
  if (/^\d{1,3}$/.test(s)) return '.' + s;
  return s;
}

function _hostMatchesInvertToken(host, token) {
  if (!host || !token) return false;
  const h = String(host).trim().toLowerCase();
  const t = _invertNormToken(token);
  if (!t) return false;
  if (t.charAt(0) === '.') {
    const oct = t.slice(1);
    return h.endsWith(t) || h.split('.').pop() === oct;
  }
  return h === t;
}

function _probeHost(which) {
  if (which === 'B') return (ESP32_HOST_B || '').trim();
  return (ESP32_IP || ESP32_HOST || '').trim();
}

function _hostAutoInvert(host) {
  if (!host || !_isEspIpv4(host)) return false;
  const last = String(host).trim().split('.').pop();
  return INVERT_AUTO_LAST_OCTETS.indexOf(last) >= 0;
}

/** true si le boîtier A ou B doit être inversé (selon son IP). */
function probeAxisInvert(which) {
  const host = _probeHost(which);
  if (!host) return false;
  if (_hostAutoInvert(host)) return true;
  return _invertLoad().some(function (t) { return _hostMatchesInvertToken(host, t); });
}

function applyAxisInvertIfNeeded(which, int16) {
  if (!int16 || !probeAxisInvert(which)) return int16;
  const out = new Int16Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = (-int16[i]) | 0;
  return out;
}

function applyAxisInvertScalar(which, v) {
  return probeAxisInvert(which) ? -v : v;
}

/**
 * Commande moniteur : invert | invert 84 | invert .84 | invert off
 * @returns {boolean} true si commande locale (ne pas envoyer à l'ESP)
 */
function handleInvertCommand(raw) {
  const parts = String(raw || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  if (cmd !== 'invert' && cmd !== 'invertA' && cmd !== 'invertB') return false;

  const list = _invertLoad();
  const arg = (parts[1] || '').trim().toLowerCase();

  // invert seul (ou ?) → statut
  if (cmd === 'invert' && (!arg || arg === '?' || arg === 'status')) {
    const a = _probeHost('A') || '(A non défini)';
    const b = _probeHost('B') || '(B non défini)';
    termAddLine('invert AUTO: …' + INVERT_AUTO_LAST_OCTETS.map(function (o) {
      return '.' + o;
    }).join(', '), 'sys');
    termAddLine('invert extra: ' + (list.length ? list.join(', ') : '(aucun)'), 'sys');
    termAddLine('  A ' + a + ' → ' + (probeAxisInvert('A') ? 'INVERSE' : 'normal') +
      (_hostAutoInvert(a) ? ' (auto)' : ''), 'sys');
    termAddLine('  B ' + b + ' → ' + (probeAxisInvert('B') ? 'INVERSE' : 'normal') +
      (_hostAutoInvert(b) ? ' (auto)' : ''), 'sys');
    termAddLine('Usage: invert 85  |  invertA  |  invertB  |  invert off', 'sys');
    return true;
  }

  if (arg === 'off' || arg === 'clear' || arg === 'none' || arg === '0') {
    _invertSave([]);
    termAddLine('invert: toutes les IP désactivées', 'sys');
    return true;
  }

  // invert 84  → IP ; invertA / invertB → IP du slot actuel
  let token = arg;
  if (cmd === 'inverta' && !arg) token = _probeHost('A');
  if (cmd === 'invertb' && !arg) token = _probeHost('B');
  token = _invertNormToken(token);
  if (!token) {
    termAddLine('invert: IP manquante (ex. invert 84)', 'sys');
    return true;
  }

  const idx = list.findIndex(function (t) {
    return _invertNormToken(t) === token ||
      _hostMatchesInvertToken(token, t) ||
      _hostMatchesInvertToken(t, token);
  });
  if (idx >= 0) {
    list.splice(idx, 1);
    _invertSave(list);
    termAddLine('invert OFF: ' + token, 'sys');
  } else {
    list.push(token);
    _invertSave(list);
    termAddLine('invert ON: ' + token +
      ' (A=' + (probeAxisInvert('A') ? 'oui' : 'non') +
      ' B=' + (probeAxisInvert('B') ? 'oui' : 'non') + ')', 'sys');
  }
  return true;
}
window.handleInvertCommand = handleInvertCommand;
window.probeAxisInvert = probeAxisInvert;

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
 * IPv4 locales du téléphone (WebRTC) — pour scanner le même /24 que le hotspot.
 */
function _rtcLocalIpv4s() {
  return new Promise(function (resolve) {
    const found = [];
    const seen = {};
    let done = false;
    function addIp(ip) {
      if (!ip || seen[ip]) return;
      if (ip.indexOf('127.') === 0 || ip === '0.0.0.0') return;
      // Lien local IPv4 inutilisable pour scan /24
      if (ip.indexOf('169.254.') === 0) return;
      seen[ip] = true;
      found.push(ip);
    }
    function harvestSdp(sdp) {
      if (!sdp) return;
      const re = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/g;
      let m;
      while ((m = re.exec(sdp)) !== null) addIp(m[1]);
    }
    function finish() {
      if (done) return;
      done = true;
      try { pc.close(); } catch (e) {}
      resolve(found);
    }
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      resolve([]);
      return;
    }
    const t = setTimeout(finish, 2800);
    pc.createDataChannel('x');
    pc.onicecandidate = function (ev) {
      if (!ev || !ev.candidate || !ev.candidate.candidate) {
        if (ev && !ev.candidate) {
          clearTimeout(t);
          finish();
        }
        return;
      }
      const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(ev.candidate.candidate);
      if (m) addIp(m[1]);
    };
    pc.createOffer().then(function (o) {
      return pc.setLocalDescription(o).then(function () {
        try { harvestSdp(pc.localDescription && pc.localDescription.sdp); } catch (e2) {}
      });
    }).catch(finish);
  });
}

function _subnetBase(ip) {
  const p = String(ip || '').split('.');
  if (p.length !== 4) return null;
  return p[0] + '.' + p[1] + '.' + p[2];
}

/**
 * Scan parallèle /ping sur un /24 (ou plage autour d'une IP connue).
 * @returns {Promise<string[]>} IPs qui répondent
 */
/** Annulation scan IP manuel (menu Connexion). */
let _espScanAbort = null;

function isEspScanBusy() { return !!_espScanAbort; }
function cancelEspScan() {
  if (_espScanAbort) _espScanAbort.aborted = true;
}

async function scanEspSubnet(opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 500;
  const concurrency = opts.concurrency || 32;
  /** Arrêt dès N ESP trouvés (2 = A+B) — évite scan complet /24 inutile. */
  const stopAfter = opts.stopAfter != null ? opts.stopAfter : 0;
  const isAborted = typeof opts.isAborted === 'function'
    ? opts.isAborted
    : function () { return !!(opts.signal && opts.signal.aborted); };
  const bases = {};
  const hosts = [];
  const seenH = {};
  let stopScan = false;

  function addHost(h) {
    if (!h || !_isEspIpv4(h) || seenH[h]) return;
    seenH[h] = true;
    hosts.push(h);
  }
  function addBase(b) {
    if (!b || bases[b]) return;
    bases[b] = true;
  }
  function prioritizeAround(ip) {
    if (!_isEspIpv4(ip)) return;
    addBase(_subnetBase(ip));
    const last = parseInt(ip.split('.')[3], 10);
    for (let d = 0; d <= 40; d++) {
      if (last + d <= 254) addHost(_subnetBase(ip) + '.' + (last + d));
      if (d > 0 && last - d >= 1) addHost(_subnetBase(ip) + '.' + (last - d));
    }
  }

  // Bases : IP locales WebRTC + IP mémorisées A/B + hôtes connus
  const rtc = await _rtcLocalIpv4s();
  if (isAborted()) return [];
  if (typeof termAddLine === 'function' && rtc.length) {
    termAddLine('[scan] interfaces: ' + rtc.join(', '), 'sys');
  }
  rtc.forEach(function (ip) { addBase(_subnetBase(ip)); });
  prioritizeAround((localStorage.getItem('esp32ip') || '').trim());
  prioritizeAround((localStorage.getItem('esp32ip_a') || '').trim());
  prioritizeAround((localStorage.getItem('esp32ip_b') || '').trim());
  if (_isEspIpv4(ESP32_HOST)) prioritizeAround(ESP32_HOST);
  if (_isEspIpv4(ESP32_HOST_B)) prioritizeAround(ESP32_HOST_B);
  // Hotspots Android / Windows / Linux fréquents (+ 10.x SoftAP Android aléatoire via WebRTC)
  ['192.168.43', '192.168.137', '10.42.0', '192.168.173', '192.168.1',
   '192.168.0', '192.168.44', '192.168.49', '172.20.10'].forEach(addBase);

  Object.keys(bases).forEach(function (b) {
    for (let i = 1; i <= 254; i++) addHost(b + '.' + i);
  });

  if (typeof termAddLine === 'function') {
    termAddLine('[scan] ' + hosts.length + ' hôtes, ' + Object.keys(bases).length +
      ' sous-réseau(x)' + (stopAfter ? (', stop@' + stopAfter) : ''), 'sys');
  }

  const found = [];
  let idx = 0;
  async function worker() {
    while (idx < hosts.length) {
      if (isAborted() || stopScan) return;
      const i = idx++;
      const h = hosts[i];
      if (await pingEspHost(h, timeoutMs)) {
        if (found.indexOf(h) < 0) found.push(h);
        if (stopAfter > 0 && found.length >= stopAfter) stopScan = true;
      }
    }
  }
  const nW = Math.min(concurrency, hosts.length);
  const jobs = [];
  for (let w = 0; w < nW; w++) jobs.push(worker());
  await Promise.all(jobs);
  return found;
}

/**
 * Trouve l'hôte joignable : IP mémorisée, mDNS, puis scan subnet hotspot.
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

  // Scan réseau local (hotspot Android : IP DHCP a changé)
  if (typeof termAddLine === 'function') {
    termAddLine(t('app.scanNet'), 'sys');
  }
  try {
    const found = await scanEspSubnet({
      timeoutMs: 450,
      concurrency: 36,
      stopAfter: 2
    });
    if (found.length) {
      const h = found[0];
      ESP32_IP = h;
      localStorage.setItem('esp32ip', h);
      // 2e IP → B si libre
      if (found.length > 1 && (!ESP32_HOST_B || ESP32_HOST_B === h)) {
        const b = found[1];
        if (b !== h) {
          ESP32_HOST_B = b;
          localStorage.setItem('esp32ip_b', b);
        }
      }
      if (typeof termAddLine === 'function') {
        termAddLine(t('app.espFound', { list: found.join(', ') }), 'ok');
      }
      return h;
    }
  } catch (e) {
    if (typeof termAddLine === 'function') {
      termAddLine(t('app.scanFail', { err: (e && e.message ? e.message : e) }), 'sys');
    }
  }

  // Ne pas réutiliser une IP morte (sinon boucle 1006)
  return '';
}

/** Menu Connexion — scan manuel ; résultats dans le terminal (copier-coller). */
async function findEspAndPrompt() {
  function line(msg, kind) {
    if (typeof termAddLine === 'function') termAddLine(msg, kind || 'sys');
  }
  if (_espScanAbort) {
    line(t('app.searchBusy'), 'sys');
    return { busy: true };
  }
  const abort = { aborted: false };
  _espScanAbort = abort;
  line(t('app.searchEsp'), 'sys');
  let found = [];
  try {
    found = await scanEspSubnet({
      timeoutMs: 450,
      concurrency: 36,
      stopAfter: 2,
      isAborted: function () { return !!abort.aborted; }
    });
  } catch (e) {
    line(t('app.scanImpossible', { err: (e && e.message ? e.message : e) }), 'sys');
    return { error: true };
  } finally {
    if (_espScanAbort === abort) _espScanAbort = null;
  }
  if (abort.aborted) {
    line(t('app.searchCancel'), 'sys');
    return { cancelled: true };
  }
  if (!found.length) {
    line(t('app.noneFound'), 'sys');
    line('Astuce: entre l\'IP affichée au Serial USB (WIFI_IP=…) — le scan a besoin du bon /24 (WebRTC).', 'sys');
    return { empty: true };
  }
  line(t('app.foundList', { n: found.length }), 'ok');
  for (let i = 0; i < found.length; i++) {
    line('  ' + found[i], 'ok');
  }
  const host = found[0];
  _wsFailCount = 0;
  if (typeof applyEspIp === 'function') applyEspIp(host, true);
  else {
    ESP32_IP = host;
    localStorage.setItem('esp32ip', host);
    _wsConnectTo(host);
  }
  if (found.length > 1) {
    const b = found[1];
    if (b !== host) {
      ESP32_HOST_B = b;
      localStorage.setItem('esp32ip_b', b);
      _wsFailCountB = 0;
      setTimeout(function () { wsConnectB(); }, 400);
      line('[B] IP auto: ' + b, 'ok');
    }
  }
  line(found.length > 1
    ? t('app.connectedAMore', { host: host })
    : t('app.connectedA', { host: host }), 'ok');
  return { ok: true, host: host, found: found };
}
window.findEspAndPrompt = findEspAndPrompt;
window.scanEspSubnet = scanEspSubnet;
window.isEspScanBusy = isEspScanBusy;
window.cancelEspScan = cancelEspScan;

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
// ESP B (optionnel) — même firmware, 2e boîtier
let ESP32_HOST_B = (localStorage.getItem('esp32ip_b') || '').trim();
if (ESP32_HOST_B && !_isEspIpv4(ESP32_HOST_B) && !_isMdnsHost(ESP32_HOST_B)) ESP32_HOST_B = '';

let ws = null;
let wsB = null;
let _wsFailCount = 0;
let _wsFailCountB = 0;
let _wsConnecting = false;
let _wsConnectingB = false;
let _wsReconnectTimer = null;
let _wsReconnectTimerB = null;
let _wsBackoffMs = 3000;
let _wsBackoffMsB = 3000;
const WS_RECONNECT_BASE_MS = 3000;
const WS_RECONNECT_MAX_MS = 30000;
const WS_FAIL_BEFORE_IP_PROMPT = 5;

/** true si A et B ont un WebSocket ouvert (physique). */
function isDualMode() {
  return !!(ws && ws.readyState === WebSocket.OPEN &&
            wsB && wsB.readyState === WebSocket.OPEN);
}
window.isDualMode = isDualMode;

/**
 * Couche SONDE — avant Équilibrage / Analyse.
 * null = pas encore choisi ; 'A' | 'B' | 'AB'
 */
const ProbeMode = (() => {
  let _mode = null; // null | 'A' | 'B' | 'AB'

  function aOk() { return !!(ws && ws.readyState === WebSocket.OPEN); }
  function bOk() { return !!(wsB && wsB.readyState === WebSocket.OPEN); }

  function get() { return _mode; }
  function isSet() { return _mode === 'A' || _mode === 'B' || _mode === 'AB'; }
  function isDual() { return _mode === 'AB'; }
  function isMonoA() { return _mode === 'A'; }
  function isMonoB() { return _mode === 'B'; }

  function canSelect(mode) {
    if (mode === 'A') return aOk();
    if (mode === 'B') return bOk();
    if (mode === 'AB') return aOk() && bOk();
    return false;
  }

  function _updateBadge() {
    const el = document.getElementById('probe-mode-label');
    if (!el) return;
    if (!_mode) {
      el.textContent = 'Sonde ?';
      el.className = 'probe-badge probe-badge--none';
    } else if (_mode === 'AB') {
      el.textContent = 'A+B';
      el.className = 'probe-badge probe-badge--ab';
    } else {
      el.textContent = 'Sonde ' + _mode;
      el.className = 'probe-badge probe-badge--' + _mode.toLowerCase();
    }
  }

  /** Changement de sonde → chaque SM quitte via son API (pas de logique métier ici). */
  function _abortSessions() {
    if (typeof _cancelNavPending === 'function') _cancelNavPending(true);
    if (typeof FftSession !== 'undefined') FftSession.reset(true);
    if (typeof PhaseSession !== 'undefined') PhaseSession.reset(true);
    if (typeof BalanceSession !== 'undefined') BalanceSession.reset(true);
    if (typeof AnalSession !== 'undefined') AnalSession.reset(true);
    if (typeof BumpSession !== 'undefined') BumpSession.reset(true);
    if (typeof BodeModuleSession !== 'undefined') BodeModuleSession.reset(true);
    if (typeof SyncSession !== 'undefined') SyncSession.reset(true);
  }

  function set(mode) {
    if (mode !== 'A' && mode !== 'B' && mode !== 'AB') return false;
    if (!canSelect(mode)) {
      if (typeof termAddLine === 'function') {
        termAddLine('!! Mode ' + mode + ' impossible — ESP manquant', 'sys');
      }
      return false;
    }
    _abortSessions();
    _mode = mode;
    try { localStorage.setItem('probe_mode', mode); } catch (e) {}
    _updateBadge();
    if (typeof DualSession !== 'undefined') {
      if (mode === 'AB') DualSession.begin();
      else DualSession.end();
    }
    if (typeof termAddLine === 'function') {
      const label = mode === 'AB' ? 'A + B (duo)' : ('Sonde ' + mode + ' (mono)');
      termAddLine('[MODE] ' + label, 'sys');
    }
    return true;
  }

  function clear(reason) {
    const was = _mode;
    _abortSessions();
    _mode = null;
    try { localStorage.removeItem('probe_mode'); } catch (e) {}
    if (typeof DualSession !== 'undefined') DualSession.end();
    if (typeof analyseResetDualSession === 'function') analyseResetDualSession();
    _updateBadge();
    if (typeof showTab === 'function') showTab('term');
    if (typeof MenuModule !== 'undefined' && typeof MenuModule.showProbeSelect === 'function') {
      MenuModule.showProbeSelect();
    }
    if (reason && typeof termAddLine === 'function') {
      termAddLine('[MODE] ' + reason + ' → choisir sonde', 'sys');
    }
    return was;
  }

  /** Si un ESP requis par le mode tombe → retour écran sonde. */
  function checkLinkHealth() {
    if (!_mode) {
      _updateBadge();
      return;
    }
    if (_mode === 'A' && !aOk()) clear('perte ESP A');
    else if (_mode === 'B' && !bOk()) clear('perte ESP B');
    else if (_mode === 'AB' && !aOk()) clear('perte ESP A (duo)');
    else if (_mode === 'AB' && !bOk()) clear('perte ESP B (duo)');
    else _updateBadge();
  }

  function change() {
    clear('changement de sonde');
  }

  _updateBadge();
  return {
    get: get, isSet: isSet, isDual: isDual, isMonoA: isMonoA, isMonoB: isMonoB,
    canSelect: canSelect, set: set, clear: clear, change: change,
    checkLinkHealth: checkLinkHealth, aOk: aOk, bOk: bOk, updateBadge: _updateBadge,
  };
})();
window.ProbeMode = ProbeMode;

/**
 * Session DOUBLE — uniquement si ProbeMode === AB.
 * ESP32 : toujours mono (même FW). Duo = 2 sessions parallèles pilotées ici.
 */
const DualSession = (() => {
  let _active = false;
  /** Attente NAV_ACK de B après startModule dual. */
  let _pendingB = null; // { expectTab, timer, onOk, onFail }
  /** ACK B arrivé avant que A soit prêt (B souvent plus rapide). */
  let _bAckEarly = null;

  function available() {
    if (typeof ProbeMode !== 'undefined' && ProbeMode.isSet()) {
      return ProbeMode.isDual() && typeof wsSendB === 'function';
    }
    return isDualMode() && typeof wsSendB === 'function';
  }
  function begin() {
    _active = available();
    return _active;
  }
  function end() {
    _clearPendingB();
    _bAckEarly = null;
    _active = false;
  }
  function is() { return _active; }

  function _clearPendingB() {
    if (_pendingB && _pendingB.timer) clearTimeout(_pendingB.timer);
    _pendingB = null;
  }

  function _tabMatch(expect, tab) {
    if (!expect) return true;
    if (tab === expect) return true;
    if (expect === 'analyse' && tab === 'bumptest') return true;
    if (expect === 'bumptest' && tab === 'analyse') return true;
    return false;
  }

  /** NAV_ACK reçu sur le canal B (appelé depuis handleTextB). */
  function onNavAckB(tab) {
    if (_pendingB) {
      if (!_tabMatch(_pendingB.expectTab, tab)) return false;
      const cb = _pendingB.onOk;
      _clearPendingB();
      _bAckEarly = null;
      if (cb) cb();
      return true;
    }
    // Trop tôt : mémoriser pour quand A sera prêt
    _bAckEarly = tab;
    return true;
  }

  function sendBoth(cmd) {
    // Mode mono B : wsSend route déjà vers B — ne pas doubler via wsSendB
    if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
      if (typeof wsSend === 'function') wsSend(cmd);
      return;
    }
    if (typeof wsSend === 'function') wsSend(cmd);
    // Comme stopBoth : ProbeMode AB suffit — ne pas exiger _active
    // (failDual / early-return enter peuvent laisser _active=false alors
    // que B a bien reçu le WS_GOTO et attend BUMP_START / LIVE_START).
    const needB = _active || available();
    if (needB && typeof wsSendB === 'function') wsSendB(cmd);
  }

  function startModule(tab, gotoCmd, opts) {
    opts = opts || {};
    // available() avant wsGoto : wsGoto → analyseResetDualSession → DualSession.end()
    const wantDual = available();
    _bAckEarly = null;
    _clearPendingB();

    // Pause équilibrage AVANT tout WS_GOTO (sinon B part en Analyse sans BAL_PAUSE)
    const cleanGoto = (gotoCmd || '').replace(/\n+$/, '');
    const isBalStay = /^WS_GOTO=EQ(_RESUME)?(\s|$)/.test(cleanGoto);
    if (!isBalStay) {
      if (typeof BalanceSession !== 'undefined' && BalanceSession.pause) {
        BalanceSession.pause();
      } else if (typeof BalanceModule !== 'undefined' &&
          typeof BalanceModule.hasProgress === 'function' && BalanceModule.hasProgress() &&
          typeof BalanceModule.pauseForLeave === 'function') {
        BalanceModule.pauseForLeave();
      }
    }

    if (wantDual) {
      if (typeof termAddLine === 'function') {
        termAddLine('[DOUBLE] ' + (opts.label || tab) + ' A+B', 'sys');
      }
      wsSendB(gotoCmd);
    }
    const go = typeof window.wsGoto === 'function' ? window.wsGoto : null;

    function readyDual() {
      _bAckEarly = null;
      begin();
      if (opts.onReady) opts.onReady(true);
    }
    function failDual() {
      _clearPendingB();
      _bAckEarly = null;
      end();
      if (typeof termAddLine === 'function') {
        termAddLine('[DOUBLE] !! B pas prêt (NAV_ACK)', 'sys');
      }
      if (opts.onFail) opts.onFail();
    }

    if (go) {
      go(tab, gotoCmd, {
        onAck: function () {
          if (!wantDual) {
            end();
            if (opts.onReady) opts.onReady(false);
            return;
          }
          // A prêt — B déjà ACK ? sinon attendre
          if (_bAckEarly && _tabMatch(tab, _bAckEarly)) {
            readyDual();
            return;
          }
          _clearPendingB();
          _pendingB = {
            expectTab: tab,
            onOk: readyDual,
            onFail: failDual,
            // Bump alloue ~90 KB — B peut ACK après A de plusieurs secondes
            timer: setTimeout(failDual, 8000),
          };
        },
        onTimeout: function () {
          _clearPendingB();
          _bAckEarly = null;
          end();
          if (opts.onFail) opts.onFail();
        },
      });
    } else if (typeof wsSend === 'function') {
      wsSend(gotoCmd);
      setTimeout(function () {
        if (wantDual) begin();
        if (opts.onReady) opts.onReady(wantDual);
      }, 200);
    }
    return wantDual;
  }

  function stopBoth(cmd) {
    const c = cmd || 'r';
    // Mono B : wsSend → B uniquement. Sinon A + B si duo (ProbeMode ou session active).
    if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
      if (typeof wsSend === 'function') wsSend(c);
    } else {
      if (typeof wsSend === 'function') wsSend(c);
      const needB = _active ||
        (typeof ProbeMode !== 'undefined' && ProbeMode.isDual());
      if (needB && typeof wsSendB === 'function') wsSendB(c);
    }
    end();
  }

  return { available: available, begin: begin, end: end, is: is,
           sendBoth: sendBoth, startModule: startModule, stopBoth: stopBoth,
           onNavAckB: onNavAckB };
})();
window.DualSession = DualSession;

function updateConnStatus() {
  const aOk = !!(ws && ws.readyState === WebSocket.OPEN);
  const bOk = !!(wsB && wsB.readyState === WebSocket.OPEN);
  const letterA = document.getElementById('conn-a');
  const letterB = document.getElementById('conn-b');
  if (letterA) {
    letterA.className = 'conn-letter ' + (aOk ? 'ok' : (ESP32_HOST ? 'err' : 'off'));
    letterA.title = aOk
      ? ('ESP A connecté — ' + (ESP32_HOST || ''))
      : (ESP32_HOST ? ('ESP A hors ligne — ' + ESP32_HOST) : 'ESP A — pas d\'IP');
  }
  if (letterB) {
    if (!ESP32_HOST_B) {
      letterB.className = 'conn-letter off';
      letterB.title = 'ESP B — pas d\'IP';
    } else {
      letterB.className = 'conn-letter ' + (bOk ? 'ok' : 'err');
      letterB.title = bOk
        ? ('ESP B connecté — ' + ESP32_HOST_B)
        : ('ESP B hors ligne — ' + ESP32_HOST_B);
    }
  }
  if (typeof ProbeMode !== 'undefined') ProbeMode.updateBadge();
  if (typeof MenuModule !== 'undefined' &&
      typeof MenuModule.refreshProbeIfShown === 'function') {
    MenuModule.refreshProbeIfShown();
  }
}

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

function _scheduleWsReconnectB() {
  if (_isSetupPortalPage()) return;
  if (!ESP32_HOST_B) return;
  if (_wsReconnectTimerB) clearTimeout(_wsReconnectTimerB);
  _wsReconnectTimerB = setTimeout(() => {
    _wsReconnectTimerB = null;
    wsConnectB();
  }, _wsBackoffMsB);
  _wsBackoffMsB = Math.min(Math.round(_wsBackoffMsB * 1.6), WS_RECONNECT_MAX_MS);
}

// État réception binaire
// Modes : 'text' | 'fft_hdr' | 'fft_bin' | 'an_hdr' | 'an_bin'
//          'bal_hdr' | 'bal_bin' | 'harm_hdr' | 'harm_bin'
let rxState   = 'text';
let rxHeaders = {};

// Tracker blocs texte multi-lignes (filtre terminal)
let _eqParsing   = false;

let _heartbeatTimer = null;
let _heartbeatTimerB = null;
let _lastAliveMs = 0;
let _lastAliveMsB = 0;
const WS_HEARTBEAT_MS = 5000;
/** Tolérant hotspot Android / micro-coupures (était 10s → faux disconnect au repos). */
const WS_ALIVE_TIMEOUT_MS = 25000;
/** >0 pendant calcul JS lourd (filtre FFT…) — évite faux timeout heartbeat. */
let _wsHeavyWork = 0;

function _markWsAlive() {
  _lastAliveMs = Date.now();
}
function _markWsAliveB() {
  _lastAliveMsB = Date.now();
}
function wsBeginHeavy() {
  _wsHeavyWork++;
  _markWsAlive();
  _markWsAliveB();
}
function wsEndHeavy() {
  _wsHeavyWork = Math.max(0, _wsHeavyWork - 1);
  _markWsAlive();
  _markWsAliveB();
}
window.wsBeginHeavy = wsBeginHeavy;
window.wsEndHeavy = wsEndHeavy;

function _cancelNavPending(silent) {
  if (_navTimeoutId) { clearTimeout(_navTimeoutId); _navTimeoutId = null; }
  if (_navPending && !silent) {
    termAddLine('[A] navigation annulée (ESP déconnecté)', 'sys');
  }
  _navPending = false;
  _navOpts = null;
}

/** Ferme A tout de suite et met le voyant rouge (TCP peut rester zombie après unplug). */
function forceCloseA(reason) {
  _stopHeartbeat();
  _cancelNavPending(true);
  rxState = 'text'; rxHeaders = {}; _eqParsing = false;
  const old = ws;
  ws = null;
  updateConnStatus();
  if (reason) termAddLine('[A] ' + reason, 'sys');
  try { if (old && old.readyState === WebSocket.OPEN) old.close(); } catch (e) {}
  if (typeof ProbeMode !== 'undefined') ProbeMode.checkLinkHealth();
}

function forceCloseB(reason) {
  _stopHeartbeatB();
  // Mono B : la nav pendante est sur wsB — l'annuler sinon WS_GOTO bloqué
  if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
    _cancelNavPending(true);
  }
  rxStateB = 'text'; rxHeadersB = {};
  const old = wsB;
  wsB = null;
  updateConnStatus();
  if (reason) termAddLine('[B] ' + reason, 'sys');
  try { if (old && old.readyState === WebSocket.OPEN) old.close(); } catch (e) {}
  if (typeof ProbeMode !== 'undefined') ProbeMode.checkLinkHealth();
}

function _startHeartbeat() {
  _stopHeartbeat();
  _markWsAlive();
  _heartbeatTimer = setInterval(() => {
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) {
      forceCloseA('lien mort (readyState)');
      if (ESP32_HOST) _scheduleWsReconnect();
      return;
    }
    if (_wsHeavyWork > 0) {
      _markWsAlive();
      try { ws.send('WS_PING\n'); } catch (e) {}
      return;
    }
    if (Date.now() - _lastAliveMs > WS_ALIVE_TIMEOUT_MS) {
      forceCloseA('injoignable (timeout heartbeat)');
      if (ESP32_HOST) _scheduleWsReconnect();
      return;
    }
    try { ws.send('WS_PING\n'); }
    catch (e) {
      forceCloseA('envoi ping échoué');
      if (ESP32_HOST) _scheduleWsReconnect();
    }
  }, WS_HEARTBEAT_MS);
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function _startHeartbeatB() {
  _stopHeartbeatB();
  _markWsAliveB();
  _heartbeatTimerB = setInterval(() => {
    if (!wsB) return;
    if (wsB.readyState !== WebSocket.OPEN) {
      forceCloseB('lien mort (readyState)');
      if (ESP32_HOST_B) _scheduleWsReconnectB();
      return;
    }
    if (_wsHeavyWork > 0) {
      _markWsAliveB();
      try { wsB.send('WS_PING\n'); } catch (e) {}
      return;
    }
    if (Date.now() - _lastAliveMsB > WS_ALIVE_TIMEOUT_MS) {
      forceCloseB('injoignable (timeout heartbeat)');
      if (ESP32_HOST_B) _scheduleWsReconnectB();
      return;
    }
    try { wsB.send('WS_PING\n'); }
    catch (e) {
      forceCloseB('envoi ping échoué');
      if (ESP32_HOST_B) _scheduleWsReconnectB();
    }
  }, WS_HEARTBEAT_MS);
}
function _stopHeartbeatB() {
  if (_heartbeatTimerB) { clearInterval(_heartbeatTimerB); _heartbeatTimerB = null; }
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
    localStorage.setItem('esp32ip_a', host);
  }
  updateConnStatus();
  hideIpBanner();
  const url = 'ws://' + host + ':81';
  termAddLine('[A] Connexion: ' + url, 'sys');
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    _wsFailCount = 0;
    _wsBackoffMs = WS_RECONNECT_BASE_MS;
    hideIpBanner();
    _markWsAlive();
    updateConnStatus();
    termAddLine('[A] -- connecte --' +
      (typeof ProbeMode !== 'undefined' && ProbeMode.isSet()
        ? (' [sonde ' + ProbeMode.get() + ']')
        : ' → choisir sonde'), 'sys');
    _startHeartbeat();
    if (_activeTab === 'calc' || _activeTab === 'demod') showTab(_activeTab);
    if (typeof BalanceModule !== 'undefined') BalanceModule.init(wsSend);
    setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('WS_GOTO=SYNC\n'); }, 300);
    if (ESP32_HOST_B && (!wsB || wsB.readyState !== WebSocket.OPEN)) {
      setTimeout(wsConnectB, 600);
    }
  };

  ws.onclose = (e) => {
    // Si forceCloseA a déjà mis ws=null, éviter double message
    if (ws === null) {
      _wsFailCount++;
      if (ESP32_HOST) _scheduleWsReconnect();
      return;
    }
    _stopHeartbeat();
    _cancelNavPending(true);
    rxState = 'text'; rxHeaders = {}; _eqParsing = false;
    ws = null;
    _wsFailCount++;
    updateConnStatus();
    if (!ESP32_HOST || _wsFailCount >= WS_FAIL_BEFORE_IP_PROMPT) {
      termAddLine('[A] -- deconnecte — entre l\'IP si besoin --', 'sys');
      showIpReconnectBanner();
      if (window.location.protocol === 'https:') return;
      // IP probablement morte (DHCP changé) — invalider + rediscover
      if (_wsFailCount >= WS_FAIL_BEFORE_IP_PROMPT && _isEspIpv4(ESP32_HOST)) {
        const dead = ESP32_HOST;
        ESP32_HOST = '';
        if (ESP32_IP === dead) ESP32_IP = '';
        localStorage.removeItem('esp32ip');
        localStorage.removeItem('esp32host');
        _wsFailCount = 0;
        setTimeout(function () { wsConnect(); }, 500);
        return;
      }
    } else {
      termAddLine('[A] deconnecte code=' + e.code + ' retry ' + Math.round(_wsBackoffMs / 1000) + 's', 'sys');
    }
    if (ESP32_HOST) _scheduleWsReconnect();
  };

  ws.onerror = () => {
    // Ne pas attendre : unplug → souvent error avant close
    updateConnStatus();
  };

  ws.onmessage = (e) => {
    _markWsAlive();
    if (typeof e.data === 'string') handleText(e.data);
    else if (e.data instanceof ArrayBuffer) handleBinary(e.data);
  };
}

function _wsConnectBTo(host) {
  if (wsB && (wsB.readyState === WebSocket.CONNECTING || wsB.readyState === WebSocket.OPEN)) return;
  if (!host) return;
  if (ESP32_HOST && host === ESP32_HOST) {
    termAddLine('[B] !! même IP que A — choisis une autre adresse', 'sys');
    return;
  }
  ESP32_HOST_B = host;
  localStorage.setItem('esp32ip_b', host);
  updateConnStatus();
  const url = 'ws://' + host + ':81';
  termAddLine('[B] Connexion: ' + url, 'sys');
  wsB = new WebSocket(url);
  wsB.binaryType = 'arraybuffer';

  wsB.onopen = () => {
    _wsFailCountB = 0;
    _wsBackoffMsB = WS_RECONNECT_BASE_MS;
    updateConnStatus();
    termAddLine('[B] -- connecte --' +
      (typeof ProbeMode !== 'undefined' && ProbeMode.isSet()
        ? (' [sonde ' + ProbeMode.get() + ']')
        : ' → choisir sonde'), 'sys');
    _startHeartbeatB();
    // Comme A : resync état module après reconnexion WiFi
    setTimeout(() => {
      if (wsB && wsB.readyState === WebSocket.OPEN) {
        try { wsB.send('WS_GOTO=SYNC\n'); } catch (e) {}
      }
    }, 300);
  };

  wsB.onclose = (e) => {
    if (wsB === null) {
      _wsFailCountB++;
      if (ESP32_HOST_B) _scheduleWsReconnectB();
      return;
    }
    _stopHeartbeatB();
    wsB = null;
    _wsFailCountB++;
    updateConnStatus();
    termAddLine('[B] deconnecte code=' + e.code, 'sys');
    if (ESP32_HOST_B) _scheduleWsReconnectB();
  };

  wsB.onerror = () => updateConnStatus();

  wsB.onmessage = (e) => {
    _markWsAliveB();
    if (typeof e.data === 'string') handleTextB(e.data);
    else if (e.data instanceof ArrayBuffer) handleBinaryB(e.data);
  };
}

// Réception B (analyse temporelle duale) — état RX séparé
let rxStateB = 'text';
let rxHeadersB = {};

function handleTextB(raw) {
  raw.split('\n').forEach(function (line) {
    line = (line || '').trim();
    if (!line) return;
    if (line === 'WS_PONG' || line === 'PONG') {
      _markWsAliveB();
      return;
    }

    // Marqueurs tach post-temporel B — ignorer le bruit jusqu'à END
    if (rxStateB === 'an_tach') {
      if (line === 'ANAL_TACH_BEGIN') {
        rxHeadersB.tachIdx = [];
        rxHeadersB.tachStarted = true;
        return;
      }
      if (line.startsWith('NTACH=')) return;
      if (line === 'ANAL_TACH_END') {
        const idx = rxHeadersB.tachIdx || [];
        const monoB = (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB());
        if (monoB && typeof analyseSetTachMarks === 'function') analyseSetTachMarks(idx);
        else if (typeof analyseSetTachMarksB === 'function') analyseSetTachMarksB(idx);
        rxStateB = 'text';
        return;
      }
      if (rxHeadersB.tachStarted && /^\d+$/.test(line)) {
        if (!rxHeadersB.tachIdx) rxHeadersB.tachIdx = [];
        rxHeadersB.tachIdx.push(parseInt(line, 10));
        return;
      }
      return; // ne pas abort sur lignes parasites (OK / ACQ…)
    }

    // Mode mono B : NAV_ACK / SYS_STATE comme sur A
    if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
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
            // balance : enterBalance via BalanceSession.beginLive / resume — pas ici
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
        } else if (mod) showTab(mod);
        return;
      }
    }

    if (line.startsWith('NAV_ACK=')) {
      const modB = line.slice(8).trim();
      if (typeof DualSession !== 'undefined' && DualSession.onNavAckB(modB)) return;
      return;
    }
    if (line.startsWith('ANAL_ARM_OK')) {
      _onAnalArmOk(true);
      return;
    }
    if (line.startsWith('ANAL_CAP_OK')) {
      _onAnalCapOk(true);
      return;
    }
    if (line.startsWith('ANAL_FIRE_ERR') || line.startsWith('ANAL_ARM_ERR') ||
        line.startsWith('ANAL_SEND_ERR')) {
      termAddLine('[B] ' + line, 'sys');
      return;
    }
    if (line.startsWith('ACQ_PROGRESS=')) {
      // Mono B : B est la sonde primaire → appliquer le cadran (comme A)
      // Duo : A pilote déjà — ignorer le doublon B
      if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB() &&
          typeof acqShowProgress === 'function') {
        acqShowProgress(line.slice(13));
      }
      return;
    }
    if (line.startsWith('BUMP_STATUS=')) {
      if (typeof bumpSetStatus === 'function') {
        bumpSetStatus('[B] ' + line.slice(12).trim());
      }
      return;
    }
    if (line.startsWith('BUMP_LIVE=')) {
      let v = parseInt(line.slice(10), 10);
      v = applyAxisInvertScalar('B', v);
      if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
        if (typeof bumpReceiveLive === 'function') bumpReceiveLive(v);
      } else if (typeof bumpReceiveLiveB === 'function') {
        bumpReceiveLiveB(v);
      }
      return;
    }
    if (line.startsWith('BUMP_CFG=')) {
      // A a déjà appliqué la config (même G/Fs)
      return;
    }
    if (line === 'BAL_TOUR') {
      rxStateB = 'bal_hdr';
      rxHeadersB = {};
      return;
    }
    if (rxStateB === 'bal_hdr') {
      if (line.startsWith('RPM=')) { rxHeadersB.rpm = parseFloat(line.slice(4)); return; }
      if (line.startsWith('N=')) { rxHeadersB.n = parseInt(line.slice(2), 10); return; }
      if (line.startsWith('RANGE=')) {
        rxHeadersB.range = parseInt(line.slice(6), 10);
        rxStateB = 'bal_bin';
        return;
      }
      return;
    }
    // Balance B : mono B → tout vers BalanceModule ; duo → RPM seulement (A pilote STATE)
    if (line.startsWith('BAL_') || line.startsWith('EQ_')) {
      if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
        if (typeof BalanceModule !== 'undefined') BalanceModule.onData(line);
        return;
      }
      if (line.startsWith('BAL_RPM=')) {
        if (typeof BalanceModule !== 'undefined' && BalanceModule.onRpmB) {
          BalanceModule.onRpmB(parseFloat(line.slice(8)) || 0);
        }
        return;
      }
      return;
    }
    if (line === 'HARM_BIN') {
      rxStateB = 'harm_hdr';
      rxHeadersB = {};
      return;
    }
    if (rxStateB === 'harm_hdr') {
      if (line.startsWith('G=')) { rxHeadersB.g = parseInt(line.slice(2), 10); return; }
      if (line.startsWith('F=')) { rxHeadersB.fs = parseFloat(line.slice(2)); return; }
      if (line.startsWith('RPM=')) { rxHeadersB.rpm = parseFloat(line.slice(4)); return; }
      if (line.startsWith('N=')) {
        rxHeadersB.n = parseInt(line.slice(2), 10);
        rxStateB = 'harm_bin';
        return;
      }
      return;
    }
    if (line === 'LIVE_FFT_BLOC') {
      rxStateB = 'fft_hdr';
      rxHeadersB = {};
      return;
    }
    if (line === 'BINARY_MODE') {
      rxStateB = 'an_hdr';
      rxHeadersB = {};
      return;
    }
    if (line.startsWith('CRC=') && rxStateB !== 'text') {
      rxHeadersB.crc = parseInt(line.slice(4), 10);
      return;
    }
    if (rxStateB === 'an_hdr' || rxStateB === 'fft_hdr') {
      if (line.startsWith('G=')) { rxHeadersB.g = parseFloat(line.slice(2)); return; }
      if (line.startsWith('F=')) { rxHeadersB.fs = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T=')) { rxHeadersB.t = parseFloat(line.slice(2)); return; }
      if (line.startsWith('N=')) {
        rxHeadersB.n = parseInt(line.slice(2), 10);
        rxStateB = (rxStateB === 'fft_hdr') ? 'fft_bin' : 'an_bin';
        return;
      }
      return;
    }
    // Preview RPM Phase B — ne pas spammer le terminal
    if (line.startsWith('HARM_RPM=')) {
      if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB() &&
          typeof HarmonicModule !== 'undefined' && HarmonicModule.onLiveRpm) {
        HarmonicModule.onLiveRpm(parseFloat(line.slice(9)));
      }
      return;
    }
    if (line.startsWith('BODE_TACH=') || line.startsWith('SYNC_TACH=') ||
        line.startsWith('BAL_RPM=')) {
      return;
    }
    if (line.startsWith('WIFI_READY=') || line.startsWith('WIFI_IP=')) return;
    termAddLine('[B] ' + line, 'sys');
  });
}

function handleBinaryB(buf) {
  const st = rxStateB;
  if (st !== 'an_bin' && st !== 'fft_bin' && st !== 'harm_bin' && st !== 'bal_bin') {
    rxStateB = 'text';
    return;
  }
  const h = rxHeadersB;
  if (!_crcCheck(buf, h.crc)) {
    rxStateB = 'text';
    return;
  }
  const samples = applyAxisInvertIfNeeded('B', new Int16Array(buf));
  // Mode mono B : B alimente les handlers « A » (UI mono classique)
  const monoB = (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB());
  if (st === 'bal_bin') {
    rxStateB = 'text';
    if (monoB && typeof BalanceModule !== 'undefined' && BalanceModule.onTourBinary) {
      BalanceModule.onTourBinary(h.rpm, h.range, h.n, samples);
    } else if (typeof BalanceModule !== 'undefined' && BalanceModule.onTourBinaryB) {
      BalanceModule.onTourBinaryB(h.rpm, h.range, h.n, samples);
    }
    return;
  }
  if (st === 'fft_bin') {
    rxStateB = 'text';
    if (monoB && typeof fftReceiveBloc === 'function') {
      fftReceiveBloc(h.g, h.fs, h.n, samples);
    } else if (typeof fftReceiveBlocB === 'function') {
      fftReceiveBlocB(h.g, h.fs, h.n, samples);
    }
    return;
  }
  if (st === 'harm_bin') {
    rxStateB = 'text';
    if (monoB && typeof HarmonicModule !== 'undefined' && HarmonicModule.onHarmBinary) {
      HarmonicModule.onHarmBinary(h.g, h.fs, h.rpm, h.n, samples);
    } else if (typeof HarmonicModule !== 'undefined' && HarmonicModule.onHarmBinaryB) {
      HarmonicModule.onHarmBinaryB(h.g, h.fs, h.rpm, h.n, samples);
    }
    return;
  }
  // an_bin : attendre ANAL_TACH_BEGIN…END (comme canal A)
  rxStateB = 'an_tach';
  rxHeadersB.tachIdx = [];
  rxHeadersB.tachStarted = false;
  if (monoB && typeof analyseReceiveBloc === 'function') {
    analyseReceiveBloc(h.g, h.fs, h.t || (h.n / h.fs), h.n, samples);
  } else if (typeof analyseReceiveBlocB === 'function') {
    analyseReceiveBlocB(h.g, h.fs, h.t || (h.n / h.fs), h.n, samples);
  }
  if (!monoB && typeof _dualOnBinaryB === 'function') _dualOnBinaryB();
}

function wsSendB(cmd) {
  if (!wsB || wsB.readyState !== WebSocket.OPEN) return false;
  const clean = (cmd || '').replace(/\n+$/, '');
  try {
    wsB.send(clean + '\n');
    return true;
  } catch (e) {
    forceCloseB('envoi échoué');
    return false;
  }
}
window.wsSendB = wsSendB;

// Acquisition temporelle : machine d'états dans anal-session.js (AnalSession).
// Ici : pont WS → AnalSession uniquement.
function _onAnalArmOk(fromB) {
  if (typeof AnalSession !== 'undefined') AnalSession.onArmOk(!!fromB);
}
function _onAnalCapOk(fromB) {
  if (typeof AnalSession !== 'undefined') AnalSession.onCapOk(!!fromB);
}
function _dualAbort(msg) {
  if (typeof AnalSession !== 'undefined') AnalSession.abort(msg || 'abort');
}
// startAnalTemporal / _dualOnBinaryA/B exposés par anal-session.js

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
  _wsConnecting = true;
  var host = ESP32_HOST;

  // App Android / cache : toujours vérifier / rediscover (pas seulement si page = ESP)
  if (window.location.protocol !== 'https:') {
    try {
      if (!host) {
        if (typeof termAddLine === 'function') {
          termAddLine('[A] pas d\'IP mémorisée — recherche…', 'sys');
        }
        host = await discoverEspHost();
      } else if (_isEspIpv4(host)) {
        // IP stale ? ping rapide avant WS (évite boucle 1006)
        const ok = await pingEspHost(host, 600);
        if (!ok) {
          if (typeof termAddLine === 'function') {
            termAddLine('[A] ' + host + ' ne répond pas — scan…', 'sys');
          }
          // Invalider IP morte pour forcer un vrai scan (pas re-ping de la même)
          const dead = host;
          if (ESP32_HOST === dead) ESP32_HOST = '';
          if (ESP32_IP === dead) ESP32_IP = '';
          try {
            if ((localStorage.getItem('esp32ip') || '') === dead) {
              localStorage.removeItem('esp32ip');
            }
            if ((localStorage.getItem('esp32host') || '') === dead) {
              localStorage.removeItem('esp32host');
            }
          } catch (e2) {}
          host = await discoverEspHost();
        }
      } else {
        host = await discoverEspHost();
      }
    } catch (e) {}
  }
  _wsConnecting = false;

  if (!host) {
    updateConnStatus();
    showIpReconnectBanner();
    if (typeof termAddLine === 'function') {
      termAddLine('[A] pas d\'IP — interface locale seulement --', 'sys');
    }
    return;
  }
  _wsConnectTo(host);
}

async function wsConnectB() {
  if (_isSetupPortalPage()) return;
  if (_wsConnectingB) return;
  if (!ESP32_HOST_B) {
    updateConnStatus();
    return;
  }
  if (_wsReconnectTimerB) {
    clearTimeout(_wsReconnectTimerB);
    _wsReconnectTimerB = null;
  }
  if (wsB && (wsB.readyState === WebSocket.CONNECTING || wsB.readyState === WebSocket.OPEN)) {
    return;
  }
  _wsConnectingB = true;
  _wsConnectBTo(ESP32_HOST_B);
  _wsConnectingB = false;
}
window.wsConnectB = wsConnectB;

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
      // Déjà connecté à cette IP → ne pas forcer un reconnect (flap idle)
      if (_isEspIpv4(v)) {
        if (ws && ws.readyState === WebSocket.OPEN &&
            (v === ESP32_HOST || v === ESP32_IP)) {
          applyEspIp(v, false);
        } else {
          applyEspIp(v, true);
        }
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
        } else if (mod === 'bode') {
          showTab('bode');
          // BodeModuleSession.enter via onAck menu (ou ici si pas d'opts)
          if ((!o || typeof o.onAck !== 'function') &&
              typeof BodeModuleSession !== 'undefined' && BodeModuleSession.enter) {
            BodeModuleSession.enter();
          }
        } else if (mod === 'sync') {
          showTab('sync');
          if ((!o || typeof o.onAck !== 'function') &&
              typeof SyncSession !== 'undefined' && SyncSession.enter) {
            SyncSession.enter();
          }
        } else if (mod) {
          showTab(mod);
          // balance : enterBalance via BalanceSession.beginLive / resume — pas ici
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
      } else if (mod === 'bode') {
        showTab('bode');
        if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.enter) {
          BodeModuleSession.enter();
        }
      } else if (mod === 'sync') {
        showTab('sync');
        if (typeof SyncSession !== 'undefined' && SyncSession.enter) {
          SyncSession.enter();
        }
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
      let v = parseInt(line.slice(10), 10);
      v = applyAxisInvertScalar('A', v);
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

    // ── Bode brut (LIVE / TACH preview / CFG / STATUS) ────────
    if (line.startsWith('BODE_STATUS=')) {
      const txt = line.slice(12).trim();
      if (typeof BodeModule !== 'undefined' && BodeModule.setStatus) {
        BodeModule.setStatus(txt);
      }
      if ((/vide|Aucune|insuffisante/i).test(txt) &&
          typeof BodeModuleSession !== 'undefined' && BodeModuleSession.getState &&
          BodeModuleSession.getState() === 'FINALIZE') {
        if (BodeModuleSession.enter) BodeModuleSession.enter();
      }
      return;
    }
    if (line.startsWith('BODE_LIVE=')) {
      let v = parseInt(line.slice(10), 10);
      v = applyAxisInvertScalar('A', v);
      if (typeof BodeModule !== 'undefined' && BodeModule.onLive) BodeModule.onLive(v);
      return;
    }
    if (line.startsWith('BODE_TACH=')) {
      const period = parseInt(line.slice(10), 10);
      if (typeof BodeModule !== 'undefined' && BodeModule.onTachPeriod) {
        BodeModule.onTachPeriod(period);
      }
      return;
    }
    if (line.startsWith('BODE_CFG=')) {
      const payload = line.slice(9).trim();
      const g = /G=(\d+)/.exec(payload);
      const f = /FS=(\d+)/.exec(payload);
      const n = /N=(\d+)/.exec(payload);
      if (typeof BodeModule !== 'undefined' && BodeModule.setConfig) {
        BodeModule.setConfig(g ? g[1] : '', f ? f[1] : '', n ? n[1] : '');
      }
      return;
    }

    // ── Sync TSA (STATUS / TACH / CFG) ─────────────────────────
    if (line.startsWith('SYNC_STATUS=')) {
      const txt = line.slice(12).trim();
      if (typeof SyncSession !== 'undefined' && SyncSession.onStatus) {
        SyncSession.onStatus(txt);
      } else if (typeof SyncModule !== 'undefined' && SyncModule.setStatus) {
        SyncModule.setStatus(txt);
      }
      return;
    }
    if (line.startsWith('SYNC_TACH=')) {
      const period = parseInt(line.slice(10), 10);
      if (typeof SyncModule !== 'undefined' && SyncModule.onTachPeriod) {
        SyncModule.onTachPeriod(period);
      }
      return;
    }
    if (line.startsWith('SYNC_CFG=')) {
      const payload = line.slice(9).trim();
      const g = /G=(\d+)/.exec(payload);
      const f = /FS=(\d+)/.exec(payload);
      const n = /N=(\d+)/.exec(payload);
      if (typeof SyncModule !== 'undefined' && SyncModule.setConfig) {
        SyncModule.setConfig(g ? g[1] : '', f ? f[1] : '', n ? n[1] : '');
      }
      return;
    }

    // Liste tach post-binaire Bode
    if (rxState === 'bode_tach') {
      if (line === 'BODE_TACH_BEGIN') {
        rxHeaders.tachList = [];
        return;
      }
      if (line === 'BODE_TACH_END') {
        if (typeof BodeModule !== 'undefined' && BodeModule.onTachUs) {
          BodeModule.onTachUs(rxHeaders.tachList || []);
        }
        rxState = 'text';
        if (typeof BodeModuleSession !== 'undefined' && BodeModuleSession.onPayloadReady) {
          BodeModuleSession.onPayloadReady();
        }
        return;
      }
      if (/^\d+$/.test(line.trim())) {
        if (!rxHeaders.tachList) rxHeaders.tachList = [];
        rxHeaders.tachList.push(parseInt(line.trim(), 10) >>> 0);
        return;
      }
      return;
    }

    // Liste tach post-binaire Sync
    if (rxState === 'sync_tach') {
      if (line === 'SYNC_TACH_BEGIN') {
        rxHeaders.tachList = [];
        return;
      }
      if (line === 'SYNC_TACH_END') {
        if (typeof SyncModule !== 'undefined' && SyncModule.onTachUs) {
          SyncModule.onTachUs(rxHeaders.tachList || []);
        }
        rxState = 'text';
        if (typeof SyncSession !== 'undefined' && SyncSession.onPayloadReady) {
          SyncSession.onPayloadReady();
        }
        return;
      }
      if (/^\d+$/.test(line.trim())) {
        if (!rxHeaders.tachList) rxHeaders.tachList = [];
        rxHeaders.tachList.push(parseInt(line.trim(), 10) >>> 0);
        return;
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

    // RPM preview Phase (avant HARM_START) — silencieux (pas de termAddLine)
    if (line.startsWith('HARM_RPM=')) {
      const rpm = parseFloat(line.slice(9));
      if (typeof HarmonicModule !== 'undefined' && HarmonicModule.onLiveRpm) {
        HarmonicModule.onLiveRpm(rpm);
      }
      return;
    }

    // Marqueurs tach post-temporel — ignorer le bruit jusqu'à END
    // (sinon OK/ACQ_PROGRESS abortaient an_tach trop tôt → mono A/B sans 1X)
    if (rxState === 'an_tach') {
      if (line === 'ANAL_TACH_BEGIN') {
        rxHeaders.tachIdx = [];
        rxHeaders.tachStarted = true;
        return;
      }
      if (line.startsWith('NTACH=')) return;
      if (line === 'ANAL_TACH_END') {
        if (typeof analyseSetTachMarks === 'function') {
          analyseSetTachMarks(rxHeaders.tachIdx || []);
        }
        rxState = 'text';
        return;
      }
      if (rxHeaders.tachStarted && /^\d+$/.test(line.trim())) {
        if (!rxHeaders.tachIdx) rxHeaders.tachIdx = [];
        rxHeaders.tachIdx.push(parseInt(line.trim(), 10));
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

    // ── BODE_BIN → brut + liste tach ensuite ───────────────────
    if (line === 'BODE_BIN') {
      rxState = 'bode_hdr'; rxHeaders = {};
      return;
    }
    if (rxState === 'bode_hdr') {
      // T0/NTACH avant N= (sinon t0=0 → indices hors buffer → Bode vide)
      if (line.startsWith('G='))     { rxHeaders.g  = parseInt(line.slice(2));   return; }
      if (line.startsWith('F='))     { rxHeaders.fs = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T='))     { rxHeaders.t  = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T0='))    { rxHeaders.t0 = parseInt(line.slice(3), 10) >>> 0; return; }
      if (line.startsWith('NTACH=')) { rxHeaders.ntach = parseInt(line.slice(6), 10); return; }
      if (line.startsWith('N=')) {
        rxHeaders.n = parseInt(line.slice(2), 10);
        if (typeof BodeModule !== 'undefined' && BodeModule.beginBinary) {
          BodeModule.beginBinary({
            g: rxHeaders.g,
            fs: rxHeaders.fs,
            t0: rxHeaders.t0 || 0,
            n: rxHeaders.n,
            t: rxHeaders.t
          });
        }
        rxState = 'bode_bin';
        return;
      }
      return;
    }

    // ── SYNC_BIN → brut + liste tach ensuite ──────────────────
    if (line === 'SYNC_BIN') {
      rxState = 'sync_hdr'; rxHeaders = {};
      return;
    }
    if (rxState === 'sync_hdr') {
      if (line.startsWith('G='))     { rxHeaders.g  = parseInt(line.slice(2));   return; }
      if (line.startsWith('F='))     { rxHeaders.fs = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T='))     { rxHeaders.t  = parseFloat(line.slice(2)); return; }
      if (line.startsWith('T0='))    { rxHeaders.t0 = parseInt(line.slice(3), 10) >>> 0; return; }
      if (line.startsWith('NTACH=')) { rxHeaders.ntach = parseInt(line.slice(6), 10); return; }
      if (line.startsWith('N=')) {
        rxHeaders.n = parseInt(line.slice(2), 10);
        if (typeof SyncModule !== 'undefined' && SyncModule.beginBinary) {
          SyncModule.beginBinary({
            g: rxHeaders.g,
            fs: rxHeaders.fs,
            t0: rxHeaders.t0 || 0,
            n: rxHeaders.n,
            t: rxHeaders.t
          });
        }
        rxState = 'sync_bin';
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

    // ── DOUBLE ARM / CAP ──────────────────────────────────────
    if (line.startsWith('ANAL_ARM_OK')) {
      _onAnalArmOk(false);
      return;
    }
    if (line.startsWith('ANAL_CAP_OK')) {
      _onAnalCapOk(false);
      return;
    }
    if (line.startsWith('ANAL_FIRE_ERR') || line.startsWith('ANAL_ARM_ERR') ||
        line.startsWith('ANAL_SEND_ERR')) {
      _dualAbort(line);
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

  const samplesA = applyAxisInvertIfNeeded('A', new Int16Array(buf));

  if (rxState === 'fft_bin') {
    rxState = 'text';
    fftReceiveBloc(h.g, h.fs, h.n, samplesA);

  } else if (rxState === 'an_bin') {
    // Attendre ANAL_TACH_BEGIN…END (toujours envoyé par ESP, même NTACH=0)
    rxState = 'an_tach';
    rxHeaders.tachIdx = [];
    rxHeaders.tachStarted = false;
    analyseReceiveBloc(h.g, h.fs, h.t || (h.n / h.fs), h.n, samplesA);
    if (typeof _dualOnBinaryA === 'function') _dualOnBinaryA();

  } else if (rxState === 'bal_bin') {
    rxState = 'text';
    if (typeof BalanceModule !== 'undefined') {
      BalanceModule.onTourBinary(h.rpm, h.range, h.n, samplesA);
    }

  } else if (rxState === 'harm_bin') {
    rxState = 'text';
    if (typeof HarmonicModule !== 'undefined') {
      HarmonicModule.onHarmBinary(h.g, h.fs, h.rpm, h.n, samplesA);
    }

  } else if (rxState === 'bode_bin') {
    // Garder l'état : liste tach suit le binaire
    if (typeof BodeModule !== 'undefined' && BodeModule.onSamples) {
      BodeModule.onSamples(samplesA);
    }
    rxState = 'bode_tach';
    rxHeaders.tachList = [];

  } else if (rxState === 'sync_bin') {
    if (typeof SyncModule !== 'undefined' && SyncModule.onSamples) {
      SyncModule.onSamples(samplesA);
    }
    rxState = 'sync_tach';
    rxHeaders.tachList = [];
  }
}

function wsSend(cmd) {
  // Mode mono B : tout part sur ESP B
  if (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB()) {
    if (!wsB || wsB.readyState !== WebSocket.OPEN) {
      termAddLine('!! ESP B non connecte', 'sys');
      updateConnStatus();
      return;
    }
    const cleanB = cmd.replace(/\n+$/, '');
    try { wsB.send(cleanB + '\n'); }
    catch (e) { forceCloseB('envoi échoué'); return; }
    if (cleanB.trim() && cleanB !== 'WS_PING') termAddLine('>>[B] ' + cleanB, 'sent');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    termAddLine('!! ESP A non connecte', 'sys');
    updateConnStatus();
    return;
  }
  const clean = cmd.replace(/\n+$/, '');
  try {
    ws.send(clean + '\n');
  } catch (e) {
    forceCloseA('envoi échoué');
    return;
  }
  if (clean.trim() && clean !== 'WS_PING') termAddLine('>> ' + clean, 'sent');
}

// ── Navigation ──────────────────────────────────────────────
const ALL_TABS = ['term', 'fft', 'analyse', 'bode', 'sync', 'calc', 'balance', 'harmonic', 'demod'];

function showTab(name) {
  _activeTab = name;
  localStorage.setItem('lastTab', name);
  ALL_TABS.forEach(n => {
    const el = document.getElementById('page-' + n);
    if (el) el.style.display = (n === name) ? 'flex' : 'none';
  });
  // data-tab (pas l'index) : Live FFT n'a plus de bouton dans la barre
  document.querySelectorAll('.tab').forEach((t) => {
    const id = t.getAttribute('data-tab');
    t.classList.toggle('active', id === name);
  });
  if (name === 'fft')      setTimeout(fftDraw,     50);
  if (name === 'analyse') {
    setTimeout(analyseDraw, 50);
    // Réaffiche Démarrer si session ARMED (évite glitch layout / bump)
    if (typeof AnalSession !== 'undefined' && AnalSession.syncUi) {
      setTimeout(function () { AnalSession.syncUi(); }, 60);
    }
  }
  if (name === 'bode') setTimeout(() => {
    if (typeof BodeModule !== 'undefined') BodeModule.resize();
  }, 50);
  if (name === 'sync') setTimeout(() => {
    if (typeof SyncModule !== 'undefined') SyncModule.resize();
  }, 50);
  if (name === 'balance')  setTimeout(() => {
    if (typeof BalanceModule !== 'undefined') {
      // Viewer only — pas de BAL_INIT ici (sinon IDLE juste après EQ_RESUME
      // tant que BAL_RESUME n'a pas encore basculé systemState).
      // enterBalance / skipInit : BalanceSession.beginLive / beginResumeLive.
      BalanceModule.resize();
    }
  }, 50);
  if (name === 'harmonic') setTimeout(() => {
    if (typeof HarmonicModule !== 'undefined') HarmonicModule.resize();
  }, 50);
  if (name === 'demod') setTimeout(() => {
    if (typeof demodDraw !== 'undefined') demodDraw();
  }, 50);
}

/**
 * Clic onglet utilisateur — modules capteurs passent par WS_GOTO
 * (sinon ESP reste au menu → pas de BAL_RPM / pas d'acq).
 */
function requestTab(name) {
  if (name === 'term' || name === 'calc') {
    showTab(name);
    return;
  }
  if (name === 'analyse') {
    showTab('analyse');
    return;
  }
  if (name === 'balance') {
    // Viewer only — démarrage via Terminal → BalanceSession.start/resume
    showTab('balance');
    return;
  }
  if (name === 'harmonic') {
    // Viewer only — démarrage uniquement via Terminal → PhaseSession.start()
    showTab('harmonic');
    return;
  }
  if (name === 'bode') {
    // Viewer only — démarrage via Terminal → BodeModuleSession
    showTab('bode');
    return;
  }
  if (name === 'sync') {
    showTab('sync');
    return;
  }
  if (name === 'fft') {
    if (_activeTab === 'fft') {
      showTab('fft');
      return;
    }
    // Live FFT : l'onglet suffit (Start envoie ANAL_LIVE) — juste afficher
    showTab('fft');
    return;
  }
  showTab(name);
}
window.requestTab = requestTab;

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
  const monoB = (typeof ProbeMode !== 'undefined' && ProbeMode.isMonoB());
  const sock = monoB ? wsB : ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    termAddLine('!! ESP ' + (monoB ? 'B' : 'A') + ' non connecte', 'sys');
    updateConnStatus();
    return;
  }
  const clean = cmdLine.replace(/\n+$/, '');
  if (clean.startsWith('WS_GOTO=ANAL_TEMP ') || clean.startsWith('WS_GOTO=ANAL_LIVE ')) {
    termAddLine('!! format invalide: WS_GOTO sans parametres', 'sys');
    return;
  }
  // Changement de module → reset machines d'états + flush dual
  if (typeof AnalSession !== 'undefined') AnalSession.reset(true);
  if (typeof BumpSession !== 'undefined') BumpSession.reset(true);
  if (typeof BodeModuleSession !== 'undefined') BodeModuleSession.reset(true);
  if (typeof SyncSession !== 'undefined') SyncSession.reset(true);
  if (typeof FftSession !== 'undefined') FftSession.reset(true);
  if (typeof PhaseSession !== 'undefined') PhaseSession.reset(true);
  // Balance : pause (pas reset destructif) — sauf si on reste en EQ
  const isBalStay = /^WS_GOTO=EQ(_RESUME)?(\s|$)/.test(clean);
  if (!isBalStay) {
    if (typeof BalanceSession !== 'undefined' && BalanceSession.pause) {
      BalanceSession.pause();
    } else if (typeof BalanceModule !== 'undefined' &&
        typeof BalanceModule.hasProgress === 'function' && BalanceModule.hasProgress() &&
        typeof BalanceModule.pauseForLeave === 'function') {
      BalanceModule.pauseForLeave();
    }
  }
  if (typeof analyseResetDualSession === 'function') analyseResetDualSession();
  // Re-assert dual session si mode AB (analyseReset DualSession.end)
  if (typeof ProbeMode !== 'undefined' && ProbeMode.isDual() &&
      typeof DualSession !== 'undefined') DualSession.begin();
  rxStateB = 'text';
  rxHeadersB = {};

  _navPending = true;
  _navOpts = opts || null;
  try {
    sock.send(clean + '\n');
  } catch (e) {
    _cancelNavPending(true);
    if (monoB) forceCloseB('envoi navigation échoué');
    else forceCloseA('envoi navigation échoué');
    return;
  }
  if (clean.trim() && clean !== 'WS_PING') {
    termAddLine('>>' + (monoB ? '[B] ' : ' ') + clean, 'sent');
  }
  _navTimeoutId = setTimeout(() => {
    _navTimeoutId = null;
    _navPending = false;
    const o = _navOpts;
    _navOpts = null;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      termAddLine('[' + (monoB ? 'B' : 'A') + '] NAV annulé (déconnecté)', 'sys');
      updateConnStatus();
      return;
    }
    termAddLine('!! NAV timeout (pas de NAV_ACK)', 'sys');
    if (o && typeof o.onTimeout === 'function') o.onTimeout();
  }, NAV_ACK_TIMEOUT_MS);
}
window.wsGoto = wsGoto;

function setDot(state, label) {
  // Compat : met à jour l'affichage global A/B
  if (label) {
    const lbl = document.getElementById('ip-label');
    if (lbl) lbl.textContent = label;
  }
  updateConnStatus();
}

function changeIpA() {
  const h = prompt('IP ESP A (ws://IP:81) :', ESP32_IP || ESP32_HOST || '');
  if (h === null) return;
  const v = h.trim();
  _wsFailCount = 0;
  if (!v) {
    showIpReconnectBanner();
    return;
  }
  const norm = _normalizeHostInput(v);
  if (ESP32_HOST_B && norm === ESP32_HOST_B) {
    termAddLine('[A] !! IP déjà utilisée par B', 'sys');
    return;
  }
  if (_isEspIpv4(norm)) applyEspIp(v, true);
  else applyEspHost(v, true);
}

function changeIpB() {
  const h = prompt('IP ESP B (optionnel, ws://IP:81) — vide = déconnecter B :', ESP32_HOST_B || '');
  if (h === null) return;
  const v = h.trim();
  _wsFailCountB = 0;
  if (!v) {
    ESP32_HOST_B = '';
    localStorage.removeItem('esp32ip_b');
    if (wsB) { try { wsB.close(); } catch (e) {} }
    wsB = null;
    updateConnStatus();
    termAddLine('[B] déconnecté / IP effacée — mode simple', 'sys');
    return;
  }
  const norm = _normalizeHostInput(v);
  if (!_isEspIpv4(norm) && !_isMdnsHost(norm)) {
    termAddLine('[B] !! adresse invalide', 'sys');
    return;
  }
  if (ESP32_HOST && norm === ESP32_HOST) {
    termAddLine('[B] !! même IP que A', 'sys');
    return;
  }
  ESP32_HOST_B = _isMdnsHost(norm) ? ESP_MDNS_HOST : norm;
  localStorage.setItem('esp32ip_b', ESP32_HOST_B);
  if (wsB) { try { wsB.close(); } catch (e) {} }
  wsB = null;
  updateConnStatus();
  setTimeout(wsConnectB, 200);
}

function changeIP() { changeIpA(); }
window.changeIpA = changeIpA;
window.changeIpB = changeIpB;
window.changeIP = changeIP;
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
    localStorage.removeItem('probe_mode');
    localStorage.setItem('lastTab', 'term');
    if (typeof anPersistClear === 'function') anPersistClear();
  } catch (e) {}
  if (typeof BalanceModule !== 'undefined' && typeof BalanceModule.clearSession === 'function') {
    BalanceModule.clearSession();
  }
  // Remise au repos des ESP encore connectés (avant clear mode)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send('BAL_RESET\n'); ws.send('WS_GOTO=term\n'); } catch (e) {}
  }
  if (wsB && wsB.readyState === WebSocket.OPEN) {
    try { wsB.send('BAL_RESET\n'); wsB.send('WS_GOTO=term\n'); } catch (e) {}
  }
  if (typeof ProbeMode !== 'undefined') ProbeMode.clear('reset session');
  _activeTab = 'term';
  showTab('term');
}
window.clearVaSession = clearVaSession;

window.addEventListener('resize', () => { fftDraw(); analyseDraw(); });

document.addEventListener('DOMContentLoaded', () => {
  const boot = function () {
    syncHostFromPage();
    updateConnStatus();
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
    if (typeof BodeModule !== 'undefined') BodeModule.init();
    if (typeof SyncModule !== 'undefined') SyncModule.init();
    // Restaure snapshot équilibrage même avant WS (pause / refresh)
    if (typeof BalanceModule !== 'undefined') BalanceModule.init(wsSend);
    if (typeof showPwaInstallUi === 'function') showPwaInstallUi();
  };
  if (typeof I18n !== 'undefined' && I18n.init) {
    I18n.init().then(boot).catch(function (e) {
      console.warn('i18n init failed', e);
      boot();
    });
  } else {
    boot();
  }
});

/** Demande confirmation avant refresh (Android : parfois sans dialogue — localStorage sauve quand même). */
window.addEventListener('beforeunload', function (e) {
  if (typeof BalanceModule !== 'undefined' &&
      typeof BalanceModule.hasProgress === 'function' && BalanceModule.hasProgress() &&
      typeof BalanceModule.persistSession === 'function') {
    BalanceModule.persistSession();
  }
  e.preventDefault();
  e.returnValue = '';
});

/**
 * Android : swipe edge / bouton retour quitte la page trop facilement.
 * Trap history → confirm « Sur de vouloir quitter ? »
 */
(function _installLeaveConfirm() {
  let _leaveArmed = false;
  let _allowLeave = false;

  function _pushGuard() {
    try {
      history.pushState({ vaGuard: 1 }, '', location.href);
      _leaveArmed = true;
    } catch (err) { /* ignore */ }
  }

  function _askLeave() {
    const msg = (typeof t === 'function')
      ? (t('common.leaveConfirm') || 'Sur de vouloir quitter ?')
      : 'Sur de vouloir quitter ?';
    return confirm(msg);
  }

  window.addEventListener('load', function () {
    // Double push : le 1er back intercepte, le 2e (si confirm) sort vraiment
    setTimeout(_pushGuard, 0);
    setTimeout(_pushGuard, 50);
  });

  window.addEventListener('popstate', function () {
    if (_allowLeave) return;
    if (!_askLeave()) {
      _pushGuard();
      return;
    }
    _allowLeave = true;
    _leaveArmed = false;
    try { history.back(); } catch (err) { /* ignore */ }
  });
})();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    wsConnect();
  }
  if (ESP32_HOST_B && (!wsB || wsB.readyState === WebSocket.CLOSED || wsB.readyState === WebSocket.CLOSING)) {
    wsConnectB();
  }

  // Android vide les canvas quand la page est en arrière-plan → redessiner
  setTimeout(() => {
    if (_activeTab === 'analyse' && typeof analyseDraw === 'function') {
      analyseDraw();
    }
    if (_activeTab === 'analyse' && typeof AnalSession !== 'undefined' && AnalSession.syncUi) {
      AnalSession.syncUi();
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

if (!_isSetupPortalPage()) {
  wsConnect();
  // B après A (connexion l'une après l'autre)
  if (ESP32_HOST_B) setTimeout(wsConnectB, 800);
}