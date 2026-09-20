/* ============================================================================
 * SignalFlow – "Frag SignalFlow" ask panel.
 * Shared by the junction dashboard (index.html) and the network page
 * (network.html). Each page injects its world via SFAsk.init(opts):
 *
 *   opts.fetchJSON(url, init)  – JSON POST helper (CORS-fallback aware)
 *   opts.apiFetch(url, init)   – raw fetch helper (used for /api/tts blobs)
 *   opts.context()             – {kind:'junction'} or
 *                                {kind:'network', region, name, scenario,
 *                                 result:{region,name,scenario,summary,
 *                                         improvement}}
 *                                The network result rides along with explain
 *                                requests so the server narrates the district
 *                                run on screen instead of the last junction.
 *   opts.resultSentence()      – spoken one-liner for "Ergebnis vorlesen"
 *   opts.suggestions: [q, …]   – one-click example questions (chips)
 *   opts.computeAnswer(q)      – optional local answer for specific questions
 *                                (computed from on-screen data, no server round
 *                                trip); return null to fall through to the API
 *
 * The panel owns every #ask-* DOM id and remembers the last answer for TTS.
 * ==========================================================================*/
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let opts = null;
  let answer = '';

  // One human-readable line per tool result digest.
  function digestLine(digest) {
    if (!digest) return '';
    if (digest.ok === false) return 'Fehler: ' + (digest.error || 'unbekannt');
    if (digest.tool === 'simulate_network') {
      const s = digest.policies || {};
      const f = (s.fixed || {}).avg_delay_s, a = (s.adaptive || {}).avg_delay_s;
      return 'Fester Plan ' + f + ' s → adaptiv ' + a + ' s mittlere Verzögerung' +
        (digest.improvement && digest.improvement.avg_delay_pct != null
          ? ' (' + digest.improvement.avg_delay_pct + ' %)' : '');
    }
    const f = digest.fixed || {}, a = digest.adaptive || {}, i = digest.improvement || {};
    return f.avg_delay_s + ' s → ' + a.avg_delay_s + ' s mittlere Verzögerung' +
      (i.avg_delay_pct != null ? ' (' + i.avg_delay_pct + ' %)' : '');
  }

  // Collapsible trace: which tool ran, with which arguments, and what came back.
  function renderAskSteps(steps, note) {
    const box = $('ask-steps'), list = $('ask-steps-list');
    if (!box || !list) return;
    list.innerHTML = '';
    $('ask-steps-n').textContent = String(steps.length);
    if (!steps.length && !note) { box.hidden = true; return; }
    steps.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'ask-step' + (s.ok === false ? ' step-error' : '');
      row.innerHTML =
        '<div class="ask-step-head"><span class="ask-step-tool">' + escapeHtml(String(s.tool)) +
        '</span><code>' + escapeHtml(JSON.stringify(s.args || {})) + '</code></div>' +
        '<div class="ask-step-digest">' + escapeHtml(digestLine(s.digest)) + '</div>';
      list.appendChild(row);
    });
    if (note) {
      const n = document.createElement('div');
      n.className = 'ask-step-note';
      n.textContent = note;
      list.appendChild(n);
    }
    box.hidden = false;
  }

  // Ask panel has three modes: agent (runs the simulator as a tool), panel
  // (the same, plus critic + writer self-check), and the fast explainer
  // (narrates the run currently on screen via /api/explain).
  let askMode = 'agent';
  const ASK_PLACEHOLDER = {
    agent: 'z. B. Was passiert in den Ferien mit 15 % Lkw?',
    panel: 'z. B. Warum sinkt der Durchsatz in den Ferien?',
    explain: 'z. B. Warum wechselt die Phase so oft?',
  };
  const ASK_MODES = ['agent', 'panel', 'explain'];

  function setAskMode(mode) {
    askMode = ASK_MODES.includes(mode) ? mode : 'agent';
    for (const m of ASK_MODES) {
      const el = $('ask-mode-' + m);
      if (el) el.classList.toggle('active', askMode === m);
    }
    const input = $('ask-input');
    if (input) input.placeholder = ASK_PLACEHOLDER[askMode];
    renderChips();
  }

  // Build (endpoint, body) for the current mode, carrying the page context
  // so network questions are answered for the district on screen.
  function askRequest(q) {
    const ctx = (opts.context && opts.context()) || { kind: 'junction' };
    if (askMode === 'explain') {
      const body = { question: q, scope: 'compare' };
      if (ctx.kind === 'network' && ctx.result) body.result = ctx.result;
      return { endpoint: '/api/explain', body: body };
    }
    const body = { question: q, max_rounds: 3,
                   mode: askMode === 'panel' ? 'panel' : 'solo' };
    if (ctx.kind === 'network') {
      body.context = { kind: 'network', region: ctx.region,
                       name: ctx.name, scenario: ctx.scenario };
    }
    return { endpoint: '/api/agent', body: body };
  }

  async function askExplain() {
    const q = $('ask-input').value.trim();
    if (!q) return;
    // locally computed answers first (deterministic, from on-screen data)
    const local = (opts.computeAnswer && opts.computeAnswer(q)) || null;
    if (local) {
      answer = local.answer;
      $('ask-answer').textContent = answer;
      renderAskSteps(local.steps || [], null);
      const src = $('ask-source');
      src.className = 'source-pill local';
      src.textContent = local.source || 'Analyse · lokal berechnet';
      return;
    }
    const btn = $('ask-send');
    btn.disabled = true; btn.textContent = 'Denkt…';
    $('ask-answer').textContent = '…';
    try {
      const req = askRequest(q);
      const res = await opts.fetchJSON(req.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      answer = res.answer || '';
      let extra = res.note || '';
      if (res.pipeline === 'panel' && Array.isArray(res.checks)) {
        const bits = res.checks.map((c) =>
          c.stage + ': ' + c.verdict + (c.issues && c.issues.length
            ? ' (' + c.issues.join('; ') + ')' : ''));
        extra = (extra ? extra + ' | ' : '') + bits.join(' | ');
      }
      $('ask-answer').textContent = answer || '(leere Antwort)';
      renderAskSteps(res.steps || [], extra);
      const src = $('ask-source');
      const live = res.source === 'featherless';
      src.className = 'source-pill ' + (live ? 'featherless' : 'fallback');
      src.textContent = (live
        ? 'Featherless' + (res.model ? ' · ' + res.model : '')
        : 'Offline-Fallback')
        + (res.pipeline === 'panel' ? ' · Panel' : '')
        + (res.cached ? ' · Cache' : '');
    } catch (e) {
      answer = '';
      renderAskSteps([], null);
      $('ask-answer').textContent = 'Anfrage fehlgeschlagen: ' + e.message +
        '  (Offline? Backend über http://127.0.0.1:8000 öffnen.)';
      const src = $('ask-source'); src.className = 'source-pill'; src.textContent = 'Fehler';
    } finally {
      btn.disabled = false; btn.textContent = 'Senden';
    }
  }

  async function speakAnswer() {
    const text = answer || $('ask-answer').textContent;
    if (!text || text === '…') return;
    const btn = $('ask-speak');
    btn.disabled = true; btn.textContent = '🔊 Lädt…';
    try {
      const res = await opts.apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 501) {
        let hint = 'TTS nicht konfiguriert.';
        try { const j = await res.json(); if (j && j.hint) hint += ' ' + j.hint; } catch (_) {}
        $('ask-answer').textContent = hint + '\n\n' + text;
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) {
      $('ask-answer').textContent = 'Vorlesen nicht möglich: ' + e.message + '\n\n' + text;
    } finally {
      btn.disabled = false; btn.textContent = '🔊 Vorlesen';
    }
  }

  // Speak a concise summary of the current result (voice is first-class, not
  // only behind the "Ask" panel). The sentence itself is page-specific.
  async function speakResult() {
    const text = opts.resultSentence ? opts.resultSentence() : '';
    const btn = $('btn-speak-result');
    if (btn) { btn.disabled = true; btn.textContent = '🔊 Lädt…'; }
    try {
      if (!text) { alert('Noch kein Ergebnis – bitte zuerst simulieren.'); return; }
      const res = await opts.apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      if (res.status === 501) { alert('Sprachausgabe nicht konfiguriert: ELEVENLABS_API_KEY in .env setzen und Server neu starten.'); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) {
      alert('Vorlesen nicht möglich: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Ergebnis vorlesen'; }
    }
  }

  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('ask-mic');
    if (!SR) {
      btn.disabled = true;
      btn.title = 'Web Speech API nicht verfügbar';
      btn.textContent = '🎤 n. verfügbar';
      return;
    }
    let rec = null, listening = false;
    btn.addEventListener('click', () => {
      if (listening) { try { rec.stop(); } catch (_) {} return; }
      try {
        rec = new SR();
        rec.lang = 'de-DE';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (ev) => {
          const txt = ev.results[0][0].transcript;
          $('ask-input').value = txt;
          askExplain();
        };
        rec.onend = () => { listening = false; btn.textContent = '🎤 Mikrofon'; btn.classList.remove('active'); };
        rec.onerror = () => { listening = false; btn.textContent = '🎤 Mikrofon'; btn.classList.remove('active'); };
        rec.start();
        listening = true; btn.textContent = '🎤 hört…'; btn.classList.add('active');
      } catch (_) {
        btn.disabled = true; btn.textContent = '🎤 n. verfügbar';
      }
    });
  }

  // one-click example questions as chips above the input row; per mode if the
  // page provides an object {agent:[...], panel:[...], explain:[...]}
  function suggestionsFor(mode) {
    if (!opts || !opts.suggestions) return [];
    if (Array.isArray(opts.suggestions)) return opts.suggestions;
    return opts.suggestions[mode] || opts.suggestions.agent || [];
  }

  function renderChips() {
    const row = document.querySelector('.ask-row');
    if (!row) return;
    const old = row.parentNode.querySelector('.ask-chips');
    if (old) old.remove();
    const list = suggestionsFor(askMode);
    if (!list.length) return;
    const box = document.createElement('div');
    box.className = 'ask-chips';
    list.forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ask-chip';
      b.textContent = q;
      b.title = q;
      b.addEventListener('click', () => {
        $('ask-input').value = q;
        askExplain();
      });
      box.appendChild(b);
    });
    row.parentNode.insertBefore(box, row);
  }

  function bind() {
    if (!$('ask-send')) return;                 // page has no ask panel
    $('ask-send').addEventListener('click', askExplain);
    $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askExplain(); });
    for (const m of ASK_MODES) {
      const el = $('ask-mode-' + m);
      if (el) el.addEventListener('click', () => setAskMode(m));
    }
    $('ask-speak').addEventListener('click', speakAnswer);
    setupMic();
    setAskMode('agent');
  }

  window.SFAsk = {
    init: function (o) { opts = o; bind(); },
    speakResult: speakResult,
  };
})();
