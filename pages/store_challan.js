(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : ''; };
  const fmtMonth = v => { const d = new Date(v); return isNaN(d) ? '' : `${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const PLAIN = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
  const F1_ROWS = 9, F2_ROWS = 10;

  const blankItem = () => ({ sr: '', desc: '', batch: '', mfg: '', unit: '', qty: '', rem: '' });
  const blankReg = () => ({ sr: '', date: '', no: '', cust: '', trans: '', pk: '', sec: '', gate: '', rem: '' });

  function defaults(row, ctx) {
    const d = row.data || {};
    const disp = d.dispatch || {};
    const asm = (ctx && ctx.assemblyDates) || (typeof QC !== 'undefined' && QC.asm) || {};
    const items = row.kind === 'spare_part'
      ? [{ product_name: d.spare_part?.part_name, quantity: d.spare_part?.quantity }]
      : (d.items || []);
    const cust = d.customer || {};
    const customer = row.kind === 'order' ? (cust.company_name || '')
      : row.kind === 'product_allocation' ? (d.sales_person?.name || d.company_name || '')
        : `Service #${String(d.spare_part?.service_id || '').slice(0, 8)}`;
    const custAddr = cust.company_address || d.company_address || '';
    const delivery = d.ship_to_different && d.ship_to_address ? d.ship_to_address : (disp.ship_to_address || custAddr);
    const modeMap = { courier: 'Courier', road: 'By Vehicle', self_pickup: 'By Hand' };
    const mode = [modeMap[disp.mode_of_delivery] || '', disp.dispatched_through || ''].filter(Boolean).join(' - ');
    const invoice = [disp.invoice_no || d.invoice_no || '', fmtDate(disp.invoice_date)].filter(Boolean).join(' / ');
    const invNo = disp.invoice_no || d.invoice_no || '';
    const ddate = fmtDate(disp.dispatched_at || disp.confirmed_at || d.dispatched_at || disp.invoice_date);
    const docket = disp.docket_no ? `Docket: ${String(disp.docket_no).toUpperCase()}` : '';
    const tItems = items.map((it, i) => {
      const months = [...new Set((it.serial_numbers || []).map(sn => asm[sn]).filter(Boolean).map(fmtMonth).filter(Boolean))];
      return {
        sr: String(i + 1),
        desc: `${it.product_name ?? ''}${it.model_no ? ' (' + it.model_no + ')' : ''}`,
        batch: (it.serial_numbers || []).length ? 'S.No: ' + it.serial_numbers.join(', ') : '',
        mfg: months.join(', '),
        unit: '',
        qty: it.quantity !== undefined && it.quantity !== null ? String(it.quantity) : '',
        rem: ''
      };
    });
    while (tItems.length < F1_ROWS) tItems.push(blankItem());
    const reg = [{ ...blankReg(), sr: '1', date: ddate, no: invNo, cust: [customer, custAddr].filter(Boolean).join(', '), trans: [disp.dispatched_through, docket].filter(Boolean).join(' / '), sec: 'Yes', rem: 'OK' }];
    while (reg.length < F2_ROWS) reg.push(blankReg());
    return {
      f1: {
        challan: invNo, mode, customer, invoice, delivery, billing: custAddr, inspect: 'OK', ddate,
        act1: 'Activity', prep_name: 'Manish Kumar', prep_des: 'Store Personnel', app_name: 'Tanuja manral', app_des: 'Quality assurance executive', items: tItems
      },
      f2: { act1: 'Vishal Sharma', prep_name: 'Manish Kumar', prep_des: 'Store Personnel', app_name: 'Tanuja manral', app_des: 'Quality assurance executive', rows: reg }
    };
  }

  const CSS = `
    .sc{width:190mm;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:10pt;box-sizing:border-box;margin:0 auto 14px}
    .sc.land{width:277mm}
    .sc *{box-sizing:border-box}
    .sc h2{font-size:12.5pt;margin:0 0 6px}
    .sc h2 small{font-size:10pt;font-weight:700;margin-left:10px}
    .sc table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:8px}
    .sc td,.sc th{border:1.2px solid #000;padding:1.3mm 1.8mm;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;line-height:1.2;text-align:left}
    .sc th{background:#f1f5f9;font-weight:700;font-size:9pt}
    .sc td.l{font-weight:700;background:#fafafa}
    .sc tr.ir td{height:9mm}
    .sc .v{outline:none;white-space:pre-wrap;display:block;min-height:1.2em}`;
  const EDIT_CSS = `
    .scx-ovl{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:3000;overflow:auto;padding:0 0 30px}
    .scx-bar{position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .scx-bar b{font-size:15px}
    .scx-bar .hint{font-size:12px;color:#64748b;flex:1;min-width:220px}
    .scx-bar button{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
    .scx-bar .pr{background:#1665ff;color:#fff}.scx-bar .ad{background:#e0f2fe;color:#075985}.scx-bar .rs{background:#eef1f6;color:#334155}.scx-bar .cl{background:#fee2e2;color:#b91c1c}
    .scx-wrap{padding:18px 10px;overflow-x:auto}
    .scx-wrap .sc{box-shadow:0 4px 24px rgba(0,0,0,.35);padding:8mm;margin-bottom:22px;flex:none}
    .scx-wrap .sc .v{background:rgba(255,236,150,.28)}
    .scx-wrap .sc .v:hover,.scx-wrap .sc .v:focus{background:rgba(255,236,150,.75)}`;

  function f1Html(st, ed) {
    const f = st.f1;
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    const lab = t => `<td class="l">${t}</td>`;
    const items = f.items.map((it, i) => `<tr class="ir"><td>${v(`f1.items.${i}.sr`)}</td><td>${v(`f1.items.${i}.desc`)}</td><td>${v(`f1.items.${i}.batch`)}</td><td>${v(`f1.items.${i}.mfg`)}</td><td>${v(`f1.items.${i}.unit`)}</td><td>${v(`f1.items.${i}.qty`)}</td><td>${v(`f1.items.${i}.rem`)}</td></tr>`).join('');
    return `<div class="sc"><h2>ANNEXURE-1: CHALLAN / OUTWARD FORM <small>ABM-STR-QF-002-F1</small></h2>
      <table><colgroup><col style="width:22%"><col style="width:28%"><col style="width:22%"><col style="width:28%"></colgroup>
        <tr>${lab('Challan  / invoice No.:')}<td>${v('f1.challan')}</td>${lab('Mode of Transport:')}<td>${v('f1.mode')}</td></tr>
        <tr>${lab('Customer / Consignee Name:')}<td>${v('f1.customer')}</td>${lab('Invoice No. &amp; Date:')}<td>${v('f1.invoice')}</td></tr>
        <tr>${lab('Delivery Address:')}<td>${v('f1.delivery')}</td>${lab('Billing Address:')}<td>${v('f1.billing')}</td></tr>
        <tr>${lab('Pre-Dispatch Inspection Status:')}<td>${v('f1.inspect')}</td>${lab('Date of Dispatch:')}<td>${v('f1.ddate')}</td></tr>
      </table>
      <table><colgroup><col style="width:5%"><col style="width:22%"><col style="width:22%"><col style="width:11%"><col style="width:8%"><col style="width:12%"><col style="width:20%"></colgroup>
        <tr><th>Sr. No.</th><th>Item Description / Material Name</th><th>Batch No./serial_no</th><th>Mfg. Date</th><th>Unit</th><th>Total quantity (boxes)</th><th>Remarks</th></tr>
        ${items}
      </table>${sigHtml(st, 'f1', ed)}</div>`;
  }

  function sigHtml(st, w, ed) {
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    return `<table><colgroup><col style="width:34%"><col style="width:33%"><col style="width:33%"></colgroup>
      <tr><td class="l">${w === 'f1' ? 'Activity' : v('f2.act1')}</td><td class="l">Prepared By</td><td class="l">Approved By</td></tr>
      <tr><td>Name</td><td>${v(`${w}.prep_name`)}</td><td>${v(`${w}.app_name`)}</td></tr>
      <tr><td>Designation &amp; Sign</td><td>${v(`${w}.prep_des`)}</td><td>${v(`${w}.app_des`)}</td></tr></table>`;
  }

  function f2Html(st, ed) {
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    const rows = st.f2.rows.map((r, i) => `<tr class="ir">${['sr', 'date', 'no', 'cust', 'trans', 'pk', 'sec', 'gate', 'rem'].map(k => `<td>${v(`f2.rows.${i}.${k}`)}</td>`).join('')}</tr>`).join('');
    return `<div class="sc land"><h2>ANNEXURE-2: OUTWARD REGISTER <small>ABM-STR-QF-002-F2</small></h2>
      <table><colgroup><col style="width:5%"><col style="width:9%"><col style="width:11%"><col style="width:18%"><col style="width:16%"><col style="width:10%"><col style="width:10%"><col style="width:9%"><col style="width:12%"></colgroup>
        <tr><th>S. No.</th><th>Date</th><th>Invoice No. / Challan No.</th><th>Customer Name &amp; Location</th><th>Transporter Details</th><th>No. of Packages (Nos/Box)</th><th>Security Check Done (Y/N)</th><th>Gate Supervisor Sign</th><th>Remarks</th></tr>
        ${rows}
      </table>${sigHtml(st, 'f2', ed)}</div>`;
  }

  function getP(o, p) { return p.split('.').reduce((a, k) => (a == null ? '' : a[k]), o) ?? ''; }
  function setP(o, p, val) {
    const ks = p.split('.'); const last = ks.pop();
    ks.reduce((a, k) => a[k], o)[last] = val;
  }

  function openStoreChallan(row, ctx) {
    document.getElementById('scxOverlay')?.remove();
    if (!document.getElementById('scxStyles')) {
      const s = document.createElement('style');
      s.id = 'scxStyles';
      s.textContent = CSS + EDIT_CSS;
      document.head.appendChild(s);
    }
    const d = row.data || {};
    const id = d.order_id || d.allocation_id || d.spare_part?.service_id || d.dispatch?.invoice_no || 'x';
    const storeKey = 'sc3:' + row.kind + ':' + id;
    let st = defaults(row, ctx);
    try {
      const sv = JSON.parse(localStorage.getItem(storeKey) || 'null');
      if (sv && sv.f1 && sv.f2 && Array.isArray(sv.f1.items) && Array.isArray(sv.f2.rows)) st = sv;
    } catch (e) { }

    const ovl = document.createElement('div');
    ovl.id = 'scxOverlay';
    ovl.className = 'scx-ovl';
    ovl.innerHTML = `
      <div class="scx-bar">
        <b><i class="fa-solid fa-file-invoice"></i> Store Challan (ABM-STR-SOP-002)</b>
        <span class="hint">Yellow fields are editable. Blank fields can be filled before printing. Changes stay saved on this computer.</span>
        <button class="ad" data-add="items"><i class="fa-solid fa-plus"></i> Item row</button>
        <button class="ad" data-add="reg"><i class="fa-solid fa-plus"></i> Register row</button>
        <button class="pr" data-pr="f1"><i class="fa-solid fa-print"></i> Print Challan (F1)</button>
        <button class="pr" data-pr="f2"><i class="fa-solid fa-print"></i> Print Register (F2)</button>
        <button class="rs"><i class="fa-solid fa-rotate-left"></i> Reset to system data</button>
        <button class="cl">Close</button>
      </div>
      <div class="scx-wrap"></div>`;
    document.body.appendChild(ovl);
    const wrap = ovl.querySelector('.scx-wrap');
    const render = () => { wrap.innerHTML = f1Html(st, true) + f2Html(st, true); };
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
    ovl.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.add === 'items') st.f1.items.push(blankItem()); else st.f2.rows.push(blankReg());
      persist(); render();
    }));
    ovl.querySelector('.rs').addEventListener('click', () => {
      if (!confirm('Are You sure you wanna to restore all the entries to Default')) return;
      try { localStorage.removeItem(storeKey); } catch (e) { }
      st = defaults(row, ctx); render();
    });
    ovl.querySelectorAll('[data-pr]').forEach(b => b.addEventListener('click', () => {
      if (typeof qcPrintWindow !== 'function') { alert('Print is not available.'); return; }
      const f2 = b.dataset.pr === 'f2';
      qcPrintWindow(`<style>${CSS}.sc{width:100%;margin:0}</style>${f2 ? f2Html(st, false) : f1Html(st, false)}`, f2 ? 'Outward Register' : 'Challan / Outward Form', f2);
    }));
  }

  window.openStoreChallan = openStoreChallan;
})();