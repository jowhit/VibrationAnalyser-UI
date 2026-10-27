// i18n.js — FR / EN (+ futures langues) côté browser uniquement
const I18n = (() => {
  const LS_KEY = 'va_lang';
  const SUPPORTED = ['fr', 'en'];
  const CACHE_VER = '91';

  let _lang = 'fr';
  let _dicts = {};
  let _ready = false;
  const _listeners = [];

  function supported() { return SUPPORTED.slice(); }
  function getLang() { return _lang; }
  function isReady() { return _ready; }

  function t(key, vars) {
    if (!key) return '';
    const d = _dicts[_lang] || {};
    const fb = _dicts.fr || {};
    let s = d[key];
    if (s == null || s === '') s = fb[key];
    if (s == null || s === '') s = key;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        s = String(s).split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      const k = el.getAttribute('data-i18n');
      if (k) el.textContent = t(k);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      const k = el.getAttribute('data-i18n-html');
      if (k) el.innerHTML = t(k);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      const k = el.getAttribute('data-i18n-placeholder');
      if (k) el.setAttribute('placeholder', t(k));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      const k = el.getAttribute('data-i18n-title');
      if (k) el.setAttribute('title', t(k));
    });
    const titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = t(titleEl.getAttribute('data-i18n'));
  }

  function _notify() {
    _listeners.forEach(function (fn) {
      try { fn(_lang); } catch (e) {}
    });
  }

  function onChange(fn) {
    if (typeof fn === 'function') _listeners.push(fn);
  }

  function setLang(code) {
    if (SUPPORTED.indexOf(code) < 0) return false;
    _lang = code;
    try { localStorage.setItem(LS_KEY, code); } catch (e) {}
    try { document.documentElement.lang = code; } catch (e) {}
    applyDom();
    _notify();
    return true;
  }

  async function _loadOne(code) {
    const url = 'lang/' + code + '.json?v=' + CACHE_VER;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('i18n ' + code + ' HTTP ' + r.status);
    _dicts[code] = await r.json();
  }

  async function init() {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (SUPPORTED.indexOf(stored) >= 0) _lang = stored;
    } catch (e) {}
    try { document.documentElement.lang = _lang; } catch (e) {}

    const loads = SUPPORTED.map(function (code) {
      return _loadOne(code).catch(function (err) {
        console.warn('i18n load failed:', code, err);
        if (!_dicts[code]) _dicts[code] = {};
      });
    });
    await Promise.all(loads);
    _ready = true;
    applyDom();
    return _lang;
  }

  return {
    init: init,
    t: t,
    setLang: setLang,
    getLang: getLang,
    supported: supported,
    applyDom: applyDom,
    onChange: onChange,
    isReady: isReady,
    CACHE_VER: CACHE_VER
  };
})();

window.I18n = I18n;
window.t = function (key, vars) {
  return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, vars) : key;
};
