/* ============================================================================
 * SignalFlow – Netzwerksimulation (vanilla JS, keine Abhängigkeiten)
 * ----------------------------------------------------------------------------
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

  /* ------------------------------- State --------------------------------- */
  const state = {
    regions: [],
    regionMeta: null,        // {id,name,bbox,stats}
    result: null,
    frames: { fixed: [], adaptive: [] },
    series: { fixed: [], adaptive: [] }, // Summe Queue je Frame
    bbox: null,
    nodeUV: new Map(),       // id -> {u,v} normiert auf bbox
    steps: 0,
    frameDt: 3,
    mode: 'both',            // 'fixed' | 'adaptive' | 'both'
    playing: false,
    speed: 1,
    t: 0,                    // Simulationssekunden
    busy: false,
    pending: false,
    dirty: false,
    startTs: 0,
    autoSpeak: false,
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
      const lbl = btn.querySelector('.btn-label');
      if (lbl) lbl.textContent = on ? 'Simuliert …' : 'Simulieren';
    }
    if (bar) {
      bar.classList.remove('hidden');
      bar.classList.toggle('running', on);
      bar.classList.toggle('done', !on);
      if (!on) setTimeout(function () { show(bar, false); bar.classList.remove('done', 'running'); }, 500);
    }
    ['ctl-region', 'ctl-duration', 'ctl-load', 'ctl-scenario', 'ctl-mix', 'ctl-tsp', 'ctl-seed', 'ctl-vph', 'btn-run']
      .forEach(function (id) { const el = $(id); if (el) el.disabled = on; });
  }

  function disableAll() {
    ['ctl-region', 'ctl-duration', 'ctl-load', 'ctl-scenario', 'ctl-mix', 'ctl-tsp', 'ctl-seed', 'ctl-vph',
      'btn-run', 'btn-play', 'progress'].forEach(function (id) {
      const el = $(id); if (el) el.disabled = true;
    });
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

  // Filter für die Gebietsliste (die Liste wächst per „Ort hinzufügen”)
  function applyRegionFilter(q) {
    const sel = $('ctl-region');
    if (!sel) return;
    const needle = (q || '').toLowerCase().trim();
    let visible = 0, firstVisible = null;
    [...sel.options].forEach(function (o) {
      const match = !needle || o.textContent.toLowerCase().indexOf(needle) >= 0
        || o.value.toLowerCase().indexOf(needle) >= 0;
      o.hidden = !match;
      if (match) { visible++; if (!firstVisible) firstVisible = o; }
    });
    if (visible && sel.selectedOptions[0] && sel.selectedOptions[0].hidden) {
      sel.value = firstVisible.value;
      state.regionMeta = state.regions.find(function (r) { return r.id === sel.value; })
        || { id: sel.value };
      renderStats();
      runSimulation();
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
      duration_min: Number($('ctl-duration').value),
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
  function projectNodes(bbox) {
    const s = bbox[0], w = bbox[1], n = bbox[2], e = bbox[3];
    const dLat = Math.max(1e-9, n - s);
    const dLon = Math.max(1e-9, e - w);
    return { s: s, w: w, n: n, e: e, dLat: dLat, dLon: dLon };
  }

  function applyResult(res) {
    if (!res || !res.network || !res.summary || !res.summary.fixed || !res.summary.adaptive) {
      showError('Ungültige Serverantwort – konnte nicht gerendert werden.');
      return;
    }
    state.result = res;
    state.bbox = res.bbox || (state.regionMeta && state.regionMeta.bbox) || null;
    state.frames = {
      fixed: (res.frames && res.frames.fixed) || [],
      adaptive: (res.frames && res.frames.adaptive) || [],
      coordinated: (res.frames && res.frames.coordinated) || [],
    };
    state.steps = (res.meta && res.meta.steps) || (res.config ? res.config.duration_min * 60 : 0);
    state.frameDt = (res.meta && res.meta.frame_dt) || (res.config && res.config.frame_dt) || 3;

    // normierte Knotenkoordinaten (bbox -> [0,1], y invertiert)
    state.nodeUV = new Map();
    if (state.bbox) {
      const p = projectNodes(state.bbox);
      (res.network.nodes || []).forEach(function (nd) {
        state.nodeUV.set(nd.id, {
          u: (nd.lon - p.w) / p.dLon,
          v: (p.n - nd.lat) / p.dLat,
        });
      });
    }

    // Zeitreihen (Summe der Queues je Frame)
    function sumSeries(frames) {
      return (frames || []).map(function (f) {
        let t = 0;
        const q = f.q || [];
        for (let i = 0; i < q.length; i++) t += q[i][1] || 0;
        return t;
      });
    }
    state.series = { fixed: sumSeries(state.frames.fixed), adaptive: sumSeries(state.frames.adaptive),
                     coordinated: sumSeries(state.frames.coordinated) };

    // Region-Meta (Name/BBox) mit Antwort abgleichen
    state.regionMeta = state.regionMeta || {};
    state.regionMeta.bbox = state.bbox;

    state.t = 0;
    state.startTs = 0;
    state.playing = true;
    setPlaying(true);

    renderStats();
    renderKPIs();
    renderCharts();
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

  // Projektions-Transform für ein gegebenes Canvas (Seitenverhältnis beachtet)
  function makeProj(w, h) {
    const b = state.bbox;
    const pad = 12;
    if (!b) return null;
    const midLat = (b[0] + b[2]) / 2;
    const worldW = (b[3] - b[1]) * Math.cos(midLat * Math.PI / 180);
    const worldH = (b[2] - b[0]);
    const scale = Math.min((w - 2 * pad) / Math.max(1e-9, worldW),
      (h - 2 * pad) / Math.max(1e-9, worldH));
    const offX = (w - worldW * scale) / 2;
    const offY = (h - worldH * scale) / 2;
    return function (uv) {
      return [offX + uv.u * worldW * scale, offY + uv.v * worldH * scale];
    };
  }

  function drawNetwork(canvas, which) {
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    // Hintergrund
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);

    if (!state.result || !state.bbox) { centerText(ctx, w, h, 'Keine Daten'); return; }
    const frames = state.frames[which] || [];
    if (!frames.length) { centerText(ctx, w, h, 'Keine Frames'); return; }

    const proj = makeProj(w, h);
    const nodes = state.result.network.nodes || [];
    const links = state.result.network.links || [];
    const signalSet = new Set(state.result.network.signal_nodes || []);

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

  function drawActiveCanvases() {
    const wrap = $('canvas-wrap');
    if (!wrap) return;
    const cMain = $('canvas-main');
    const titleMain = $('cell-main-title');
    if (state.mode === 'both') {
      wrap.classList.add('dual');
      if (titleMain) titleMain.textContent = 'Fixed';      // links Fixed, rechts Adaptive
      const titleAlt = $('cell-alt-title');
      if (titleAlt) titleAlt.textContent = 'Adaptive';
      drawNetwork(cMain, 'fixed');
      drawNetwork($('canvas-alt'), 'adaptive');
    } else {
      wrap.classList.remove('dual');
      if (titleMain) {
        titleMain.textContent = state.mode === 'fixed' ? 'Fixed-Time'
          : (state.mode === 'coordinated' ? 'Koord. (Welle)' : 'Adaptive');
      }
      drawNetwork(cMain, state.mode === 'fixed' ? 'fixed' : state.mode);
    }

    // Readouts
    const tEl = $('playhead-t');
    if (tEl) tEl.textContent = 't ' + timeStr(state.t) + ' / ' + timeStr(state.steps);
    const qEl = $('playhead-q');
    if (qEl) {
      const serKey = state.mode === 'both' ? 'adaptive' : state.mode;
      const arr = state.series[serKey] || [];
      const idx = state.steps ? clamp(Math.round(state.t / Math.max(1, state.frameDt)), 0, arr.length - 1) : 0;
      qEl.textContent = arr.length ? fmt(arr[idx] || 0, 0) + ' veh' : '–';
    }
    updateDrillHead();
    if (state.drill) drawDrill();
  }

  /* ------------------------- Knoten-Drilldown ---------------------------- */
  // Click a signalised node on the map -> junction close-up in an overlay:
  // arms at their TRUE bearings (north up, i.e. correctly rotated), queues
  // from the link data of the current frame, signal colours from the node's
  // real phase (axis 0 = N/S feeds, axis 1 = E/W feeds — same split the
  // server's controller uses).

  function rrLocal(ctx, x, y, rw, rh, r) {
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
    const title = $('drill-title'), sub = $('drill-sub');
    const label = state.mode === 'fixed' ? 'Fixed-Time'
      : (state.mode === 'coordinated' ? 'Koord. (Welle)' : 'Adaptiv');
    if (title) title.textContent = d.type + ' · ' + d.arms.length + ' Straßen';
    if (sub) {
      sub.textContent = (d.names.length ? d.names.join(' · ') + ' — ' : '') + label + ' · Norden oben';
      sub.title = 'Knoten ' + d.nodeId;
    }
  }

  function drawDrill() {
    const d = state.drill;
    const canvas = $('drill-canvas');
    if (!d || !canvas || !state.result) return;
    const which = state.mode === 'fixed' ? 'fixed'
      : (state.mode === 'coordinated' ? 'coordinated' : 'adaptive');
    const frames = state.frames[which] || [];
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
    const phText = phase === 0 ? 'Achse N–S frei' : 'Achse O–W frei';
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

  /* -------------------------------- KPIs --------------------------------- */
  const KPI_META = [
    { title: 'Ø Verzögerung', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_delay_s; },
      info: 'Mittlere Verzögerung je Fahrzeug im ganzen Gebiet (Sekunden) — Wartezeit vor Rot plus Anfahrverluste. Weniger ist besser.' },
    { title: 'Durchsatz', unit: 'veh/h', dir: 'up', dec: 0, get: function (s) { return s.throughput_vph; },
      info: 'Fahrzeuge pro Stunde, die das Gebiet passieren. Mehr ist besser.' },
    { title: 'Ø Reisezeit', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_travel_time_s; },
      info: 'Mittlere Gesamtreisezeit je Trip von Einfahrt bis Ausfahrt (Sekunden). Weniger ist besser.' },
    { title: 'CO₂-Proxy', unit: 'g', dir: 'down', dec: 0, get: function (s) { return s.co2_g; },
      info: 'Geschätzter CO₂-Ausstoß aus Stand- und Verzögerungszeiten (Gramm) — aus Leerlauf-Zeiten hochgerechnet, keine Messung. Weniger ist besser.' },
    { title: 'Trips abgeschl.', unit: '', dir: 'up', dec: 0, get: function (s) { return s.served; },
      info: 'Im Simulationszeitraum abgeschlossene Fahrten. Mehr ist besser.' },
    { title: 'Korridor Ø-Verzög.', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.corridor_delay_s; },
      info: 'Verzögerung nur entlang des stärksten Korridors (Referenzstrecke der grünen Welle, Sekunden). Weniger ist besser.' },
  ];

  function deltaPct(fx, ad, dir) {
    if (!fx) return 0;
    return dir === 'up' ? (ad - fx) / fx * 100 : (fx - ad) / fx * 100;
  }

  function renderKPIs() {
    const grid = $('kpi-grid');
    const tableWrap = $('kpi-table-wrap');
    if (!grid) return;
    const res = state.result;
    if (!res) { grid.innerHTML = ''; if (tableWrap) tableWrap.innerHTML = ''; return; }
    const fx = res.summary.fixed, ad = res.summary.adaptive, co = res.summary.coordinated;
    const te = res.summary.fixed_tuned_est;
    const POLICY_INFO = {
      fixed: 'Fester Signalplan mit vordefinierten Grünzeiten — reagiert nicht auf den live Verkehr (Baseline)',
      adaptive: 'SignalFlow: Phasenlängen reagieren live auf den Warteschlangen-Druck jeder Richtung (Max-Pressure)',
      coordinated: 'Grüne Welle: feste Versatz-Offsets zwischen benachbarten Ampeln entlang des Korridors',
      tuned: 'Fester Plan, getunt aus Detektor-Zählungen (OD-Schätzung) statt echter Nachfrage — fairere Baseline ohne Oracle-Wissen. Je nach Netz schlägt sie Adaptive (kurzmaschige Grids wie Berlin/Hamburg) oder verliert (z. B. Riem/Köln) — siehe docs/results.md.',
    };
    const clsFor = function (d) { return d > 5 ? 'good' : (d < -5 ? 'bad' : 'mid'); };
    // Δ gegenüber Fixed-Time als schlichte Zahl (kein Pill), positiv = besser
    const dltOf = function (m, val, base) {
      if (base == null || !base || val == null) return '';
      const dd = deltaPct(base, val, m.dir);
      return '<i class="dlt ' + clsFor(dd) + '" title="Δ gegenüber Fixed-Time — positiv = besser">'
        + (dd > 0 ? '+' : '') + fmt(dd, 1) + ' %</i>';
    };
    // Gewinner je Kennzahl: bester Wert über alle Richtungen (Richtung beachtet)
    const winnerOf = function (m) {
      const cand = [[m.get(fx), 'fixed'], [m.get(ad), 'adaptive']];
      if (co && m.get(co) != null) cand.push([m.get(co), 'coordinated']);
      if (te && m.get(te) != null) cand.push([m.get(te), 'tuned']);
      let best = null;
      cand.forEach(function (c) {
        if (c[0] == null) return;
        if (best == null) { best = c; return; }
        if (m.dir === 'up' ? c[0] > best[0] : c[0] < best[0]) best = c;
      });
      return best ? best[1] : null;
    };
    let html = '';
    KPI_META.forEach(function (m) {
      const fv = m.get(fx), av = m.get(ad);
      const d = deltaPct(fv, av, m.dir);
      const cls = clsFor(d);
      const sign = d > 0 ? '+' : '';
      let coRow = '', coDelta = '';
      if (co && m.get(co) != null) {
        const cv = m.get(co);
        const d2 = deltaPct(fv, cv, m.dir);
        coRow = '<div class="row coordinated"><span class="tag" title="' + POLICY_INFO.coordinated + '">Koord.</span><b>' + fmt(cv, m.dec) + '</b></div>';
        coDelta = '<span class="delta coordinated ' + clsFor(d2) + '">Welle ' + (d2 > 0 ? '+' : '') + fmt(d2, 1) + ' %</span>';
      }
      let teRow = '';
      if (te && m.get(te) != null) {
        teRow = '<div class="row tuned-est"><span class="tag" title="' + POLICY_INFO.tuned + '">Tuned*</span><b>' + fmt(m.get(te), m.dec) + '</b></div>';
      }
      const win = winnerOf(m);
      // 3-Spalten-Zeile: Label | Δ% (Zeilenfarbe) | Wert (bester fett)
      const row = (cls, label, info, v, isWin, dlt) =>
        '<div class="row ' + cls + '"><span class="tag" title="' + info + '">' + label + '</span>' +
        '<i class="dlt">' + dlt + '</i>' +
        '<b class="' + (isWin ? 'best' : '') + '">' + v + '</b></div>';
      if (co && m.get(co) != null) {
        coRow = row('coordinated', 'Koord.', POLICY_INFO.coordinated, fmt(m.get(co), m.dec),
                    win === 'coordinated', dltOf(m, m.get(co), fv).replace(/<\/?i[^>]*>/g, ''));
      }
      if (te && m.get(te) != null) {
        teRow = row('tuned-est', 'Tuned*', POLICY_INFO.tuned, fmt(m.get(te), m.dec),
                    win === 'tuned', dltOf(m, m.get(te), fv).replace(/<\/?i[^>]*>/g, ''));
      }
      html += '<div class="kpi">' +
        '<header><h3 title="' + m.info + '">' + m.title + '</h3><span class="unit">' + (m.unit || '') + '</span></header>' +
        '<div class="kpi-rows">' +
        row('fixed', 'Fixed', POLICY_INFO.fixed, fmt(fv, m.dec), win === 'fixed', '') +
        row('adaptive', 'Adaptiv', POLICY_INFO.adaptive, fmt(av, m.dec), win === 'adaptive',
            dltOf(m, av, fv).replace(/<\/?i[^>]*>/g, '')) +
        coRow +
        teRow +
        '</div>' +
        '</div>';
    });
    grid.innerHTML = html;
    if (tableWrap) {
      // gruppierte Matrix: je Kennzahl zwei Spalten (Wert | Δ vs. Fixed) unter
      // einer Überschrift; Werte + Δ in Strategien-Farbe, bester Wert fett
      const dltTxt = function (m, val, base) {
        if (base == null || !base || val == null) return '–';
        const dd = deltaPct(base, val, m.dir);
        return (dd > 0 ? '+' : '') + fmt(dd, 1) + ' %';
      };
      const headCells = KPI_META.map(function (m) {
        return '<th colspan="2" title="' + m.info + '">' + m.title + (m.unit ? ' <span class="unit">' + m.unit + '</span>' : '') + '</th>';
      }).join('');
      const subHeads = KPI_META.map(function () {
        return '<th class="sub">Wert</th><th class="sub">Δ</th>';
      }).join('');
      const cells = function (src, pol) {
        return KPI_META.map(function (m) {
          const best = winnerOf(m) === pol ? ' best' : '';
          return '<td class="v' + best + '">' + fmt(m.get(src), m.dec) + '</td>' +
                 '<td class="dltc">' + dltTxt(m, m.get(src), m.get(fx)) + '</td>';
        }).join('');
      };
      const fixedCells = KPI_META.map(function (m) {
        return '<td class="v' + (winnerOf(m) === 'fixed' ? ' best' : '') + '">' + fmt(m.get(fx), m.dec) + '</td><td class="dltc">–</td>';
      }).join('');
      let extraRows = '';
      if (co) {
        extraRows += '<tr class="pol-coordinated"><th class="pol" title="' + POLICY_INFO.coordinated + '">Koord.</th>' + cells(co, 'coordinated') + '</tr>';
      }
      if (te) {
        extraRows += '<tr class="pol-tuned"><th class="pol" title="' + POLICY_INFO.tuned + '">Tuned*</th>' + cells(te, 'tuned') + '</tr>';
      }
      tableWrap.innerHTML = '<table class="kpi-table">' +
        '<thead><tr><th rowspan="2"></th>' + headCells + '</tr><tr>' + subHeads + '</tr></thead><tbody>' +
        '<tr class="pol-fixed"><th class="pol" title="' + POLICY_INFO.fixed + '">Fixed</th>' + fixedCells + '</tr>' +
        '<tr class="pol-adaptive"><th class="pol" title="' + POLICY_INFO.adaptive + '">Adaptiv</th>' + cells(ad, 'adaptive') + '</tr>' +
        extraRows + '</tbody></table>';
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

  function chartTitle(canvas, left, right) {
    const fit = fitCanvas(canvas);
    return fit;
  }

  function drawBars(canvas) {
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    if (!state.result) { centerText(ctx, w, h, 'Keine Daten'); return; }
    const imp = state.result.improvement || {};
    const fx = state.result.summary.fixed, ad = state.result.summary.adaptive;

    const metrics = [
      { label: 'Ø Verzög.', v: imp.avg_delay_pct != null ? imp.avg_delay_pct : deltaPct(fx.avg_delay_s, ad.avg_delay_s, 'down') },
      { label: 'Durchsatz', v: imp.throughput_pct != null ? imp.throughput_pct : deltaPct(fx.throughput_vph, ad.throughput_vph, 'up') },
      { label: 'Ø Reisezeit', v: imp.avg_travel_pct != null ? imp.avg_travel_pct : deltaPct(fx.avg_travel_time_s, ad.avg_travel_time_s, 'down') },
      { label: 'CO₂', v: imp.co2_pct != null ? imp.co2_pct : deltaPct(fx.co2_g, ad.co2_g, 'down') },
      { label: 'Trips', v: deltaPct(fx.served, ad.served, 'up') },
    ];

    const padL = 40, padR = 14, padT = 22, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const n = metrics.length;
    const groupW = plotW / n;
    const barW = Math.min(46, groupW * 0.5);

    const vmax = Math.max(5, Math.max.apply(null, metrics.map(function (m) { return Math.abs(m.v || 0); })));
    const zeroY = padT + plotH / 2;   // 0-Linie in der Mitte (pos +, neg -)

    // Grid
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = padT + plotH * i / 2;
      line(ctx, padL, y, padL + plotW, y);
    }
    ctx.strokeStyle = COL.axis;
    line(ctx, padL, zeroY, padL + plotW, zeroY);

    // Achsenbeschriftung (%)
    ctx.fillStyle = COL.faint; ctx.font = '11px ' + FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('+' + vmax.toFixed(0) + '%', padL - 6, padT);
    ctx.fillText('0', padL - 6, zeroY);
    ctx.fillText('-' + vmax.toFixed(0) + '%', padL - 6, padT + plotH);

    metrics.forEach(function (m, i) {
      const cx = padL + groupW * (i + 0.5);
      const v = m.v || 0;
      const hgt = (Math.abs(v) / vmax) * (plotH / 2 - 4);
      const y = v >= 0 ? zeroY - hgt : zeroY;
      const good = v > 0.05;
      const bad = v < -0.05;
      ctx.fillStyle = good ? '#22c55e' : (bad ? '#ef4444' : '#64748b');
      ctx.globalAlpha = 0.88;
      ctx.fillRect(cx - barW / 2, y, barW, Math.max(1, hgt));
      ctx.globalAlpha = 1;

      // Wert
      ctx.fillStyle = '#dbe4ee';
      ctx.font = '600 12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = v >= 0 ? 'bottom' : 'top';
      ctx.fillText((v > 0 ? '+' : '') + fmt(v, 1) + '%', cx, v >= 0 ? y - 4 : y + hgt + 4);

      // Label
      ctx.fillStyle = COL.txt;
      ctx.font = '11px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(m.label, cx, padT + plotH + 8);
    });

    // Hinweis
    ctx.fillStyle = COL.faint; ctx.font = '10.5px ' + FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Δ Adaptive vs. Fixed (positiv = besser)', padL, padT - 18);
  }

  function drawLoadChart(canvas) {
    const fit = fitCanvas(canvas);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    if (!state.result) { centerText(ctx, w, h, 'Keine Daten'); return; }

    const fx = state.series.fixed || [], ad = state.series.adaptive || [];
    if (!fx.length && !ad.length) { centerText(ctx, w, h, 'Keine Frames'); return; }

    const padL = 44, padR = 14, padT = 24, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    let ymax = 1;
    fx.forEach(function (v) { if (v > ymax) ymax = v; });
    ad.forEach(function (v) { if (v > ymax) ymax = v; });
    ymax = Math.ceil(ymax * 1.15);

    // Grid
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      line(ctx, padL, y, padL + plotW, y);
    }
    // Y-Labels
    ctx.fillStyle = COL.faint; ctx.font = '10.5px ' + FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      ctx.fillText(fmt(ymax * (1 - i / 4), 0), padL - 6, y);
    }
    // X-Labels (Minuten)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const mins = Math.max(1, Math.round(state.steps / 60));
    const ticks = Math.min(6, mins);
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const x = padL + plotW * frac;
      ctx.fillText(Math.round(mins * frac) + '′', x, padT + plotH + 8);
    }

    function plot(series, color, width) {
      if (!series.length) return;
      const n = series.length;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = padL + plotW * (n > 1 ? i / (n - 1) : 0);
        const y = padT + plotH * (1 - clamp(series[i] / ymax, 0, 1));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    plot(fx, '#64748b', 1.8);      // Fixed
    plot(ad, '#2dd4bf', 2.2);      // Adaptive

    // Playhead
    if (state.steps) {
      const x = padL + plotW * clamp(state.t / state.steps, 0, 1);
      ctx.strokeStyle = 'rgba(56,189,248,.7)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      line(ctx, x, padT, x, padT + plotH);
      ctx.setLineDash([]);
    }

    // Titel + Legende
    ctx.fillStyle = COL.faint; ctx.font = '10.5px ' + FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Summe Warteschlangen (veh)', padL, padT - 18);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#64748b'; ctx.fillText('■ Fixed', w - padR - 74, padT - 18);
    ctx.fillStyle = '#2dd4bf'; ctx.fillText('■ Adaptive', w - padR, padT - 18);
  }

  function renderCharts() {
    drawBars($('chart-bars'));
    drawLoadChart($('chart-load'));
  }

  function renderMeta() {
    const el = $('meta-info');
    if (!el) return;
    const res = state.result;
    if (!res) { el.textContent = 'Keine Simulation geladen.'; return; }
    const c = res.config || {};
    el.textContent = (res.name || res.region) + ' · Determinismus: Seed ' + fmt(c.seed, 0) +
      ' · Dauer ' + fmt(c.duration_min, 0) + ' min · Profil ' + (c.demand_profile || '–') +
      ' · dt = 1 s · ' + ((res.meta && res.meta.generated) || '');
  }

  /* ------------------------------ Transport ------------------------------ */
  function setPlaying(p) {
    state.playing = p;
    const b = $('btn-play');
    if (b) { b.textContent = p ? '❚❚' : '▶'; b.title = p ? 'Pause' : 'Play'; }
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

  let lastTs = 0;
  function frameLoop(ts) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (state.playing && state.result) {
      state.t += dt * state.speed * playbackRate();
      if (state.t >= state.steps) { state.t = state.steps; setPlaying(false); }
    }
    updateProgress();
    drawActiveCanvases();
    if (state.result) drawLoadChart($('chart-load'));
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

  function bindControls() {
    const dur = $('ctl-duration'), load = $('ctl-load'), seed = $('ctl-seed'), vph = $('ctl-vph');
    const prof = $('ctl-scenario'), region = $('ctl-region');

    const syncVals = function () {
      if ($('val-duration')) $('val-duration').textContent = dur.value;
      if ($('val-load')) $('val-load').textContent = Number(load.value).toFixed(2);
      if ($('val-seed')) $('val-seed').textContent = seed.value;
      if ($('val-vph')) $('val-vph').textContent = vph.value;
      [dur, load, seed, vph].forEach(setRangeFill);
    };

    // sliders + profile: only mark dirty (no auto-run)
    [dur, load, seed, vph].forEach(function (el) {
      el.addEventListener('input', function () { syncVals(); markDirty(); });
    });
    prof.addEventListener('change', function () { syncVals(); markDirty(); });
    ['ctl-mix', 'ctl-tsp'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', markDirty);
    });
    // switching region is a deliberate action -> load it right away
    region.addEventListener('change', function () {
      const id = region.value;
      state.regionMeta = state.regions.find(function (r) { return r.id === id; }) || { id: id };
      renderStats();
      runSimulation();
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
      });
    });

    // viewer mode only — .ask-mode buttons belong to the ask panel (ask.js)
    const viewerModeBtns = document.querySelectorAll('.modes:not(.ask-mode) .mode-btn');
    viewerModeBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.mode || 'adaptive';
        viewerModeBtns.forEach(function (x) { x.classList.toggle('active', x === b); });
        drawActiveCanvases();
      });
    });

    const prog = $('progress');
    if (prog) {
      prog.addEventListener('input', function () {
        if (!state.steps) return;
        state.t = clamp(Number(prog.value) / 100, 0, 1) * state.steps;
        setRangeFill(prog);
        drawActiveCanvases();
        if (state.result) drawLoadChart($('chart-load'));
      });
    }
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

  async function init() {
    bindTransport();
    bindControls();
    bindAddRegion();
    initKpiView();
    initTheme();
    if (window.SFAsk) SFAsk.init({
      fetchJSON: fetchJSON,
      apiFetch: apiFetch,
      context: askContext,
      resultSentence: resultSentence,
    });
    const speakBtn = $('btn-speak-result');
    if (speakBtn) speakBtn.addEventListener('click', function () { SFAsk.speakResult(); });
    const autoChk = $('chk-autospeak');
    if (autoChk) autoChk.addEventListener('change', function (e) {
      state.autoSpeak = !!e.target.checked;
    });
    const exportBtn = $('btn-export');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      const cv = document.getElementById('canvas-main');
      if (!cv) return;
      cv.toBlob(function (blob) {          // object-URL: data:-URLs break past ~2 MB
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'signalflow-netzwerk.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }, 'image/png');
    });
    // Knoten-Drilldown: Klick auf einen Signal-Knoten der Karte
    // (beide Karten — im Modus „Beide" zeigen links Adaptive, rechts Fixed)
    ['canvas-main', 'canvas-alt'].forEach(function (cid) {
      const cv = $(cid);
      if (!cv) return;
      cv.addEventListener('click', function (ev) {
        const id = drillHit(cv, ev);
        if (id) openDrill(id);
      });
      cv.addEventListener('mousemove', function (ev) {
        cv.style.cursor = drillHit(cv, ev) ? 'pointer' : 'default';
      });
    });
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
    renderBadges();
    requestAnimationFrame(frameLoop);

    let data;
    try {
      data = await fetchJSON('api/regions');
    } catch (e) {
      showError('Backend nicht erreichbar (' + e.message + '). Starte den Server mit ' +
        '„cd signalflow && ./run.sh\u201c und öffne http://127.0.0.1:8000/network.html ' +
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
