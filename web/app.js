/* ============================================================================
 * SignalFlow – frontend dashboard (vanilla JS, no dependencies)
 * ----------------------------------------------------------------------------
 * Talks to the SignalFlow backend (same origin, relative paths):
 *   GET  /api/health   GET /api/config
 *   POST /api/simulate POST /api/agent POST /api/explain   POST /api/tts
 *
 * The UI is fully self-contained and degrades gracefully:
 *   - If the backend is unreachable (e.g. page opened via file://) the dashboard
 *     switches to a small built-in "offline demo" generator so every chart,
 *     canvas and panel still renders. No external CDNs, works offline.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ===========================================================================
   * 1) CONSTANTS
   * ======================================================================== */

  // approach-turn movement keys, e.g. "N-T"
  const APPROACHES = ['N', 'E', 'S', 'W'];
  const TURNS = ['L', 'T', 'R'];
  const MOVE_KEYS = [];
  for (const a of APPROACHES) for (const t of TURNS) MOVE_KEYS.push(a + '-' + t);

  // phase -> movements that get green
  const PHASE_MOVES = {
    NS_THRU: ['N-T', 'N-R', 'S-T', 'S-R'],
    NS_LEFT: ['N-L', 'S-L'],
    EW_THRU: ['E-T', 'E-R', 'W-T', 'W-R'],
    EW_LEFT: ['E-L', 'W-L'],
  };
  const PHASE_ORDER = ['NS_THRU', 'NS_LEFT', 'EW_THRU', 'EW_LEFT'];
  // respect the user's motion preference: skip the moving-vehicle animation
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // phase -> which approach letter(s) belong to it (used for yellow display)
  const PHASE_APPROACHES = {
    NS_THRU: ['N', 'S'], NS_LEFT: ['N', 'S'],
    EW_THRU: ['E', 'W'], EW_LEFT: ['E', 'W'],
    NS: ['N', 'S'], EW: ['E', 'W'],
    EW_THRU_T3: ['E', 'W'], N_MINOR: ['N'], W_LEFT: ['W'],
  };
  const PHASE_LABEL = {
    NS_THRU: 'N–S · Geradeaus', NS_LEFT: 'N–S · Links',
    EW_THRU: 'O–W · Geradeaus', EW_LEFT: 'O–W · Links',
    NS: 'N–S (permissiv)', EW: 'O–W (permissiv)',
    N_MINOR: 'N · Nebenrichtung', W_LEFT: 'O · Links',
    roundabout: 'Kreisverkehr (yield)',
    none: 'durchlaufend',
  };

  // fallback defaults (identical schema to POST /api/simulate body)
  const DEFAULT_CONFIG = {
    duration_min: 30, seed: 42, dt: 1,
    demand_multiplier: 1.0, demand_profile: 'peak',
    demand: {
      N: { T: 720, L: 140, R: 120 }, E: { T: 600, L: 100, R: 90 },
      S: { T: 760, L: 150, R: 130 }, W: { T: 560, L: 90, R: 80 },
    },
    lanes: { T: 2, L: 1, R: 1 },
    fixed_greens: [36, 10, 32, 8],
    min_green: 24, max_green: 50, switch_hysteresis: 3.0,
  };

  // KPI definitions: mapping to summary fields, direction & formatting
  const KPI_META = [
    { key: 'delay', title: 'Ø Verzögerung', unit: 's', dir: 'down', dec: 1, get: (s) => s.avg_delay_s,
      info: 'Mittlere Verzögerung je Fahrzeug (Sekunden) — Wartezeit vor Rot plus Anfahrverluste. Weniger ist besser.' },
    { key: 'throughput', title: 'Durchsatz', unit: 'veh/h', dir: 'up', dec: 0, get: (s) => s.throughput_vph,
      info: 'Fahrzeuge pro Stunde, die den Knoten passieren. Mehr ist besser.' },
    { key: 'maxq', title: 'max. Warteschlange', unit: '', dir: 'down', dec: 1, get: (s) => s.max_queue,
      info: 'Längste Fahrzeugschlange einer Zufahrt während des Laufs (Fahrzeuge). Weniger ist besser.' },
    { key: 'co2', title: 'CO₂-Proxy', unit: 'g', dir: 'down', dec: 0, get: (s) => s.co2_g,
      info: 'Geschätzter CO₂-Ausstoß aus Stand- und Verzögerungszeiten (Gramm) — aus Leerlauf-Zeiten hochgerechnet, keine Messung. Weniger ist besser.' },
    { key: 'wasted', title: 'Leerlauf-Grün', unit: 's', dir: 'down', dec: 0, get: (s) => s.wasted_green_s,
      info: 'Grünzeit in Sekunden, in der keine Fahrzeuge mehr warten — reine Verschwendung. Weniger ist besser.' },
  ];

  const COL = {
    green: '#22c55e', yellow: '#f59e0b', red: '#ef4444',
    adaptive: '#2dd4bf', fixed: '#64748b',
    L: '#f59e0b', T: '#38bdf8', R: '#2dd4bf',
    grid: '#1e2a37', axis: '#4a5563', txt: '#8b98a7',
  };

  /* ===========================================================================
   * 2) STATE
   * ======================================================================== */
  const state = {
    baseConfig: clone(DEFAULT_CONFIG),
    result: null,
    summaryFixed: null,
    summaryAdaptive: null,
    fixedFrames: [],
    adaptiveFrames: [],
    decisions: [],
    frameDt: 4,
    duration: 1800,       // seconds
    metaGenerated: '',
    // playback
    mode: 'adaptive',     // 'fixed' | 'adaptive' | 'both'
    playing: false,
    speed: 1,
    baseSpeed: 1,
    crossing: [],          // vehicles currently driving through the junction
    crossSpawn: {},        // last sim-time a crossing vehicle was spawned per movement
    autoSpeak: false,
    t: 0,
    // panels
    selectedDecision: 0,
    answer: '',
    online: { api: false, featherless: false, elevenlabs: false },
    busy: false,
  };

  /* ===========================================================================
   * 3) TINY UTILITIES
   * ======================================================================== */
  // hoisted helpers (function declarations) so they are safe to use during
  // module evaluation (e.g. the `state` initializer below).
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmt(v, dec) {
    if (v === null || v === undefined || Number.isNaN(v)) return '–';
    return Number(v).toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function timeStr(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  // PNG export via Blob/object-URL — data:-URLs break past ~2 MB (dual view, retina)
  function exportCanvas(id, filename) {
    const cv = document.getElementById(id);
    if (!cv) return;
    cv.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  /* ===========================================================================
   * 4) DATA LAYER
   * ======================================================================== */
  async function fetchJSON(url, opts) {
    const res = await apiFetch(url, opts);
    if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
    return res.json();
  }

  // The real local backend. If the page is opened from the app preview (a
  // different origin that cannot proxy our POST API and answers 415/405), we
  // transparently fall back to the backend directly (it sets CORS *).
  const BACKEND = 'http://127.0.0.1:8000';
  function apiUrl(url) {
    if (typeof url !== 'string' || /^https?:\/\//i.test(url)) return url;
    return url.charAt(0) === '/' ? url : '/' + url;
  }
  async function apiFetch(url, opts) {
    const u = apiUrl(url);
    const isApi = u.indexOf('/api/') === 0;
    try {
      const r = await fetch(url, opts);
      if (!r.ok && isApi && location.origin !== BACKEND) {
        return await fetch(BACKEND + u, opts);
      }
      return r;
    } catch (e) {
      if (isApi && location.origin !== BACKEND) return await fetch(BACKEND + u, opts);
      throw e;
    }
  }

  // ---- health -------------------------------------------------------------
  async function loadHealth() {
    try {
      const h = await fetchJSON('/api/health', { cache: 'no-store' });
      state.online.api = !!h.ok;
      state.online.featherless = !!h.featherless;
      state.online.elevenlabs = !!h.elevenlabs;
    } catch (e) {
      state.online.api = false;
    }
    renderBadges();
  }

  // ---- config (seed the base config from the server if possible) -----------
  async function loadConfig() {
    try {
      const cfg = await fetchJSON('/api/config', { cache: 'no-store' });
      if (cfg && typeof cfg === 'object') state.baseConfig = Object.assign(clone(DEFAULT_CONFIG), cfg);
    } catch (e) { /* keep local defaults */ }
  }

  // ---- build the POST body from base config + UI controls ------------------
  function buildConfig() {
    const cfg = clone(state.baseConfig);
    cfg.duration_min = +$('ctl-duration').value;
    cfg.demand_multiplier = +$('ctl-load').value;
    const prof = $('ctl-profile');
    if (prof) cfg.demand_profile = prof.value;   // legacy; the scenario sets the shape
    cfg.seed = +$('ctl-seed').value;
    const jt = document.getElementById('ctl-junction');
    if (jt) cfg.junction_type = jt.value;
    const src = document.getElementById('ctl-source');
    if (src) cfg.arrival_source = src.value;
    const scen = document.getElementById('ctl-scenario');
    if (scen) cfg.demand_scenario = scen.value;
    const mix = document.getElementById('ctl-mix');
    if (mix) {
      cfg.vehicle_mix = {
        car: { car: 1.0 },
        city: { car: 0.80, van: 0.08, truck: 0.08, bus: 0.04 },
        truck: { car: 0.64, van: 0.06, truck: 0.24, bus: 0.06 },
      }[mix.value] || { car: 1.0 };
    }
    const tsp = document.getElementById('ctl-tsp');
    if (tsp) cfg.transit_priority = tsp.value === 'on';
    cfg.dt = 1;
    return cfg;
  }

  // ---- run a simulation (network first, offline demo as fallback) ----------
  async function runSimulation() {
    setBusy(true);
    hide($('sim-error'));
    const cfg = buildConfig();
    let payload = null, usedDemo = false;
    try {
      payload = await fetchJSON('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      state.online.api = true;
      hide($('offline-notice'));
    } catch (e) {
      usedDemo = true;
      state.online.api = false;
      show($('offline-notice'));
      payload = runDemo(cfg);            // built-in fallback
    }

    if (!payload || !payload.summary || !payload.summary.fixed) {
      show($('sim-error'), 'Ungültige Serverantwort – konnte nicht gerendert werden.');
      setBusy(false);
      return;
    }

    applyPayload(payload, usedDemo);
    setBusy(false);
    renderBadges();
  }

  function applyPayload(res, usedDemo) {
    state.result = res;
    state.summaryFixed = res.summary.fixed;
    state.summaryAdaptive = res.summary.adaptive;
    state.fixedFrames = (res.fixed && res.fixed.frames) || [];
    state.adaptiveFrames = (res.adaptive && res.adaptive.frames) || [];
    state.decisions = (res.adaptive && res.adaptive.decisions) || [];
    state.frameDt = (res.meta && res.meta.frame_dt) || state.frameDt || 4;
    state.duration = (res.meta && res.meta.steps) ||
      (res.config ? res.config.duration_min * 60 : 1800);
    state.junction = res.junction || null;
    state.metaGenerated = (res.meta && res.meta.generated) || (usedDemo ? 'offline demo' : '');
    state.selectedDecision = Math.max(0, state.decisions.length - 1);

    // reset playhead, start animating. Default = watchable 10x (one signal cycle
    // ~10 s), so queues are visibly draining. The 0.5/1/2/4 buttons multiply this.
    state.t = 0;
    state.baseSpeed = 10;
    state.speed = state.baseSpeed;
    state.crossing = [];
    state.crossSpawn = {};
    setPlaying(true);
    updateSpeedReadout();

    renderKPIs();
    buildKpiCards();
    buildKpiTable();
    renderKPIs();
    renderCharts();
    renderDecisions();
    renderMeta(usedDemo);
    if (state.autoSpeak && window.SFAsk) SFAsk.speakResult();
    // auto-ask? no. keep user driven.
  }

  /* ===========================================================================
   * 5) BADGES / BUSY / META
   * ======================================================================== */
  function renderBadges() {
    setBadge('badge-featherless', state.online.featherless, 'verbunden', 'Offline-Fallback');
    setBadge('badge-elevenlabs', state.online.elevenlabs, 'verbunden', 'Offline');
  }
  function setBadge(id, ok, okText, offText) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('ok', 'off', 'err');
    if (!state.online.api && !ok) { el.classList.add('err'); }
    else el.classList.add(ok ? 'ok' : 'off');
    el.querySelector('.badge-state').textContent = ok ? okText : offText;
  }

  function setBusy(b) {
    state.busy = b;
    const btn = $('btn-simulate');
    btn.disabled = b;
    btn.classList.toggle('busy', b);
    const bar = $('loading-bar');
    if (b) { bar.classList.remove('hidden', 'done'); bar.classList.add('running'); }
    else {
      bar.classList.add('done');
      setTimeout(() => { bar.classList.add('hidden'); bar.classList.remove('done', 'running'); }, 450);
    }
  }

  function renderMeta(usedDemo) {
    if (!state.result) return;
    const s = state.summaryAdaptive || {};
    $('meta-info').textContent =
      `${state.metaGenerated || 'SignalFlow'} · ${state.duration}s · adaptive Ø-Delay ${fmt(s.avg_delay_s, 1)}s` +
      (usedDemo ? ' · OFFLINE-DEMO' : '');
  }

  /* ===========================================================================
   * 6) KPI CARDS
   * ======================================================================== */
  function buildKpiCards() {
    const grid = $('kpi-grid');
    grid.innerHTML = '';
    const jl = state.junction || {};
    const refL = jl.reference_label || 'Fixed';
    const altL = jl.alternative_label || 'Adaptive';
    for (const m of KPI_META) {
      const card = document.createElement('article');
      card.className = 'kpi';
      card.innerHTML = `
        <header><h3 title="${m.info}">${m.title}</h3><span class="unit">${m.unit}</span></header>
        <div class="kpi-rows">
          <div class="row fixed"><span class="tag" title="${POLICY_INFO.fixed}">${refL}</span><i class="dlt"></i><b data-kpi="${m.key}-fixed">–</b></div>
          <div class="row adaptive"><span class="tag" title="${POLICY_INFO.adaptive}">${altL}</span><i class="dlt" data-kpi="${m.key}-delta" title="Δ gegenüber Fixed-Time — positiv = besser">–</i><b data-kpi="${m.key}-adaptive">–</b></div>
        </div>`;
      grid.appendChild(card);
    }
  }

  // Compact matrix alternative to the cards: policies as rows, metrics as
  // columns, traffic-light deltas (green/orange/red) under the adaptive
  // values. Both views share the data-kpi hooks, so renderKPIs updates
  // whichever is visible.
  const POLICY_INFO = {
    fixed: 'Fester Signalplan mit vordefinierten Grünzeiten — reagiert nicht auf den live Verkehr (Baseline)',
    adaptive: 'SignalFlow: Phasenlängen reagieren live auf den Warteschlangen-Druck jeder Richtung (Max-Pressure)',
  };
  function buildKpiTable() {
    const wrap = $('kpi-table-wrap');
    if (!wrap) return;
    const jl = state.junction || {};
    const refL = jl.reference_label || 'Fixed';
    const altL = jl.alternative_label || 'Adaptive';
    const head = KPI_META.map((m) =>
      `<th colspan="2" title="${m.info}">${m.title}${m.unit ? ' <span class="unit">' + m.unit + '</span>' : ''}</th>`).join('');
    const subHeads = KPI_META.map(() => '<th class="sub">Wert</th><th class="sub">Δ</th>').join('');
    const fixedCells = KPI_META.map((m) =>
      `<td class="v" data-kpi="${m.key}-fixed">–</td><td class="dltc">–</td>`).join('');
    const adaptiveCells = KPI_META.map((m) =>
      `<td class="v adaptive-v" data-kpi="${m.key}-adaptive">–</td>` +
      `<td class="dltc"><i class="dlt" data-kpi="${m.key}-delta" title="Δ gegenüber Fixed-Time — positiv = besser">–</i></td>`).join('');
    wrap.innerHTML = `<table class="kpi-table">
      <thead><tr><th rowspan="2"></th>${head}</tr><tr>${subHeads}</tr></thead>
      <tbody>
        <tr class="pol-fixed"><th class="pol" title="${POLICY_INFO.fixed}">${refL}</th>${fixedCells}</tr>
        <tr class="pol-adaptive"><th class="pol" title="${POLICY_INFO.adaptive}">${altL}</th>${adaptiveCells}</tr>
      </tbody>
    </table>`;
  }

  // cards ⇄ table toggle (persisted; table is the default)
  function initKpiView() {
    const grid = $('kpi-grid'), wrap = $('kpi-table-wrap');
    if (!grid || !wrap) return;
    const apply = (view) => {
      grid.hidden = view !== 'cards';
      wrap.hidden = view !== 'table';
      document.querySelectorAll('.kpi-view-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === view));
      try { localStorage.setItem('sf-kpi-view', view); } catch (_) {}
    };
    let view = 'table';
    try { view = localStorage.getItem('sf-kpi-view') || 'table'; } catch (_) {}
    if (view !== 'cards' && view !== 'table') view = 'table';
    document.querySelectorAll('.kpi-view-btn').forEach((b) =>
      b.addEventListener('click', () => apply(b.dataset.view)));
    apply(view);
  }

  function renderKPIs() {
    if (!state.summaryFixed || !state.summaryAdaptive) return;
    const all = (name) => document.querySelectorAll('[data-kpi="' + name + '"]');
    for (const m of KPI_META) {
      const fv = m.get(state.summaryFixed);
      const av = m.get(state.summaryAdaptive);
      all(m.key + '-fixed').forEach((el) => { el.textContent = fmt(fv, m.dec); });
      all(m.key + '-adaptive').forEach((el) => { el.textContent = fmt(av, m.dec); });

      // winner per metric: bold the better value (direction-aware, ties bold both)
      const betterAdaptive = m.dir === 'up' ? av > fv : av < fv;
      const tie = av === fv;
      all(m.key + '-fixed').forEach((el) => el.classList.toggle('best', tie || !betterAdaptive));
      all(m.key + '-adaptive').forEach((el) => el.classList.toggle('best', tie || betterAdaptive));

      all(m.key + '-delta').forEach((dEl) => {
        if (!fv) { dEl.textContent = 'n/a'; return; }
        // signed improvement: > 0 always means "better than Fixed-Time"
        const pct = m.dir === 'up' ? (av - fv) / fv * 100 : (fv - av) / fv * 100;
        dEl.textContent = (pct >= 0 ? '+' : '−') + fmt(Math.abs(pct), 1) + ' %';
        dEl.title = pct >= 0 ? 'Verbesserung gegenüber Fixed-Time' : 'Verschlechterung gegenüber Fixed-Time';
      });
    }
  }

  /* ===========================================================================
   * 7) CANVAS: intersection top-view
   * ======================================================================== */
  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function rr(ctx, x, y, w, h, r) { // rounded rect path
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawIntersection(canvas, frames, label) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);

    if (!frames || !frames.length) {
      centerText(ctx, w, h, 'Keine Daten');
      return;
    }

    const fIdx = state.t / Math.max(1, state.frameDt);
    const i0 = clamp(Math.floor(fIdx), 0, frames.length - 1);
    const i1 = clamp(i0 + 1, 0, frames.length - 1);
    const frac = clamp(fIdx - i0, 0, 1);
    const frame = frames[i0];
    const frameB = frames[i1];
    const g = geom(w, h);

    const j = state.junction || { arms: APPROACHES, movements: null, signalized: true, type: 'cross4' };
    const arms = j.arms || APPROACHES;
    const hasN = arms.indexOf('N') >= 0, hasS = arms.indexOf('S') >= 0;
    const hasE = arms.indexOf('E') >= 0, hasW = arms.indexOf('W') >= 0;

    // --- roads (only along arms that exist) ---
    ctx.fillStyle = '#141c25';
    if (hasE || hasW) ctx.fillRect(0, g.cy - g.roadHalf, w, 2 * g.roadHalf);
    if (hasN && hasS) ctx.fillRect(g.cx - g.roadHalf, 0, 2 * g.roadHalf, h);
    else if (hasN) ctx.fillRect(g.cx - g.roadHalf, 0, 2 * g.roadHalf, g.cy + g.roadHalf);
    else if (hasS) ctx.fillRect(g.cx - g.roadHalf, g.cy - g.roadHalf, 2 * g.roadHalf, h - (g.cy - g.roadHalf));

    // road edge lines
    ctx.strokeStyle = '#2a3948'; ctx.lineWidth = 1.5;
    if (hasE || hasW) {
      line(ctx, 0, g.cy - g.roadHalf, w, g.cy - g.roadHalf);
      line(ctx, 0, g.cy + g.roadHalf, w, g.cy + g.roadHalf);
    }
    if (hasN) { line(ctx, g.cx - g.roadHalf, 0, g.cx - g.roadHalf, g.cy - g.roadHalf); line(ctx, g.cx + g.roadHalf, 0, g.cx + g.roadHalf, g.cy - g.roadHalf); }
    if (hasS) { line(ctx, g.cx - g.roadHalf, g.cy + g.roadHalf, g.cx - g.roadHalf, h); line(ctx, g.cx + g.roadHalf, g.cy + g.roadHalf, g.cx + g.roadHalf, h); }

    // --- roundabout: draw the circulating ring, no signal heads ---
    const isRound = j.type === 'roundabout';
    if (isRound) {
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.roadHalf * 0.78, 0, Math.PI * 2);
      ctx.fillStyle = '#0f1620'; ctx.fill();
      ctx.strokeStyle = '#3a4c60'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.roadHalf * 0.40, 0, Math.PI * 2);
      ctx.fillStyle = '#16202b'; ctx.fill(); ctx.stroke();
    }

    // dashed lane separators (outside the box) + stop lines
    ctx.setLineDash([7, 7]); ctx.strokeStyle = '#33465a';
    if (hasN) line(ctx, g.cx, 0, g.cx, g.cy - g.roadHalf);
    if (hasS) line(ctx, g.cx, g.cy + g.roadHalf, g.cx, h);
    if (hasW) line(ctx, 0, g.cy, g.cx - g.roadHalf, g.cy);
    if (hasE) line(ctx, g.cx + g.roadHalf, g.cy, w, g.cy);
    ctx.setLineDash([]);

    // junction box outline
    ctx.strokeStyle = 'rgba(230,237,243,.55)'; ctx.lineWidth = 3;
    line(ctx, g.cx - g.roadHalf, g.cy - g.roadHalf, g.cx + g.roadHalf, g.cy - g.roadHalf);
    line(ctx, g.cx - g.roadHalf, g.cy + g.roadHalf, g.cx + g.roadHalf, g.cy + g.roadHalf);
    line(ctx, g.cx - g.roadHalf, g.cy - g.roadHalf, g.cx - g.roadHalf, g.cy + g.roadHalf);
    line(ctx, g.cx + g.roadHalf, g.cy - g.roadHalf, g.cx + g.roadHalf, g.cy + g.roadHalf);

    // --- per-approach signal heads (signalised junctions only) ---
    if (j.signalized !== false) {
      for (const a of arms) {
        drawSignalHead(ctx, g, a, signalColor(frame, a));
      }
    }

    // --- vehicles (stacked per lane, right-hand traffic) ---
    const lanes = (state.baseConfig && state.baseConfig.lanes) || { T: 2, L: 1, R: 1 };
    const bands = approachLaneBands(g, lanes);
    const moves = j.movements || null;
    const moveOk = (a, turn) => !moves || moves.indexOf(a + '-' + turn) >= 0;
    for (const a of arms) {
      const sgn = latSignFor(a);
      for (const turn of TURNS) {
        if (!moveOk(a, turn)) continue;
        const key = a + '-' + turn;
        const qa = (frame.q && frame.q[key]) || 0;
        const qb = (frameB.q && frameB.q[key]) || 0;
        const q = qa + (qb - qa) * frac;          // smooth queue growth/shrink
        const offsets = (bands[turn] || [0]).map(function (v) { return sgn * v; });
        drawQueue(ctx, g, a, turn, q, offsets, bands.eff);
      }
    }

    // --- vehicles driving through the junction (one per green movement per step) ---
    if (state.playing && frame.green) {
      for (const key of frame.green) {
        if (REDUCED) break;
        if (!moveOk(key.split('-')[0], key.split('-')[1])) continue;
        if ((frame.t - (state.crossSpawn[key] || -999)) >= state.frameDt && state.crossing.length < 80) {
          state.crossSpawn[key] = frame.t;
          const parts = key.split('-');
          state.crossing.push({ a: parts[0], turn: parts[1], p: 0,
                                kind: vehicleKind(key, Math.round(frame.t * 3)) });
        }
      }
    }
    for (const c of state.crossing) drawCrossing(ctx, g, c, bands);

    // --- labels & center readout ---
    // compass letters sit beside the road, not on the lane markings
    ctx.fillStyle = '#5d6b7a'; ctx.font = '600 12px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', g.cx - g.roadHalf - 18, 14);
    ctx.fillText('S', g.cx - g.roadHalf - 18, h - 14);
    ctx.fillText('W', 14, g.cy - g.roadHalf - 18);
    ctx.fillText('O', w - 14, g.cy - g.roadHalf - 18);

    // phase readout on a chip so crossing vehicles stay readable
    const phText = PHASE_LABEL[frame.phase] || frame.phase || '';
    const tText = 't = ' + Math.round(frame.t) + 's';
    ctx.font = '600 11px ' + FONT;
    const rw = Math.max(ctx.measureText(phText).width, ctx.measureText(tText).width);
    ctx.font = '10px ' + FONT;
    const chipW = rw + 20, chipH = 34;
    const chipX = g.cx, chipY = g.cy + g.roadHalf * 0.55 + 7;
    ctx.fillStyle = 'rgba(9,13,18,.78)';
    ctx.strokeStyle = '#223040'; ctx.lineWidth = 1;
    rr(ctx, chipX - chipW / 2, chipY - chipH / 2, chipW, chipH, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(45,212,191,.85)';
    ctx.font = '600 11px ' + FONT;
    ctx.fillText(phText, chipX, chipY - 7);
    ctx.fillStyle = 'rgba(139,152,167,.9)';
    ctx.font = '10px ' + FONT;
    ctx.fillText(tText, chipX, chipY + 8);
    void label;
  }

  function geom(w, h) {
    const cx = w / 2, cy = h / 2;
    const half = Math.min(w, h) / 2;
    const roadHalf = half * 0.26;
    const laneW = roadHalf / 2.6;
    const carLen = laneW * 1.4;
    const carGap = laneW * 0.30;
    const pitch = carLen + carGap;
    const approachLen = half - roadHalf;
    const maxPerLane = clamp(Math.floor((approachLen * 0.92 - carGap) / pitch), 1, 9);
    return { cx, cy, half, roadHalf, laneW, carLen, carGap, pitch, approachLen, maxPerLane };
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function signalColor(frame, approach) {
    if (frame.kind === 'all_red') return 'red';
    const greens = frame.green || [];
    if (greens.some((k) => k[0] === approach)) return 'green';
    if (frame.kind === 'yellow') {
      const ap = PHASE_APPROACHES[frame.phase] || [];
      return ap.indexOf(approach) >= 0 ? 'yellow' : 'red';
    }
    return 'red';
  }

  function drawSignalHead(ctx, g, a, color) {
    const c = COL[color];
    const thick = 9;
    let x, y, w, h;
    // the head sits over the approach's incoming (right-hand) half of the road
    if (a === 'N') { w = g.roadHalf; h = thick; x = g.cx - g.roadHalf; y = g.cy - g.roadHalf - 13 - thick / 2; }
    else if (a === 'S') { w = g.roadHalf; h = thick; x = g.cx; y = g.cy + g.roadHalf + 13 - thick / 2; }
    else if (a === 'E') { w = thick; h = g.roadHalf; x = g.cx + g.roadHalf + 13 - thick / 2; y = g.cy - g.roadHalf; }
    else { w = thick; h = g.roadHalf; x = g.cx - g.roadHalf - 13 - thick / 2; y = g.cy; }
    ctx.save();
    ctx.shadowColor = c; ctx.shadowBlur = 14;
    ctx.fillStyle = c;
    rr(ctx, x, y, w, h, thick / 2); ctx.fill();
    ctx.restore();
  }

  /* -------------------- vehicle types (Pkw / Van / Lkw / Bus) -------------
   * Queue counts are aggregate vehicles, so the *configured* mix of the run
   * decides which slot shows which type — deterministic per (movement, index)
   * so the picture is stable across frames. Turn direction stays the colour;
   * the type changes size and silhouette. */
  const VEH = {
    car:   { len: 1.0,  wid: 1.0 },
    van:   { len: 1.22, wid: 1.08 },
    truck: { len: 1.85, wid: 1.14 },
    bus:   { len: 2.05, wid: 1.12 },
  };
  function vehicleMix() {
    const m = (state.result && state.result.config && state.result.config.vehicle_mix)
      || (state.baseConfig && state.baseConfig.vehicle_mix) || { car: 1 };
    return Object.keys(m).filter((k) => m[k] > 0).map((k) => [k, m[k]])
      .sort((x, y) => y[1] - x[1]);
  }
  function hash01(key, i) {
    let h = 2166136261 ^ Math.imul(i + 1, 374761393);
    for (let k = 0; k < key.length; k++) { h ^= key.charCodeAt(k); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }
  function vehicleKind(key, i) {
    const mix = vehicleMix();
    if (mix.length < 2) return mix[0] ? mix[0][0] : 'car';
    const x = hash01(key, i);
    let acc = 0;
    for (const [kind, share] of mix) { acc += share; if (x < acc) return kind; }
    return mix[mix.length - 1][0];
  }
  // Body along the travel axis (x after translate/rotate); wid across.
  function drawVehicleBody(ctx, kind, len, wid) {
    const v = VEH[kind] || VEH.car;
    const L = len * v.len, W = wid * v.wid;
    rr(ctx, -L / 2, -W / 2, L, W, Math.min(L, W) * 0.26);
    ctx.fill();
    if (kind !== 'car') {                        // heavier traffic pops a bit
      ctx.strokeStyle = 'rgba(9,13,18,.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.save();
    if (kind === 'truck') {
      ctx.fillStyle = 'rgba(9,13,18,.4)';                 // cab / box gap
      ctx.fillRect(L * 0.14, -W / 2 + 1, 2.5, W - 2);
      ctx.fillStyle = 'rgba(230,237,243,.5)';             // cab window
      ctx.fillRect(L / 2 - 3.5, -W / 2 + 1.5, 2, W - 3);
    } else if (kind === 'bus') {
      ctx.fillStyle = 'rgba(230,237,243,.38)';            // roof stripes
      ctx.fillRect(-L * 0.32, -W / 2 + 1.5, L * 0.64, 2);
      ctx.fillRect(-L * 0.32, W / 2 - 3.5, L * 0.64, 2);
    } else if (kind === 'van') {
      ctx.fillStyle = 'rgba(230,237,243,.35)';            // windscreen
      ctx.fillRect(L / 2 - 3, -W / 2 + 1.5, 2, W - 3);
    }
    ctx.restore();
  }

  function drawQueue(ctx, g, a, turn, q, offsets, laneEff) {
    const count = Math.round(q);
    if (count <= 0) return;
    const nLanes = Math.max(1, offsets.length);
    const color = COL[turn];
    const vertical = (a === 'N' || a === 'S');
    const roadHalf = g.roadHalf, carLen = g.carLen, carGap = g.carGap, pitch = g.pitch;
    const bodyW = (laneEff || g.laneW) * 0.78; // lane pitch, not nominal laneW
    const extra = new Array(nLanes).fill(0);   // extra length longer vehicles add

    for (let i = 0; i < count; i++) {
      const laneIdx = i % nLanes;
      const pos = Math.floor(i / nLanes);
      if (pos >= g.maxPerLane) break;
      const kind = vehicleKind(a + '-' + turn + laneIdx, i);
      const vlen = carLen * ((VEH[kind] || VEH.car).len);
      const off = offsets[laneIdx];          // signed lateral offset (right-hand side)
      let cx0, cy0;
      if (vertical) {
        const sx = g.cx + off;
        const yBase = a === 'N'
          ? g.cy - roadHalf - carGap - vlen / 2 - pos * pitch - extra[laneIdx]
          : g.cy + roadHalf + carGap + vlen / 2 + pos * pitch + extra[laneIdx];
        cx0 = sx; cy0 = yBase;
      } else {
        const sy = g.cy + off;
        const xBase = a === 'W'
          ? g.cx - roadHalf - carGap - vlen / 2 - pos * pitch - extra[laneIdx]
          : g.cx + roadHalf + carGap + vlen / 2 + pos * pitch + extra[laneIdx];
        cx0 = xBase; cy0 = sy;
      }
      ctx.save();
      ctx.translate(cx0, cy0);
      if (vertical) ctx.rotate(Math.PI / 2);      // body x-axis along the road
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.92;
      drawVehicleBody(ctx, kind, carLen, bodyW);
      ctx.restore();
      ctx.globalAlpha = 1;
      extra[laneIdx] += vlen - carLen;            // push followers further back
    }
  }

  // Right-hand traffic: an approach's lanes live in its right-hand half of the
  // road. Within that half they are ordered from the kerb inward as R, T, L
  // (kerb -> median), and the returned offsets are signed relative to the road
  // centreline (+ = down/right on screen).
  const MOVEMENTS_MEDIAN_FIRST = ['L', 'T', 'R'];
  function approachLaneBands(g, lanes) {
    const per = { L: Math.max(1, lanes.L | 0), T: Math.max(1, lanes.T | 0), R: Math.max(1, lanes.R | 0) };
    const total = per.L + per.T + per.R;
    const eff = Math.min(g.laneW, g.roadHalf / total);
    const bands = { L: [], T: [], R: [] };
    let j = 0;
    for (const mv of MOVEMENTS_MEDIAN_FIRST) {   // median -> kerb
      for (let k = 0; k < per[mv]; k++) { bands[mv].push((j + 0.5) * eff); j++; }
    }
    bands.eff = eff;                           // actual lane pitch (vehicles must fit inside)
    return bands;                              // unsigned distance from the centreline
  }

  // +1 when the approach's right-hand side is the +lateral axis (S: +x, W: +y)
  function latSignFor(a) { return (a === 'S' || a === 'W') ? 1 : -1; }

  // a vehicle mid-crossing, drawn along its true turning path:
  //   T -> straight across, R -> right-hand quarter arc, L -> left-hand arc
  // roundabout -> straight lead-in, circulate the ring, straight lead-out
  // (right-hand traffic circles counter-clockwise on screen).
  const RING_ANGLE = { N: -Math.PI / 2, S: Math.PI / 2, E: 0, W: Math.PI };
  function exitArmFor(a, turn) {
    const H = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] };
    const V2ARM = { '0,1': 'S', '0,-1': 'N', '1,0': 'E', '-1,0': 'W' };
    const hx = H[a][0], hy = H[a][1];
    const d = turn === 'R' ? [-hy, hx] : turn === 'L' ? [hy, -hx] : [-hx, -hy];
    return V2ARM[d.join(',')];
  }

  function drawCrossing(ctx, g, c, bands) {
    const a = c.a, turn = c.turn;
    const p = clamp(c.p, 0, 1);
    let x, y, ang;

    if (state.junction && state.junction.type === 'roundabout') {
      const rC = g.roadHalf * 0.59;               // mid of the circulating lane
      const thIn = RING_ANGLE[a];
      const thOut = RING_ANGLE[exitArmFor(a, turn)];
      let d = thOut - thIn;                       // travel CCW on screen (y grows down)
      while (d > -1e-9) d -= 2 * Math.PI;
      while (d <= -2 * Math.PI + 1e-9) d += 2 * Math.PI;
      const EXT = 0.43;                           // lead-in/out to the stop line (rC+EXT ≈ roadHalf)
      const ringPt = (th, r) => [g.cx + Math.cos(th) * r, g.cy + Math.sin(th) * r];
      const entry0 = ringPt(thIn, rC + EXT), entry1 = ringPt(thIn, rC);
      const exit1 = ringPt(thOut, rC), exit0 = ringPt(thOut, rC + EXT);
      if (p < 0.22) {
        const u = p / 0.22;
        x = entry0[0] + (entry1[0] - entry0[0]) * u;
        y = entry0[1] + (entry1[1] - entry0[1]) * u;
        ang = Math.atan2(entry1[1] - entry0[1], entry1[0] - entry0[0]);
      } else if (p > 0.78) {
        const u = (p - 0.78) / 0.22;
        x = exit1[0] + (exit0[0] - exit1[0]) * u;
        y = exit1[1] + (exit0[1] - exit1[1]) * u;
        ang = Math.atan2(exit0[1] - exit1[1], exit0[0] - exit1[0]);
      } else {
        const u = (p - 0.22) / 0.56;
        const th = thIn + d * u;
        x = g.cx + Math.cos(th) * rC;
        y = g.cy + Math.sin(th) * rC;
        ang = Math.atan2(Math.cos(th) * d, -Math.sin(th) * d);
      }
    } else {
      const sgnIn = latSignFor(a);
      const vIn = (bands[turn] && bands[turn][0]) || g.laneW * 0.6;
      const vOut = (bands.T && bands.T[0]) || g.laneW * 0.6;
      const offIn = sgnIn * vIn;

      // heading per approach (screen coords, y grows downwards)
      const HEAD = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] };
      let hx = HEAD[a][0], hy = HEAD[a][1];
      let dx = hx, dy = hy;
      if (turn === 'R') { dx = -hy; dy = hx; }          // rotate right (clockwise)
      else if (turn === 'L') { dx = hy; dy = -hx; }     // rotate left

      const R = g.roadHalf;
      const inVertical = (a === 'N' || a === 'S');
      const outVertical = (dx === 0);
      // exit lanes sit on the right-hand side of the *exit* heading
      const sgnOut = outVertical ? -Math.sign(dy || 1) : Math.sign(dx || 1);

      let x0, y0, x1, y1;
      if (inVertical) {
        x0 = g.cx + offIn;
        y0 = a === 'N' ? g.cy - R : g.cy + R;
      } else {
        x0 = a === 'W' ? g.cx - R : g.cx + R;
        y0 = g.cy + offIn;
      }
      if (outVertical) {
        x1 = g.cx + sgnOut * vOut;
        y1 = dy > 0 ? g.cy + R : g.cy - R;
      } else {
        x1 = dx > 0 ? g.cx + R : g.cx - R;
        y1 = g.cy + sgnOut * vOut;
      }

      if (turn === 'T') {
        x = x0 + (x1 - x0) * p;
        y = y0 + (y1 - y0) * p;
        ang = Math.atan2(y1 - y0, x1 - x0);
      } else {
        // quadratic Bezier with the control point at the lane-crossing corner
        const cxq = inVertical ? x0 : x1;
        const cyq = inVertical ? y1 : y0;
        const u = 1 - p;
        x = u * u * x0 + 2 * u * p * cxq + p * p * x1;
        y = u * u * y0 + 2 * u * p * cyq + p * p * y1;
        const tx = 2 * u * (cxq - x0) + 2 * p * (x1 - cxq);
        const ty = 2 * u * (cyq - y0) + 2 * p * (y1 - cyq);
        ang = Math.atan2(ty, tx);
      }
    }

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = COL[turn] || '#9fb0c0';
    drawVehicleBody(ctx, c.kind || 'car', g.carLen, (bands.eff || g.laneW) * 0.78);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function frameIndex(frames) {
    const idx = Math.round(state.t / state.frameDt);
    return clamp(idx, 0, frames.length - 1);
  }

  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  function centerText(ctx, w, h, txt) {
    ctx.fillStyle = '#63707e'; ctx.font = '600 14px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, w / 2, h / 2);
  }

  function drawActiveCanvases() {
    const wrap = $('canvas-wrap');
    if (state.mode === 'both') {
      wrap.classList.add('dual');
      $('cell-main-title').textContent = 'Fixed';
      $('cell-alt-title').textContent = 'Adaptive';
      drawIntersection($('canvas-main'), state.fixedFrames, 'fixed');
      drawIntersection($('canvas-alt'), state.adaptiveFrames, 'adaptive');
    } else {
      wrap.classList.remove('dual');
      $('cell-main-title').textContent = state.mode === 'fixed' ? 'Fixed' : 'Adaptive';
      drawIntersection($('canvas-main'),
        state.mode === 'fixed' ? state.fixedFrames : state.adaptiveFrames, state.mode);
    }
    // readouts
    const frames = state.mode === 'fixed' ? state.fixedFrames : state.adaptiveFrames;
    if (frames && frames.length) {
      const f = frames[frameIndex(frames)];
      $('playhead-phase').textContent = PHASE_LABEL[f.phase] || f.phase || '–';
      $('playhead-t').textContent = 't ' + timeStr(state.t) + ' / ' + timeStr(state.duration);
      const qel = $('playhead-queue');
      if (qel) {
        let tot = 0;
        for (const k in (f.q || {})) tot += f.q[k] || 0;
        qel.textContent = Math.round(tot) + ' veh';
      }
    }
  }

  /* ===========================================================================
   * 8) CHARTS  (bars + delay time-series)
   * ======================================================================== */
  const BAR_METRICS = [
    { title: 'Ø Verzögerung', unit: 's', get: (s) => s.avg_delay_s, dec: 1 },
    { title: 'Durchsatz', unit: 'veh/h', get: (s) => s.throughput_vph, dec: 0 },
    { title: 'max. Queue', unit: '', get: (s) => s.max_queue, dec: 1 },
    { title: 'CO₂', unit: 'g', get: (s) => s.co2_g, dec: 0 },
  ];

  function renderCharts() {
    drawBars($('chart-bars'));
    drawDelayChart(); // also drawn in the animation loop for the playhead
  }

  function drawBars(canvas) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!state.summaryFixed || !state.summaryAdaptive) { centerText(ctx, w, h, 'Keine Daten'); return; }

    const padL = 46, padR = 14, padT = 26, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const n = BAR_METRICS.length;
    const groupW = plotW / n;
    const barW = Math.min(34, groupW * 0.30);

    // grid
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      line(ctx, padL, y, padL + plotW, y);
    }

    BAR_METRICS.forEach((m, i) => {
      const fv = m.get(state.summaryFixed) || 0;
      const av = m.get(state.summaryAdaptive) || 0;
      const max = Math.max(fv, av) * 1.18 || 1;
      const gx = padL + i * groupW;
      const center = gx + groupW / 2;

      const fh = plotH * (fv / max);
      const ah = plotH * (av / max);
      const xf = center - barW - 3, xa = center + 3;

      // fixed bar
      ctx.fillStyle = COL.fixed;
      rr(ctx, xf, padT + plotH - fh, barW, fh, 4); ctx.fill();
      // adaptive bar
      ctx.fillStyle = COL.adaptive;
      rr(ctx, xa, padT + plotH - ah, barW, ah, 4); ctx.fill();

      // value labels
      ctx.fillStyle = '#cbd5e1'; ctx.font = '10.5px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(fv, m.dec), xf + barW / 2, padT + plotH - fh - 3);
      ctx.fillStyle = COL.adaptive;
      ctx.fillText(fmt(av, m.dec), xa + barW / 2, padT + plotH - ah - 3);

      // category label
      ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT; ctx.textBaseline = 'top';
      ctx.fillText(m.title + (m.unit ? ' (' + m.unit + ')' : ''), center, padT + plotH + 9);
    });

    // baseline
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, padT + plotH, padL + plotW, padT + plotH);

    // legend
    legendSwatch(ctx, padL, 10, COL.fixed, 'Fixed');
    legendSwatch(ctx, padL + 78, 10, COL.adaptive, 'Adaptive');
  }

  function legendSwatch(ctx, x, y, color, label) {
    ctx.fillStyle = color; rr(ctx, x, y, 10, 10, 3); ctx.fill();
    ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 15, y + 5);
  }

  function drawDelayChart() {
    const canvas = $('chart-delay');
    if (!canvas) return;
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!state.fixedFrames.length || !state.adaptiveFrames.length) {
      centerText(ctx, w, h, 'Keine Daten'); return;
    }

    const padL = 52, padR = 14, padT = 26, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    // cumulative delay series (veh·s) — frame.delay_s is already cumulative
    const fx = state.fixedFrames, ax = state.adaptiveFrames;
    let yMax = 1;
    for (const f of fx) yMax = Math.max(yMax, f.delay_s || 0);
    for (const f of ax) yMax = Math.max(yMax, f.delay_s || 0);
    yMax *= 1.1;

    const tMax = Math.max(state.duration, 1);

    // grid + y labels
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.fillStyle = COL.txt; ctx.font = '10px ' + FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      line(ctx, padL, y, padL + plotW, y);
      ctx.fillText(fmt(yMax * (1 - i / 4), 0), padL - 7, y);
    }
    // x labels (time)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const x = padL + plotW * i / 4;
      ctx.fillText(timeStr(tMax * i / 4), x, padT + plotH + 8);
    }

    // series
    plotSeries(ctx, fx, padL, padT, plotW, plotH, tMax, yMax, COL.fixed);
    plotSeries(ctx, ax, padL, padT, plotW, plotH, tMax, yMax, COL.adaptive);

    // axes
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, padT + plotH, padL + plotW, padT + plotH);
    line(ctx, padL, padT, padL, padT + plotH);

    // playhead
    const px = padL + plotW * clamp(state.t / tMax, 0, 1);
    ctx.strokeStyle = 'rgba(230,237,243,.35)';
    ctx.setLineDash([4, 4]);
    line(ctx, px, padT, px, padT + plotH);
    ctx.setLineDash([]);

    // legend + axis title
    legendSwatch(ctx, padL, 10, COL.fixed, 'Fixed');
    legendSwatch(ctx, padL + 78, 10, COL.adaptive, 'Adaptive');
    ctx.fillStyle = COL.txt; ctx.font = '10px ' + FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('kumuliert · veh·s', w - padR, 10);
  }

  function plotSeries(ctx, frames, padL, padT, plotW, plotH, tMax, yMax, color) {
    if (!frames.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const x = padL + plotW * clamp((f.t || 0) / tMax, 0, 1);
      const y = padT + plotH * (1 - clamp((f.delay_s || 0) / yMax, 0, 1));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /* ===========================================================================
   * 9) DECISIONS PANEL ("Warum?")
   * ======================================================================== */
  function renderDecisions() {
    const list = $('decisions-list');
    list.innerHTML = '';
    const decs = state.decisions || [];
    if (!decs.length) {
      list.innerHTML = '<li class="empty">Keine Phasenwechsel protokolliert.</li>';
      renderPressureTable(null);
      return;
    }
    // newest first
    for (let i = decs.length - 1; i >= 0; i--) {
      const d = decs[i];
      const li = document.createElement('li');
      li.className = 'decision-item' + (i === state.selectedDecision ? ' active' : '');
      li.dataset.idx = String(i);
      li.innerHTML =
        `<div class="head"><span class="t">${timeStr(d.t)}</span>` +
        `<span class="swap">${d.from || '–'}<span class="arrow">→</span>${d.to || '–'}</span></div>` +
        `<div class="why">${escapeHtml(d.reason || '')}</div>`;
      li.addEventListener('click', () => {
        state.selectedDecision = i;
        renderDecisions();
      });
      list.appendChild(li);
    }
    renderPressureTable(decs[state.selectedDecision]);
  }

  function renderPressureTable(dec) {
    const tbl = $('pressures-table');
    tbl.innerHTML = '';
    const head = document.createElement('thead');
    head.innerHTML = '<tr><th>Phase</th><th></th><th style="text-align:right">Druck</th></tr>';
    tbl.appendChild(head);
    const body = document.createElement('tbody');
    const pressures = (dec && dec.pressures) || null;
    let maxP = 1;
    if (pressures) for (const k of PHASE_ORDER) maxP = Math.max(maxP, pressures[k] || 0);
    for (const p of PHASE_ORDER) {
      const val = pressures ? (pressures[p] || 0) : null;
      const tr = document.createElement('tr');
      const barW = val !== null ? Math.round(70 * clamp(val / maxP, 0, 1)) : 0;
      tr.innerHTML =
        `<td>${PHASE_LABEL[p] || p}</td>` +
        `<td><div class="bar" style="width:${barW}px"></div></td>` +
        `<td class="p">${val === null ? '–' : fmt(val, 1)}</td>`;
      if (dec && dec.to === p) tr.style.color = COL.adaptive;
      body.appendChild(tr);
    }
    tbl.appendChild(body);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ===========================================================================
   * 10) ASK PANEL — extracted to web/ask.js (shared with network.html).
   *    Initialised with junction context in bindEvents(); see SFAsk.init.
   * ======================================================================== */

  // Speak a concise summary of the current result (junction phrasing; the
  // network page injects its own). Fed to SFAsk for "Ergebnis vorlesen".
  function buildResultSentence() {
    const r = state.result;
    if (!r || !r.summary || !r.summary.fixed || !r.summary.adaptive) return '';
    const f = r.summary.fixed, a = r.summary.adaptive, i = r.improvement || {};
    const sc = (state.baseConfig && state.baseConfig.demand_scenario) || 'normal';
    return 'SignalFlow, Szenario ' + sc + '. Feste Steuerung: ' +
      fmt(f.avg_delay_s, 1) + ' Sekunden Verzögerung je Fahrzeug. Adaptive Steuerung: ' +
      fmt(a.avg_delay_s, 1) + ' Sekunden, also ' + fmt(i.avg_delay_pct != null ? i.avg_delay_pct : 0, 1) +
      ' Prozent weniger. Durchsatz ' + fmt(a.throughput_vph, 0) + ' Fahrzeuge pro Stunde.';
  }

  /* ===========================================================================
   * 11) PLAYBACK / ANIMATION LOOP
   * ======================================================================== */
  function setPlaying(p) {
    state.playing = p;
    const b = $('btn-play');
    b.textContent = p ? '❚❚' : '▶';
    b.title = p ? 'Pause' : 'Play';
    b.setAttribute('aria-label', p ? 'Pause' : 'Abspielen');
    b.setAttribute('aria-pressed', p ? 'true' : 'false');
  }

  // keyboard control: space = play/pause, arrows = scrub, +/- = speed
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!state.result) return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
      else if (e.key === 'ArrowRight') { state.t = clamp(state.t + 10, 0, state.duration); }
      else if (e.key === 'ArrowLeft') { state.t = clamp(state.t - 10, 0, state.duration); }
      else if (e.key === '+' || e.key === '=') { state.speed = Math.min(state.speed * 2, 400); updateSpeedReadout(); }
      else if (e.key === '-') { state.speed = Math.max(state.speed / 2, 1); updateSpeedReadout(); }
    });
  }

  function updateSpeedReadout() {
    const el = document.getElementById('speed-readout');
    if (el) el.textContent = fmt(state.speed, 0) + '×';
  }

  function updateProgress() {
    const p = $('progress');
    const val = state.duration ? (state.t / state.duration) * 100 : 0;
    p.value = String(clamp(val, 0, 100));
    setRangeFill(p, clamp(val, 0, 100));
  }

  let lastTs = 0;
  function frameLoop(ts) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (state.playing && state.result) {
      state.t += dt * state.speed;
      if (state.t >= state.duration) { state.t = state.duration; setPlaying(false); }
      // advance vehicles driving through the junction
      const rate = (dt * state.speed) / Math.max(1, state.frameDt * 0.9);
      if (state.crossing.length) {
        state.crossing.forEach((c) => { c.p += rate; });
        state.crossing = state.crossing.filter((c) => c.p < 1);
      }
    }
    updateProgress();
    drawActiveCanvases();
    if (state.result) drawDelayChart();
    requestAnimationFrame(frameLoop);
  }

  /* ===========================================================================
   * 12) CONFIG CONTROLS
   * ======================================================================== */
  function bindControls() {
    const dur = $('ctl-duration'), load = $('ctl-load'), seed = $('ctl-seed');
    const source = document.getElementById('ctl-source');

    const sync = () => {
      $('val-duration').textContent = dur.value;
      $('val-load').textContent = Number(load.value).toFixed(2);
      $('val-seed').textContent = seed.value;
      [dur, load, seed].forEach(setRangeFill);
    };
    [dur, load, seed].forEach((el) => el.addEventListener('input', sync));
    sync();

    let timer = null;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(runSimulation, 300); };
    dur.addEventListener('input', schedule);
    load.addEventListener('input', schedule);
    seed.addEventListener('input', schedule);
    if (source) source.addEventListener('change', runSimulation);
    ['ctl-scenario', 'ctl-mix', 'ctl-tsp', 'ctl-junction'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', runSimulation);
    });
  }

  // paint the filled part of a range input via a CSS variable
  function setRangeFill(el, forcePct) {
    const min = +el.min || 0, max = +el.max || 100, v = +el.value;
    const pct = forcePct !== undefined ? forcePct : ((v - min) / (max - min) * 100);
    el.style.setProperty('--fill', pct + '%');
  }

  /* ===========================================================================
   * 13) SMALL DOM HELPERS
   * ======================================================================== */
  function show(el, text) { if (el) { if (text) el.innerHTML = text; el.classList.remove('hidden'); } }
  function hide(el) { if (el) el.classList.add('hidden'); }

  /* ===========================================================================
   * 14) OFFLINE DEMO GENERATOR  (mirrors the backend payload shape)
   * ======================================================================== */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(rng, lam) {
    if (lam <= 0) return 0;
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  function runDemo(cfg) {
    const steps = Math.max(60, (cfg.duration_min || 30) * 60);
    const sampleDt = 4;
    const lanes = cfg.lanes || { T: 2, L: 1, R: 1 };
    const svc = {};
    for (const m of MOVE_KEYS) { const turn = m.split('-')[1]; svc[m] = (lanes[turn] || 1) * 1800 / 3600; }

    const rng = mulberry32(cfg.seed || 1);
    const arrivals = [];
    for (let t = 0; t < steps; t++) {
      const mult = cfg.demand_profile === 'flat' ? 1
        : 0.6 + 1.0 * Math.sin(Math.PI * t / (steps - 1));
      const row = {};
      for (const a of APPROACHES) for (const mv of TURNS) {
        const rate = ((cfg.demand[a] || {})[mv] || 0) * (cfg.demand_multiplier || 1) * mult;
        row[a + '-' + mv] = poisson(rng, rate / 3600);
      }
      arrivals.push(row);
    }

    // ---- fixed-time plan ----
    const fixedGreens = cfg.fixed_greens || [36, 10, 32, 8];
    const plan = [];
    PHASE_ORDER.forEach((ph, i) => {
      plan.push({ phase: ph, kind: 'green', dur: fixedGreens[i] || 20 });
      plan.push({ phase: ph, kind: 'yellow', dur: 3 });
      plan.push({ phase: ph, kind: 'all_red', dur: 1 });
    });

    function policyFixed() {
      let pos = 0, remaining = plan[0].dur;
      return function (t) {
        const cur = plan[pos];
        const dec = { phase: cur.phase, kind: cur.kind, green: cur.kind === 'green' ? PHASE_MOVES[cur.phase] : [] };
        remaining--;
        if (remaining <= 0) { pos = (pos + 1) % plan.length; remaining = plan[pos].dur; }
        return dec;
      };
    }

    const minG = cfg.min_green || 24, maxG = cfg.max_green || 50;
    function policyAdaptive() {
      let cur = 0, elapsed = 0, mode = 'green', pending = 0;
      return function (t, q) {
        const pressures = PHASE_ORDER.map((ph) =>
          PHASE_MOVES[ph].reduce((s, m) => s + (q[m] || 0), 0));
        const curName = PHASE_ORDER[cur];
        const dec = { phase: curName, kind: mode, green: mode === 'green' ? PHASE_MOVES[curName] : [], pressures: null };

        if (mode === 'green') {
          elapsed++;
          let best = 0;
          for (let i = 1; i < PHASE_ORDER.length; i++) if (pressures[i] > pressures[best]) best = i;
          const curP = pressures[cur];
          const beat = best !== cur && pressures[best] > curP * (cfg.switch_hysteresis || 3) + 0.5;
          if ((elapsed >= minG && beat) || elapsed >= maxG) {
            dec.switch = true; dec.to = PHASE_ORDER[best]; pending = best; mode = 'yellow'; elapsed = 0;
            dec.kind = 'yellow'; dec.green = [];
            dec.pressures = {};
            PHASE_ORDER.forEach((ph, i2) => dec.pressures[ph] = Math.round(pressures[i2] * 10) / 10);
            dec.reason = `switch ${curName}->${PHASE_ORDER[best]} ` +
              `(${elapsed ? 'higher competing pressure' : 'max green reached'}): ` +
              `pressure ${pressures[best].toFixed(1)} vs current ${curP.toFixed(1)}`;
          }
        } else if (mode === 'yellow') {
          elapsed++; dec.green = [];
          if (elapsed >= 3) { mode = 'all_red'; elapsed = 0; }
        } else {
          elapsed++; dec.green = [];
          if (elapsed >= 1) { cur = pending; mode = 'green'; elapsed = 0; dec.phase = PHASE_ORDER[cur]; }
        }
        return dec;
      };
    }

    function runOne(stepFn) {
      const q = {}; MOVE_KEYS.forEach((m) => q[m] = 0);
      const frames = [], decisions = [];
      let arrived = 0, served = 0, delay = 0, wasted = 0, maxQ = 0, qSum = 0;
      for (let t = 0; t < steps; t++) {
        const row = arrivals[t];
        for (const m of MOVE_KEYS) { const n = row[m]; if (n) { q[m] += n; arrived += n; } }
        const dec = stepFn(t, q);
        const greens = dec.green || [];
        let stepServed = 0;
        for (const m of greens) { const s = Math.min(q[m], svc[m]); q[m] -= s; stepServed += s; }
        served += stepServed;
        const qNow = MOVE_KEYS.reduce((s, m) => s + q[m], 0);
        qSum += qNow; maxQ = Math.max(maxQ, qNow);
        delay += qNow;
        if (greens.length && greens.every((m) => q[m] < 0.5)) wasted += 1;
        if (dec.switch) decisions.push({ t, from: dec.phase, to: dec.to, reason: dec.reason, pressures: dec.pressures });
        if (t % sampleDt === 0 || t === steps - 1) {
          const qObj = {}; MOVE_KEYS.forEach((m) => qObj[m] = Math.round(q[m] * 100) / 100);
          frames.push({
            t, phase: dec.phase, kind: dec.kind,
            green: greens.slice().sort(), q: qObj,
            served: Math.round(stepServed * 100) / 100,
            delay_s: Math.round(delay * 10) / 10,
          });
        }
      }
      return {
        frames, decisions,
        summary: {
          controller: 'demo',
          arrived, served,
          avg_delay_s: Math.round(delay / Math.max(1, arrived) * 100) / 100,
          avg_queue: Math.round(qSum / steps * 1000) / 1000,
          max_queue: Math.round(maxQ * 100) / 100,
          throughput_vph: Math.round(served / (steps / 3600) * 10) / 10,
          stops: 0,
          wasted_green_s: wasted,
          total_delay_vehsec: Math.round(delay * 10) / 10,
          co2_g: Math.round(delay * 1.15 * 10) / 10,
          left_in_system: Math.round(MOVE_KEYS.reduce((s, m) => s + q[m], 0) * 100) / 100,
        },
      };
    }

    const f = runOne(policyFixed());
    const a = runOne(policyAdaptive());
    const fs = f.summary, as = a.summary;
    const red = (b, n) => b ? Math.round((b - n) / b * 1000) / 10 : 0;
    return {
      config: cfg, phases: PHASE_ORDER,
      summary: { fixed: fs, adaptive: as },
      improvement: {
        avg_delay_pct: red(fs.avg_delay_s, as.avg_delay_s),
        throughput_pct: fs.throughput_vph ? Math.round((as.throughput_vph - fs.throughput_vph) / fs.throughput_vph * 1000) / 10 : 0,
        max_queue_pct: red(fs.max_queue, as.max_queue),
        co2_pct: red(fs.co2_g, as.co2_g),
        wasted_green_pct: red(fs.wasted_green_s, as.wasted_green_s),
      },
      fixed: { frames: f.frames },
      adaptive: { frames: a.frames, decisions: a.decisions.slice(0, 200) },
      meta: { steps, frame_dt: sampleDt, generated: 'SignalFlow demo (offline)' },
    };
  }

  /* ===========================================================================
   * 15) EVENT WIRING + INIT
   * ======================================================================== */
  // dark ⇄ light theme (persisted; canvases stay dark "monitors")
  function initTheme() {
    const btn = $('btn-theme');
    const apply = (t) => {
      document.body.dataset.theme = t;
      if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
      try { localStorage.setItem('sf-theme', t); } catch (_) {}
    };
    let t = 'dark';
    try { t = localStorage.getItem('sf-theme') || 'dark'; } catch (_) {}
    if (t !== 'light' && t !== 'dark') t = 'dark';
    if (btn) btn.addEventListener('click', () =>
      apply(document.body.dataset.theme === 'light' ? 'dark' : 'light'));
    apply(t);
  }

  function bindEvents() {
    initKpiView();
    initTheme();
    $('btn-simulate').addEventListener('click', runSimulation);

    $('btn-play').addEventListener('click', () => {
      if (!state.result) return;
      if (state.t >= state.duration) state.t = 0;
      setPlaying(!state.playing);
    });

    document.querySelectorAll('.speed-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.speed = (state.baseSpeed || 10) * (+b.dataset.speed);
        updateSpeedReadout();
        document.querySelectorAll('.speed-btn').forEach((x) => x.classList.toggle('active', x === b));
      });
    });

    // viewer mode only — .ask-mode buttons belong to the ask panel (ask.js)
    const viewerModeBtns = document.querySelectorAll('.modes:not(.ask-mode) .mode-btn');
    viewerModeBtns.forEach((b) => {
      b.addEventListener('click', () => {
        state.mode = b.dataset.mode;
        viewerModeBtns.forEach((x) => x.classList.toggle('active', x === b));
      });
    });

    const prog = $('progress');
    prog.addEventListener('input', () => {
      state.t = (Number(prog.value) / 100) * state.duration;
      setRangeFill(prog, Number(prog.value));
    });

    if (window.SFAsk) SFAsk.init({
      fetchJSON: fetchJSON,
      apiFetch: apiFetch,
      context: function () { return { kind: 'junction' }; },
      resultSentence: buildResultSentence,
    });
    if ($('btn-speak-result')) $('btn-speak-result').addEventListener('click', () => SFAsk.speakResult());

    // scenario presets (one click)
    document.querySelectorAll('.preset').forEach((b) => {
      b.addEventListener('click', () => {
        const sel = document.getElementById('ctl-scenario');
        if (sel) sel.value = b.dataset.scenario || 'normal';
        document.querySelectorAll('.preset').forEach((x) => x.classList.toggle('active', x === b));
        runSimulation();
      });
    });

    // export the intersection view as PNG
    if ($('btn-export')) $('btn-export').addEventListener('click', () => {
      exportCanvas('canvas-main', 'signalflow-kreuzung.png');
    });

    // auto-speak toggle
    if ($('chk-autospeak')) $('chk-autospeak').addEventListener('change', (e) => {
      state.autoSpeak = !!e.target.checked;
    });

    window.addEventListener('resize', () => { renderCharts(); });
  }

  async function init() {
    bindKeyboard();
    buildKpiCards();
    bindControls();
    bindEvents();
    renderDecisions();          // zero-state
    renderBadges();
    updateProgress();
    requestAnimationFrame(frameLoop);

    // kick off network work (each step degrades gracefully)
    await Promise.all([loadHealth(), loadConfig()]);
    renderBadges();
    await runSimulation();
  }

  // run once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
