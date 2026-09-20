/* ============================================================================
 * SignalFlow – Netzwerksimulation (vanilla JS, keine Abhängigkeiten)
 * ----------------------------------------------------------------------------
 * Angeglichen an das Einzelkreuzungs-Dashboard (web/app.js): dieselben
 * Strategie-Toggles, dieselbe KPI-Matrix (eine Zeile je Strategie, Δ-Semantik),
 * Balken- + Verlaufs-Chart mit Metrik-Chips und von–bis-Zoom, ein
 * "Warum?"-Protokoll je Strategie und der PDF-Bericht (web/report.js).
 *
 * Backend (gleiche Origin, relative Pfade):
 *   GET  /api/regions
 *   POST /api/simulate_network
 *
 * Robust: ist /api/regions leer oder schlägt simulate_network fehl, erscheint
 * eine klare Fehlermeldung – kein Crash, keine Konsolenfehler.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------- Helfer -------------------------------- */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(v, dec) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '–';
    return Number(v).toLocaleString('de-DE', {
      minimumFractionDigits: dec, maximumFractionDigits: dec,
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeStr(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function setRangeFill(el) {
    if (!el) return;
    const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
    const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', p + '%');
  }
  function show(el, on) { if (el) el.classList.toggle('hidden', !on); }

  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const COL = { grid: '#1a2632', axis: '#223040', txt: '#8b98a7', faint: '#63707e' };

  const REF_QUEUE = 12; // veh/Link, ab dem ein Link als "rot" gilt
  const CO2_IDLE_G_PER_S = 1.15;   // wie signalflow/network.py:CO2_IDLE_G_PER_S

  /* --------------------- Strategien & Kennzahlen-Meta -------------------- */
  // Farb- und Reihenfolge-konsistent zur Einzelkreuzung (web/app.js).
  // summaryKey: Feld in payload.summary, frames: nur diese sind animierbar —
  // Tuned existiert im Gebietsmodell nur als Kennzahl (keine Frames).
  const POLICY_META = [
    { key: 'fixed', summaryKey: 'fixed', label: 'Fixed', color: '#aab6c4',
      info: 'Fester Signalplan mit vordefinierten Grünzeiten — reagiert nicht auf den live Verkehr (Baseline)' },
    { key: 'adaptive', summaryKey: 'adaptive', label: 'Adaptiv', color: '#2dd4bf',
      info: 'SignalFlow: Grünanteile je Knoten folgen dem gemessenen Verkehr (Detektor-Proxy aus Link-Einläufen)' },
    { key: 'coordinated', summaryKey: 'coordinated', label: 'Koord.', color: '#f5c451',
      info: 'Grüne Welle: gemeinsamer Korridor-Takt + Versatz-Offsets; das übrige Netz bleibt adaptiv' },
    { key: 'tuned', summaryKey: 'fixed_tuned_est', label: 'Tuned', color: '#a78bfa',
      info: 'Fester Plan, getunt aus Detektor-Zählungen (OD-Schätzung) statt echter Nachfrage — fairere Baseline ohne Oracle-Wissen. Je nach Netz schlägt sie Adaptive (kurzmaschige Grids wie Berlin/Hamburg) oder verliert (z. B. Riem/Köln) — siehe docs/results.md. Animiert wird die Zähl-basierte Variante.' },
  ];

  const KPI_META = [
    { key: 'delay', title: 'Ø Verzögerung', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_delay_s; },
      info: 'Mittlere Verzögerung je Fahrzeug im ganzen Gebiet (Sekunden) — Wartezeit vor Rot plus Anfahrverluste. Weniger ist besser.' },
    { key: 'throughput', title: 'Durchsatz', unit: 'veh/h', dir: 'up', dec: 0, get: function (s) { return s.throughput_vph; },
      info: 'Fahrzeuge pro Stunde, die das Gebiet passieren. Mehr ist besser.' },
    { key: 'travel', title: 'Ø Reisezeit', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_travel_time_s; },
      info: 'Mittlere Gesamtreisezeit je Trip von Einfahrt bis Ausfahrt (Sekunden). Weniger ist besser.' },
    { key: 'co2', title: 'CO₂-Proxy', unit: 'g', dir: 'down', dec: 0, get: function (s) { return s.co2_g; },
      info: 'Geschätzter CO₂-Ausstoß aus Stand- und Verzögerungszeiten (Gramm) — aus Leerlauf-Zeiten hochgerechnet, keine Messung. Weniger ist besser.' },
    { key: 'served', title: 'Trips abgeschl.', unit: '', dir: 'up', dec: 0, get: function (s) { return s.served; },
      info: 'Im Simulationszeitraum abgeschlossene Fahrten. Mehr ist besser.' },
    { key: 'corridor', title: 'Korridor Ø-Verzög.', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.corridor_delay_s; },
      info: 'Verzögerung nur entlang des stärksten Korridors (Referenzstrecke der grünen Welle, Sekunden). Weniger ist besser.' },
  ];

  const BAR_METRICS = [
    { title: 'Ø Verzögerung', unit: 's', dec: 1, get: function (s) { return s.avg_delay_s; } },
    { title: 'Durchsatz', unit: 'veh/h', dec: 0, get: function (s) { return s.throughput_vph; } },
    { title: 'Ø Reisezeit', unit: 's', dec: 1, get: function (s) { return s.avg_travel_time_s; } },
    { title: 'CO₂', unit: 'g', dec: 0, get: function (s) { return s.co2_g; } },
    { title: 'Trips', unit: '', dec: 0, get: function (s) { return s.served; } },
  ];

  /* ------------------------------- State --------------------------------- */
  const state = {
    regions: [],
    regionMeta: null,        // {id,name,bbox,stats}
    result: null,
    summaries: {},           // summaryKey -> summary
    framesBy: {},            // policy key -> frames[]
    visible: { fixed: true, adaptive: true, coordinated: false, tuned: false },
    decTab: 'adaptive',
    chartMetric: 'delay',    // delay | throughput | maxq | co2 | corr
    chartMode: 'abs',        // 'abs' (Verlauf) | 'cum' (kumuliert)
    zoom: null,              // {from, to} Minuten des Tages, null = ganzes Fenster
    seriesCache: {},
    corridorIds: new Set(),
    bbox: null,
    nodeUV: new Map(),       // id -> {u,v} normiert auf bbox
    steps: 0,
    frameDt: 3,
    playing: false,
    speed: 1,
    t: 0,                    // Simulationssekunden
    busy: false,
    pending: false,
    dirty: false,
    autoSpeak: false,
    osm: false,              // OSM-Kachel-Unterlage (persistiert)
    osmOpacity: 0.7,         // Deckkraft der Kacheln (persistiert)
    _drawSig: null,          // Änderungs-Signal: Karte nur bei echten Updates neu zeichnen
    drill: null,
  };

  /* ---------------------------- Datenzugriff ----------------------------- */
  // The real local backend. If the page is opened from the app preview (a
  // different origin that cannot proxy our POST API and answers 415/405), we
  // transparently fall back to the backend directly (it sets CORS *).
  const BACKEND = 'http://127.0.0.1:8000';
  function apiUrl(url) {
    if (typeof url !== 'string' || /^https?:\/\//i.test(url)) return url;
    return url.charAt(0) === '/' ? url : '/' + url;   // 'api/x' -> '/api/x'
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

  async function fetchJSON(url, opts) {
    const r = await apiFetch(url, opts);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function showError(msg) { const el = $('net-error'); if (el) { el.textContent = msg; show(el, true); } }
  function hideError() { show($('net-error'), false); }

  function setBusy(on) {
    const bar = $('loading-bar');
    const btn = $('btn-run');
    if (btn) {
      btn.classList.toggle('busy', on);
      btn.disabled = on;
    }
    if (bar) {
      bar.classList.remove('hidden');
      bar.classList.toggle('running', on);
      bar.classList.toggle('done', !on);
      if (!on) setTimeout(function () { show(bar, false); bar.classList.remove('done', 'running'); }, 500);
    }
    ['ctl-region', 'ctl-load', 'ctl-scenario', 'ctl-mix', 'ctl-tsp', 'ctl-seed', 'ctl-vph',
     'ctl-dow', 'ctl-time-from', 'ctl-time-to']
      .forEach(function (id) { const el = $(id); if (el) el.disabled = on; });
  }

  function disableAll() {
    ['ctl-region', 'ctl-load', 'ctl-scenario', 'ctl-mix', 'ctl-tsp', 'ctl-seed', 'ctl-vph',
      'ctl-dow', 'ctl-time-from', 'ctl-time-to', 'btn-run', 'btn-play', 'progress'].forEach(function (id) {
      const el = $(id); if (el) el.disabled = true;
    });
  }

  /* ------------------------ Zeitfenster (Uhrzeit) ------------------------ */
  // Szenario ⇒ typisches Zeitfenster (wie auf der Einzelkreuzung); das Fenster
  // bleibt frei anpassbar. Nachfrage folgt der Uhrzeit, Spannen > ~2 h laufen
  // als Zeitraffer (der Server rechnet die KPIs auf die Wanduhr zurück).
  var SCENARIO_WINDOWS = {
    normal:        { dow: 'wd', from: '06:00', to: '22:00' },
    berufsverkehr: { dow: 'wd', from: '07:00', to: '18:00' },
    ferien:        { dow: 'wd', from: '09:00', to: '19:00' },
    freizeit:      { dow: 'sa', from: '09:00', to: '21:00' },
  };

  function spanMinutes(fromS, toS) {
    if (!fromS || !toS) return 0;
    const min = function (s) { const p = s.split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); };
    return ((min(toS) - min(fromS)) + 1440) % 1440 || 1440;
  }

  function applyScenarioPreset() {
    const sel = $('ctl-scenario');
    const w = SCENARIO_WINDOWS[sel ? sel.value : 'normal'] || SCENARIO_WINDOWS.normal;
    if ($('ctl-dow')) $('ctl-dow').value = w.dow;
    if ($('ctl-time-from')) $('ctl-time-from').value = w.from;
    if ($('ctl-time-to')) $('ctl-time-to').value = w.to;
    updateTimeHint();
  }

  function updateTimeHint() {
    const fromS = ($('ctl-time-from') && $('ctl-time-from').value) || '07:00';
    const toS = ($('ctl-time-to') && $('ctl-time-to').value) || '18:00';
    const span = spanMinutes(fromS, toS);
    const dow = ($('ctl-dow') && $('ctl-dow').value) || 'wd';
    const dowl = { wd: 'Mo–Fr', sa: 'Sa', so: 'So' }[dow] || '';
    const hint = $('time-hint');
    if (hint) {
      const h = span > 120 ? 'Tagesgang komprimiert · Mengen 1:1'
                           : span + ' min in Echtzeit';
      hint.textContent = dowl + ' ' + fromS + '–' + toS + ' · Nachfrage folgt der Uhrzeit · ' + h;
    }
  }

  // wall-clock string for sim second t (null when no window is configured)
  function clockString(t) {
    const m = clockMinAt(t);
    return m == null ? null : minToLabel(m);
  }

  // minutes-of-day for sim second t (null when no window is configured)
  function clockMinAt(t) {
    const res = state.result;
    const from = res && ((res.meta && res.meta.time_from) ||
                         (res.scenario && res.scenario.time_from));
    if (!from) return null;
    const rate = (res.meta && res.meta.clock_rate) || 1;
    const p = from.split(':').map(Number);
    return ((p[0] || 0) * 60 + (p[1] || 0) + Math.floor((t * rate) / 60)) % 1440;
  }

  function minToLabel(min, withUhr) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' +
      String(m % 60).padStart(2, '0') + (withUhr ? ' Uhr' : '');
  }

  /* --------------------------- Policies ---------------------------------- */
  // Strategien mit Kennzahlen im aktuellen Ergebnis (Tuned = fixed_tuned_est)
  function kpiPolicies() {
    return POLICY_META.filter(function (p) { return !!state.summaries[p.summaryKey]; });
  }
  // Strategien mit Animations-Frames
  function animatablePolicies() {
    return POLICY_META.filter(function (p) { return (state.framesBy[p.key] || []).length; });
  }
  // sichtbare animierbare Strategien — steuert Canvases UND beide Charts
  function visiblePolicies() {
    return animatablePolicies().filter(function (p) { return state.visible[p.key]; });
  }

  /* --------------------------- Regions laden ----------------------------- */
  function populateRegions(regions, selectId) {
    const sel = $('ctl-region');
    if (!sel) return;
    sel.innerHTML = '';
    regions.forEach(function (r) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name || r.id;
      sel.appendChild(o);
    });
    const pick = regions.find(function (r) { return r.id === selectId; });
    sel.value = (pick || regions[0]).id;
    state.regionMeta = pick || regions[0];
    const filter = $('region-filter');
    if (filter) filter.value = '';
    applyRegionFilter('');
  }

  // Filter für die Gebietsliste (die Liste wächst per „Ort hinzufügen”).
  // Mehrfach-Token-Match ("tü zent" trifft "Tübingen Zentrum"), Treffer-Zähler
  // als Hinweis — und kein Auto-Simulieren mehr: wird die Auswahl ausgefiltert,
  // springt die Auswahl auf den ersten Treffer und markiert nur "dirty".
  function applyRegionFilter(q) {
    const sel = $('ctl-region');
    if (!sel) return;
    const tokens = (q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    let visible = 0, firstVisible = null;
    const cur = sel.selectedOptions[0];
    [...sel.options].forEach(function (o) {
      const hay = (o.textContent + ' ' + o.value).toLowerCase();
      const match = !tokens.length || tokens.every(function (t) { return hay.indexOf(t) >= 0; });
      o.hidden = !match;
      if (match) { visible++; if (!firstVisible) firstVisible = o; }
    });
    const hint = $('region-filter-hint');
    if (hint) {
      hint.textContent = tokens.length
        ? visible + ' von ' + sel.options.length + ' Gebieten'
        : '';
    }
    if (visible && cur && cur.hidden && firstVisible) {
      sel.value = firstVisible.value;
      state.regionMeta = state.regions.find(function (r) { return r.id === sel.value; })
        || { id: sel.value };
      renderStats();
      markDirty();
    }
  }

  // ---- "Ort hinzufügen": geocode + OSM fetch + build, live ---------------
  async function addRegionFromInput() {
    const inp = $('add-place'), st = $('add-status'), btn = $('btn-add-region');
    const q = inp ? inp.value.trim() : '';
    if (!q) { if (st) st.textContent = 'Bitte einen Ort eingeben (z. B. „Tübingen Zentrum“).'; return; }
    if (st) st.textContent = 'Lade „' + q + '“ von OpenStreetMap …';
    if (btn) btn.disabled = true;
    try {
      const res = await fetchJSON('api/regions_add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, span_deg: 0.015 }),
      });
      const regions = (res && res.regions) || [];
      const newId = res && res.region && res.region.id;
      state.regions = regions;
      populateRegions(regions, newId);
      renderStats();
      const st2 = (res && res.region && res.region.stats) || {};
      if (st) st.textContent = 'Hinzugefügt: ' + (res.region.name || newId) +
        ' (' + (st2.links || '?') + ' Links) – wird simuliert …';
      if (inp) inp.value = '';
      await runSimulation();
      if (st) st.textContent = 'Hinzugefügt: ' + (res.region.name || newId);
    } catch (e) {
      if (st) st.textContent = 'Fehler: ' + e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindAddRegion() {
    const btn = $('btn-add-region'), inp = $('add-place');
    if (btn) btn.addEventListener('click', addRegionFromInput);
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addRegionFromInput(); }
    });
  }

  function statPill(label, value, accent) {
    return '<span class="stat' + (accent ? ' accent' : '') + '"><span class="k">' + label +
      '</span> <b>' + value + '</b></span>';
  }

  function renderStats() {
    const box = $('net-stats');
    if (!box) return;
    const m = state.regionMeta;
    if (!m) { box.innerHTML = ''; return; }
    const s = m.stats || {};
    let html = '';
    if (s.nodes != null) html += statPill('Knoten', fmt(s.nodes, 0));
    if (s.links != null) html += statPill('Links', fmt(s.links, 0));
    if (s.signals != null) html += statPill('signalisiert', fmt(s.signals, 0), true);
    if (s.junctions != null) html += statPill('Kreuzungen', fmt(s.junctions, 0));
    const d = state.result && state.result.demand;
    if (d) {
      html += statPill('Zufahrten', fmt(d.n_entries, 0));
      html += statPill('Ausfahrten', fmt(d.n_exits, 0));
    }
    box.innerHTML = html;
  }

  /* --------------------------- Simulation -------------------------------- */
  function buildBody() {
    const mix = $('ctl-mix') ? $('ctl-mix').value : 'car';
    const tsp = $('ctl-tsp') ? $('ctl-tsp').value : 'off';
    return {
      region: $('ctl-region').value,
      time_from: $('ctl-time-from') ? $('ctl-time-from').value : null,
      time_to: $('ctl-time-to') ? $('ctl-time-to').value : null,
      warmup_min: 5,
      demand_multiplier: Number($('ctl-load').value),
      demand_scenario: $('ctl-scenario') ? $('ctl-scenario').value : 'normal',
      vehicle_mix: {
        car: { car: 1.0 },
        city: { car: 0.86, van: 0.06, truck: 0.06, bus: 0.02 },
        truck: { car: 0.72, van: 0.06, truck: 0.20, bus: 0.02 },
      }[mix] || { car: 1.0 },
      transit_priority: tsp === 'on',
      seed: Number($('ctl-seed').value),
      total_vph: Number($('ctl-vph').value),
    };
  }

  async function runSimulation() {
    if (state.busy) { state.pending = true; return; }
    const sel = $('ctl-region');
    if (!sel || !sel.value) return;
    closeDrill();          // Knoten-Overlay gehört zum vorherigen Lauf/Gebiet
    state.busy = true;
    setBusy(true);
    hideError();
    try {
      const res = await fetchJSON('api/simulate_network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      applyResult(res);
      clearDirty();
    } catch (e) {
      showError('Simulation fehlgeschlagen: ' + e.message);
      setBusy(false);
    } finally {
      state.busy = false;
      if (!state.pending) setBusy(false);
      if (state.pending) { state.pending = false; runSimulation(); }
    }
  }

  /* --------------------------- Ergebnis ---------------------------------- */
  // Web-Mercator (wie die OSM-Kacheln): Knoten und Kacheln teilen sich dieselbe
  // Projektion, damit das Karten-Overlay pixelgenau unter dem Graph liegt.
  function mercX(lon) { return (lon + 180) / 360; }
  function mercY(lat) {
    const s = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function applyResult(res) {
    if (!res || !res.network || !res.summary || !res.summary.fixed || !res.summary.adaptive) {
      showError('Ungültige Serverantwort – konnte nicht gerendert werden.');
      return;
    }
    state.result = res;
    state.summaries = res.summary || {};
    state.framesBy = {
      fixed: (res.frames && res.frames.fixed) || [],
      adaptive: (res.frames && res.frames.adaptive) || [],
      coordinated: (res.frames && res.frames.coordinated) || [],
      tuned: (res.frames && res.frames.tuned) || [],
    };
    state.steps = (res.meta && res.meta.steps) || (res.config ? res.config.duration_min * 60 : 0);
    state.frameDt = (res.meta && res.meta.frame_dt) || (res.config && res.config.frame_dt) || 3;

    // Knotenkoordinaten in Web-Mercator; mercBox = bbox im Mercator-Raum
    state.bbox = res.bbox || (state.regionMeta && state.regionMeta.bbox) || null;
    state.nodeUV = new Map();
    state.mercBox = null;
    if (state.bbox) {
      const s = state.bbox[0], w = state.bbox[1], n = state.bbox[2], e = state.bbox[3];
      state.mercBox = {
        x0: mercX(w), x1: mercX(e),
        y0: mercY(n), y1: mercY(s),   // Mercator: Norden = KLEINERER Wert; y0 oben
      };
      (res.network.nodes || []).forEach(function (nd) {
        state.nodeUV.set(nd.id, { mx: mercX(nd.lon), my: mercY(nd.lat) });
      });
    }

    // Korridor-Link-IDs (für die "Korridor-Stau"-Serie im Verlaufs-Chart)
    state.corridorIds = new Set((res.corridor && res.corridor.links) || []);

    // Region-Meta (Name/BBox) mit Antwort abgleichen
    state.regionMeta = state.regionMeta || {};
    state.regionMeta.bbox = state.bbox;

    // zoom folgt dem neuen Fenster; Serien-Cache verwerfen
    state.zoom = null;
    state.seriesCache = {};
    const zf = $('zoom-from'), zt = $('zoom-to');
    if (zf && zt && res.meta && res.meta.time_from) {
      zf.value = res.meta.time_from;
      zt.value = res.meta.time_to || res.meta.time_from;
    }

    state.t = 0;
    setPlaying(true);
    updateSpeedReadout();

    renderStats();
    buildKpiCards();
    buildKpiTable();
    renderKPIs();
    syncPolicyButtons();
    buildCanvasCells();
    state._drawSig = null;      // frische Karten im nächsten Frame zeichnen
    renderCharts();
    renderDecisions();
    renderMeta();
    if (state.autoSpeak && window.SFAsk) SFAsk.speakResult();
  }

  /* ------------------------- Ask-Panel / Badges -------------------------- */
  // Context for web/ask.js: the district currently on screen. The stripped
  // result rides along with explain requests so the server narrates THIS run.
  function askContext() {
    if (!state.result) return { kind: 'junction' };
    return {
      kind: 'network',
      region: state.result.region || (state.regionMeta && state.regionMeta.id) || '',
      name: state.result.name || (state.regionMeta && state.regionMeta.name) || '',
      scenario: ($('ctl-scenario') && $('ctl-scenario').value) || '',
      result: {
        region: state.result.region,
        name: state.result.name,
        scenario: state.result.scenario,
        summary: state.result.summary,
        improvement: state.result.improvement,
      },
    };
  }

  // Spoken one-liner for "Ergebnis vorlesen" (network phrasing).
  function resultSentence() {
    const r = state.result;
    if (!r || !r.summary || !r.summary.fixed || !r.summary.adaptive) return '';
    const f = r.summary.fixed, a = r.summary.adaptive, i = r.improvement || {};
    return 'SignalFlow Netzwerk ' + (r.name || '') + '. Feste Steuerung: ' +
      fmt(f.avg_delay_s, 1) + ' Sekunden mittlere Verzögerung. Adaptive Steuerung: ' +
      fmt(a.avg_delay_s, 1) + ' Sekunden, also ' +
      fmt(i.avg_delay_pct != null ? i.avg_delay_pct : 0, 1) + ' Prozent weniger.';
  }

  function renderBadges() {
    fetchJSON('api/health').then(function (h) {
      setBadge('badge-featherless', !!h.featherless, 'verbunden', 'Offline-Fallback');
      setBadge('badge-elevenlabs', !!h.elevenlabs, 'verbunden', 'Offline');
    }).catch(function () {
      setBadge('badge-featherless', null, '', '');
      setBadge('badge-elevenlabs', null, '', '');
    });
  }
  function setBadge(id, ok, okText, offText) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('ok', 'off', 'err');
    el.classList.add(ok === null ? 'err' : (ok ? 'ok' : 'off'));
    const s = el.querySelector('.badge-state');
    if (s) s.textContent = ok === null ? 'nicht erreichbar' : (ok ? okText : offText);
  }

  /* ------------------------------- View ---------------------------------- */
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function centerText(ctx, w, h, txt) {
    ctx.fillStyle = COL.faint;
    ctx.font = '600 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, w / 2, h / 2);
  }

  function queueColor(q) {
    const r = clamp(q / REF_QUEUE, 0, 1);
    const hue = 130 * (1 - r);
    const light = 42 + 8 * (1 - r);
    return 'hsl(' + hue.toFixed(0) + ' 82% ' + light.toFixed(0) + '%)';
  }

  function frameIndex(frames, t) {
    if (!frames || !frames.length) return -1;
    const idx = Math.round(t / Math.max(1, state.frameDt));
    return clamp(idx, 0, frames.length - 1);
  }

  // Projektions-Transform für ein gegebenes Canvas (Seitenverhältnis beachtet).
  // map() nimmt absolute Mercator-Koordinaten {mx,my}.
  function makeProj(w, h) {
    const mb = state.mercBox;
    const pad = 12;
    if (!mb) return null;
    const worldW = Math.max(1e-12, mb.x1 - mb.x0);
    const worldH = Math.max(1e-12, mb.y1 - mb.y0);
    const scale = Math.min((w - 2 * pad) / worldW, (h - 2 * pad) / worldH);
    const offX = (w - worldW * scale) / 2;
    const offY = (h - worldH * scale) / 2;
    return function (m) {
      return [offX + (m.mx - mb.x0) * scale, offY + (m.my - mb.y0) * scale];
    };
  }

  /* --------------------- OSM-Kacheln (Karten-Overlay) -------------------- */
  // Halbtransparente echte Karte unter dem Graph — Wiedererkennungswert.
  // Kacheln © OpenStreetMap-Mitwirkende; braucht Internet, degradiert offline
  // stumm (die Karte bleibt einfach dunkel). Cache pro Session im Speicher,
  // crossOrigin anonym, damit toDataURL (PNG/Bericht-Export) weiter funktioniert.
  const TILE_CACHE = new Map();      // url -> Image | null (null = fehlgeschlagen)
  const OSM_MAX_TILES = 24;

  function tileZoomFor(w, h) {
    const mb = state.mercBox;
    if (!mb) return 0;
    const target = Math.max(w, h) * (window.devicePixelRatio > 1 ? 2 : 1.4);
    const span = Math.max(mb.x1 - mb.x0, mb.y1 - mb.y0);
    let z = Math.ceil(Math.log2(target / Math.max(1e-12, span * 256)));
    // Kachel-Budget: zu viele Kacheln -> Zoom runter
    for (; z > 4; z--) {
      const tx = (mb.x1 - mb.x0) * (1 << z) + 2;
      const ty = (mb.y1 - mb.y0) * (1 << z) + 2;
      if (tx * ty <= OSM_MAX_TILES) break;
    }
    return clamp(z, 4, 18);
  }

  // lädt fehlende Kacheln nach; zeichnet, was da ist; liefert "fertig?" zurück
  function drawTileLayer(ctx, w, h, proj) {
    const mb = state.mercBox;
    if (!mb) return true;
    const z = tileZoomFor(w, h);
    const n = 1 << z;
    const x0 = Math.max(0, Math.floor(mb.x0 * n) - 1);
    const x1 = Math.min(n - 1, Math.floor(mb.x1 * n) + 1);
    const y0 = Math.max(0, Math.floor(mb.y0 * n) - 1);
    const y1 = Math.min(n - 1, Math.floor(mb.y1 * n) + 1);

    let pending = 0;
    ctx.save();
    ctx.globalAlpha = state.osmOpacity;
    try { ctx.filter = 'grayscale(0.75) brightness(0.5) contrast(1.08)'; } catch (e) { /* alt */ }
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const url = 'https://tile.openstreetmap.org/' + z + '/' + tx + '/' + ty + '.png';
        const img = TILE_CACHE.get(url);
        if (img === undefined) {
          TILE_CACHE.set(url, null);            // Platzhalter, nicht doppelt laden
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = function () {
            TILE_CACHE.set(url, im);
            state._drawSig = null;              // neu zeichnen, wenn alle da sind
          };
          im.onerror = function () { TILE_CACHE.set(url, null); };
          im.src = url;
          pending++;
          continue;
        }
        // Kachel-Rechteck aus den Mercator-Grenzen projizieren (nahtlos zum Graph)
        const tl = proj({ mx: tx / n, my: ty / n });
        const br = proj({ mx: (tx + 1) / n, my: (ty + 1) / n });
        if (br[0] < 0 || br[1] < 0 || tl[0] > w || tl[1] > h) continue;
        if (img) ctx.drawImage(img, tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
      }
    }
    ctx.restore();
    if (pending) state._tilesPending = true;
    else if (state._tilesPending) { state._tilesPending = false; state._drawSig = null; }
    return pending === 0;
  }

  function drawNetwork(canvas, which) {
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    // Hintergrund
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);

    if (!state.result || !state.bbox) { centerText(ctx, w, h, 'Keine Daten'); return; }
    const frames = state.framesBy[which] || [];
    if (!frames.length) { centerText(ctx, w, h, 'Keine Frames'); return; }

    const proj = makeProj(w, h);
    const nodes = state.result.network.nodes || [];
    const links = state.result.network.links || [];
    const signalSet = new Set(state.result.network.signal_nodes || []);

    // OSM-Karte als halbtransparente Unterlage (wenn zugeschaltet)
    if (state.osm && proj) drawTileLayer(ctx, w, h, proj);

    const f = frames[frameIndex(frames, state.t)];
    const qmap = new Map();
    if (f) { (f.q || []).forEach(function (e) { qmap.set(e[0], e[1]); }); }

    // Links
    ctx.lineCap = 'round';
    for (let i = 0; i < links.length; i++) {
      const lk = links[i];
      const a = state.nodeUV.get(lk.from), b = state.nodeUV.get(lk.to);
      if (!a || !b) continue;
      const pa = proj(a), pb = proj(b);
      const q = qmap.get(lk.id) || 0;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      const lanes = Math.max(1, lk.lanes || 1);
      if (q >= 0.5) {
        ctx.strokeStyle = queueColor(q);
        ctx.lineWidth = Math.min(5, 1.4 + lanes * 0.7 + clamp(q / REF_QUEUE, 0, 1) * 1.4);
      } else {
        ctx.strokeStyle = '#2b3746';
        ctx.lineWidth = Math.min(3.4, 1.1 + lanes * 0.55);
      }
      ctx.stroke();
    }

    // Knoten (nicht-signalisiert dezent, signalisiert hervorgehoben)
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const uv = state.nodeUV.get(nd.id);
      if (!uv) continue;
      const p = proj(uv);
      if (signalSet.has(nd.id)) {
        if (state.drill && state.drill.nodeId === nd.id) {
          ctx.beginPath();
          ctx.arc(p[0], p[1], 7.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#e6edf3';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3.0, 0, Math.PI * 2);
        ctx.fillStyle = '#2dd4bf';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 1.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(200,214,228,.45)';
        ctx.fill();
      }
    }

    // Rahmen
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  /* -------------------- Canvas-Zellen je Strategie ----------------------- */
  // Wie auf der Einzelkreuzung: eine Zelle je sichtbarer Strategie, das Grid
  // richtet sich nach der Anzahl (data-n). Tuned hat im Gebietsmodell keine
  // Frames und erscheint deshalb nicht als Canvas.
  function buildCanvasCells() {
    const wrap = $('canvas-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const p of animatablePolicies()) {
      const cell = document.createElement('div');
      cell.className = 'canvas-cell';
      cell.id = 'cell-' + p.key;
      cell.hidden = !state.visible[p.key];
      const title = document.createElement('div');
      title.className = 'canvas-title';
      title.textContent = p.label;
      const cv = document.createElement('canvas');
      cv.id = 'canvas-' + p.key;
      cell.appendChild(title);
      cell.appendChild(cv);
      wrap.appendChild(cell);
    }
    syncCanvasGrid();
  }

  function syncCanvasGrid() {
    const wrap = $('canvas-wrap');
    if (!wrap) return;
    const vis = visiblePolicies();
    wrap.dataset.n = String(vis.length);
    for (const p of animatablePolicies()) {
      const cell = $('cell-' + p.key);
      if (cell) cell.hidden = !state.visible[p.key];
    }
  }

  function drawActiveCanvases(force) {
    // Readouts laufen jeden Tick (billig); die Karten selbst nur, wenn der
    // Frame wechselt, gescrubbt wird oder sich etwas am Zustand ändert —
    // 4 Netzkarten × alle Links 60×/s neu zu zeichnen bringt nichts.
    const vis = visiblePolicies();
    const fi = Math.round(state.t / Math.max(1, state.frameDt));
    const sig = fi + '|' + Math.round(state.t / 10) + '|' +
      (state.drill ? state.drill.nodeId : '') + '|' + vis.length;
    if (!force && sig === state._drawSig) {
      updateDrillHead();
      return;
    }
    state._drawSig = sig;

    for (const p of vis) {
      const cv = $('canvas-' + p.key);
      if (cv) drawNetwork(cv, p.key);
    }

    // Readouts: Uhrzeit + Σ Queue über alle sichtbaren Strategien
    const cEl = $('playhead-clock');
    if (cEl) {
      const c = clockString(state.t);
      cEl.textContent = c ? c + ' Uhr' : '–';
    }
    const qEl = $('playhead-q');
    if (qEl) {
      let tot = 0, any = false;
      for (const p of vis) {
        const fr = state.framesBy[p.key] || [];
        const f = fr[frameIndex(fr, state.t)];
        if (!f) continue;
        any = true;
        (f.q || []).forEach(function (e) { tot += e[1] || 0; });
      }
      qEl.textContent = any ? fmt(tot, 0) + ' veh' : '–';
    }
    updateDrillHead();
    if (state.drill) drawDrill();
  }

  /* ------------------------- Knoten-Drilldown ---------------------------- */
  // Click a signalised node on the map -> junction close-up in an overlay:
  // arms at their TRUE bearings (north up, i.e. correctly rotated), queues
  // from the link data of the current frame, signal colours from the node's
  // real phase (axis 0 = N/S feeds, axis 1 = E/W feeds — same split the
  // server's controller uses). Gezeigt wird die erste sichtbare Strategie.
  function drillPolicy() {
    const vis = visiblePolicies();
    return vis.length ? vis[0] : null;
  }

  function rrLocal(ctx, x, y, rw, rh, r) {
    r = Math.min(r, rw / 2, rh / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx.arcTo(x, y + rh, x, y, r);
    ctx.arcTo(x, y, x + rw, y, r);
    ctx.closePath();
  }

  function openDrill(nodeId) {
    const res = state.result;
    if (!res || !res.network) return;
    const net = res.network;
    const byId = new Map();
    (net.nodes || []).forEach(function (nd) { byId.set(nd.id, nd); });
    const nd = byId.get(nodeId);
    if (!nd) return;
    // echte Knotenform: ALLE Nachbarn (ein- und ausgehende Links — OSM
    // Einbahnstraßen!) bilden einen Arm; Queue + Ampel nur auf Zufahrten.
    const armMap = new Map();
    (net.links || []).forEach(function (lk) {
      let other = null, incoming = false;
      if (lk.to === nodeId) { other = lk.from; incoming = true; }
      else if (lk.from === nodeId) { other = lk.to; }
      if (other == null || !byId.has(other)) return;
      const f = byId.get(other);
      const dlat = f.lat - nd.lat;
      const dlon = (f.lon - nd.lon) * Math.cos((nd.lat || 0) * Math.PI / 180);
      if (!armMap.has(other)) {
        armMap.set(other, {
          bearing: Math.atan2(dlon, dlat),               // 0 = north, clockwise
          axis: Math.abs(dlat) >= Math.abs(dlon) ? 0 : 1,// same split as the server
          lanes: 1, incoming: false, linkId: null, names: new Set(),
        });
      }
      const arm = armMap.get(other);
      arm.lanes = Math.max(arm.lanes, Math.max(1, lk.lanes || 1));
      if (incoming) {
        arm.incoming = true;
        arm.axis = Math.abs(dlat) >= Math.abs(dlon) ? 0 : 1;
        if (arm.linkId == null) arm.linkId = lk.id;
      }
      if (lk.name) arm.names.add(lk.name);
    });
    const arms = Array.from(armMap.values());
    if (!arms.length) return;
    arms.sort(function (a, b) { return a.bearing - b.bearing; });
    const names = [];
    arms.forEach(function (a) {
      a.names.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    });
    state.drill = {
      nodeId: nodeId,
      arms: arms,
      names: names.slice(0, 3),
      type: arms.length >= 4 ? 'Kreuzung' : (arms.length === 3 ? 'T-Kreuzung' : 'Kantenknoten'),
    };
    const panel = $('drill');
    if (panel) panel.hidden = false;
    updateDrillHead();
    drawDrill();
  }

  function closeDrill() {
    state.drill = null;
    const panel = $('drill');
    if (panel) panel.hidden = true;
    drawActiveCanvases();
  }

  function updateDrillHead() {
    const d = state.drill;
    if (!d) return;
    const pol = drillPolicy();
    const title = $('drill-title'), sub = $('drill-sub');
    if (title) title.textContent = d.type + ' · ' + d.arms.length + ' Straßen';
    if (sub) {
      sub.textContent = (d.names.length ? d.names.join(' · ') + ' — ' : '') +
        (pol ? pol.label + ' · ' : '') + 'Norden oben';
      sub.title = 'Knoten ' + d.nodeId;
    }
  }

  function drawDrill() {
    const d = state.drill;
    const canvas = $('drill-canvas');
    const pol = drillPolicy();
    if (!d || !canvas || !state.result || !pol) return;
    const frames = state.framesBy[pol.key] || [];
    const f = frames.length ? frames[frameIndex(frames, state.t)] : null;
    const qmap = new Map(), phmap = new Map();
    if (f) {
      (f.q || []).forEach(function (e) { qmap.set(e[0], e[1]); });
      (f.ph || []).forEach(function (e) { phmap.set(e[0], e[1]); });
    }
    const phase = phmap.has(d.nodeId) ? phmap.get(d.nodeId) : 0;

    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);

    const R = Math.min(w, h) * 0.12;                 // junction hub radius
    const roadHalf = Math.min(w, h) * 0.07;
    const maxLen = Math.min(w, h) / 2 - 8;
    const carLen = roadHalf * 0.58, carW = roadHalf * 0.34;

    let sumQ = 0;
    d.arms.forEach(function (arm) {
      const dx = Math.sin(arm.bearing), dy = -Math.cos(arm.bearing);  // screen dir
      const ang = Math.atan2(dy, dx);
      // road surface + edges + dashed centre line
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#141c25';
      ctx.lineWidth = roadHalf * 2;
      ctx.beginPath();
      ctx.moveTo(cx + dx * R, cy + dy * R);
      ctx.lineTo(cx + dx * maxLen, cy + dy * maxLen);
      ctx.stroke();
      ctx.strokeStyle = '#2a3948'; ctx.lineWidth = 1.2;
      [-1, 1].forEach(function (s) {
        const ox = -dy * s * roadHalf, oy = dx * s * roadHalf;
        ctx.beginPath();
        ctx.moveTo(cx + dx * R + ox, cy + dy * R + oy);
        ctx.lineTo(cx + dx * maxLen + ox, cy + dy * maxLen + oy);
        ctx.stroke();
      });
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#33465a';
      ctx.beginPath();
      ctx.moveTo(cx + dx * (R + 6), cy + dy * (R + 6));
      ctx.lineTo(cx + dx * maxLen, cy + dy * maxLen);
      ctx.stroke();
      ctx.setLineDash([]);
      // queue + signal only where traffic actually enters (one-ways!)
      if (!arm.incoming) return;
      const q = qmap.get(arm.linkId) || 0;
      sumQ += q;
      const lanes = Math.min(3, Math.max(1, Math.round(arm.lanes)));
      const pitch = carLen * 1.35;
      const n = Math.min(80, Math.round(q));
      const vehColor = queueColor(q);               // gleiche Farbskala wie die Karte
      for (let i = 0; i < n; i++) {
        const lane = i % lanes, pos = Math.floor(i / lanes);
        const dist = R + 7 + carLen / 2 + pos * pitch;
        const off = (lane + 0.5) * (roadHalf / lanes);
        const vx = cx + dx * dist + dy * off;       // right of the inbound heading
        const vy = cy + dy * dist - dx * off;
        ctx.save();
        ctx.translate(vx, vy);
        ctx.rotate(ang);
        ctx.fillStyle = vehColor;
        ctx.globalAlpha = 0.95;
        rrLocal(ctx, -carLen / 2, -carW / 2, carLen, carW, 2);
        ctx.fill();
        ctx.restore();
      }
      // signal head at the stop line (green when its axis has right of way)
      const green = arm.axis === phase;
      ctx.save();
      ctx.translate(cx + dx * (R + 5), cy + dy * (R + 5));
      ctx.rotate(ang);
      ctx.shadowColor = green ? '#22c55e' : '#ef4444';
      ctx.shadowBlur = 12;
      ctx.fillStyle = green ? '#22c55e' : '#ef4444';
      rrLocal(ctx, -2.5, -roadHalf * 0.92, 5, roadHalf * 1.84, 2.5);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    });

    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#101823';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,237,243,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // compass + readout chip (unrotated HUD)
    ctx.fillStyle = '#5d6b7a';
    ctx.font = '600 11px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, 12);
    const phText = (pol ? pol.label + ' · ' : '') +
      (phase === 0 ? 'Achse N–S frei' : 'Achse O–W frei');
    const tText = 't = ' + Math.round(state.t) + ' s · Σ Queue ' + Math.round(sumQ) + ' veh';
    ctx.font = '600 11px ' + FONT;
    const chipW = Math.max(ctx.measureText(phText).width,
                           ctx.measureText(tText).width) + 20;
    ctx.fillStyle = 'rgba(9,13,18,.78)';
    ctx.strokeStyle = '#223040';
    rrLocal(ctx, w - 12 - chipW, 8, chipW, 32, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(45,212,191,.9)';
    ctx.fillText(phText, w - 12 - chipW / 2, 18);
    ctx.fillStyle = 'rgba(139,152,167,.9)';
    ctx.font = '10px ' + FONT;
    ctx.fillText(tText, w - 12 - chipW / 2, 30);
  }

  // signal-node hit test on the map canvas (click opens the drilldown)
  function drillHit(canvas, ev) {
    if (!state.result || !state.bbox) return null;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const proj = makeProj(r.width, r.height);
    if (!proj) return null;
    let best = null, bestD = 12;
    (state.result.network.signal_nodes || []).forEach(function (id) {
      const uv = state.nodeUV.get(id);
      if (!uv) return;
      const p = proj(uv);
      const dd = Math.hypot(p[0] - x, p[1] - y);
      if (dd < bestD) { bestD = dd; best = id; }
    });
    return best;
  }

  /* -------------------------------- KPIs ---------------------------------
     Identische Struktur zur Einzelkreuzung: eine Zeile je Strategie, Δ als
     klassische Prozentänderung ((neu−alt)/alt) mit besser/schlechter-Farbe,
     "±0,0 %" exakt rundungsgleich, Gewinner je Kennzahl fett. */
  function buildKpiCards() {
    const grid = $('kpi-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const pols = kpiPolicies();
    for (const m of KPI_META) {
      const card = document.createElement('article');
      card.className = 'kpi';
      const rows = pols.map(function (p) {
        return '<div class="row pol-' + p.key + '"><span class="tag" title="' + escapeHtml(p.info) + '">' + p.label + '</span>' +
          (p.key === 'fixed'
            ? '<i class="dlt"></i>'
            : '<i class="dlt" data-kpi="' + m.key + '-' + p.key + '-delta" title="Δ gegenüber Fixed — positiv = besser">–</i>') +
          '<b data-kpi="' + m.key + '-' + p.key + '">–</b></div>';
      }).join('');
      card.innerHTML = '<header><h3 title="' + escapeHtml(m.info) + '">' + m.title +
        '</h3><span class="unit">' + (m.unit || '') + '</span></header>' +
        '<div class="kpi-rows">' + rows + '</div>';
      grid.appendChild(card);
    }
  }

  // Kompakte Matrix: Strategien als Zeilen, Kennzahlen als Wert|Δ-Spalten.
  function buildKpiTable() {
    const wrap = $('kpi-table-wrap');
    if (!wrap) return;
    const pols = kpiPolicies();
    const head = KPI_META.map(function (m) {
      return '<th colspan="2" title="' + escapeHtml(m.info) + '">' + m.title +
        (m.unit ? ' <span class="unit">' + m.unit + '</span>' : '') + '</th>';
    }).join('');
    const subHeads = KPI_META.map(function () {
      return '<th class="sub">Wert</th><th class="sub" title="Klassische relative Änderung gegenüber Fixed (neu − alt) / alt. Die Farbe bewertet: grün = besser, rot = schlechter — bei „weniger ist besser“-Kennzahlen ist ein negatives Δ also gut.">Δ vs Fixed</th>';
    }).join('');
    const bodyRows = pols.map(function (p) {
      const cells = KPI_META.map(function (m) {
        const dlt = p.key === 'fixed'
          ? '<td class="dltc">–</td>'
          : '<td class="dltc"><i class="dlt" data-kpi="' + m.key + '-' + p.key + '-delta" title="Δ gegenüber Fixed — positiv = besser">–</i></td>';
        return '<td class="v pol-v" data-kpi="' + m.key + '-' + p.key + '">–</td>' + dlt;
      }).join('');
      return '<tr class="pol-' + p.key + '"><th class="pol" title="' + escapeHtml(p.info) + '">' + p.label + '</th>' + cells + '</tr>';
    }).join('');
    wrap.innerHTML = '<table class="kpi-table">' +
      '<thead><tr><th rowspan="2"></th>' + head + '</tr><tr>' + subHeads + '</tr></thead>' +
      '<tbody>' + bodyRows + '</tbody></table>';
  }

  function renderKPIs() {
    const pols = kpiPolicies();
    if (!pols.length) return;
    const all = function (name) { return document.querySelectorAll('[data-kpi="' + name + '"]'); };
    for (const m of KPI_META) {
      const vals = pols.map(function (p) {
        return { p: p, v: m.get(state.summaries[p.summaryKey]) };
      });
      for (const { p, v } of vals) {
        all(m.key + '-' + p.key).forEach(function (el) { el.textContent = fmt(v, m.dec); });
      }

      // Gewinner je Kennzahl über alle Strategien (richtungsabhängig)
      const best = vals.reduce(function (b, x) {
        return m.dir === 'up' ? (x.v > b.v ? x : b) : (x.v < b.v ? x : b);
      }, vals[0]);
      for (const { p, v } of vals) {
        all(m.key + '-' + p.key).forEach(function (el) { el.classList.toggle('best', v === best.v); });
      }

      // Δ vs Fixed: klassische relative Änderung (neu − alt)/alt — das Vorzeichen
      // ist die reine Wertänderung; besser/schlechter zeigt die Farbe.
      const fv = (vals.find(function (x) { return x.p.key === 'fixed'; }) || {}).v;
      for (const { p, v } of vals) {
        if (p.key === 'fixed') continue;
        all(m.key + '-' + p.key + '-delta').forEach(function (dEl) {
          if (!fv) { dEl.textContent = 'n/a'; return; }
          const pct = (v - fv) / fv * 100;
          // neutral, wenn die ANGEZEIGTE Zahl 0,0 wäre (kein rot/grün auf Rundung)
          const shown = Math.round(pct * 10) / 10;
          const neutral = shown === 0;
          const better = !neutral && (m.dir === 'up' ? shown > 0 : shown < 0);
          const worse = !neutral && !better;
          dEl.textContent = neutral ? '±0,0 %'
            : (shown > 0 ? '+' : '−') + fmt(Math.abs(shown), 1) + ' %';
          dEl.classList.toggle('good', better);
          dEl.classList.toggle('bad', worse);
          dEl.classList.toggle('mid', false);
          dEl.title =
            (better ? 'Verbesserung' : worse ? 'Verschlechterung' : 'praktisch unverändert') +
            ' gegenüber Fixed — Vorzeichen = reine Wertänderung (' +
            (m.dir === 'up' ? 'höher ist besser' : 'kleiner ist besser') +
            '; Farbe zeigt besser/schlechter)';
        });
      }
    }
  }

  // cards ⇄ table toggle (persisted; table is the default)
  function initKpiView() {
    const grid = $('kpi-grid'), wrap = $('kpi-table-wrap');
    if (!grid || !wrap) return;
    const apply = function (view) {
      grid.hidden = view !== 'cards';
      wrap.hidden = view !== 'table';
      document.querySelectorAll('.kpi-view-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.view === view);
      });
      try { localStorage.setItem('sf-kpi-view', view); } catch (e) { /* ignore */ }
    };
    let view = 'table';
    try { view = localStorage.getItem('sf-kpi-view') || 'table'; } catch (e) { /* ignore */ }
    if (view !== 'cards' && view !== 'table') view = 'table';
    document.querySelectorAll('.kpi-view-btn').forEach(function (b) {
      b.addEventListener('click', function () { apply(b.dataset.view); });
    });
    apply(view);
  }

  /* ------------------------------- Charts -------------------------------- */
  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function chartPolicies() {
    // dieselben Schalter wie die Viewer-Canvases: der Filter gilt überall
    return visiblePolicies();
  }

  function drawBars(canvas) {
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
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

    BAR_METRICS.forEach(function (m, i) {
      const vals = pols.map(function (p) {
        return { p: p, v: m.get(state.summaries[p.summaryKey]) || 0 };
      });
      const max = Math.max.apply(null, vals.map(function (x) { return x.v; })) * 1.18 || 1;
      const center = padL + i * groupW + groupW / 2;
      const groupWpx = vals.length * (barW + 4) - 4;

      vals.forEach(function (o, k) {
        const bh = plotH * (o.v / max);
        const bx = center - groupWpx / 2 + k * (barW + 4);
        ctx.fillStyle = o.p.color;
        rrLocal(ctx, bx, padT + plotH - bh, barW, bh, 3); ctx.fill();
        // value labels only when they fit
        if (barW >= 14) {
          ctx.fillStyle = '#cbd5e1'; ctx.font = '9.5px ' + FONT;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(o.v, m.dec), bx + barW / 2, padT + plotH - bh - 2);
        }
      });

      // category label
      ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT; ctx.textBaseline = 'top';
      ctx.fillText(m.title + (m.unit ? ' (' + m.unit + ')' : ''), center, padT + plotH + 9);
    });

    // baseline + legend (dynamic, left to right)
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, padT + plotH, padL + plotW, padT + plotH);
    let lx = padL;
    for (const p of pols) {
      legendSwatch(ctx, lx, 10, p.color, p.label);
      lx += 26 + ctx.measureText(p.label).width + 22;
    }
  }

  function legendSwatch(ctx, x, y, color, label) {
    ctx.fillStyle = color; rrLocal(ctx, x, y, 10, 10, 3); ctx.fill();
    ctx.fillStyle = COL.txt; ctx.font = '11.5px ' + FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 15, y + 5);
  }

  // Verlauf-Panel: Kennzahlen je sichtbarer Strategie, x-Achse Uhrzeit,
  // Flächen-Darstellung, von–bis-Zoom — Struktur wie auf der Einzelkreuzung.
  const CHART_METRICS = {
    delay: {
      title: 'Verzögerung',
      abs: { note: 'wartende Fahrzeuge im Netz (veh)', dec: 0, get: function (p) { return p.qTot; } },
      cum: { note: 'kumuliert · veh·s', dec: 0, get: function (p) { return p.delayCum; } },
    },
    throughput: {
      title: 'Durchsatz',
      abs: { note: 'Fahrzeuge/h (momentan)', dec: 0, get: function (p) { return p.servedInst; } },
      cum: { note: 'Fahrzeuge/h (Ø bis t)', dec: 0, get: function (p) { return p.thruCum; } },
    },
    maxq: {
      title: 'max. Queue',
      abs: { note: 'längste Link-Warteschlange (veh)', dec: 1, get: function (p) { return p.qMax; } },
      cum: { note: 'Rekord bis t (veh)', dec: 1, get: function (p) { return p.maxRun; } },
    },
    co2: {
      title: 'CO₂-Proxy',
      abs: { note: 'Leerlauf-Ausstoß je Frame (g)', dec: 1, get: function (p) { return p.co2Abs; } },
      cum: { note: 'kumuliert · g', dec: 0, get: function (p) { return p.co2Cum; } },
    },
    corr: {
      title: 'Korridor-Stau',
      abs: { note: 'wartende Fz auf dem Korridor (veh)', dec: 1, get: function (p) { return p.corrAbs; } },
      cum: { note: 'kumuliert · veh·s', dec: 0, get: function (p) { return p.corrCum; } },
    },
  };

  // derived per-frame series per policy (cached until the next payload)
  function policySeries(pol) {
    state.seriesCache = state.seriesCache || {};
    if (state.seriesCache[pol]) return state.seriesCache[pol];
    const fr = state.framesBy[pol] || [];
    const dt = Math.max(1, state.frameDt);
    const corr = state.corridorIds;
    let servedSum = 0, delayCum = 0, co2Cum = 0, corrCum = 0, maxRun = 0;
    const pts = fr.map(function (f) {
      let qTot = 0, qMax = 0, corrTot = 0;
      (f.q || []).forEach(function (e) {
        const v = e[1] || 0;
        qTot += v;
        if (v > qMax) qMax = v;
        if (corr.has(e[0])) corrTot += v;
      });
      servedSum += (f.s || 0);
      delayCum += qTot * dt;
      co2Cum += qTot * dt * CO2_IDLE_G_PER_S;
      corrCum += corrTot * dt;
      if (qMax > maxRun) maxRun = qMax;
      const elapsedH = ((f.t || 0) + dt) / 3600;
      return {
        m: clockMinAt(f.t || 0),
        qTot: qTot, qMax: qMax,
        servedInst: (f.s || 0) / dt * 3600,
        thruCum: servedSum / Math.max(1e-9, elapsedH),
        delayCum: delayCum,
        co2Abs: qTot * CO2_IDLE_G_PER_S, co2Cum: co2Cum,
        corrAbs: corrTot, corrCum: corrCum,
        maxRun: maxRun,
      };
    });
    state.seriesCache[pol] = pts;
    return pts;
  }

  function drawSeriesChart() {
    const canvas = $('chart-delay');
    if (!canvas) return;
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    const pols = chartPolicies().filter(function (p) { return (state.framesBy[p.key] || []).length; });
    if (!pols.length) { centerText(ctx, w, h, 'Keine Daten'); return; }
    const met = CHART_METRICS[state.chartMetric] || CHART_METRICS.delay;
    const view = state.chartMode === 'cum' ? met.cum : met.abs;

    const padL = 52, padR = 14, padT = 26, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    // x-domain: sim seconds mapped to minutes-of-day; zoom narrows both
    const z0 = state.zoom ? state.zoom.from : 0;
    const z1 = state.zoom ? state.zoom.to : 1440;
    const x0m = state.zoom ? z0 : (clockMinAt(0) || 0);
    const x1m = state.zoom ? z1 : ((clockMinAt(state.steps) != null
      ? clockMinAt(state.steps) : 1440) || 1440);
    if (x1m <= x0m) { centerText(ctx, w, h, 'Zoom-Bereich leer'); return; }

    // series (lightly smoothed; signal cycles add sawtooth noise)
    const W = (state.chartMetric === 'corr' && state.chartMode === 'abs') ? 1 : 3;
    const series = pols.map(function (p) {
      const raw = policySeries(p.key);
      const pts = [];
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        if (r.m == null || r.m < z0 || r.m > z1) continue;
        let sum = 0, cnt = 0;
        for (let k = Math.max(0, i - W + 1); k <= Math.min(raw.length - 1, i + W - 1); k++) {
          sum += view.get(raw[k]); cnt++;
        }
        pts.push({ m: r.m, v: sum / cnt });
      }
      return { p: p, pts: pts };
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

    const X = function (m) { return padL + plotW * ((m - x0m) / (x1m - x0m)); };
    const Y = function (v) { return padT + plotH * (1 - clamp(v / yMax, 0, 1)); };

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
      s.pts.forEach(function (pt, i) {
        if (i === 0) ctx.moveTo(X(pt.m), Y(pt.v)); else ctx.lineTo(X(pt.m), Y(pt.v));
      });
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
    ctx.fillStyle = COL.txt; ctx.font = '10px ' + FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(view.note, w - padR, 10);
  }

  function renderCharts() {
    drawBars($('chart-bars'));
    drawSeriesChart();
  }

  function renderMeta() {
    const el = $('meta-info');
    if (!el) return;
    const res = state.result;
    if (!res) { el.textContent = 'Keine Simulation geladen.'; return; }
    const c = res.config || {};
    const m = res.meta || {};
    const win = m.time_from ? (' · Fenster ' + m.time_from + '–' + m.time_to +
      (m.clock_rate > 1 ? ' (Tagesgang komprimiert, Mengen 1:1)' : '')) : '';
    const pols = kpiPolicies().map(function (p) { return p.label; }).join(', ');
    el.textContent = (res.name || res.region) + ' · Strategien: ' + pols +
      ' · Seed ' + fmt(c.seed, 0) +
      ' · Dauer ' + fmt(c.duration_min, 0) + ' min' + win +
      ' · ' + ((res.meta && res.meta.generated) || '');
  }

  /* --------------------- Entscheidungsprotokoll -------------------------- */
  // Wie auf der Einzelkreuzung je Strategie ein Reiter: Adaptiv zeigt
  // Live-Zahlen aus den Frames (Top-Stau-Links + "Netz in Zahlen"), die
  // festen Verfahren zeigen ihren Plan.
  function renderDecisions() {
    renderDecView();
  }

  function renderDecView() {
    let pol = state.decTab;
    const adaptiveBox = $('dec-adaptive');
    const planBox = $('dec-plan');
    if (!adaptiveBox || !planBox) return;
    const known = POLICY_META.some(function (p) { return p.key === pol; });
    if (!known || pol === 'tuned' && !state.summaries.fixed_tuned_est) pol = 'adaptive';
    adaptiveBox.hidden = pol !== 'adaptive';
    planBox.hidden = pol === 'adaptive';
    if (pol === 'adaptive') {
      renderHotspots();
      renderAdaptiveStats();
    } else {
      renderPlanCard(pol, planBox);
    }
  }

  // Link-Name für Hotspots: OSM-Straßenname, sonst Klasse, sonst Link-Nummer.
  // Als Knoten für die Kreuzungs-Ansicht gilt das signalisierte Ende — bei
  // Rückstau-Segmenten liegt der Stau oft zwischen unsignalisierten Knoten.
  function linkInfo(id) {
    const links = (state.result && state.result.network && state.result.network.links) || [];
    const lk = links.find(function (l) { return l.id === id; });
    if (!lk) return { name: 'Link ' + id, node: null };
    const signalSet = new Set((state.result && state.result.network &&
      state.result.network.signal_nodes) || []);
    let node = null;
    if (lk.to != null && signalSet.has(lk.to)) node = lk.to;
    else if (lk.from != null && signalSet.has(lk.from)) node = lk.from;
    return { name: lk.name || lk.hw || ('Link ' + id), node: node };
  }

  // Top-Stau-Links aus den Adaptiv-Frames — die ehrliche Antwort des
  // Gebietsmodells auf "wo entscheidet die Steuerung am meisten": die
  // Zufahrten mit dem größten Druck. Klick öffnet die Kreuzungs-Ansicht.
  function renderHotspots() {
    const list = $('hotspots-list');
    const legend = $('hotspot-legend');
    if (!list) return;
    const frames = state.framesBy.adaptive || [];
    if (!frames.length) {
      if (legend) legend.innerHTML = '';
      list.innerHTML = '<li class="empty">Keine Frames für die Hotspot-Analyse.</li>';
      return;
    }
    const agg = new Map();   // linkId -> {max, sum, n, tAtMax}
    frames.forEach(function (f) {
      (f.q || []).forEach(function (e) {
        const id = e[0], v = e[1] || 0;
        if (v < 0.5) return;
        let a = agg.get(id);
        if (!a) { a = { max: 0, sum: 0, n: 0, tAtMax: 0 }; agg.set(id, a); }
        a.sum += v; a.n++;
        if (v > a.max) { a.max = v; a.tAtMax = f.t || 0; }
      });
    });
    const rows = [...agg.entries()]
      .map(function (kv) {
        return { id: kv[0], max: kv[1].max, avg: kv[1].sum / Math.max(1, kv[1].n), tAtMax: kv[1].tAtMax };
      })
      .sort(function (a, b) { return b.max - a.max; })
      .slice(0, 8);
    if (legend) {
      legend.innerHTML = '<span class="lg lead">Top-Stau-Links (Adaptiv-Lauf):</span>' +
        '<span class="lg faint">' + agg.size + ' Links mit Verkehr · Klick öffnet die Kreuzungs-Ansicht</span>';
    }
    if (!rows.length) {
      list.innerHTML = '<li class="empty">Keine nennenswerten Warteschlangen — freie Fahrt im ganzen Zeitfenster.</li>';
      return;
    }
    const maxAll = rows[0].max;
    list.innerHTML = '';
    rows.forEach(function (r, i) {
      const info = linkInfo(r.id);
      const li = document.createElement('li');
      li.className = 'decision-item hot';
      li.innerHTML =
        '<div class="head"><span class="t">#' + (i + 1) + '</span>' +
        '<span class="swap">' + escapeHtml(info.name) + '</span>' +
        '<span class="cat cat-hot" title="Maximale Warteschlange und Uhrzeit des Maximums">' +
        'max ' + fmt(r.max, 0) + ' veh · ' + (clockString(r.tAtMax) || timeStr(r.tAtMax)) + '</span></div>' +
        '<div class="why"><span class="bar" style="width:' +
        Math.max(2, Math.round(220 * clamp(r.max / maxAll, 0, 1))) + 'px"></span>' +
        '<span class="avg">Ø ' + fmt(r.avg, 1) + ' veh über den Lauf</span></div>';
      if (info.node != null) {
        li.title = 'Kreuzungs-Ansicht dieses Knotens öffnen';
        li.addEventListener('click', function () { openDrill(info.node); });
      } else {
        li.title = 'Rückstau-Segment zwischen unsignalisierten Knoten — keine Kreuzungs-Ansicht';
        li.style.cursor = 'default';
        li.classList.add('noclick');
      }
      list.appendChild(li);
    });
  }

  // rechte Spalte: was der Adaptiv-Lauf in Summe getan hat
  function renderAdaptiveStats() {
    const box = $('adaptive-stats');
    if (!box) return;
    const s = state.summaries;
    if (!s.adaptive) { box.innerHTML = ''; return; }
    const pts = policySeries('adaptive');
    let avgQ = 0, peak = { qTot: 0, m: null };
    for (const p of pts) {
      avgQ += p.qTot;
      if (p.qTot > peak.qTot) peak = p;
    }
    avgQ = pts.length ? avgQ / pts.length : 0;
    const tsp = state.result && state.result.scenario && state.result.scenario.transit_priority;
    const modeTxt = tsp
      ? 'Max-Pressure je Knoten (+ Bus-Priorität auf dem Korridor)'
      : 'Grünanteile je Zyklus aus gemessenen Einläufen (Detektor-Proxy)';
    // Δ in derselben klassischen Semantik wie die KPI-Tabelle (neu − alt)/alt;
    // die Farbe bewertet, das Vorzeichen ist die reine Wertänderung.
    const dDelay = (s.adaptive.avg_delay_s - s.fixed.avg_delay_s) /
      Math.max(1e-9, s.fixed.avg_delay_s) * 100;
    const shownD = Math.round(dDelay * 10) / 10;
    const dGood = shownD < 0;    // kleiner = besser
    const dTxt = shownD === 0 ? '±0,0 %'
      : (shownD > 0 ? '+' : '−') + fmt(Math.abs(shownD), 1) + ' %';
    const rows = [
      ['Verfahren', modeTxt],
      ['Ø Netz-Queue', fmt(avgQ, 1) + ' veh'],
      ['Spitzen-Queue', fmt(peak.qTot, 0) + ' veh' + (peak.m != null ? ' · ' + minToLabel(peak.m) + ' Uhr' : '')],
      ['Σ Wartezeit', fmt(s.adaptive.total_delay_vehsec, 0) + ' veh·s'],
      ['Signalisierte Knoten', fmt(s.adaptive.junctions != null ? s.adaptive.junctions : (s.fixed && s.fixed.junctions), 0)],
      ['Takt / Nachjustierung', '60 s Basis · Grünanteile je Umlauf neu'],
      ['Δ Ø Verzögerung vs. Fixed',
        '<i class="dlt ' + (shownD === 0 ? 'mid' : (dGood ? 'good' : 'bad')) +
        '" style="font-size:12.5px" title="Klassische Wertänderung gegenüber Fixed — negatives Δ = weniger Verzögerung (grün)">' +
        dTxt + '</i>'],
    ];
    box.innerHTML = '<table class="stats-table">' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') +
      '</table>';
  }

  // Plan-Karten für die festen Verfahren (Fixed / Koord. / Tuned)
  function renderPlanCard(pol, box) {
    const res = state.result;
    if (!res) { box.innerHTML = '<p class="empty">Keine Daten.</p>'; return; }
    let html = '';
    if (pol === 'fixed') {
      const fx = res.summary.fixed || {};
      html += '<p class="plan-line"><b>Festes Signalprogramm</b> an ' +
        fmt(fx.junctions, 0) + ' Knoten · Umlauf 66 s (30 + 3 + 30) — überall derselbe Takt</p>' +
        '<table class="plan-table"><thead><tr><th>Phase</th><th>Dauer</th></tr></thead><tbody>' +
        '<tr><td>Achse A frei (N–S-Lagen)</td><td>30 s</td></tr>' +
        '<tr><td>Gelb</td><td>3 s</td></tr>' +
        '<tr><td>Achse B frei (O–W-Lagen)</td><td>30 s</td></tr>' +
        '<tr><td>Gelb</td><td>3 s</td></tr>' +
        '</tbody></table>' +
        '<p class="plan-why"><b>Warum so?</b> Feste 50/50-Verteilung ohne Rückkopplung: ' +
        'ob eine Richtung voll oder leer ist, ändert nichts am Plan. Genau deshalb dient ' +
        'Fixed als Baseline — jede Abweicheung der anderen Strategien gegen diesen Plan ist ' +
        'der messbare Gewinn (oder Verlust) der Steuerung.</p>' +
        '<p class="plan-src">Baseline: FixedTime 66 s Umlauf, gleichphasig an allen Knoten</p>';
    } else if (pol === 'coordinated') {
      const cor = res.corridor || {};
      const nCor = (res.corridors || []).length;
      const nodes = cor.nodes || [];
      const offs = cor.offsets || [];
      const axes = cor.main_axis || [];
      const shown = Math.min(14, nodes.length);
      html += '<p class="plan-line"><b>Korridor-Takt</b> ' + fmt(cor.cycle_s, 0) + 's' +
        ' · Hauptgrün ' + fmt(cor.main_green_s, 0) + 's' +
        (cor.length_m ? ' · ' + fmt(cor.length_m / 1000, 1) + ' km' : '') +
        ' · ' + fmt(cor.junctions, 0) + ' Knoten' +
        (nCor > 1 ? ' · ' + nCor + ' Koordinierungskorridore erkannt' : '') + '</p>' +
        '<table class="plan-table"><thead><tr><th>#</th><th>Knoten im Korridor</th><th>Offset</th><th>Hauptachse</th></tr></thead><tbody>' +
        nodes.slice(0, shown).map(function (nid, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + nid + '</td><td>' + fmt(offs[i], 0) + ' s</td><td>' +
            (axes[i] === 1 ? 'B' : 'A') + '</td></tr>';
        }).join('') +
        (nodes.length > shown
          ? '<tr><td colspan="4">+ ' + (nodes.length - shown) + ' weitere Knoten im Verband</td></tr>'
          : '') +
        '</tbody></table>' +
        '<p class="plan-why"><b>Warum so?</b> Der Versatz-Offset jedes Knotens ist die ' +
        'kumulierte Freifluss-Fahrtzeit vom Korridoranfang, multipliziert mit einem ' +
        'Progressionsfaktor leicht unter Freifluss — so bleibt der Pulk im Grünband, statt ' +
        'an der nächsten Ampel aufzulaufen. Das Restnetz läuft adaptiv weiter, nur die ' +
        'Korridorknoten folgen dem gemeinsamen Takt.</p>' +
        '<p class="plan-src">Korridor = längste Route zwischen Einfahrten und Ausfahrten (OSM-Dijkstra), Versatz = kumulative Fahrtzeit</p>';
    } else if (pol === 'tuned') {
      const od = (res.meta && res.meta.od_estimation) || {};
      const te = res.summary.fixed_tuned_est || {};
      html += '<p class="plan-line"><b>Fester Plan aus Zählungen</b> — Grünanteile je Knoten ' +
        'proportional zur geschätzten Nachfrage, Umlauf ' + fmt(te.cycle_s || 60, 0) + 's</p>' +
        '<table class="plan-table"><thead><tr><th>Schritt</th><th>Ergebnis</th></tr></thead><tbody>' +
        '<tr><td>Detektor-Zählungen</td><td>aus dem Fixed-Lauf (Stopp-Linien)</td></tr>' +
        (od.pairs != null ? '<tr><td>OD-Paare</td><td>' + fmt(od.pairs_active != null ? od.pairs_active : od.pairs, 0) + ' aktiv von ' + fmt(od.pairs, 0) + '</td></tr>' : '') +
        (od.iterations != null ? '<tr><td>Schätzung</td><td>iterativ · ' + fmt(od.iterations, 0) + ' Iterationen</td></tr>' : '') +
        (od.fit_rel_err_pct != null ? '<tr><td>Restfehler der Anpassung</td><td>' + fmt(od.fit_rel_err_pct, 1) + ' %</td></tr>' : '') +
        '</tbody></table>' +
        '<p class="plan-why"><b>Warum so?</b> Getunt wie eine echte Stadt: Zählstellen liefern ' +
        'Häufigkeiten, daraus wird die Nachfrage (OD-Matrix) geschätzt und der feste Plan auf ' +
        'die Schätzung abgestimmt — kein Oracle-Wissen über die wahre Nachfrage. Ehrlich ' +
        'berichtet: je nach Netz schlägt dieses Verfahren Adaptiv (kurzmaschige Grids wie ' +
        'Berlin/Hamburg, wo Rückstau die Live-Steuerung bestraft) oder verliert dagegen ' +
        '(z. B. Riem/Köln) — beide Baselines stehen in den Kennzahlen und in docs/results.md.</p>' +
        '<p class="plan-src">Zähl-basierte OD-Schätzung (Cascetta-Stil) auf den Gateway-Routen des Netzes</p>';
    }
    box.innerHTML = html;
  }

  /* ------------------------------ Transport ------------------------------ */
  function setPlaying(p) {
    state.playing = p;
    const b = $('btn-play');
    if (b) {
      b.textContent = p ? '❚❚' : '▶';
      b.title = p ? 'Pause' : 'Play';
      b.setAttribute('aria-label', p ? 'Pause' : 'Abspielen');
      b.setAttribute('aria-pressed', p ? 'true' : 'false');
    }
  }

  function updateProgress() {
    const p = $('progress');
    if (!p) return;
    const val = state.steps ? (state.t / state.steps) * 100 : 0;
    p.value = String(clamp(val, 0, 100));
    setRangeFill(p);
  }

  // Wiedergabe: gesamte Simulation in ~45 s bei 1× (beschleunigt), damit lange
  // Standzeiten nicht in Echtzeit durchlaufen müssen.
  function playbackRate() {
    return Math.max(1, state.steps / 45);
  }

  function updateSpeedReadout() {
    const el = $('speed-readout');
    if (el) el.textContent = fmt(playbackRate() * state.speed, 0) + '×';
  }

  let lastTs = 0;
  function frameLoop(ts) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (state.playing && state.result) {
      state.t += dt * playbackRate() * state.speed;
      if (state.t >= state.steps) { state.t = state.steps; setPlaying(false); }
    }
    updateProgress();
    drawActiveCanvases();
    if (state.result) drawSeriesChart();
    requestAnimationFrame(frameLoop);
  }

  /* ----------------------------- Interaktion ----------------------------- */
  // A network run takes seconds, so control changes only mark the config as
  // "dirty" — the user triggers the run explicitly with the Simulieren button.
  function markDirty() {
    state.dirty = true;
    const hint = $('run-hint');
    if (hint) { hint.textContent = 'Parameter geändert – „Simulieren“ drücken'; hint.classList.remove('hidden'); }
    const btn = $('btn-run');
    if (btn) btn.classList.add('dirty');
  }
  function clearDirty() {
    state.dirty = false;
    const hint = $('run-hint');
    if (hint) { hint.textContent = ''; hint.classList.add('hidden'); }
    const btn = $('btn-run');
    if (btn) btn.classList.remove('dirty');
  }

  // Strategie-Toggles wie auf der Einzelkreuzung: ein Zustand (state.visible)
  // steuert die Canvas-Zellen UND beide Auswertungs-Charts.
  function applyPolicyToggle(pol) {
    if (pol === 'all') {
      for (const p of animatablePolicies()) state.visible[p.key] = true;
    } else {
      state.visible[pol] = !state.visible[pol];
      const anim = animatablePolicies().filter(function (p) { return state.visible[p.key]; });
      if (!anim.length) state.visible[pol] = true;   // nie alles aus
    }
    syncPolicyButtons();
    syncCanvasGrid();
    state._drawSig = null;      // Umschalten erzwingt Neuzeichnen (auch gleiche Anzahl)
    renderCharts();
  }

  function syncPolicyButtons() {
    const animKeys = animatablePolicies().map(function (p) { return p.key; });
    document.querySelectorAll('.policy-modes .pol-btn').forEach(function (b) {
      const pol = b.dataset.pol;
      if (pol === 'all') {
        const anim = animatablePolicies();
        b.classList.toggle('active',
          anim.length > 0 && anim.every(function (p) { return state.visible[p.key]; }));
        return;
      }
      const avail = animKeys.indexOf(pol) >= 0;
      b.disabled = !avail;
      b.classList.toggle('active', avail && !!state.visible[pol]);
      b.title = avail ? b.title
        : 'Für diesen Lauf nicht vorhanden (Tuned entsteht aus der OD-Schätzung — bei abgeschalteter Schätzung gibt es keine Animation)';
    });
  }

  function bindControls() {
    const load = $('ctl-load'), seed = $('ctl-seed'), vph = $('ctl-vph');
    const prof = $('ctl-scenario'), region = $('ctl-region');

    const syncVals = function () {
      if ($('val-load')) $('val-load').textContent = Number(load.value).toFixed(2);
      if ($('val-seed')) $('val-seed').textContent = seed.value;
      if ($('val-vph')) $('val-vph').textContent = vph.value;
      [load, seed, vph].forEach(setRangeFill);
    };

    // sliders: only mark dirty (no auto-run)
    [load, seed, vph].forEach(function (el) {
      el.addEventListener('input', function () { syncVals(); markDirty(); });
    });
    // Szenario setzt das Zeitfenster vor; Fenster-Änderungen markieren dirty
    prof.addEventListener('change', function () { syncVals(); applyScenarioPreset(); markDirty(); });
    ['ctl-dow', 'ctl-time-from', 'ctl-time-to'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', function () { updateTimeHint(); markDirty(); });
    });
    ['ctl-mix', 'ctl-tsp'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', markDirty);
    });
    // region switch is a deliberate action, but does not auto-run either:
    // mark dirty and let the user press Simulieren (keeps big nets snappy)
    region.addEventListener('change', function () {
      const id = region.value;
      state.regionMeta = state.regions.find(function (r) { return r.id === id; }) || { id: id };
      renderStats();
      markDirty();
    });
    const regionFilter = $('region-filter');
    if (regionFilter) regionFilter.addEventListener('input', function (e) {
      applyRegionFilter(e.target.value);
    });

    const run = $('btn-run');
    if (run) run.addEventListener('click', function () { runSimulation(); });

    syncVals();
  }

  function bindTransport() {
    const play = $('btn-play');
    if (play) play.addEventListener('click', function () {
      if (!state.result) return;
      if (state.t >= state.steps) state.t = 0;
      setPlaying(!state.playing);
    });

    document.querySelectorAll('.speed-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.speed = Number(b.dataset.speed) || 1;
        document.querySelectorAll('.speed-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        updateSpeedReadout();
      });
    });

    // strategy toggles (viewer canvases + both chart cards share one state) —
    // .ask-mode buttons belong to the ask panel (ask.js)
    document.querySelectorAll('.policy-modes .pol-btn').forEach(function (b) {
      b.addEventListener('click', function () { applyPolicyToggle(b.dataset.pol); });
    });

    // decision-log tabs (adaptive live view vs. the other strategies' plans)
    document.querySelectorAll('.dec-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.decTab = b.dataset.dec;
        document.querySelectorAll('.dec-tab').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        renderDecView();
      });
    });

    // time-series chart: metric chips + Verlauf/Kumuliert + von–bis zoom
    document.querySelectorAll('.chart-metrics .met-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.chartMetric = b.dataset.met;
        document.querySelectorAll('.chart-metrics .met-btn').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        renderCharts();
      });
    });
    document.querySelectorAll('.chart-mode .cmode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.chartMode = b.dataset.cmode;
        document.querySelectorAll('.chart-mode .cmode-btn').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        renderCharts();
      });
    });
    const applyZoom = function () {
      const toMin = function (s) {
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
    ['zoom-from', 'zoom-to'].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener('change', applyZoom);
    });
    const zr = $('zoom-reset');
    if (zr) zr.addEventListener('click', function () {
      state.zoom = null;
      const res = state.result;
      if (res && res.meta && res.meta.time_from) {
        if ($('zoom-from')) $('zoom-from').value = res.meta.time_from;
        if ($('zoom-to')) $('zoom-to').value = res.meta.time_to || res.meta.time_from;
      }
      renderCharts();
    });

    const prog = $('progress');
    if (prog) {
      prog.addEventListener('input', function () {
        if (!state.steps) return;
        state.t = clamp(Number(prog.value) / 100, 0, 1) * state.steps;
        setRangeFill(prog);
        drawActiveCanvases(true);
        if (state.result) drawSeriesChart();
      });
    }

    // OSM-Karten-Unterlage (persistiert; offline fehlen einfach die Kacheln)
    // + Deckkraft-Slider
    const osmBtn = $('btn-osm');
    const opaSlider = $('osm-opacity');
    if (opaSlider) {
      try {
        const v = Number(localStorage.getItem('sf-osm-opacity'));
        if (v >= 10 && v <= 100) state.osmOpacity = v / 100;
      } catch (e) { /* ignore */ }
      opaSlider.value = String(Math.round(state.osmOpacity * 100));
      setRangeFill(opaSlider);
      opaSlider.addEventListener('input', function () {
        state.osmOpacity = Number(opaSlider.value) / 100;
        setRangeFill(opaSlider);
        try { localStorage.setItem('sf-osm-opacity', opaSlider.value); } catch (e) { /* ignore */ }
        if (state.osm) { state._drawSig = null; drawActiveCanvases(true); }
      });
    }
    if (osmBtn) {
      try { state.osm = localStorage.getItem('sf-osm-tiles') === '1'; } catch (e) { /* ignore */ }
      osmBtn.classList.toggle('active', state.osm);
      if (opaSlider) opaSlider.disabled = !state.osm;
      osmBtn.addEventListener('click', function () {
        state.osm = !state.osm;
        osmBtn.classList.toggle('active', state.osm);
        if (opaSlider) opaSlider.disabled = !state.osm;
        try { localStorage.setItem('sf-osm-tiles', state.osm ? '1' : '0'); } catch (e) { /* ignore */ }
        state._drawSig = null;
        drawActiveCanvases(true);
      });
    }
  }

  /* -------------------- PDF-Abhandlung (Bericht) ------------------------- */
  // Din A4-Bericht der laufenden Netzwerk-Simulation: Randbedingungen aus den
  // Controls, KPI-Tabelle der Strategien, Charts + Karten-Composite. Derselbe
  // Builder wie auf der Einzelkreuzung (web/report.js).
  const PAGE_W_NB = 503;   // nutzbare Breite in pt

  function exportReportPdf() {
    if (!state.result || !window.SFReport) return;
    const res = state.result;
    const selText = function (id) {
      const el = document.getElementById(id);
      return el && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '–';
    };
    const val = function (id) { const el = document.getElementById(id); return el ? el.value : '–'; };
    const pols = kpiPolicies();
    const meta = res.meta || {};
    const spanMin = Math.round((res.config && res.config.span_sec || state.steps) / 60);
    const spanTxt = spanMin >= 120 ? Math.round(spanMin / 6) / 10 + ' h' : spanMin + ' min';
    const win = meta.time_from
      ? meta.time_from + '–' + meta.time_to + ' Uhr · ' + spanTxt +
        (meta.clock_rate > 1 ? ' · Tagesgang komprimiert (' + fmt(meta.clock_rate, 1) + '×, Mengen 1:1)' : '')
      : spanTxt;
    const fx = res.summary.fixed || {};
    const netStats = res.demand || {};

    const conditions = [
      ['Gebiet', (res.name || res.region) + ' (' + res.region + ')'],
      ['Netz', fmt(fx.links, 0) + ' Links · ' + fmt(fx.junctions, 0) + ' signalisierte Knoten' +
        (netStats.n_entries != null ? ' · ' + fmt(netStats.n_entries, 0) + ' Zufahrten / ' + fmt(netStats.n_exits, 0) + ' Ausfahrten' : '')],
      ['Szenario', selText('ctl-scenario')],
      ['Zeitraum', win + ' · Warm-up ' + (meta.warmup_min || 0) + ' min (nicht gewertet)'],
      ['Fahrzeugmix', selText('ctl-mix')],
      ['Bus-Priorität', val('ctl-tsp') === 'on' ? 'an (TSP)' : 'aus'],
      ['Last', '×' + Number(val('ctl-load')).toFixed(2).replace('.', ',') +
        ' · ' + fmt(val('ctl-vph'), 0) + ' veh/h Gesamtnachfrage'],
      ['Strategien', pols.map(function (p) { return p.label; }).join(', ')],
      ['Modell', 'Link-Queue (mesoskopisch) · deterministisch · Seed ' + val('ctl-seed') + ' (ohne Wirkung)'],
    ];

    const rows = [['Kennzahl'].concat(pols.map(function (p) { return p.label; }))];
    for (const m of KPI_META) {
      rows.push([m.title + (m.unit ? ' (' + m.unit + ')' : '')].concat(
        pols.map(function (p) { return fmt(m.get(state.summaries[p.summaryKey]), m.dec); })));
    }

    // Charts + sichtbare Karten-Canvases als JPEG (2er-Raster mit Labels)
    const jpeg = function (canvas) { return canvas.toDataURL('image/jpeg', 0.92); };
    const images = [];
    const bars = $('chart-bars'), delay = $('chart-delay');
    if (bars && bars.width) images.push({
      caption: 'Kennzahlen im Vergleich', dataUrl: jpeg(bars),
      w: PAGE_W_NB, h: PAGE_W_NB * bars.height / bars.width, px: bars.width, py: bars.height });
    if (delay && delay.width) images.push({
      caption: 'Verlauf über die Zeit', dataUrl: jpeg(delay),
      w: PAGE_W_NB, h: PAGE_W_NB * delay.height / delay.width, px: delay.width, py: delay.height });
    const vis = visiblePolicies();
    if (vis.length) images.push(mapComposite(vis));

    const now = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes());
    const spec = {
      title: 'SignalFlow — Netzwerk-Bericht',
      subtitle: 'Distrikt-Simulation · erstellt am ' +
        now.toLocaleDateString('de-DE') + ' ' + now.toLocaleTimeString('de-DE') +
        ' · ' + (meta.generated || ''),
      sections: [{ heading: 'Randbedingungen', lines: conditions }],
      table: { heading: 'Kennzahlen im Vergleich', head: rows[0], rows: rows.slice(1) },
      images: images,
      footer: '© OpenStreetMap-Mitwirkende (ODbL) · LLM: Featherless · TTS: ElevenLabs · ' +
        'MunichTech EXPO 2026 · Code: PolyForm Noncommercial 1.0.0 — dynamisch erzeugter ' +
        'Bericht der laufenden Simulation; Modellgrenzen siehe Writeup.',
    };
    SFReport.download(SFReport.build(spec), 'signalflow-netzwerk-bericht-' + stamp + '.pdf');
  }

  // alle sichtbaren Karten-Canvases als beschriftetes 2er-Raster-Bild
  function mapComposite(vis) {
    const CW = 480, GAP = 12, LABEL = 26;
    const cols = Math.min(2, vis.length);
    const cellW = (CW - GAP * (cols - 1)) / cols;
    const ref = document.getElementById('canvas-' + vis[0].key);
    const cellH = Math.round(cellW * ref.height / ref.width);
    const rows = Math.ceil(vis.length / cols);
    const off = document.createElement('canvas');
    off.width = CW * 2;                 // doppelte Auflösung für JPEG-Schärfe
    off.height = (cellH + LABEL + GAP) * rows * 2;
    off.style.width = CW + 'px';
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.scale(2, 2);
    ctx.font = '600 12px system-ui, sans-serif';
    vis.forEach(function (p, i) {
      const cx = (i % cols) * (cellW + GAP);
      const cy = Math.floor(i / cols) * (cellH + LABEL + GAP);
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(p.label, cx + 2, cy + 13);
      ctx.drawImage(document.getElementById('canvas-' + p.key), cx, cy + LABEL,
        cellW, cellH);
    });
    const w = 503, h = Math.round(off.height / off.width * 503);
    return { caption: 'Netzkarte je Strategie', dataUrl: off.toDataURL('image/jpeg', 0.92),
             w: w, h: h, px: off.width, py: off.height };
  }

  /* ------------------------------- Start --------------------------------- */
  // dark ⇄ light theme (persisted; canvases stay dark "monitors")
  function initTheme() {
    const btn = $('btn-theme');
    const apply = function (t) {
      document.body.dataset.theme = t;
      if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
      try { localStorage.setItem('sf-theme', t); } catch (e) { /* ignore */ }
    };
    let t = 'dark';
    try { t = localStorage.getItem('sf-theme') || 'dark'; } catch (e) { /* ignore */ }
    if (t !== 'light' && t !== 'dark') t = 'dark';
    if (btn) btn.addEventListener('click', function () {
      apply(document.body.dataset.theme === 'light' ? 'dark' : 'light');
    });
    apply(t);
  }

  function bindDrill() {
    // Klick auf einen Signal-Knoten einer der Strategie-Karten (Delegation —
    // die Zellen werden je Lauf neu gebaut)
    const wrap = $('canvas-wrap');
    if (wrap) {
      wrap.addEventListener('click', function (ev) {
        const cv = ev.target.closest('canvas');
        if (!cv) return;
        const id = drillHit(cv, ev);
        if (id) openDrill(id);
      });
      wrap.addEventListener('mousemove', function (ev) {
        const cv = ev.target.closest('canvas');
        if (!cv) return;
        cv.style.cursor = drillHit(cv, ev) ? 'pointer' : 'default';
      });
    }
    const dclose = $('drill-close');
    if (dclose) dclose.addEventListener('click', closeDrill);
    // Overlay vergrößern/verkleinern (400 ↔ 640 px)
    const dsize = $('drill-size');
    if (dsize) dsize.addEventListener('click', function () {
      const panel = $('drill');
      if (!panel) return;
      panel.classList.toggle('big');
      drawDrill();
    });
    // Overlay an der Kopfzeile verschiebbar machen (PiP-Stil)
    const drillPanel = $('drill');
    if (drillPanel) {
      let dragX = 0, dragY = 0, dragging = false;
      drillPanel.addEventListener('pointerdown', function (ev) {
        if (ev.target.closest('.drill-actions')) return;
        dragging = true;
        dragX = ev.clientX - drillPanel.offsetLeft;
        dragY = ev.clientY - drillPanel.offsetTop;
        drillPanel.classList.add('dragging');
        try { drillPanel.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ }
      });
      drillPanel.addEventListener('pointermove', function (ev) {
        if (!dragging) return;
        const x = Math.max(8, Math.min(window.innerWidth - drillPanel.offsetWidth - 8,
                                        ev.clientX - dragX));
        const y = Math.max(8, Math.min(window.innerHeight - drillPanel.offsetHeight - 8,
                                        ev.clientY - dragY));
        drillPanel.style.left = x + 'px';
        drillPanel.style.top = y + 'px';
        drillPanel.style.right = 'auto';
        drillPanel.style.bottom = 'auto';
      });
      drillPanel.addEventListener('pointerup', function () {
        dragging = false;
        drillPanel.classList.remove('dragging');
      });
    }
  }

  async function init() {
    bindTransport();
    bindControls();
    bindAddRegion();
    bindDrill();
    initKpiView();
    initTheme();
    applyScenarioPreset();      // Zeitfenster passend zum Start-Szenario
    if (window.SFAsk) SFAsk.init({
      fetchJSON: fetchJSON,
      apiFetch: apiFetch,
      context: askContext,
      resultSentence: resultSentence,
      suggestions: [
        'Was bringt die grüne Welle in diesem Gebiet?',
        'Warum schlägt Tuned Adaptiv hier teils?',
        'Was passiert bei doppelter Nachfrage?',
      ],
    });
    const speakBtn = $('btn-speak-result');
    if (speakBtn) speakBtn.addEventListener('click', function () { SFAsk.speakResult(); });
    const autoChk = $('chk-autospeak');
    if (autoChk) autoChk.addEventListener('change', function (e) {
      state.autoSpeak = !!e.target.checked;
    });
    const exportBtn = $('btn-export');
    if (exportBtn) exportBtn.addEventListener('click', exportReportPdf);
    window.addEventListener('resize', function () {
      state._drawSig = null;
      renderCharts();
    });
    renderBadges();
    requestAnimationFrame(frameLoop);

    let data;
    try {
      data = await fetchJSON('api/regions');
    } catch (e) {
      showError('Backend nicht erreichbar (' + e.message + '). Starte den Server mit ' +
        '„cd signalflow && ./run.sh“ und öffne http://127.0.0.1:8000/network.html ' +
        '(die App-Vorschau kann den POST der API nicht weiterleiten).');
      disableAll();
      return;
    }
    const regions = (data && data.regions) || [];
    if (!regions.length) {
      showError('Keine Regionen verfügbar: /api/regions ist leer. Bitte OSM-Daten ' +
        'nach data/regions/ aufbereiten und den Server neu starten.');
      disableAll();
      return;
    }
    state.regions = regions;
    populateRegions(regions);
    renderStats();
    await runSimulation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
