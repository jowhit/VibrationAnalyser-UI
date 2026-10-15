// calc.js — Outils de calcul : masse d'essai, combiner, diviser, influence 1P, influence 2P
(function() {
  const PI = Math.PI;

  // ─────────────────────────────────────────────────────────
  // Helpers complexes
  // ─────────────────────────────────────────────────────────

  // Vecteur polaire → complexe {re, im}
  function polar(amp, deg) {
    const rad = deg * PI / 180;
    return { re: amp * Math.cos(rad), im: amp * Math.sin(rad) };
  }

  // Addition complexe
  function cadd(a, b) { return { re: a.re+b.re, im: a.im+b.im }; }

  // Soustraction complexe
  function csub(a, b) { return { re: a.re-b.re, im: a.im-b.im }; }

  // Multiplication complexe
  function cmul(a, b) {
    return { re: a.re*b.re - a.im*b.im, im: a.re*b.im + a.im*b.re };
  }

  // Division complexe a/b
  function cdiv(a, b) {
    const d = b.re*b.re + b.im*b.im;
    if (d < 1e-30) return null; // division par zéro
    return { re: (a.re*b.re + a.im*b.im)/d, im: (a.im*b.re - a.re*b.im)/d };
  }

  // Module
  function cabs(a) { return Math.sqrt(a.re*a.re + a.im*a.im); }

  // Argument en degrés [0, 360)
  function carg(a) {
    let deg = Math.atan2(a.im, a.re) * 180 / PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  // Lire valeur d'un input (retourne NaN si vide/invalide)
  function val(id) { return parseFloat(document.getElementById(id).value); }

  // ─────────────────────────────────────────────────────────
  // Masse d'essai
  // ─────────────────────────────────────────────────────────
  const essaiBtn    = document.getElementById('calc-essai-btn');
  const essaiResult = document.getElementById('calc-essai-result');

  function calcMasseEssai() {
    const rpm   = val('calc-essai-rpm');
    const masse = val('calc-essai-masse');
    const rayon = val('calc-essai-rayon');
    if (isNaN(rpm)||isNaN(masse)||isNaN(rayon)||rpm<=0||masse<=0||rayon<=0) {
      essaiResult.textContent = 'Erreur saisie'; return;
    }
    const omega = 2 * PI * rpm / 60;
    const mt = (masse * 1000 * 0.1) / (rayon / 1000 * omega * omega / 9.81);
    essaiResult.textContent = mt > 0 ? mt.toFixed(2) + ' g' : 'Erreur calcul';
  }
  essaiBtn.addEventListener('click', calcMasseEssai);
  calcMasseEssai();

  // ─────────────────────────────────────────────────────────
  // Combiner deux masses
  // ─────────────────────────────────────────────────────────
  const combBtn    = document.getElementById('calc-combiner-btn');
  const combResult = document.getElementById('calc-combiner-result');

  function calcCombiner() {
    const m1 = val('calc-combiner-m1'), a1 = val('calc-combiner-a1');
    const m2 = val('calc-combiner-m2'), a2 = val('calc-combiner-a2');
    if (isNaN(m1)||isNaN(a1)||isNaN(m2)||isNaN(a2)) { combResult.textContent='Erreur saisie'; return; }
    const v = cadd(polar(m1, a1), polar(m2, a2));
    let ang = Math.atan2(v.im, v.re) * 180 / PI;
    if (ang < 0) ang += 360;
    combResult.textContent = cabs(v).toFixed(2) + ' g @ ' + Math.round(ang) + '°';
  }
  combBtn.addEventListener('click', calcCombiner);
  window.calcCombiner = calcCombiner;
  calcCombiner();

  // ─────────────────────────────────────────────────────────
  // Diviser une masse sur deux pales
  // ─────────────────────────────────────────────────────────
  const divBtn  = document.getElementById('calc-diviser-btn');
  const divRes1 = document.getElementById('calc-diviser-pale1-result');
  const divRes2 = document.getElementById('calc-diviser-pale2-result');

  function calcDiviser() {
    const masse = val('calc-diviser-masse');
    const angle = val('calc-diviser-angle');
    const pale1 = val('calc-diviser-pale1');
    const pale2 = val('calc-diviser-pale2');
    if (isNaN(masse)||isNaN(angle)||isNaN(pale1)||isNaN(pale2)||masse<=0) {
      divRes1.textContent = divRes2.textContent = 'Erreur saisie'; return;
    }
    if (pale1 === pale2) {
      divRes1.textContent = divRes2.textContent = 'Angles identiques'; return;
    }
    const m1 = Math.abs(masse * Math.cos((angle - pale1) * PI / 180));
    const m2 = Math.abs(masse * Math.cos((angle - pale2) * PI / 180));
    divRes1.textContent = m1.toFixed(2) + ' g @ ' + Math.round(pale1) + '°';
    divRes2.textContent = m2.toFixed(2) + ' g @ ' + Math.round(pale2) + '°';
  }
  divBtn.addEventListener('click', calcDiviser);
  window.calcDiviser = calcDiviser;
  calcDiviser();

  // ─────────────────────────────────────────────────────────
  // Gestion des sous-onglets (existants + nouveaux)
  // ─────────────────────────────────────────────────────────
  const tabs  = document.querySelectorAll('.calc-tab');
  const panes = document.querySelectorAll('.calc-pane');

  function switchCalcTab(paneId) {
    panes.forEach(p => p.classList.remove('active'));
    const active = document.getElementById('calc-' + paneId);
    if (active) active.classList.add('active');
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-pane') === paneId));
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const p = tab.getAttribute('data-pane');
      if (p) switchCalcTab(p);
    });
  });

  // ─────────────────────────────────────────────────────────
  // INFLUENCE 1 PLAN
  // ─────────────────────────────────────────────────────────
  //
  //  Méthode des coefficients d'influence :
  //    V1  = vecteur vibration Run 1 (baseline)
  //    V2  = vecteur vibration Run 2 (avec masse mt @ αt)
  //    T   = masse essai vecteur = mt ∠ αt
  //    IC  = (V2 - V1) / T         coefficient d'influence
  //    Wcorr = -V1 / IC = -V1 × T / (V2 - V1)
  //
  window.calcInfluence1P = function() {
    const errEl = document.getElementById('ic1-err');
    errEl.textContent = '';

    const a1 = val('ic1-a1'), p1 = val('ic1-p1');  // Run 1
    const mt = val('ic1-mt'), at = val('ic1-at');   // Masse essai
    const a2 = val('ic1-a2'), p2 = val('ic1-p2');  // Run 2

    if ([a1,p1,mt,at,a2,p2].some(isNaN) || a1<0 || mt<=0 || a2<0) {
      errEl.textContent = '⚠ Vérifiez les valeurs saisies.'; return;
    }

    const V1 = polar(a1, p1);
    const V2 = polar(a2, p2);
    const T  = polar(mt, at);

    // IC = (V2 - V1) / T
    const dV = csub(V2, V1);
    const IC = cdiv(dV, T);
    if (!IC || cabs(IC) < 1e-10) {
      errEl.textContent = '⚠ Run 1 et Run 2 identiques — vérifiez les données.'; return;
    }

    // Wcorr = -V1 / IC
    const Wneg = { re: -V1.re, im: -V1.im };
    const Wcorr = cdiv(Wneg, IC);
    if (!Wcorr) { errEl.textContent = '⚠ Erreur calcul (IC nul).'; return; }

    const masse = cabs(Wcorr);
    const angle = carg(Wcorr);

    document.getElementById('ic1-result-masse').textContent = masse.toFixed(2) + ' g';
    document.getElementById('ic1-result-angle').textContent = Math.round(angle) + '°';
  };

  // ─────────────────────────────────────────────────────────
  // INFLUENCE 2 PLANS
  // ─────────────────────────────────────────────────────────
  //
  //  Indices : A = Plan 1, B = Plan 2
  //  Runs : 1 = baseline, 2 = essai sur A, 3 = essai sur B
  //
  //  Coefficients d'influence :
  //    αAA = (V2A - V1A) / T1     effet du balourd sur A vu du plan A
  //    αBA = (V2B - V1B) / T1     effet du balourd sur A vu du plan B
  //    αAB = (V3A - V1A) / T2     effet du balourd sur B vu du plan A
  //    αBB = (V3B - V1B) / T2     effet du balourd sur B vu du plan B
  //
  //  Système 2×2 complexe :
  //    αAA·WA + αAB·WB = -V1A
  //    αBA·WA + αBB·WB = -V1B
  //
  //  Solution par règle de Cramer :
  //    det  = αAA·αBB - αAB·αBA
  //    WA   = (-V1A·αBB + αAB·V1B) / det
  //    WB   = ( αBA·V1A - αAA·V1B) / det
  //
  window.calcInfluence2P = function() {
    const errEl = document.getElementById('ic2-err');
    errEl.textContent = '';

    // Run 1 — baseline
    const a1p1=val('ic2-a1p1'), p1p1=val('ic2-p1p1');  // Plan1
    const a1p2=val('ic2-a1p2'), p1p2=val('ic2-p1p2');  // Plan2

    // Masses essai
    const mt1=val('ic2-mt1'), at1=val('ic2-at1');       // Sur Plan1
    const mt2=val('ic2-mt2'), at2=val('ic2-at2');       // Sur Plan2

    // Run 2 — masse sur Plan1
    const a2p1=val('ic2-a2p1'), p2p1=val('ic2-p2p1');
    const a2p2=val('ic2-a2p2'), p2p2=val('ic2-p2p2');

    // Run 3 — masse sur Plan2
    const a3p1=val('ic2-a3p1'), p3p1=val('ic2-p3p1');
    const a3p2=val('ic2-a3p2'), p3p2=val('ic2-p3p2');

    const all = [a1p1,p1p1,a1p2,p1p2,mt1,at1,mt2,at2,
                 a2p1,p2p1,a2p2,p2p2,a3p1,p3p1,a3p2,p3p2];
    if (all.some(isNaN) || mt1<=0 || mt2<=0) {
      errEl.textContent = '⚠ Vérifiez toutes les valeurs saisies.'; return;
    }

    // Vecteurs
    const V1A = polar(a1p1, p1p1);
    const V1B = polar(a1p2, p1p2);
    const T1  = polar(mt1,  at1);
    const T2  = polar(mt2,  at2);
    const V2A = polar(a2p1, p2p1);
    const V2B = polar(a2p2, p2p2);
    const V3A = polar(a3p1, p3p1);
    const V3B = polar(a3p2, p3p2);

    // Coefficients d'influence
    const αAA = cdiv(csub(V2A, V1A), T1);
    const αBA = cdiv(csub(V2B, V1B), T1);
    const αAB = cdiv(csub(V3A, V1A), T2);
    const αBB = cdiv(csub(V3B, V1B), T2);

    if (!αAA||!αBA||!αAB||!αBB) {
      errEl.textContent = '⚠ Division par zéro dans les coefficients.'; return;
    }

    // Déterminant : det = αAA·αBB - αAB·αBA
    const det = csub(cmul(αAA, αBB), cmul(αAB, αBA));
    if (cabs(det) < 1e-20) {
      errEl.textContent = '⚠ Système singulier — les plans sont trop couplés ou les données sont incorrectes.'; return;
    }

    // WA = (-V1A·αBB + αAB·V1B) / det
    const negV1A = { re: -V1A.re, im: -V1A.im };
    const negV1B = { re: -V1B.re, im: -V1B.im };
    const numA = cadd(cmul(negV1A, αBB), cmul(αAB, V1B));
    const WA   = cdiv(numA, det);

    // WB = (αBA·V1A - αAA·V1B) / det  =  (αBA·V1A + αAA·(-V1B)) / det
    const numB = cadd(cmul(αBA, V1A), cmul(αAA, negV1B));
    const WB   = cdiv(numB, det);

    if (!WA || !WB) { errEl.textContent = '⚠ Erreur calcul.'; return; }

    document.getElementById('ic2-r1-masse').textContent = cabs(WA).toFixed(2) + ' g';
    document.getElementById('ic2-r1-angle').textContent = Math.round(carg(WA)) + '°';
    document.getElementById('ic2-r2-masse').textContent = cabs(WB).toFixed(2) + ' g';
    document.getElementById('ic2-r2-angle').textContent = Math.round(carg(WB)) + '°';
  };

})();
