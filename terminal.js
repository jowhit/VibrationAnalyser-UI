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
  wsSend(val);
  inp.value = '';
}

document.getElementById('term-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') termSendInput();
});
