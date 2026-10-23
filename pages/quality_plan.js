(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : ''; };
  const PLAIN = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
  const MIN_ROWS = 10;

  const A1 = [
    ['Stage 1: Incoming Material QC', 'Dimensions, Visual Defects, Supplier COA Verification (if available)', 'As per Raw Material Specs / Approved Drawing', 'Visual inspection', '100% Visual', 'Zero Defects, Pass Specs', 'QC Executive', 'Incoming QC register'],
    ['Stage 2: In-Process Inspection (IPQC)', 'Component verification, electrical/wiring, line clearance, Assembly/fitment check', 'As per drawing approved. Approved by BOM', 'Visual inspection', '100% Visual', 'Zero defects, correct fitments & connection', 'QC Executive', 'Batch manufacturing record'],
    ['Stage 3: Finished Goods Inspection', 'Functional Testing, Physical Dimension, Cleanliness, Workmanship', 'Finished Product Specification', 'Visual inspection', 'Visual verification, measuring instrument', 'Correct model no., variant, serial no.', 'QC Executive', 'Finished good QC register'],
    ['Stage 4: Post Packing & Pre-Dispatch (PDI)', 'Proper Packaging & wrapping with belt, Labeling & tagging, Box Quantity', 'Packaging & Labeling', 'Visual inspection', '100% Visual', 'Correct labeling, pristine box', 'QC Executive', 'Batch manufacturing record']
  ];
  const A1K = ['stage', 'param', 'spec', 'method', 'plan', 'accept', 'agency', 'rec'];
  const A2K = ['sr', 'date', 'mat', 'sup', 'inv', 'qty', 'rep', 'coa', 'st', 'disp', 'sign'];
  const A3K = ['sr', 'date', 'prod', 'lot', 'mfg', 'qty', 'rep', 'res', 'status', 'qc', 'qa'];
  const blank = keys => Object.fromEntries(keys.map(k => [k, '']));

  function getP(o, p) { return p.split('.').reduce((a, k) => (a == null ? '' : a[k]), o) ?? ''; }
  function setP(o, p, val) {
    const ks = p.split('.'); const last = ks.pop();
    ks.reduce((a, k) => a[k], o)[last] = val;
  }

  const norm = x => String(x || '').trim().toLowerCase();

  function lotsFor(asm, inv, ships, part) {
    const n = norm(part.part_name), bt = norm(part.belongs_to);
    const snap = (asm.part_sources || []).find(s => norm(s.part_name) === n && (!bt || !norm(s.belongs_to) || norm(s.belongs_to) === bt));
    if (snap && (snap.lots || []).length) {
      return snap.lots.map(l => ({ date: l.purchase_date, sup: l.supplier, inv: l.invoice_no, qty: l.quantity }));
    }
    const live = inv.filter(x => x.product_type === 'spare_parts' && norm(x.product_name) === n
      && (!bt || norm(x.parent_product_name) === bt) && x.supplier);
    live.sort((x, y) => new Date(y.purchase_date || 0) - new Date(x.purchase_date || 0));
    if (live.length) return [{ date: live[0].purchase_date, sup: live[0].supplier, inv: live[0].invoice_no, qty: part.quantity }];
    for (const sh of ships) {
      const hit = (sh.products || []).some(p => (!bt || norm(p.product_name) === bt)
        && (p.parts || []).some(pt => norm(pt.part_name) === n));
      if (hit && sh.company_name) return [{ date: sh.received_date || sh.dispatch_date, sup: sh.company_name, inv: sh.invoice_no, qty: part.quantity }];
    }
    return [{ date: '', sup: '', inv: '', qty: part.quantity }];
  }

  function defaults(asm, inv, ships) {
    const when = asm.completed_at || asm.assembly_date || asm.created_at;
    const a2 = [];
    (asm.parts_used || []).forEach(p => {
      const mat = `${p.part_name || ''}${p.belongs_to ? ' (' + p.belongs_to + ')' : ''}`;
      const lots = p.source === 'local'
        ? [{ date: when, sup: 'Local Purchase', inv: '', qty: p.quantity }]
        : lotsFor(asm, inv, ships, p);
      lots.forEach(l => a2.push({
        sr: String(a2.length + 1),
        date: fmtDate(l.date) || fmtDate(when),
        mat,
        sup: l.sup || '',
        inv: l.inv || '',
        qty: l.qty ? `${l.qty} Nos` : '',
        rep: '', coa: '', st: 'OK', disp: 'Accepted', sign: ''
      }));
    });
    while (a2.length < MIN_ROWS) a2.push(blank(A2K));
    const lots = {};
    (asm.serials || []).forEach(s => { const k = s.lot_no || '-'; lots[k] = (lots[k] || 0) + 1; });
    const released = asm.status === 'completed';
    const a3 = Object.entries(lots).map(([lot, n], i) => ({
      sr: String(i + 1),
      date: fmtDate(when),
      prod: `${asm.product_name || ''}${asm.model_number ? ' (' + asm.model_number + ')' : ''}`,
      lot: lot === '-' ? '' : lot,
      mfg: fmtDate(when),
      qty: String(n),
      rep: '', res: 'Pass', status: released ? 'Released' : 'Hold', qc: '', qa: ''
    }));
    while (a3.length < MIN_ROWS) a3.push(blank(A3K));
    return { a1: A1.map(r => Object.fromEntries(A1K.map((k, i) => [k, r[i]]))), a2, a3 };
  }

  const CSS = `
    .qp{width:277mm;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:10pt;box-sizing:border-box;margin:0 auto 14px}
    .qp *{box-sizing:border-box}
    .qp h2{font-size:12.5pt;margin:0 0 6px}
    .qp h2 small{font-size:10pt;font-weight:700;margin-left:10px}
    .qp table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:8px}
    .qp td,.qp th{border:1.2px solid #000;padding:1.3mm 1.8mm;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;line-height:1.2;text-align:left}
    .qp th{background:#f1f5f9;font-weight:700;font-size:9pt}
    .qp td.l{font-weight:700;background:#fafafa}
    .qp tr.ir td{height:9mm}
    .qp .v{outline:none;white-space:pre-wrap;display:block;min-height:1.2em}`;
  const EDIT_CSS = `
    .qpx-ovl{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:3000;overflow:auto;padding:0 0 30px}
    .qpx-bar{position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .qpx-bar b{font-size:15px}
    .qpx-bar .hint{font-size:12px;color:#64748b;flex:1;min-width:220px}
    .qpx-bar button{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
    .qpx-bar .pr{background:#1665ff;color:#fff}.qpx-bar .ad{background:#e0f2fe;color:#075985}.qpx-bar .rs{background:#eef1f6;color:#334155}.qpx-bar .cl{background:#fee2e2;color:#b91c1c}
    .qpx-wrap{padding:18px 10px;overflow-x:auto}
    .qpx-wrap .qp{box-shadow:0 4px 24px rgba(0,0,0,.35);padding:8mm;margin-bottom:22px;flex:none}
    .qpx-wrap .qp .v{background:rgba(255,236,150,.28)}
    .qpx-wrap .qp .v:hover,.qpx-wrap .qp .v:focus{background:rgba(255,236,150,.75)}
    .qpx-list{max-width:1100px;margin:18px auto;background:#fff;border-radius:14px;padding:18px}
    .qpx-list input{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:12px;font-size:14px}
    .qpx-list table{width:100%;border-collapse:collapse;font-size:13.5px}
    .qpx-list th{background:#eaf2ff;padding:10px;text-align:left}
    .qpx-list td{padding:10px;border-top:1px solid #eef1f6}
    .qpx-list button{padding:6px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600}`;

  function sigHtml() {
    return `<table><colgroup><col style="width:50%"><col style="width:50%"></colgroup>
      <tr><td>Prepared By (Quality control manager): Komal<br><br>Sign___________</td><td>Approved (By Director): Prashant sharma<br><br>Sign___________</td></tr></table>`;
  }

  function section(st, ed, which) {
    const ce = ed ? ` contenteditable="${PLAIN}"` : '';
    const v = p => `<span class="v"${ce} data-p="${p}">${esc(getP(st, p))}</span>`;
    if (which === 'a1') {
      const rows = st.a1.map((r, i) => `<tr class="ir">${A1K.map(k => `<td>${v(`a1.${i}.${k}`)}</td>`).join('')}</tr>`).join('');
      return `<div class="qp"><h2>ANNEXURE-1: QUALITY PLAN <small>ABM-QC-QF-001-F1</small></h2>
        <table><colgroup><col style="width:12%"><col style="width:18%"><col style="width:12%"><col style="width:10%"><col style="width:11%"><col style="width:13%"><col style="width:10%"><col style="width:14%"></colgroup>
        <tr><th>Stage</th><th>Inspection / Testing Parameter</th><th>Specification / Standard</th><th>Testing Method / Reference</th><th>Sampling Plan</th><th>Acceptance Criteria</th><th>Inspection Agency</th><th>Record Format</th></tr>
        ${rows}</table>${sigHtml()}</div>`;
    }
    if (which === 'a2') {
      const rows = st.a2.map((r, i) => `<tr class="ir">${A2K.map(k => `<td>${v(`a2.${i}.${k}`)}</td>`).join('')}</tr>`).join('');
      return `<div class="qp"><h2>ANNEXURE-2: INCOMING MATERIAL QC REGISTER <small>ABM-QC-QF-001-F2</small></h2>
        <table><colgroup><col style="width:4%"><col style="width:8%"><col style="width:14%"><col style="width:12%"><col style="width:9%"><col style="width:8%"><col style="width:11%"><col style="width:7%"><col style="width:9%"><col style="width:9%"><col style="width:9%"></colgroup>
        <tr><th>Sr no</th><th>Date</th><th>Material Name / Description</th><th>Supplier / Manufacturer Name</th><th>Invoice no.</th><th>Qty Received (Unit)</th><th>QC Report No. (QC/IM/YY-YY/XXX)</th><th>Supplier COA (Y/N)</th><th>Inspection / Test Status</th><th>Disposition (Accepted / Rejected)</th><th>QC Sign &amp; Date</th></tr>
        ${rows}</table>${sigHtml()}</div>`;
    }
    const rows = st.a3.map((r, i) => `<tr class="ir">${A3K.map(k => `<td>${v(`a3.${i}.${k}`)}</td>`).join('')}</tr>`).join('');
    return `<div class="qp"><h2>ANNEXURE-3: FINISHED GOOD QC REGISTER <small>ABM-QC-QF-001-F3</small></h2>
      <table><colgroup><col style="width:5%"><col style="width:8%"><col style="width:14%"><col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:11%"><col style="width:10%"><col style="width:9%"><col style="width:9%"><col style="width:10%"></colgroup>
      <tr><th>S.N.</th><th>Date</th><th>Product Name / Device Type</th><th>Batch / Lot No.</th><th>Mfg. Date</th><th>Batch Qty Passed (Pcs)</th><th>QC Report No. (QC/FG/YY-YY/XXX)</th><th>Testing / Inspection Result</th><th>Status (Released / Hold)</th><th>QC Officer Sign</th><th>QA Head Release Sign</th></tr>
      ${rows}</table>${sigHtml()}</div>`;
  }

  async function loadJson(url) {
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(url);
    return r.json();
  }

  async function loadInventory() {
    if (typeof QC !== 'undefined' && QC.rows && QC.rows.length) return QC.rows.filter(r => r.type === 'inventory').map(r => r.data);
    try { return (await loadJson('/inventory/')).dataset || []; } catch (e) { return []; }
  }

  function openQualityPlan() {
    document.getElementById('qpxOverlay')?.remove();
    if (!document.getElementById('qpxStyles')) {
      const s = document.createElement('style');
      s.id = 'qpxStyles';
      s.textContent = CSS + EDIT_CSS;
      document.head.appendChild(s);
    }
    const ovl = document.createElement('div');
    ovl.id = 'qpxOverlay';
    ovl.className = 'qpx-ovl';
    document.body.appendChild(ovl);
    const close = () => { ovl.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    let list = [];
    let inv = [];
    let ships = [];

    const showList = async () => {
      ovl.innerHTML = `<div class="qpx-bar"><b><i class="fa-solid fa-clipboard-list"></i> Quality Plan - Select Assembly</b><span class="hint">Kisi bhi assembly par click karo, form auto-fill ho jayega.</span><button class="cl">Close</button></div>
        <div class="qpx-list"><input id="qpxSearch" placeholder="Search assembly ID, product, model, serial..."><div id="qpxTable">Loading...</div></div>`;
      ovl.querySelector('.cl').addEventListener('click', close);
      try {
        const [a, i, sh] = await Promise.all([list.length ? { dataset: list } : loadJson('/assembly/'), inv.length ? inv : loadInventory(), ships.length ? { dataset: ships } : loadJson('/shipment/').catch(() => ({ dataset: [] }))]);
        list = (a.dataset || []).slice().sort((x, y) => new Date(y.completed_at || y.assembly_date || y.created_at || 0) - new Date(x.completed_at || x.assembly_date || x.created_at || 0));
        inv = i;
        ships = sh.dataset || [];
      } catch (e) {
        ovl.querySelector('#qpxTable').textContent = 'Could not load assemblies.';
        return;
      }
      const draw = () => {
        const q = ovl.querySelector('#qpxSearch').value.trim().toLowerCase();
        const rows = list.filter(a => !q || `${a.assembly_id} ${a.product_name} ${a.model_number} ${a.status} ${(a.serials || []).map(s => s.serial_number + ' ' + s.lot_no).join(' ')}`.toLowerCase().includes(q));
        ovl.querySelector('#qpxTable').innerHTML = `<table><thead><tr><th>Assembly ID</th><th>Product</th><th>Model</th><th>Qty</th><th>Parts</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>${rows.map(a => `<tr><td>${esc(String(a.assembly_id || '').slice(0, 8))}</td><td>${esc(a.product_name)}</td><td>${esc(a.model_number)}</td><td>${esc(a.quantity)}</td><td>${(a.parts_used || []).length}</td><td>${esc(String(a.status || '').replace(/_/g, ' '))}</td><td>${fmtDate(a.completed_at || a.assembly_date || a.created_at)}</td><td><button data-id="${esc(a.assembly_id)}">Open</button></td></tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">No assemblies found.</td></tr>'}</tbody></table>`;
        ovl.querySelectorAll('#qpxTable [data-id]').forEach(b => b.addEventListener('click', () => showForm(list.find(a => String(a.assembly_id) === b.dataset.id))));
      };
      ovl.querySelector('#qpxSearch').addEventListener('input', draw);
      draw();
    };

    const showForm = asm => {
      if (!asm) return;
      const storeKey = 'qp2:' + asm.assembly_id;
      let st = defaults(asm, inv, ships);
      try {
        const sv = JSON.parse(localStorage.getItem(storeKey) || 'null');
        if (sv && Array.isArray(sv.a1) && Array.isArray(sv.a2) && Array.isArray(sv.a3)) st = sv;
      } catch (e) { }
      ovl.innerHTML = `<div class="qpx-bar">
          <button class="rs" data-back>&larr; Back</button>
          <b>Quality Plan (ABM-QC-QF-001) - ${esc(asm.product_name || '')} ${esc(String(asm.assembly_id || '').slice(0, 8))}</b>
          <span class="hint">Yellow fields editable hain. Changes is computer par save rehte hain.</span>
          <button class="ad" data-add="a2"><i class="fa-solid fa-plus"></i> Incoming row</button>
          <button class="ad" data-add="a3"><i class="fa-solid fa-plus"></i> FG row</button>
          <button class="pr" data-pr="a1"><i class="fa-solid fa-print"></i> Print F1</button>
          <button class="pr" data-pr="a2"><i class="fa-solid fa-print"></i> Print F2</button>
          <button class="pr" data-pr="a3"><i class="fa-solid fa-print"></i> Print F3</button>
          <button class="rs" data-reset><i class="fa-solid fa-rotate-left"></i> Reset</button>
          <button class="cl">Close</button>
        </div><div class="qpx-wrap"></div>`;
      const wrap = ovl.querySelector('.qpx-wrap');
      const render = () => { wrap.innerHTML = section(st, true, 'a1') + section(st, true, 'a2') + section(st, true, 'a3'); };
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
      ovl.querySelector('.cl').addEventListener('click', close);
      ovl.querySelector('[data-back]').addEventListener('click', showList);
      ovl.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
        st[b.dataset.add].push(blank(b.dataset.add === 'a2' ? A2K : A3K));
        persist(); render();
      }));
      ovl.querySelector('[data-reset]').addEventListener('click', () => {
        if (!confirm('Are You sure you wanna to restore all the entries to Default')) return;
        try { localStorage.removeItem(storeKey); } catch (e) { }
        st = defaults(asm, inv, ships); render();
      });
      const titles = { a1: 'Quality Plan', a2: 'Incoming Material QC Register', a3: 'Finished Good QC Register' };
      ovl.querySelectorAll('[data-pr]').forEach(b => b.addEventListener('click', () => {
        if (typeof qcPrintWindow !== 'function') { alert('Print is not available.'); return; }
        qcPrintWindow(`<style>${CSS}.qp{width:100%;margin:0}</style>${section(st, false, b.dataset.pr)}`, titles[b.dataset.pr], true);
      }));
    };

    showList();
  }

  window.openQualityPlan = openQualityPlan;
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('qcQuality')?.addEventListener('click', openQualityPlan);
  });
})();