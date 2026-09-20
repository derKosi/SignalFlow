/* ============================================================================
 * SignalFlow – PDF-Abhandlung der aktuellen Simulation (ohne Abhängigkeiten).
 * ----------------------------------------------------------------------------
 * Schreibt ein valides PDF 1.4 von Hand: Text in Helvetica/Helvetica-Bold
 * (WinAnsi), eingebettete JPEGs (DCTDecode, direkt aus canvas.toDataURL).
 * A4 hoch (595 x 842 pt), Ursprung unten links — alle y-Angaben im Renderer
 * sind "von oben" und werden umgerechnet.
 *
 * Nutzung:
 *   const pdf = SFReport.build(spec);          // -> Uint8Array
 *   SFReport.download(pdf, 'signalflow-bericht.pdf');
 *
 * spec: { title, subtitle, sections:[{heading, pageBreak, lines:[[k,v]|str]}],
 *         table:{heading, head:[...], rows:[[...]]},
 *         images:[{caption, dataUrl, w, h, px, py}], footer }
 *   w/h = Anzeigemaße in pt, px/py = Pixelmaße des Quell-Canvas (für das
 *   JPEG-XObject).
 * ==========================================================================*/
(function () {
  'use strict';

  const PAGE_W = 595, PAGE_H = 842, MARGIN = 46;

  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  // PDF-Standardfonts sind WinAnsi; alles darüber -> lesbare Ersatzzeichen
  const SUBST = { '₂': '2', '–': '-', '—': '-', '·': '-', '→': '->', '∑': 'S',
                  '’': "'", '‘': "'", '‚': ',', '“': '"', '”': '"', '…': '...',
                  '✓': 'ok', '×': 'x', '≥': '>=', '≤': '<=' };
  function latin1(s) {
    let out = '';
    for (const ch of String(s)) {
      const code = ch.codePointAt(0);
      if (SUBST[ch] !== undefined) out += SUBST[ch];
      else if (code <= 255) out += ch;
      else out += '?';
    }
    return out;
  }
  const enc = new TextEncoder();
  const bytes = (s) => enc.encode(s);
  function joinBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function dataUrlToBytes(dataUrl) {
    const b64 = String(dataUrl).split(',')[1] || '';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ------------------------------ Builder -------------------------------- */
  function Doc() {
    this.pages = [];
    this.imgSeq = 0;
    this.addPage();
  }
  Doc.prototype.addPage = function () {
    this.cur = { ops: [], imgs: [] };
    this.pages.push(this.cur);
    return this;
  };
  // Text; y von oben, x links. opts: {bold, size, gray, color:[r,g,b 0..1]}
  Doc.prototype.text = function (x, y, size, txt, opts) {
    opts = opts || {};
    const font = opts.bold ? '/F2' : '/F1';
    let color = '0.12 0.15 0.19 rg';
    if (opts.gray) color = '0.42 0.46 0.52 rg';
    if (opts.color) color = opts.color.join(' ') + ' rg';
    this.cur.ops.push('BT ' + color + ' ' + font + ' ' + size +
      ' Tf 1 0 0 1 ' + Number(x).toFixed(2) + ' ' + (PAGE_H - y).toFixed(2) +
      ' Tm (' + esc(latin1(txt)) + ') Tj ET\n');
    return this;
  };
  Doc.prototype.rule = function (y, light) {
    this.cur.ops.push((light ? '0.82 0.85 0.89' : '0.55 0.60 0.66') + ' RG 0.7 w ' +
      MARGIN + ' ' + (PAGE_H - y).toFixed(2) + ' m ' + (PAGE_W - MARGIN) + ' ' +
      (PAGE_H - y).toFixed(2) + ' l S\n');
    return this;
  };
  // JPEG einbetten (dataUrl). w/h = pt auf der Seite, px/py = Pixelmaße.
  Doc.prototype.image = function (x, yTop, w, h, dataUrl, px, py) {
    const name = '/Im' + (++this.imgSeq);
    this.cur.imgs.push({ name: name, bytes: dataUrlToBytes(dataUrl), px: px, py: py });
    this.cur.ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' +
      Number(x).toFixed(2) + ' ' + (PAGE_H - yTop - h).toFixed(2) + ' cm ' +
      name + ' Do Q\n');
    return this;
  };

  Doc.prototype.build = function () {
    // Objektnummern: 1 Katalog, 2 Pages, 3 F1, 4 F2, dann je Seite Page+Content,
    // dann die Bilder.
    const nPages = this.pages.length;
    const catalogId = 1, pagesId = 2, fontRegularId = 3, fontBoldId = 4;
    let nextId = 5;
    const pageIds = [];
    const pageMeta = [];
    for (const page of this.pages) {
      const pageId = nextId++;
      const contentId = nextId++;
      const imgIds = page.imgs.map(() => nextId++);
      pageIds.push(pageId);
      pageMeta.push({ pageId: pageId, contentId: contentId, imgIds: imgIds, page: page });
    }

    const objects = [];
    const put = (id, body) => { objects[id - 1] = body; };
    const kids = pageIds.map((id) => id + ' 0 R').join(' ');

    put(catalogId, bytes('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>'));
    put(pagesId, bytes('<< /Type /Pages /Count ' + nPages + ' /Kids [' + kids + '] >>'));
    put(fontRegularId, bytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
                             '/Encoding /WinAnsiEncoding >>'));
    put(fontBoldId, bytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ' +
                          '/Encoding /WinAnsiEncoding >>'));
    for (const m of pageMeta) {
      const imgRefs = m.page.imgs.map((im, i) =>
        im.name + ' ' + m.imgIds[i] + ' 0 R').join(' ');
      put(m.pageId, bytes('<< /Type /Page /Parent ' + pagesId + ' 0 R ' +
        '/MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] ' +
        '/Resources << /Font << /F1 ' + fontRegularId + ' 0 R /F2 ' + fontBoldId +
        ' 0 R >> ' + (imgRefs ? '/XObject << ' + imgRefs + ' >>' : '') + ' >> ' +
        '/Contents ' + m.contentId + ' 0 R >>'));
      const contentBytes = bytes(m.page.ops.join(''));
      put(m.contentId, joinBytes([
        bytes('<< /Length ' + contentBytes.length + ' >>\nstream\n'),
        contentBytes,
        bytes('\nendstream'),
      ]));
      m.page.imgs.forEach((im, i) => {
        put(m.imgIds[i], joinBytes([
          bytes('<< /Type /XObject /Subtype /Image /Width ' + im.px +
                ' /Height ' + im.py +
                ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
                '/Length ' + im.bytes.length + ' >>\nstream\n'),
          im.bytes,
          bytes('\nendstream'),
        ]));
      });
    }

    const total = nextId - 1;
    const parts = [bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    const offsets = [0];
    let pos = parts[0].length;
    for (let i = 1; i <= total; i++) {
      offsets.push(pos);
      const head = bytes(i + ' 0 obj\n');
      const body = objects[i - 1];
      const tail = bytes('\nendobj\n');
      parts.push(head, body, tail);
      pos += head.length + body.length + tail.length;
    }
    const xrefStart = pos;
    let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= total; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    parts.push(bytes(xref));
    parts.push(bytes('trailer\n<< /Size ' + (total + 1) +
      ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n'));
    return joinBytes(parts);
  };

  /* --------------------------- Report-Layout ----------------------------- */
  function render(doc, spec) {
    let y = 64;
    doc.text(MARGIN, y, 19, spec.title || 'SignalFlow', { bold: true });
    if (spec.subtitle) {
      y += 20;
      doc.text(MARGIN, y, 9.5, spec.subtitle, { gray: true });
    }
    y += 24;
    doc.rule(y);
    y += 22;

    for (const section of spec.sections || []) {
      if (section.pageBreak) { doc.addPage(); y = 56; }
      if (y > 760) { doc.addPage(); y = 56; }
      if (section.heading) {
        doc.text(MARGIN, y, 13, section.heading, { bold: true });
        y += 8;
        doc.rule(y, true);
        y += 17;
      }
      for (const line of section.lines || []) {
        if (Array.isArray(line)) {
          doc.text(MARGIN + 2, y, 10, line[0] + ':', { bold: true });
          doc.text(MARGIN + 175, y, 10, line[1]);
        } else {
          doc.text(MARGIN + 2, y, 10, line);
        }
        y += 16;
      }
      y += 6;
    }

    if (spec.table) {
      if (y > 680) { doc.addPage(); y = 56; }
      doc.text(MARGIN, y, 13, spec.table.heading || 'Kennzahlen', { bold: true });
      y += 8; doc.rule(y, true); y += 18;
      const cols = spec.table.head;
      const colW = (PAGE_W - 2 * MARGIN) / cols.length;
      let x = MARGIN;
      cols.forEach((h, i) => {
        doc.text(x + 2, y, 9.5, h, { bold: true, gray: i > 0 });
        x += colW;
      });
      y += 6; doc.rule(y, true); y += 15;
      for (const row of spec.table.rows) {
        x = MARGIN;
        row.forEach((cell, i) => {
          doc.text(x + 2, y, 10, String(cell), { bold: i === 0 });
          x += colW;
        });
        y += 15;
        if (y > 800) { doc.addPage(); y = 56; }
      }
      y += 10;
    }

    for (const img of spec.images || []) {
      if (y + img.h + 40 > PAGE_H - 40) { doc.addPage(); y = 56; }
      if (img.caption) {
        doc.text(MARGIN, y, 10.5, img.caption, { bold: true });
        y += 13;
      }
      doc.image(MARGIN, y, img.w, img.h, img.dataUrl, img.px, img.py);
      y += img.h + 20;
    }

    if (spec.footer) {
      if (y > PAGE_H - 56) doc.addPage();
      doc.text(MARGIN, PAGE_H - 30, 7.5, spec.footer, { gray: true });
    }
  }

  function download(bytesOut, filename) {
    const blob = new Blob([bytesOut], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
  }

  window.SFReport = {
    Doc: Doc,
    render: render,
    build: (spec) => { const doc = new Doc(); render(doc, spec); return doc.build(); },
    download: download,
  };
})();
