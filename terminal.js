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
