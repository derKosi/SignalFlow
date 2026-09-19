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
    state.series = { fixed: sumSeries(state.frames.fixed), adaptive: sumSeries(state.frames.adaptive) };

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
      if (titleMain) titleMain.textContent = 'Adaptive';
      const titleAlt = $('cell-alt-title');
      if (titleAlt) titleAlt.textContent = 'Fixed';
      drawNetwork(cMain, 'adaptive');
      drawNetwork($('canvas-alt'), 'fixed');
    } else {
      wrap.classList.remove('dual');
      if (titleMain) titleMain.textContent = state.mode === 'fixed' ? 'Fixed-Time' : 'Adaptive';
      drawNetwork(cMain, state.mode === 'fixed' ? 'fixed' : 'adaptive');
    }

    // Readouts
    const tEl = $('playhead-t');
    if (tEl) tEl.textContent = timeStr(state.t);
    const qEl = $('playhead-q');
    if (qEl) {
      const arr = state.series.adaptive || [];
      const idx = state.steps ? clamp(Math.round(state.t / Math.max(1, state.frameDt)), 0, arr.length - 1) : 0;
      qEl.textContent = arr.length ? fmt(arr[idx] || 0, 0) + ' veh' : '–';
    }
  }

  /* -------------------------------- KPIs --------------------------------- */
  const KPI_META = [
    { title: 'Ø Verzögerung', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_delay_s; } },
    { title: 'Durchsatz', unit: 'veh/h', dir: 'up', dec: 0, get: function (s) { return s.throughput_vph; } },
    { title: 'Ø Reisezeit', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.avg_travel_time_s; } },
    { title: 'CO₂-Proxy', unit: 'g', dir: 'down', dec: 0, get: function (s) { return s.co2_g; } },
    { title: 'Trips abgeschl.', unit: '', dir: 'up', dec: 0, get: function (s) { return s.served; } },
    { title: 'Korridor Ø-Verzög.', unit: 's', dir: 'down', dec: 1, get: function (s) { return s.corridor_delay_s; } },
  ];

  function deltaPct(fx, ad, dir) {
    if (!fx) return 0;
    return dir === 'up' ? (ad - fx) / fx * 100 : (fx - ad) / fx * 100;
  }

  function renderKPIs() {
    const grid = $('kpi-grid');
    if (!grid) return;
    const res = state.result;
    if (!res) { grid.innerHTML = ''; return; }
    const fx = res.summary.fixed, ad = res.summary.adaptive, co = res.summary.coordinated;
    const te = res.summary.fixed_tuned_est;
    let html = '';
    KPI_META.forEach(function (m) {
      const fv = m.get(fx), av = m.get(ad);
      const d = deltaPct(fv, av, m.dir);
      const cls = d > 0.05 ? 'good' : (d < -0.05 ? 'bad' : 'neutral');
      const sign = d > 0 ? '+' : '';
      let coRow = '', coDelta = '';
      if (co && m.get(co) != null) {
        const cv = m.get(co);
        const d2 = deltaPct(fv, cv, m.dir);
        const cls2 = d2 > 0.05 ? 'good' : (d2 < -0.05 ? 'bad' : 'neutral');
        coRow = '<div class="row coordinated"><span class="tag">Koord.</span><b>' + fmt(cv, m.dec) + '</b></div>';
        coDelta = '<span class="delta coordinated ' + cls2 + '">Welle ' + (d2 > 0 ? '+' : '') + fmt(d2, 1) + ' %</span>';
      }
      let teRow = '';
      if (te && m.get(te) != null) {
        teRow = '<div class="row tuned-est"><span class="tag" title="Fester Plan, getunt aus Detektor-Z&auml;hlungen (OD-Sch&auml;tzung) statt echter Nachfrage — fairere Baseline ohne Oracle-Wissen">Tuned*</span><b>' + fmt(m.get(te), m.dec) + '</b></div>';
      }
      html += '<div class="kpi">' +
        '<header><h3>' + m.title + '</h3><span class="unit">' + (m.unit || '') + '</span></header>' +
        '<div class="kpi-rows">' +
        '<div class="row fixed"><span class="tag">Fixed</span><b>' + fmt(fv, m.dec) + '</b></div>' +
        '<div class="row adaptive"><span class="tag">Adaptiv</span><b>' + fmt(av, m.dec) + '</b></div>' +
        coRow +
        teRow +
        '</div>' +
        '<span class="delta ' + cls + '">' + sign + fmt(d, 1) + ' %</span>' + coDelta +
        '</div>';
    });
    grid.innerHTML = html;
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

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.mode || 'adaptive';
        document.querySelectorAll('.mode-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
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
  async function init() {
    bindTransport();
    bindControls();
    bindAddRegion();
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
