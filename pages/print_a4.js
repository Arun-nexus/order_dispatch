/* =====================================================================
   print_a4.js  —  shared A4 printing helpers (Acer Biomedical)

   A4Print.form(id, defaults)   -> opens the editable "ORDER DISPATCH FORM"
                                   (same structure as the Excel form) and
                                   prints it on one A4 portrait sheet.
   A4Print.table({title, subtitle, head, rows, landscape})
                                -> prints any list/table on A4 (use it next
                                   to every "Export" button).
   A4Print.attachNextTo(btn, fn, label)
                                -> drops a "Print" button right beside an
                                   existing Export button; fn() must return
                                   {title, subtitle?, head:[], rows:[[]]}.
   ===================================================================== */
const A4Print = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- print options (remembered): orientation, both sides, copies, page numbers ----------
  const OPT_KEY = 'a4print:opts';
  function loadOpts() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}') || {}; } catch (e) { o = {}; }
    return { orient: o.orient || 'auto', duplex: !!o.duplex, copies: Math.min(10, Math.max(1, Number(o.copies) || 1)), pageNumbers: o.pageNumbers !== false };
  }

  function askOptions(kind, onGo) {
    document.getElementById('a4OptModal')?.remove();
    const o = loadOpts();
    const m = document.createElement('div');
    m.id = 'a4OptModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:center;z-index:4000;';
    const row = 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0;font-size:13px;color:#334155;';
    const inp = 'padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;';
    m.innerHTML = `<div style="background:#fff;border-radius:16px;padding:22px 24px;width:400px;max-width:94vw;font-family:Arial,sans-serif;">
      <h3 style="margin:0 0 4px;">Print options (A4)</h3>
      <p style="margin:0 0 8px;font-size:12px;color:#64748b;">${kind === 'form' ? 'Order Dispatch Form' : 'List / table'}</p>
      ${kind === 'form' ? '' : `<label style="${row}">Orientation
        <select id="a4o_orient" style="${inp}"><option value="auto">Auto (by columns)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>`}
      <label style="${row}">Copies <input id="a4o_copies" type="number" min="1" max="10" value="${o.copies}" style="${inp}width:70px;"></label>
      <label style="${row}"><span><b>Print on both sides</b> (duplex)<br><small style="color:#64748b;">${kind === 'form'
        ? 'Copies ek ke baad ek aate hain: copy 1 front, copy 2 back'
        : 'Binding margin front/back mein alternate hota hai, taaki file/bind karne par text na kate'}</small></span>
        <input id="a4o_duplex" type="checkbox" ${o.duplex ? 'checked' : ''}></label>
      ${kind === 'form' ? '' : `<label style="${row}">Page numbers (Page 1 of N) <input id="a4o_pn" type="checkbox" ${o.pageNumbers ? 'checked' : ''}></label>`}
      <p style="font-size:11.5px;color:#92400e;background:#fef3c7;border-radius:8px;padding:8px 10px;margin:8px 0;">
        Browser printer ko khud duplex mein nahi daal sakta. Print window khulne par <b>"Two-sided / Print on both sides"</b> (Flip on long edge) select karna.</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;">
        <button id="a4o_cancel" style="padding:9px 14px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button id="a4o_go" style="padding:9px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-print"></i> Print</button>
      </div></div>`;
    document.body.appendChild(m);
    if (kind !== 'form') m.querySelector('#a4o_orient').value = o.orient;
    const close = () => m.remove();
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    m.querySelector('#a4o_cancel').addEventListener('click', close);
    m.querySelector('#a4o_go').addEventListener('click', () => {
      const n = {
        orient: kind === 'form' ? o.orient : m.querySelector('#a4o_orient').value,
        copies: Math.min(10, Math.max(1, Number(m.querySelector('#a4o_copies').value) || 1)),
        duplex: m.querySelector('#a4o_duplex').checked,
        pageNumbers: kind === 'form' ? o.pageNumbers : m.querySelector('#a4o_pn').checked
      };
      try { localStorage.setItem(OPT_KEY, JSON.stringify(n)); } catch (e) { /* ignore */ }
      close();
      onGo(n);
    });
    m.querySelector('#a4o_go').focus();
  }

  // ---------- print through a hidden iframe (A4, no app chrome) ----------
  function printDoc(title, bodyHtml, css, o) {
    o = o || {};
    const isForm = !!o.isForm;
    const margin = isForm ? '6mm 8mm' : '8mm 8mm 12mm';
    const pn = !isForm && o.pageNumbers ? `@bottom-center{content:"Page " counter(page) " of " counter(pages);font:8pt Arial,sans-serif;color:#444}` : '';
    const duplexCss = !isForm && o.duplex
      ? '@page :right{margin-left:14mm;margin-right:8mm}@page :left{margin-left:8mm;margin-right:14mm}' : '';
    const copies = Math.max(1, o.copies || 1);
    const body = Array.from({ length: copies }, (_, i) =>
      `<div class="a4copy"${i < copies - 1 ? ' style="break-after:page;page-break-after:always"' : ''}>${bodyHtml}</div>`).join('');
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(f);
    const d = f.contentWindow.document;
    d.open();
    d.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      @page{size:A4 ${o.landscape ? 'landscape' : 'portrait'};margin:${margin};${pn}}
      ${duplexCss}
      html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      ${css}</style></head><body>${body}</body></html>`);
    d.close();
    setTimeout(() => {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { alert('Print could not be started.'); }
      setTimeout(() => f.remove(), 60000);
    }, 300);
  }

  // =====================================================================
  //  Generic table print
  // =====================================================================
  function table(opts) {
    const head = opts.head || [], rows = opts.rows || [];
    if (!rows.length) { alert('Nothing to print for the current filters.'); return; }
    askOptions('table', o => tableGo(opts, o));
  }

  function tableGo(opts, o) {
    const head = opts.head || [], rows = opts.rows || [];
    const landscape = o.orient === 'landscape' || (o.orient === 'auto' && (opts.landscape ?? head.length > 6));
    const fs = head.length <= 6 ? 9 : head.length <= 10 ? 8 : 7;
    const css = `
      body{font-family:Arial,Helvetica,sans-serif;color:#111}
      .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:6px}
      .hd h1{font-size:15pt;margin:0}.hd small{font-size:8.5pt;color:#333}
      table{width:100%;border-collapse:collapse;font-size:${fs}pt}
      thead{display:table-header-group}
      th{background:#e5e7eb;text-align:left;border:1px solid #000;padding:3px 4px}
      td{border:1px solid #444;padding:3px 4px;vertical-align:top;word-break:break-word}
      tr{page-break-inside:avoid}`;
    const body = `
      <div class="hd"><div><h1>${esc(opts.title || 'Report')}</h1><small>Acer Biomedical${opts.subtitle ? ' &nbsp;|&nbsp; ' + esc(opts.subtitle) : ''}</small></div>
      <small>Printed: ${new Date().toLocaleString('en-GB')} &nbsp;|&nbsp; ${rows.length} record(s)</small></div>
      <table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    printDoc(opts.title || 'Report', body, css, { landscape, duplex: o.duplex, copies: o.copies, pageNumbers: o.pageNumbers });
  }

  function attachNextTo(btn, getOpts, label) {
    if (!btn || btn.dataset.printAttached) return null;
    btn.dataset.printAttached = '1';
    const p = document.createElement('button');
    p.type = 'button';
    p.className = btn.className;
    p.innerHTML = `<i class="fa-solid fa-print"></i> ${label || 'Print'}`;
    p.addEventListener('click', () => table(getOpts()));
    btn.insertAdjacentElement('afterend', p);
    return p;
  }

  // =====================================================================
  //  ORDER DISPATCH FORM  (mirrors ORDER_DISPATCH_FORM.xlsx cell-for-cell)
  //  Columns: A 5.66 | B-F 18.66 each      Rows 2..23 (heights from Excel)
  // =====================================================================
  const MM = 0.315;                       // Excel pt -> mm : base form fits one A4 page
  // Excel row heights (pt) are only the MINIMUM height: a row grows when its text needs more room.
  const ROW_PT = { 2: 30, 3: 30, 4: 30, 5: 170.25, 6: 45, 7: 20.1, 8: 20.1, 9: 20.1, 10: 30, 11: 30,
    12: 20.1, 13: 20.1, 14: 20.1, 15: 20.1, 16: 30, 17: 30.6, 18: 110.1, 19: 30, 20: 30, 21: 20.1, 22: 20.1, 23: 20.1, 24: 60 };

  // width is fixed (194mm); height is free
  const FORM_CSS = `
    .odf-sheet{width:194mm;background:#fff;color:#000;font-family:Cambria,Georgia,'Times New Roman',serif;font-size:10pt;box-sizing:border-box}
    .odf-sheet table{width:194mm;border-collapse:collapse;table-layout:fixed;border:2.4px solid #000}
    .odf-sheet td{border:1.3px solid #000;padding:0.3mm 1.2mm;vertical-align:middle;line-height:1.12;word-break:break-word;overflow-wrap:anywhere}
    .odf-sheet td.t{vertical-align:top}
    .odf-sheet td.a{padding:0;text-align:center;vertical-align:middle}
    .odf-sheet tr.sec td{border-top:2.4px solid #000}
    .odf-sheet .r{text-align:right}
    .odf-sheet .ctr{text-align:center}
    .odf-sheet .l{font-weight:700}
    .odf-sheet .ttl{font-size:13pt}
    .odf-sheet .big{font-size:12.5pt}
    .odf-sheet .v{font-weight:400;outline:none;white-space:pre-wrap}
    .odf-sheet .v.vb{display:block;min-height:1.2em}
    .odf-sheet .vt{display:inline-block;writing-mode:vertical-rl;text-orientation:upright;font-weight:700;line-height:1;font-size:10pt;white-space:nowrap}
    .odf-sheet .vt.sm{font-size:7pt}`;

  const EDIT_CSS = `
    .odf-ovl{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:3000;overflow:auto;padding:0 0 30px}
    .odf-bar{position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .odf-bar b{font-size:15px}
    .odf-bar span.hint{font-size:12px;color:#64748b;flex:1;min-width:220px}
    .odf-bar button{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
    .odf-bar .pr{background:#1665ff;color:#fff}.odf-bar .rs{background:#eef1f6;color:#334155}.odf-bar .cl{background:#fee2e2;color:#b91c1c}
    .odf-wrap{display:flex;justify-content:center;padding:18px 10px}
    .odf-wrap .odf-sheet{box-shadow:0 4px 24px rgba(0,0,0,.35)}
    .odf-sheet .v{background:rgba(255,236,150,.28)}
    .odf-sheet .v.vb{min-height:1.4em}
    .odf-sheet .v:hover,.odf-sheet .v:focus{background:rgba(255,236,150,.7)}
    .odf-sheet span.v{display:inline-block;min-width:22px;min-height:12px;border-bottom:1px dotted #94a3b8}`;

  function formHtml() {
    const td = (rs, cs, body, cls) => `<td${rs > 1 ? ` rowspan="${rs}"` : ''}${cs > 1 ? ` colspan="${cs}"` : ''}${cls ? ` class="${cls}"` : ''}>${body}</td>`;
    const lab = (t, al, extra) => `<div class="${al || ''}"><span class="l ${extra || ''}">${t}</span></div>`;
    const val = k => `<div class="v vb" data-k="${k}" contenteditable="plaintext-only"></div>`;
    const lv = (t, k, extra) => `<span class="l ${extra || ''}">${t}</span> <span class="v" data-k="${k}" contenteditable="plaintext-only"></span>`;
    const vert = (t, cls) => `<div class="vt ${cls || ''}">${t}</div>`;
    const tr = (n, inner, sec) => `<tr${sec ? ' class="sec"' : ''} style="height:${(ROW_PT[n] * MM).toFixed(2)}mm">${inner}</tr>`;

    return `<div class="odf-sheet"><table>
      <colgroup><col style="width:11mm"><col style="width:36.6mm"><col style="width:36.6mm"><col style="width:36.6mm"><col style="width:36.6mm"><col style="width:36.6mm"></colgroup>
      ${tr(2, td(1, 3, lv('Invoice No.', 'inv', 'ttl')) + td(1, 2, lv('REF:', 'ref')) + td(1, 1, lv('Date:', 'date')))}
      ${tr(3, td(8, 1, vert('ACCOUNTS DEPARTMENT'), 'a') + td(1, 1, lab('PARTY NAME :- ')) + td(1, 4, val('party')), true)}
      ${tr(4, td(1, 1, lab('ADDRESS :- ')) + td(1, 4, val('address')))}
      ${tr(5, td(1, 1, lab('ORDER DETAILS :-')) + td(1, 4, val('details'), 't'))}
      ${tr(6, td(1, 1, lab('MODE OF DISPATCH')) + td(1, 1, lv('BY HAND - NA', 'hand'), 't') + td(1, 1, lv('BY PORTER -', 'porter'), 't') + td(1, 1, lv('BY COURIER', 'courier'), 't') + td(1, 1, lv('OTHERS -', 'others'), 't'))}
      ${tr(7, td(3, 1, lab('ACCOUNTS APPROVAL  - ')) + td(1, 2, lv('Approved-', 'appr'), 't') + td(3, 1, lv('TIME IN - ', 'ain'), 't') + td(3, 1, lv('TIME OUT - ', 'aout'), 't'))}
      ${tr(8, td(1, 2, lv('Hold-', 'hold'), 't'))}
      ${tr(9, td(1, 2, lv('Reason-', 'reason'), 't'))}
      ${tr(10, td(1, 1, lab('TIME LINE:- ')) + td(1, 1, lab('ORDER RECEIVED ', 'r')) + td(1, 1, val('recv')) + td(1, 1, lab('ORDER SEND FOR DISPATCH', 'r')) + td(1, 1, val('sentdisp')))}
      ${tr(11, td(9, 1, vert('QC DEPARTMENT'), 'a') + td(1, 1, lab('SEND FOR Q.C (TIME) :-')) + td(1, 1, lab('TIME IN', 'r')) + td(1, 1, val('qcin')) + td(1, 1, lab('TIME OUT', 'r')) + td(1, 1, val('qcout')), true)}
      ${tr(12, td(5, 1, lab('Q.C DONE BY :-')) + td(5, 2, val('qcby'), 't') + td(1, 1, lab('MANUAL', 'r')) + td(1, 1, val('manual')))}
      ${tr(13, td(1, 1, lab('ACESSORIES', 'r')) + td(1, 1, val('acc')))}
      ${tr(14, td(1, 1, lab('PACKING LIST ', 'r')) + td(1, 1, val('plist')))}
      ${tr(15, td(1, 1, lab('STICKERS', 'r')) + td(1, 1, val('stick')))}
      ${tr(16, td(1, 1, lab('Physical Appearance', 'r')) + td(1, 1, val('phys')))}
      ${tr(17, td(2, 1, lab('S.NO. OF MACHINE &amp; ACCESSORIES ', 'ctr')) + td(2, 2, val('serials'), 't') + td(1, 2, lab('Manufacturing Date', 'r', 'big')))}
      ${tr(18, td(1, 2, val('mfg'), 't'))}
      ${tr(19, td(1, 1, lab('SEND FOR BILLLING ')) + td(1, 1, lab('TIME IN', 'r')) + td(1, 1, val('bilin')) + td(1, 1, lab('TIME OUT', 'r')) + td(1, 1, val('bilout')))}
      ${tr(20, td(5, 1, vert('DISPATCH DEPARTMENT', 'sm'), 'a') + td(1, 1, lab('BILLED BY &amp; CHECKED BY')) + td(1, 1, lab('BILLED BY', 'r')) + td(1, 1, val('billedby')) + td(1, 1, lab('CHECKED BY', 'r')) + td(1, 1, val('checkedby')), true)}
      ${tr(21, td(3, 1, lab('FINAL PACKING CHECKED BY ')) + td(3, 1, val('packby'), 't') + td(1, 2, lab('Video of Machine &amp; Accessories', 'r')) + td(1, 1, val('vid1')))}
      ${tr(22, td(1, 2, lab('Video of Packing', 'r')) + td(1, 1, val('vid2')))}
      ${tr(23, td(1, 2, lab('Stickers Pasting', 'r')) + td(1, 1, val('vid3')))}
      ${tr(24, td(1, 1, lab('HANDOVER TO COURIER  PERSON WITH DIMENSIONS ')) + td(1, 1, val('handover'), 't') + td(1, 2, lab('NEXT DAY BILL CHECKED BY ORDER DISPATCH FORM', 'r')) + td(1, 1, val('nextday')))}
    </table></div>`;
  }

  // rows grow with their text, so nothing has to be shrunk
  function fit() { /* intentionally empty: height is flexible, width is fixed */ }

  function form(id, defaults, opts) {
    opts = opts || {};
    const old = document.getElementById('odfOverlay');
    if (old) old.remove();
    if (!document.getElementById('odfStyles')) {
      const st = document.createElement('style');
      st.id = 'odfStyles';
      st.textContent = FORM_CSS + EDIT_CSS;
      document.head.appendChild(st);
    }
    const storeKey = 'odf2:' + id;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch (e) { saved = {}; }

    const ovl = document.createElement('div');
    ovl.id = 'odfOverlay';
    ovl.className = 'odf-ovl';
    ovl.innerHTML = `
      <div class="odf-bar">
        <b><i class="fa-solid fa-file-lines"></i> Order Dispatch Form</b>
        <span class="hint">Yellow fields are editable. Boxes grow downward on their own when there is more text (width stays fixed). Changes stay saved on this computer.</span>
        <button class="pr"><i class="fa-solid fa-print"></i> Print (A4)</button>
        <button class="rs"><i class="fa-solid fa-rotate-left"></i> Reset to system data</button>
        <button class="cl">Close</button>
      </div>
      <div class="odf-wrap">${formHtml()}</div>`;
    document.body.appendChild(ovl);
    const sheet = ovl.querySelector('.odf-sheet');

    const fill = useSaved => {
      sheet.querySelectorAll('[data-k]').forEach(el => {
        const k = el.dataset.k;
        el.textContent = (useSaved && k in saved) ? saved[k] : (defaults[k] ?? '');
      });
      fit(sheet);
    };
    fill(true);

    const persist = () => {
      const o = {};
      sheet.querySelectorAll('[data-k]').forEach(el => { o[el.dataset.k] = el.innerText.replace(/\n$/, ''); });
      try { localStorage.setItem(storeKey, JSON.stringify(o)); } catch (e) { /* storage full / blocked: ignore */ }
    };
    sheet.addEventListener('input', e => {
      const vb = e.target.closest('.vb');
      if (vb) fit(vb.parentElement);
      persist();
    });
    // paste as plain text only (keeps the form clean)
    sheet.addEventListener('paste', e => {
      if (!e.target.closest('[data-k]')) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text'));
    });
    // single-line cells: Enter moves on instead of adding a line (Shift+Enter = new line)
    sheet.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.matches('span.v')) e.preventDefault();
    });

    const close = () => { ovl.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    ovl.querySelector('.cl').addEventListener('click', close);
    ovl.querySelector('.rs').addEventListener('click', () => {
      if (!confirm('Are You sure you wanna to restore all the entries to Default')) return;
      saved = {};
      try { localStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
      fill(false);
    });
    ovl.querySelector('.pr').addEventListener('click', () => {
      const clone = sheet.cloneNode(true);
      clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
      askOptions('form', o => printDoc('Order Dispatch Form ' + (defaults.ref || ''), clone.outerHTML, FORM_CSS, { isForm: true, duplex: o.duplex, copies: o.copies }));
    });
  }

  // =====================================================================
  //  "Print instead of download" hooks for existing Export buttons.
  //  arm()  -> the NEXT csv download is turned into an A4 print.
  //  intercept(head, rows, name) is called at the top of every csv helper.
  // =====================================================================
  let armed = null, armTimer = null;
  const nice = n => String(n || 'Report').replace(/\.csv$/i, '').replace(/_?\d{4}-\d{2}-\d{2}$/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  function arm(title) {
    armed = { title: title || '' };
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = null; }, 180000);
  }
  function intercept(head, rows, name) {
    if (!armed) return false;
    const t = armed.title || nice(name);
    armed = null;
    clearTimeout(armTimer);
    table({ title: t, head, rows });
    return true;
  }

  // adds a "Print" button beside the "Export" submit button of an export wizard / modal form
  function wizardPrint(modal, title) {
    const form = modal && modal.querySelector('form');
    const sub = form && form.querySelector('button[type=submit]');
    if (!sub || form.querySelector('.a4-print-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'a4-print-btn';
    b.style.cssText = sub.style.cssText;
    b.style.background = '#0f766e';
    b.style.color = '#fff';
    b.innerHTML = '<i class="fa-solid fa-print"></i> Print';
    b.addEventListener('click', () => {
      arm(title);
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    sub.insertAdjacentElement('beforebegin', b);
  }

  // adds a "Print" twin next to a button that exports directly (it re-uses the export's own data)
  function attachTwin(btn, title) {
    if (!btn || btn.dataset.twin) return null;
    btn.dataset.twin = '1';
    const p = btn.cloneNode(false);
    p.removeAttribute('id');
    p.removeAttribute('data-action');
    p.classList.remove('export-users-btn', 'export-customers-btn');
    p.innerHTML = '<i class="fa-solid fa-print"></i> Print';
    p.title = 'Print on A4';
    p.addEventListener('click', e => {
      e.stopPropagation();
      arm(title || (btn.closest('.modal-content,.modal,div')?.querySelector('h3')?.textContent || '').trim());
      btn.click();
    });
    btn.insertAdjacentElement('afterend', p);
    return p;
  }

  return { form, table, attachNextTo, arm, intercept, wizardPrint, attachTwin };
})();