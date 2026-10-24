// terminal.js — affichage terminal + envoi
const termEl = document.getElementById('terminal');
let termAutoScroll = true;

termEl.addEventListener('scroll', () => {
  termAutoScroll = (termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight) < 40;
});

function termAddLine(text, cls) {
  const d = document.createElement('div');
  d.className = 'line';
  if (cls) {
    d.className += ' ' + cls;
  } else if (text.includes('===') || /^\d:/.test(text)) {
    d.className += ' menu';
  }
  d.textContent = text;
  termEl.appendChild(d);
  if (termEl.children.length > 800) termEl.removeChild(termEl.firstChild);
  if (termAutoScroll) termEl.scrollTop = termEl.scrollHeight;
}

function termClear() { termEl.innerHTML = ''; }

/** Copie tout le journal terminal (sélection tactile difficile sur Android). */
function termCopyLog() {
  if (!termEl) return;
  const lines = [];
  const kids = termEl.children;
  for (let i = 0; i < kids.length; i++) {
    const t = (kids[i].textContent || '').trimEnd();
    if (t) lines.push(t);
  }
  const text = lines.join('\n');
  if (!text) {
    termAddLine('[log] (vide)', 'sys');
    return;
  }
  const done = function (ok) {
    termAddLine(ok ? '[log] copié (' + lines.length + ' lignes)' : '[log] !! copie échouée', 'sys');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () {
      _termCopyFallback(text, done);
    });
  } else {
    _termCopyFallback(text, done);
  }
}
window.termCopyLog = termCopyLog;

function _termCopyFallback(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    done(!!ok);
  } catch (e) {
    done(false);
  }
}

function termSendInput() {
  const inp = document.getElementById('term-input');
  const val = inp.value;
  if (!val) return;
  inp.value = '';
  const clean = val.trim();
  // Commandes locales browser (pas envoyées à l'ESP)
  if (/^invert(a|b)?\b/i.test(clean)) {
    termAddLine('>> ' + clean, 'sent');
    if (typeof handleInvertCommand === 'function') handleInvertCommand(clean);
    else termAddLine('!! handleInvertCommand absent — recharge app.js', 'sys');
    return;
  }
  wsSend(val);
}

document.getElementById('term-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') termSendInput();
});
