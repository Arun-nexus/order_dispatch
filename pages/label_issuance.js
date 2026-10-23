(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : ''; };
  const fmtMonth = v => { const d = new Date(v); return isNaN(d) ? '' : `${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const PLAIN = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
  const ROWS = 10;
  const STORE = 'Manish kumar', PROD = 'Harsh kumar';
  const blankRow = n => ({ sr: String(n), mat: '', lot: '', qty: '', by: '', to: '' });

  function getP(o, p) { return p.split('.').reduce((a, k) => (a == null ? '' : a[k]), o) ?? ''; }
  function setP(o, p, val) {
    const ks = p.split('.'); const last = ks.pop();
    ks.reduce((a, k) => a[k], o)[last] = val;
  }

  function defaults(row, ctx) {
    const d = row.data || {};
    const disp = d.dispatch || {};
    const asm = (ctx && ctx.assemblyDates) || (typeof QC !== 'undefined' && QC.asm) || {};
    const items = row.kind === 'spare_part'
      ? [{ product_name: d.spare_part?.part_name, quantity: d.spare_part?.quantity }]
      : (d.items || []);
    const ddate = fmtDate(disp.dispatched_at || disp.confirmed_at || d.dispatched_at || disp.invoice_date);
    const label = it => `${it.product_name ?? ''}${it.model_no ? ' (' + it.model_no + ')' : ''}`;
    const serials = items.flatMap(it => it.serial_numbers || []);
    const months = [...new Set(serials.map(sn => asm[sn]).filter(Boolean).map(fmtMonth).filter(Boolean))];
    const total = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const rows = items.map((it, i) => ({
      sr: String(i + 1),
      mat: label(it),
      lot: (it.serial_numbers || []).length ? 'S.No: ' + it.serial_numbers.join(', ') : '',
      qty: it.quantity !== undefined && it.quantity !== null ? String(it.quantity) : '',
      by: STORE,
      to: PROD
    }));
    while (rows.length < ROWS) rows.push(blankRow(rows.length + 1));
    return {
      a1: {
        date: ddate,
        product: items.map(label).filter(Boolean).join('; '),
        lot: serials.length ? 'S.No: ' + serials.join(', ') : '',
        qty: total ? String(total) : '',
        mfg: months.join(', '),
        storage: 'Standard Room Temperature',
        total: total ? String(total) : '',
        used: total ? String(total) : '',
        scrap: 'Zero',
        ret: 'Zero',
        bal: 'Zero',
        issued: STORE,
        recv: PROD,
        qc: 'Shivani Jha',
        rem: 'NA',
        qa: 'Tanuja Manral'
      },
      a2: { rows }
    };
  }

  const CSS = `
    .lb{width:190mm;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:10pt;box-sizing:border-box;margin:0 auto 14px}
    .lb *{box-sizing:border-box}
    .lb h2{font-size:12.5pt;margin:0 0 6px}
    .lb table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:8px}
    .lb td,.lb th{border:1.2px solid #000;padding:1.3mm 1.8mm;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;line-height:1.2;text-align:left}
    .lb th{background:#f1f5f9;font-weight:700;font-size:9pt}
    .lb td.l{font-weight:700;background:#fafafa}
    .lb td.t{text-align:center;font-weight:700;font-size:11pt}
    .lb tr.ir td{height:9mm}
    .lb .v{outline:none;white-space:pre-wrap;display:block;min-height:1.2em}`;
  const EDIT_CSS = `
    .lbx-ovl{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:3000;overflow:auto;padding:0 0 30px}
    .lbx-bar{position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .lbx-bar b{font-size:15px}
    .lbx-bar .hint{font-size:12px;color:#64748b;flex:1;min-width:220px}
    .lbx-bar button{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
    .lbx-bar .pr{background:#1665ff;color:#fff}.lbx-bar .ad{background:#e0f2fe;color:#075985}.lbx-bar .rs{background:#eef1f6;color:#334155}.lbx-bar .cl{background:#fee2e2;color:#b91c1c}
    .lbx-wrap{padding:18px 10px;overflow-x:auto}
    .lbx-wrap .lb{box-shadow:0 4px 24px rgba(0,0,0,.35);padding:8mm;margin-bottom:22px;flex:none}
    .lbx-wrap .lb .v{background:rgba(255,236,150,.28)}
    .lbx-wrap .lb .v:hover,.lbx-wrap .lb .v:focus{background:rgba(255,236,150,.75)}`;

  function a1Html(st, ed) {
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    const l = t => `<td class="l">${t}</td>`;
    return `<div class="lb"><h2>ANNEXURE-1: LABEL ISSUANCE-RETRIEVAL REGISTER FORM (ABM-PRD-QF-002-F1)</h2>
      <table><colgroup><col style="width:24%"><col style="width:26%"><col style="width:28%"><col style="width:22%"></colgroup>
        <tr><td class="t" colspan="4">LABEL ISSUANCE &amp; RETRIEVAL REGISTER</td></tr>
        <tr>${l('Date of Request/Issuance:')}<td>${v('a1.date')}</td>${l('Product Name &amp; Code:')}<td>${v('a1.product')}</td></tr>
        <tr>${l('Lot no / Serial No.')}<td>${v('a1.lot')}</td>${l('Quantity :')}<td>${v('a1.qty')}</td></tr>
        <tr>${l('Mfg. Date:')}<td>${v('a1.mfg')}</td>${l('Storage &amp; Handling Instructions:')}<td>${v('a1.storage')}</td></tr>
        <tr>${l('Total Quantity Issued (A):')}<td>${v('a1.total')}</td>${l('Issued By (Store In-charge Sign &amp; Date):')}<td>${v('a1.issued')}</td></tr>
        <tr>${l('Quantity Used / Applied (B) for:')}<td>${v('a1.used')}</td>${l('Received By (Production In-charge Sign):')}<td>${v('a1.recv')}</td></tr>
        <tr>${l('Quantity Scrapped / Damaged (C):')}<td>${v('a1.scrap')}</td>${l('QC Examination &amp; Verification Sign:')}<td>${v('a1.qc')}</td></tr>
        <tr>${l('Quantity Returned Unused (D):')}<td>${v('a1.ret')}</td>${l('Balance Reconciled (A - B - C - D = 0): [ Yes / No ]')}<td>${v('a1.bal')}</td></tr>
        <tr><td class="l" colspan="4">Remarks / Discrepancy Note: ${v('a1.rem')}</td></tr>
        <tr><td class="l" colspan="4">Verified &amp; Closed By (QA Sign): ${v('a1.qa')}</td></tr>
      </table></div>`;
  }

  function a2Html(st, ed) {
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    const rows = st.a2.rows.map((r, i) => `<tr class="ir">${['sr', 'mat', 'lot', 'qty', 'by', 'to'].map(k => `<td>${v(`a2.rows.${i}.${k}`)}</td>`).join('')}</tr>`).join('');
    return `<div class="lb"><h2>ANNEXURE-2: MATERIAL ISSUANCE LOG BOOK FORM (ABM-PRD-QF-002-F2)</h2>
      <table><colgroup><col style="width:7%"><col style="width:23%"><col style="width:26%"><col style="width:12%"><col style="width:16%"><col style="width:16%"></colgroup>
        <tr><th>S.No.</th><th>Material Name &amp; Specification</th><th>Lot. No. / Batch No./Serial No.</th><th>Quantity Issued</th><th>Issued by (Store)</th><th>Issued to (Production)</th></tr>
        ${rows}
      </table></div>`;
  }

  function openLabelIssuance(row, ctx) {
    document.getElementById('lbxOverlay')?.remove();
    if (!document.getElementById('lbxStyles')) {
      const s = document.createElement('style');
      s.id = 'lbxStyles';
      s.textContent = CSS + EDIT_CSS;
      document.head.appendChild(s);
    }
    const d = row.data || {};
    const id = d.order_id || d.allocation_id || d.spare_part?.service_id || d.dispatch?.invoice_no || 'x';
    const storeKey = 'lb1:' + row.kind + ':' + id;
    let st = defaults(row, ctx);
    try {
      const sv = JSON.parse(localStorage.getItem(storeKey) || 'null');
      if (sv && sv.a1 && sv.a2 && Array.isArray(sv.a2.rows)) st = sv;
    } catch (e) { }

    const ovl = document.createElement('div');
    ovl.id = 'lbxOverlay';
    ovl.className = 'lbx-ovl';
    ovl.innerHTML = `
      <div class="lbx-bar">
        <b><i class="fa-solid fa-tags"></i> Label Issuance (ABM-PRD-QF-002)</b>
        <span class="hint">Yellow fields are editable. Changes stay saved on this computer.</span>
        <button class="ad" data-add><i class="fa-solid fa-plus"></i> Log row</button>
        <button class="pr" data-pr="a1"><i class="fa-solid fa-print"></i> Print Register (F1)</button>
        <button class="pr" data-pr="a2"><i class="fa-solid fa-print"></i> Print Log Book (F2)</button>
        <button class="rs" data-reset><i class="fa-solid fa-rotate-left"></i> Reset to system data</button>
        <button class="cl">Close</button>
      </div>
      <div class="lbx-wrap"></div>`;
    document.body.appendChild(ovl);
    const wrap = ovl.querySelector('.lbx-wrap');
    const render = () => { wrap.innerHTML = a1Html(st, true) + a2Html(st, true); };
    const persist = () => { try { localStorage.setItem(storeKey, JSON.stringify(st)); } catch (e) { } };
    render();

    wrap.addEventListener('input', e => {
      const el = e.target.closest('[data-p]');
      if (!el) return;
      setP(st, el.dataset.p, el.innerText.replace(/\n$/, ''));
      persist();
    });
    wrap.addEventListener('paste', e => {
      if (!e.target.closest('[data-p]')) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text'));
    });
    const close = () => { ovl.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ovl.querySelector('.cl').addEventListener('click', close);
    ovl.querySelector('[data-add]').addEventListener('click', () => {
      st.a2.rows.push(blankRow(st.a2.rows.length + 1));
      persist(); render();
    });
    ovl.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm('Are You sure you wanna to restore all the entries to Default')) return;
      try { localStorage.removeItem(storeKey); } catch (e) { }
      st = defaults(row, ctx); render();
    });
    ovl.querySelectorAll('[data-pr]').forEach(b => b.addEventListener('click', () => {
      if (typeof qcPrintWindow !== 'function') { alert('Print is not available.'); return; }
      const f2 = b.dataset.pr === 'a2';
      qcPrintWindow(`<style>${CSS}.lb{width:100%;margin:0}</style>${f2 ? a2Html(st, false) : a1Html(st, false)}`, f2 ? 'Material Issuance Log Book' : 'Label Issuance Register', false);
    }));
  }

  window.openLabelIssuance = openLabelIssuance;
})();