function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const allocState = { allocations: [], products: [], requests: [], searchQuery: '', activeFilters: null };
let allocPage = 1;
const ALLOC_PAGE_SIZE = 50;

// Generic pagination control renderer — rebuilds the .pagination buttons based
// on however many pages the current row count needs, and wires them up.
function renderTablePagination(container, page, totalPages, onChange) {
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" data-page="prev"><i class="fa-solid fa-angle-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="page${i === page ? ' active-page' : ''}" data-page="${i}">${i}</button>`;
  }
  html += `<button class="page-btn" data-page="next"><i class="fa-solid fa-angle-right"></i></button>`;
  container.innerHTML = html;
  container.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => {
    const d = btn.dataset.page;
    if (d === 'prev') onChange(Math.max(1, page - 1));
    else if (d === 'next') onChange(Math.min(totalPages, page + 1));
    else onChange(Number(d));
  }));
}

document.addEventListener('DOMContentLoaded', () => {
  loadAllocations();
  loadInventoryForAllocation();
  loadPendingRequests();
  wireTopActions();
  wireFilter();
  wireHeaderSearch();
  injectAllocateModal();
  wireNotifBell();
  setInterval(() => renderAllocationsTable(getFilteredAllocations()), 60 * 1000); // keep countdowns fresh
  setInterval(loadPendingRequests, 60 * 1000);
});

// ---------- Header search (by serial number, product name or sales person) ----------
function wireHeaderSearch() {
  const input = document.querySelector('.search input');
  if (!input) return;
  input.addEventListener('input', () => {
    allocState.searchQuery = input.value.trim().toLowerCase();
    allocPage = 1;
    renderAllocationsTable(getFilteredAllocations());
  });
}

// Combines the header search box with whatever the "Apply Filter" bar last
// set, so any action that re-fetches data (approve, return, allocate, etc.)
// can re-render the SAME filtered/searched view instead of snapping back to
// the full unfiltered list.
function getFilteredAllocations() {
  let list = allocState.allocations;

  const q = allocState.searchQuery;
  if (q) {
    list = list.filter(a => {
      const isSpare = a.allocation_type === 'spare_part';
      const serials = isSpare ? [] : (a.items || []).flatMap(i => i.serial_numbers || []);
      const products = isSpare
        ? [a.spare_part?.part_name || '']
        : (a.items || []).map(i => i.product_name || '');
      const who = isSpare
        ? `service #${(a.spare_part?.service_id || '').slice(0, 8)}`
        : (a.sales_person?.name || '');
      return serials.some(s => (s || '').toLowerCase().includes(q)) ||
        products.some(p => p.toLowerCase().includes(q)) ||
        who.toLowerCase().includes(q) ||
        (a.company_name || '').toLowerCase().includes(q) ||
        (a.allocation_id || '').toLowerCase().includes(q);
    });
  }

  const f = allocState.activeFilters;
  if (f) {
    list = list.filter(a => {
      const meta = returnMeta(a);
      const statusOk = !f.status
        || (f.status === 'Pending' && a.return_status !== 'returned' && !meta.overdue)
        || (f.status === 'Overdue' && meta.overdue && a.return_status !== 'returned')
        || (f.status === 'Returned' && a.return_status === 'returned');
      const dateOk = !f.date || (a.allotment_date || '').startsWith(f.date);
      return statusOk && dateOk;
    });
  }

  return list;
}

function wireNotifBell() {
  const bell = document.getElementById('notifBell');
  if (bell) bell.addEventListener('click', () => {
    document.getElementById('pendingRequestsSection')?.scrollIntoView({ behavior: 'smooth' });
  });
}

async function loadPendingRequests() {
  const role = getRole();
  const section = document.getElementById('pendingRequestsSection');
  // Requests panel is visible to admin/accounts/service_manager — matches
  // backend's require_role() on /request/. Other roles get their own
  // request status via the notification bell (common_auth.js) instead.
  const canView = role === 'admin' || role === 'accounts' || role === 'service_manager';
  if (!canView) {
    if (section) section.style.display = 'none';
    return;
  }
  try {
    const res = await apiFetch('/request/');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    allocState.requests = data.dataset || [];
    renderPendingRequests();
  } catch (err) {
    console.error(err);
  }
}

function detailRow(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<div class="detail"><small>${label}</small><p>${esc(String(value))}</p></div>`;
}
function itemDetailBlock(i, withPrice) {
  const rows = [
    detailRow('Product Name', i.product_name), detailRow('Product ID', i.product_id), detailRow('Model No.', i.model_no),
    detailRow('Quantity', i.quantity), detailRow('Serial No.', (i.serial_numbers || []).join(', ')),
  ];
  if (withPrice) rows.push(detailRow('Price (per unit)', i.price != null && i.price !== '' ? '₹' + i.price : ''), detailRow('Tax Rate', i.tax_rate != null && i.tax_rate !== '' ? i.tax_rate + '%' : ''));
  return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px;margin-bottom:8px;">${rows.join('')}</div>`;
}
function customerDetailBlock(c) {
  c = c || {};
  return detailRow('Company', c.company_name) + detailRow('Address', c.company_address || c.address)
    + detailRow('GST No.', c.gst_number) + detailRow('Contact Person', c.contractor_person)
    + detailRow('Contact Number', c.contractor_number || c.phone_number) + detailRow('Email', c.contractor_email);
}
function reqItemLabel(i) {
  const extra = [i.product_id, i.model_no].filter(Boolean).join(' · ');
  return esc(i.product_name || '') + (extra ? ` (${esc(extra)})` : '');
}

function renderPendingRequests() {
  const box = document.getElementById('pendingRequestsList');
  const badge = document.getElementById('notifBadge');
  const countLabel = document.getElementById('pendingCountLabel');
  if (!box) return;

  const pending = allocState.requests
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (badge) {
    badge.style.display = pending.length ? 'inline-block' : 'none';
    badge.textContent = pending.length;
  }
  if (countLabel) countLabel.textContent = pending.length ? `(${pending.length})` : '';

  if (!pending.length) {
    box.innerHTML = '<p style="color:#94a3b8;padding:10px;">No pending requests.</p>';
    return;
  }

  box.innerHTML = pending.map(r => {
    const iconMap = { demo_unit: 'fa-handshake', spare_part: 'fa-gears', order: 'fa-cart-shopping', media_review: 'fa-photo-film', status_update: 'fa-pen', convert_to_order: 'fa-file-invoice-dollar', return_demo: 'fa-rotate-left' };
    const icon = iconMap[r.request_type] || 'fa-bell';

    let title, subtitle;
    if (r.request_type === 'demo_unit') {
      title = `Demo Unit — ${esc(r.raised_by)}`;
      subtitle = (r.details?.items || []).map(i => `${reqItemLabel(i)} x${i.quantity}`).join(', ')
        + (r.details?.remarks ? ` • Remarks: ${esc(r.details.remarks)}` : '');
    } else if (r.request_type === 'return_demo') {
      title = `Demo Return — ${esc(r.raised_by)}`;
      subtitle = (r.details?.items || []).map(i => `${reqItemLabel(i)} x${i.quantity}`).join(', ')
        + ` • Through: ${esc(r.details?.returned_through || '-')}`;
    } else if (r.request_type === 'convert_to_order') {
      title = `Convert Demo to Order — ${esc(r.details?.customer?.company_name || '')}`;
      subtitle = (r.details?.items || []).map(i => `${reqItemLabel(i)} x${i.quantity} @ ₹${i.price}`).join(', ');
    } else if (r.request_type === 'order') {
      title = `Order — ${r.details?.customer?.company_name || 'New customer'}`;
      subtitle = (r.details?.items || []).map(i => `${reqItemLabel(i)} x${i.quantity}`).join(', ');
    } else if (r.request_type === 'media_review') {
      title = `Service Media — Service #${(r.details?.service_id || '').slice(0, 8)}`;
      subtitle = 'Video uploaded, awaiting download confirmation';
    } else if (r.request_type === 'status_update') {
      title = `Status Change — Service #${(r.details?.service_id || '').slice(0, 8)}`;
      subtitle = `Requested: "${(r.details?.service_status || '').replace('_', ' ')}"${r.details?.reason ? ' — ' + r.details.reason : ''}`;
    } else {
      title = `Spare Part — Service #${(r.details?.service_id || '').slice(0, 8)}`;
      subtitle = r.details?.note || '';
    }

    // status_update is completed from the Service page's Update Status action (needs
    // service charges etc. that this quick panel doesn't collect), so no approve/reject here
    const actions = r.request_type === 'status_update'
      ? `<p style="font-size:11px;color:#94a3b8;">Complete this from the Service page's Update Status action.</p>`
      : `<div style="display:flex;gap:8px;">
          <button class="req-approve-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;">Approve</button>
          <button class="req-reject-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#d62828;color:#fff;cursor:pointer;">Reject</button>
        </div>`;

    return `
      <div class="order-item" data-id="${r.request_id}">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid ${icon}"></i></div>
          <div>
            <h4>${title}</h4>
            <p>${subtitle} • raised by ${r.raised_by}</p>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="req-view-btn" title="View details" style="border:none;background:none;color:#1665ff;font-size:16px;cursor:pointer;"><i class="fa-solid fa-circle-info"></i></button>
          ${actions}
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.req-approve-btn').forEach(btn => btn.addEventListener('click', e => approveRequest(rowRequestId(e))));
  box.querySelectorAll('.req-reject-btn').forEach(btn => btn.addEventListener('click', e => rejectRequest(rowRequestId(e))));
  box.querySelectorAll('.req-view-btn').forEach(btn => btn.addEventListener('click', e => openRequestDetailsModal(rowRequest(e))));
}

function rowRequest(e) {
  const id = e.target.closest('.order-item').dataset.id;
  return allocState.requests.find(r => r.request_id === id);
}

// Shows type-specific details for a pending request: product name/qty/price for
// demo unit & order requests, spare part note/technician/service id for spare
// part requests. Reuses the existing viewAllocationModal markup.
function openRequestDetailsModal(r) {
  if (!r) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  const d = r.details || {};

  let heading, body;

  if (r.request_type === 'demo_unit') {
    heading = 'Demo Unit Request';
    const itemsRows = (d.items || []).map(i => itemDetailBlock(i, true)).join('');
    body = `
      ${itemsRows || '<div class="detail"><small>Products</small><p>-</p></div>'}
      <div class="detail"><small>Requested By</small><p>${esc(r.raised_by)}</p></div>
      <div class="detail"><small>Remarks</small><p>${esc(d.remarks || '-')}</p></div>`;
  } else if (r.request_type === 'return_demo') {
    heading = 'Demo Unit Return';
    const itemsRows = (d.items || []).map(i => itemDetailBlock(i, false)).join('');
    // proof file is a large base64 blob, so it is not part of the request list — loaded when this modal opens
    const proofHtml = (d.proof && (d.proof.name || d.proof.data))
      ? '<p id="proofBox" style="font-size:12px;color:#94a3b8;">Loading proof…</p>'
      : '<p>Not provided</p>';
    body = `
      ${itemsRows}
      <div class="detail"><small>Returned Through</small><p>${esc(d.returned_through || '-')}</p></div>
      <div class="detail"><small>Proof of Return</small>${proofHtml}</div>
      <div class="detail"><small>Requested By</small><p>${esc(r.raised_by)}</p></div>`;
  } else if (r.request_type === 'convert_to_order') {
    heading = 'Convert Demo to Order';
    const itemsRows = (d.items || []).map(i => itemDetailBlock(i, true)).join('');
    body = `
      ${itemsRows}
      ${customerDetailBlock(d.customer)}
      <div class="detail"><small>Requested By</small><p>${esc(r.raised_by)}</p></div>`;
  } else if (r.request_type === 'order') {
    heading = 'Order Request';
    const itemsRows = (d.items || []).map(i => itemDetailBlock(i, true)).join('');
    body = `
      ${itemsRows || '<div class="detail"><small>Products</small><p>-</p></div>'}
      ${customerDetailBlock(d.customer)}
      ${detailRow('Payment Mode', d.payment_mode)}${detailRow('Discount', d.discount ? '₹' + d.discount : '')}
      <div class="detail"><small>Requested By</small><p>${esc(r.raised_by ?? '-')}</p></div>
      ${(d.attachments || []).length ? `<div class="detail"><small>Attachments</small><p>${d.attachments.map((f, i) => `<a href="#" class="attach-link" data-i="${i}" style="display:block;color:#1665ff;">${esc(f.name)}</a>`).join('')}</p></div>` : ''}`;
  } else if (r.request_type === 'spare_part') {
    heading = 'Spare Part Request';
    body = `
      <div class="detail"><small>Spare Part</small><p>${d.note || '-'}</p></div>
      <div class="detail"><small>Technician</small><p>${r.raised_by ?? '-'}</p></div>
      <div class="detail"><small>Service ID</small><p>${d.service_id ?? '-'}</p></div>`;
  } else if (r.request_type === 'status_update') {
    heading = 'Status Change Request';
    body = `
      <div class="detail"><small>Service ID</small><p>${d.service_id ?? '-'}</p></div>
      <div class="detail"><small>Requested Status</small><p>${(d.service_status || '').replace('_', ' ')}</p></div>
      <div class="detail"><small>Reason</small><p>${d.reason || '-'}</p></div>
      <div class="detail"><small>Requested By</small><p>${r.raised_by ?? '-'}</p></div>`;
  } else {
    heading = 'Request Details';
    body = `<div class="detail"><small>Service ID</small><p>${d.service_id ?? '-'}</p></div>
      <div class="detail"><small>Requested By</small><p>${r.raised_by ?? '-'}</p></div>`;
  }

  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${heading}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${body}`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelectorAll('.attach-link').forEach(link => link.addEventListener('click', async e => {
    e.preventDefault();
    const f = d.attachments[Number(link.dataset.i)];
    try {
      const res = await apiFetch(`/order_attachment/${r.request_id}/${f.stored_name}`);
      if (!res.ok) throw new Error('could not download file');
      const url = URL.createObjectURL(await res.blob());
      const tmp = document.createElement('a');
      tmp.href = url; tmp.download = f.name; tmp.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  }));
  modal.style.display = 'flex';

  const proofBox = document.getElementById('proofBox');
  if (proofBox) {
    apiFetch(`/request/${r.request_id}/proof`)
      .then(res => res.json())
      .then(({ proof }) => {
        if (!proof || !proof.data) { proofBox.textContent = 'Not provided'; return; }
        const name = esc(proof.name || 'proof');
        proofBox.outerHTML = String(proof.data).startsWith('data:image/')
          ? `<a href="${proof.data}" download="${name}"><img src="${proof.data}" alt="proof" style="max-width:100%;max-height:180px;border-radius:8px;border:1px solid #e2e8f0;"></a>`
          : `<a href="${proof.data}" download="${name}">Download ${name}</a>`;
      })
      .catch(() => { proofBox.textContent = 'Proof could not be loaded.'; });
  }
}

function rowRequestId(e) {
  return e.target.closest('.order-item').dataset.id;
}

function openInvoiceModal(r) {
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  const d = r.details || {};
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Invoice Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Company</small><p>${esc(d.customer?.company_name || '-')}</p></div>
    <div class="detail"><small>Products</small><p>${(d.items || []).map(i => `${esc(i.product_name)} x${i.quantity} @ ₹${i.price}`).join('<br>')}</p></div>
    <form id="invoiceForm" style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">
      <input name="invoice_no" placeholder="Invoice Number" required>
      <input name="invoice_date" type="date" required>
      <div style="display:flex;justify-content:space-between;margin-top:6px;">
        <button type="button" id="invoiceCancel" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Approve &amp; Create Order</button>
      </div>
    </form>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  document.getElementById('invoiceCancel').addEventListener('click', close);
  document.getElementById('invoiceForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await approveRequest(r.request_id, { invoice_no: fd.get('invoice_no'), invoice_date: fd.get('invoice_date') });
    close();
  });
  modal.style.display = 'flex';
}

async function approveRequest(requestId, extra) {
  const req = allocState.requests.find(x => x.request_id === requestId);
  if (req && req.request_type === 'convert_to_order' && !extra) return openInvoiceModal(req);
  if (!extra && !confirm('Approve this request?')) return;
  try {
    const opts = { method: 'POST' };
    if (extra) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(extra); }
    const res = await apiFetch(`/request/approve/${requestId}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'approval failed');
    await loadPendingRequests();
    await loadAllocations();
    await loadInventoryForAllocation();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

async function rejectRequest(requestId) {
  const reason = prompt('Reason for rejecting (optional):') || '';
  try {
    const res = await apiFetch(`/request/reject/${requestId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'rejection failed');
    await loadPendingRequests();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

async function loadAllocations() {
  try {
    const res = await apiFetch('/allocation/');
    if (!res.ok) throw new Error('failed to fetch allocations');
    const data = await res.json();
    allocState.allocations = (data.dataset || []).slice().reverse();
    allocPage = 1;
    renderAllocationsTable(getFilteredAllocations());
    updateAllocationCards(allocState.allocations);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load allocations.');
  }
}

async function loadInventoryForAllocation() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) throw new Error('failed to fetch inventory');
    const data = await res.json();
    allocState.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

const fmtDT = d => d ? new Date(d).toLocaleString('en-GB') : '-';
const returnedOn = a => a.return_completed_at || a.returned_on;

function returnMeta(a) {
  if (a.return_status === 'returned') return { label: 'Returned', cls: 'high', overdue: false, complete: true };
  const due = new Date(a.return_due_date);
  const now = new Date();
  const msLeft = due - now;
  if (msLeft <= 0) return { label: 'Overdue', cls: 'low', overdue: true, complete: false };
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  return { label: `${daysLeft}d left`, cls: daysLeft <= 2 ? 'medium' : 'high', overdue: false, complete: false };
}

function updateAllocationCards(allocations) {
  const values = document.querySelectorAll('.cards .card h2');
  if (!values.length) return;
  const pending = allocations.filter(a => !returnMeta(a).complete && !returnMeta(a).overdue).length;
  const overdue = allocations.filter(a => !returnMeta(a).complete && returnMeta(a).overdue).length;
  const returned = allocations.filter(a => returnMeta(a).complete).length;
  values[0].textContent = allocations.length;
  if (values[1]) values[1].textContent = pending;
  if (values[2]) values[2].textContent = overdue;
  if (values[3]) values[3].textContent = returned;
}

// Label for one allocated item — new rows always carry quantity 1 and their
// own serial number (partial returns are gone), but older rows created
// before this change may still hold quantity>1 with several serials, so
// both are shown correctly here.
function itemLabel(i) {
  const qtyPart = (i.quantity || 1) > 1 ? ` x${i.quantity}` : '';
  return `${i.product_name}${qtyPart}`;
}
function itemSerials(i) {
  return (i.serial_numbers || []).join(', ');
}

function renderAllocationsTable(allocations) {
  // Newest allotments first instead of the raw (ascending) API order.
  const sorted = [...allocations].sort((a, b) =>
    new Date(b.allotment_date || b.created_at || 0) - new Date(a.allotment_date || a.created_at || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / ALLOC_PAGE_SIZE));
  allocPage = Math.min(Math.max(1, allocPage), totalPages);
  const start = (allocPage - 1) * ALLOC_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + ALLOC_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  pageRows.forEach(a => {
    const meta = returnMeta(a);
    const isSpare = a.allocation_type === 'spare_part';
    const productLabel = isSpare
      ? `${a.spare_part?.part_name ?? ''} x${a.spare_part?.quantity ?? 1}`
      : (a.items || []).map(itemLabel).join(', ');
    const serialLabel = isSpare
      ? '-'
      : ((a.items || []).map(itemSerials).filter(Boolean).join(', ') || '-');
    const whoLabel = isSpare
      ? `Service #${(a.spare_part?.service_id || '').slice(0, 8)}`
      : (a.sales_person?.name ?? '');
    const addressLabel = isSpare
      ? (a.spare_part?.service_id || '').slice(0, 8) || '-'
      : ([a.company_name, a.address].filter(Boolean).join(', ') || '-');

    const tr = document.createElement('tr');
    tr.dataset.id = a.allocation_id;
    tr.innerHTML = `
      <td>${isSpare ? 'Spare Part' : (a.allocation_type === 'demo_unit' ? 'Demo' : 'Product')}</td>
      <td>${productLabel}</td>
      <td>${serialLabel}</td>
      <td>${whoLabel}</td>
      <td>${addressLabel}</td>
      <td>${a.allotment_date ? new Date(a.allotment_date).toLocaleDateString('en-GB') : '-'}</td>
      <td>${a.return_due_date ? new Date(a.return_due_date).toLocaleDateString('en-GB') : '-'}</td>
      <td>${esc(a.created_by || a.allocated_by || '-')}</td>
      <td>${esc(a.returned_by || '-')}</td>
      <td>${fmtDT(returnedOn(a))}</td>
      <td><span class="stock ${meta.cls}">${meta.label}</span></td>
      <td>
        <button class="icon-btn view-alloc-btn"><i class="fa-solid fa-eye"></i></button>
        ${window.__allocCanEdit && !isSpare && !a.dispatch && !meta.complete
          ? '<button class="icon-btn edit-alloc-btn" title="Edit (serial / details)"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${window.__allocCanEdit && !isSpare && !meta.complete
          ? '<button class="icon-btn convert-alloc-btn" title="Convert to Order"><i class="fa-solid fa-file-invoice-dollar"></i></button>' : ''}
        ${!isSpare && !a.dispatch && !a.sent_to_dispatch && window.__allocCanCreate
          ? '<button class="icon-btn dispatch-alloc-btn" title="Send to Dispatch"><i class="fa-solid fa-truck-fast"></i></button>' : ''}
        ${!isSpare && a.sent_to_dispatch && !a.dispatch
          ? '<span class="stock pending" title="Waiting to be dispatched" style="padding:4px 8px;">In Dispatch Queue</span>' : ''}
        ${!meta.complete && window.__allocCanReturnOrDamage ? '<button class="icon-btn return-alloc-btn"><i class="fa-solid fa-rotate-left"></i></button>' : ''}
        ${window.__allocCanReturnOrDamage ? (a.damage_report?.reported
          ? '<button class="icon-btn damage-view-btn" title="Damage reported" style="color:#d62828;"><i class="fa-solid fa-triangle-exclamation"></i></button>'
          : '<button class="icon-btn damage-report-btn" title="Report damaged product"><i class="fa-regular fa-triangle-exclamation"></i></button>') : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-alloc-btn').forEach(btn => btn.addEventListener('click', e => openViewAllocationModal(rowAllocation(e))));
  tbody.querySelectorAll('.edit-alloc-btn').forEach(btn => btn.addEventListener('click', e => openEditAllocationModal(rowAllocation(e))));
  tbody.querySelectorAll('.convert-alloc-btn').forEach(btn => btn.addEventListener('click', e => openConvertAllocationModal(rowAllocation(e))));
  tbody.querySelectorAll('.dispatch-alloc-btn').forEach(btn => btn.addEventListener('click', e => sendToDispatch(rowAllocation(e))));
  tbody.querySelectorAll('.return-alloc-btn').forEach(btn => btn.addEventListener('click', e => openReturnModal(rowAllocation(e))));
  tbody.querySelectorAll('.damage-report-btn').forEach(btn => btn.addEventListener('click', e => openDamageReportModal(rowAllocation(e))));
  tbody.querySelectorAll('.damage-view-btn').forEach(btn => btn.addEventListener('click', e => openDamageViewModal(rowAllocation(e))));

  renderTablePagination(document.querySelector('.pagination'), allocPage, totalPages, p => {
    allocPage = p;
    renderAllocationsTable(allocations);
  });
}

// ---------- Send allocated product to Dispatch (mirrors how orders reach the dispatch queue) ----------
async function sendToDispatch(a) {
  if (!a) return;
  const label = (a.items || []).map(itemLabel).join(', ');
  if (!confirm(`Send "${label}" to the dispatch queue?`)) return;
  try {
    const res = await apiFetch(`/allocation/send_to_dispatch/${a.allocation_id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'could not send to dispatch');
    await loadAllocations();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

function rowAllocation(e) {
  const tr = e.target.closest('tr');
  return allocState.allocations.find(a => a.allocation_id === tr.dataset.id);
}

// ---------- Return allocation ----------
// Every row is now a single allocated unit (or, for spare parts, one
// service's request) — so returning it is a one-shot confirm, no picking
// serials or splitting quantity.
function openReturnModal(a) {
  if (!a) return;
  const isSpare = a.allocation_type === 'spare_part';
  const label = isSpare
    ? `${a.spare_part?.part_name ?? ''} x${a.spare_part?.quantity ?? 1}`
    : (a.items || []).map(i => `${i.product_name}${itemSerials(i) ? ' (SN: ' + itemSerials(i) + ')' : ''}`).join(', ');
  if (!confirm(`Mark "${label}" as returned?`)) return;
  submitReturn(a);
}

async function submitReturn(a) {
  try {
    const res = await apiFetch(`/allocation/return/${a.allocation_id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'update failed');
    await loadAllocations();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

function openViewAllocationModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  const meta = returnMeta(a);
  const isSpare = a.allocation_type === 'spare_part';

  const itemsHtml = isSpare
    ? `<div class="detail"><small>Spare Part</small><p>${a.spare_part?.part_name ?? ''} x${a.spare_part?.quantity ?? 1}</p></div>
       <div class="detail"><small>Service ID</small><p>${a.spare_part?.service_id ?? ''}</p></div>`
    : `${(a.items || []).map(i => itemDetailBlock(i, false)).join('')}
       ${a.allocation_type === 'demo_unit'
         ? customerDetailBlock(a.customer) + detailRow('Distributor', a.allocated_by)
         : detailRow('Sales Person', [a.sales_person?.name, a.sales_person?.contact_number].filter(Boolean).join(' — '))
           + detailRow('Company', a.company_name) + detailRow('Address', a.address)
           + detailRow('GST No.', a.gst_number) + detailRow('Phone', a.phone_number)}
       ${a.convert_request?.price ? detailRow('Requested Order Price', '₹' + a.convert_request.price + (a.convert_request.tax_rate ? ` (+${a.convert_request.tax_rate}% tax)` : '')) : ''}
       ${detailRow('Remarks', a.remarks)}`;

  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Allocation Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Allocation ID</small><p>${a.allocation_id ?? ''}</p></div>
    ${itemsHtml}
    <div class="detail"><small>Allotment Date</small><p>${a.allotment_date ? new Date(a.allotment_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Return Due</small><p>${a.return_due_date ? new Date(a.return_due_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Created By</small><p>${esc(a.created_by || a.allocated_by || '-')}</p></div>
    ${a.return_status === 'returned' ? `<div class="detail"><small>Return Approved By</small><p>${esc(a.returned_by || '-')}</p></div>
    <div class="detail"><small>Returned On</small><p>${fmtDT(returnedOn(a))}</p></div>` : ''}
    <div class="detail"><small>Status</small><p>${meta.label}</p></div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

// ---------- Edit allocation (serial number swap + details) ----------
async function openEditAllocationModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';
  const items = a.items || [];
  const it = items.length === 1 ? items[0] : null;
  const qty = it ? Math.max(1, Number(it.quantity) || (it.serial_numbers || []).length || 1) : 0;
  const current = it ? (it.serial_numbers || []) : [];
  const isDemo = a.allocation_type === 'demo_unit';
  const inp = 'width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;';

  content.innerHTML = '<p style="padding:20px;color:#64748b;">Loading available serial numbers…</p>';
  modal.style.display = 'flex';

  let available = [];
  if (it) {
    try {
      const res = await apiFetch(`/inventory/available_serials?product_id=${encodeURIComponent(it.product_id || '')}&model_no=${encodeURIComponent(it.model_no || '')}`);
      if (res.ok) available = (await res.json()).serial_numbers || [];
    } catch (e) { /* picker just shows current serial */ }
  }
  const options = [...current, ...available.filter(x => !current.includes(x))];

  const serialSelects = it ? Array.from({ length: qty }, (_, k) => `
      <select class="editSerial" style="${inp}margin-bottom:6px;">
        ${current[k] ? '' : '<option value="">— select serial —</option>'}
        ${options.map(x => `<option value="${esc(x)}" ${x === current[k] ? 'selected' : ''}>${esc(x)}${x === current[k] ? ' (current)' : ''}</option>`).join('')}
      </select>`).join('') : '';

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3>Edit Allocation</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${items.map(i => itemDetailBlock(i, false)).join('')}
    ${it ? `<div class="detail"><small>Serial Number(s) — ${available.length} other available in inventory</small>${serialSelects}
      <p style="font-size:12px;color:#64748b;">The new serial is deducted from inventory; the old one goes back to inventory.</p></div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
      ${isDemo ? '' : `
      <input id="editCompany" placeholder="Company Name" value="${esc(a.company_name || '')}" style="${inp}">
      <input id="editAddress" placeholder="Address" value="${esc(a.address || '')}" style="${inp}">
      <input id="editGst" placeholder="GST Number" value="${esc(a.gst_number || '')}" style="${inp}">
      <input id="editPhone" placeholder="Phone Number" value="${esc(a.phone_number || '')}" style="${inp}">`}
      <input id="editRemarks" placeholder="Remarks" value="${esc(a.remarks || '')}" style="${inp}">
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:14px;">
      <button type="button" id="editCancel" style="padding:10px 16px;border:none;border-radius:8px;background:#e5e7eb;cursor:pointer;">Cancel</button>
      <button type="button" id="editSave" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Save Changes</button>
    </div>`;

  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  document.getElementById('editCancel').addEventListener('click', close);
  document.getElementById('editSave').addEventListener('click', async () => {
    const body = { remarks: document.getElementById('editRemarks').value };
    if (!isDemo) {
      body.company_name = document.getElementById('editCompany').value;
      body.address = document.getElementById('editAddress').value;
      body.gst_number = document.getElementById('editGst').value;
      body.phone_number = document.getElementById('editPhone').value;
    }
    if (it) {
      const picked = [...content.querySelectorAll('.editSerial')].map(sel => sel.value);
      const filled = picked.filter(Boolean);
      if (filled.length && filled.length !== qty) return alert('Select a serial number for every unit.');
      if (new Set(filled).size !== filled.length) return alert('Serial numbers must be different.');
      if (filled.length && JSON.stringify(filled) !== JSON.stringify(current)) body.serial_numbers = filled;
    }
    try {
      const res = await apiFetch(`/allocation/edit/${a.allocation_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      close();
      await loadAllocations();
      alert(data.message || 'Allocation updated');
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// ---------- Convert a dispatched demo unit straight into an order ----------
function openConvertAllocationModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';
  const c = a.customer || {};
  const inp = 'width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;';
  const today = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3>Convert to Order</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${(a.items || []).map(i => itemDetailBlock(i, false)).join('')}
    <p style="font-size:12px;color:#64748b;margin-bottom:8px;">Enter the customer's company details. The demo unit moves to Orders (stock is not changed again).</p>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <input id="cvCompany" placeholder="Company Name *" value="${esc(c.company_name || '')}" style="${inp}">
      <input id="cvAddress" placeholder="Company Address *" value="${esc(c.company_address || c.address || '')}" style="${inp}">
      <input id="cvGst" placeholder="GST Number" value="${esc(c.gst_number || '')}" style="${inp}">
      <input id="cvPrice" type="number" min="0" step="any" placeholder="Price per unit (₹) *" value="${a.convert_request?.price || ''}" style="${inp}">
      <input id="cvTax" type="number" min="0" step="any" placeholder="Tax Rate (%)" value="${a.convert_request?.tax_rate || ''}" style="${inp}">
      <input id="cvInvNo" placeholder="Invoice Number *" style="${inp}">
      <input id="cvInvDate" type="date" value="${today}" style="${inp}">
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:14px;">
      <button type="button" id="cvCancel" style="padding:10px 16px;border:none;border-radius:8px;background:#e5e7eb;cursor:pointer;">Cancel</button>
      <button type="button" id="cvSave" style="padding:10px 16px;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;">Create Order</button>
    </div>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  document.getElementById('cvCancel').addEventListener('click', close);
  document.getElementById('cvSave').addEventListener('click', async () => {
    const v = id => document.getElementById(id).value.trim();
    const body = {
      company_name: v('cvCompany'), company_address: v('cvAddress'), gst_number: v('cvGst'),
      price: Number(v('cvPrice')) || 0, tax_rate: Number(v('cvTax')) || 0,
      invoice_no: v('cvInvNo'), invoice_date: v('cvInvDate'),
    };
    if (!body.company_name || !body.company_address) return alert('Company name and address are required.');
    if (body.price <= 0) return alert('Enter a valid price.');
    if (!body.invoice_no || !body.invoice_date) return alert('Invoice number and date are required.');
    try {
      const res = await apiFetch(`/allocation/convert_to_order_direct/${a.allocation_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'conversion failed');
      close();
      await loadAllocations();
      alert(`${data.message}\nOrder ID: ${data.order_id}`);
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}

// ---------- Report Damaged Product modal ----------
function openDamageReportModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Report Damaged Product</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="damageForm" style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="font-size:12px;color:#64748b;">Photo of damage (required)</label>
        <input type="file" name="image" accept="image/*" required style="width:100%;padding:6px 0;">
      </div>
      <textarea name="issue" placeholder="Specify the issue (e.g. cracked casing, broken screen...)" required rows="4"
        style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;resize:vertical;"></textarea>
      <p style="font-size:11px;color:#94a3b8;">Photo is emailed immediately and auto-deleted from the database after 2 days.</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#d62828;color:#fff;cursor:pointer;">Submit</button>
      </div>
    </form>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  content.querySelector('#damageForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const issue = (fd.get('issue') || '').trim();
    const imageFile = e.target.image.files[0];

    if (!imageFile) { alert('Please attach a photo of the damaged product.'); return; }
    if (!issue) { alert('Please specify the issue.'); return; }

    const maxBytes = 2 * 1024 * 1024;
    if (imageFile.size > maxBytes) {
      alert(`Image is ${(imageFile.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`);
      return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await apiFetch(`/allocation/report_damage/${a.allocation_id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issue, image: reader.result })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'damage report failed');
        modal.style.display = 'none';
        await loadAllocations();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    };
    reader.readAsDataURL(imageFile);
  });

  modal.style.display = 'flex';
}

function openDamageViewModal(a) {
  if (!a?.damage_report) return;
  const dr = a.damage_report;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');

  const photoHtml = src => `<img src="${src}" style="max-width:100%;border-radius:10px;margin-top:8px;">`;
  const purgedHtml = `<p style="font-size:12px;color:#94a3b8;margin-top:6px;">Photo already emailed and auto-deleted from the database (2-day retention).</p>`;
  // photo is no longer sent with the allocation list (it is a large base64 blob) — loaded when opened
  const imageHtml = dr.image ? photoHtml(dr.image) : (dr.image_purged ? purgedHtml : '<p id="damagePhotoBox" style="font-size:12px;color:#94a3b8;margin-top:6px;">Loading photo…</p>');

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Damage Report</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Issue</small><p>${dr.issue ?? ''}</p></div>
    <div class="detail"><small>Reported By</small><p>${dr.reported_by ?? ''}</p></div>
    <div class="detail"><small>Reported At</small><p>${dr.reported_at ? new Date(dr.reported_at).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Photo</small>${imageHtml}</div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';

  const box = document.getElementById('damagePhotoBox');
  if (box) {
    apiFetch(`/allocation/${a.allocation_id}/damage_image`)
      .then(r => r.json())
      .then(d => { box.outerHTML = d.image ? photoHtml(d.image) : purgedHtml; })
      .catch(() => { box.textContent = 'Photo could not be loaded.'; });
  }
}

function wireTopActions() {
  const exportBtn = document.querySelector('.top-actions .export');
  if (exportBtn) exportBtn.addEventListener('click', exportAllocationsCSV);
  // Allocate button is wired inside injectAllocateModal()

  // Matches backend: admin/accounts/service_manager can create & send to
  // dispatch; admin/accounts/distributor/service_manager can return or
  // report damage.
  const role = getRole();
  window.__allocCanEdit = role === 'admin' || role === 'accounts';
  window.__allocCanCreate = role === 'admin' || role === 'accounts' || role === 'service_manager';
  window.__allocCanReturnOrDamage = role === 'admin' || role === 'accounts' || role === 'distributor' || role === 'service_manager';
  if (!window.__allocCanCreate) {
    const addBtn = document.querySelector('.top-actions .add-product');
    if (addBtn) addBtn.style.display = 'none';
  }
}

// Distinct sales-person names across the current product allocations, for
// the export wizard's "All / a particular sales person" filter. Spare-part
// and demo-unit allocations don't have a sales person, so they're only ever
// included when "All" is selected.
function uniqueSalesPersonNames() {
  const names = new Set();
  allocState.allocations.forEach(a => {
    if (a.allocation_type !== 'spare_part' && a.sales_person?.name) names.add(a.sales_person.name);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

function exportAllocationsCSV() {
  openExportWizard({
    title: 'Export Allocations',
    statusOptions: ['pending', 'returned'],
    statusField: 'return_status',
    dateField: 'allotment_date',
    dateLabel: 'Allotment Date',
    personOptions: uniqueSalesPersonNames(),
    personField: 'sales_person.name',
    getRows: () => allocState.allocations,
    onConfirm: (rows) => {
      const header = ['Allocation ID', 'Type', 'Product/Spare Part', 'Sales Person/Service', 'Serial_no.' ,'Allotment Date', 'Return Due', 'Created By', 'Returned By', 'Returned On', 'Status'];
      const csvRows = rows.map(a => {
        const isSpare = a.allocation_type === 'spare_part';
        return [
          a.allocation_id,
          isSpare ? 'Spare Part' : 'Product',
          isSpare ? `${a.spare_part?.part_name} x${a.spare_part?.quantity}` : (a.items || []).map(i => `${reqItemLabel(i)} x${i.quantity}`).join(' | '),
          isSpare ? a.spare_part?.service_id : a.sales_person?.name,
          a.serial_numbers,
          a.allotment_date,
          a.return_due_date,
          a.created_by || a.allocated_by || '',
          a.returned_by || '',
          returnedOn(a) || '',
          returnMeta(a).label
        ];
      });
      downloadCSV(header, csvRows, 'allocations.csv');
    }
  });
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function downloadCSV(header, rows, filename) {
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function openExportWizard({ title, statusOptions, statusField, dateField, dateLabel, personOptions, personField, getRows, onConfirm }) {
  const field = statusField || 'status';
  let modal = document.getElementById('exportWizardModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'exportWizardModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1200;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:360px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>${title}</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:#64748b;">Status</label>
        <select name="status" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${personOptions ? `
        <label style="font-size:13px;color:#64748b;">Sales Person</label>
        <select name="person" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="">All</option>
          ${personOptions.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  modal.querySelector('#exportWizardForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = fd.get('status');
    const person = fd.get('person');
    const dateFrom = fd.get('dateFrom');
    const dateTo = fd.get('dateTo');

    const filtered = getRows().filter(row => {
      if (status && row[field] !== status) return false;
      // "All" (empty) keeps every allocation type; picking a name only keeps
      // that sales person's product allocations (spare parts/demo units have
      // no sales_person, so they're excluded once a specific name is chosen).
      if (personField && person && row.sales_person?.name !== person) return false;
      if (dateField && (dateFrom || dateTo)) {
        const rowDate = row[dateField] ? new Date(row[dateField]) : null;
        if (!rowDate) return false;
        if (dateFrom && rowDate < new Date(dateFrom)) return false;
        if (dateTo && rowDate > new Date(dateTo + 'T23:59:59')) return false;
      }
      return true;
    });

    modal.style.display = 'none';
    onConfirm(filtered);
  });

  modal.style.display = 'flex';
}

function wireFilter() {
  const filterBtn = document.querySelector('.filter-btn');
  if (!filterBtn) return;
  filterBtn.addEventListener('click', () => {
    const [statusSel] = document.querySelectorAll('.filter-box select');
    const [dateBox] = document.querySelectorAll('.filter-box input[type="date"]');
    const status = statusSel.value === 'All Status' ? '' : statusSel.value;
    const date = dateBox.value;

    allocState.activeFilters = (status || date) ? { status, date } : null;
    allocPage = 1;
    renderAllocationsTable(getFilteredAllocations());
  });
}

// ---------- Allocate wizard ----------
const allocWiz = {
  type: '',              // 'product' | 'spare'
  salesPersonId: '',
  salesPerson: null,
  cart: {},               // product_id -> {product_id, product_name, quantity}
  serialChoices: {},      // rowKey (product_id||product_name||model_no) -> [serial1, serial2, ...] one per unit
  service: null,
  partName: '',
  partQuantity: 1,
  companyName: '',
  address: ''
};

function resetAllocWiz() {
  allocWiz.type = '';
  allocWiz.salesPersonId = '';
  allocWiz.salesPerson = null;
  allocWiz.cart = {};
  allocWiz.serialChoices = {};
  allocWiz.service = null;
  allocWiz.partName = '';
  allocWiz.partQuantity = 1;
  allocWiz.companyName = '';
  allocWiz.address = '';
}

function injectAllocateModal() {
  const modal = document.getElementById('allocateModal');
  const newBtn = document.querySelector('.top-actions .add-product');
  if (newBtn) newBtn.addEventListener('click', () => {
    resetAllocWiz();
    modal.style.display = 'flex';
    renderAllocTypeStep();
  });
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

function allocModalBody() {
  const modal = document.getElementById('allocateModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="allocWizTitle">Allocate</h3>
      <button type="button" id="allocWizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div id="allocWizBody"></div>`;
  content.querySelector('#allocWizClose').addEventListener('click', () => modal.style.display = 'none');
  return document.getElementById('allocWizBody');
}
function allocWizTitle(t) { document.getElementById('allocWizTitle').textContent = t; }

// Step 0: allocation type
function renderAllocTypeStep() {
  const body = allocModalBody();
  allocWizTitle('Allocate');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">What are you allocating?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnAllocProduct" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-box"></i><br>Product to User
      </button>
      <button id="btnAllocSpare" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-screwdriver-wrench"></i><br>Spare Part to Service
      </button>
    </div>`;
  document.getElementById('btnAllocProduct').addEventListener('click', () => { allocWiz.type = 'product'; renderSystemUserStep(); });
  document.getElementById('btnAllocSpare').addEventListener('click', () => { allocWiz.type = 'spare'; renderActiveServicesStep(); });
}

// ----- Product allocation flow -----
// Allocation can only go to a registered system user (no free-typed sales persons).
async function renderSystemUserStep() {
  const body = allocModalBody();
  allocWizTitle('Select User');
  body.innerHTML = `
    <input id="spSearch" placeholder="Search user" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="spResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="backSp1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('backSp1').addEventListener('click', renderAllocTypeStep);

  const searchInput = document.getElementById('spSearch');
  const resultsBox = document.getElementById('spResults');
  resultsBox.innerHTML = '<small style="color:#94a3b8;">Loading...</small>';
  let users = [];
  try {
    const res = await apiFetch('/account/users');
    const data = await res.json();
    users = data.dataset || [];
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Could not load users.</small>';
    return;
  }
  const draw = () => {
    const term = searchInput.value.trim().toLowerCase();
    const list = users.filter(u => `${u.name || ''} ${u.username || ''} ${u.role || ''}`.toLowerCase().includes(term));
    if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No users found.</small>'; return; }
    resultsBox.innerHTML = list.map(u => `
      <div class="sp-row" data-username="${u.username}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
        <strong>${u.name || u.username}</strong><br>
        <small style="color:#64748b;">${u.username} • ${u.role ?? ''}</small>
      </div>`).join('');
    resultsBox.querySelectorAll('.sp-row').forEach(row => row.addEventListener('click', () => {
      const u = users.find(x => x.username === row.dataset.username);
      allocWiz.salesPersonId = u.username;
      allocWiz.salesPerson = u;
      renderProductCartStep();
    }));
  };
  searchInput.addEventListener('input', draw);
  draw();
}

function renderProductCartStep() {
  const body = allocModalBody();
  allocWizTitle(`Products for ${allocWiz.salesPerson?.name ?? ''}`);
  const products = allocState.products;

  // BUG FIX (same as orders.js): inventory keeps one document per lot, and
  // the same product_id can appear on several rows with a different
  // product_name/model_no. A row/cart-line is only "the same product" when
  // product_id + product_name + model_no ALL match — otherwise it's a
  // different, independent product and needs its own row + cart entry.
  const rowKey = (p) => `${p.product_id}||${p.product_name || ''}||${p.model_no || ''}`;
  const totalQtyByKey = new Map();
  for (const p of products) {
    const key = rowKey(p);
    totalQtyByKey.set(key, (totalQtyByKey.get(key) || 0) + (Number(p.quantity) || 0));
  }
  const stockFor = (p) => totalQtyByKey.get(rowKey(p)) ?? (Number(p.quantity) || 0);
  function dedupeByRowKey(list) {
    const seen = new Map();
    for (const p of list) {
      const key = rowKey(p);
      if (!seen.has(key)) seen.set(key, p);
    }
    return [...seen.values()];
  }

  body.innerHTML = `
    <input id="allocProdFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#64748b;"><th>Product</th><th>Stock</th><th style="width:70px;">Qty</th></tr></thead>
        <tbody id="allocProdRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backCart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="toDetailsBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
    </div>`;
  document.getElementById('backCart').addEventListener('click', renderSystemUserStep);

  const rowsBox = document.getElementById('allocProdRows');
  const renderRows = (list) => {
    const rows = dedupeByRowKey(list);
    rowsBox.innerHTML = rows.map(p => {
      const key = rowKey(p);
      const stock = stockFor(p);
      return `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}${p.model_no ? ' · ' + p.model_no : ''}</small></td>
        <td>${stock}</td>
        <td><input type="number" min="0" max="${stock}" value="${allocWiz.cart[key]?.quantity ?? 0}"
              data-row-key="${key}" class="allocQtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`;
    }).join('');
    rowsBox.querySelectorAll('.allocQtyInput').forEach(inp => inp.addEventListener('input', () => {
      const key = inp.dataset.rowKey;
      const p = rows.find(x => rowKey(x) === key);
      if (!p) return;
      const stock = stockFor(p);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, stock));
      inp.value = qty;
      if (qty > 0) allocWiz.cart[key] = { product_id: p.product_id, product_name: p.product_name, model_no: p.model_no || '', quantity: qty };
      else delete allocWiz.cart[key];
    }));
  };
  renderRows(products);
  document.getElementById('allocProdFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term) || (p.model_no || '').toLowerCase().includes(term)));
  });

  document.getElementById('toDetailsBtn').addEventListener('click', () => {
    if (!Object.keys(allocWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    renderAllocSerialReviewStep();
  });
}

// Step: review auto-fetched serial numbers for the cart, optionally swap any
// of them for a different available serial before allotment details.
async function renderAllocSerialReviewStep() {
  allocWizTitle('Review Serial Numbers');
  const body = allocModalBody();
  body.innerHTML = `<p style="color:#94a3b8;">Loading available serial numbers...</p>`;

  const cartItems = Object.values(allocWiz.cart);
  const rowKeyOf = (i) => `${i.product_id}||${i.product_name}||${i.model_no || ''}`;

  const availableByVariant = {};
  await Promise.all(cartItems.map(async (item) => {
    const variantKey = `${item.product_id}||${item.model_no || ''}`;
    if (availableByVariant[variantKey]) return;
    try {
      const params = new URLSearchParams({ product_id: item.product_id, model_no: item.model_no || '' });
      const res = await apiFetch(`/inventory/available_serials?${params.toString()}`);
      const data = await res.json();
      availableByVariant[variantKey] = data.serial_numbers || [];
    } catch (err) {
      availableByVariant[variantKey] = [];
    }
  }));

  let html = `<p style="color:#64748b;margin-bottom:12px;font-size:13px;">
    Each unit is auto-assigned the oldest available serial number. Pick a different one below if needed — search by typing in the box.
  </p>`;

  cartItems.forEach((item) => {
    const rowKey = rowKeyOf(item);
    const variantKey = `${item.product_id}||${item.model_no || ''}`;
    const available = availableByVariant[variantKey] || [];
    const needed = item.quantity;
    const slots = Math.min(needed, available.length);

    html += `<div style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:8px;padding:10px;">
      <strong>${item.product_name}${item.model_no ? ' · ' + item.model_no : ''}</strong> × ${needed}`;

    if (!available.length) {
      html += `<p style="font-size:12px;color:#94a3b8;margin-top:4px;">No serial numbers on file for this item — will allocate unserialized.</p></div>`;
      return;
    }
    if (needed > available.length) {
      html += `<p style="font-size:12px;color:#d62828;margin-top:4px;">Only ${available.length} serial number(s) on file — the remaining ${needed - available.length} unit(s) will allocate unserialized.</p>`;
    }

    const existingChoices = allocWiz.serialChoices[rowKey] || [];
    for (let slot = 0; slot < slots; slot++) {
      const defaultSerial = available[slot];
      const chosen = existingChoices[slot] || defaultSerial;
      html += `
        <div style="margin-top:8px;">
          <label style="font-size:12px;color:#64748b;">Unit ${slot + 1} serial number${chosen === defaultSerial ? ' (auto)' : ''}</label>
          <input list="allocSerialList__${rowKey.replace(/[^a-zA-Z0-9]/g, '_')}__${slot}" class="allocSerialPickInput"
                 data-row-key="${rowKey}" data-slot="${slot}" value="${chosen}"
                 style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;">
          <datalist id="allocSerialList__${rowKey.replace(/[^a-zA-Z0-9]/g, '_')}__${slot}">
            ${available.map(sn => `<option value="${sn}">`).join('')}
          </datalist>
        </div>`;
    }
    html += `</div>`;
  });

  html += `
    <div style="display:flex;justify-content:space-between;margin-top:14px;">
      <button type="button" id="backSerialReview" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="toDetailsBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
    </div>`;

  body.innerHTML = html;
  document.getElementById('backSerialReview').addEventListener('click', renderProductCartStep);

  body.querySelectorAll('.allocSerialPickInput').forEach(inp => {
    const rowKey = inp.dataset.rowKey;
    const slot = Number(inp.dataset.slot);
    if (!allocWiz.serialChoices[rowKey]) allocWiz.serialChoices[rowKey] = [];
    allocWiz.serialChoices[rowKey][slot] = inp.value;
    inp.addEventListener('change', () => {
      const siblings = [...body.querySelectorAll(`.allocSerialPickInput[data-row-key="${rowKey}"]`)];
      const dup = siblings.find(s => s !== inp && s.value === inp.value && inp.value.trim() !== '');
      if (dup) {
        alert('This serial number is already selected for another unit of this item — pick a different one.');
        inp.value = allocWiz.serialChoices[rowKey][slot] || '';
        return;
      }
      const item = cartItems.find(i => rowKeyOf(i) === rowKey);
      const variantKey = `${item?.product_id}||${item?.model_no || ''}`;
      const available = availableByVariant[variantKey] || [];
      if (inp.value.trim() && !available.includes(inp.value.trim())) {
        alert('That serial number isn\'t in the available list for this product.');
        inp.value = allocWiz.serialChoices[rowKey][slot] || '';
        return;
      }
      allocWiz.serialChoices[rowKey][slot] = inp.value.trim();
    });
  });

  document.getElementById('toDetailsBtn2').addEventListener('click', renderCompanyDetailsStep);
}

// Step: optional company details — none of these fields are required, so the
// admin can skip straight through if there's nothing to record here.
function renderCompanyDetailsStep() {
  const body = allocModalBody();
  allocWizTitle('Company Details (Optional)');
  const c = allocWiz.companyDetails || {};
  body.innerHTML = `
    <form id="companyDetailsForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company Name" value="${c.company_name ?? ''}">
      <input name="address" placeholder="Address" value="${c.address ?? ''}">
      <input name="gst_number" placeholder="GST No." value="${c.gst_number ?? ''}">
      <input name="phone_number" placeholder="Phone No." value="${c.phone_number ?? ''}">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backCompanyDetails" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('backCompanyDetails').addEventListener('click', renderAllocSerialReviewStep);
  document.getElementById('companyDetailsForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    allocWiz.companyDetails = {
      company_name: fd.get('company_name') || '',
      address: fd.get('address') || '',
      gst_number: fd.get('gst_number') || '',
      phone_number: fd.get('phone_number') || ''
    };
    renderAllotmentDetailsStep();
  });
}

function renderAllotmentDetailsStep() {
  const body = allocModalBody();
  allocWizTitle('Allotment Details');
  const today = new Date().toLocaleDateString('en-GB');
  const cartItems = Object.values(allocWiz.cart);
  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `${i.product_name} × ${i.quantity}`).join('<br>')}
    </div>
    <form id="allotmentForm" style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="font-size:13px;color:#64748b;">Allotment Date</label>
        <input value="${today}" disabled style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f3f4f6;">
      </div>
      <p style="font-size:12px;color:#94a3b8;">Return window: 7 days from allotment date.</p>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backDetails" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Create Allotment</button>
      </div>
    </form>`;
  document.getElementById('backDetails').addEventListener('click', renderCompanyDetailsStep);
  document.getElementById('allotmentForm').addEventListener('submit', async e => {
    e.preventDefault();
    const c = allocWiz.companyDetails || {};
    const payload = {
      allocated_to: allocWiz.salesPersonId || '',
      items: Object.values(allocWiz.cart).map(i => {
        const rowKey = `${i.product_id}||${i.product_name}||${i.model_no || ''}`;
        const chosen = (allocWiz.serialChoices[rowKey] || []).filter(Boolean);
        return {
          ...i,
          // only send serial_numbers when we have exactly one per unit —
          // otherwise leave empty so the backend falls back to auto-allocation
          serial_numbers: chosen.length === i.quantity ? chosen : []
        };
      }),
      company_name: c.company_name || '',
      address: c.address || '',
      gst_number: c.gst_number || '',
      phone_number: c.phone_number || ''
    };
    try {
      const res = await apiFetch('/allocation/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'allocation failed');
      document.getElementById('allocateModal').style.display = 'none';
      resetAllocWiz();
      await loadAllocations();
      await loadInventoryForAllocation();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// ----- Spare-part allocation flow -----
async function renderActiveServicesStep() {
  const body = allocModalBody();
  allocWizTitle('Active Services');
  body.innerHTML = `<p style="color:#94a3b8;">Loading active services...</p>`;
  try {
    const res = await apiFetch('/service/active');
    const data = await res.json();
    const list = data.dataset || [];
    body.innerHTML = `
      <div id="svcList" style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
      <div style="margin-top:14px;">
        <button type="button" id="backAllocType2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      </div>`;
    document.getElementById('backAllocType2').addEventListener('click', renderAllocTypeStep);

    const svcList = document.getElementById('svcList');
    if (!list.length) { svcList.innerHTML = '<small style="color:#94a3b8;">No active services found.</small>'; return; }
    svcList.innerHTML = list.map(s => `
      <div class="svc-row" data-id="${s.service_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
        <strong>${s.product_id ?? ''}</strong> — ${s.serial_no ?? ''}<br>
        <small style="color:#64748b;">${s.issue ?? ''} • ${s.status ?? ''}</small>
      </div>`).join('');
    svcList.querySelectorAll('.svc-row').forEach(row => row.addEventListener('click', () => {
      const s = list.find(x => x.service_id === row.dataset.id);
      allocWiz.service = s;
      renderSparePartFormStep();
    }));
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') body.innerHTML = '<small style="color:#d62828;">Could not load services.</small>';
  }
}

function renderSparePartFormStep() {
  const body = allocModalBody();
  allocWizTitle(`Spare Part — Service #${(allocWiz.service.service_id || '').slice(0, 8)}`);
  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      Product: ${allocWiz.service.product_id ?? ''} • Serial: ${allocWiz.service.serial_no ?? ''}<br>
      Issue: ${allocWiz.service.issue ?? ''}
    </div>
    <form id="sparePartForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="part_name" placeholder="Spare Part Name" required>
      <input name="quantity" type="number" min="1" value="1" placeholder="Quantity" required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backSpare" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Allocate</button>
      </div>
    </form>`;
  document.getElementById('backSpare').addEventListener('click', renderActiveServicesStep);
  document.getElementById('sparePartForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      spare_part: {
        service_id: allocWiz.service.service_id,
        part_name: fd.get('part_name'),
        quantity: Number(fd.get('quantity')) || 1
      }
    };
    try {
      const res = await apiFetch('/allocation/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'allocation failed');
      resetAllocWiz();
      window.location.href = data.redirect || 'service.html';
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}