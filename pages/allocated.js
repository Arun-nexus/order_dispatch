/* ---- A4 print support: print_a4.js is loaded on demand (safe if it is missing) ---- */
(function () { if (typeof A4Print === 'undefined' && !document.getElementById('a4printjs')) { const s = document.createElement('script'); s.id = 'a4printjs'; s.src = 'print_a4.js'; document.head.appendChild(s); } })();
function a4Ready(cb, n) { n = n || 0; if (typeof A4Print !== 'undefined') return cb(); if (n < 50) setTimeout(() => a4Ready(cb, n + 1), 200); }
function a4Intercept(head, rows, name) { return typeof A4Print !== 'undefined' && A4Print.intercept(head, rows, name); }
function a4WizardPrint(modal, title) { if (typeof A4Print !== 'undefined') A4Print.wizardPrint(modal, title); }
function a4Twin(btn, title) { if (btn) a4Ready(() => A4Print.attachTwin(btn, title)); }
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

// Opens the allocate wizard at the part step for a technician's spare part request:
// ?alloc_service=<service_id>&alloc_parts=<name|name>&alloc_request=<request_id>
async function openRequestedPartAllocation(params) {
  const sid = params.get('alloc_service'), rid = params.get('alloc_request');
  const parts = (params.get('alloc_parts') || '').split('|').map(x => x.trim()).filter(Boolean);
  if (!sid || !rid) return;
  const modal = document.getElementById('allocateModal');
  resetAllocWiz();
  allocWiz.type = 'spare';
  allocWiz.requestId = rid;
  allocWiz.queue = parts;
  modal.style.display = 'flex';
  try {
    const res = await apiFetch('/service/');
    const data = await res.json();
    allocWiz.service = (data.dataset || []).find(x => x.service_id === sid) || { service_id: sid };
  } catch (e) { allocWiz.service = { service_id: sid }; }
  renderSparePartFormStep();
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
  wireAllocCardClicks();
  try {
    const qp = new URLSearchParams(location.search);
    if (qp.get('alloc_service')) { openRequestedPartAllocation(qp); history.replaceState(null, '', location.pathname); }
  } catch (e) { console.error(e); }
  setInterval(() => renderAllocationsTable(getFilteredAllocations()), 60 * 1000); // keep countdowns fresh
  setInterval(() => { if (!reqBusy.size) loadPendingRequests(); }, 60 * 1000);
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
    const reqCardBox = document.getElementById('cardPendingRequests')?.closest('.card');
    if (reqCardBox) reqCardBox.style.display = 'none';
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

// "dd/mm/yyyy, hh:mm AM/PM" — date AND time the request was generated
function fmtReqDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleDateString('en-GB') + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function renderPendingRequests() {
  const box = document.getElementById('pendingRequestsList');
  const badge = document.getElementById('notifBadge');
  const countLabel = document.getElementById('pendingCountLabel');
  if (!box) return;

  const pending = allocState.requests.filter(r => r.status === 'pending');
  const listed = allocState.requests
    .filter(r => r.status === 'pending' || r.status === 'partially_approved')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (badge) {
    badge.style.display = pending.length ? 'inline-block' : 'none';
    badge.textContent = pending.length;
  }
  if (countLabel) countLabel.textContent = pending.length ? `(${pending.length})` : '';
  const reqCard = document.getElementById('cardPendingRequests');
  if (reqCard) reqCard.textContent = pending.length;

  if (!listed.length) {
    box.innerHTML = '<p style="color:#94a3b8;padding:10px;">No pending requests.</p>';
    return;
  }

  box.innerHTML = listed.map(r => {
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

    if (r.status === 'partially_approved') {
      subtitle = (subtitle || '') + ` • Partial: ${(r.details?.partial?.approved_items || []).length} approved, ${(r.details?.partial?.unapproved_items || []).length} not approved — ${esc(r.details?.partial?.remarks || '')}`;
    }
    const canPartial = r.status === 'pending' && ['demo_unit', 'order'].includes(r.request_type) && (r.details?.items || []).length > 1;
    // status_update is completed from the Service page's Update Status action (needs
    // service charges etc. that this quick panel doesn't collect), so no approve/reject here
    const actions = r.status === 'partially_approved'
      ? `<span style="font-size:12px;color:#92400e;background:#fef3c7;padding:4px 10px;border-radius:999px;font-weight:600;">Awaiting distributor</span>`
      : r.request_type === 'status_update'
        ? `<p style="font-size:11px;color:#94a3b8;">Complete this from the Service page's Update Status action.</p>`
        : `<div style="display:flex;gap:8px;">
          <button class="req-approve-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;">Approve</button>
          ${canPartial ? '<button class="req-partial-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#d97706;color:#fff;cursor:pointer;">Partial</button>' : ''}
          <button class="req-reject-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#d62828;color:#fff;cursor:pointer;">Reject</button>
        </div>`;

    const typeLabel = ALLOC_REQ_LABELS[r.request_type] || 'Request';
    return `
      <div class="order-item" data-id="${r.request_id}" style="align-items:flex-start;gap:14px;">
        <div class="order-left" style="align-items:flex-start;min-width:0;flex:1;">
          <div class="order-icon"><i class="fa-solid ${icon}"></i></div>
          <div style="min-width:0;">
            <h4 style="margin:0 0 4px;">${title}</h4>
            <p style="margin:0 0 6px;word-break:break-word;">${subtitle || '-'}</p>
            <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:#64748b;">
              <span style="background:#eef2ff;color:#3730a3;padding:2px 8px;border-radius:999px;font-weight:600;">${esc(typeLabel)}</span>
              ${r.status === 'partially_approved' ? '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:999px;font-weight:600;">Partially approved</span>' : ''}
              <span><i class="fa-regular fa-user"></i> Raised by <b>${esc(r.raised_by ?? '-')}</b></span>
              <span title="Request generated on"><i class="fa-regular fa-clock"></i> Requested on <b>${fmtReqDateTime(r.created_at)}</b></span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <button class="req-view-btn" title="View details" style="border:none;background:none;color:#1665ff;font-size:16px;cursor:pointer;"><i class="fa-solid fa-circle-info"></i></button>
          ${actions}
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.req-approve-btn').forEach(btn => btn.addEventListener('click', e => approveRequest(rowRequestId(e))));
  box.querySelectorAll('.req-reject-btn').forEach(btn => btn.addEventListener('click', e => rejectRequest(rowRequestId(e))));
  box.querySelectorAll('.req-partial-btn').forEach(btn => btn.addEventListener('click', e => openRequestPopup(rowRequest(e))));
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
      <div class="detail"><small>Remarks</small><p>${esc(d.remarks || '-')}</p></div>
      ${partialInfoHtml(d)}`;
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
      ${partialInfoHtml(d)}
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
    ${body}
    <div class="detail"><small>Requested On</small><p>${fmtReqDateTime(r.created_at)}</p></div>`;

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

// ---------- payment block for turning a demo unit into an order ----------
// Same payment modes as the Orders page (Credit / Partial / Net Banking / UPI / Cheque / DD / Cash),
// so a converted order carries a real payment mode instead of a "Demo Conversion" label.
const CONV_PAY_MODES = [
  ['Credit', 'Credit'], ['Partial', 'Partial (part now, rest later)'], ['NetBanking', 'Net Banking'],
  ['UPI', 'UPI'], ['Cheque', 'Cheque'], ['DemandDraft', 'Demand Draft'], ['Cash', 'Cash'],
];
const CONV_PAY_INP = 'width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;';

function convPayHtml(selected) {
  return `
    <select id="cvPayMode" style="${CONV_PAY_INP}">
      <option value="">Select Payment Mode *</option>
      ${CONV_PAY_MODES.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <div id="cvPayExtra" style="display:flex;flex-direction:column;gap:8px;"></div>`;
}

function convPayDaysHtml(idPrefix, label) {
  return `
    <label style="font-size:12px;color:#64748b;">${label}</label>
    <select id="${idPrefix}Days" style="${CONV_PAY_INP}">
      <option value="15">15 days</option><option value="30">30 days</option>
      <option value="45">45 days</option><option value="60">60 days</option>
      <option value="manual">Other (enter days)</option>
    </select>
    <input id="${idPrefix}DaysManual" type="number" min="1" max="60" placeholder="Enter days (max 60)" style="display:none;${CONV_PAY_INP}">`;
}

// getTotal() -> order total incl. tax, used for the Partial balance hint / check
function convPayRender(mode, getTotal) {
  const box = document.getElementById('cvPayExtra');
  if (!box) return;
  const f = (id, ph, type) => `<input id="${id}" ${type ? `type="${type}"` : ''} placeholder="${ph}" style="${CONV_PAY_INP}">`;
  if (mode === 'Credit') {
    box.innerHTML = convPayDaysHtml('cvpC', 'Credit period');
  } else if (mode === 'Partial') {
    box.innerHTML = `
      <label style="font-size:12px;color:#64748b;">Amount paid now (₹)</label>
      <input id="cvpPaid" type="number" min="0" step="any" placeholder="e.g. half of the total" style="${CONV_PAY_INP}">
      ${convPayDaysHtml('cvpP', 'In how many days will the remaining payment be made?')}
      <div id="cvpHint" style="font-size:12px;color:#b45309;background:#fffbeb;border-radius:8px;padding:8px 10px;"></div>`;
    const paid = document.getElementById('cvpPaid'), hint = document.getElementById('cvpHint');
    const refresh = () => {
      const total = getTotal(), p = Number(paid.value) || 0;
      const fmt = n => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
      hint.textContent = `Order total (incl. tax): ${fmt(total)} — paid now ${fmt(p)}, balance ${fmt(Math.max(total - p, 0))} on credit.`;
    };
    paid.addEventListener('input', refresh);
    refresh();
    // price / tax can change in the direct-convert form while this block is open
    ['cvPrice', 'cvTax'].forEach(id => document.getElementById(id)?.addEventListener('input', refresh));
  } else if (mode === 'Cheque') {
    box.innerHTML = f('cvpChqNo', 'Cheque Number') + f('cvpChqDate', '', 'date') + f('cvpChqBank', 'Bank Name');
  } else if (mode === 'DemandDraft') {
    box.innerHTML = f('cvpDdNo', 'Demand Draft Number') + f('cvpDdDate', '', 'date') + f('cvpDdBank', 'Bank Name');
  } else if (mode === 'UPI') {
    box.innerHTML = f('cvpUpi', 'UPI ID (e.g. name@bank)');
  } else if (mode === 'NetBanking') {
    box.innerHTML = f('cvpNbBank', 'Bank Name') + f('cvpNbAcc', 'Account Number') + f('cvpNbIfsc', 'IFSC Code');
  } else if (mode === 'Cash') {
    box.innerHTML = f('cvpCash', 'Received By (Person Name)');
  } else {
    box.innerHTML = '';
  }
  box.querySelectorAll('select[id$="Days"]').forEach(sel => sel.addEventListener('change', () => {
    document.getElementById(sel.id + 'Manual').style.display = sel.value === 'manual' ? 'block' : 'none';
  }));
}

// wires the mode <select> built by convPayHtml()
function convPayWire(getTotal) {
  const sel = document.getElementById('cvPayMode');
  if (!sel) return;
  sel.addEventListener('change', () => convPayRender(sel.value, getTotal));
  convPayRender(sel.value, getTotal);
}

// returns { payment_mode, payment_details } or throws an Error with a message for the user
function convPayRead(getTotal) {
  const mode = document.getElementById('cvPayMode')?.value || '';
  if (!mode) throw new Error('Please select a payment mode.');
  const v = id => (document.getElementById(id)?.value || '').trim();
  const days = prefix => {
    const sel = v(prefix + 'Days');
    return Number(sel === 'manual' ? v(prefix + 'DaysManual') : sel);
  };
  if (mode === 'Credit') {
    const d = days('cvpC');
    if (!d || d < 1 || d > 60) throw new Error('Credit days must be between 1 and 60.');
    return { payment_mode: mode, payment_details: { credit_days: d } };
  }
  if (mode === 'Partial') {
    const paid = Number(v('cvpPaid')) || 0, d = days('cvpP'), total = getTotal();
    if (paid <= 0) throw new Error('Enter the amount paid now for a partial payment.');
    if (total > 0 && paid >= total) throw new Error('Partial payment must be less than the order total — choose another payment mode.');
    if (!d || d < 1 || d > 60) throw new Error('Days for the remaining payment must be between 1 and 60.');
    return { payment_mode: mode, payment_details: { paid_amount: paid, credit_days: d } };
  }
  if (mode === 'Cheque') {
    if (!v('cvpChqNo') || !v('cvpChqDate')) throw new Error('Cheque number and date are required.');
    return { payment_mode: mode, payment_details: { cheque_number: v('cvpChqNo'), cheque_date: v('cvpChqDate'), bank_name: v('cvpChqBank') } };
  }
  if (mode === 'DemandDraft') {
    if (!v('cvpDdNo') || !v('cvpDdDate')) throw new Error('Demand draft number and date are required.');
    return { payment_mode: mode, payment_details: { dd_number: v('cvpDdNo'), dd_date: v('cvpDdDate'), bank_name: v('cvpDdBank') } };
  }
  if (mode === 'UPI') {
    if (!v('cvpUpi')) throw new Error('UPI ID is required.');
    return { payment_mode: mode, payment_details: { upi_id: v('cvpUpi') } };
  }
  if (mode === 'NetBanking') {
    if (!v('cvpNbBank') || !v('cvpNbAcc') || !v('cvpNbIfsc')) throw new Error('Bank name, account number and IFSC code are required.');
    return { payment_mode: mode, payment_details: { bank_name: v('cvpNbBank'), account_number: v('cvpNbAcc'), ifsc_code: v('cvpNbIfsc') } };
  }
  if (mode === 'Cash') {
    if (!v('cvpCash')) throw new Error('Received-by person name is required.');
    return { payment_mode: mode, payment_details: { received_by: v('cvpCash') } };
  }
  throw new Error('Invalid payment mode.');
}

function openInvoiceModal(r) {
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';
  const d = r.details || {};
  const getTotal = () => Math.round((d.items || []).reduce((s, i) => {
    const line = (Number(i.price) || 0) * (Number(i.quantity) || 0);
    return s + line + line * (Number(i.tax_rate) || 0) / 100;
  }, 0) * 100) / 100;
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
      ${convPayHtml('')}
      <div style="display:flex;justify-content:space-between;margin-top:6px;">
        <button type="button" id="invoiceCancel" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Approve &amp; Create Order</button>
      </div>
    </form>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  document.getElementById('invoiceCancel').addEventListener('click', close);
  convPayWire(getTotal);
  document.getElementById('invoiceForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let pay;
    try { pay = convPayRead(getTotal); } catch (err) { alert(err.message); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Processing...'; }
    const ok = await approveRequest(r.request_id, { invoice_no: fd.get('invoice_no'), invoice_date: fd.get('invoice_date'), ...pay });
    if (ok) { close(); return; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Approve & Create Order'; }
  });
  modal.style.display = 'flex';
}

const reqBusy = new Set();

function setReqBusy(requestId, on) {
  if (on) reqBusy.add(requestId); else reqBusy.delete(requestId);
  document.querySelectorAll('.order-item[data-id="' + requestId + '"] button').forEach(b => {
    b.disabled = on;
    b.style.opacity = on ? '.55' : '';
    b.style.cursor = on ? 'wait' : 'pointer';
  });
}

async function refreshAfterRequestAction() {
  await Promise.allSettled([loadPendingRequests(), loadAllocations(), loadInventoryForAllocation()]);
}

async function approveRequest(requestId, extra) {
  if (reqBusy.has(requestId)) return false;
  const req = allocState.requests.find(x => x.request_id === requestId);
  if (req && req.request_type === 'convert_to_order' && !extra) { openInvoiceModal(req); return false; }
  if (!extra && !confirm('Approve this request?')) return false;
  let ok = false;
  setReqBusy(requestId, true);
  try {
    const opts = { method: 'POST' };
    if (extra) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(extra); }
    const res = await apiFetch(`/request/approve/${requestId}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'approval failed');
    if (data.pending_allocation && data.redirect) {
      setReqBusy(requestId, false);
      if (/allocated\.html$/.test(location.pathname)) { openRequestedPartAllocation(new URL(data.redirect, location.href).searchParams); return true; }
      window.location.href = data.redirect; return true;
    }
    ok = true;
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  } finally {
    setReqBusy(requestId, false);
  }
  await refreshAfterRequestAction();
  return ok;
}

async function rejectRequest(requestId) {
  if (reqBusy.has(requestId)) return;
  const reason = prompt('Reason for rejecting (optional):');
  if (reason === null) return;
  setReqBusy(requestId, true);
  try {
    const res = await apiFetch(`/request/reject/${requestId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'rejection failed');
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  } finally {
    setReqBusy(requestId, false);
  }
  await refreshAfterRequestAction();
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

function allocCardList(type) {
  const all = allocState.allocations;
  if (type === 'all') return all;
  if (type === 'pending') return all.filter(a => !returnMeta(a).complete && !returnMeta(a).overdue);
  if (type === 'overdue') return all.filter(a => !returnMeta(a).complete && returnMeta(a).overdue);
  if (type === 'returned') return all.filter(a => returnMeta(a).complete);
  return [];
}

function requestSummary(r) {
  const items = r.details?.items || r.details?.items_list || [];
  if (items.length) return items.map(i => `${esc(i.product_name || '')} x${i.quantity ?? 1}`).join(', ');
  if (r.details?.customer?.company_name) return esc(r.details.customer.company_name);
  if (r.details?.service_id) return `Service #${esc(r.details.service_id.slice(0, 8))}`;
  return '-';
}

const allocCV = { type: '', base: [], f: {}, requests: false };
const ALLOC_REQ_LABELS = { demo_unit: 'Demo Unit', spare_part: 'Spare Part', order: 'Order', media_review: 'Service Media', status_update: 'Status Change', convert_to_order: 'Convert to Order', return_demo: 'Demo Return' };
const ALLOC_KIND_LABELS = { product: 'Product', demo_unit: 'Demo', spare_part: 'Spare Part' };

function cvEnsureStyles() {
  if (document.getElementById('cvStyles')) return;
  const st = document.createElement('style');
  st.id = 'cvStyles';
  st.textContent = `
    .cv-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
    .cv-head h3{margin:0}
    .cv-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
    .cv-bar select,.cv-bar input{padding:7px 9px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;background:var(--bg-white);min-width:0}
    .cv-bar input[type=text]{flex:1;min-width:150px}
    .cv-bar label{font-size:12px;color:var(--text-muted)}
    .cv-btn{padding:8px 12px;border:none;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600}
    .cv-btn.exp{background:var(--primary);color:#fff}
    .cv-btn.rst{background:var(--bg-hover);color:var(--text-secondary)}
    .cv-count{font-size:12px;color:var(--text-muted);margin:0 0 8px}
    .cv-wrap{overflow:auto;max-height:58vh;border:1px solid var(--border);border-radius:10px}
    .cv-tbl{width:100%;font-size:12.5px;border-collapse:collapse;min-width:760px}
    .cv-tbl th{position:sticky;top:0;background:var(--bg-light);color:var(--text-secondary);text-align:left;padding:8px;border-bottom:1px solid var(--border);white-space:nowrap}
    .cv-tbl td{color:var(--text-primary);padding:8px;border-bottom:1px solid var(--bg-hover);vertical-align:top}
    .cv-tbl tbody tr.cv-row{cursor:pointer}
    .cv-tbl tbody tr.cv-row:hover{background:var(--bg-light)}
    .cv-hint{font-size:11.5px;color:var(--text-light);margin-top:8px}
  `;
  document.head.appendChild(st);
}

function cvPlain(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html ?? '');
  return d.textContent.replace(/\s+/g, ' ').trim();
}

function cvDownloadCsv(head, rows, fileBase) {
  if (a4Intercept(head, rows, fileBase)) return;
  const cell = v => {
    const t = String(v ?? '');
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${fileBase}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function allocKind(a) {
  return a.allocation_type === 'spare_part' ? 'spare_part' : (a.allocation_type === 'demo_unit' ? 'demo_unit' : 'product');
}

function allocWho(a) {
  return a.allocation_type === 'spare_part'
    ? `Service #${(a.spare_part?.service_id || '').slice(0, 8)}`
    : (a.sales_person?.name ?? '');
}

function allocProductHtml(a) {
  return a.allocation_type === 'spare_part'
    ? sparePartLabel(a.spare_part)
    : (a.items || []).map(itemLabel).join(', ');
}

function allocSerialText(a) {
  return a.allocation_type === 'spare_part' ? '-' : ((a.items || []).map(itemSerials).filter(Boolean).join(', ') || '-');
}

function allocStatusKey(a) {
  const meta = returnMeta(a);
  return meta.complete ? 'returned' : (meta.overdue ? 'overdue' : 'pending');
}

function allocCvFiltered() {
  const f = allocCV.f;
  const q = (f.q || '').toLowerCase();
  if (allocCV.requests) {
    return allocCV.base.filter(r => {
      if (f.reqType && r.request_type !== f.reqType) return false;
      if (f.raisedBy && r.raised_by !== f.raisedBy) return false;
      if (q && !`${ALLOC_REQ_LABELS[r.request_type] || r.request_type || ''} ${cvPlain(requestSummary(r))} ${r.raised_by || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  return allocCV.base.filter(a => {
    if (f.kind && allocKind(a) !== f.kind) return false;
    if (f.status && allocStatusKey(a) !== f.status) return false;
    if (f.who && allocWho(a) !== f.who) return false;
    const d = (a.allotment_date || '').slice(0, 10);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (q) {
      const hay = [a.allocation_id, a.company_name, a.address, allocWho(a), cvPlain(allocProductHtml(a)), allocSerialText(a)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function allocCvHead() {
  return allocCV.requests
    ? ['Type', 'Details', 'Raised By', 'Requested On (Date & Time)']
    : ['Type', 'Product / Spare Part', 'Serial No.', 'Sales Person / Service', 'Allotment Date', 'Return Due', 'Status'];
}

function allocCvCells(x) {
  if (allocCV.requests) {
    return [esc(ALLOC_REQ_LABELS[x.request_type] || x.request_type || '-'), requestSummary(x), esc(x.raised_by || '-'),
    fmtReqDateTime(x.created_at)];
  }
  const meta = returnMeta(x);
  return [
    ALLOC_KIND_LABELS[allocKind(x)],
    allocProductHtml(x),
    esc(allocSerialText(x)),
    esc(allocWho(x)),
    x.allotment_date ? new Date(x.allotment_date).toLocaleDateString('en-GB') : '-',
    x.return_due_date ? new Date(x.return_due_date).toLocaleDateString('en-GB') : '-',
    `<span class="stock ${meta.cls}">${meta.label}</span>`
  ];
}

function allocCvPaint() {
  const body = document.getElementById('cvBody');
  if (!body) return;
  const list = allocCvFiltered();
  const cols = allocCvHead().length;
  body.innerHTML = list.map((x, i) => `<tr class="cv-row" data-i="${i}">${allocCvCells(x).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-light);padding:20px;">Nothing matches these filters.</td></tr>`;
  document.getElementById('cvCount').textContent = `${list.length} of ${allocCV.base.length} record(s)`;
  body.querySelectorAll('tr.cv-row').forEach(tr => tr.addEventListener('click', () => {
    const x = list[Number(tr.dataset.i)];
    const vm = document.getElementById('viewAllocationModal');
    if (vm) vm.style.zIndex = 1100;
    if (allocCV.requests) openRequestDetailsModal(x);
    else openViewAllocationModal(x);
  }));
}

function openAllocCardDetailModal(type) {
  const modal = document.getElementById('allocCardDetailModal');
  const box = modal.querySelector('.modal-content');
  cvEnsureStyles();
  const titles = { all: 'All Allocations', pending: 'Pending Return', overdue: 'Overdue Allocations', returned: 'Returned Allocations', requests: 'Pending Requests' };
  const requests = type === 'requests';
  allocCV.type = type;
  allocCV.requests = requests;
  allocCV.f = {};
  allocCV.base = requests
    ? allocState.requests.filter(r => r.status === 'pending' || r.status === 'partially_approved').sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    : allocCardList(type);
  const opt = arr => arr.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort();

  let bar;
  if (requests) {
    const types = uniq(allocCV.base.map(r => r.request_type));
    const raised = uniq(allocCV.base.map(r => r.raised_by));
    bar = `
      <input type="text" data-f="q" placeholder="Search details, raised by...">
      <select data-f="reqType"><option value="">All Types</option>${types.map(t => `<option value="${esc(t)}">${esc(ALLOC_REQ_LABELS[t] || t)}</option>`).join('')}</select>
      <select data-f="raisedBy"><option value="">All Raised By</option>${opt(raised)}</select>`;
  } else {
    const whos = uniq(allocCV.base.map(allocWho));
    bar = `
      <input type="text" data-f="q" placeholder="Search product, serial, company, ID...">
      <select data-f="kind"><option value="">All Types</option><option value="product">Product</option><option value="demo_unit">Demo</option><option value="spare_part">Spare Part</option></select>
      ${type === 'all' ? '<select data-f="status"><option value="">All Status</option><option value="pending">Pending</option><option value="overdue">Overdue</option><option value="returned">Returned</option></select>' : ''}
      <select data-f="who"><option value="">All Sales / Service</option>${opt(whos)}</select>
      <label>Allotted</label>
      <input type="date" data-f="from" title="From"><input type="date" data-f="to" title="To">`;
  }

  box.style.width = 'min(1100px,95vw)';
  box.innerHTML = `
    <div class="cv-head"><h3>${titles[type]}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>
    <div class="cv-bar">${bar}
      <button class="cv-btn rst" id="cvReset">Reset</button>
      <button class="cv-btn exp" id="cvExport"><i class="fa-solid fa-download"></i> Export CSV</button>
    </div>
    <p class="cv-count" id="cvCount"></p>
    <div class="cv-wrap"><table class="cv-tbl">
      <thead><tr>${allocCvHead().map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody id="cvBody"></tbody></table></div>
    <p class="cv-hint">Click a row to see full details.</p>`;

  box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelectorAll('[data-f]').forEach(el => el.addEventListener(el.type === 'text' ? 'input' : 'change', e => {
    allocCV.f[el.dataset.f] = e.target.value;
    allocCvPaint();
  }));
  box.querySelector('#cvReset').addEventListener('click', () => {
    allocCV.f = {};
    box.querySelectorAll('[data-f]').forEach(el => { el.value = ''; });
    allocCvPaint();
  });
  a4Twin(box.querySelector('#cvExport'), titles[type]);
  box.querySelector('#cvExport').addEventListener('click', () => {
    const list = allocCvFiltered();
    cvDownloadCsv(allocCvHead(), list.map(x => allocCvCells(x).map(cvPlain)), titles[type].toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  });
  allocCvPaint();
  modal.style.display = 'flex';
}

function wireAllocCardClicks() {
  document.querySelectorAll('.cards .card[data-card-filter]').forEach(card => {
    card.addEventListener('click', () => openAllocCardDetailModal(card.dataset.cardFilter));
  });
  const modal = document.getElementById('allocCardDetailModal');
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

function roleLabel(role) {
  if (role === 'distributor') return 'Sales';
  const r = String(role || '').replace(/_/g, ' ');
  return r.charAt(0).toUpperCase() + r.slice(1);
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
  // id + model identify exactly which variant/lot this unit came from (two
  // products can share a name, e.g. same model in black vs grey) — shown as
  // a small sub-line under the name, same pattern used on the Dispatch page.
  const meta = [i.product_id, i.model_no].filter(Boolean).join(' · ');
  const metaHtml = meta ? `<br><small style="color:#94a3b8;">${esc(meta)}</small>` : '';
  return `${esc(i.product_name || '')}${qtyPart}${metaHtml}`;
}
function itemSerials(i) {
  return (i.serial_numbers || []).join(', ');
}

// Spare/service part allocations only carry the part's own name + quantity
// (see allocation.py's spare_part shape) — not which product that part
// belongs to. Inventory's matching spare_parts/service_parts lot DOES carry
// that (parent_product_name), so it's looked up here from the inventory
// list already loaded for the allocate wizard's product picker
// (allocState.products, populated by loadInventoryForAllocation). Matched by
// part name alone since a spare_part allocation has no product_type of its
// own to disambiguate — first match wins.
function sparePartParentName(partName) {
  if (!partName) return '';
  const needle = partName.trim().toLowerCase();
  if (!needle) return '';
  const match = (allocState.products || []).find(p =>
    (p.product_type === 'spare_parts' || p.product_type === 'service_parts') &&
    (p.product_name || '').trim().toLowerCase() === needle
  );
  return match?.parent_product_name || '';
}

function sparePartLabel(sp) {
  const name = esc(sp?.part_name ?? '');
  const qty = sp?.quantity ?? 1;
  const parent = sparePartParentName(sp?.part_name);
  const belongsTo = parent
    ? `<br><small style="color:#94a3b8;">Belongs to: ${esc(parent)}</small>`
    : '';
  return `${name} x${qty}${belongsTo}`;
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
      ? sparePartLabel(a.spare_part)
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
  // plain text only here — this goes into a native confirm() dialog, which
  // can't render the <br><small> markup itemLabel/sparePartLabel use elsewhere
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
       ${detailRow('Belongs To', sparePartParentName(a.spare_part?.part_name))}
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
// The company is picked from the companies already on file (Users → Companies);
// "Create new company" is still there for a customer that is not registered yet.
async function openConvertAllocationModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  content.style.maxHeight = '86vh'; content.style.overflowY = 'auto';

  let companies = [];
  try {
    const r = await apiFetch('/customer/company_list');
    if (r.ok) companies = (await r.json()).dataset || [];
  } catch (e) { companies = []; }

  const c = a.customer || {};
  const today = new Date().toISOString().slice(0, 10);
  const inp = 'width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:8px;';
  const norm = v => String(v || '').trim().toLowerCase();
  // pre-select the company the demo was allotted against, if it is already registered
  const preset = companies.find(x => c.customer_id && x.customer_id === c.customer_id)
    || companies.find(x => norm(x.company_name) && norm(x.company_name) === norm(c.company_name));
  const st = {
    customerId: preset ? preset.customer_id : '',
    company: c.company_name || '', address: c.company_address || c.address || '', gst: c.gst_number || '',
    price: a.convert_request?.price || '', tax: a.convert_request?.tax_rate || '', invNo: '', invDate: today,
  };

  const draw = () => {
    const picked = companies.find(x => x.customer_id === st.customerId);
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3>Convert to Order</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      ${(a.items || []).map(i => itemDetailBlock(i, false)).join('')}
      <p style="font-size:12px;color:#64748b;margin-bottom:8px;">Pick the customer's company. The demo unit moves to Orders (stock is not changed again).</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <select id="cvPick" style="${inp}">
          <option value="">➕ Create new company</option>
          ${companies.map(x => `<option value="${esc(x.customer_id)}" ${x.customer_id === st.customerId ? 'selected' : ''}>${esc(x.company_name)}</option>`).join('')}
        </select>
        ${picked ? `
          <div style="background:#f8fafc;border-radius:10px;padding:10px;font-size:13px;color:#475569;">
            <div><strong>${esc(picked.company_name)}</strong></div>
            <div>${esc(picked.company_address) || '—'}</div>
            <div>GST: ${esc(picked.gst_number) || '—'}${picked.contractor_person ? ' • ' + esc(picked.contractor_person) : ''} ${esc(picked.contractor_number || '')}</div>
          </div>` : `
          <input id="cvCompany" placeholder="Company Name *" value="${esc(st.company)}" style="${inp}">
          <input id="cvAddress" placeholder="Company Address *" value="${esc(st.address)}" style="${inp}">
          <input id="cvGst" placeholder="GST Number" value="${esc(st.gst)}" style="${inp}">`}
        <input id="cvPrice" type="number" min="0" step="any" placeholder="Price per unit (₹) *" value="${esc(st.price)}" style="${inp}">
        <input id="cvTax" type="number" min="0" step="any" placeholder="Tax Rate (%)" value="${esc(st.tax)}" style="${inp}">
        <input id="cvInvNo" placeholder="Invoice Number *" value="${esc(st.invNo)}" style="${inp}">
        <input id="cvInvDate" type="date" value="${esc(st.invDate)}" style="${inp}">
        ${convPayHtml(st.payMode)}
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:14px;">
        <button type="button" id="cvCancel" style="padding:10px 16px;border:none;border-radius:8px;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="button" id="cvSave" style="padding:10px 16px;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;">Create Order</button>
      </div>`;
    wire();
  };

  // keep what was typed when the company choice switches between "existing" and "new"
  const readFields = () => {
    const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : null; };
    for (const [key, id] of [['company', 'cvCompany'], ['address', 'cvAddress'], ['gst', 'cvGst'], ['price', 'cvPrice'], ['tax', 'cvTax'], ['invNo', 'cvInvNo'], ['invDate', 'cvInvDate'], ['payMode', 'cvPayMode']]) {
      const val = v(id);
      if (val !== null) st[key] = val;
    }
  };

  // order total (incl. tax) from the price / tax currently typed in the form and this unit's quantities
  const getTotal = () => {
    const price = Number(document.getElementById('cvPrice')?.value) || 0;
    const tax = Number(document.getElementById('cvTax')?.value) || 0;
    const qty = (a.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    return Math.round(price * qty * (1 + tax / 100) * 100) / 100;
  };

  const wire = () => {
    const close = () => modal.style.display = 'none';
    content.querySelector('.close').addEventListener('click', close);
    document.getElementById('cvCancel').addEventListener('click', close);
    convPayWire(getTotal);
    document.getElementById('cvPick').addEventListener('change', e => { readFields(); st.customerId = e.target.value; draw(); });
    document.getElementById('cvSave').addEventListener('click', async () => {
      readFields();
      const picked = companies.find(x => x.customer_id === st.customerId);
      const body = {
        customer_id: picked ? picked.customer_id : '',
        company_name: picked ? picked.company_name : st.company,
        company_address: picked ? (picked.company_address || '') : st.address,
        gst_number: picked ? (picked.gst_number || '') : st.gst,
        price: Number(st.price) || 0, tax_rate: Number(st.tax) || 0,
        invoice_no: st.invNo, invoice_date: st.invDate,
      };
      if (!picked && (!body.company_name || !body.company_address)) return alert('Select a company, or enter the new company name and address.');
      if (body.price <= 0) return alert('Enter a valid price.');
      if (!body.invoice_no || !body.invoice_date) return alert('Invoice number and date are required.');
      try { Object.assign(body, convPayRead(getTotal)); } catch (err) { return alert(err.message); }
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
  };

  draw();
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
    withTypeFilter: true,
    getRows: getFilteredAllocations,
    onConfirm: (rows) => {
      const header = ['Allocation ID', 'Type', 'Product/Spare Part', 'Sales Person/Service', 'Serial_no.', 'Allotment Date', 'Return Due', 'Created By', 'Returned By', 'Returned On', 'Status'];
      const csvRows = rows.map(a => {
        const isSpare = a.allocation_type === 'spare_part';
        return [
          a.allocation_id,
          ALLOC_KIND_LABELS[allocKind(a)],
          isSpare ? `${a.spare_part?.part_name} x${a.spare_part?.quantity}` : (a.items || []).map(i => `${reqItemLabel(i)} x${i.quantity}`).join(' | '),
          isSpare ? a.spare_part?.service_id : a.sales_person?.name,
          isSpare ? '' : (a.items || []).map(itemSerials).filter(Boolean).join('; '),
          a.allotment_date ? new Date(a.allotment_date).toLocaleDateString('en-GB') : '',
          a.return_due_date ? new Date(a.return_due_date).toLocaleDateString('en-GB') : '',
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
  if (a4Intercept(header, rows, filename)) return;
  const q = v => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [header, ...rows].map(r => r.map(q).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function openExportWizard({ title, statusOptions, statusField, dateField, dateLabel, personOptions, personField, withTypeFilter, getRows, onConfirm }) {
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
      <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px;">${getRows().length} record(s) match the filters currently applied on this page. The options below narrow it further.</p>
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${withTypeFilter ? `
        <label style="font-size:13px;color:#64748b;">What to export</label>
        <select name="kind" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="both">Both (spare parts + demo products)</option>
          <option value="spare">Spare parts only</option>
          <option value="demo">Demo products only</option>
        </select>` : ''}
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

  a4WizardPrint(modal, title);
  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  modal.querySelector('#exportWizardForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = fd.get('status');
    const person = fd.get('person');
    const kind = fd.get('kind') || 'both';
    const dateFrom = fd.get('dateFrom');
    const dateTo = fd.get('dateTo');

    const filtered = getRows().filter(row => {
      if (kind === 'spare' && row.allocation_type !== 'spare_part') return false;
      if (kind === 'demo' && row.allocation_type === 'spare_part') return false;
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
  requestId: '',          // technician spare_part request being fulfilled
  queue: [],              // part names still to allocate for that request
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
  allocWiz.requestId = '';
  allocWiz.queue = [];
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
    <input id="spSearch" placeholder="Search by name, username or role (e.g. Sales)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
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
    const list = users.filter(u => `${u.name || ''} ${u.username || ''} ${u.role || ''} ${roleLabel(u.role)}`.toLowerCase().includes(term));
    if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No users found.</small>'; return; }
    resultsBox.innerHTML = list.map(u => `
      <div class="sp-row" data-username="${u.username}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong>${u.name || u.username}</strong>
          <span style="font-size:11px;font-weight:600;color:#1665ff;background:#eef3fb;border-radius:999px;padding:2px 10px;">${roleLabel(u.role)}</span>
        </div>
        <small style="color:#64748b;">${u.username}</small>
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
    <div id="allocSerialSearch" style="margin-bottom:6px;"></div>
    <div id="allocSerialMsg" style="font-size:12px;color:#16a34a;margin-bottom:8px;"></div>
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
  window.serialSearchWidget(document.getElementById('allocSerialSearch'), (r) => {
    const key = `${r.product_id}||${r.product_name || ''}||${r.model_no || ''}`;
    const choices = allocWiz.serialChoices[key] || (allocWiz.serialChoices[key] = []);
    if (allocWiz.cart[key] && choices.includes(r.serial_number)) { document.getElementById('allocSerialMsg').textContent = r.serial_number + ' is already added.'; return; }
    const prev = allocWiz.cart[key]?.quantity || 0;
    choices.forEach((c, i) => { if (c === r.serial_number) choices[i] = ''; });
    choices[prev] = r.serial_number;
    allocWiz.cart[key] = { product_id: r.product_id, product_name: r.product_name, model_no: r.model_no || '', quantity: prev + 1 };
    document.getElementById('allocSerialMsg').textContent = `Added ${r.serial_number} - ${r.product_name} (qty ${prev + 1})`;
    renderRows(products);
  });
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
    const usedSerials = new Set(existingChoices.filter(Boolean));
    const serialPool = available.filter(sn => !usedSerials.has(sn));
    let poolIdx = 0;
    for (let slot = 0; slot < slots; slot++) {
      const pinnedSerial = existingChoices[slot];
      const chosen = pinnedSerial || serialPool[poolIdx++] || '';
      html += `
        <div style="margin-top:8px;">
          <label style="font-size:12px;color:#64748b;">Unit ${slot + 1} serial number${pinnedSerial ? '' : ' (auto)'}</label>
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

// ----- Part allocation flow (against a service) -----
// Step 1: ALL services are listed (any status) with a search box.
// Step 2: every inventory item except "product" (spare parts, service parts, accessories) can be picked.
//   - a lot that has hologram numbers -> choose the exact hologram number(s) to give
//   - a lot without hologram numbers  -> choose the quantity to give
// The server deducts exactly what was chosen and records the allocation against that service.
async function renderActiveServicesStep() {
  const body = allocModalBody();
  allocWizTitle('Select Service');
  body.innerHTML = `<p style="color:#94a3b8;">Loading services...</p>`;
  try {
    const res = await apiFetch('/service/');
    if (!res.ok) throw new Error('failed to fetch services');
    const data = await res.json();
    const list = (data.dataset || []).slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const statusOf = s => String(s.status || s.service_status || '').replace(/_/g, ' ');

    body.innerHTML = `
      <input id="svcSearch" placeholder="Search by product, serial, issue, status or service ID..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;margin-bottom:10px;">
      <div id="svcList" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
      <div style="margin-top:14px;">
        <button type="button" id="backAllocType2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      </div>`;
    document.getElementById('backAllocType2').addEventListener('click', renderAllocTypeStep);

    const svcList = document.getElementById('svcList');
    const searchEl = document.getElementById('svcSearch');
    const draw = () => {
      const term = searchEl.value.trim().toLowerCase();
      const rows = list.filter(s => !term || [s.service_id, s.product_id, s.product_name, s.model_no, s.serial_no, s.issue, statusOf(s), s.company_name]
        .join(' ').toLowerCase().includes(term));
      if (!rows.length) { svcList.innerHTML = `<small style="color:#94a3b8;">${list.length ? 'No service matches your search.' : 'No services found.'}</small>`; return; }
      svcList.innerHTML = rows.map(s => `
        <div class="svc-row" data-id="${esc(s.service_id)}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <strong>${esc(s.product_name || s.product_id || '')}</strong>
            <span style="font-size:11px;font-weight:600;color:#1665ff;background:#eef3fb;border-radius:999px;padding:2px 10px;text-transform:capitalize;">${esc(statusOf(s) || '-')}</span>
          </div>
          <small style="color:#64748b;">Serial: ${esc(s.serial_no || '-')} • #${esc((s.service_id || '').slice(0, 8))}</small><br>
          <small style="color:#64748b;">${esc(s.issue || '')}</small>
        </div>`).join('');
      svcList.querySelectorAll('.svc-row').forEach(row => row.addEventListener('click', () => {
        allocWiz.service = list.find(x => x.service_id === row.dataset.id);
        renderSparePartFormStep();
      }));
    };
    searchEl.addEventListener('input', draw);
    draw();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') body.innerHTML = '<small style="color:#d62828;">Could not load services.</small>';
  }
}

// Everything in inventory except plain products (and faulty/damaged stock) can be given to a service.
const ALLOC_PART_LABELS = { spare_parts: 'Spare Part', service_parts: 'Service Part', accessories: 'Accessory' };
const isPartType = p => !!ALLOC_PART_LABELS[p.product_type];
const holoCountOf = p => (typeof p.hologram_count === 'number' ? p.hologram_count
  : (Array.isArray(p.hologram_numbers) ? p.hologram_numbers.length : (p.hologram_no ? 1 : 0)));

// the list only carries hologram_count; the numbers themselves come from the lot detail
async function allocFetchLotDetail(p) {
  try {
    const params = new URLSearchParams({
      product_id: p.product_id || '', model_no: p.model_no || '', product_type: p.product_type || '', lot_id: p._id || ''
    });
    const res = await apiFetch(`/inventory/detail?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (p._id && data.product && data.product._id && data.product._id !== p._id) return null;
    return { ...p, ...data.product };
  } catch (e) { console.error(e); return null; }
}
async function allocLotHolograms(lot) {
  const out = [];
  const seen = new Set();
  const details = await Promise.all(lot.docs.filter(d => holoCountOf(d) > 0).map(allocFetchLotDetail));
  details.forEach(d => {
    if (!d) return;
    const arr = Array.isArray(d.hologram_numbers) ? d.hologram_numbers : (d.hologram_no ? [d.hologram_no] : []);
    arr.forEach(h => { const k = String(h).trim(); if (k && !seen.has(k)) { seen.add(k); out.push({ no: k, lot_id: d._id || '' }); } });
  });
  return out;
}

async function renderSparePartFormStep() {
  const svc = allocWiz.service || {};
  const body = allocModalBody();
  allocWizTitle(`Allocate to Service #${(svc.service_id || '').slice(0, 8)}`);
  body.innerHTML = `<p style="color:#94a3b8;">Loading inventory...</p>`;
  await loadInventoryForAllocation();

  // one lot per inventory document (spare/service parts each have their own lot id)
  const lotMap = new Map();
  (allocState.products || []).filter(p => isPartType(p) && (Number(p.quantity) || 0) > 0).forEach(p => {
    const k = String(p._id || `${p.product_id}||${p.product_name}||${p.model_no}`);
    lotMap.set(k, {
      key: k, product_id: p.product_id, type: p.product_type, name: p.product_name || '', model: p.model_no || '',
      parent: p.parent_product_name || '', stock: Number(p.quantity) || 0, tagged: holoCountOf(p), docs: [p]
    });
  });
  const lots = [...lotMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const svcNames = [svc.product_name, svc.product_id].filter(Boolean).map(x => String(x).trim().toLowerCase());
  const forService = l => !!l.parent && svcNames.includes(l.parent.trim().toLowerCase());
  const hasMatches = lots.some(forService);

  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      Product: ${esc(svc.product_name || svc.product_id || '')} • Serial: ${esc(svc.serial_no || '')}<br>
      Issue: ${esc(svc.issue || '')}
    </div>
    ${allocWiz.requestId && allocWiz.queue.length ? `<div style="background:#eef5ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;color:#1e3a8a;">
      Technician requested: <b>${allocWiz.queue.map(esc).join(', ')}</b>. The item is pre-selected — just choose the hologram number(s).</div>` : ''}
    <form id="sparePartForm">
      <div style="font-size:12px;font-weight:600;color:#334155;margin-bottom:4px;">1. Select item <small style="font-weight:400;color:#94a3b8;">(spare parts, service parts, accessories)</small></div>
      <div style="display:flex;gap:8px;">
        <input id="spFilter" placeholder="Search item..." style="flex:1;width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;min-width:0;">
      </div>
      ${hasMatches ? `<label style="display:flex;align-items:center;justify-content:flex-start;gap:6px;font-size:12px;color:#475569;margin:8px 0;"><input type="checkbox" id="spOnlyFor" style="width:auto;margin:0;"> Only items that belong to this product</label>` : '<div style="height:8px;"></div>'}
      <div id="spList" style="max-height:180px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;"></div>

      <div id="spHoloBox" style="display:none;margin-top:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:600;color:#334155;">2. Choose hologram number(s)</span>
          <span id="spHoloInfo" style="font-size:12px;color:#64748b;"></span>
        </div>
        <input id="spHoloSearch" placeholder="Search hologram number..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">
        <div style="display:flex;gap:8px;margin:8px 0;">
          <button type="button" id="spSelShown" style="padding:5px 10px;border:none;border-radius:6px;background:#e2e8f0;cursor:pointer;font-size:12px;">Select shown</button>
          <button type="button" id="spClear" style="padding:5px 10px;border:none;border-radius:6px;background:#e2e8f0;cursor:pointer;font-size:12px;">Clear</button>
        </div>
        <div id="spHoloList" style="max-height:170px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:8px;display:flex;flex-wrap:wrap;gap:6px;"></div>
      </div>

      <div id="spQtyBox" style="display:none;margin-top:14px;">
        <span style="font-size:12px;font-weight:600;color:#334155;">2. Quantity to give</span>
        <small id="spQtyInfo" style="margin-left:8px;color:#64748b;"></small>
        <input id="spQty" type="number" min="1" value="1" style="width:100%;margin-top:4px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
          <span style="font-size:12px;font-weight:600;color:#334155;">3. Hologram numbers <small style="font-weight:400;color:#94a3b8;">(optional — type or edit, one per line or comma separated)</small></span>
          <span id="spManualInfo" style="font-size:12px;color:#64748b;"></span>
        </div>
        <textarea id="spManual" rows="3" placeholder="e.g. HG-1001, HG-1002" style="width:100%;margin-top:4px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;font-family:inherit;"></textarea>
      </div>

      <div id="spPicked" style="font-size:13px;color:#64748b;margin:10px 0 0;">Select an item to allocate.</div>
      <div style="display:flex;justify-content:space-between;margin-top:14px;">
        <button type="button" id="backSpare" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" id="spSubmit" disabled style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;opacity:.5;">Allocate</button>
      </div>
    </form>`;
  document.getElementById('backSpare').addEventListener('click', () => {
    if (allocWiz.requestId) { document.getElementById('allocateModal').style.display = 'none'; resetAllocWiz(); }
    else renderActiveServicesStep();
  });

  const $ = id => document.getElementById(id);
  const listEl = $('spList'), pickedEl = $('spPicked'), submitEl = $('spSubmit');
  const filterEl = $('spFilter'), onlyEl = $('spOnlyFor');
  const holoBox = $('spHoloBox'), holoList = $('spHoloList'), holoSearch = $('spHoloSearch'), holoInfo = $('spHoloInfo');
  const qtyBox = $('spQtyBox'), qtyEl = $('spQty'), qtyInfo = $('spQtyInfo');
  const manualEl = $('spManual'), manualInfo = $('spManualInfo');
  const manualList = () => [...new Set(manualEl.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))];
  let sel = null, holos = [], chosen = new Set();
  const holoCache = new Map();
  const byHologram = () => !!sel && sel.tagged > 0;
  const qtyValue = () => Math.max(0, Math.min(Math.floor(Number(qtyEl.value) || 0), sel ? sel.stock : 0));

  function updateSummary() {
    let n = 0;
    if (sel) n = byHologram() ? chosen.size : qtyValue();
    holoInfo.textContent = `${chosen.size} selected / ${holos.length} available`;
    { const m = manualList().length; manualInfo.textContent = m ? `${m} number${m === 1 ? '' : 's'}${sel && m > qtyValue() ? ' — more than quantity' : ''}` : ''; }
    if (!sel) pickedEl.textContent = 'Select an item to allocate.';
    else if (byHologram()) pickedEl.innerHTML = `Giving <b>${n}</b> × <b>${esc(sel.name)}</b>${sel.model ? ' · ' + esc(sel.model) : ''}${n ? ' — ' + [...chosen].slice(0, 6).map(esc).join(', ') + (n > 6 ? ` +${n - 6} more` : '') : ''}`;
    else pickedEl.innerHTML = `Giving <b>${n}</b> × <b>${esc(sel.name)}</b>${sel.model ? ' · ' + esc(sel.model) : ''}`;
    submitEl.disabled = !n; submitEl.style.opacity = n ? '1' : '.5';
  }
  function drawHolos() {
    const term = holoSearch.value.trim().toLowerCase();
    const rows = holos.filter(h => !term || h.no.toLowerCase().includes(term));
    holoList.innerHTML = rows.length ? rows.map(h => `
      <label data-h="${esc(h.no)}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid ${chosen.has(h.no) ? '#2563eb' : '#e2e8f0'};background:${chosen.has(h.no) ? '#eff6ff' : '#fff'};">
        <input type="checkbox" ${chosen.has(h.no) ? 'checked' : ''} style="margin:0;"> ${esc(h.no)}
      </label>`).join('')
      : `<span style="font-size:12px;color:#94a3b8;">${holos.length ? 'No hologram number matches your search.' : 'No hologram numbers on file for this item.'}</span>`;
    holoList.querySelectorAll('label[data-h]').forEach(l => l.querySelector('input').addEventListener('change', e => {
      const h = l.dataset.h;
      if (e.target.checked) chosen.add(h); else chosen.delete(h);
      drawHolos(); updateSummary();
    }));
    holoList._shown = rows;
  }
  async function pick(key) {
    sel = lotMap.get(key) || null;
    chosen = new Set(); holos = []; holoSearch.value = ''; manualEl.value = '';
    drawLots();
    holoBox.style.display = 'none'; qtyBox.style.display = 'none';
    if (!sel) { updateSummary(); return; }
    if (!byHologram()) {
      qtyBox.style.display = 'block';
      qtyEl.max = sel.stock; qtyEl.value = 1;
      qtyInfo.textContent = `${sel.stock} in stock`;
      updateSummary();
      return;
    }
    holoBox.style.display = 'block';
    holoList.innerHTML = '<span style="font-size:12px;color:#94a3b8;">Loading hologram numbers...</span>';
    updateSummary();
    if (!holoCache.has(key)) holoCache.set(key, await allocLotHolograms(sel));
    if (!sel || sel.key !== key) return;       // user picked something else meanwhile
    holos = holoCache.get(key);
    drawHolos(); updateSummary();
  }
  function drawLots() {
    const term = filterEl.value.trim().toLowerCase();
    const only = onlyEl && onlyEl.checked;
    const rows = lots.filter(l => (!only || forService(l)) && 
      (!term || [l.name, l.model, l.parent, l.product_id, ALLOC_PART_LABELS[l.type]].join(' ').toLowerCase().includes(term)));
    if (!rows.length) {
      listEl.innerHTML = `<p style="padding:14px;color:#94a3b8;font-size:13px;">${lots.length ? 'No item matches.' : 'No spare parts, service parts or accessories in inventory.'}</p>`;
      return;
    }
    listEl.innerHTML = rows.map(l => `
      <div class="sp-row" data-key="${esc(l.key)}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;${sel && sel.key === l.key ? 'background:#eff6ff;' : ''}">
        <div>
          <strong style="font-size:13px;">${esc(l.name)}</strong>${l.model ? ` <small style="color:#64748b;">· ${esc(l.model)}</small>` : ''}
          <small style="color:#1665ff;"> · ${esc(ALLOC_PART_LABELS[l.type])}</small>
          ${l.parent ? `<br><small style="color:#94a3b8;">Belongs to: ${esc(l.parent)}</small>` : ''}
        </div>
        <span style="font-size:12px;font-weight:600;white-space:nowrap;color:${l.tagged ? '#16a34a' : '#64748b'};">${l.tagged ? `${l.tagged} hologram${l.tagged === 1 ? '' : 's'}` : `Qty ${l.stock}`}</span>
      </div>`).join('');
    listEl.querySelectorAll('.sp-row').forEach(r => r.addEventListener('click', () => pick(r.dataset.key)));
  }
  filterEl.addEventListener('input', drawLots);
  if (onlyEl) onlyEl.addEventListener('change', drawLots);
  holoSearch.addEventListener('input', drawHolos);
  qtyEl.addEventListener('input', updateSummary);
  manualEl.addEventListener('input', () => {
    const n = manualList().length;
    if (n && sel) qtyEl.value = Math.min(n, sel.stock);   // quantity follows the numbers typed
    updateSummary();
  });
  $('spSelShown').addEventListener('click', () => {
    const shown = holoList._shown || [];
    if (shown.length > 25 && !confirm(`Select all ${shown.length} shown hologram numbers?`)) return;
    shown.forEach(h => chosen.add(h.no)); drawHolos(); updateSummary();
  });
  $('spClear').addEventListener('click', () => { chosen.clear(); drawHolos(); updateSummary(); });
  drawLots(); updateSummary();

  // opened from a technician's request: pre-add the requested part
  if (allocWiz.requestId && allocWiz.queue.length) {
    const want = String(allocWiz.queue[0]).trim().toLowerCase();
    const hit = lots.find(l => l.name.trim().toLowerCase() === want) || lots.find(l => l.name.toLowerCase().includes(want) || want.includes(l.name.toLowerCase()));
    if (hit) { filterEl.value = hit.name; drawLots(); pick(hit.key); }
    else { filterEl.value = allocWiz.queue[0]; drawLots(); pickedEl.innerHTML = `<span style="color:#d62828;">"${esc(allocWiz.queue[0])}" was not found in stock — search and pick the closest item.</span>`; }
  }

  $('sparePartForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!sel) { alert('Select an item to allocate.'); return; }
    const part = sel;
    const withHolo = byHologram();
    const picked = withHolo ? holos.filter(h => chosen.has(h.no)) : [];
    const quantity = withHolo ? picked.length : qtyValue();
    if (!quantity) { alert(withHolo ? 'Select the hologram number(s) to give.' : 'Enter a valid quantity.'); return; }
    if (!withHolo && manualList().length > quantity) { alert('You typed more hologram numbers than the quantity. Increase the quantity or remove some numbers.'); return; }
    submitEl.disabled = true; submitEl.textContent = 'Allocating...';
    const payload = {
      spare_part: {
        service_id: svc.service_id,
        part_name: part.name,
        quantity,
        product_id: part.product_id,
        model_no: part.model,
        product_type: part.type,
        lot_id: part.docs[0]?._id || '',
        hologram_numbers: picked.map(h => h.no),
        holograms: picked.map(h => ({ hologram_number: h.no, lot_id: h.lot_id })),
        request_id: allocWiz.requestId || '',
        manual_holograms: withHolo ? [] : manualList()
      }
    };
    try {
      const res = await apiFetch('/allocation/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'allocation failed');
      // confirm those exact hologram numbers left inventory
      let stillThere = [];
      if (withHolo) {
        await loadInventoryForAllocation();
        const lotsTouched = part.docs.filter(d => picked.some(h => h.lot_id === d._id));
        const fresh = await Promise.all(lotsTouched.map(allocFetchLotDetail));
        const left = new Set(picked.map(h => h.no));
        fresh.forEach(d => { if (d) (Array.isArray(d.hologram_numbers) ? d.hologram_numbers : []).forEach(h => { if (left.has(String(h).trim())) stillThere.push(h); }); });
      }
      if (stillThere.length) alert(`Allocated, but these hologram numbers are still in inventory: ${stillThere.slice(0, 10).join(', ')}${stillThere.length > 10 ? '…' : ''}. Please check the deduction on the server.`);
      if (allocWiz.requestId && allocWiz.queue.length > 1) {   // more requested parts left for this request
        allocWiz.queue.shift();
        return renderSparePartFormStep();
      }
      resetAllocWiz();
      window.location.href = data.redirect || 'service.html';
    } catch (err) {
      submitEl.disabled = false; submitEl.textContent = 'Allocate';
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}