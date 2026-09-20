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
    NS_THRU: 'N–S · Gerade', NS_LEFT: 'N–S · Links',
    EW_THRU: 'O–W · Gerade', EW_LEFT: 'O–W · Links',
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

  // the compared strategies (colour-consistent with the network dashboard)
  const POLICY_META = [
    { key: 'fixed', label: 'Fixed', color: '#aab6c4',
      info: 'Fester Signalplan mit vordefinierten Grünzeiten — reagiert nicht auf den live Verkehr (Baseline)' },
    { key: 'adaptive', label: 'Adaptiv', color: '#2dd4bf',
      info: 'SignalFlow: Phasenlängen reagieren live auf den Warteschlangen-Druck jeder Richtung (Max-Pressure)' },
    { key: 'coordinated', label: 'Koord.', color: '#f5c451',
      info: 'Grüne Welle: Korridor-Takt 90 s, Grünanteile zugunsten der Hauptachse. An der isolierten Kreuzung ≈ Fixed — der Gewinn entsteht erst mit Nachbarn (Netzwerk-Ansicht)' },
    { key: 'tuned', label: 'Tuned', color: '#a78bfa',
      info: 'Webster-Pläne aus Stopp-Linien-Zählungen (Detektor-Daten), je Tageszeit — keine live Anpassung während der Fahrt' },
  ];
  const polByKey = (k) => POLICY_META.find((p) => p.key === k) || POLICY_META[0];

  /* ===========================================================================
   * 2) STATE
   * ======================================================================== */
  const state = {
    baseConfig: clone(DEFAULT_CONFIG),
    result: null,
    summaries: {},          // policy key -> summary  (fixed, adaptive, …)
    framesBy: {},           // policy key -> frames[]
    plans: {},              // policy key -> plan info (fixed/coordinated/tuned)
    decisions: [],
    availablePolicies: ['fixed', 'adaptive'],
    frameDt: 4,
    duration: 1800,         // seconds
    metaGenerated: '',
    // playback: which strategies are shown (subset of availablePolicies)
    visible: { fixed: true, adaptive: true, coordinated: true, tuned: true },
    decTab: 'adaptive',
    chartMetric: 'delay',     // delay | throughput | maxq | co2 | wasted
    chartMode: 'abs',         // 'abs' (Verlauf) | 'cum' (kumuliert)
    zoom: null,               // {from, to} minutes-of-day, null = whole window
    playing: false,
    speed: 1,
    baseSpeed: 1,
    crossingBy: {},         // policy key -> vehicles currently driving through
    crossSpawnBy: {},       // policy key -> last sim-time a crossing vehicle spawned per movement
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
    cfg.demand_multiplier = +$('ctl-load').value;
    cfg.seed = +$('ctl-seed').value;
    // the wall-clock window IS the simulated span; the engine warms up before it
    cfg.time_from = ($('ctl-time-from').value || null);
    cfg.time_to = ($('ctl-time-to').value || null);
    cfg.warmup_min = 15;
    cfg.duration_min = spanMinutes(cfg.time_from, cfg.time_to) || 30;
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

  // window span in minutes (to before from crosses midnight)
  function spanMinutes(fromS, toS) {
    if (!fromS || !toS) return 0;
    const min = (s) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const a = min(fromS), b = min(toS);
    return ((b - a + 1440) % 1440) || 1440;
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
    clearDirty();
    setBusy(false);
    renderBadges();
  }

  function applyPayload(res, usedDemo) {
    state.result = res;
    state.summaries = res.summary || {};
    state.framesBy = {
      fixed: (res.fixed && res.fixed.frames) || [],
      adaptive: (res.adaptive && res.adaptive.frames) || [],
      coordinated: (res.coordinated && res.coordinated.frames) || [],
      tuned: (res.tuned && res.tuned.frames) || [],
    };
    state.plans = {
      fixed: (res.fixed && res.fixed.plan) || null,
      coordinated: (res.coordinated && res.coordinated.plan) || null,
      tuned: (res.tuned && res.tuned.plan) || null,
    };
    state.availablePolicies = POLICY_META
      .filter((p) => state.summaries[p.key] && state.framesBy[p.key].length)
      .map((p) => p.key);
    for (const p of POLICY_META) {
      if (state.availablePolicies.indexOf(p.key) < 0) state.visible[p.key] = false;
    }
    if (!POLICY_META.some((p) => state.visible[p.key])) state.visible.fixed = true;
    state.decisions = (res.adaptive && res.adaptive.decisions) || [];
    state.frameDt = (res.meta && res.meta.frame_dt) || state.frameDt || 4;
    state.duration = (res.meta && res.meta.steps) ||
      (res.config ? res.config.duration_min * 60 : 1800);
    state.junction = res.junction || null;
    state.metaGenerated = (res.meta && res.meta.generated) || (usedDemo ? 'offline demo' : '');
    state.selectedDecision = Math.max(0, state.decisions.length - 1);
    if (state.availablePolicies.indexOf(state.decTab) < 0) state.decTab = 'adaptive';
    // zoom follows the new window; series cache invalid
    state.zoom = null;
    state.seriesCache = {};
    const zf = $('zoom-from'), zt = $('zoom-to');
    if (zf && zt && res.meta && res.meta.time_from) {
      zf.value = res.meta.time_from;
      zt.value = res.meta.time_to || res.meta.time_from;
    }

    // reset playhead, start animating. Base speed scales with the window so a
    // full day plays back in a few minutes; the 0.5/1/2/4 buttons multiply it.
    state.t = 0;
    state.baseSpeed = clamp(Math.round(state.duration / 120), 10, 120);
    state.speed = state.baseSpeed;
    state.crossingBy = {};
    state.crossSpawnBy = {};
    setPlaying(true);
    updateSpeedReadout();

    buildKpiCards();
    buildKpiTable();
    renderKPIs();
    renderCharts();
    renderDecisions();
    syncPolicyButtons();
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
    const a = state.summaries.adaptive || {};
    const fx = state.summaries.fixed || {};
    const c = clockString(0);
    $('meta-info').textContent =
      `${state.metaGenerated || 'SignalFlow'} · ${timeStr(state.duration)}${c ? ' ab ' + c + ' Uhr' : ''} · ` +
      `Ø Verzögerung: Fixed ${fmt(fx.avg_delay_s, 1)}s → Adaptiv ${fmt(a.avg_delay_s, 1)}s` +
      (usedDemo ? ' · OFFLINE-DEMO' : '');
  }

  /* ===========================================================================
   * 6) KPI CARDS / TABLE  (one row per strategy)
   * ======================================================================== */
  // strategies available in the current result (roundabout swaps two of them)
  function activePolicies() {
    return POLICY_META.filter((p) => state.summaries[p.key]);
  }

  function buildKpiCards() {
    const grid = $('kpi-grid');
    grid.innerHTML = '';
    const pols = activePolicies();
    for (const m of KPI_META) {
      const card = document.createElement('article');
      card.className = 'kpi';
      const rows = pols.map((p) => `
          <div class="row pol-${p.key}"><span class="tag" title="${p.info}">${p.label}</span>` +
        (p.key === 'fixed'
          ? '<i class="dlt"></i>'
          : `<i class="dlt" data-kpi="${m.key}-${p.key}-delta" title="Δ gegenüber Fixed — positiv = besser">–</i>`) +
        `<b data-kpi="${m.key}-${p.key}">–</b></div>`).join('');
      card.innerHTML = `
        <header><h3 title="${m.info}">${m.title}</h3><span class="unit">${m.unit}</span></header>
        <div class="kpi-rows">${rows}</div>`;
      grid.appendChild(card);
    }
  }

  // Compact matrix alternative to the cards: policies as rows, metrics as
  // columns, Δ vs Fixed next to each value. Both views share the data-kpi
  // hooks, so renderKPIs updates whichever is visible.
  function buildKpiTable() {
    const wrap = $('kpi-table-wrap');
    if (!wrap) return;
    const pols = activePolicies();
    const head = KPI_META.map((m) =>
      `<th colspan="2" title="${m.info}">${m.title}${m.unit ? ' <span class="unit">' + m.unit + '</span>' : ''}</th>`).join('');
    const subHeads = KPI_META.map(() => '<th class="sub">Wert</th><th class="sub">Δ</th>').join('');
    const bodyRows = pols.map((p) => {
      const cells = KPI_META.map((m) => {
        const dlt = p.key === 'fixed'
          ? '<td class="dltc">–</td>'
          : `<td class="dltc"><i class="dlt" data-kpi="${m.key}-${p.key}-delta" title="Δ gegenüber Fixed — positiv = besser">–</i></td>`;
        return `<td class="v pol-v" data-kpi="${m.key}-${p.key}">–</td>${dlt}`;
      }).join('');
      return `<tr class="pol-${p.key}"><th class="pol" title="${p.info}">${p.label}</th>${cells}</tr>`;
    }).join('');
    wrap.innerHTML = `<table class="kpi-table">
      <thead><tr><th rowspan="2"></th>${head}</tr><tr>${subHeads}</tr></thead>
      <tbody>${bodyRows}</tbody>
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
    const pols = activePolicies();
    if (!pols.length) return;
    const all = (name) => document.querySelectorAll('[data-kpi="' + name + '"]');
    for (const m of KPI_META) {
      const vals = pols.map((p) => ({ p, v: m.get(state.summaries[p.key]) }));
      for (const { p, v } of vals) {
        all(m.key + '-' + p.key).forEach((el) => { el.textContent = fmt(v, m.dec); });
      }

      // winner per metric across all strategies (direction-aware, ties bold all)
      const best = vals.reduce((b, x) =>
        m.dir === 'up' ? (x.v > b.v ? x : b) : (x.v < b.v ? x : b), vals[0]);
      for (const { p, v } of vals) {
        all(m.key + '-' + p.key).forEach((el) => el.classList.toggle('best', v === best.v));
      }

      // Δ vs Fixed (signed: > 0 always means "better than Fixed")
      const fv = (vals.find((x) => x.p.key === 'fixed') || {}).v;
      for (const { p, v } of vals) {
        if (p.key === 'fixed') continue;
        all(m.key + '-' + p.key + '-delta').forEach((dEl) => {
          if (!fv) { dEl.textContent = 'n/a'; return; }
          const pct = m.dir === 'up' ? (v - fv) / fv * 100 : (fv - v) / fv * 100;
          dEl.textContent = (pct >= 0 ? '+' : '−') + fmt(Math.abs(pct), 1) + ' %';
          dEl.title = pct >= 0
            ? 'Verbesserung gegenüber Fixed'
            : 'Verschlechterung gegenüber Fixed';
        });
      }
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

  function drawIntersection(canvas, frames, pkey) {
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
    const crossing = state.crossingBy[pkey] || (state.crossingBy[pkey] = []);
    const crossSpawn = state.crossSpawnBy[pkey] || (state.crossSpawnBy[pkey] = {});
    if (state.playing && frame.green) {
      for (const key of frame.green) {
        if (REDUCED) break;
        if (!moveOk(key.split('-')[0], key.split('-')[1])) continue;
        if ((frame.t - (crossSpawn[key] || -999)) >= state.frameDt && crossing.length < 80) {
          crossSpawn[key] = frame.t;
          const parts = key.split('-');
          crossing.push({ a: parts[0], turn: parts[1], p: 0,
                          kind: vehicleKind(key, Math.round(frame.t * 3)) });
        }
      }
    }
    for (const c of crossing) drawCrossing(ctx, g, c, bands);

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
    void pkey;
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

  function visiblePolicies() {
    return POLICY_META.filter((p) => state.visible[p.key] &&
      state.framesBy[p.key] && state.framesBy[p.key].length);
  }

  // wall-clock string for sim second t (null when no window is configured)
  function clockString(t) {
    const res = state.result;
    const from = res && ((res.meta && res.meta.time_from) ||
                         (res.scenario && res.scenario.time_from));
    if (!from) return null;
    const min = (s) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const total = (min(from) + Math.floor(t / 60)) % 1440;
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' +
      String(total % 60).padStart(2, '0');
  }

  function drawActiveCanvases() {
    const wrap = $('canvas-wrap');
    const vis = visiblePolicies();
    wrap.dataset.n = String(vis.length);
    for (const p of POLICY_META) {
      const cell = $('cell-' + p.key);
      if (cell) cell.hidden = state.visible[p.key] !== true ||
        !state.framesBy[p.key] || !state.framesBy[p.key].length;
    }
    for (const p of vis) {
      drawIntersection($('canvas-' + p.key), state.framesBy[p.key], p.key);
    }
    // readouts: clock, phase of the first visible strategy, Σ queues of all visible
    const clockEl = $('playhead-clock');
    if (clockEl) {
      const c = clockString(state.t);
      clockEl.textContent = c ? c + ' Uhr' : '–';
    }
    if (vis.length) {
      const f0 = state.framesBy[vis[0].key];
      const f = f0[frameIndex(f0)];
      $('playhead-phase').textContent = PHASE_LABEL[f.phase] || f.phase || '–';
      const qel = $('playhead-queue');
      if (qel) {
        let tot = 0;
        for (const p of vis) {
          const fr = state.framesBy[p.key];
          const ff = fr[frameIndex(fr)];
          for (const k in (ff.q || {})) tot += ff.q[k] || 0;
        }
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

  function chartPolicies() {
    return POLICY_META.filter((p) => state.summaries[p.key]);
  }

  function drawBars(canvas) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const pols = chartPolicies();
    if (!pols.length) { centerText(ctx, w, h, 'Keine Daten'); return; }

    const padL = 46, padR = 14, padT = 26, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const n = BAR_METRICS.length;
    const groupW = plotW / n;
    const barW = Math.max(8, Math.min(26, groupW * 0.62 / pols.length));

    // grid
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      line(ctx, padL, y, padL + plotW, y);
    }

    BAR_METRICS.forEach((m, i) => {
      const vals = pols.map((p) => ({ p, v: m.get(state.summaries[p.key]) || 0 }));
      const max = Math.max.apply(null, vals.map((x) => x.v)) * 1.18 || 1;
      const center = padL + i * groupW + groupW / 2;
      const groupWpx = vals.length * (barW + 4) - 4;

      vals.forEach(({ p, v }, k) => {
        const bh = plotH * (v / max);
        const bx = center - groupWpx / 2 + k * (barW + 4);
        ctx.fillStyle = p.color;
        rr(ctx, bx, padT + plotH - bh, barW, bh, 3); ctx.fill();
        // value labels only when they fit
        if (barW >= 14) {
          ctx.fillStyle = '#cbd5e1'; ctx.font = '9.5px ' + FONT;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(v, m.dec), bx + barW / 2, padT + plotH - bh - 2);
        }
      });

      // category label
      ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT; ctx.textBaseline = 'top';
      ctx.fillText(m.title + (m.unit ? ' (' + m.unit + ')' : ''), center, padT + plotH + 9);
    });

    // baseline
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, padT + plotH, padL + plotW, padT + plotH);

    // legend (dynamic, left to right)
    let lx = padL;
    for (const p of pols) {
      legendSwatch(ctx, lx, 10, p.color, p.label);
      lx += 26 + ctx.measureText(p.label).width + 22;
    }
  }

  function legendSwatch(ctx, x, y, color, label) {
    ctx.fillStyle = color; rr(ctx, x, y, 10, 10, 3); ctx.fill();
    ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 15, y + 5);
  }

  // Verlauf-Panel: alle fünf KPIs, je einmal als Momentanwert (Verlauf) und
  // einmal kumuliert — x-Achse Uhrzeit, Flächen je Strategie, von–bis-Zoom.
  const CHART_METRICS = {
    delay: {
      title: 'Verzögerung',
      abs: { note: 'wartende Fahrzeuge (Rate, veh)', dec: 1, get: (p) => p.qTot },
      cum: { note: 'kumuliert · veh·s', dec: 0, get: (p) => p.delayCum },
    },
    throughput: {
      title: 'Durchsatz',
      abs: { note: 'Fahrzeuge/h (momentan)', dec: 0, get: (p) => p.servedInst },
      cum: { note: 'Fahrzeuge/h (Ø bis t)', dec: 0, get: (p) => p.thruCum },
    },
    maxq: {
      title: 'max. Queue',
      abs: { note: 'längste Warteschlange (veh)', dec: 1, get: (p) => p.qMax },
      cum: { note: 'Rekord bis t (veh)', dec: 1, get: (p) => p.maxRun },
    },
    co2: {
      title: 'CO₂-Proxy',
      abs: { note: 'Leerlauf-Ausstoß je Frame (g)', dec: 1, get: (p) => p.co2Abs },
      cum: { note: 'kumuliert · g', dec: 0, get: (p) => p.co2Cum },
    },
    wasted: {
      title: 'Leerlauf-Grün',
      abs: { note: 'verschwendetes Grün je Frame (s)', dec: 0, get: (p) => p.wastedAbs },
      cum: { note: 'kumuliert · s', dec: 0, get: (p) => p.wastedCum },
    },
  };

  // derived per-frame series per policy (cached until the next payload)
  function policySeries(pol) {
    state.seriesCache = state.seriesCache || {};
    if (state.seriesCache[pol]) return state.seriesCache[pol];
    const k = (state.result && state.result.config &&
               state.result.config.co2_idle_g_per_s) || 1.15;
    const fr = state.framesBy[pol] || [];
    let servedSum = 0, wastedSum = 0, maxRun = 0;
    const pts = fr.map((f) => {
      const qs = f.q || {};
      let qTot = 0, qMax = 0;
      for (const key in qs) { qTot += qs[key] || 0; if ((qs[key] || 0) > qMax) qMax = qs[key]; }
      const served = f.served || 0;
      servedSum += served;
      const elapsedH = ((f.t || 0) + state.frameDt) / 3600;
      let wastedAbs = 0;
      if (f.green && f.green.length && f.green.every((mv) => (qs[mv] || 0) < 0.5)) {
        wastedAbs = state.frameDt;
      }
      wastedSum += wastedAbs;
      if (qMax > maxRun) maxRun = qMax;
      return {
        m: clockMinAt(f.t || 0),
        qTot, qMax,
        servedInst: served / Math.max(1, state.frameDt) * 3600,
        thruCum: servedSum / Math.max(1e-9, elapsedH),
        delayCum: f.delay_s || 0,
        co2Abs: qTot * k, co2Cum: (f.delay_s || 0) * k,
        wastedAbs, wastedCum: wastedSum,
        maxRun,
      };
    });
    state.seriesCache[pol] = pts;
    return pts;
  }

  // minutes-of-day for sim second t (null when no window is configured)
  function clockMinAt(t) {
    const res = state.result;
    const from = res && ((res.meta && res.meta.time_from) ||
                         (res.scenario && res.scenario.time_from));
    if (!from) return null;
    const p = from.split(':').map(Number);
    return ((p[0] || 0) * 60 + (p[1] || 0) + Math.floor(t / 60)) % 1440;
  }

  function minToLabel(min, withUhr) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' +
      String(m % 60).padStart(2, '0') + (withUhr ? ' Uhr' : '');
  }

  function drawDelayChart() {
    const canvas = $('chart-delay');
    if (!canvas) return;
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const pols = chartPolicies().filter((p) => (state.framesBy[p.key] || []).length);
    if (!pols.length) { centerText(ctx, w, h, 'Keine Daten'); return; }
    const met = CHART_METRICS[state.chartMetric] || CHART_METRICS.delay;
    const view = state.chartMode === 'cum' ? met.cum : met.abs;

    const padL = 52, padR = 14, padT = 26, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    // x-domain: sim seconds mapped to minutes-of-day; zoom narrows both
    const z0 = state.zoom ? state.zoom.from : 0;
    const z1 = state.zoom ? state.zoom.to : 1440;
    const x0m = state.zoom ? z0 : (clockMinAt(0) || 0);
    const x1m = state.zoom ? z1 : ((clockMinAt(state.duration) != null
      ? clockMinAt(state.duration) : 1440) || 1440);
    if (x1m <= x0m) { centerText(ctx, w, h, 'Zoom-Bereich leer'); return; }

    // series (lightly smoothed; signal cycles add sawtooth noise)
    const W = (state.chartMetric === 'wasted' && state.chartMode === 'abs') ? 1 : 3;
    const series = pols.map((p) => {
      const raw = policySeries(p.key);
      const pts = [];
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        if (r.m == null || r.m < z0 || r.m > z1) continue;
        let sum = 0, n = 0;
        for (let k = Math.max(0, i - W + 1); k <= Math.min(raw.length - 1, i + W - 1); k++) {
          sum += view.get(raw[k]); n++;
        }
        pts.push({ m: r.m, v: sum / n });
      }
      return { p, pts };
    });

    let yMax = 1;
    for (const s of series) for (const pt of s.pts) yMax = Math.max(yMax, pt.v);
    yMax *= 1.1;

    // grid + y labels
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.fillStyle = COL.txt; ctx.font = '10px ' + FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      line(ctx, padL, y, padL + plotW, y);
      ctx.fillText(fmt(yMax * (1 - i / 4), view.dec), padL - 7, y);
    }
    // x labels (clock within the zoom window)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      ctx.fillText(minToLabel(x0m + (x1m - x0m) * i / 4, i === 4),
        padL + plotW * i / 4, padT + plotH + 8);
    }

    const X = (m) => padL + plotW * ((m - x0m) / (x1m - x0m));
    const Y = (v) => padT + plotH * (1 - clamp(v / yMax, 0, 1));

    // translucent area + line per strategy
    for (const s of series) {
      if (s.pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(X(s.pts[0].m), Y(0));
      for (const pt of s.pts) ctx.lineTo(X(pt.m), Y(pt.v));
      ctx.lineTo(X(s.pts[s.pts.length - 1].m), Y(0));
      ctx.closePath();
      ctx.globalAlpha = 0.14; ctx.fillStyle = s.p.color; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.p.color; ctx.lineWidth = 2;
      ctx.beginPath();
      s.pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(X(pt.m), Y(pt.v)); else ctx.lineTo(X(pt.m), Y(pt.v)); });
      ctx.stroke();
    }

    // axes
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, padT + plotH, padL + plotW, padT + plotH);
    line(ctx, padL, padT, padL, padT + plotH);

    // playhead
    const ph = clockMinAt(state.t);
    if (ph != null && ph >= z0 && ph <= z1) {
      const px = X(ph);
      ctx.strokeStyle = 'rgba(230,237,243,.35)';
      ctx.setLineDash([4, 4]);
      line(ctx, px, padT, px, padT + plotH);
      ctx.setLineDash([]);
    }

    // legend + axis note
    let lx = padL;
    for (const s of series) {
      legendSwatch(ctx, lx, 10, s.p.color, s.p.label);
      lx += 26 + ctx.measureText(s.p.label).width + 22;
    }
    ctx.fillStyle = COL.txt; ctx.font = '10px ' + FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(view.note, w - padR, 10);
  }

  /* ===========================================================================
   * 9) DECISIONS PANEL ("Warum?") — adaptive switch log + plan cards
   * ======================================================================== */
  function renderDecisions() {
    renderDecView();
  }

  function renderDecView() {
    const pol = state.decTab;
    const adaptiveBox = $('dec-adaptive');
    const planBox = $('dec-plan');
    if (!adaptiveBox || !planBox) return;
    const isAdaptive = pol === 'adaptive' || !state.summaries[pol];
    adaptiveBox.hidden = !isAdaptive;
    planBox.hidden = isAdaptive;
    if (isAdaptive) {
      renderDecisionList();
      renderAdaptiveStats();
    } else {
      renderPlanCard(pol, planBox);
    }
  }

  // right column beneath the pressure table: what the log says in aggregate
  function renderAdaptiveStats() {
    const box = $('adaptive-stats');
    if (!box) return;
    const decs = state.decisions || [];
    if (!decs.length) { box.innerHTML = ''; return; }
    box.title = 'Statistik über die protokollierten Wechsel (max. die ersten 200 des Laufs)';
    const targets = {};
    let earlyExit = 0;
    for (const d of decs) {
      const to = d.to || '–';
      targets[to] = (targets[to] || 0) + 1;
      if ((d.reason || '').indexOf('served out') >= 0) earlyExit++;
    }
    const top = Object.keys(targets).sort((a, b) => targets[b] - targets[a])[0];
    const span = state.duration / 3600;
    const rows = [
      ['Phasenwechsel', fmt(decs.length, 0) + (span >= 1
        ? ' · ' + fmt(decs.length / span, 1) + '/h' : '')],
      ['Häufigstes Ziel', (PHASE_LABEL[top] || top) + ' (' + fmt(targets[top], 0) + '×)'],
      ['Früh beendet (leere Phase)', fmt(earlyExit, 0) + '×'],
      ['Ø Wartezeit beim Wechsel', (() => {
          const waits = decs.map((d) => {
            const m = /worst wait (\d+)/.exec(d.reason || '');
            return m ? Number(m[1]) : null;
          }).filter((v) => v != null);
          return waits.length
            ? fmt(waits.reduce((s, v) => s + v, 0) / waits.length, 0) + ' s' : '–';
        })()],
    ];
    box.innerHTML = '<h3>Log in Zahlen</h3><table class="stats-table">' +
      rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') +
      '</table>';
  }

  function renderDecisionList() {
    const list = $('decisions-list');
    list.innerHTML = '';
    const decs = state.decisions || [];
    if (!decs.length) {
      const unsig = state.junction && state.junction.signalized === false;
      list.innerHTML = unsig
        ? '<li class="empty">Kreisverkehr: keine Ampel — Einfahrten sind yield-regelt.</li>'
        : '<li class="empty">Keine Phasenwechsel protokolliert.</li>';
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
        `<div class="head"><span class="t">${clockString(d.t) || timeStr(d.t)}</span>` +
        `<span class="swap">${d.from || '–'}<span class="arrow">→</span>${d.to || '–'}</span></div>` +
        `<div class="why">${escapeHtml(d.reason || '')}</div>`;
      li.addEventListener('click', () => {
        state.selectedDecision = i;
        renderDecisionList();
      });
      list.appendChild(li);
    }
    renderPressureTable(decs[state.selectedDecision]);
  }

  // plan card for fixed / coordinated / tuned (from the engine's plan info)
  function renderPlanCard(pol, box) {
    const plan = state.plans[pol];
    const phases = (state.result && state.result.phases) || [];
    if (!plan) {
      box.innerHTML = '<p class="empty">Keine Planinformationen für diese Strategie.</p>';
      return;
    }
    let html = '';
    if (pol === 'coordinated' && plan.main_axis) {
      html += `<p class="plan-line"><b>Korridor-Takt</b> ${plan.cycle_s}s` +
        (plan.target_cycle_s ? ` (Ziel ${plan.target_cycle_s}s)` : '') +
        ` · Offset ${plan.offset_s}s · Hauptachse <b>${plan.main_axis}</b>` +
        ` · Bias ×${plan.bias}</p>`;
    }
    if (plan.buckets) {
      html += '<table class="plan-table"><thead><tr><th>Tageszeit</th><th>Zyklus</th><th>Stoßphase</th><th>Grün je Phase</th></tr></thead><tbody>' +
        plan.buckets.map((b) => {
          const ratios = b.flow_ratios || [];
          const crit = ratios.length
            ? ratios.indexOf(Math.max.apply(null, ratios)) : -1;
          const critName = crit >= 0 && phases[crit] ? (PHASE_LABEL[phases[crit]] || phases[crit]) : '–';
          return `<tr><td>${String(b.from_h).padStart(2, '0')}:00–${String(b.to_h).padStart(2, '0')}:00</td>` +
            `<td>${b.cycle_s}s${b.y_total != null ? ' · Y=' + b.y_total : ''}</td>` +
            `<td>${critName}</td>` +
            `<td>${(b.greens || []).join(' / ')}s</td></tr>`;
        }).join('') +
        '</tbody></table>';
      html += '<p class="plan-why"><b>Warum so?</b> Aus den Stopp-Linien-Zählungen jeder ' +
        'Tageszeit wird die stärkste Stunde (Spitzenstunde) bestimmt. Daraus folgt je Phase ' +
        'das Flussverhältnis y = Nachfrage / Kapazität; der Webster-Zyklus ' +
        'C = (1,5·L + 5)/(1 − Y) und die Grünverteilung ∝ y ergeben sich direkt daraus — ' +
        'die Stoßphase bekommt automatisch den größten Grünanteil. Ein eigener Plan je ' +
        'Tageszeit, weil ein Plan, der zur Rush passt, um 14 Uhr nur verschwendetes Grün ' +
        'produziert (und umgekehrt).</p>';
    } else {
      html += '<table class="plan-table"><thead><tr><th>Phase</th><th>Grün</th></tr></thead><tbody>' +
        phases.map((ph, i) =>
          `<tr><td>${PHASE_LABEL[ph] || ph}</td><td>${(plan.greens || [])[i] != null ? (plan.greens || [])[i] + 's' : '–'}</td></tr>`).join('') +
        '</tbody></table>';
      html += `<p class="plan-line">Zyklus <b>${plan.cycle_s}s</b>` +
        (plan.y_total != null ? ' · Flussverhältnis Y=' + plan.y_total : '') +
        (plan.offset_s != null && !plan.main_axis ? ' · Offset ' + plan.offset_s + 's' : '') +
        '</p>';
    }
    html += `<p class="plan-src">${escapeHtml(plan.source || '')}</p>`;
    box.innerHTML = html;
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
      const barW = val !== null ? Math.round(150 * clamp(val / maxP, 0, 1)) : 0;
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

  // Locally computed answers for suggested questions — honest numbers straight
  // from the frames on screen, no LLM round trip. Returns null → API request.
  function computeLocalAnswer(q) {
    const ql = q.toLowerCase();
    // Stoßzeit-Frage: vergleicht mittlere Warteschlangen in den Spitzenfenstern
    if (/stoßzeit|stosszeit|spitze|durchschnitt/.test(ql) && /tuned|adaptiv/.test(ql)) {
      const pols = ['fixed', 'adaptive', 'coordinated', 'tuned']
        .filter((k) => (state.framesBy[k] || []).length && state.summaries[k]);
      if (pols.length < 2 || clockMinAt(0) == null) return null;
      const rush = [[420, 540], [960, 1080]];           // 07:00–09:00, 16:00–18:00
      const w0 = clockMinAt(0) || 0;
      const w1 = clockMinAt(state.duration) != null ? clockMinAt(state.duration) : 1440;
      const active = rush.filter(([a, b]) => Math.max(a, w0) < Math.min(b, w1));
      if (!active.length) {
        return { answer: 'Das aktuelle Zeitfenster (' + minToLabel(w0) + '–' +
          minToLabel(w1) + ' Uhr) enthält keine Stoßzeitfenster. Wähle z. B. ' +
          'Berufsverkehr 07–18 Uhr, dann vergleiche ich die Spitzen.', source: 'Analyse · lokal' };
      }
      const isPeak = (m) => active.some(([a, b]) => m >= a && m < b);
      const avgQ = (pol, fn) => {
        let sum = 0, n = 0;
        for (const f of state.framesBy[pol]) {
          const m = clockMinAt(f.t || 0);
          if (m == null || !fn(m)) continue;
          sum += Object.keys(f.q || {}).reduce((s, k) => s + (f.q[k] || 0), 0);
          n++;
        }
        return n ? sum / n : 0;
      };
      const stats = {};
      for (const pol of pols) {
        stats[pol] = {
          peak: avgQ(pol, isPeak),
          off: avgQ(pol, (m) => !isPeak(m)),
          delay: (state.summaries[pol] || {}).avg_delay_s,
        };
      }
      const label = { fixed: 'Fixed', adaptive: 'Adaptiv', coordinated: 'Koord.', tuned: 'Tuned' };
      const fmtV = (v) => fmt(v, 1).replace(',0', '');
      const rushTxt = active.map(([a, b]) => minToLabel(a) + '–' + minToLabel(b)).join(' & ');
      const peakRank = pols.slice().sort((a, b) => stats[a].peak - stats[b].peak);
      const avgRank = pols.slice().sort((a, b) => stats[a].delay - stats[b].delay);
      const lines = [
        'Tagesdurchschnitt (Ø Verzögerung): ' +
          avgRank.map((k) => label[k] + ' ' + fmt(stats[k].delay, 1) + ' s').join(', ') +
          ' — vorn liegt ' + label[avgRank[0]] + '.',
        'Stoßzeitfenster (' + rushTxt + ' Uhr, mittlere Warteschlange): ' +
          peakRank.map((k) => label[k] + ' ' + fmtV(stats[k].peak) + ' veh').join(', ') +
          ' — vorn liegt ' + label[peakRank[0]] + '.',
        'Nebenzeiten (mittlere Warteschlange): ' +
          pols.map((k) => label[k] + ' ' + fmtV(stats[k].off) + ' veh').join(', ') + '.',
      ];
      if (peakRank[0] !== 'adaptive') {
        lines.push('Die These stimmt also für diesen Lauf: zur Spitze hält ' +
          label[peakRank[0]] + ' die kürzesten Schlangen (sein Webster-Plan ist auf die ' +
          'Spitzenstunde dimensioniert), im Tagesmittel gewinnt trotzdem ' +
          label[avgRank[0]] + ', weil max-pressure die Nebenzeiten besser bedient.');
      } else {
        lines.push('In diesem Lauf gewinnt Adaptiv sogar zur Spitze — hysteresefreies ' +
          'Umschalten zahlt sich hier stärker aus als der auf die Spitzenstunde ' +
          'getunte feste Plan.');
      }
      return { answer: lines.join('\n'), source: 'Analyse · lokal aus Frames berechnet' };
    }
    if (/grüne welle|gruenen welle|koord/.test(ql)) {
      return { answer:
        'Die grüne Welle (Koord.) ist ein Korridor-Plan: fester 90-s-Takt, Versatz-Offset, ' +
        'Grünanteile zugunsten der Hauptachse. An dieser einzelnen Kreuzung liegt sie deshalb ' +
        'nahe an Fixed — ihr Vorteil entsteht erst mit Nachbarn, weil Fahrzeuge in Pulks ' +
        'ankommen. Öffne die Netzwerk-Simulation: dort gewinnt Koord. auf dem Korridor deutlich.',
        source: 'Hintergrund · lokal' };
    }
    return null;
  }

  // Speak a concise summary of the current result (junction phrasing; the
  // network page injects its own). Fed to SFAsk for "Ergebnis vorlesen".
  function buildResultSentence() {
    const s = state.summaries || {};
    if (!s.fixed || !s.adaptive) return '';
    const parts = [
      'Fixed: ' + fmt(s.fixed.avg_delay_s, 1) + ' Sekunden Verzögerung je Fahrzeug.',
      'Adaptiv: ' + fmt(s.adaptive.avg_delay_s, 1) + ' Sekunden.',
    ];
    if (s.coordinated) parts.push('Koordiniert: ' + fmt(s.coordinated.avg_delay_s, 1) + ' Sekunden.');
    if (s.tuned) parts.push('Tuned: ' + fmt(s.tuned.avg_delay_s, 1) + ' Sekunden.');
    parts.push('Durchsatz adaptiv: ' + fmt(s.adaptive.throughput_vph, 0) + ' Fahrzeuge pro Stunde.');
    return 'SignalFlow. ' + parts.join(' ');
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
      // advance vehicles driving through the junction (per strategy)
      const rate = (dt * state.speed) / Math.max(1, state.frameDt * 0.9);
      for (const k in state.crossingBy) {
        const arr = state.crossingBy[k];
        if (!arr.length) continue;
        for (const c of arr) c.p += rate;
        state.crossingBy[k] = arr.filter((c) => c.p < 1);
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
    const load = $('ctl-load'), seed = $('ctl-seed');
    const source = document.getElementById('ctl-source');

    const sync = () => {
      $('val-load').textContent = Number(load.value).toFixed(2);
      $('val-seed').textContent = seed.value;
      [load, seed].forEach(setRangeFill);
    };
    [load, seed].forEach((el) => el.addEventListener('input', () => { sync(); markDirty(); }));
    sync();

    if (source) source.addEventListener('change', markDirty);
    const scen = document.getElementById('ctl-scenario');
    if (scen) scen.addEventListener('change', applyScenarioPreset);
    ['ctl-mix', 'ctl-tsp', 'ctl-junction'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', markDirty);
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

  // clock-based demand shapes (mirror of the Python CLOCK_PROFILES)
  function circG(h, mu, sig) {
    const d = Math.abs(h - mu);
    return Math.exp(-0.5 * Math.pow(Math.min(d, 24 - d) / sig, 2));
  }
  const DEMO_CLOCK_PROFILES = {
    commute: (h) => 0.05 + 0.57 * circG(h, 8, 0.85) + 0.50 * circG(h, 17.5, 0.95),
    peak: (h) => 0.10 + 0.28 * circG(h, 8, 1.4) + 0.48 * circG(h, 13.2, 2.8) + 0.33 * circG(h, 17.6, 1.5),
    leisure: (h) => 0.08 + 0.70 * circG(h, 14.2, 2.3),
    flat: (h) => 0.55 + 0.25 * circG(h, 13.5, 4.5),
  };
  const SCENARIO_PROFILE = { normal: 'peak', berufsverkehr: 'commute', ferien: 'flat', freizeit: 'leisure' };

  function runDemo(cfg) {
    const steps = Math.max(60, (cfg.duration_min || 30) * 60);
    const sampleDt = 4;
    const lanes = cfg.lanes || { T: 2, L: 1, R: 1 };
    const svc = {};
    for (const m of MOVE_KEYS) { const turn = m.split('-')[1]; svc[m] = (lanes[turn] || 1) * 1800 / 3600; }

    const fromS = cfg.time_from || null;
    const profName = SCENARIO_PROFILE[cfg.demand_scenario] || 'peak';
    const fromMin = fromS ? fromS.split(':').reduce((a, x) => a * 60 + Number(x), 0) : 0;

    const rng = mulberry32(cfg.seed || 1);
    const arrivals = [];
    for (let t = 0; t < steps; t++) {
      const mult = fromS
        ? DEMO_CLOCK_PROFILES[profName](((fromMin + t) % 1440) / 60)
        : 0.6 + 1.0 * Math.sin(Math.PI * t / (steps - 1));
      const row = {};
      for (const a of APPROACHES) for (const mv of TURNS) {
        const rate = ((cfg.demand[a] || {})[mv] || 0) * (cfg.demand_multiplier || 1) * mult;
        row[a + '-' + mv] = poisson(rng, rate / 3600);
      }
      arrivals.push(row);
    }

    function planFor(greens) {
      const plan = [];
      PHASE_ORDER.forEach((ph, i) => {
        plan.push({ phase: ph, kind: 'green', dur: greens[i] || 20 });
        plan.push({ phase: ph, kind: 'yellow', dur: 3 });
        plan.push({ phase: ph, kind: 'all_red', dur: 1 });
      });
      return plan;
    }
    function policyPlan(plan) {
      let pos = 0, remaining = plan[0].dur;
      return function (t) {
        const cur = plan[pos];
        const dec = { phase: cur.phase, kind: cur.kind, green: cur.kind === 'green' ? PHASE_MOVES[cur.phase] : [] };
        remaining--;
        if (remaining <= 0) { pos = (pos + 1) % plan.length; remaining = plan[pos].dur; }
        return dec;
      };
    }

    // ---- fixed-time plan ----
    const fixedGreens = cfg.fixed_greens || [36, 10, 32, 8];

    // ---- coordinated: 90 s corridor cycle, bias toward the busier axis ----
    const demOf = (m) => ((cfg.demand[m.split('-')[0]] || {})[m.split('-')[1]]) || 0;
    const axisOf = (ph) => (PHASE_MOVES[ph][0][0] === 'N' || PHASE_MOVES[ph][0][0] === 'S') ? 'NS' : 'EW';
    const axisSum = (ax) => PHASE_ORDER.reduce((s2, ph) =>
      axisOf(ph) === ax ? s2 + PHASE_MOVES[ph].reduce((s3, m) => s3 + demOf(m), 0) : s2, 0);
    const mainAxis = axisSum('NS') >= axisSum('EW') ? 'NS' : 'EW';
    const coordLost = PHASE_ORDER.length * 4;
    const coordAvail = Math.max(PHASE_ORDER.length * 7, 90 - coordLost);
    const coordDem = PHASE_ORDER.map((ph) =>
      PHASE_MOVES[ph].reduce((s2, m) => s2 + demOf(m), 0) *
      (axisOf(ph) === mainAxis ? 1.25 : 0.8));
    const coordTot = coordDem.reduce((a2, b2) => a2 + b2, 0) || 1;
    const coordGreens = PHASE_ORDER.map((_, i) =>
      Math.max(7, Math.round(coordAvail * coordDem[i] / coordTot)));

    // ---- tuned: Webster splits from the demand counts (demo shortcut) ----
    const crit = PHASE_ORDER.map((ph) => Math.max.apply(null, PHASE_MOVES[ph].map(
      (m) => demOf(m) / Math.max(1, lanes[m.split('-')[1]] || 1)))) / 1800;
    const Y = crit.reduce((a2, b2) => a2 + b2, 0);
    const tunedLost = PHASE_ORDER.length * 4;
    const tunedCycle = Y > 0.01
      ? Math.round(Math.min(150, Math.max(40, (1.5 * tunedLost + 5) / (1 - Math.min(0.95, Y)))))
      : 60;
    const tunedAvail = Math.max(PHASE_ORDER.length * 6, tunedCycle - tunedLost);
    const critTot = crit.reduce((a2, b2) => a2 + b2, 0) || 1;
    const tunedGreens = PHASE_ORDER.map((_, i) =>
      Math.max(6, Math.round(tunedAvail * crit[i] / critTot)));

    const fixedPlan = planFor(fixedGreens);
    const coordPlan = planFor(coordGreens);
    const tunedPlan = planFor(tunedGreens);

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

    const f = runOne(policyPlan(fixedPlan));
    const a = runOne(policyAdaptive());
    const co = runOne(policyPlan(coordPlan));
    const tu = runOne(policyPlan(tunedPlan));
    const fs = f.summary, as = a.summary;
    const red = (b, n) => b ? Math.round((b - n) / b * 1000) / 10 : 0;
    return {
      config: cfg, phases: PHASE_ORDER,
      summary: { fixed: fs, adaptive: as, coordinated: co.summary, tuned: tu.summary },
      improvement: {
        avg_delay_pct: red(fs.avg_delay_s, as.avg_delay_s),
        throughput_pct: fs.throughput_vph ? Math.round((as.throughput_vph - fs.throughput_vph) / fs.throughput_vph * 1000) / 10 : 0,
        max_queue_pct: red(fs.max_queue, as.max_queue),
        co2_pct: red(fs.co2_g, as.co2_g),
        wasted_green_pct: red(fs.wasted_green_s, as.wasted_green_s),
      },
      fixed: { frames: f.frames, plan: { cycle_s: fixedGreens.reduce((x, y) => x + y, 0) + 16,
                                          greens: fixedGreens, source: 'fester Tagesplan (Offline-Demo)' } },
      adaptive: { frames: a.frames, decisions: a.decisions.slice(0, 200) },
      coordinated: { frames: co.frames, plan: { cycle_s: coordGreens.reduce((x, y) => x + y, 0) + coordLost,
                                                target_cycle_s: 90, offset_s: 12, main_axis: mainAxis,
                                                bias: 1.25, greens: coordGreens,
                                                source: 'Korridor-Takt 90s (Offline-Demo)' } },
      tuned: { frames: tu.frames, plan: { cycle_s: tunedGreens.reduce((x, y) => x + y, 0) + tunedLost,
                                          greens: tunedGreens, y_total: Math.round(Y * 1000) / 1000,
                                          source: 'Webster-Splits aus Zählungen (Offline-Demo)' } },
      meta: { steps, frame_dt: sampleDt, generated: 'SignalFlow demo (offline)',
              time_from: cfg.time_from, time_to: cfg.time_to, warmup_min: 0,
              clock: !!fromS },
    };
  }

  /* ===========================================================================
   * 15) EVENT WIRING + INIT
   * ======================================================================== */
  // reflect visibility/availability on the strategy toggle buttons
  function syncPolicyButtons() {
    document.querySelectorAll('.policy-modes .pol-btn').forEach((b) => {
      const pol = b.dataset.pol;
      if (pol === 'all') {
        b.classList.toggle('active',
          state.availablePolicies.length > 0 &&
          state.availablePolicies.every((k) => state.visible[k]));
        return;
      }
      const avail = state.availablePolicies.indexOf(pol) >= 0;
      b.disabled = !avail;
      b.classList.toggle('active', avail && !!state.visible[pol]);
      b.title = avail ? b.title : 'Für den Kreisverkehr-Vergleich nicht vorhanden';
    });
  }
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

  // Szenario ⇒ typisches Zeitfenster (Typntag). Das Fenster bleibt frei
  // anpassbar; die Nachfrage folgt dann der echten Uhrzeit im Fenster.
  const SCENARIO_WINDOWS = {
    normal:        { dow: 'wd', from: '06:00', to: '22:00', holiday: false },
    berufsverkehr: { dow: 'wd', from: '07:00', to: '18:00', holiday: false },
    ferien:        { dow: 'wd', from: '09:00', to: '19:00', holiday: true },
    freizeit:      { dow: 'sa', from: '09:00', to: '21:00', holiday: false },
  };

  /* --- dirty tracking: Änderungen starten NICHT automatisch — der
     Simulieren-Button tut es. Nur der erste Seitenaufruf läuft von selbst. --- */
  function markDirty() {
    const hint = $('run-hint');
    if (hint) { hint.textContent = 'Parameter geändert – „Simulieren“ drücken'; hint.classList.remove('hidden'); }
    const btn = $('btn-simulate');
    if (btn) btn.classList.add('dirty');
  }
  function clearDirty() {
    const hint = $('run-hint');
    if (hint) { hint.textContent = ''; hint.classList.add('hidden'); }
    const btn = $('btn-simulate');
    if (btn) btn.classList.remove('dirty');
  }

  function applyScenarioPreset() {
    presetWindow();
    updateTimeHint();
    markDirty();
  }

  // set the window inputs from the scenario without triggering a run
  function presetWindow() {
    const sel = $('ctl-scenario');
    const w = SCENARIO_WINDOWS[sel ? sel.value : 'normal'] || SCENARIO_WINDOWS.normal;
    if ($('ctl-dow')) $('ctl-dow').value = w.dow;
    if ($('ctl-time-from')) $('ctl-time-from').value = w.from;
    if ($('ctl-time-to')) $('ctl-time-to').value = w.to;
    if ($('ctl-holiday')) $('ctl-holiday').checked = w.holiday;
  }

  function updateTimeHint() {
    const fromS = ($('ctl-time-from') && $('ctl-time-from').value) || '07:00';
    const toS = ($('ctl-time-to') && $('ctl-time-to').value) || '18:00';
    const span = spanMinutes(fromS, toS);
    const dow = ($('ctl-dow') && $('ctl-dow').value) || 'wd';
    const holiday = $('ctl-holiday') && $('ctl-holiday').checked;
    const hint = $('time-hint');
    if (hint) {
      const dowl = { wd: 'Mo–Fr', sa: 'Sa', so: 'So' }[dow] || '';
      hint.textContent = dowl + ' ' + fromS + '–' + toS + ' = ' +
        (span >= 120 ? Math.round(span / 6) / 10 + ' h' : span + ' min') +
        ' Simulation · Nachfrage folgt der Uhrzeit' +
        (holiday ? ' · Ferien (−30 %)' : '');
    }
  }

  function initTimeWindow() {
    const ids = ['ctl-dow', 'ctl-time-from', 'ctl-time-to', 'ctl-holiday'];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { updateTimeHint(); markDirty(); });
    });
    presetWindow();           // Fenster passend zum Start-Szenario (kein Auto-Run)
    updateTimeHint();
  }

  function bindEvents() {
    initKpiView();
    initTheme();
    initTimeWindow();
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

    // strategy toggles: show/hide each controller's canvas, "Alle" = all on
    document.querySelectorAll('.policy-modes .pol-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const pol = b.dataset.pol;
        if (pol === 'all') {
          for (const p of POLICY_META) {
            if (state.availablePolicies.indexOf(p.key) >= 0) state.visible[p.key] = true;
          }
        } else {
          state.visible[pol] = !state.visible[pol];
          if (!POLICY_META.some((p) => state.visible[p.key])) state.visible[pol] = true;
        }
        syncPolicyButtons();
      });
    });

    // decision-log tabs (adaptive switch log vs. the other strategies' plans)
    document.querySelectorAll('.dec-tab').forEach((b) => {
      b.addEventListener('click', () => {
        state.decTab = b.dataset.dec;
        document.querySelectorAll('.dec-tab').forEach((x) =>
          x.classList.toggle('active', x === b));
        renderDecView();
      });
    });

    // time-series chart: metric chips + Verlauf/Kumuliert + von–bis zoom
    document.querySelectorAll('.chart-metrics .met-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.chartMetric = b.dataset.met;
        document.querySelectorAll('.chart-metrics .met-btn').forEach((x) =>
          x.classList.toggle('active', x === b));
        renderCharts();
      });
    });
    document.querySelectorAll('.chart-mode .cmode-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.chartMode = b.dataset.cmode;
        document.querySelectorAll('.chart-mode .cmode-btn').forEach((x) =>
          x.classList.toggle('active', x === b));
        renderCharts();
      });
    });
    const applyZoom = () => {
      const toMin = (s) => {
        if (!s) return null;
        const p = s.split(':').map(Number);
        return (p[0] || 0) * 60 + (p[1] || 0);
      };
      const a = toMin($('zoom-from') && $('zoom-from').value);
      const b2 = toMin($('zoom-to') && $('zoom-to').value);
      if (a == null || b2 == null || a === b2) state.zoom = null;
      else state.zoom = { from: a, to: b2 };
      renderCharts();
    };
    ['zoom-from', 'zoom-to'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', applyZoom);
    });
    const zr = $('zoom-reset');
    if (zr) zr.addEventListener('click', () => {
      state.zoom = null;
      const res = state.result;
      if (res && res.meta && res.meta.time_from) {
        if ($('zoom-from')) $('zoom-from').value = res.meta.time_from;
        if ($('zoom-to')) $('zoom-to').value = res.meta.time_to || res.meta.time_from;
      }
      renderCharts();
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
      computeAnswer: computeLocalAnswer,
      suggestions: [
        'Warum gewinnt Adaptiv im Durchschnitt, verliert aber zur Stoßzeit gegen Tuned?',
        'Wo sieht man die grüne Welle?',
        'Was passiert in den Ferien mit 15 % Lkw?',
      ],
    });
    if ($('btn-speak-result')) $('btn-speak-result').addEventListener('click', () => SFAsk.speakResult());

    // export the first visible intersection view as PNG
    if ($('btn-export')) $('btn-export').addEventListener('click', () => {
      const vis = visiblePolicies();
      const key = vis.length ? vis[0].key : 'fixed';
      exportCanvas('canvas-' + key, 'signalflow-kreuzung-' + key + '.png');
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
