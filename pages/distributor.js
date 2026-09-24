const spState = { allocations: [], products: [], myRequests: [], rows: [], statusFilter: '' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let spPage = 1;
const SP_PAGE_SIZE = 50;

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
  loadMyAllocations();
  loadMyRequests();
  loadInventoryForDemo();
  wireFilter();
  injectAllotModal();
});

async function loadMyAllocations() {
  try {
    const res = await apiFetch('/allocation/mine');
    if (!res.ok) throw new Error('failed to fetch allocations');
    const data = await res.json();
    const mine = data.dataset || [];

    let team = [];
    let teamAllocations = [];
    try {
      const [teamRes, teamAllocRes] = await Promise.all([
        apiFetch('/account/my_team'),
        apiFetch('/allocation/team')
      ]);
      if (teamRes.ok) team = (await teamRes.json()).dataset || [];
      if (teamAllocRes.ok) teamAllocations = (await teamAllocRes.json()).dataset || [];
    } catch (teamErr) {
      console.error('could not fetch team allocations', teamErr);
    }

    spState.teamMemberMap = {};
    team.forEach(m => { spState.teamMemberMap[m.username] = m; });

    const seen = new Set(mine.map(a => a.allocation_id));
    const merged = [...mine];
    teamAllocations.forEach(a => {
      if (!seen.has(a.allocation_id)) { merged.push(a); seen.add(a.allocation_id); }
    });

    spState.allocations = merged.slice().reverse();
    spPage = 1;
    renderWelcome();
    refreshView();
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your demo units.');
  }
}

function creatorLabel(username) {
  if (!username) return '-';
  if (username === getUsername()) return `${username} (You)`;
  const member = spState.teamMemberMap && spState.teamMemberMap[username];
  return member ? `${member.name ?? username}` : username;
}

function renderWelcome() {
  const uname = getUsername() || 'Sales Person';
  const welcomeEl = document.getElementById('welcomeText');
  if (welcomeEl) welcomeEl.textContent = `Welcome Back, ${uname}`;
  const dateEl = document.getElementById('todayDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function loadInventoryForDemo() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) throw new Error('failed to fetch inventory');
    const data = await res.json();
    spState.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

function returnMeta(a) {
  if (a.return_status === 'returned') return { label: 'Returned', cls: 'high', overdue: false };
  const msLeft = new Date(a.return_due_date) - new Date();
  if (msLeft <= 0) return { label: 'Overdue', cls: 'low', overdue: true };
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  return { label: `${daysLeft}d left`, cls: daysLeft <= 2 ? 'medium' : 'high', overdue: false };
}

// One table row per allocated unit, plus one row per request still waiting
// for (or refused at) approval.
function rebuildRows() {
  const reqRows = spState.myRequests
    .filter(r => r.request_type === 'demo_unit' && (r.status === 'pending' || r.status === 'rejected'))
    .map(r => ({ kind: 'req', id: r.request_id, date: r.created_at, data: r }));
  const allocRows = spState.allocations.map(a => ({ kind: 'alloc', id: a.allocation_id, date: a.allotment_date || a.created_at, data: a }));
  spState.rows = [...reqRows, ...allocRows];
}

function refreshView() {
  rebuildRows();
  renderCards();
  renderTable(filteredRows());
}

// Lifecycle: Under Approval -> Approved -> Processing (sent to dispatch) -> Dispatched
function rowStatus(row) {
  if (row.kind === 'req') {
    return row.data.status === 'rejected'
      ? { key: 'rejected', label: 'Rejected', cls: 'low' }
      : { key: 'under_approval', label: 'Under Approval', cls: 'medium' };
  }
  const a = row.data;
  if (a.return_status === 'returned') return { key: 'returned', label: 'Returned', cls: 'high' };
  if (a.return_request && a.return_request.status === 'pending') return { key: 'return_pending', label: 'Return Pending Approval', cls: 'medium' };
  if (a.convert_request && a.convert_request.status === 'pending') return { key: 'convert_pending', label: 'Order Request Pending', cls: 'medium' };
  if (a.dispatch) return returnMeta(a).overdue
    ? { key: 'overdue', label: 'Dispatched · Overdue', cls: 'low' }
    : { key: 'dispatched', label: 'Dispatched', cls: 'high' };
  if (a.sent_to_dispatch) return { key: 'processing', label: 'Processing', cls: 'medium' };
  return { key: 'approved', label: 'Approved', cls: 'medium' };
}

function renderCards() {
  const allocations = spState.allocations;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('cardTotal', allocations.length);
  set('cardNotReturned', allocations.filter(a => a.return_status !== 'returned').length);
  set('cardOverdue', spState.rows.filter(r => rowStatus(r).key === 'overdue').length);
  set('cardPendingRequests', spState.rows.filter(r => r.kind === 'req' && r.data.status === 'pending').length);
  set('cardRejectedRequests', spState.rows.filter(r => r.kind === 'req' && r.data.status === 'rejected').length);
}

function filteredRows() {
  const f = spState.statusFilter;
  return f ? spState.rows.filter(r => rowStatus(r).key === f) : spState.rows;
}

function itemsLabel(items) {
  return (items || []).map(i => `${esc(i.product_name)} x${i.quantity}${i.serial_numbers?.length ? ` <small style="color:#94a3b8;">(${esc(i.serial_numbers.join(', '))})</small>` : ''}`).join(', ');
}

function renderTable(rows) {
  const sorted = [...rows].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / SP_PAGE_SIZE));
  spPage = Math.min(Math.max(1, spPage), totalPages);
  const start = (spPage - 1) * SP_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + SP_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';
  if (!pageRows.length) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#94a3b8;">No demo units yet.</td></tr>';

  pageRows.forEach(row => {
    const st = rowStatus(row);
    const isReq = row.kind === 'req';
    const d = row.data;
    const creator = isReq ? d.raised_by : d.allocated_by;
    const remarks = isReq ? d.details?.remarks : d.remarks;
    const tr = document.createElement('tr');
    tr.dataset.key = `${row.kind}:${row.id}`;
    tr.innerHTML = `
      <td>${esc(creatorLabel(creator))}</td>
      <td>Demo</td>
      <td>${remarks ? esc(remarks) : '-'}</td>
      <td>${itemsLabel(isReq ? d.details?.items : d.items)}</td>
      <td>${row.date ? new Date(row.date).toLocaleDateString('en-GB') : '-'}</td>
      <td>${!isReq && d.return_due_date ? new Date(d.return_due_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="stock ${st.cls}">${st.label}</span></td>
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        ${rowActionsExtra(row, st)}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', e => openViewModal(rowFromEvent(e))));
  wireRowActions(tbody);

  renderTablePagination(document.querySelector('.pagination'), spPage, totalPages, p => {
    spPage = p;
    renderTable(rows);
  });
}

// hooks filled in by the convert-to-order step
// Convert / Return buttons are always visible on demo-unit rows; they are only clickable once the unit is dispatched
// (and no other request for it is pending).
function actionBtn(cls, icon, label, enabled, title, color) {
  return `<button class="${cls}" ${enabled ? '' : 'disabled'} title="${title}"
    style="margin-left:6px;padding:6px 10px;border:none;border-radius:8px;font-size:12px;white-space:nowrap;
    background:${enabled ? color : '#e5e7eb'};color:${enabled ? '#fff' : '#94a3b8'};cursor:${enabled ? 'pointer' : 'not-allowed'};">
    <i class="fa-solid ${icon}"></i> ${label}</button>`;
}

function rowActionsExtra(row, st) {
  if (row.kind !== 'alloc' || st.key === 'returned') return '';
  const enabled = st.key === 'dispatched' || st.key === 'overdue';
  const hint = st.key === 'convert_pending' ? 'Order request already sent'
    : st.key === 'return_pending' ? 'Return request already sent' : 'Available after dispatch';
  return actionBtn('convert-btn', 'fa-file-invoice-dollar', st.key === 'convert_pending' ? 'Request Sent' : 'Convert to Order', enabled, enabled ? 'Convert to Order' : hint, '#1665ff')
    + actionBtn('return-btn', 'fa-rotate-left', st.key === 'return_pending' ? 'Return Sent' : 'Return', enabled, enabled ? 'Request return' : hint, '#f59e0b');
}
function wireRowActions(tbody) {
  tbody.querySelectorAll('.convert-btn:not([disabled])').forEach(b => b.addEventListener('click', e => openConvertModal(rowFromEvent(e))));
  tbody.querySelectorAll('.return-btn:not([disabled])').forEach(b => b.addEventListener('click', e => openReturnModal(rowFromEvent(e))));
}

// ---------- Return a dispatched demo unit (needs admin approval; marked returned once approved) ----------
function openReturnModal(row) {
  if (!row || row.kind !== 'alloc') return;
  const a = row.data;
  const modal = document.getElementById('allotModal');
  const body = wizBody();
  wizTitle('Return Demo Unit');
  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">${itemsLabel(a.items)}</div>
    <form id="returnForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="returned_through" placeholder="Returned through (courier / transport / person name)" required>
      <label style="font-size:12px;color:#64748b;margin-bottom:-6px;">Proof of return (optional — image or PDF, max 1.5 MB)</label>
      <input name="proof" type="file" accept="image/*,application/pdf">
      <p style="font-size:12px;color:#94a3b8;">Sent to admin for approval. The unit is marked returned once approved.</p>
      <div style="display:flex;justify-content:space-between;margin-top:6px;">
        <button type="button" id="returnCancel" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#f59e0b;color:#fff;cursor:pointer;">Send Return Request</button>
      </div>
    </form>`;
  document.getElementById('returnCancel').addEventListener('click', () => modal.style.display = 'none');
  document.getElementById('returnForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const file = fd.get('proof');
    const payload = { returned_through: fd.get('returned_through').trim(), proof: {} };
    try {
      if (file && file.size) {
        if (file.size > 1.5 * 1024 * 1024) { alert('Proof file is too large (max 1.5 MB).'); return; }
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('could not read the proof file'));
          r.readAsDataURL(file);
        });
        payload.proof = { name: file.name, type: file.type, data };
      }
      const res = await apiFetch(`/allocation/return_request/${a.allocation_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      modal.style.display = 'none';
      alert('Return request sent — admin will review and approve it.');
      await loadMyAllocations();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}

// ---------- Convert a dispatched demo unit into an order (needs admin approval) ----------
function openConvertModal(row) {
  if (!row || row.kind !== 'alloc') return;
  const a = row.data;
  const modal = document.getElementById('allotModal');
  const body = wizBody();
  wizTitle('Convert to Order');
  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">${itemsLabel(a.items)}</div>
    <form id="convertForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company Name" required>
      <input name="company_address" placeholder="Company Address" required>
      <input name="gst_number" placeholder="GST Number (optional)">
      <input name="price" type="number" min="1" step="0.01" placeholder="Price per unit (₹)" required>
      <input name="tax_rate" type="number" min="0" step="0.01" placeholder="Tax rate % (optional)">
      <p style="font-size:12px;color:#94a3b8;">Sent to admin for approval. Once approved this unit moves to My Orders.</p>
      <div style="display:flex;justify-content:space-between;margin-top:6px;">
        <button type="button" id="convertCancel" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
      </div>
    </form>`;
  document.getElementById('convertCancel').addEventListener('click', () => modal.style.display = 'none');
  document.getElementById('convertForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'), company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number') || '', price: Number(fd.get('price')), tax_rate: Number(fd.get('tax_rate')) || 0
    };
    try {
      const res = await apiFetch(`/allocation/convert_to_order/${a.allocation_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      modal.style.display = 'none';
      alert('Order request sent — admin will review and approve it.');
      await loadMyAllocations();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}

function rowFromEvent(e) {
  const key = e.target.closest('tr').dataset.key;
  return spState.rows.find(r => `${r.kind}:${r.id}` === key);
}

function detailRow(label, value) {
  return `<div class="detail"><small>${label}</small><p>${value}</p></div>`;
}

// Same layout as the order details modal on the Orders page.
function openViewModal(row) {
  if (!row) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  content.style.maxHeight = '86vh';
  content.style.overflowY = 'auto';
  const st = rowStatus(row);
  const d = row.data;
  const isReq = row.kind === 'req';
  const items = (isReq ? d.details?.items : d.items) || [];
  const cr = (!isReq && d.convert_request && d.convert_request.status === 'pending') ? d.convert_request : null;
  const crRejected = (!isReq && d.convert_request && d.convert_request.status === 'rejected') ? d.convert_request : null;
  const rr = (!isReq && d.return_request) ? d.return_request : null;

  const itemRows = items.length ? items.map(i => `<tr>
      <td>${esc(i.product_name)}</td>
      <td>${esc((i.serial_numbers || []).join(', ')) || '-'}</td>
      <td>${i.quantity ?? 0}</td>
      <td>${cr ? '₹' + (cr.price ?? 0) : '-'}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No items</td></tr>';

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${isReq ? 'Demo Unit Request' : 'Demo Unit Details'}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${detailRow(isReq ? 'Request ID' : 'Allocation ID', esc(row.id))}
    ${detailRow('Requested By', esc(creatorLabel(isReq ? d.raised_by : d.allocated_by)))}
    ${cr ? detailRow('Company', esc(cr.customer?.company_name || '-')) + detailRow('Address', esc(cr.customer?.company_address || '-')) : ''}
    <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Serial No.</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${detailRow('Remarks', esc((isReq ? d.details?.remarks : d.remarks) || '-'))}
    ${detailRow('Status', st.label)}`;

  if (isReq) {
    html += detailRow('Requested On', row.date ? new Date(row.date).toLocaleString() : '-');
    if (d.status === 'rejected') html += detailRow('Rejection Reason', esc(d.reason || '-'));
  } else {
    if (crRejected) html += detailRow('Order Request Rejected', esc(crRejected.reason || '-'));
    if (rr) {
      html += detailRow('Returned Through', esc(rr.returned_through || '-'));
      if (rr.status === 'rejected') html += detailRow('Return Request Rejected', esc(rr.reason || '-'));
    }
    html += detailRow('Allotment Date', d.allotment_date ? new Date(d.allotment_date).toLocaleString() : '-');
    html += detailRow('Return Due', d.return_due_date ? new Date(d.return_due_date).toLocaleString() : '-');
    if (d.dispatch) {
      const x = d.dispatch;
      html += detailRow('Docket No.', esc(x.docket_no || '-'))
        + detailRow('Invoice No. / Date', `${esc(x.invoice_no || '-')} / ${esc(x.invoice_date || '-')}`)
        + detailRow('Mode of Delivery', esc(x.mode_of_delivery || '-'));
    }
  }

  content.innerHTML = html;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    spState.statusFilter = document.getElementById('statusFilter').value;
    spPage = 1;
    renderTable(filteredRows());
  });
}

// ---------- Allot Demo Unit wizard ----------
const spWiz = { cart: {}, remarks: '' };

function resetSpWiz() {
  spWiz.cart = {};
  spWiz.remarks = '';
}

function injectAllotModal() {
  const modal = document.getElementById('allotModal');
  const btn = document.querySelector('.top-actions .add-product');
  if (btn) btn.addEventListener('click', () => {
    resetSpWiz();
    modal.style.display = 'flex';
    renderProductsStep();
  });
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

function wizBody() {
  const modal = document.getElementById('allotModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="wizTitle">Request Demo Unit</h3>
      <button type="button" id="wizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div id="wizStepBody"></div>`;
  content.querySelector('#wizClose').addEventListener('click', () => modal.style.display = 'none');
  return document.getElementById('wizStepBody');
}
function wizTitle(t) { document.getElementById('wizTitle').textContent = t; }

// Multiple inventory entries can share the same product_id (e.g. separate
// batches/lots). Showing them as separate rows would let the person type into
// two different rows for "the same" product — since the cart used to be keyed
// by product_id alone, only the last one edited would actually stick. Collapse
// them into a single row per product+model instead.
// A row is only "the same product" when product_id + product_name + model_no
// ALL match — if even one differs, it's a different, independent product and
// gets its own row and its own cart line. (Same rule as the Create Order
// product picker in distributor_orders.js.)
function rowKeyFor(p) { return `${p.product_id}||${p.product_name || ''}||${p.model_no || ''}`; }

function dedupeProducts(rawProducts) {
  const map = new Map();
  for (const p of rawProducts) {
    const key = rowKeyFor(p);
    if (!map.has(key)) map.set(key, { ...p });
  }
  return Array.from(map.values());
}

function renderProductsStep() {
  const body = wizBody();
  wizTitle('Request Demo Unit');
  const products = dedupeProducts(spState.products || []);
  body.innerHTML = `
    <div id="prodCatTabs" style="display:flex;gap:8px;margin-bottom:10px;"></div>
    <input id="prodFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Stock</th><th style="width:70px;">Qty</th></tr></thead>
        <tbody id="prodRows"></tbody>
      </table>
    </div>
    <textarea id="demoRemarks" rows="2" placeholder="Remarks (optional)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-top:10px;resize:vertical;">${esc(spWiz.remarks)}</textarea>
    <p style="font-size:12px;color:#94a3b8;margin-top:8px;">Return window: 7 days from allotment date.</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backCart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
      <button type="button" id="allotBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;
  document.getElementById('backCart').addEventListener('click', () => { document.getElementById('allotModal').style.display = 'none'; });
  document.getElementById('demoRemarks').addEventListener('input', e => { spWiz.remarks = e.target.value; });

  // ---------- Category tabs: Products / Accessories / Spare Parts ----------
  // Filters the same product table by product_type — same pattern used on
  // the Create Order product picker, the admin Orders page and Inventory.
  const catTabsBox = document.getElementById('prodCatTabs');
  const categories = [
    { type: 'product', label: 'Products' },
    { type: 'accessories', label: 'Accessories' },
    { type: 'spare_parts', label: 'Spare Parts' }
  ];
  let activeCategory = 'product';

  function paintCatTab(btn, active) {
    btn.style.border = active ? '1px solid #1665ff' : '1px solid #e2e8f0';
    btn.style.background = active ? '#eaf1ff' : '#f8fafc';
    btn.style.color = active ? '#1665ff' : '#334155';
    btn.style.borderRadius = '8px';
    btn.style.padding = '8px 14px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
  }

  catTabsBox.innerHTML = categories.map(c => `<button type="button" class="prod-cat-btn" data-type="${c.type}">${c.label}</button>`).join('');
  catTabsBox.querySelectorAll('.prod-cat-btn').forEach(btn => {
    paintCatTab(btn, btn.dataset.type === activeCategory);
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.type;
      catTabsBox.querySelectorAll('.prod-cat-btn').forEach(b => paintCatTab(b, b.dataset.type === activeCategory));
      applyFilters();
    });
  });

  const rowsBox = document.getElementById('prodRows');
  function productRowHtml(p) {
    const key = rowKeyFor(p);
    const qtyInCart = spWiz.cart[key]?.quantity ?? '';
    return `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}${p.model_no ? ' — ' + p.model_no : ''}</small></td>
        <td>${p.quantity ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${qtyInCart}"
              data-row-key="${key}" class="qtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`;
  }
  function renderRows(list) { rowsBox.innerHTML = list.map(productRowHtml).join(''); }

  rowsBox.addEventListener('input', (e) => {
    const inp = e.target.closest('.qtyInput');
    if (!inp) return;
    const key = inp.dataset.rowKey;
    const p = products.find(x => rowKeyFor(x) === key);
    if (!p) return;
    const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
    inp.value = qty;
    if (qty > 0) spWiz.cart[key] = { product_id: p.product_id, product_name: p.product_name, model_no: p.model_no || '', quantity: qty };
    else delete spWiz.cart[key];
  });

  function currentCategoryProducts() {
    return products.filter(p => (p.product_type || 'product') === activeCategory);
  }

  function applyFilters() {
    const term = document.getElementById('prodFilter').value.trim().toLowerCase();
    const base = currentCategoryProducts();
    const filtered = term
      ? base.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term) || (p.model_no || '').toLowerCase().includes(term))
      : base;
    renderRows(filtered);
  }

  applyFilters();
  if (!products.length) {
    rowsBox.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:16px;color:#94a3b8;">
      No products loaded. <button type="button" id="retryInvBtn" style="border:none;background:#eef2ff;color:#2563eb;padding:4px 10px;border-radius:6px;cursor:pointer;">Retry</button>
    </td></tr>`;
    document.getElementById('retryInvBtn')?.addEventListener('click', async () => {
      await loadInventoryForDemo();
      renderProductsStep();
    });
  }

  document.getElementById('prodFilter').addEventListener('input', applyFilters);

  document.getElementById('allotBtn').addEventListener('click', async () => {
    if (!Object.keys(spWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    const payload = {
      items: Object.values(spWiz.cart),
      remarks: spWiz.remarks.trim()
    };
    try {
      const res = await apiFetch('/request/demo_unit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      document.getElementById('allotModal').style.display = 'none';
      resetSpWiz();
      alert('Request sent — admin/employee will review and approve it.');
      await loadMyRequests();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

async function loadMyRequests() {
  try {
    const res = await apiFetch('/request/mine');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    spState.myRequests = (data.dataset || []).filter(r => r.request_type === 'demo_unit' || r.request_type === 'order');
    refreshView();
  } catch (err) {
    console.error(err);
  }
}