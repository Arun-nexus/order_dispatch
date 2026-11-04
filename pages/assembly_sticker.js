/* =========================================================
   assembly_sticker.js
   Product sticker (label) designer + export for the Assembly page.

   Two supply types, taken from FETAL_MONITOR.docx:
     - normal : has M.R.P row, no govt line
     - govt   : no M.R.P, extra last row "GOVT. SUPPLY NOT FOR RETAIL SALE."

   One sticker is generated per serial number, 2 stickers per A4 page,
   exported as PDF (jsPDF) or Word .docx (docx library).

   Needs (loaded in assembly.html before this file):
     window.jspdf  (jsPDF 2.5.1)   -> PDF
     window.docx   (docx 8.5.0)    -> Word

   Public API: window.AsmSticker
     makeState(base)                      -> sticker state object (all editable fields)
     renderEditor(host, state, serials)   -> editable sticker preview inside `host`
     downloadPdf(state, serials)          / downloadDocx(state, serials)
     openForAssembly(assembly)            -> stand-alone modal for a saved assembly
   ========================================================= */
(function () {
  'use strict';

  const DEFAULTS = {
    licenseNo: 'MFG/MD/2023/000828',
    mfrName: 'Acer Biomedicals LLP,',
    mfrAddress: 'Industrial Unit No. 80, Block G, Noida, Sector 63, Noida, Gautam Buddha Nagar, Uttar Pradesh, 201301',
    quantity: '01 NOS',
    input: '100-240 V 50/60Hz',
    govtLine: 'GOVT. SUPPLY NOT FOR RETAIL SALE.',
  };

  // ---- geometry (taken from the Word file: table 9685 twips ~ 171 mm, 2 stickers per A4) ----
  const COL_MM = [60, 111];                 // label column, value column
  const TABLE_MM = COL_MM[0] + COL_MM[1];   // 171 mm
  const PAGE = { w: 210, h: 297, x: (210 - TABLE_MM) / 2, slotTop: [14, 162.5] };
  const TWIP = 56.6929;                     // twips per mm
  const FONT_PT = 14;                       // sz 28 in the Word file

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function monthYear(ym) {                  // "2026-11" -> "11/2026"
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? `${m[2]}/${m[1]}` : (ym || '');
  }

  function makeState(base) {
    base = base || {};
    return {
      type: base.type === 'govt' ? 'govt' : 'normal',
      licenseNo: base.licenseNo ?? DEFAULTS.licenseNo,
      mfrName: base.mfrName ?? DEFAULTS.mfrName,
      mfrAddress: base.mfrAddress ?? DEFAULTS.mfrAddress,
      productName: base.productName ?? '',
      modelNo: base.modelNo ?? '',
      quantity: base.quantity ?? DEFAULTS.quantity,
      input: base.input ?? DEFAULTS.input,
      mfgDate: base.mfgDate ?? '',
      mrp: base.mrp ?? '',
      govtLine: base.govtLine ?? DEFAULTS.govtLine,
    };
  }

  // ---- row spec shared by PDF + Word -------------------------------------------------
  function rowSpec(d, serial) {
    const rows = [
      { label: 'Mfg. License No.', value: d.licenseNo, minH: 10 },
      { label: 'Name and Address\nOf Manufacturer', mfr: true, minH: 19.5 },
      { label: 'Name of product', value: d.productName, minH: 9 },
      { label: 'Model No.', value: d.modelNo, minH: 13.5 },
      { label: 'Quantity', value: d.quantity, minH: 9.5 },
      { label: 'Input', value: d.input, minH: 9.5 },
      { label: 'Month & Year of\nManufacturer', value: d.mfgDate, minH: 11 },
    ];
    if (d.type === 'normal') rows.push({ label: 'M.R.P\n(Inclusive of all taxes)', value: d.mrp, minH: 11.5 });
    rows.push({ full: true, text: 'PRODUCT SERIAL NO. : ' + (serial || ''), minH: 14 });
    if (d.type === 'govt') rows.push({ full: true, text: d.govtLine, minH: 10 });
    return rows;
  }

  const chunk2 = arr => { const out = []; for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2)); return out; };
  const safeName = s => String(s || 'product').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'product';
  const today = () => new Date().toISOString().slice(0, 10);
  const fileBase = (d) => `${safeName(d.productName)}_${d.type === 'govt' ? 'govt' : 'normal'}_stickers_${today()}`;

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  // =========================================================
  // PDF
  // =========================================================
  function pdfText(s) { return String(s ?? '').replace(/₹/g, 'Rs. '); }   // built-in PDF fonts have no rupee glyph

  function drawStickerPdf(doc, d, serial, x, y) {
    const LH = FONT_PT * 0.3528 * 1.2;       // line height in mm
    const padL = 2.5, padR = 1.5, padT = 1.8, padB = 1.4;
    doc.setFont('times', 'bold');
    doc.setFontSize(FONT_PT);

    // 1) measure every row
    const rows = rowSpec(d, serial).map(r => {
      if (r.full) {
        const lines = doc.splitTextToSize(pdfText(r.text), TABLE_MM - padL - padR);
        return { ...r, lines, h: Math.max(r.minH, lines.length * LH + padT + padB) };
      }
      const wrap = (txt, w, bold) => {
        doc.setFont('times', bold ? 'bold' : 'normal');
        return String(txt).split('\n').flatMap(t => doc.splitTextToSize(pdfText(t), w));
      };
      const labelLines = wrap(r.label, COL_MM[0] - padL - padR, true);
      let valueLines;
      if (r.mfr) {
        valueLines = [
          ...wrap(d.mfrName, COL_MM[1] - padL - padR, true).map(t => ({ t, b: true })),
          ...wrap(d.mfrAddress, COL_MM[1] - padL - padR, false).map(t => ({ t, b: false })),
        ];
      } else {
        valueLines = wrap(r.value || '', COL_MM[1] - padL - padR, true).map(t => ({ t, b: true }));
      }
      const n = Math.max(labelLines.length, valueLines.length);
      return { ...r, labelLines, valueLines, h: Math.max(r.minH, n * LH + padT + padB) };
    });

    // 2) draw
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.setTextColor(0);
    let yy = y;
    rows.forEach(r => {
      if (r.full) {
        doc.rect(x, yy, TABLE_MM, r.h);
        doc.setFont('times', 'bold');
        doc.setFontSize(FONT_PT);
        const total = r.lines.length * LH;
        r.lines.forEach((t, i) => doc.text(t, x + TABLE_MM / 2, yy + (r.h - total) / 2 + LH * (i + 0.78), { align: 'center' }));
      } else {
        doc.rect(x, yy, COL_MM[0], r.h);
        doc.rect(x + COL_MM[0], yy, COL_MM[1], r.h);
        doc.setFontSize(FONT_PT);
        doc.setFont('times', 'bold');
        r.labelLines.forEach((t, i) => doc.text(t, x + padL, yy + padT + LH * (i + 0.78)));
        r.valueLines.forEach((l, i) => {
          doc.setFont('times', l.b ? 'bold' : 'normal');
          doc.text(l.t, x + COL_MM[0] + padL, yy + padT + LH * (i + 0.78));
        });
      }
      yy += r.h;
    });
    return yy - y;
  }

  function downloadPdf(state, serials) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library (jsPDF) did not load. Check your internet connection and reload the page.');
    const list = (serials && serials.length) ? serials : [''];
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    chunk2(list).forEach((pair, pi) => {
      if (pi > 0) doc.addPage('a4', 'portrait');
      pair.forEach((serial, si) => drawStickerPdf(doc, state, serial, PAGE.x, PAGE.slotTop[si]));
    });
    doc.save(fileBase(state) + '.pdf');
  }

  // =========================================================
  // WORD (.docx)
  // =========================================================
  async function downloadDocx(state, serials) {
    if (!window.docx) throw new Error('Word library (docx) did not load. Check your internet connection and reload the page.');
    const D = window.docx;
    const FONT = 'Cambria';
    const list = (serials && serials.length) ? serials : [''];
    const tw = mm => Math.round(mm * TWIP);
    const colTw = [tw(COL_MM[0]), tw(COL_MM[1])];
    const line = { style: D.BorderStyle.SINGLE, size: 6, color: '000000' };
    const run = (text, bold) => new D.TextRun({ text: String(text ?? ''), bold: !!bold, size: FONT_PT * 2, font: FONT });
    const para = (text, bold, center) => new D.Paragraph({
      alignment: center ? D.AlignmentType.CENTER : D.AlignmentType.LEFT,
      spacing: { before: 0, after: 0 },
      children: [run(text, bold)],
    });
    const lines = (txt, bold) => String(txt ?? '').split('\n').map(t => para(t, bold));
    const margins = { top: 60, bottom: 40, left: 142, right: 80 };

    const buildTable = (serial) => new D.Table({
      width: { size: colTw[0] + colTw[1], type: D.WidthType.DXA },
      columnWidths: colTw,
      layout: D.TableLayoutType.FIXED,
      alignment: D.AlignmentType.CENTER,
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: rowSpec(state, serial).map(r => {
        const height = { value: tw(r.minH), rule: D.HeightRule.ATLEAST };
        if (r.full) {
          return new D.TableRow({
            height, cantSplit: true,
            children: [new D.TableCell({
              columnSpan: 2, margins, verticalAlign: D.VerticalAlign.CENTER,
              width: { size: colTw[0] + colTw[1], type: D.WidthType.DXA },
              children: [para(r.text, true, true)],
            })],
          });
        }
        const valueParas = r.mfr
          ? [para(state.mfrName, true), ...String(state.mfrAddress ?? '').split('\n').map(t => para(t, false))]
          : lines(r.value, true);
        return new D.TableRow({
          height, cantSplit: true,
          children: [
            new D.TableCell({ margins, width: { size: colTw[0], type: D.WidthType.DXA }, children: lines(r.label, true) }),
            new D.TableCell({ margins, width: { size: colTw[1], type: D.WidthType.DXA }, children: valueParas }),
          ],
        });
      }),
    });

    const spacer = (pageBreak) => new D.Paragraph({
      pageBreakBefore: !!pageBreak,
      spacing: { before: 0, after: 0, line: pageBreak ? 20 : tw(11), lineRule: D.LineRuleType.EXACT },
      children: [],
    });

    const children = [];
    chunk2(list).forEach((pair, pi) => {
      if (pi > 0) children.push(spacer(true));
      pair.forEach((serial, si) => {
        if (si > 0) children.push(spacer(false));
        children.push(buildTable(serial));
      });
    });
    children.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT }, children: [] }));

    const doc = new D.Document({
      creator: 'Accure ERP',
      title: 'Product Stickers',
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: tw(PAGE.slotTop[0]), bottom: tw(10), left: tw(PAGE.x), right: tw(PAGE.x), header: 0, footer: 0 },
          },
        },
        children,
      }],
    });
    download(await D.Packer.toBlob(doc), fileBase(state) + '.docx');
  }

  // =========================================================
  // EDITOR UI (sticker preview where every field can be changed)
  // =========================================================
  function ensureStyles() {
    if (document.getElementById('asmStickerStyles')) return;
    const st = document.createElement('style');
    st.id = 'asmStickerStyles';
    st.textContent = `
      .stk-toggle{display:flex;gap:8px;margin-bottom:12px}
      .stk-toggle button{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#64748b}
      .stk-toggle button.on{border-color:#1665ff;background:#eef3fb;color:#1665ff}
      .stk-sheet{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;overflow-x:auto}
      .stk-tbl{width:100%;min-width:560px;border-collapse:collapse;background:#fff;font-family:Cambria,'Times New Roman',serif;color:#000;table-layout:fixed}
      .stk-tbl td{border:1.5px solid #000;padding:5px 8px;vertical-align:top;font-weight:700;font-size:15px;line-height:1.3;background:#fff !important;color:#000 !important}
      .stk-tbl td.lbl{width:35%}
      .stk-tbl td.full{text-align:center}
      .stk-tbl input,.stk-tbl textarea{width:100%;box-sizing:border-box;border:none;border-bottom:1px dashed #94a3b8;border-radius:0;background:#fffdf0;padding:2px 3px;font:inherit;color:#000;outline:none;resize:vertical}
      .stk-tbl input:focus,.stk-tbl textarea:focus{background:#fff8c9;border-bottom-color:#1665ff}
      .stk-tbl textarea.addr{font-weight:400;min-height:58px}
      .stk-tbl td.full input{text-align:center}
      .stk-tbl .serial-auto{color:#1665ff}
      .stk-hint{font-size:12px;color:#64748b;margin:10px 0 0}
      .stk-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}
      .stk-btn{padding:10px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:#fff}
      .stk-btn.pdf{background:#d62828}
      .stk-btn.doc{background:#1e5bb8}
      .stk-btn.ghost{background:#eee;color:#334155}
      #asmStickerModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1300}
    `;
    document.head.appendChild(st);
  }

  function renderEditor(host, state, serials) {
    ensureStyles();
    const list = serials || [];
    const pages = Math.max(1, Math.ceil(Math.max(list.length, 1) / 2));
    const isGovt = state.type === 'govt';
    const inp = (key, cls) => `<input type="text" data-k="${key}" ${cls ? `class="${cls}"` : ''} value="${esc(state[key])}">`;

    host.innerHTML = `
      <div class="stk-toggle">
        <button type="button" data-type="normal" class="${isGovt ? '' : 'on'}"><i class="fa-solid fa-store"></i> Normal Sticker</button>
        <button type="button" data-type="govt" class="${isGovt ? 'on' : ''}"><i class="fa-solid fa-landmark"></i> Govt. Supply Sticker</button>
      </div>
      <div class="stk-sheet">
        <table class="stk-tbl">
          <tr><td class="lbl">Mfg. License No.</td><td>${inp('licenseNo')}</td></tr>
          <tr><td class="lbl">Name and Address<br>Of Manufacturer</td>
              <td>${inp('mfrName')}<textarea class="addr" data-k="mfrAddress">${esc(state.mfrAddress)}</textarea></td></tr>
          <tr><td class="lbl">Name of product</td><td>${inp('productName')}</td></tr>
          <tr><td class="lbl">Model No.</td><td>${inp('modelNo')}</td></tr>
          <tr><td class="lbl">Quantity</td><td>${inp('quantity')}</td></tr>
          <tr><td class="lbl">Input</td><td>${inp('input')}</td></tr>
          <tr><td class="lbl">Month &amp; Year of<br>Manufacturer</td><td>${inp('mfgDate')}</td></tr>
          ${isGovt ? '' : `<tr><td class="lbl">M.R.P<br>(Inclusive of all taxes)</td><td>${inp('mrp')}</td></tr>`}
          <tr><td class="full" colspan="2">PRODUCT SERIAL NO. : <span class="serial-auto">${esc(list[0] || '(serial number of each unit)')}</span></td></tr>
          ${isGovt ? `<tr><td class="full" colspan="2">${inp('govtLine')}</td></tr>` : ''}
        </table>
      </div>
      <p class="stk-hint">
        Every yellow field is editable. The serial number changes automatically on each sticker
        (preview shows unit 1). <b>${list.length || 0}</b> sticker(s) → <b>${pages}</b> A4 page(s), 2 stickers per page.
      </p>`;

    host.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', () => { state[el.dataset.k] = el.value; }));
    host.querySelectorAll('.stk-toggle button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.type === state.type) return;
      state.type = b.dataset.type;
      renderEditor(host, state, serials);
    }));
  }

  function guard(fn) {
    return async (...a) => {
      try { await fn(...a); }
      catch (err) {
        console.error(err);
        const msg = err && err.message ? err.message : 'Could not create the sticker file.';
        if (typeof showResponseModal === 'function') showResponseModal('Download failed', msg, false); else alert(msg);
      }
    };
  }
  const safePdf = guard((s, l) => downloadPdf(s, l));
  const safeDocx = guard((s, l) => downloadDocx(s, l));

  // download buttons wired to a state + serial list
  function wireDownloadButtons(root, state, serials) {
    root.querySelector('[data-stk="pdf"]')?.addEventListener('click', () => safePdf(state, serials));
    root.querySelector('[data-stk="docx"]')?.addEventListener('click', () => safeDocx(state, serials));
  }

  // stand-alone modal for an already saved assembly (table button)
  function openForAssembly(a) {
    ensureStyles();
    let modal = document.getElementById('asmStickerModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'asmStickerModal';
      modal.innerHTML = '<div class="modal-content" style="background:#fff;border-radius:16px;padding:26px;width:min(820px,96vw);max-height:92vh;overflow-y:auto;"></div>';
      document.body.appendChild(modal);
    }
    const saved = a.sticker || {};
    const state = makeState({
      ...saved,
      type: a.supplyType || saved.type || 'normal',
      productName: a.productName || saved.productName || '',
      modelNo: a.modelNumber || saved.modelNo || '',
      mfgDate: a.mfgDate || saved.mfgDate || '',
      mrp: a.mrp || saved.mrp || '',
    });
    const serials = (a.serials || []).map(s => s.serial);
    const box = modal.querySelector('.modal-content');
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">Stickers — ${esc(a.productName)}</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <div id="stkHost"></div>
      <div class="stk-actions">
        <button class="stk-btn pdf" data-stk="pdf"><i class="fa-solid fa-file-pdf"></i> Download PDF</button>
        <button class="stk-btn doc" data-stk="docx"><i class="fa-solid fa-file-word"></i> Download Word</button>
      </div>`;
    renderEditor(box.querySelector('#stkHost'), state, serials);
    wireDownloadButtons(box, state, serials);
    box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.style.display = 'flex';
  }

  window.AsmSticker = { DEFAULTS, makeState, monthYear, renderEditor, wireDownloadButtons, downloadPdf, downloadDocx, openForAssembly, rowSpec };
})();