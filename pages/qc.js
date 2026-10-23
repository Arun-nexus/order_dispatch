const QC = { rows: [], filtered: [], f: { type: '', status: '', q: '', from: '', to: '' }, page: 1, size: 25, asm: {} };
const TYPE_LABEL = { inventory: 'Inventory', order: 'Order', dispatch: 'Dispatch', service: 'Service' };

function qEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function qTitle(s) {
  return String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function qDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  return isNaN(d) ? '-' : d.toLocaleDateString('en-GB');
}
function qShort(id) {
  return id ? String(id).slice(0, 8) : '-';
}

async function qGet(url) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(url);
  return res.json();
}

function itemsOf(row) {
  const d = row.data;
  if (row.type === 'inventory') return [{ name: [d.product_name, d.model_no].filter(Boolean).join(' · ') || d.product_id || '-', qty: d.quantity ?? '' }];
  if (row.type === 'service') return [{ name: row.product, qty: '' }];
  if (row.kind === 'spare_part') return [{ name: d.spare_part?.part_name || '-', qty: d.spare_part?.quantity ?? '' }];
  const items = d.items || [];
  return items.length ? items.map(i => ({ name: `${i.product_name ?? ''}${i.model_no ? ' (' + i.model_no + ')' : ''}`, qty: i.quantity ?? 0 })) : [{ name: '-', qty: '' }];
}

function serialsOf(row) {
  const d = row.data;
  const own = [].concat(d.serial_numbers || [], d.serial_no || []);
  const fromItems = (d.items || []).flatMap(i => i.serial_numbers || []);
  return own.concat(fromItems).join(' ');
}

function buildRows(inv, ord, dsp, svc) {
  const rows = [];
  (inv.dataset || []).forEach(p => rows.push({
    type: 'inventory', data: p,
    ref: p.product_id || p.lot_no || '-',
    product: [p.product_name, p.model_no].filter(Boolean).join(' · ') || '-',
    qty: p.quantity ?? '-',
    party: p.supplier || '-',
    date: p.purchase_date || p.created_at || '',
    status: p.damage_status || (Number(p.quantity) > 0 ? 'In Stock' : 'Out Of Stock')
  }));
  (ord.dataset || []).forEach(o => rows.push({
    type: 'order', kind: 'order', data: o,
    ref: qShort(o.order_id),
    product: '',
    qty: (o.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0),
    party: o.customer?.company_name || '-',
    date: o.order_date || '',
    status: qTitle(o.status || '-')
  }));
  const add = (list, kind, done) => (list || []).forEach(d => rows.push({
    type: 'dispatch', kind, data: d,
    ref: d.dispatch?.invoice_no || d.dispatch?.docket_no || qShort(kind === 'order' ? d.order_id : d.allocation_id),
    product: '',
    qty: kind === 'spare_part' ? (d.spare_part?.quantity ?? '-') : (d.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0),
    party: kind === 'order' ? (d.customer?.company_name || '-') : kind === 'product_allocation' ? (d.sales_person?.name || d.company_name || '-') : `Service #${qShort(d.spare_part?.service_id)}`,
    date: d.dispatch?.dispatched_at || d.order_date || d.allotment_date || d.created_at || '',
    status: done ? (d.status === 'delivered' ? 'Delivered' : 'Dispatched') : 'Pending'
  }));
  add(dsp.pending_orders, 'order', false);
  add(dsp.dispatched_orders, 'order', true);
  add(dsp.pending_spare_parts, 'spare_part', false);
  add(dsp.dispatched_spare_parts, 'spare_part', true);
  add(dsp.pending_product_allocations, 'product_allocation', false);
  add(dsp.dispatched_product_allocations, 'product_allocation', true);
  (svc.dataset || []).forEach(s => rows.push({
    type: 'service', data: s,
    ref: qShort(s.service_id),
    product: [s.product_name, s.model_no].filter(Boolean).join(' · ') || s.product_id || '-',
    qty: '-',
    party: s.technician_alloted || '-',
    date: s.created_at || '',
    status: qTitle(s.status || '-')
  }));
  rows.forEach(r => {
    if (r.type === 'order' || r.type === 'dispatch') r.product = itemsOf(r).map(i => `${i.name}${i.qty !== '' ? ' x ' + i.qty : ''}`).join('; ');
    r.hay = `${r.type} ${r.ref} ${r.product} ${r.party} ${r.status} ${serialsOf(r)} ${r.data.order_id || ''} ${r.data.allocation_id || ''} ${r.data.service_id || ''} ${r.data.dispatch?.docket_no || ''} ${r.data.dispatch?.invoice_no || ''} ${r.data.dispatch?.dispatched_through || ''}`.toLowerCase();
  });
  return rows;
}

async function loadQc() {
  try {
    const [inv, ord, dsp, svc] = await Promise.all([qGet('/inventory/'), qGet('/order/'), qGet('/dispatch/'), qGet('/service/')]);
    QC.asm = dsp.assembly_dates || {};
    QC.rows = buildRows(inv, ord, dsp, svc);
    updateCards();
    fillStatusOptions();
    applyFilters();
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load QC data.');
  }
}

function updateCards() {
  const c = t => QC.rows.filter(r => r.type === t).length;
  document.getElementById('cTotal').textContent = QC.rows.length;
  document.getElementById('cInventory').textContent = c('inventory');
  document.getElementById('cOrder').textContent = c('order');
  document.getElementById('cDispatch').textContent = c('dispatch');
  document.getElementById('cPending').textContent = QC.rows.filter(r => r.type === 'dispatch' && r.status === 'Pending').length;
  document.getElementById('cService').textContent = c('service');
}

function fillStatusOptions() {
  const sel = document.getElementById('fStatus');
  const pool = QC.rows.filter(r => !QC.f.type || r.type === QC.f.type);
  const set = [...new Set(pool.map(r => r.status))].sort();
  sel.innerHTML = '<option value="">All Status</option>' + set.map(s => `<option value="${qEsc(s.toLowerCase())}">${qEsc(s)}</option>`).join('');
  sel.value = set.some(s => s.toLowerCase() === QC.f.status) ? QC.f.status : '';
  QC.f.status = sel.value;
}

function syncControls() {
  document.getElementById('fType').value = QC.f.type;
  document.getElementById('fStatus').value = QC.f.status;
  document.getElementById('fFrom').value = QC.f.from;
  document.getElementById('fTo').value = QC.f.to;
  document.getElementById('qcSearch').value = QC.f.q;
  document.querySelectorAll('#qcCards .card').forEach(c => {
    const on = (c.dataset.type || '') === QC.f.type && (c.dataset.status || '') === QC.f.status;
    c.style.outline = on ? '2px solid #1665ff' : 'none';
  });
}

function applyFilters() {
  const f = QC.f;
  const q = f.q.toLowerCase();
  const from = f.from ? new Date(`${f.from}T00:00:00`) : null;
  const to = f.to ? new Date(`${f.to}T23:59:59`) : null;
  QC.filtered = QC.rows.filter(r => {
    if (f.type && r.type !== f.type) return false;
    if (f.status && r.status.toLowerCase() !== f.status) return false;
    if (q && !r.hay.includes(q)) return false;
    if (from || to) {
      if (!r.date) return false;
      const d = new Date(r.date);
      if (isNaN(d) || (from && d < from) || (to && d > to)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const pages = Math.max(1, Math.ceil(QC.filtered.length / QC.size));
  if (QC.page > pages) QC.page = pages;
  syncControls();
  renderTable();
}

function renderTable() {
  const start = (QC.page - 1) * QC.size;
  const slice = QC.filtered.slice(start, start + QC.size);
  document.getElementById('qcBody').innerHTML = slice.map((r, i) => {
    const lines = itemsOf(r).map(it => `<div>${qEsc(it.name)}${it.qty !== '' && (r.type === 'order' || r.type === 'dispatch') ? ' <span style="color:#64748b;">x ' + qEsc(it.qty) + '</span>' : ''}</div>`).join('');
    return `<tr>
      <td><span style="background:#eef2ff;color:#3730a3;padding:2px 10px;border-radius:999px;font-size:12px;">${TYPE_LABEL[r.type]}${r.kind === 'spare_part' ? ' · Spare' : r.kind === 'product_allocation' ? ' · Demo' : ''}</span></td>
      <td>${qEsc(r.ref)}</td>
      <td>${lines}</td>
      <td>${qEsc(r.qty)}</td>
      <td>${qEsc(r.party)}</td>
      <td>${qDate(r.date)}</td>
      <td>${qEsc(r.status)}</td>
      <td style="white-space:nowrap;"><button class="icon-btn" data-i="${start + i}" title="View"><i class="fa-solid fa-eye"></i></button>${r.type === 'dispatch' ? ` <button class="icon-btn" data-ch="${start + i}" title="Store Challan"><i class="fa-solid fa-file-lines"></i></button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No records found.</td></tr>';
  document.querySelectorAll('#qcBody [data-i]').forEach(b => b.addEventListener('click', () => openView(QC.filtered[Number(b.dataset.i)])));
  document.querySelectorAll('#qcBody [data-ch]').forEach(b => b.addEventListener('click', () => window.openStoreChallan && window.openStoreChallan(QC.filtered[Number(b.dataset.ch)])));
  const pages = Math.max(1, Math.ceil(QC.filtered.length / QC.size));
  document.getElementById('qcPager').innerHTML = `<button class="page-btn" data-p="prev"><i class="fa-solid fa-angle-left"></i></button><button class="page active-page" style="min-width:90px;">${QC.page} / ${pages}</button><button class="page-btn" data-p="next"><i class="fa-solid fa-angle-right"></i></button>`;
  document.querySelectorAll('#qcPager [data-p]').forEach(b => b.addEventListener('click', () => {
    QC.page = b.dataset.p === 'prev' ? Math.max(1, QC.page - 1) : Math.min(pages, QC.page + 1);
    renderTable();
  }));
  document.getElementById('qcCount').textContent = `${QC.filtered.length} of ${QC.rows.length} record(s)`;
}

function exportRows() {
  return QC.filtered.flatMap(r => {
    const disp = r.data.dispatch || {};
    return itemsOf(r).map(it => [TYPE_LABEL[r.type], r.ref, it.name, it.qty, r.party, qDate(r.date), r.status, disp.invoice_no || '', disp.docket_no || '', disp.dispatched_through || '']);
  });
}
const EXPORT_HEAD = ['Type', 'Reference', 'Product / Details', 'Qty', 'Party', 'Date', 'Status', 'Invoice No.', 'Docket No.', 'Courier / Transport'];

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\ufeff' + [EXPORT_HEAD].concat(exportRows()).map(r => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `qc_register_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function printTable() {
  const rows = exportRows();
  const summary = [QC.f.type && TYPE_LABEL[QC.f.type], QC.f.status && qTitle(QC.f.status), QC.f.from && `From ${QC.f.from}`, QC.f.to && `To ${QC.f.to}`, QC.f.q && `Search: ${QC.f.q}`].filter(Boolean).join(' | ') || 'All records';
  const html = `<h2 style="font-size:15pt;margin:0 0 4px;">QC Register</h2><div style="font-size:10pt;color:#444;margin-bottom:10px;">${qEsc(summary)} &nbsp;|&nbsp; Printed: ${new Date().toLocaleString('en-GB')} &nbsp;|&nbsp; ${rows.length} row(s)</div>
    <table class="reg"><thead><tr>${EXPORT_HEAD.map(h => `<th>${qEsc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${qEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  qcPrintWindow(html, 'QC Register', true);
}

const V_LABELS = {
  dispatched_through: 'Courier / Transport', mode_of_delivery: 'Mode of Delivery', gst_number: 'GST No.', total_mrp: 'Total Amount',
  company_name: 'Company', company_address: 'Address', model_no: 'Model No.', product_id: 'Product ID', tax_rate: 'Tax Rate (%)'
};
function vLabel(k) {
  return V_LABELS[k] || qTitle(k);
}
function vFmt(k, v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) {
    const t = new Date(v);
    if (!isNaN(t)) return v.length > 10 ? t.toLocaleString('en-GB') : t.toLocaleDateString('en-GB');
  }
  if (typeof v === 'number' && /(price|amount|mrp|total|discount|charge)/i.test(k) && !/(rate|percent|qty|quantity)/i.test(k)) return '\u20b9' + v.toLocaleString('en-IN');
  return String(v);
}
function vFlat(obj, prefix, out, skip) {
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (skip.includes(k) || v === null || v === undefined || v === '') return;
    if (typeof v === 'string' && v.startsWith('data:')) return;
    const label = prefix ? `${prefix} \u2013 ${vLabel(k)}` : vLabel(k);
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (v.every(x => x === null || typeof x !== 'object')) out.push([label, v.map(x => vFmt(k, x)).join(', ')]);
      else v.forEach((x, i) => vFlat(x, `${label} ${i + 1}`, out, skip));
    } else if (typeof v === 'object') {
      vFlat(v, label, out, skip);
    } else {
      out.push([label, vFmt(k, v)]);
    }
  });
  return out;
}
function vTile(label, value, hl) {
  if (value === undefined || value === null || value === '') return '';
  return `<div style="background:${hl ? '#eef4ff' : '#f7f8fd'};${hl ? 'border:1px solid #bfd4ff;' : ''}border-radius:12px;padding:12px 14px;min-width:0;"><div style="font-size:12px;color:#64748b;margin-bottom:4px;">${qEsc(label)}</div><div style="font-size:14.5px;color:#1e293b;font-weight:500;word-break:break-word;">${qEsc(value)}</div></div>`;
}
function vGrid(html) {
  return html ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">${html}</div>` : '';
}
function vLeft(obj, skip, prefix) {
  return vFlat(obj, prefix || '', [], ['_id', 'image', 'video', 'password'].concat(skip || [])).map(([l, v]) => vTile(l, v)).join('');
}
function vTitle(t) {
  return `<h4 style="margin:18px 0 8px;font-size:13px;color:#334155;">${t}</h4>`;
}
function vChips(arr) {
  return (arr || []).map(x => `<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:8px;padding:2px 8px;font-size:12px;margin:2px 4px 2px 0;">${qEsc(x)}</span>`).join('');
}
function vProducts(items) {
  if (!items.length) return '';
  const th = 'padding:12px 14px;text-align:left;color:#334155;white-space:nowrap;';
  const td = 'padding:12px 14px;border-top:1px solid #eef1f6;vertical-align:top;';
  const priced = items.some(i => i.price !== undefined && i.price !== '');
  const rows = items.map(it => {
    const qty = Number(it.quantity) || 0;
    const line = priced ? qty * (Number(it.price) || 0) * (1 + (Number(it.tax_rate) || 0) / 100) : null;
    return `<tr><td style="${td}"><strong>${qEsc(it.product_name ?? '')}</strong><br><small style="color:#94a3b8;">${qEsc([it.product_id && 'ID: ' + it.product_id, it.model_no && 'Model: ' + it.model_no].filter(Boolean).join(' \u00b7 '))}</small></td>
      <td style="${td}">${vChips(it.serial_numbers) || '-'}</td><td style="${td}">${qty}</td>
      ${priced ? `<td style="${td}">${it.price !== undefined && it.price !== '' ? '\u20b9' + Number(it.price).toLocaleString('en-IN') : '-'}</td><td style="${td}">${it.tax_rate !== undefined && it.tax_rate !== '' ? it.tax_rate + '%' : '-'}</td><td style="${td}"><strong>\u20b9${(line || 0).toLocaleString('en-IN')}</strong></td>` : ''}</tr>`;
  }).join('');
  return `<div style="border:1px solid #e2e8f0;border-radius:12px;overflow-x:auto;"><table style="width:100%;min-width:480px;border-collapse:collapse;font-size:13.5px;"><thead><tr style="background:#eaf2ff;"><th style="${th}">Product</th><th style="${th}">Serial No(s)</th><th style="${th}">Qty</th>${priced ? `<th style="${th}">Price</th><th style="${th}">Tax</th><th style="${th}">Line Total</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function viewBody(r) {
  const d = r.data;
  if (r.type === 'inventory') {
    return vGrid(vLeft(d, ['serial_numbers', 'hologram_numbers']))
      + ((d.serial_numbers || []).length ? vTitle(`Serial numbers (${d.serial_numbers.length})`) + vChips(d.serial_numbers) : '')
      + ((d.hologram_numbers || []).length ? vTitle(`Hologram numbers (${d.hologram_numbers.length})`) + vChips(d.hologram_numbers) : '');
  }
  if (r.type === 'service') {
    const media = [d.image_drive_link && `<a href="${qEsc(d.image_drive_link)}" target="_blank" rel="noopener">Image</a>`, d.video_drive_link && `<a href="${qEsc(d.video_drive_link)}" target="_blank" rel="noopener">Video</a>`].filter(Boolean).join(' | ');
    return vGrid(vLeft(d, ['parts_replaced', 'image_drive_link', 'video_drive_link'])) + (media ? vTitle('Media') + `<div>${media}</div>` : '')
      + ((d.parts_replaced || []).length ? vTitle('Parts replaced') + vGrid((d.parts_replaced || []).map(p => vTile(p.part_name || 'Part', `Old: ${p.old_hologram_number || '-'} \u2192 New: ${p.new_hologram_number || '-'}`)).join('')) : '');
  }
  const disp = d.dispatch || null;
  const skip = ['dispatch', 'items', 'customer', 'sales_person', 'spare_part', 'attachments'];
  const handled = ['image', 'image_drive_link', 'media_updated_at', 'docket_no', 'dispatched_through', 'mode_of_delivery', 'invoice_no', 'invoice_date', 'dispatched_by', 'ship_to_different', 'ship_to_address', 'dispatched_at'];
  const dispatchHtml = disp
    ? vTitle('Dispatch') + vGrid(vTile('Courier / Transport', disp.dispatched_through || '-', true) + vTile('Docket No.', disp.docket_no || '-') + vTile('Mode of Delivery', (disp.mode_of_delivery || '').replace(/_/g, ' ')) + vTile('Invoice No.', disp.invoice_no) + vTile('Invoice Date', disp.invoice_date ? qDate(disp.invoice_date) : '') + vTile('Dispatched By', disp.dispatched_by) + vTile('Dispatched At', disp.dispatched_at ? new Date(disp.dispatched_at).toLocaleString('en-GB') : '') + vLeft(disp, handled))
    : vTitle('Dispatch') + vGrid(vTile('Dispatch', 'Not yet dispatched'));
  return vGrid(vLeft(d, skip))
    + (d.customer ? vTitle('Customer') + vGrid(vLeft(d.customer)) : '')
    + (d.sales_person ? vTitle('Sales Person') + vGrid(vLeft(d.sales_person)) : '')
    + (d.spare_part ? vTitle('Spare Part') + vGrid(vLeft(d.spare_part)) : '')
    + dispatchHtml
    + ((d.items || []).length ? vTitle('Products') + vProducts(d.items) : '');
}

function openView(r) {
  if (!r) return;
  const modal = document.getElementById('qcViewModal');
  const content = document.getElementById('qcViewContent');
  const idText = r.data.order_id || r.data.allocation_id || r.data.service_id || r.data.product_id || r.ref;
  const canForm = r.type === 'order' || (r.type === 'dispatch');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid #eef1f6;">
      <div><h3 style="margin:0;">${TYPE_LABEL[r.type]} Details</h3><div style="font-size:12.5px;color:#94a3b8;margin-top:4px;word-break:break-all;">ID: ${qEsc(idText)} &nbsp;|&nbsp; Status: ${qEsc(r.status)}</div></div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${canForm ? '<button class="cv-btn exp" id="qcOpenForm"><i class="fa-solid fa-clipboard-check"></i> QC Form</button>' : ''}
        <button class="cv-btn exp" id="qcPrintView"><i class="fa-solid fa-print"></i> Print</button>
        <button id="qcCloseView" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="qcViewBody">${viewBody(r)}</div>`;
  document.getElementById('qcCloseView').addEventListener('click', () => modal.style.display = 'none');
  document.getElementById('qcPrintView').addEventListener('click', () => {
    qcPrintWindow(`<h2 style="font-size:15pt;margin:0 0 4px;">${TYPE_LABEL[r.type]} Details</h2><div style="font-size:10pt;color:#444;margin-bottom:12px;">ID: ${qEsc(idText)} | Status: ${qEsc(r.status)}</div>${document.getElementById('qcViewBody').innerHTML}`, `${TYPE_LABEL[r.type]} Details`);
  });
  const formBtn = document.getElementById('qcOpenForm');
  if (formBtn) formBtn.addEventListener('click', () => openQcForms({ kind: r.kind, data: r.data }, { assemblyDates: QC.asm, personName: n => n || '' }));
  modal.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('qcSearch').addEventListener('input', e => { QC.f.q = e.target.value.trim(); QC.page = 1; applyFilters(); });
  document.getElementById('fType').addEventListener('change', e => { QC.f.type = e.target.value; QC.f.status = ''; QC.page = 1; fillStatusOptions(); applyFilters(); });
  document.getElementById('fStatus').addEventListener('change', e => { QC.f.status = e.target.value; QC.page = 1; applyFilters(); });
  document.getElementById('fFrom').addEventListener('change', e => { QC.f.from = e.target.value; QC.page = 1; applyFilters(); });
  document.getElementById('fTo').addEventListener('change', e => { QC.f.to = e.target.value; QC.page = 1; applyFilters(); });
  document.getElementById('fReset').addEventListener('click', () => { QC.f = { type: '', status: '', q: '', from: '', to: '' }; QC.page = 1; fillStatusOptions(); applyFilters(); });
  document.querySelectorAll('#qcCards .card').forEach(c => c.addEventListener('click', () => {
    QC.f.type = c.dataset.type || '';
    fillStatusOptions();
    QC.f.status = c.dataset.status || '';
    document.getElementById('fStatus').value = QC.f.status;
    QC.page = 1;
    applyFilters();
  }));
  document.getElementById('qcExport').addEventListener('click', exportCsv);
  document.getElementById('qcPrint').addEventListener('click', printTable);
  document.getElementById('qcViewModal').addEventListener('mousedown', e => { if (e.target.id === 'qcViewModal') e.target.style.display = 'none'; });
  loadQc();
});