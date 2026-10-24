// balance.js — Équilibrage 1 plan et 2 plans
// Mode 2P mono : table d'étapes A-B-B-A-A-B (déplacement sonde)
// Mode 2P duo  : ProbeMode A+B → capture A+B simultanée (même ICM)
// ════════════════════════════════════════════════════════════════

const BalanceModule = (() => {

  const S = Object.freeze({
    UNKNOWN:'UNKNOWN', IDLE:'IDLE', RPM_SCAN:'RPM_SCAN',
    RUN1_READY:'RUN1_READY', RUN1_RUNNING:'RUN1_RUNNING',
    R2_CONFIG:'R2_CONFIG',
    RUN2_READY:'RUN2_READY', RUN2_RUNNING:'RUN2_RUNNING',
    CORRECTION:'CORRECTION',
    RUNX_READY:'RUNX_READY', RUNX_RUNNING:'RUNX_RUNNING',
  });

  const BAL_TACH_STALE_MS = 1500;

  let state  = S.UNKNOWN;
  let sendFn = null;
  let _mode  = null;
  /** true = 2P + ProbeMode AB : sondes fixes, capture simultanée */
  let _duo2P = false;
  /** Évite de redemander la sauvegarde à chaque clic après calcul. */
  let _saveOfferedThisProc = false;
  /** Session pause (localStorage) — survit au refresh. */
  const BAL_LS_KEY = 'va_balance_v1';
  let _sessionPaused = false;
  let _espStateName = 'IDLE';

  // ── Données 1P ───────────────────────────────────────────────
  let _run1=null, _run2=null, _runs1P=[];
  let _testMass1P=0, _testAngle1P=0;
  let _influenceRatio=0, _phaseShift=0, _runXcount=2;

  // ── Données 2P ───────────────────────────────────────────────
  // _meas[cond]['A'|'B'] = {amp, phase}
  let _meas = [ {A:null,B:null}, {A:null,B:null}, {A:null,B:null} ];
  let _trialMasses = [ {mass:0,angle:0}, {mass:0,angle:0} ];
  let _influence2P = null;   // { aAA, aAB, aBA, aBB, D } — complexes pour RunX

  // Polaires 2P
  let _polarPtsA=[], _polarPtsB=[];

  // ── Table d'étapes 2P mono (déplacement sonde) ───────────────
  const STEPS = [
    { type:'start', btn:'Démarrer',           sensor:null  },
    { type:'burst', btn:'Run 1 A  ▶',         sensor:'A'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'A',  key:[0,'A'] },
    { type:'burst', btn:'Run 1 B  ▶',         sensor:'B'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'B',  key:[0,'B'] },
    { type:'mass',  btn:'📦 Valider masse A',  sensor:null, massIdx:0, needsAccept:true  },
    { type:'burst', btn:'Run 2 B  ▶',         sensor:'B'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'B',  key:[1,'B'] },
    { type:'burst', btn:'Run 2 A  ▶',         sensor:'A'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'A',  key:[1,'A'] },
    { type:'mass',  btn:'📦 Valider masse B',  sensor:null, massIdx:1, needsAccept:false },
    { type:'burst', btn:'Run 3 A  ▶',         sensor:'A'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'A',  key:[2,'A'] },
    { type:'burst', btn:'Run 3 B  ▶',         sensor:'B'   },
    { type:'capt',  btn:'✓ Capturer',          sensor:'B',  key:[2,'B'], computeICM:true },
  ];
  const STEPS_LEN = STEPS.length;

  // ── Table 2P duo (sondes fixes A=palier A, B=palier B) ──────
  // Un seul Capturer fige les deux moyennes. Même _icm2P ensuite.
  const STEPS_DUO = [
    { type:'start', btn:'Démarrer',              sensor:'AB' },
    { type:'burst', btn:'Run 1 A+B  ▶',          sensor:'AB' },
    { type:'capt',  btn:'✓ Capturer A+B',         sensor:'AB', both:true, keys:[[0,'A'],[0,'B']] },
    { type:'mass',  btn:'📦 Valider masse A',     sensor:null, massIdx:0, sendR2:true },
    { type:'burst', btn:'Run 2 A+B  ▶',          sensor:'AB' },
    { type:'capt',  btn:'✓ Capturer A+B',         sensor:'AB', both:true, keys:[[1,'A'],[1,'B']] },
    { type:'mass',  btn:'📦 Valider masse B',     sensor:null, massIdx:1, needsAccept:true },
    { type:'burst', btn:'Run 3 A+B  ▶',          sensor:'AB' },
    { type:'capt',  btn:'✓ Capturer A+B',         sensor:'AB', both:true, keys:[[2,'A'],[2,'B']], computeICM:true },
  ];
  const STEPS_DUO_LEN = STEPS_DUO.length;

  let _2pStep = 0;

  // RunX storage : { [runNum]: {A:null, B:null} }
  let _runXData = {};

  // ── Moyennage vectoriel (mono = slot A ; duo = A et B) ───────
  // Fenêtre glissante + chauffe JS + reset phasor (léger)
  const BAL_WARMUP = 4;             // tours ignorés après Start/Capturer (JS)
  const BAL_JUMP_THR = 0.45;        // distance phasor / amp_moy
  const BAL_JUMP_NEED = 2;          // 2 tours suspects d'affilée → reset
  let _winMax = 16;                 // 8 / 16 / 32 (opérateur)
  let _winA = [];                   // {re,im}[]
  let _winB = [];
  let _avgRe=0, _avgIm=0, _tourCount=0;   // sommes / N fenêtre A
  let _avgReB=0, _avgImB=0, _tourCountB=0;
  let _warmA = 0, _warmB = 0;
  let _jumpA = 0, _jumpB = 0;
  let _suppressLiveTour = false;
  let _pending2pCapt = null;
  let _lastTachMs = 0;
  let _tachStaleTimer = null;

  // ── DOM ──────────────────────────────────────────────────────
  let _canvas1P, _ctx1P, _canvasA, _ctxA, _canvasB, _ctxB;
  let statusEl, logEl, resultEl, btnRun, btnResetTop, btnSaveCoeff, btnLoadCoeff;
  let btnMode1p, btnMode2p, inMass, inAngle;
  let _initialized=false;
  let _nvsCoeffValid=false;
  let _nvsCoeffMode=null;
  let _coeffLoaded=false;

  function _result2pHtml() {
    const el = document.getElementById('bal-result-2p');
    return el ? el.innerHTML : '';
  }

  function _isFiniteNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }
  function _cxOk(z) {
    return z && typeof z === 'object' && _isFiniteNum(z.r) && _isFiniteNum(z.i);
  }
  function _influence2PComplete(inv) {
    if (!inv || typeof inv !== 'object') return false;
    const { aAA, aAB, aBA, aBB, D } = inv;
    return _cxOk(aAA) && _cxOk(aAB) && _cxOk(aBA) && _cxOk(aBB) && _cxOk(D);
  }
  function _cxPolar(z) {
    const amp = Math.sqrt(z.r * z.r + z.i * z.i);
    let ph = Math.atan2(z.i, z.r) * 180 / Math.PI;
    if (ph < 0) ph += 360;
    return { amp, phase: ph };
  }
  function _polarCx(amp, phase) {
    const r = phase * Math.PI / 180;
    return { r: amp * Math.cos(r), i: amp * Math.sin(r) };
  }
  function _parseKeyFloat(line, key) {
    const i = line.indexOf(key);
    if (i < 0) return NaN;
    return parseFloat(line.slice(i + key.length));
  }
  function _canSaveCoeff() {
    if (_mode === '1P') return _influenceRatio > 0 && !!_run1 && !!_run2;
    // 2P : dès que la matrice est calculée (ne pas attendre _2pStep — ICM
    // est appelé AVANT _advanceStep sur la dernière capture)
    if (_mode === '2P') return _influence2PComplete(_influence2P);
    return false;
  }
  function _canLoadCoeff() {
    if (!_nvsCoeffValid || !_nvsCoeffMode) return false;
    return _nvsCoeffMode === (_mode === '1P' ? '1P' : '2P');
  }
  function _updateCoeffButtons() {
    if (btnSaveCoeff) {
      btnSaveCoeff.disabled = !_canSaveCoeff();
    }
    if (btnLoadCoeff) {
      btnLoadCoeff.disabled = !_canLoadCoeff();
    }
    if (btnMode1p) btnMode1p.classList.toggle('bal-mode-toggle--active', _mode === '1P');
    if (btnMode2p) btnMode2p.classList.toggle('bal-mode-toggle--active', _mode === '2P');
    _updateModeLock();
  }

  function clearSession() {
    _procedureResetLocal(false);
    _coeffLoaded = false;
    _influenceRatio = 0;
    _phaseShift = 0;
    _influence2P = null;
    _sessionPaused = false;
    _clearStorage();
    _clearBalLogs();
    _mode = '1P';
    setMode('1P');
    state = S.IDLE;
    _updateUI();
    _updateCoeffButtons();
    _updateModeLock();
    _updatePauseBanner();
    if (typeof BalanceSession !== 'undefined' && BalanceSession.markIdle) {
      BalanceSession.markIdle();
    }
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  function init(send) {
    sendFn = send;
    if (_initialized) { sendFn('BAL_INIT\n'); return; }
    _initialized = true;

    _canvas1P = document.getElementById('bal-canvas');
    _ctx1P = _canvas1P ? _canvas1P.getContext('2d') : null;
    _canvasA = document.getElementById('bal-canvas-a');
    _ctxA = _canvasA ? _canvasA.getContext('2d') : null;
    _canvasB = document.getElementById('bal-canvas-b');
    _ctxB = _canvasB ? _canvasB.getContext('2d') : null;

    statusEl = document.getElementById('bal-status');
    logEl = document.getElementById('bal-log');
    resultEl = document.getElementById('bal-result');
    btnRun = document.getElementById('btn-bal-run');
    btnResetTop = document.getElementById('btn-bal-reset-top');
    btnSaveCoeff = document.getElementById('btn-bal-save-coeff');
    btnLoadCoeff = document.getElementById('btn-bal-load-coeff');
    btnMode1p = document.getElementById('btn-bal-mode-1p');
    btnMode2p = document.getElementById('btn-bal-mode-2p');
    inMass = null;
    inAngle = null;
    _bindTrialInputs();

    if (btnRun) btnRun.addEventListener('click', _doRun);
    if (btnResetTop) btnResetTop.addEventListener('click', doReset);
    if (btnSaveCoeff) btnSaveCoeff.addEventListener('click', doSaveCoeff);
    if (btnLoadCoeff) btnLoadCoeff.addEventListener('click', doLoadCoeff);
    if (btnMode1p) btnMode1p.addEventListener('click', () => setMode('1P'));
    if (btnMode2p) btnMode2p.addEventListener('click', () => setMode('2P'));
    const btnResume = document.getElementById('btn-bal-resume');
    if (btnResume) {
      btnResume.addEventListener('click', function () {
        if (typeof BalanceSession !== 'undefined' && BalanceSession.resume) {
          BalanceSession.resume();
        } else {
          resumeSession();
        }
      });
    }
    const btnCopyLog = document.getElementById('btn-bal-copy-log');
    if (btnCopyLog) btnCopyLog.addEventListener('click', copyLog);
    const btnMore = document.getElementById('btn-bal-more');
    const morePanel = document.getElementById('bal-more-panel');
    if (btnMore && morePanel) {
      btnMore.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = morePanel.style.display !== 'none';
        morePanel.style.display = open ? 'none' : 'flex';
        btnMore.classList.toggle('bal-more-open', !open);
        btnMore.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      document.addEventListener('click', function () {
        if (morePanel.style.display === 'none') return;
        morePanel.style.display = 'none';
        btnMore.classList.remove('bal-more-open');
        btnMore.setAttribute('aria-expanded', 'false');
      });
      morePanel.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    document.querySelectorAll('[data-bal-win]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const n = parseInt(btn.getAttribute('data-bal-win'), 10);
        if (n === 8 || n === 16 || n === 32) setWinMax(n);
      });
    });
    window.addEventListener('resize', resize);

    try {
      const w = parseInt(localStorage.getItem('bal_win_max'), 10);
      if (w === 8 || w === 16 || w === 32) _winMax = w;
    } catch (e) {}

    log('Module équilibrage prêt');
    state = S.IDLE;
    if (!_mode) setMode('1P');
    _restoreFromStorageIfAny();
    if (_sessionPaused && typeof BalanceSession !== 'undefined' && BalanceSession.markPaused) {
      BalanceSession.markPaused();
    }
    _updateUI();
    _updateCoeffButtons();
    _updatePauseBanner();
    _updateWinButtons();
    sendFn('BAL_INIT\n');
  }

  function _isDuo2P() {
    return _mode === '2P' && _duo2P;
  }

  function _refreshDuoFlag() {
    _duo2P = (typeof ProbeMode !== 'undefined' && ProbeMode.isDual());
  }

  /** Envoi BAL_* — duo = A+B ; mono B = wsSend route déjà vers B. */
  function _balSend(cmd) {
    const clean = (cmd || '').replace(/\n+$/, '');
    if (_isDuo2P()) {
      if (typeof DualSession !== 'undefined') {
        DualSession.begin();
        DualSession.sendBoth(clean);
      } else {
        if (typeof wsSend === 'function') wsSend(clean);
        else if (sendFn) sendFn(clean + '\n');
        if (typeof wsSendB === 'function') wsSendB(clean);
      }
    } else if (typeof wsSend === 'function') {
      wsSend(clean); // respecte ProbeMode mono B
    } else if (sendFn) {
      sendFn(clean + '\n');
    }
  }

  function _stepsLen() { return _isDuo2P() ? STEPS_DUO_LEN : STEPS_LEN; }

  function _startTachWatch() {
    _stopTachWatch();
    _lastTachMs = Date.now();
    _tachStaleTimer = setInterval(function () {
      if (!_lastTachMs) return;
      if (Date.now() - _lastTachMs < BAL_TACH_STALE_MS) return;
      _updateRpm(0);
    }, 250);
  }

  function _stopTachWatch() {
    if (_tachStaleTimer) { clearInterval(_tachStaleTimer); _tachStaleTimer = null; }
  }

  /**
   * @param {{ skipInit?: boolean }} [opts] skipInit après EQ_RESUME (évite double BAL_INIT)
   */
  function enterBalance(opts) {
    opts = opts || {};
    const main = document.getElementById('bal-main');
    if (main) main.style.display = 'flex';
    _refreshDuoFlag();
    if (!_mode) setMode('1P');
    else if (_mode === '2P') setMode('2P'); // re-évalue duo
    if (!_sessionPaused && !opts.skipInit) {
      _balSend('BAL_INIT');
    }
    if (!_sessionPaused) _startTachWatch();
    _updatePauseBanner();
    setTimeout(resize, 60);
  }

  function _resizeCnv(wrapId, cnv) {
    if (!cnv) return;
    const wrap=document.getElementById(wrapId);
    if (!wrap||wrap.offsetParent===null) return;
    if (wrap.clientWidth===0||wrap.clientHeight===0){setTimeout(()=>{ _resizeCnv(wrapId,cnv); },60);return;}
    const sz=Math.min(wrap.clientWidth,wrap.clientHeight,380);
    cnv.width=sz; cnv.height=sz;
  }

  // ════════════════════════════════════════════════════════════
  // SÉLECTION MODE
  // ════════════════════════════════════════════════════════════
  /** Procédure 2P déjà engagée → ne plus basculer vers 1 Plan. */
  function _is2PProcedureActive() {
    return _mode === '2P' && _2pStep > 0;
  }
  /** 1P démarré (après IDLE) → ne plus basculer vers 2 Plans. */
  function _is1PProcedureActive() {
    return _mode === '1P' && state && state !== S.IDLE && state !== S.UNKNOWN;
  }

  function _updateModeLock() {
    const lockTo1p = _is2PProcedureActive();
    const lockTo2p = _is1PProcedureActive();
    if (btnMode1p) {
      btnMode1p.disabled = lockTo1p;
      btnMode1p.classList.toggle('bal-mode-toggle--locked', lockTo1p);
      btnMode1p.title = lockTo1p
        ? 'Procédure 2 plans en cours — Reset pour changer'
        : 'Mode 1 plan';
    }
    if (btnMode2p) {
      btnMode2p.disabled = lockTo2p;
      btnMode2p.classList.toggle('bal-mode-toggle--locked', lockTo2p);
      btnMode2p.title = lockTo2p
        ? 'Procédure 1 plan en cours — Reset pour changer'
        : 'Mode 2 plans';
    }
  }

  function setMode(mode) {
    if (mode === '1P' && _is2PProcedureActive()) {
      setStatus('Procédure 2 plans en cours — Reset pour passer en 1 Plan', 'err');
      return;
    }
    if (mode === '2P' && _is1PProcedureActive()) {
      setStatus('Procédure 1 plan en cours — Reset pour passer en 2 Plans', 'err');
      return;
    }
    _mode = mode;
    _refreshDuoFlag();
    _bindTrialInputs();
    const l1 = document.getElementById('bal-layout-1p');
    const l2 = document.getElementById('bal-layout-2p');
    const rpm1 = document.getElementById('bal-rpm');
    const rpm2 = document.getElementById('bal-rpm-2p');
    if (l1) l1.style.display = mode === '1P' ? 'flex' : 'none';
    if (l2) l2.style.display = mode === '2P' ? 'flex' : 'none';
    if (rpm1) rpm1.style.display = mode === '1P' ? 'flex' : 'none';
    if (rpm2) rpm2.style.display = mode === '2P' ? 'flex' : 'none';
    if (mode === '2P') {
      if (_duo2P && typeof DualSession !== 'undefined') DualSession.begin();
      _update2PStatus();
      setTimeout(() => { _resizeCnv('bal-polar-a', _canvasA); _resizeCnv('bal-polar-b', _canvasB); _drawAll2P(); }, 60);
    } else {
      setTimeout(() => { _resizeCnv('bal-canvas-wrap', _canvas1P); _drawPolar1P(); }, 60);
    }
    const duoLbl = _duo2P ? '2 Plans duo (A+B simultanés)' : '2 Plans (déplacement sonde)';
    log('Mode: ' + (mode === '1P' ? '1 Plan' : duoLbl));
    _updateUI();
    _updateCoeffButtons();
    _updateModeLock();
  }

  function selectSensor() { /* réservé */ }

  // ════════════════════════════════════════════════════════════
  // DFT 1X
  // ════════════════════════════════════════════════════════════
  function _dft1X(samples, gRange, N) {
    const lsbPerG=16384/gRange;
    let mean=0; for(let i=0;i<N;i++) mean+=samples[i]; mean/=N;
    let sc=0, ss=0;
    for(let i=0;i<N;i++){
      const v=(samples[i]-mean)/lsbPerG;
      const hw=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));
      const a=2*Math.PI*i/N;
      sc+=v*hw*Math.cos(a); ss+=v*hw*Math.sin(a);
    }
    sc/=N; ss/=N;
    const amp=2*Math.sqrt(sc*sc+ss*ss);
    let ph=Math.atan2(ss,sc)*180/Math.PI; if(ph<0)ph+=360;
    return {amp,phase:ph};
  }

  // ════════════════════════════════════════════════════════════
  // ICM 1 PLAN
  // ════════════════════════════════════════════════════════════
  function _icm1P(r1,r2,mass,angle) {
    const toR=d=>d*Math.PI/180;
    const dr=r2.amp*Math.cos(toR(r2.phase))-r1.amp*Math.cos(toR(r1.phase));
    const di=r2.amp*Math.sin(toR(r2.phase))-r1.amp*Math.sin(toR(r1.phase));
    const dAmp=Math.sqrt(dr*dr+di*di), ratio=dAmp/mass;
    let dPh=Math.atan2(di,dr)*180/Math.PI; if(dPh<0)dPh+=360;
    let pSh=dPh-angle; if(pSh>180)pSh-=360; if(pSh<=-180)pSh+=360;
    const corrMass=ratio>0?r1.amp/ratio:0;
    let corrAngle=r1.phase+180-pSh; corrAngle=((corrAngle%360)+360)%360;
    return {corrMass,corrAngle,ratio,pSh};
  }

  // ════════════════════════════════════════════════════════════
  // ICM 2 PLANS — Cramer 2×2 complexe
  // Retourne corrections + matrice d'influence stockée pour RunX
  // ════════════════════════════════════════════════════════════
  function _icm2P(v1a,v1b,v2a,v2b,v3a,v3b,mA,angA,mB,angB) {
    const toR=d=>d*Math.PI/180;
    const cx=(a,p)=>({r:a*Math.cos(toR(p)),i:a*Math.sin(toR(p))});
    const sub=(a,b)=>({r:a.r-b.r,i:a.i-b.i});
    const sc=(v,s)=>({r:v.r/s,i:v.i/s});
    const mul=(a,b)=>({r:a.r*b.r-a.i*b.i,i:a.r*b.i+a.i*b.r});
    const det=(a,b,c,d)=>({r:a.r*d.r-a.i*d.i-(b.r*c.r-b.i*c.i),i:a.r*d.i+a.i*d.r-(b.r*c.i+b.i*c.r)});
    const div=(n,d)=>{const m2=d.r*d.r+d.i*d.i;return{r:(n.r*d.r+n.i*d.i)/m2,i:(n.i*d.r-n.r*d.i)/m2};};
    const polar=v=>{const amp=Math.sqrt(v.r*v.r+v.i*v.i);let ph=Math.atan2(v.i,v.r)*180/Math.PI;if(ph<0)ph+=360;return{amp,phase:ph};};

    const V1A=cx(v1a.amp,v1a.phase), V1B=cx(v1b.amp,v1b.phase);
    const aAA=sc(sub(cx(v2a.amp,v2a.phase),V1A),mA);
    const aAB=sc(sub(cx(v3a.amp,v3a.phase),V1A),mB);
    const aBA=sc(sub(cx(v2b.amp,v2b.phase),V1B),mA);
    const aBB=sc(sub(cx(v3b.amp,v3b.phase),V1B),mB);
    const D=det(aAA,aAB,aBA,aBB);
    if(D.r*D.r+D.i*D.i<1e-30) return null;

    const CA=div(sub(mul(aBB,V1A),mul(aAB,V1B)),D);
    const CB=div(sub(mul(aAA,V1B),mul(aBA,V1A)),D);
    const pA=polar(CA), pB=polar(CB);
    return {
      planA:{mass:pA.amp,angle:((pA.phase+180)%360+360)%360},
      planB:{mass:pB.amp,angle:((pB.phase+180)%360+360)%360},
      influence:{aAA,aAB,aBA,aBB,D,V1A,V1B}
    };
  }

  // Correction résiduelle à partir de la matrice stockée
  function _corrResiduelle(vNewA,vNewB) {
    if (!_influence2P) return null;
    const {aAA,aAB,aBA,aBB,D}=_influence2P;
    const toR=d=>d*Math.PI/180;
    const cx=(a,p)=>({r:a*Math.cos(toR(p)),i:a*Math.sin(toR(p))});
    const sub=(a,b)=>({r:a.r-b.r,i:a.i-b.i});
    const mul=(a,b)=>({r:a.r*b.r-a.i*b.i,i:a.r*b.i+a.i*b.r});
    const div=(n,d)=>{const m2=d.r*d.r+d.i*d.i;return{r:(n.r*d.r+n.i*d.i)/m2,i:(n.i*d.r-n.r*d.i)/m2};};
    const polar=v=>{const amp=Math.sqrt(v.r*v.r+v.i*v.i);let ph=Math.atan2(v.i,v.r)*180/Math.PI;if(ph<0)ph+=360;return{amp,phase:ph};};
    const VA=cx(vNewA.amp,vNewA.phase), VB=cx(vNewB.amp,vNewB.phase);
    const CA=div(sub(mul(aBB,VA),mul(aAB,VB)),D);
    const CB=div(sub(mul(aAA,VB),mul(aBA,VA)),D);
    const pA=polar(CA), pB=polar(CB);
    return {
      planA:{mass:pA.amp,angle:((pA.phase+180)%360+360)%360},
      planB:{mass:pB.amp,angle:((pB.phase+180)%360+360)%360}
    };
  }

  // ════════════════════════════════════════════════════════════
  // RÉCEPTION TOUR BINAIRE
  // ════════════════════════════════════════════════════════════
  function setWinMax(n) {
    if (n !== 8 && n !== 16 && n !== 32) return;
    _winMax = n;
    try { localStorage.setItem('bal_win_max', String(n)); } catch (e) {}
    _trimWindow('A');
    _trimWindow('B');
    _updateWinButtons();
    log('Fenêtre moyenne = ' + n + ' tours');
  }

  function _updateWinButtons() {
    document.querySelectorAll('[data-bal-win]').forEach(function (btn) {
      const n = parseInt(btn.getAttribute('data-bal-win'), 10);
      btn.classList.toggle('bal-mode-toggle--active', n === _winMax);
    });
  }

  function _trimWindow(ch) {
    const isA = ch === 'A';
    const win = isA ? _winA : _winB;
    while (win.length > _winMax) {
      const old = win.shift();
      if (isA) { _avgRe -= old.re; _avgIm -= old.im; _tourCount = win.length; }
      else { _avgReB -= old.re; _avgImB -= old.im; _tourCountB = win.length; }
    }
  }

  function _clearWindow(ch) {
    if (ch === 'A') {
      _winA = []; _avgRe = 0; _avgIm = 0; _tourCount = 0; _jumpA = 0;
    } else {
      _winB = []; _avgReB = 0; _avgImB = 0; _tourCountB = 0; _jumpB = 0;
    }
  }

  /**
   * Ajoute un tour à la moyenne (fenêtre + chauffe + reset phasor).
   * Reset phasor = distance complexe / amp — coût négligeable.
   * @returns {{amp:number,phase:number}|null} moyenne courante
   */
  function _pushTourAvg(ch, amp, phase) {
    const isA = ch === 'A';
    const re = amp * Math.cos(phase * Math.PI / 180);
    const im = amp * Math.sin(phase * Math.PI / 180);
    const tag = isA ? (_isDuo2P() ? 'A' : '') : 'B';

    if (isA ? _warmA > 0 : _warmB > 0) {
      if (isA) _warmA--; else _warmB--;
      const left = isA ? _warmA : _warmB;
      log('T' + tag + ' chauffe (' + (BAL_WARMUP - left) + '/' + BAL_WARMUP +
          ')  ' + amp.toFixed(3) + 'g @' + Math.round(phase) + '°');
      return isA ? _getLiveAvg() : _getLiveAvgB();
    }

    const count = isA ? _tourCount : _tourCountB;
    if (count >= 2) {
      const sRe = isA ? _avgRe : _avgReB;
      const sIm = isA ? _avgIm : _avgImB;
      const mRe = sRe / count, mIm = sIm / count;
      const mAmp = Math.sqrt(mRe * mRe + mIm * mIm) || 1e-9;
      const dist = Math.sqrt((re - mRe) * (re - mRe) + (im - mIm) * (im - mIm));
      if (dist / mAmp > BAL_JUMP_THR) {
        if (isA) _jumpA++; else _jumpB++;
        const streak = isA ? _jumpA : _jumpB;
        if (streak < BAL_JUMP_NEED) {
          log('T' + tag + ' suspect Δphasor — ignoré (' + streak + '/' + BAL_JUMP_NEED + ')');
          return isA ? _getLiveAvg() : _getLiveAvgB();
        }
        _clearWindow(ch);
        log('T' + tag + ' RESET phasor (changement détecté)');
      } else {
        if (isA) _jumpA = 0; else _jumpB = 0;
      }
    }

    const win = isA ? _winA : _winB;
    if (win.length >= _winMax) {
      const old = win.shift();
      if (isA) { _avgRe -= old.re; _avgIm -= old.im; }
      else { _avgReB -= old.re; _avgImB -= old.im; }
    }
    win.push({ re: re, im: im });
    if (isA) {
      _avgRe += re; _avgIm += im; _tourCount = win.length;
    } else {
      _avgReB += re; _avgImB += im; _tourCountB = win.length;
    }

    const avg = isA ? _getLiveAvg() : _getLiveAvgB();
    if (avg) {
      log('T' + tag + _tourCountFor(ch) + '  ' + amp.toFixed(3) + 'g @' + Math.round(phase) +
          '°  →  Moy(' + _tourCountFor(ch) + '/' + _winMax + '): ' +
          avg.amp.toFixed(3) + 'g @' + Math.round(avg.phase) + '°');
    }
    return avg;
  }

  function _tourCountFor(ch) { return ch === 'A' ? _tourCount : _tourCountB; }

  function onTourBinary(rpm,range,n,samples) {
    if(![S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING].includes(state)) return;
    if (_suppressLiveTour) return;
    const {amp,phase}=_dft1X(samples,range,n);
    const avg=_pushTourAvg('A', amp, phase);
    _updateRpm(rpm);
    if (!avg) {
      if (_mode==='1P') _drawPolar1P();
      else if (_isDuo2P()) { _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA); _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB); }
      else _drawAll2P();
      if (_isDuo2P()) _updateUI();
      return;
    }
    if (_mode==='1P') {
      _drawLivePolar(_ctx1P,_canvas1P,_runs1P,avg.amp,avg.phase,_tourCount);
    } else if (_isDuo2P()) {
      _drawLivePolar(_ctxA,_canvasA,_polarPtsA,avg.amp,avg.phase,_tourCount);
      const avgB=_getLiveAvgB();
      if (avgB) _drawLivePolar(_ctxB,_canvasB,_polarPtsB,avgB.amp,avgB.phase,_tourCountB);
      else _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
    } else {
      const activeSensor=_getActiveSensor2P();
      if (activeSensor==='A') { _drawLivePolar(_ctxA,_canvasA,_polarPtsA,avg.amp,avg.phase,_tourCount); _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB); }
      else                    { _drawLivePolar(_ctxB,_canvasB,_polarPtsB,avg.amp,avg.phase,_tourCount); _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA); }
    }
    if (_isDuo2P()) _updateUI();
  }

  /** Tour ESP B — uniquement mode 2P duo. */
  function onTourBinaryB(rpm,range,n,samples) {
    if (!_isDuo2P()) return;
    if(![S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING].includes(state)) return;
    if (_suppressLiveTour) return;
    const {amp,phase}=_dft1X(samples,range,n);
    const avg=_pushTourAvg('B', amp, phase);
    _updateRpm(rpm);
    if (avg) _drawLivePolar(_ctxB,_canvasB,_polarPtsB,avg.amp,avg.phase,_tourCountB);
    else _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
    const avgA=_getLiveAvg();
    if (avgA) _drawLivePolar(_ctxA,_canvasA,_polarPtsA,avgA.amp,avgA.phase,_tourCount);
    else _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);
    _updateUI();
  }

  function onRpmB(rpm) {
    if (!_isDuo2P()) return;
    _updateRpm(rpm);
  }

  function _getActiveSensor2P() {
    const def=_getStepDef(_2pStep);
    return def?def.sensor:null;
  }

  function _getLiveAvg() {
    if (_tourCount===0) return null;
    const amp=Math.sqrt(_avgRe*_avgRe+_avgIm*_avgIm)/_tourCount;
    let ph=Math.atan2(_avgIm,_avgRe)*180/Math.PI; if(ph<0)ph+=360;
    return {amp,phase:ph};
  }
  function _getLiveAvgB() {
    if (_tourCountB===0) return null;
    const amp=Math.sqrt(_avgReB*_avgReB+_avgImB*_avgImB)/_tourCountB;
    let ph=Math.atan2(_avgImB,_avgReB)*180/Math.PI; if(ph<0)ph+=360;
    return {amp,phase:ph};
  }

  function _resetAvg() {
    _winA = []; _winB = [];
    _avgRe=0; _avgIm=0; _tourCount=0;
    _avgReB=0; _avgImB=0; _tourCountB=0;
    _warmA = BAL_WARMUP; _warmB = BAL_WARMUP;
    _jumpA = 0; _jumpB = 0;
    if (_mode==='2P') _drawAll2P(); else _drawPolar1P();
  }

  function copyLog() {
    const el = _mode === '2P'
      ? document.getElementById('bal-log-2p')
      : document.getElementById('bal-log');
    const text = el ? (el.innerText || el.textContent || '') : '';
    if (!text.trim()) {
      setStatus('Log vide', 'err');
      return;
    }
    const done = function () {
      setStatus('Log copié', 'ok');
      log('📋 Log copié (' + text.split('\n').length + ' lignes)');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        _copyLogFallback(text, done);
      });
    } else {
      _copyLogFallback(text, done);
    }
  }

  function _copyLogFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (done) done();
    } catch (e) {
      setStatus('Copie log échouée', 'err');
    }
  }

  // ════════════════════════════════════════════════════════════
  // DÉFINITION DE L'ÉTAPE COURANTE
  // ════════════════════════════════════════════════════════════
  function _getStepDef(step) {
    if (_isDuo2P()) {
      if (step < STEPS_DUO_LEN) return STEPS_DUO[step];
      const rel = step - STEPS_DUO_LEN;
      const runIdx = Math.floor(rel / 2);
      const sub = rel % 2;
      const runNum = runIdx + 4;
      if (sub === 0) return { type:'burst', btn:`Run ${runNum} A+B  ▶`, sensor:'AB', clearResults:true };
      return { type:'capt', btn:'✓ Capturer A+B', sensor:'AB', both:true, runXBoth:{ num:runNum }, showResult:true };
    }
    if (step<STEPS_LEN) return STEPS[step];
    const rel=step-STEPS_LEN;
    const runIdx=Math.floor(rel/4);
    const sub=rel%4;
    const runNum=runIdx+4;
    const p1=(runIdx%2===0)?'B':'A';
    const p2=p1==='B'?'A':'B';
    switch(sub){
      case 0: return {type:'burst',btn:`Run ${runNum} ${p1}  ▶`,sensor:p1,clearResults:true};
      case 1: return {type:'capt', btn:'✓ Capturer',sensor:p1, runX:{num:runNum,plane:p1}};
      case 2: return {type:'burst',btn:`Run ${runNum} ${p2}  ▶`,sensor:p2};
      case 3: return {type:'capt', btn:'✓ Capturer',sensor:p2, runX:{num:runNum,plane:p2},showResult:true};
    }
  }

  // ════════════════════════════════════════════════════════════
  // BOUTON RUN
  // ════════════════════════════════════════════════════════════
  function _doRun() {
    if (_mode==='1P') { _doRun1P(); } else { _doRun2P(); }
  }

  // ── MODE 1P ─────────────────────────────────────────────────
  function _doRun1P() {
    if (state===S.R2_CONFIG) {
      const mass=parseFloat(inMass.value), ang=parseFloat(inAngle.value)||0;
      if (!mass||mass<=0){setStatus('Entrez une masse > 0','err');return;}
      _testMass1P=mass; _testAngle1P=ang;
      // Empêche spam / gel si l'opérateur reclique avant BAL_STATE=RUN2_READY
      if (btnRun) btnRun.disabled = true;
      _balSend('BAL_R2 MASS='+mass.toFixed(3)+' ANG='+ang.toFixed(3));
      log('→ Masse: '+mass.toFixed(1)+'g @ '+ang.toFixed(1)+'°');
      setStatus('Masse envoyée — attendre confirmation ESP…', 'wait');
      return;
    }
    if ([S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING].includes(state)){_accept1P();return;}
    if (state===S.CORRECTION){_resetAvg();_balSend('BAL_ACCEPT');return;}
    _suppressLiveTour = false;
    _resetAvg(); _balSend('BAL_RUN'); log('→ BAL_RUN');
  }

  function _accept1P() {
    const avg=_getLiveAvg();
    if (!avg||_tourCount<1){setStatus('Attendre au moins 1 tour','err');return;}
    if (state===S.RUN1_RUNNING) {
      _run1=avg; _pushPts(_runs1P,1,avg.amp,avg.phase,'#1a6fc4');
      log('✓ R1: '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°');
      _suppressLiveTour = true;
      _resetAvg(); _balSend('BAL_ACCEPT'); _showMassInput('Masse et angle essai');
      persistSession();
    } else if (state===S.RUN2_RUNNING) {
      _run2=avg; _pushPts(_runs1P,2,avg.amp,avg.phase,'#2a8a3e');
      log('✓ R2: '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°');
      const icm=_icm1P(_run1,_run2,_testMass1P,_testAngle1P);
      _influenceRatio=icm.ratio; _phaseShift=icm.pSh;
      log('✓ Correction: '+icm.corrMass.toFixed(1)+'g @ '+icm.corrAngle.toFixed(1)+'°');
      setStatus('Correction: '+icm.corrMass.toFixed(1)+'g @ '+icm.corrAngle.toFixed(1)+'°','ok');
      if (resultEl) resultEl.innerHTML=_html1PCorrResult('Correction 1 Plan',icm.corrMass,icm.corrAngle,
        'R1: '+_run1.amp.toFixed(3)+'g @'+_run1.phase.toFixed(1)+'°  |  R2: '+_run2.amp.toFixed(3)+'g @'+_run2.phase.toFixed(1)+'°');
      _drawPolar1P(); _hideMassInput(); _suppressLiveTour = true; _resetAvg(); _balSend('BAL_ACCEPT');
      persistSession();
      _maybeOfferSave();
    } else if (state===S.RUNX_RUNNING) {
      _runXcount++; _pushPts(_runs1P,_runXcount,avg.amp,avg.phase,'#c45a00');
      const corrMass=_influenceRatio>0?avg.amp/_influenceRatio:0;
      let corrAngle=avg.phase+180-_phaseShift; corrAngle=((corrAngle%360)+360)%360;
      const red=_run1?((_run1.amp-avg.amp)/_run1.amp*100):0;
      log('Run '+_runXcount+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  '+(red>=0?'▼':'▲')+Math.abs(red).toFixed(1)+'%');
      if (resultEl) resultEl.innerHTML=_html1PCorrResult('Run '+_runXcount+' — Correction',corrMass,corrAngle,
        'Amp: '+avg.amp.toFixed(3)+'g @'+avg.phase.toFixed(1)+'°  <span style="color:'+(red>=0?'#2a7a35':'#bb2200')+'">'+(red>=0?'▼':'▲')+Math.abs(red).toFixed(1)+'%</span>');
      _drawPolar1P(); _suppressLiveTour = true; _resetAvg(); _balSend('BAL_ACCEPT');
    }
    _updateUI();
    _updateCoeffButtons();
  }

  // ── MODE 2P ─────────────────────────────────────────────────
  function _doRun2P() {
    const def=_getStepDef(_2pStep);
    if (!def) return;

    // ── type mass : valider formulaire ────────────────────────
    if (def.type==='mass') {
      const mass=parseFloat(inMass.value), ang=parseFloat(inAngle.value)||0;
      if (!mass||mass<=0){setStatus('Entrez une masse > 0','err');return;}
      _trialMasses[def.massIdx]={mass,angle:ang};
      log('Masse Plan '+(def.massIdx===0?'A':'B')+': '+mass.toFixed(1)+'g @ '+ang.toFixed(1)+'°');
      _hideMassInput();
      if (def.sendR2) {
        // Duo après Run1 : BAL_R2 pour passer R2_CONFIG → RUN2_READY
        _balSend('BAL_R2 MASS=' + mass.toFixed(3) + ' ANG=' + ang.toFixed(3));
      } else if (def.needsAccept) {
        _balSend('BAL_ACCEPT');
      }
      _advanceStep();
      return;
    }

    // ── type burst : démarrer acquisition ─────────────────────
    if (def.type==='burst') {
      if (![S.IDLE,S.RUN1_READY,S.RUN2_READY,S.RUNX_READY].includes(state)) return;
      if (def.clearResults) _clearResult2P();
      _setSensor2P(def.sensor);
      _suppressLiveTour = false;
      _resetAvg();
      const nextDef = _getStepDef(_2pStep + 1);
      if (nextDef && nextDef.type === 'capt') {
        if (nextDef.both && nextDef.keys)
          _pending2pCapt = { kind: 'both', keys: nextDef.keys, computeICM: !!nextDef.computeICM };
        else if (nextDef.both && nextDef.runXBoth)
          _pending2pCapt = { kind: 'runxBoth', num: nextDef.runXBoth.num, showResult: !!nextDef.showResult };
        else if (nextDef.key)
          _pending2pCapt = { kind: 'key', key: [nextDef.key[0], nextDef.key[1]], computeICM: !!nextDef.computeICM };
        else if (nextDef.runX)
          _pending2pCapt = { kind: 'runx', runX: { num: nextDef.runX.num, plane: nextDef.runX.plane }, showResult: !!nextDef.showResult };
        else
          _pending2pCapt = null;
      } else {
        _pending2pCapt = null;
      }
      _balSend('BAL_RUN');
      log('→ '+def.btn.replace('  ▶',''));
      _advanceStep();
      return;
    }

    // ── type start : estimation RPM ───────────────────────────
    if (def.type==='start') {
      if (![S.IDLE,S.RUN1_READY].includes(state)) return;
      _suppressLiveTour = false;
      _balSend('BAL_RUN');
      log('→ Démarrer — estimation RPM' + (_isDuo2P() ? ' A+B' : ''));
      _advanceStep();
      return;
    }

    // ── type capt : capturer la mesure ────────────────────────
    if (def.type==='capt') {
      const running=[S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING];
      const runningOk = running.includes(state);
      const pend = _pending2pCapt;

      // Duo : un Capturer fige A et B
      if (_isDuo2P() && (def.both || (pend && (pend.kind === 'both' || pend.kind === 'runxBoth')))) {
        const avgA=_getLiveAvg(), avgB=_getLiveAvgB();
        if (!avgA||_tourCount<1||!avgB||_tourCountB<1) {
          setStatus('Attendre tours A et B (A='+_tourCount+' B='+_tourCountB+')','err');
          return;
        }
        if (!runningOk) { setStatus('Attendre acquisition (tours)...','wait'); return; }
        if (pend && pend.kind === 'both') {
          const condLabels=['C1','C2','C3'];
          const colors=['#1a6fc4','#2a8a3e','#c45a00'];
          pend.keys.forEach(function (kb) {
            const cond=kb[0], plane=kb[1];
            const avg = plane==='A' ? avgA : avgB;
            const n = plane==='A' ? _tourCount : _tourCountB;
            _meas[cond][plane]=avg;
            _pushPts(plane==='A'?_polarPtsA:_polarPtsB, condLabels[cond], avg.amp, avg.phase, colors[cond]);
            log('✓ Cond.'+(cond+1)+' Palier '+plane+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  ('+n+' tours)');
          });
          _drawAll2P();
          _suppressLiveTour = true;
          _balSend('BAL_ACCEPT');
          _resetAvg();
          if (pend.computeICM) _doComputeICM();
          _pending2pCapt = null;
          _advanceStep();
        } else if (pend && pend.kind === 'runxBoth') {
          const num=pend.num;
          if (!_runXData[num]) _runXData[num]={A:null,B:null};
          _runXData[num].A=avgA; _runXData[num].B=avgB;
          _pushPts(_polarPtsA,'V'+num, avgA.amp, avgA.phase, '#e07000');
          _pushPts(_polarPtsB,'V'+num, avgB.amp, avgB.phase, '#e07000');
          _drawAll2P();
          log('✓ Run '+num+' A: '+avgA.amp.toFixed(3)+'g @ '+avgA.phase.toFixed(1)+'°');
          log('✓ Run '+num+' B: '+avgB.amp.toFixed(3)+'g @ '+avgB.phase.toFixed(1)+'°');
          _suppressLiveTour = true;
          _balSend('BAL_ACCEPT');
          _resetAvg();
          if (pend.showResult) _doShowRunXResult(num);
          _pending2pCapt = null;
          _advanceStep();
        }
        return;
      }

      const avg=_getLiveAvg();
      if (!avg||_tourCount<1){setStatus('Attendre au moins 1 tour','err');return;}
      if (!runningOk && !(_mode==='2P' && _tourCount>=1)) {
        setStatus('Attendre acquisition (tours)...','wait');
        return;
      }
      if (pend && pend.kind === 'key') {
        const cond = pend.key[0], plane = pend.key[1];
        _meas[cond][plane]=avg;
        const condLabels=['C1','C2','C3'];
        const colors=['#1a6fc4','#2a8a3e','#c45a00'];
        _pushPts(plane==='A'?_polarPtsA:_polarPtsB, condLabels[cond], avg.amp, avg.phase, colors[cond]);
        if(plane==='A') _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);
        else            _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
        log('✓ Cond.'+(cond+1)+' Palier '+plane+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  ('+_tourCount+' tours)');
        _suppressLiveTour = true;
        _balSend('BAL_ACCEPT');
        _resetAvg();
        if (pend.computeICM) _doComputeICM();
        _pending2pCapt = null;
        _advanceStep();
      } else if (pend && pend.kind === 'runx') {
        const {num,plane}=pend.runX;
        if (!_runXData[num]) _runXData[num]={A:null,B:null};
        _runXData[num][plane]=avg;
        _pushPts(plane==='A'?_polarPtsA:_polarPtsB,'V'+num, avg.amp, avg.phase, '#e07000');
        if(plane==='A') _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);
        else            _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
        log('✓ Run '+num+' Palier '+plane+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  ('+_tourCount+' tours)');
        _suppressLiveTour = true;
        _balSend('BAL_ACCEPT');
        _resetAvg();
        if (pend.showResult) _doShowRunXResult(num);
        _pending2pCapt = null;
        _advanceStep();
      } else if (def.key) {
        const [cond,plane]=def.key;
        _meas[cond][plane]=avg;
        const condLabels=['C1','C2','C3'];
        const colors=['#1a6fc4','#2a8a3e','#c45a00'];
        _pushPts(plane==='A'?_polarPtsA:_polarPtsB, condLabels[cond], avg.amp, avg.phase, colors[cond]);
        if(plane==='A') _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);
        else            _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
        log('✓ Cond.'+(cond+1)+' Palier '+plane+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  ('+_tourCount+' tours)');
        _suppressLiveTour = true;
        _balSend('BAL_ACCEPT');
        _resetAvg();
        if (def.computeICM) _doComputeICM();
        _advanceStep();
      } else if (def.runX) {
        const {num,plane}=def.runX;
        if (!_runXData[num]) _runXData[num]={A:null,B:null};
        _runXData[num][plane]=avg;
        _pushPts(plane==='A'?_polarPtsA:_polarPtsB,'V'+num, avg.amp, avg.phase, '#e07000');
        if(plane==='A') _drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);
        else            _drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);
        log('✓ Run '+num+' Palier '+plane+': '+avg.amp.toFixed(3)+'g @ '+avg.phase.toFixed(1)+'°  ('+_tourCount+' tours)');
        _suppressLiveTour = true;
        _balSend('BAL_ACCEPT');
        _resetAvg();
        if (def.showResult) _doShowRunXResult(num);
        _advanceStep();
      }
    }
  }

  // ── Calculer et afficher ICM 2P ──────────────────────────────
  function _doComputeICM() {
    const v1a=_meas[0].A, v1b=_meas[0].B;
    const v2a=_meas[1].A, v2b=_meas[1].B;
    const v3a=_meas[2].A, v3b=_meas[2].B;
    if (!v1a||!v1b||!v2a||!v2b||!v3a||!v3b){setStatus('Données incomplètes','err');return;}
    const result=_icm2P(v1a,v1b,v2a,v2b,v3a,v3b,
                        _trialMasses[0].mass,_trialMasses[0].angle,
                        _trialMasses[1].mass,_trialMasses[1].angle);
    if (!result){setStatus('Erreur: matrice singulière','err');log('⚠ ICM singulière');return;}
    _influence2P=result.influence;
    log('✓ Plan A: '+result.planA.mass.toFixed(1)+'g @ '+result.planA.angle.toFixed(1)+'°');
    log('✓ Plan B: '+result.planB.mass.toFixed(1)+'g @ '+result.planB.angle.toFixed(1)+'°');
    setStatus('✓ Corrections calculées','ok');
    _showResult2P(result.planA, result.planB,
      'Essai A: '+_trialMasses[0].mass.toFixed(1)+'g @'+_trialMasses[0].angle.toFixed(1)+
      '°  |  Essai B: '+_trialMasses[1].mass.toFixed(1)+'g @'+_trialMasses[1].angle.toFixed(1)+'°', null, null);
    _updateCoeffButtons();
    _maybeOfferSave();
  }

  // ── Afficher correction résiduelle RunX ──────────────────────
  function _doShowRunXResult(runNum) {
    const d=_runXData[runNum];
    if (!d||!d.A||!d.B) return;
    const corr=_corrResiduelle(d.A, d.B);
    if (!corr){setStatus('Erreur calcul résiduel','err');return;}

    // Réduction vs baseline
    const v1a=_meas[0].A, v1b=_meas[0].B;
    const redA=v1a?(((v1a.amp-d.A.amp)/v1a.amp)*100):0;
    const redB=v1b?(((v1b.amp-d.B.amp)/v1b.amp)*100):0;

    log('Run '+runNum+' Plan A: '+corr.planA.mass.toFixed(1)+'g @ '+corr.planA.angle.toFixed(1)+'°  '+(redA>=0?'▼':'▲')+Math.abs(redA).toFixed(1)+'%');
    log('Run '+runNum+' Plan B: '+corr.planB.mass.toFixed(1)+'g @ '+corr.planB.angle.toFixed(1)+'°  '+(redB>=0?'▼':'▲')+Math.abs(redB).toFixed(1)+'%');
    setStatus('Run '+runNum+' — Corrections résiduelles','ok');
    _showResult2P(corr.planA, corr.planB, null, redA, redB);
    _updateCoeffButtons();
  }

  function _showResult2P(planA, planB, detail, redA, redB) {
    const rEl=document.getElementById('bal-result-2p');
    if (!rEl) return;
    const redHtml=(red,plane)=>red!==null?
      '<span style="color:'+(red>=0?'#2a7a35':'#bb2200')+'">'+(red>=0?'▼':'▲')+Math.abs(red).toFixed(1)+'%</span>':'';
    rEl.innerHTML=
      '<div class="bal-correction">'+
      '<div class="bal-corr-label">⚖ Corrections 2 Plans</div>'+
      '<div class="bal-corr-plan-lbl" style="color:#1a6fc4">Plan A</div>'+
      '<div class="bal-corr-mass">'+planA.mass.toFixed(1)+'<span class="bal-unit"> g</span></div>'+
      '<div class="bal-corr-ang">@ '+planA.angle.toFixed(1)+'°  '+redHtml(redA,'A')+'</div>'+
      '<div class="bal-corr-sep"></div>'+
      '<div class="bal-corr-plan-lbl" style="color:#2a8a3e">Plan B</div>'+
      '<div class="bal-corr-mass">'+planB.mass.toFixed(1)+'<span class="bal-unit"> g</span></div>'+
      '<div class="bal-corr-ang">@ '+planB.angle.toFixed(1)+'°  '+redHtml(redB,'B')+'</div>'+
      (detail?'<div class="bal-corr-sep"></div><div class="bal-corr-detail">'+detail+'</div>':'')+
      '</div>';
  }

  function _clearResult2P() {
    const rEl=document.getElementById('bal-result-2p');
    if (rEl) rEl.innerHTML='';
  }

  // ── Avancer à l'étape suivante ────────────────────────────────
  function _advanceStep() {
    _2pStep++;
    const def=_getStepDef(_2pStep);
    if (def && def.type==='mass') {
      _showMassInput(def.massIdx===0?'Masse essai Plan A':'Masse essai Plan B');
      const stopMsg=def.massIdx===0
        ?'⛔ Arrêter le rotor — Installer masse Plan A'
        :'⛔ Arrêter le rotor — Retirer masse A, installer masse Plan B';
      setStatus(stopMsg,'wait');
      log(stopMsg);
    } else {
      _update2PStatus();
    }
    _setSensor2P(def ? (def.sensor || null) : null);
    _updateUI();
    _updateCoeffButtons();
    _updateModeLock();
    persistSession();
  }

  // ── Afficher le bon encadrement polaire ───────────────────────
  function _setSensor2P(sensor) {
    const a=document.getElementById('bal-polar-a');
    const b=document.getElementById('bal-polar-b');
    if (!a||!b) return;
    if (sensor==='AB')      { a.classList.add('bal-polar-active'); b.classList.add('bal-polar-active'); }
    else if (sensor==='A')  { a.classList.add('bal-polar-active'); b.classList.remove('bal-polar-active'); }
    else if (sensor==='B')  { b.classList.add('bal-polar-active'); a.classList.remove('bal-polar-active'); }
    else                    { a.classList.remove('bal-polar-active'); b.classList.remove('bal-polar-active'); }
  }

  // ── Status 2P ────────────────────────────────────────────────
  function _update2PStatus() {
    if (_mode!=='2P') return;
    const def=_getStepDef(_2pStep);
    if (!def) return;
    if (def.type==='mass') return;
    if (_2pStep===0) {
      setStatus(_isDuo2P()
        ? 'Duo A+B — cliquer Démarrer (RPM)'
        : 'Prêt — cliquer Démarrer pour estimer le RPM','ok');
    } else if (def.type==='burst') {
      if (_isDuo2P()) {
        setStatus('Les 2 sondes actives — cliquer '+def.btn.trim(),'');
      } else {
        const condNames=['sans masse','avec masse Plan A','avec masse Plan B'];
        setStatus('Positionner sonde sur Palier '+def.sensor+' — cliquer '+def.btn.trim(),'');
      }
    } else if (def.type==='capt') {
      setStatus(_isDuo2P()
        ? 'Stable — Capturer fige A et B'
        : 'Machine stable — cliquer Capturer','wait');
    } else if (def.type==='start') {
      setStatus('Prêt — cliquer Démarrer','ok');
    }
  }

  // ════════════════════════════════════════════════════════════
  // RÉCEPTION TEXTE ESP
  // ════════════════════════════════════════════════════════════
  function _applyCoeffLoaded(line) {
    if (line.indexOf('mode=1P') >= 0 || line.indexOf('mode=1plan') >= 0) {
      _influenceRatio = _parseKeyFloat(line, 'h_amp=');
      _phaseShift = _parseKeyFloat(line, 'h_phase=');
      _coeffLoaded = true;
    } else if (line.indexOf('mode=2P') >= 0 || line.indexOf('mode=2plans') >= 0) {
      const inv = {
        aAA: _polarCx(_parseKeyFloat(line, 'h_aa_amp='), _parseKeyFloat(line, 'h_aa_phase=')),
        aAB: _polarCx(_parseKeyFloat(line, 'h_ab_amp='), _parseKeyFloat(line, 'h_ab_phase=')),
        aBA: _polarCx(_parseKeyFloat(line, 'h_ba_amp='), _parseKeyFloat(line, 'h_ba_phase=')),
        aBB: _polarCx(_parseKeyFloat(line, 'h_bb_amp='), _parseKeyFloat(line, 'h_bb_phase=')),
        D: _polarCx(1, 0)
      };
      inv.D = {
        r: inv.aAA.r * inv.aBB.r - inv.aAA.i * inv.aBB.i - (inv.aAB.r * inv.aBA.r - inv.aAB.i * inv.aBA.i),
        i: inv.aAA.r * inv.aBB.i + inv.aAA.i * inv.aBB.r - (inv.aAB.r * inv.aBA.i + inv.aAB.i * inv.aBA.r)
      };
      _influence2P = inv;
      _coeffLoaded = true;
    }
    _2pStep = _stepsLen();
    _runXData = {};
    _polarPtsA = [];
    _polarPtsB = [];
    _drawPolar1P();
    _drawAll2P();
    log('Coefficient chargé — prêt pour RunX');
    setStatus('Coefficient chargé — RunX prêt', 'ok');
    _updateCoeffButtons();
  }

  function onData(line) {
    const l = line.trim();
    if (!l) return;
    if (l.startsWith('BAL_COEFF_STATUS')) {
      _nvsCoeffValid = l.indexOf('valid=1') >= 0;
      const mi = l.indexOf('mode=');
      _nvsCoeffMode = mi >= 0 ? l.slice(mi + 5).trim().split(/\s/)[0] : null;
      if (_nvsCoeffMode === '1plan') _nvsCoeffMode = '1P';
      if (_nvsCoeffMode === '2plans') _nvsCoeffMode = '2P';
      _updateCoeffButtons();
      return;
    }
    if (l.startsWith('BAL_COEFF_LOADED')) {
      _applyCoeffLoaded(l);
      return;
    }
    if (l === 'BAL_COEFF_SAVED' || l.startsWith('Coefficient')) {
      log('Coefficient sauvegardé');
      return;
    }
    if (l.startsWith('BAL_RPM=')) { _updateRpm(parseFloat(l.slice(8)) || 0); return; }
    if (l.startsWith('BAL_STATE=')) { _applyState(l.slice(10)); return; }
    if (l.startsWith('BAL_ERR=')) {
      log('⚠ ' + l.slice(8));
      setStatus('Erreur: ' + l.slice(8), 'err');
      // Débloque « Valider masse » si R2 rejeté / timeout état
      if (btnRun) btnRun.disabled = false;
      _updateUI();
      return;
    }
  }

  function _applyState(name) {
    state=name;
    _espStateName = _normalizeEspStateName(name);
    if([S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING].includes(state)) {
      _suppressLiveTour = false;
      _resetAvg();
    }

    if (_mode==='1P') {
      const labels={
        [S.IDLE]:'Prêt — cliquer Démarrer pour estimer le RPM',
        [S.RPM_SCAN]:'Estimation RPM en cours — attendre le tach…',
        [S.RUN1_READY]:'Run 1 (sans masse) — cliquer Run 1 ▶',
        [S.RUN1_RUNNING]:'Run 1 — attendre stabilité puis Capturer',
        [S.R2_CONFIG]:'⛔ Arrêter le rotor — saisir masse et angle d\'essai',
        [S.RUN2_READY]:'Masse installée — cliquer Run 2 ▶',
        [S.RUN2_RUNNING]:'Run 2 — attendre stabilité puis Capturer',
        [S.CORRECTION]:'✓ Correction calculée — Continuer pour RunX',
        [S.RUNX_READY]:'Run vérif — cliquer Run vérif ▶',
        [S.RUNX_RUNNING]:'Run vérif — attendre stabilité puis Capturer'
      };
      const isWait=[S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING,S.RPM_SCAN,S.R2_CONFIG].includes(state);
      const isOk=[S.IDLE,S.RUN1_READY,S.RUN2_READY,S.RUNX_READY,S.CORRECTION].includes(state);
      setStatus(labels[state]||name,isWait?'wait':isOk?'ok':'');
      if (state === S.R2_CONFIG) _showMassInput('Masse et angle essai');
      else _hideMassInput();
    } else {
      // Mode 2P — transitions ESP
      // Mono déplacement : dummy R2 après 1ʳᵉ paire. Duo : masse A réelle (sendR2).
      if (!_isDuo2P() && state===S.R2_CONFIG && _2pStep<=4) {
        setTimeout(()=>_balSend('BAL_R2 MASS=1 ANG=0'), 200);
      }
      if (state===S.RUN1_READY && _2pStep===0) {
        _advanceStep();
        return;
      }
      const def=_getStepDef(_2pStep);
      if (def && def.type!=='mass') _update2PStatus();
    }
    log('ESP: '+name);
    _updateUI();
    _updateCoeffButtons();
    _updateModeLock();
    if (hasProgress()) persistSession();
  }

  // RPM
  let _lastRpm=0;
  function _updateRpm(rpm) {
    _lastRpm=rpm;
    if (rpm > 0) _lastTachMs = Date.now();
    const vid=_mode==='2P'?'bal-rpm-val-2p':'bal-rpm-val';
    const did=_mode==='2P'?'bal-rpm-dot-2p':'bal-rpm-dot';
    const v=document.getElementById(vid), d=document.getElementById(did);
    if(v) v.textContent=rpm>0?Math.round(rpm).toString():'0';
    if(d) d.className='bal-rpm-dot '+(rpm>0?'bal-rpm-dot--ok':'bal-rpm-dot--lost');
  }

  /** Remet les deux moniteurs RPM (1P / 2P) à 0 — ex. après reset complet. */
  function _zeroAllRpmDisplays() {
    _lastRpm = 0;
    [['bal-rpm-val', 'bal-rpm-dot'], ['bal-rpm-val-2p', 'bal-rpm-dot-2p']].forEach(([vid, did]) => {
      const v = document.getElementById(vid), d = document.getElementById(did);
      if (v) v.textContent = '0';
      if (d) d.className = 'bal-rpm-dot bal-rpm-dot--lost';
    });
  }

  function _resetStatusBars() {
    ['bal-status', 'bal-status-2p'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = 'Prêt'; el.className = 'bal-status'; }
    });
  }

  function _clearBalLogs() {
    if (logEl) logEl.textContent = '';
    const l2 = document.getElementById('bal-log-2p');
    if (l2) l2.textContent = '';
  }

  // ════════════════════════════════════════════════════════════
  // RESET
  // ════════════════════════════════════════════════════════════
  function _procedureResetLocal(keepCoeff) {
    state = S.IDLE;
    _run1 = null; _run2 = null; _runs1P = []; _runXcount = 2;
    _testMass1P = 0; _testAngle1P = 0;
    _saveOfferedThisProc = false;
    if (!keepCoeff) {
      _influenceRatio = 0; _phaseShift = 0; _influence2P = null;
      _coeffLoaded = false;
    }
    _meas = [{ A: null, B: null }, { A: null, B: null }, { A: null, B: null }];
    _trialMasses = [{ mass: 0, angle: 0 }, { mass: 0, angle: 0 }];
    _runXData = {};
    _2pStep = 0; _polarPtsA = []; _polarPtsB = [];
    _suppressLiveTour = false;
    _resetAvg();
    _zeroAllRpmDisplays();
    if (resultEl) resultEl.innerHTML = '';
    const r2p = document.getElementById('bal-result-2p');
    if (r2p) r2p.innerHTML = '';
    if (inMass) inMass.value = '100';
    if (inAngle) inAngle.value = '0';
    _hideMassInput();
    _drawPolar1P();
    _drawAll2P();
    _resetStatusBars();
    _setSensor2P(null);
    _pending2pCapt = null;
    if (_mode === '2P') _update2PStatus();
    _updateUI();
    _updateCoeffButtons();
    _updateModeLock();
  }

  function doReset() {
    _procedureResetLocal(_coeffLoaded);
    _sessionPaused = false;
    _clearStorage();
    _updatePauseBanner();
    log('─── RESET procédure ───');
    _balSendAllEsp('BAL_RESET');
  }

  function doSaveCoeff() {
    if (!_canSaveCoeff()) return;
    let cmd = 'BAL_SAVE_COEFF ';
    if (_mode === '1P') {
      cmd += 'mode=1P h_amp=' + _influenceRatio.toFixed(6) + ' h_phase=' + _phaseShift.toFixed(2);
    } else {
      const { aAA, aAB, aBA, aBB } = _influence2P;
      const pAA = _cxPolar(aAA), pAB = _cxPolar(aAB), pBA = _cxPolar(aBA), pBB = _cxPolar(aBB);
      cmd += 'mode=2P'
        + ' h_aa_amp=' + pAA.amp.toFixed(6) + ' h_aa_phase=' + pAA.phase.toFixed(2)
        + ' h_ab_amp=' + pAB.amp.toFixed(6) + ' h_ab_phase=' + pAB.phase.toFixed(2)
        + ' h_ba_amp=' + pBA.amp.toFixed(6) + ' h_ba_phase=' + pBA.phase.toFixed(2)
        + ' h_bb_amp=' + pBB.amp.toFixed(6) + ' h_bb_phase=' + pBB.phase.toFixed(2);
    }
    _balSend(cmd);
  }

  /** Après 2 runs (1P) ou 3 runs (2P) : proposer la sauvegarde NVS une fois. */
  function _maybeOfferSave() {
    if (!_canSaveCoeff() || _saveOfferedThisProc) return;
    _saveOfferedThisProc = true;
    _updateCoeffButtons();
    const msg = _mode === '1P'
      ? 'Coefficient calculé (2 runs).\nSauvegarder pour reprise plus tard ?'
      : 'Coefficient 2 plans calculé (3 runs).\nSauvegarder pour reprise plus tard ?';
    // setTimeout : laisse le rendu des corrections avant la boîte de dialogue
    setTimeout(function () {
      if (confirm(msg)) doSaveCoeff();
    }, 50);
  }

  function doLoadCoeff() {
    if (!_canLoadCoeff()) return;
    _balSend('BAL_LOAD_COEFF');
  }

  // ════════════════════════════════════════════════════════════
  // GRAPHIQUES
  // ════════════════════════════════════════════════════════════
  function _polarBase(c,cnv,pts) {
    if(!c||!cnv||cnv.width===0) return null;
    const W=cnv.width,H=cnv.height,cx=W/2,cy=H/2,R=Math.min(W,H)*0.38;
    c.clearRect(0,0,W,H); c.fillStyle='#ffffff'; c.fillRect(0,0,W,H);
    const maxAmp=pts.length>0?Math.max(...pts.map(p=>p.amp),0.001)*1.25:0.1;
    [0.25,0.5,0.75,1.0].forEach(f=>{
      c.strokeStyle=f===1.0?'#999':'#ddd'; c.setLineDash(f===1.0?[]:[3,4]); c.lineWidth=f===1.0?1.1:0.8;
      c.beginPath(); c.arc(cx,cy,R*f,0,2*Math.PI); c.stroke(); c.setLineDash([]);
      if(f<1.0){c.fillStyle='#bbb';c.font='7px "Courier New",monospace';c.textAlign='left';c.fillText((maxAmp*f).toFixed(3),cx+R*f+2,cy-2);}
    });
    c.strokeStyle='#ddd'; c.lineWidth=0.7;
    [[0,-1],[1,0],[0,1],[-1,0]].forEach(([dx,dy])=>{c.beginPath();c.moveTo(cx,cy);c.lineTo(cx+dx*R*1.05,cy+dy*R*1.05);c.stroke();});
    c.fillStyle='#888'; c.font='9px "Courier New",monospace';
    c.textAlign='center';c.fillText('0°',cx,cy-R-7);c.fillText('180°',cx,cy+R+11);
    c.textAlign='left';c.fillText('90°',cx+R+4,cy+4);c.textAlign='right';c.fillText('270°',cx-R-4,cy+4);
    c.beginPath();c.arc(cx,cy,3,0,2*Math.PI);c.fillStyle='#ccc';c.fill();
    return{cx,cy,R,maxAmp};
  }

  function _drawPoints(c,cx,cy,R,maxAmp,pts) {
    pts.forEach(p=>{
      const ratio=Math.min(p.amp/maxAmp,1.0),rr=ratio*R,angRad=(p.phase-90)*Math.PI/180;
      const px=cx+rr*Math.cos(angRad),py=cy+rr*Math.sin(angRad);
      c.strokeStyle=p.color+'55';c.lineWidth=1;c.beginPath();c.moveTo(cx,cy);c.lineTo(px,py);c.stroke();
      c.beginPath();c.arc(px,py,6,0,2*Math.PI);c.fillStyle=p.color;c.fill();
      c.beginPath();c.arc(px,py,10,0,2*Math.PI);c.strokeStyle=p.color+'44';c.lineWidth=1;c.stroke();
      c.fillStyle=p.color;c.font='bold 9px "Courier New",monospace';c.textAlign='left';c.fillText(p.label,px+9,py-2);
    });
  }

  function _drawPolarWithPts(c,cnv,pts) {
    const base=_polarBase(c,cnv,pts); if(!base) return;
    const{cx,cy,R,maxAmp}=base;
    if(pts.length===0){c.fillStyle='#bbb';c.font='11px "Courier New",monospace';c.textAlign='center';c.fillText('—',cx,cy+4);return;}
    _drawPoints(c,cx,cy,R,maxAmp,pts);
  }

  function _drawLivePolar(c,cnv,pts,avgAmp,avgPh,tourN) {
    const nTour = (tourN != null) ? tourN : _tourCount;
    const allAmps=[...pts.map(p=>p.amp),avgAmp];
    const maxAmp=Math.max(...allAmps,0.001)*1.25;
    const base=_polarBase(c,cnv,pts); if(!base) return;
    const{cx,cy,R}=base; _drawPoints(c,cx,cy,R,maxAmp,pts);
    const ratio=Math.min(avgAmp/maxAmp,1.0),rr=ratio*R,angRad=(avgPh-90)*Math.PI/180;
    const px=cx+rr*Math.cos(angRad),py=cy+rr*Math.sin(angRad);
    c.strokeStyle='#e07000aa';c.lineWidth=1;c.beginPath();c.moveTo(cx,cy);c.lineTo(px,py);c.stroke();
    const ringR=Math.max(4,Math.min(16,60/Math.max(nTour,1)));
    c.beginPath();c.arc(px,py,ringR,0,2*Math.PI);c.strokeStyle='#e0700055';c.lineWidth=1.5;c.stroke();
    c.beginPath();c.arc(px,py,6,0,2*Math.PI);c.fillStyle='#e07000';c.fill();
    c.strokeStyle='#fff';c.lineWidth=1.5;c.beginPath();c.moveTo(px-4,py);c.lineTo(px+4,py);c.moveTo(px,py-4);c.lineTo(px,py+4);c.stroke();
    c.fillStyle='#c05000';c.font='8px "Courier New",monospace';c.textAlign='left';
    c.fillText(avgAmp.toFixed(3)+'g @'+Math.round(avgPh)+'°',px+8,py-3);
    c.fillStyle='#c0500099';c.fillText('n='+nTour,px+8,py+8);
  }

  function _drawPolar1P(){_drawPolarWithPts(_ctx1P,_canvas1P,_runs1P);}
  function _drawAll2P(){_drawPolarWithPts(_ctxA,_canvasA,_polarPtsA);_drawPolarWithPts(_ctxB,_canvasB,_polarPtsB);}

  // ════════════════════════════════════════════════════════════
  // UI HELPERS
  // ════════════════════════════════════════════════════════════
  function _bindTrialInputs() {
    const massId = _mode === '2P' ? 'bal-trial-mass-2p' : 'bal-trial-mass-1p';
    const angId  = _mode === '2P' ? 'bal-trial-angle-2p' : 'bal-trial-angle-1p';
    inMass  = document.getElementById(massId);
    inAngle = document.getElementById(angId);
  }
  function _showMassInput(label) {
    _bindTrialInputs();
    const pid = _mode === '2P' ? 'bal-params-2p' : 'bal-params';
    const tid = _mode === '2P' ? 'bal-params-title-2p' : 'bal-params-title';
    const el = document.getElementById(pid);
    const lbl = document.getElementById(tid);
    if (el) el.style.display = 'block';
    if (lbl) lbl.textContent = label || 'Masse essai';
  }
  function _hideMassInput() {
    ['bal-params', 'bal-params-2p'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  function _pushPts(arr,label,amp,phase,color) {
    const idx=arr.findIndex(p=>p.label===label);
    if(idx>=0) arr[idx]={label,amp,phase,color}; else arr.push({label,amp,phase,color});
  }
  function _html1PCorrResult(title,mass,angle,detail) {
    return '<div class="bal-correction"><div class="bal-corr-label">⚖ '+title+'</div>'+
      '<div class="bal-corr-mass">'+mass.toFixed(1)+'<span class="bal-unit"> g</span></div>'+
      '<div class="bal-corr-ang">@ '+angle.toFixed(1)+'°</div>'+
      '<div class="bal-corr-sep"></div><div class="bal-corr-detail">'+detail+'</div></div>';
  }

  // ════════════════════════════════════════════════════════════
  // UPDATE UI — label du bouton selon étape courante
  // ════════════════════════════════════════════════════════════
  function _updateUI() {
    if (!btnRun) return;
    if (!_mode){btnRun.disabled=true;return;}

    if (_mode==='1P') {
      const running=[S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING];
      const ready=[S.IDLE,S.RUN1_READY,S.RUN2_READY,S.RUNX_READY];
      btnRun.disabled=![...running,...ready,S.R2_CONFIG,S.CORRECTION].includes(state);
      const lbl={[S.IDLE]:'Démarrer',[S.RUN1_READY]:'Run 1  ▶',[S.RUN1_RUNNING]:'✓ Capturer',
        [S.R2_CONFIG]:'📦 Valider masse essai',[S.RUN2_READY]:'Run 2  ▶',[S.RUN2_RUNNING]:'✓ Capturer',
        [S.CORRECTION]:'▶ Continuer',[S.RUNX_READY]:'Run vérif  ▶',[S.RUNX_RUNNING]:'✓ Capturer',[S.RPM_SCAN]:'Scan RPM…'};
      btnRun.textContent=lbl[state]||'Run ▶';
    } else {
      const def=_getStepDef(_2pStep);
      if (!def){btnRun.disabled=true;btnRun.textContent='Terminé ✓';return;}

      const running=[S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING];
      const ready=[S.IDLE,S.RUN1_READY,S.RUN2_READY,S.RUNX_READY];

      if (def.type==='mass') {
        btnRun.disabled=false; btnRun.textContent=def.btn;
      } else if (def.type==='burst' || def.type==='start') {
        btnRun.disabled=!ready.includes(state); btnRun.textContent=def.btn;
      } else if (def.type==='capt') {
        const running=[S.RUN1_RUNNING,S.RUN2_RUNNING,S.RUNX_RUNNING];
        if (_isDuo2P() && def.both) {
          btnRun.disabled = !running.includes(state) || _tourCount < 1 || _tourCountB < 1;
        } else {
          btnRun.disabled=!running.includes(state) && !(_mode==='2P' && _tourCount>=1);
        }
        btnRun.textContent=def.btn;
      }
    }
    btnRun.classList.toggle('btn-waiting',state===S.RPM_SCAN);
  }

  function setStatus(msg,type) {
    const el=_mode==='2P'?document.getElementById('bal-status-2p'):document.getElementById('bal-status');
    if(!el) return; el.textContent=msg; el.className='bal-status'+(type?' bal-st-'+type:'');
  }
  function log(msg) {
    const el=_mode==='2P'?document.getElementById('bal-log-2p'):document.getElementById('bal-log');
    if(!el) return;
    const t=new Date().toTimeString().slice(0,8),d=document.createElement('div');
    d.textContent='['+t+'] '+msg; el.appendChild(d); el.scrollTop=el.scrollHeight;
  }
  function resize(){
    _resizeCnv('bal-canvas-wrap',_canvas1P);
    _resizeCnv('bal-polar-a',_canvasA);
    _resizeCnv('bal-polar-b',_canvasB);
    if(_mode==='2P') _drawAll2P(); else _drawPolar1P();
  }

  // ════════════════════════════════════════════════════════════
  // PAUSE / REPRISE — mémoire JS (localStorage), pas NVS mid-run
  // ════════════════════════════════════════════════════════════
  function _normalizeEspStateName(name) {
    if (name === 'RUN1_RUNNING') return 'RUN1_READY';
    if (name === 'RUN2_RUNNING') return 'RUN2_READY';
    if (name === 'RUNX_RUNNING') return 'RUNX_READY';
    if (name === 'RPM_SCAN') return 'IDLE';
    return name || 'IDLE';
  }

  function _balSendAllEsp(cmd) {
    const clean = (cmd || '').replace(/\n+$/, '');
    const dual = (typeof ProbeMode !== 'undefined' && ProbeMode.isDual()) ||
      (typeof DualSession !== 'undefined' && DualSession.available());
    if (dual) {
      if (typeof DualSession !== 'undefined') DualSession.begin();
      if (typeof DualSession !== 'undefined' && DualSession.sendBoth) {
        DualSession.sendBoth(clean);
      } else {
        if (typeof wsSend === 'function') wsSend(clean);
        if (typeof wsSendB === 'function') wsSendB(clean);
      }
    } else {
      _balSend(clean);
    }
  }

  function hasProgress() {
    if (_mode === '1P') {
      return !!_run1 || !!_run2 || _influenceRatio > 0 ||
        [S.RUN1_READY, S.RUN1_RUNNING, S.R2_CONFIG, S.RUN2_READY, S.RUN2_RUNNING,
         S.CORRECTION, S.RUNX_READY, S.RUNX_RUNNING, S.RPM_SCAN].includes(state);
    }
    if (_mode === '2P') {
      if (_2pStep > 0) return true;
      if (_influence2PComplete(_influence2P)) return true;
      for (let i = 0; i < 3; i++) {
        if (_meas[i].A || _meas[i].B) return true;
      }
    }
    return _sessionPaused;
  }

  function _snapshot() {
    return {
      v: 1,
      paused: _sessionPaused,
      mode: _mode,
      duo: !!_duo2P,
      probe: (typeof ProbeMode !== 'undefined') ? ProbeMode.get() : null,
      espState: _normalizeEspStateName(_espStateName || state),
      state: state,
      step2p: _2pStep,
      run1: _run1,
      run2: _run2,
      runs1P: _runs1P,
      testMass1P: _testMass1P,
      testAngle1P: _testAngle1P,
      influenceRatio: _influenceRatio,
      phaseShift: _phaseShift,
      runXcount: _runXcount,
      meas: _meas,
      trialMasses: _trialMasses,
      influence2P: _influence2P,
      polarPtsA: _polarPtsA,
      polarPtsB: _polarPtsB,
      runXData: _runXData,
      coeffLoaded: _coeffLoaded,
      saveOffered: _saveOfferedThisProc,
      resultHtml: resultEl ? resultEl.innerHTML : '',
      result2pHtml: _result2pHtml(),
      ts: Date.now(),
    };
  }

  function persistSession() {
    if (!hasProgress() && !_sessionPaused) return;
    try {
      localStorage.setItem(BAL_LS_KEY, JSON.stringify(_snapshot()));
    } catch (e) {}
  }

  function _clearStorage() {
    try { localStorage.removeItem(BAL_LS_KEY); } catch (e) {}
  }

  function _readStorage() {
    try {
      const raw = localStorage.getItem(BAL_LS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.v !== 1) return null;
      return o;
    } catch (e) { return null; }
  }

  function _applySnapshot(o) {
    if (!o) return;
    _mode = o.mode === '2P' ? '2P' : '1P';
    _duo2P = !!o.duo;
    _sessionPaused = !!o.paused;
    _espStateName = o.espState || 'IDLE';
    state = o.state || S.IDLE;
    _2pStep = o.step2p || 0;
    _run1 = o.run1 || null;
    _run2 = o.run2 || null;
    _runs1P = Array.isArray(o.runs1P) ? o.runs1P : [];
    _testMass1P = o.testMass1P || 0;
    _testAngle1P = o.testAngle1P || 0;
    _influenceRatio = o.influenceRatio || 0;
    _phaseShift = o.phaseShift || 0;
    _runXcount = o.runXcount || 2;
    _meas = o.meas || [{ A: null, B: null }, { A: null, B: null }, { A: null, B: null }];
    _trialMasses = o.trialMasses || [{ mass: 0, angle: 0 }, { mass: 0, angle: 0 }];
    _influence2P = o.influence2P || null;
    _polarPtsA = Array.isArray(o.polarPtsA) ? o.polarPtsA : [];
    _polarPtsB = Array.isArray(o.polarPtsB) ? o.polarPtsB : [];
    _runXData = o.runXData || {};
    _coeffLoaded = !!o.coeffLoaded;
    _saveOfferedThisProc = !!o.saveOffered;
    if (resultEl) resultEl.innerHTML = o.resultHtml || '';
    const r2p = document.getElementById('bal-result-2p');
    if (r2p) r2p.innerHTML = o.result2pHtml || '';
    setMode(_mode);
    _drawPolar1P();
    _drawAll2P();
    _updateUI();
    _updateCoeffButtons();
    _updatePauseBanner();
  }

  function _restoreFromStorageIfAny() {
    const o = _readStorage();
    if (!o) return;
    _applySnapshot(o);
    if (o.paused) log('Session en pause restaurée (refresh)');
    else if (hasProgress()) log('Session équilibrage restaurée');
  }

  function _updatePauseBanner() {
    const el = document.getElementById('bal-pause-banner');
    const txt = document.getElementById('bal-pause-banner-txt');
    if (!el) return;
    const show = !!_sessionPaused && hasProgress();
    el.style.display = show ? 'flex' : 'none';
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (txt && show) {
      const label = _mode === '2P'
        ? (_duo2P ? '2P duo' : '2P')
        : '1P';
      txt.textContent = 'Équilibrage ' + label + ' en pause — Reprendre pour continuer';
    }
  }

  /** Appelé par BalanceSession.pause() avant autre module. */
  function pauseForLeave() {
    if (!hasProgress()) return false;
    _sessionPaused = true;
    _espStateName = _normalizeEspStateName(_espStateName || state);
    persistSession();
    _balSendAllEsp('BAL_PAUSE');
    _stopTachWatch();
    _updatePauseBanner();
    log('⏸ Pause équilibrage (autre module)');
    if (typeof termAddLine === 'function') {
      termAddLine('[BAL] pause — session gardée', 'sys');
    }
    if (typeof BalanceSession !== 'undefined' && BalanceSession.markPaused) {
      BalanceSession.markPaused();
    }
    return true;
  }

  function discardSession() {
    _sessionPaused = false;
    _procedureResetLocal(false);
    _clearStorage();
    _balSendAllEsp('BAL_RESET');
    _updatePauseBanner();
    log('Session équilibrage abandonnée');
    if (typeof BalanceSession !== 'undefined' && BalanceSession.markIdle) {
      BalanceSession.markIdle();
    }
  }

  /** Nouveau depuis menu : confirme si progression, puis flush. */
  function prepareNewFromMenu() {
    if (hasProgress() || _sessionPaused || _readStorage()) {
      if (!confirm('Nouvelle procédure d\'équilibrage ?\nLa session en cours / en pause sera perdue.')) {
        return false;
      }
      discardSession();
    }
    return true;
  }

  /**
   * Reprise session — opts.onLive(dual) / opts.onFail() pour BalanceSession.
   * @param {{ onLive?: function, onFail?: function }} [opts]
   */
  function resumeSession(opts) {
    opts = opts || {};
    const snap = _readStorage();
    if (snap) _applySnapshot(snap);
    if (!hasProgress()) {
      setStatus('Aucune session à reprendre', 'err');
      if (opts.onFail) opts.onFail();
      return;
    }
    _sessionPaused = false;
    persistSession();
    _updatePauseBanner();

    const espState = _normalizeEspStateName(_espStateName || state || 'IDLE');
    const onReady = function (dual) {
      // Une seule restauration d'état (EQ_RESUME côté ESP = stop modules + ACK)
      _balSendAllEsp('BAL_RESUME STATE=' + espState);
      _startTachWatch();
      setStatus('Session reprise', 'ok');
      log('▶ Reprise équilibrage → ' + espState);
      _updateUI();
      setTimeout(resize, 80);
      if (opts.onLive) opts.onLive(!!dual);
      else if (typeof BalanceSession !== 'undefined' && BalanceSession.markLive) {
        BalanceSession.markLive(!!dual);
      }
    };
    const onFail = function () {
      setStatus('Reprise échouée (NAV)', 'err');
      _sessionPaused = true;
      persistSession();
      _updatePauseBanner();
      if (opts.onFail) opts.onFail();
      else if (typeof BalanceSession !== 'undefined' && BalanceSession.markPaused) {
        BalanceSession.markPaused();
      }
    };

    if (typeof DualSession !== 'undefined' && DualSession.available()) {
      DualSession.startModule('balance', 'WS_GOTO=EQ_RESUME', {
        label: 'Équilibrage (reprise)',
        onReady: onReady,
        onFail: onFail,
      });
    } else if (typeof window.wsGoto === 'function') {
      window.wsGoto('balance', 'WS_GOTO=EQ_RESUME', {
        onAck: function () { onReady(false); },
        onTimeout: onFail,
      });
    } else {
      _balSendAllEsp('WS_GOTO=EQ_RESUME');
      setTimeout(function () { onReady(false); }, 300);
      if (typeof showTab === 'function') showTab('balance');
    }
  }

  function selectMode(m) { setMode(m); }

  return {
    init, enterBalance, onData, onTourBinary, onTourBinaryB, onRpmB,
    setMode, selectMode, resize, clearSession, selectSensor,
    hasProgress, persistSession, pauseForLeave, resumeSession,
    discardSession, prepareNewFromMenu, setWinMax, copyLog,
    isPaused: function () { return !!_sessionPaused; },
  };
})();
