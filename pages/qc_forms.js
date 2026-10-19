(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoDate = v => {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const showDate = iso => (iso ? iso.split('-').reverse().join('/') : '');

  const F1 = [
    ['customer', 'Customer Name', 'text'],
    ['ref_no', 'Invoice No. / Inquiry / PO No. / PI No.', 'text'],
    ['product', 'Product Name & Model No.', 'text'],
    ['qty', 'Quantity', 'text'],
    ['delivery', 'Delivery Schedule', 'choice', ['Standard', 'Urgent']],
    ['regulatory', 'Regulatory Requirements', 'text'],
    ['technical', 'Technical Requirements Reviewed', 'choice', ['Yes', 'No']],
    ['commercial', 'Commercial Terms Reviewed', 'choice', ['Yes', 'No']],
    ['capability', 'Capability Confirmed', 'choice', ['Yes', 'No']],
    ['remarks', 'Review Remarks', 'choice', ['Regular Order', 'Tender Specific', 'As Per Specification']],
    ['reviewed_by', 'Reviewed By', 'text'],
    ['reviewed_date', 'Reviewed Date', 'date'],
    ['approved_by', 'Approved By', 'text'],
    ['approved_date', 'Approved Date', 'date']
  ];
  const F2 = [
    ['customer', 'Customer Name', 'text'],
    ['invoice_no', 'Invoice No.', 'text'],
    ['product', 'Product Details', 'text'],
    ['qty', 'Quantity', 'text'],
    ['mfg', 'Manufacturing Details (month/year)', 'text'],
    ['qa', 'QA Inspection Status', 'choice', ['Pass', 'Fail']],
    ['packing', 'Packing Verified', 'choice', ['Yes', 'No']],
    ['label', 'Label Verified', 'choice', ['Yes', 'No']],
    ['dispatch_mode', 'Dispatch Details', 'choice', ['Courier', 'By Vehicle', 'Porter', 'By Hand']],
    ['dispatch_date', 'Dispatch Date', 'date'],
    ['transport', 'Transport Details', 'text'],
    ['checked_by', 'Checked By', 'text'],
    ['checked_date', 'Checked Date', 'date'],
    ['approved_by', 'Approved By', 'text'],
    ['approved_date', 'Approved Date', 'date']
  ];

  function defaultsFor(row, ctx) {
    const d = row.data || {};
    const disp = d.dispatch || {};
    const items = row.kind === 'spare_part'
      ? [{ product_name: d.spare_part?.part_name, quantity: d.spare_part?.quantity }]
      : (d.items || []);
    const customer = row.kind === 'order' ? (d.customer?.company_name || '')
      : row.kind === 'product_allocation' ? (d.sales_person?.name || d.company_name || '')
        : `Service #${(d.spare_part?.service_id || '').slice(0, 8)}`;
    const product = items.map(i => `${i.product_name ?? ''}${i.model_no ? ' (' + i.model_no + ')' : ''}`).filter(Boolean).join('; ');
    const total = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const qty = items.length > 1 ? `${total} (${items.map(i => i.quantity ?? 0).join(' + ')})` : (items.length ? String(items[0].quantity ?? '') : '');
    const asm = (ctx && ctx.assemblyDates) || {};
    const fmtMonth = v => { const x = new Date(v); return isNaN(x) ? '' : `${pad(x.getMonth() + 1)}/${x.getFullYear()}`; };
    const mfgParts = items.map(it => {
      const months = [...new Set((it.serial_numbers || []).map(sn => asm[sn]).filter(Boolean).map(fmtMonth).filter(Boolean))];
      return months.length ? { name: it.product_name ?? '', months } : null;
    }).filter(Boolean);
    const mfg = mfgParts.length === 1 && items.length === 1 ? mfgParts[0].months.join(', ') : mfgParts.map(p => `${p.name}: ${p.months.join(', ')}`).join('; ');
    const modeMap = { courier: 'Courier', road: 'By Vehicle', self_pickup: 'By Hand' };
    const transport = [disp.dispatched_through, disp.docket_no ? `Docket: ${String(disp.docket_no).toUpperCase()}` : ''].filter(Boolean).join(' / ');
    const order = row.kind === 'order' ? (d.order_id || '') : (d.allocation_id || '');
    const who = n => (ctx && ctx.personName ? ctx.personName(n) : n) || '';
    const creator = who(d.creator?.raised_by || d.created_by || d.allocated_by) || 'Om Pal';
    const orderDate = isoDate(d.order_date || d.allotment_date || d.created_at);
    const dispatchDate = isoDate(disp.dispatched_at || disp.confirmed_at || d.dispatched_at || disp.invoice_date);
    return {
      f1: {
        customer,
        ref_no: disp.invoice_no || d.invoice_no || d.po_no || d.pi_no || (order ? order.slice(0, 8) : ''),
        product, qty,
        delivery: 'Standard',
        regulatory: 'None',
        technical: 'Yes',
        commercial: 'Yes',
        capability: 'Yes',
        remarks: 'Regular Order',
        reviewed_by: who(d.reference || d.creator?.raised_by || d.created_by),
        approved_by: creator,
        approved_date: orderDate
      },
      f2: {
        customer,
        invoice_no: disp.invoice_no || d.invoice_no || '',
        product, qty, mfg,
        qa: 'Pass',
        packing: 'Yes',
        label: 'Yes',
        dispatch_mode: modeMap[disp.mode_of_delivery] || '',
        dispatch_date: dispatchDate,
        transport,
        checked_by: 'Manish',
        checked_date: dispatchDate,
        approved_by: 'Om Pal',
        approved_date: dispatchDate
      }
    };
  }

  const css = `@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Calibri,Arial,sans-serif;font-size:12pt;color:#000;margin:0}
.page{page-break-after:always;padding:4px}.page:last-child{page-break-after:auto}
h2{font-size:14pt;margin:0 0 22px}.line{margin:13px 0;line-height:1.5}
.u{display:inline-block;min-width:300px;border-bottom:1px solid #000;padding:0 4px;vertical-align:bottom}
.opt{margin-right:16px;white-space:nowrap}.on{font-weight:700}
table.sig{width:100%;border-collapse:collapse;margin:22px 0}
table.sig td{border:1px solid #000;padding:8px 10px;vertical-align:top;width:50%}
table.sig tr.tall td{height:70px}
table.reg{width:100%;border-collapse:collapse;font-size:10pt}
table.reg th,table.reg td{border:1px solid #444;padding:5px 7px;text-align:left;vertical-align:top}
table.reg th{background:#e8eefc}`;

  function line(label, val) {
    return `<div class="line"><b>${esc(label)}:</b> <span class="u">${esc(val) || '&nbsp;'}</span></div>`;
  }
  function opts(label, list, val) {
    return `<div class="line"><b>${esc(label)}:</b> ${list.map(o => `<span class="opt${val === o ? ' on' : ''}">${val === o ? '&#9745;' : '&#9744;'} ${esc(o)}</span>`).join('')}</div>`;
  }
  function sigTable() {
    return `<table class="sig"><tr><td>Reviewed By(sales &amp; market personnel):</td><td>Approved By(QA executive): Tanuja Manral</td></tr><tr class="tall"><td>Sign:</td><td>Sign:</td></tr></table>`;
  }
  function f1Html(v) {
    return `<div class="page"><h2>Annexure-1: Contract Review Checklist (ABM-QA-QF-007-F1)</h2>
      ${line('Customer Name', v.customer)}${line('Invoice No./Inquiry/PO No./PI No.', v.ref_no)}${line('Product Name & model no.', v.product)}${line('Quantity', v.qty)}
      ${opts('Delivery Schedule', ['Standard', 'Urgent'], v.delivery)}${line('Regulatory Requirements', v.regulatory)}
      ${opts('Technical Requirements Reviewed', ['Yes', 'No'], v.technical)}${opts('Commercial Terms Reviewed', ['Yes', 'No'], v.commercial)}${opts('Capability Confirmed', ['Yes', 'No'], v.capability)}
      ${opts('Review Remarks', ['Regular Order', 'Tender Specific', 'As Per Specification'], v.remarks)}
      <div class="line"><b>Reviewed By:</b> <span class="u" style="min-width:200px">${esc(v.reviewed_by) || '&nbsp;'}</span> &nbsp; <b>Date:</b> <span class="u" style="min-width:120px">${esc(showDate(v.reviewed_date)) || '&nbsp;'}</span></div>
      ${sigTable()}
      <div class="line"><b>Approved By:</b> <span class="u" style="min-width:200px">${esc(v.approved_by) || '&nbsp;'}</span> &nbsp; <b>Date:</b> <span class="u" style="min-width:120px">${esc(showDate(v.approved_date)) || '&nbsp;'}</span></div></div>`;
  }
  function f2Html(v) {
    return `<div class="page"><h2>Annexure-2: Order to Dispatch Checklist (ABM-QA-QF-007-F2)</h2>
      ${line('Customer Name', v.customer)}${line('Invoice No.', v.invoice_no)}${line('Product Details', v.product)}${line('Quantity', v.qty)}${line('Manufacturing Details (month/year)', v.mfg)}
      ${opts('QA Inspection Status', ['Pass', 'Fail'], v.qa)}${opts('Packing Verified', ['Yes', 'No'], v.packing)}${opts('Label Verified', ['Yes', 'No'], v.label)}
      ${opts('Dispatch details', ['Courier', 'By Vehicle', 'Porter', 'By Hand'], v.dispatch_mode)}${line('Dispatch Date', showDate(v.dispatch_date))}${line('Transport Details', v.transport)}
      <div class="line"><b>Checked By:</b> <span class="u" style="min-width:200px">${esc(v.checked_by) || '&nbsp;'}</span> &nbsp; <b>Date:</b> <span class="u" style="min-width:120px">${esc(showDate(v.checked_date)) || '&nbsp;'}</span></div>
      ${sigTable()}
      <div class="line"><b>Approved By:</b> <span class="u" style="min-width:200px">${esc(v.approved_by) || '&nbsp;'}</span> &nbsp; <b>Date:</b> <span class="u" style="min-width:120px">${esc(showDate(v.approved_date)) || '&nbsp;'}</span></div></div>`;
  }

  function printWindow(html, title, landscape) {
    const w = window.open('', '_blank');
    if (!w) { alert('Allow pop-ups for this site to print.'); return; }
    const extra = landscape ? '@page{size:A4 landscape;margin:12mm}' : '';
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}${extra}</style></head><body>${html}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }
  window.qcPrintWindow = printWindow;

  function openQcForms(row, ctx) {
    const old = document.getElementById('qcFormModal');
    if (old) old.remove();
    const def = defaultsFor(row, ctx || {});
    const state = { f1: { ...def.f1 }, f2: { ...def.f2 } };
    const auto = { f1: { ...def.f1 }, f2: { ...def.f2 } };
    Object.keys(auto).forEach(f => Object.keys(auto[f]).forEach(k => { if (!auto[f][k]) delete auto[f][k]; }));
    ['f1', 'f2'].forEach(f => Object.keys(state[f]).forEach(k => { if (state[f][k] === undefined) state[f][k] = ''; }));

    const control = (f, [key, label, type, list]) => {
      const val = state[f][key] || '';
      let input;
      if (type === 'choice') {
        input = `<select data-f="${f}" data-k="${key}" style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px;"><option value=""></option>${list.map(o => `<option ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else {
        input = `<input type="${type === 'date' ? 'date' : 'text'}" data-f="${f}" data-k="${key}" value="${esc(val)}" style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px;min-width:0;">`;
      }
      return `<div style="margin-bottom:10px;" data-row="${f}.${key}">
        <div style="font-size:12px;color:#64748b;margin-bottom:3px;">${esc(label)} <span class="qcf-auto" style="background:#e0ecff;color:#1d4ed8;border-radius:999px;padding:1px 7px;font-size:10px;margin-left:4px;display:none;">auto</span></div>
        <div style="display:flex;gap:6px;">${input}<button type="button" class="qcf-x" data-f="${f}" data-k="${key}" title="Clear" style="border:none;background:#f1f5f9;border-radius:8px;width:34px;cursor:pointer;color:#64748b;">&times;</button></div></div>`;
    };
    const panel = (f, title, fields) => `<div style="border:1px solid #e2e8f0;border-radius:14px;padding:16px;min-width:0;"><h4 style="margin:0 0 12px;font-size:14px;color:#334155;">${title}</h4>${fields.map(x => control(f, x)).join('')}</div>`;

    const overlay = document.createElement('div');
    overlay.id = 'qcFormModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1100;padding:8px;';
    overlay.innerHTML = `<div style="background:#fff;border-radius:16px;padding:22px;width:min(1000px,100%);max-height:92vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <div><h3 style="margin:0;">QC Forms (SOP-07)</h3><div style="font-size:12px;color:#94a3b8;margin-top:3px;">Default and auto-filled values can be changed or removed. Blank fields can be filled before printing.</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button type="button" id="qcfClearAuto" style="padding:8px 12px;border:none;border-radius:8px;background:#fee2e2;color:#b91c1c;cursor:pointer;">Remove auto-filled</button>
          <button type="button" data-print="f1" style="padding:8px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;"><i class="fa-solid fa-print"></i> Print F1</button>
          <button type="button" data-print="f2" style="padding:8px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;"><i class="fa-solid fa-print"></i> Print F2</button>
          <button type="button" data-print="both" style="padding:8px 12px;border:none;border-radius:8px;background:#0f9d58;color:#fff;cursor:pointer;"><i class="fa-solid fa-print"></i> Print Both</button>
          <button type="button" id="qcfClose" style="border:none;background:none;font-size:24px;cursor:pointer;">&times;</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;">
        ${panel('f1', 'Annexure-1: Contract Review Checklist (ABM-QA-QF-007-F1)', F1)}
        ${panel('f2', 'Annexure-2: Order to Dispatch Checklist (ABM-QA-QF-007-F2)', F2)}
      </div></div>`;
    document.body.appendChild(overlay);

    const refreshBadge = (f, k) => {
      const badge = overlay.querySelector(`[data-row="${f}.${k}"] .qcf-auto`);
      if (badge) badge.style.display = auto[f][k] && state[f][k] === auto[f][k] ? 'inline-block' : 'none';
    };
    const setValue = (f, k, v) => {
      state[f][k] = v;
      const el = overlay.querySelector(`[data-f="${f}"][data-k="${k}"]:not(button)`);
      if (el) el.value = v;
      refreshBadge(f, k);
    };
    overlay.querySelectorAll('input[data-f], select[data-f]').forEach(el => {
      refreshBadge(el.dataset.f, el.dataset.k);
      const h = () => { state[el.dataset.f][el.dataset.k] = el.value; refreshBadge(el.dataset.f, el.dataset.k); };
      el.addEventListener('input', h);
      el.addEventListener('change', h);
    });
    overlay.querySelectorAll('.qcf-x').forEach(b => b.addEventListener('click', () => setValue(b.dataset.f, b.dataset.k, '')));
    overlay.querySelector('#qcfClearAuto').addEventListener('click', () => {
      ['f1', 'f2'].forEach(f => Object.keys(auto[f]).forEach(k => { if (state[f][k] === auto[f][k]) setValue(f, k, ''); }));
    });
    const close = () => overlay.remove();
    overlay.querySelector('#qcfClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
      const which = b.dataset.print;
      const html = (which === 'f1' || which === 'both' ? f1Html(state.f1) : '') + (which === 'f2' || which === 'both' ? f2Html(state.f2) : '');
      printWindow(html, 'QC Forms SOP-07');
    }));
  }
  window.openQcForms = openQcForms;
})();