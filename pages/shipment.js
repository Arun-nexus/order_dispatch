// =========================================================
// shipment.js
// Powers pages/shipment.html — cards, table/filtering, and the
// multi-step "Add Shipment" wizard (company details -> products
// -> per-product spare parts + warranty).
//
// NOTE ON BACKEND: this file talks to /shipment/ endpoints the
// same way allocated.js/dispatch.js talk to /request/ etc. If
// those routes don't exist on the server yet, saveShipmentToServer()
// below falls back to keeping everything in local memory so the
// page still works end-to-end for demoing the flow. Swap the
// fallback out once the FastAPI routes are added.
// =========================================================

let shipments = [];               // list rendered in the table
let shipmentDraft = null;         // wizard state while the modal is open
let shipmentStep = 1;             // 1 = company info, 2 = products, 3 = parts
let editingShipmentId = null;     // set when "Mark Received" targets a row
let deletingShipmentId = null;

const SHIPMENT_MODAL = () => document.querySelector('#shipmentModal .modal-content');

function newId() {
  return 'SH-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function money(n) {
  const v = Number(n) || 0;
  return '₹' + v.toLocaleString('en-IN');
}

const PART_STATUS_LABELS = {
  assembly: 'Assembly',
  purchase: 'Purchase',
  warranty: 'Warranty',
};
function partStatusLabel(status) {
  return PART_STATUS_LABELS[status] || PART_STATUS_LABELS.assembly;
}

// =========================================================
// LOAD + CARDS + TABLE
// =========================================================

// server stores snake_case (shipment_id, company_name, dispatch_date, ...);
// the UI below works with the camelCase shape used while building the wizard.
const CURRENCIES = { INR: '₹', USD: '$', EUR: '€', GBP: '£', CNY: 'CN¥', JPY: 'JP¥', AED: 'AED ', SGD: 'S$' };
let companyList = [];

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function curMoney(n, cur) {
  return (CURRENCIES[cur] || cur + ' ') + (Number(n) || 0).toLocaleString('en-IN');
}
function draftTotal(s) {
  return (s.products || []).reduce((t, p) => t + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0);
}
const PAYMENT_LABELS = { paid: 'Paid', partial: 'Partial (part now, rest on credit)', credit: 'Credit' };
function addDays(dateStr, days) {
  const d = new Date(dateStr || todayStr());
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
// payment summary for the view modal
function paymentSummaryHtml(s) {
  const total = draftTotal(s);
  const mode = s.paymentMode || 'paid';
  if (mode === 'paid') return '<div class="detail"><small>Payment</small><p>Paid in full</p></div>';
  const paid = mode === 'partial' ? (Number(s.paidAmount) || 0) : 0;
  const due = s.dueDate || addDays(s.dispatchDate, s.creditDays);
  return `
    <div class="detail"><small>Payment</small><p>${mode === 'partial' ? 'Partial — part paid, rest on credit' : 'Credit'}</p></div>
    <div class="detail"><small>Paid now</small><p>${curMoney(paid, s.currency)}</p></div>
    <div class="detail"><small>On credit (balance)</small><p>${curMoney(Math.max(total - paid, 0), s.currency)}</p></div>
    <div class="detail"><small>Credit time</small><p>${s.creditDays} day(s) — due ${due || '—'}<br><small style="color:#94a3b8;">Later payments are tracked in Users → Companies.</small></p></div>`;
}
async function loadCompanyList() {
  try {
    const r = await apiFetch('/customer/company_list');
    if (r.ok) companyList = (await r.json()).dataset || [];
  } catch (e) { companyList = []; }
}

function fromServerShape(s) {
  return {
    id: s.shipment_id || s.id,
    companyName: s.company_name,
    companyAddress: s.company_address,
    customerId: s.customer_id || '',
    paymentMode: s.payment_mode || 'paid',
    paidAmount: Number(s.paid_amount) || 0,
    creditDays: Number(s.credit_days) || 0,
    dueDate: s.due_date || '',
    currency: s.currency || 'INR',
    exchangeRate: Number(s.exchange_rate) || 1,
    totalInr: s.total_inr,
    dispatchDate: s.dispatch_date,
    receivedDate: s.received_date || '',
    createdAt: s.created_at,
    products: (s.products || []).map(p => ({
      name: p.product_name,
      quantity: p.quantity,
      price: p.price,
      warranty: p.warranty || '',
      parts: (p.parts || []).map(part => ({ name: part.part_name, quantity: part.quantity, status: part.status || 'assembly' })),
    })),
  };
}

function toServerShape(s) {
  return {
    company_name: s.companyName,
    company_address: s.companyAddress,
    customer_id: s.customerId || '',
    gst_number: s.gstNumber || '',
    contractor_person: s.contactPerson || '',
    contractor_number: s.contactNumber || '',
    contractor_email: s.contactEmail || '',
    payment_mode: s.paymentMode || 'paid',
    paid_amount: s.paymentMode === 'partial' ? (Number(s.paidAmount) || 0) : 0,
    credit_days: s.paymentMode === 'paid' ? 0 : (Number(s.creditDays) || 0),
    currency: s.currency || 'INR',
    exchange_rate: Number(s.exchangeRate) || 1,
    dispatch_date: s.dispatchDate,
    received_date: s.receivedDate || '',
    products: (s.products || []).map(p => ({
      product_name: p.name,
      quantity: Number(p.quantity) || 0,
      price: Number(p.price) || 0,
      warranty: p.warranty || '',
      parts: (p.parts || []).map(part => ({ part_name: part.name, quantity: Number(part.quantity) || 0, status: part.status || 'assembly' })),
    })),
  };
}

async function loadShipments() {
  try {
    const res = await apiFetch('/shipment/');
    if (res.ok) {
      const data = await res.json();
      shipments = (data.dataset || []).map(fromServerShape);
    }
  } catch (err) {
    // no backend route yet (or offline) — keep whatever is already in memory
    console.warn('shipment: using local data, server list unavailable', err.message);
  }
  renderCards();
  renderTable();
}

function shipmentStatus(s) {
  return s.receivedDate ? 'received' : 'pending';
}

function currentFYRange() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: new Date(y, 3, 1), end: new Date(y + 1, 2, 31, 23, 59, 59) };
}

function renderCards() {
  const now = new Date();
  const thisMonth = shipments.filter(s => {
    const d = new Date(s.createdAt || s.dispatchDate);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const today = shipments.filter(s => (s.createdAt || '').slice(0, 10) === todayStr()).length;
  const received = shipments.filter(s => shipmentStatus(s) === 'received').length;
  const pending = shipments.filter(s => shipmentStatus(s) === 'pending').length;
  const fyRange = currentFYRange();
  const fy = shipments.filter(s => {
    const d = new Date(s.createdAt || s.dispatchDate);
    return d >= fyRange.start && d <= fyRange.end;
  }).length;

  document.getElementById('cardThisMonth').textContent = thisMonth;
  document.getElementById('cardToday').textContent = today;
  document.getElementById('cardReceived').textContent = received;
  document.getElementById('cardPending').textContent = pending;
  document.getElementById('cardFY').textContent = fy;
}

function shipmentCardRowsHtml(list) {
  if (!list.length) return '<p style="color:#94a3b8;text-align:center;padding:16px;">No shipments to show.</p>';
  return `<table style="width:100%;font-size:13px;border-collapse:collapse;">
    <thead><tr style="text-align:left;">
      <th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">Company</th>
      <th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">Products</th>
      <th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">Order Date</th>
      <th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">Received Date</th>
      <th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">Status</th>
    </tr></thead>
    <tbody>${list.map(s => `<tr>
      <td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${s.companyName ?? ''}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${productSummary(s.products)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${s.dispatchDate ? new Date(s.dispatchDate).toLocaleDateString('en-GB') : '-'}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${s.receivedDate ? new Date(s.receivedDate).toLocaleDateString('en-GB') : '-'}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${shipmentStatus(s)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function openShipmentCardDetailModal(type) {
  const modal = document.getElementById('shipmentCardDetailModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const now = new Date();
  const fyRange = currentFYRange();

  let title = '';
  let list = shipments;
  if (type === 'thisMonth') {
    title = 'This Month Shipment';
    list = shipments.filter(s => {
      const d = new Date(s.createdAt || s.dispatchDate);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
  } else if (type === 'today') {
    title = 'Today Shipment';
    list = shipments.filter(s => (s.createdAt || '').slice(0, 10) === todayStr());
  } else if (type === 'received') {
    title = 'Received Shipment';
    list = shipments.filter(s => shipmentStatus(s) === 'received');
  } else if (type === 'pending') {
    title = 'Pending Shipment';
    list = shipments.filter(s => shipmentStatus(s) === 'pending');
  } else if (type === 'fy') {
    title = 'Financial Year Shipment';
    list = shipments.filter(s => {
      const d = new Date(s.createdAt || s.dispatchDate);
      return d >= fyRange.start && d <= fyRange.end;
    });
  }

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${title}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${shipmentCardRowsHtml(list)}`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireShipmentCardClicks() {
  document.querySelectorAll('.cards .card[data-card-filter]').forEach(card => {
    card.addEventListener('click', () => openShipmentCardDetailModal(card.dataset.cardFilter));
  });
}

function productSummary(products) {
  if (!products || !products.length) return '—';
  const first = products[0];
  const extra = products.length > 1 ? ` +${products.length - 1} more` : '';
  return `${first.name} x${first.quantity}${extra}`;
}

function renderTable() {
  const tbody = document.getElementById('shipmentTbody');
  const statusFilter = document.getElementById('statusFilter').value;
  const dateFilter = document.getElementById('dispatchDateFilter').value;
  const search = (document.getElementById('shipmentSearch').value || '').toLowerCase();

  const rows = shipments.filter(s => {
    if (statusFilter && shipmentStatus(s) !== statusFilter) return false;
    if (dateFilter && s.dispatchDate !== dateFilter) return false;
    if (search) {
      const hay = (s.companyName + ' ' + (s.products || []).map(p => p.name).join(' ')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px;">No shipments yet</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => {
    const status = shipmentStatus(s);
    const pill = status === 'received'
      ? '<span class="status delivered">Received</span>'
      : '<span class="status pending">Pending</span>';
    return `
      <tr>
        <td>${s.companyName}</td>
        <td>${(s.companyAddress || '').slice(0, 40)}${(s.companyAddress || '').length > 40 ? '…' : ''}</td>
        <td>${productSummary(s.products)}</td>
        <td>${s.dispatchDate || '—'}</td>
        <td>${s.receivedDate || '—'}</td>
        <td>${pill}</td>
        <td>
          <button class="icon-btn" data-action="view" data-id="${s.id}" title="View"><i class="fa-solid fa-eye"></i></button>
          <button class="icon-btn" data-action="edit" data-id="${s.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          ${status === 'pending' ? `<button class="icon-btn" data-action="receive" data-id="${s.id}" title="Mark Received"><i class="fa-solid fa-truck-ramp-box"></i></button>` : ''}
          <button class="icon-btn" data-action="delete" data-id="${s.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action="view"]').forEach(b => b.addEventListener('click', () => openViewModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="edit"]').forEach(b => b.addEventListener('click', () => openEditShipmentModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="receive"]').forEach(b => b.addEventListener('click', () => openReceivedModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', () => openDeleteModal(b.dataset.id)));
}

// =========================================================
// VIEW MODAL
// =========================================================

function openViewModal(id) {
  const s = shipments.find(x => x.id === id);
  if (!s) return;
  const box = document.querySelector('#viewShipmentModal .modal-content');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Shipment Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Company Name</small><p>${s.companyName}</p></div>
    <div class="detail"><small>Company Address</small><p>${s.companyAddress || '—'}</p></div>
    ${paymentSummaryHtml(s)}
    <div class="detail"><small>Total</small><p>${curMoney(draftTotal(s), s.currency)}${s.currency !== 'INR' ? ` ≈ ${money(s.totalInr)} (₹${s.exchangeRate}/${s.currency})` : ''}</p></div>
    <div class="detail"><small>Dispatch Date</small><p>${s.dispatchDate || '—'}</p></div>
    <div class="detail"><small>Received Date</small><p>${s.receivedDate || 'Not received yet'}</p></div>
    <hr style="margin:14px 0;border:none;border-top:1px solid #eef1f6;">
    <h4 style="margin-bottom:10px;">Products</h4>
    ${(s.products || []).map(p => `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-weight:600;">
          <span>${p.name}</span>
          <span>${curMoney(p.price, s.currency)} x ${p.quantity}</span>
        </div>
        ${p.warranty ? `<p style="font-size:12px;color:#64748b;margin-top:4px;">Warranty: ${p.warranty}</p>` : ''}
        ${(p.parts && p.parts.length) ? `
          <p style="font-size:12px;font-weight:600;color:#334155;margin-top:8px;">Parts</p>
          <ul style="margin:4px 0 0 18px;font-size:13px;color:#475569;">
            ${p.parts.map(part => `<li>${part.name} — qty ${part.quantity} <span style="color:#94a3b8;">(${partStatusLabel(part.status)})</span></li>`).join('')}
          </ul>` : `<p style="font-size:12px;color:#94a3b8;margin-top:6px;">No parts added</p>`}
      </div>
    `).join('') || '<p style="color:#94a3b8;">No products added</p>'}
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('viewShipmentModal'));
  openModal('viewShipmentModal');
}

// =========================================================
// MARK RECEIVED MODAL
// =========================================================

function openReceivedModal(id) {
  editingShipmentId = id;
  const box = document.querySelector('#receivedModal .modal-content');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Mark as Received</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="receivedForm" style="display:flex;flex-direction:column;gap:10px;">
      <label style="font-size:13px;color:#64748b;">Shipment Received Date</label>
      <input type="date" id="receivedDateInput" value="${todayStr()}" required>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Save</button>
      </div>
    </form>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('receivedModal'));
  box.querySelector('.cancel-btn').addEventListener('click', () => closeModal('receivedModal'));
  box.querySelector('#receivedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('receivedDateInput').value;
    const s = shipments.find(x => x.id === editingShipmentId);
    if (s) s.receivedDate = date;
    let inventoryNote = '';
    try {
      const res = await apiFetch(`/shipment/mark_received/${editingShipmentId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ received_date: date })
      });
      const data = await res.json().catch(() => null);
      if (data && Array.isArray(data.inventory_sync) && data.inventory_sync.length) {
        inventoryNote = ` ${data.inventory_sync.length} part line(s) synced into Inventory.`;
      } else if (data && typeof data.inventory_sync === 'string' && data.inventory_sync.startsWith('failed')) {
        inventoryNote = ' Note: parts could not be synced into Inventory automatically — please check manually.';
      }
    } catch (err) { /* local-only fallback, ignore */ }
    closeModal('receivedModal');
    renderCards();
    renderTable();
    showResponseModal('Shipment updated', `Received date has been saved.${inventoryNote}`, true);
  });
  openModal('receivedModal');
}

// =========================================================
// DELETE MODAL
// =========================================================

function openDeleteModal(id) {
  deletingShipmentId = id;
  openModal('deleteShipmentModal');
}

document.getElementById('deleteShipmentCancel')?.addEventListener('click', () => closeModal('deleteShipmentModal'));
document.getElementById('deleteShipmentConfirm')?.addEventListener('click', async () => {
  shipments = shipments.filter(s => s.id !== deletingShipmentId);
  try {
    await apiFetch(`/shipment/delete/${deletingShipmentId}`, { method: 'POST' });
  } catch (err) { /* local-only fallback, ignore */ }
  closeModal('deleteShipmentModal');
  renderCards();
  renderTable();
  showResponseModal('Shipment deleted', 'The shipment record has been removed.', true);
});

// =========================================================
// MODAL HELPERS
// =========================================================

function openModal(id) {
  const m = document.getElementById(id);
  m.style.display = 'flex';
}
function closeModal(id) {
  const m = document.getElementById(id);
  m.style.display = 'none';
}

// =========================================================
// ADD SHIPMENT WIZARD
// Step 1: company name, address, dispatch date, received date (optional)
// Step 2: add one or more products (name, quantity, price)
// Step 3: for every product added in step 2 — warranty + spare parts
//         (each product can have any number of parts, added one at a time)
// =========================================================

function stepDots(active) {
  const labels = ['Company', 'Products', 'Parts & Warranty'];
  return `
    <div style="display:flex;gap:8px;margin-bottom:20px;">
      ${labels.map((label, i) => `
        <div style="flex:1;text-align:center;">
          <div style="height:6px;border-radius:99px;background:${i + 1 <= active ? '#1665ff' : '#e2e8f0'};margin-bottom:6px;"></div>
          <span style="font-size:11px;color:${i + 1 === active ? '#1665ff' : '#94a3b8'};font-weight:${i + 1 === active ? '600' : '400'};">${label}</span>
        </div>
      `).join('')}
    </div>`;
}

async function openAddShipmentModal() {
  await loadCompanyList();
  shipmentDraft = {
    id: newId(),
    companyName: '',
    companyAddress: '',
    customerId: '',
    gstNumber: '',
    contactPerson: '',
    contactNumber: '',
    contactEmail: '',
    paymentMode: 'paid',
    paidAmount: 0,
    creditDays: '',
    currency: 'INR',
    exchangeRate: 1,
    rateNote: '',
    dispatchDate: todayStr(),
    receivedDate: '',
    products: []
  };
  shipmentStep = 1;
  renderShipmentStep();
  openModal('shipmentModal');
}

async function openEditShipmentModal(id) {
  const s = shipments.find(x => x.id === id);
  if (!s) return;
  await loadCompanyList();
  shipmentDraft = JSON.parse(JSON.stringify(s));
  shipmentDraft.isEdit = true;
  shipmentDraft.rateNote = '';
  if (!shipmentDraft.customerId) {
    const m = companyList.find(c => (c.company_name || '').trim().toLowerCase() === (s.companyName || '').trim().toLowerCase());
    shipmentDraft.customerId = m ? m.customer_id : '';
  }
  shipmentStep = 1;
  renderShipmentStep();
  openModal('shipmentModal');
}

function renderShipmentStep() {
  if (shipmentStep === 1) return renderStep1();
  if (shipmentStep === 2) return renderStep2();
  return renderStep3();
}

// ---------- STEP 1: company, payment, currency ----------
function readStep1() {
  const g = id => document.getElementById(id);
  const d = shipmentDraft;
  if (g('s1Dispatch')) d.dispatchDate = g('s1Dispatch').value;
  if (g('s1ReceivedDate')) d.receivedDate = g('s1ReceivedDate').value;
  if (g('s1Payment')) d.paymentMode = g('s1Payment').value;
  if (g('s1CreditDays')) d.creditDays = g('s1CreditDays').value;
  if (g('s1Rate')) d.exchangeRate = Number(g('s1Rate').value) || 0;
  if (g('s1CompanyName')) {
    d.companyName = g('s1CompanyName').value.trim();
    d.companyAddress = g('s1CompanyAddress').value.trim();
    d.gstNumber = g('s1Gst').value.trim();
    d.contactPerson = g('s1ContactPerson').value.trim();
    d.contactNumber = g('s1ContactNumber').value.trim();
    d.contactEmail = g('s1ContactEmail').value.trim();
  }
}

async function fetchRate() {
  const d = shipmentDraft;
  if (d.currency === 'INR') { d.exchangeRate = 1; d.rateNote = ''; return renderStep1(); }
  d.rateNote = 'Fetching live rate...';
  renderStep1();
  try {
    const r = await apiFetch(`/shipment/fx_rate?currency=${d.currency}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'failed');
    d.exchangeRate = data.rate;
    d.rateNote = `Live rate: 1 ${d.currency} = ₹${data.rate}`;
  } catch (e) {
    d.rateNote = 'Live rate unavailable — enter the rate manually';
  }
  renderStep1();
}

function renderStep1() {
  const d = shipmentDraft;
  const box = SHIPMENT_MODAL();
  const picked = companyList.find(c => c.customer_id === d.customerId);
  const input = (id, ph, val) => `<input id="${id}" placeholder="${ph}" value="${esc(val)}">`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>${d.isEdit ? 'Edit' : 'Add'} Shipment</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(1)}
    <form id="shipStep1Form" style="display:flex;flex-direction:column;gap:10px;">
      <label style="font-size:13px;color:#64748b;">Company</label>
      <select id="s1Company">
        <option value="">➕ Create new company manually</option>
        ${companyList.map(c => `<option value="${esc(c.customer_id)}" ${c.customer_id === d.customerId ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}
      </select>
      ${picked ? `
        <div style="background:#f8fafc;border-radius:10px;padding:10px;font-size:13px;color:#475569;">
          <div>${esc(picked.company_address) || '—'}</div>
          <div>GST: ${esc(picked.gst_number) || '—'} • ${esc(picked.contractor_person) || ''} ${esc(picked.contractor_number) || ''}</div>
        </div>` : `
        ${input('s1CompanyName', 'Company Name', d.companyName)}
        <textarea id="s1CompanyAddress" placeholder="Company Address" rows="2">${esc(d.companyAddress)}</textarea>
        ${input('s1Gst', 'GST Number (optional)', d.gstNumber)}
        ${input('s1ContactPerson', 'Contact Person (optional)', d.contactPerson)}
        ${input('s1ContactNumber', 'Contact Number (optional)', d.contactNumber)}
        ${input('s1ContactEmail', 'Contact Email (optional)', d.contactEmail)}`}
      <div style="display:flex;gap:10px;">
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:13px;color:#64748b;">Payment</label>
          <select id="s1Payment">
            <option value="paid" ${d.paymentMode === 'paid' ? 'selected' : ''}>Paid (full)</option>
            <option value="partial" ${d.paymentMode === 'partial' ? 'selected' : ''}>Partial (part now, rest later)</option>
            <option value="credit" ${d.paymentMode === 'credit' ? 'selected' : ''}>Credit (pay later)</option>
          </select>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:13px;color:#64748b;">Price Currency</label>
          <select id="s1Currency">
            ${Object.keys(CURRENCIES).map(c => `<option value="${c}" ${c === d.currency ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      ${d.paymentMode !== 'paid' ? `
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:13px;color:#9a3412;font-weight:600;">In how many days will the ${d.paymentMode === 'partial' ? 'remaining' : ''} payment be made?</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="s1CreditDays" type="number" min="1" max="365" step="1" placeholder="Credit time (days)" value="${esc(d.creditDays)}" style="flex:1;">
            <span style="font-size:12px;color:#9a3412;white-space:nowrap;" id="s1DueHint"></span>
          </div>
          ${d.paymentMode === 'partial' ? '<small style="color:#9a3412;">The amount paid now is asked on the next step, once products and prices are added.</small>' : ''}
        </div>` : ''}
      ${d.currency !== 'INR' ? `
        <div style="display:flex;gap:8px;align-items:center;">
          <span style="font-size:13px;color:#64748b;white-space:nowrap;">1 ${d.currency} = ₹</span>
          <input id="s1Rate" type="number" step="any" min="0" value="${d.exchangeRate}" style="flex:1;">
          <button type="button" id="s1RefreshRate" style="padding:8px 12px;border:none;border-radius:8px;background:#e2e8f0;cursor:pointer;">Refresh</button>
        </div>
        <small style="color:#94a3b8;">${esc(d.rateNote)}</small>` : ''}
      <label style="font-size:13px;color:#64748b;">Shipment Dispatch Date</label>
      <input type="date" id="s1Dispatch" value="${esc(d.dispatchDate)}" required>
      ${d.isEdit ? `<input type="hidden" id="s1ReceivedDate" value="${esc(d.receivedDate)}">` : `<label style="font-size:13px;color:#64748b;">Shipment Received Date <span style="color:#94a3b8;">(optional — can be added later)</span></label>
      <input type="date" id="s1ReceivedDate" value="${esc(d.receivedDate)}">`}
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" id="shipCancelBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Next: Add Products</button>
      </div>
    </form>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#shipCancelBtn').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#s1Company').addEventListener('change', (e) => {
    readStep1();
    const c = companyList.find(x => x.customer_id === e.target.value);
    d.customerId = c ? c.customer_id : '';
    d.companyName = c ? c.company_name : '';
    d.companyAddress = c ? (c.company_address || '') : '';
    d.gstNumber = c ? (c.gst_number || '') : '';
    d.contactPerson = c ? (c.contractor_person || '') : '';
    d.contactNumber = c ? (c.contractor_number || '') : '';
    d.contactEmail = c ? (c.contractor_email || '') : '';
    renderStep1();
  });
  box.querySelector('#s1Payment').addEventListener('change', (e) => {
    readStep1();
    d.paymentMode = e.target.value;
    renderStep1();
  });
  const refreshDueHint = () => {
    const hint = box.querySelector('#s1DueHint');
    if (!hint) return;
    const days = Number(box.querySelector('#s1CreditDays').value) || 0;
    const disp = box.querySelector('#s1Dispatch').value;
    hint.textContent = days > 0 ? `Due on ${addDays(disp, days)}` : '';
  };
  box.querySelector('#s1CreditDays')?.addEventListener('input', refreshDueHint);
  box.querySelector('#s1Dispatch').addEventListener('change', refreshDueHint);
  refreshDueHint();
  box.querySelector('#s1Currency').addEventListener('change', (e) => {
    readStep1();
    d.currency = e.target.value;
    fetchRate();
  });
  box.querySelector('#s1RefreshRate')?.addEventListener('click', () => { readStep1(); fetchRate(); });
  box.querySelector('#shipStep1Form').addEventListener('submit', (e) => {
    e.preventDefault();
    readStep1();
    if (!d.companyName) return showResponseModal('Company required', 'Select a company or enter its name.', false);
    if (d.currency !== 'INR' && !(d.exchangeRate > 0)) return showResponseModal('Rate required', 'Enter a valid exchange rate.', false);
    if (d.paymentMode !== 'paid') {
      const days = Number(d.creditDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) return showResponseModal('Credit time required', 'Enter in how many days (1-365) the payment will be made.', false);
      d.creditDays = days;
    }
    shipmentStep = 2;
    renderShipmentStep();
  });
}

// ---------- STEP 2: products ----------
function renderStep2() {
  const box = SHIPMENT_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>${shipmentDraft.isEdit ? 'Edit' : 'Add'} Shipment</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(2)}
    <p style="font-size:13px;color:#64748b;margin-bottom:10px;">Add every product going out in this shipment.</p>
    <div id="productRows" style="display:flex;flex-direction:column;gap:10px;"></div>
    <p id="shipTotals" style="margin-top:12px;font-size:13px;font-weight:600;color:#334155;text-align:right;"></p>
    ${shipmentDraft.paymentMode === 'partial' ? `
      <div style="margin-top:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:10px;">
        <label style="font-size:13px;color:#9a3412;font-weight:600;">Amount paid now (${shipmentDraft.currency})</label>
        <input id="s2PaidAmount" type="number" min="0" step="any" placeholder="e.g. half of the total" value="${shipmentDraft.paidAmount || ''}" style="width:100%;margin-top:4px;">
        <p id="s2PaidHint" style="font-size:12px;color:#9a3412;margin-top:6px;"></p>
      </div>` : ''}
    <button type="button" id="addProductRowBtn" style="margin-top:10px;padding:10px 14px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:13px;color:#334155;">
      <i class="fa-solid fa-plus"></i> Add Product
    </button>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;">
      <button type="button" id="shipBackBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Back</button>
      <button type="button" id="shipNextToPartsBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Next: Add Parts</button>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#shipBackBtn').addEventListener('click', () => { shipmentStep = 1; renderShipmentStep(); });

  // seed with one row if nothing added yet
  if (!shipmentDraft.products.length) addProductRow();
  else shipmentDraft.products.forEach(() => {}); // rows are rebuilt below from state

  renderProductRows();

  box.querySelector('#addProductRowBtn').addEventListener('click', () => {
    addProductRow();
    renderProductRows();
  });

  box.querySelector('#s2PaidAmount')?.addEventListener('input', updateShipTotals);
  box.querySelector('#shipNextToPartsBtn').addEventListener('click', () => {
    readProductRowsIntoDraft();
    const valid = shipmentDraft.products.filter(p => p.name && p.quantity);
    if (!valid.length) {
      showResponseModal('Add a product', 'Please add at least one product with a name and quantity.', false);
      return;
    }
    if (shipmentDraft.paymentMode === 'partial') {
      const total = draftTotal({ products: valid });
      const paid = Number(shipmentDraft.paidAmount) || 0;
      if (!(paid > 0) || paid >= total) {
        showResponseModal('Check paid amount', 'For a partial payment, the amount paid now must be more than 0 and less than the total (' + curMoney(total, shipmentDraft.currency) + ').', false);
        return;
      }
    }
    shipmentDraft.products = valid.map(p => ({ ...p, warranty: p.warranty || '', parts: p.parts || [] }));
    shipmentStep = 3;
    renderShipmentStep();
  });
}

function addProductRow() {
  shipmentDraft.products.push({ name: '', quantity: '', price: '', warranty: '', parts: [] });
}

function renderProductRows() {
  const wrap = document.getElementById('productRows');
  wrap.innerHTML = shipmentDraft.products.map((p, i) => `
    <div style="display:flex;gap:8px;align-items:center;" data-row="${i}">
      <input type="text" class="prodName" placeholder="Product Name" value="${p.name}" style="flex:2;">
      <input type="number" min="0" class="prodQty" placeholder="Qty" value="${p.quantity}" style="flex:1;">
      <input type="number" min="0" step="any" class="prodPrice" placeholder="Price (${shipmentDraft.currency})" value="${p.price}" style="flex:1;">
      <button type="button" class="removeProdBtn" data-index="${i}" style="border:none;background:#fee2e2;color:#dc2626;border-radius:8px;width:38px;height:38px;cursor:pointer;">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `).join('');

  wrap.oninput = updateShipTotals;
  updateShipTotals();
  wrap.querySelectorAll('.removeProdBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      readProductRowsIntoDraft();
      shipmentDraft.products.splice(Number(btn.dataset.index), 1);
      if (!shipmentDraft.products.length) addProductRow();
      renderProductRows();
    });
  });
}

function updateShipTotals() {
  readProductRowsIntoDraft();
  const el = document.getElementById('shipTotals');
  if (!el) return;
  const d = shipmentDraft;
  const t = draftTotal(d);
  el.textContent = d.currency === 'INR'
    ? `Total: ${money(t)}`
    : `Total: ${curMoney(t, d.currency)} ≈ ${money(Math.round(t * d.exchangeRate * 100) / 100)} (at ₹${d.exchangeRate}/${d.currency})`;
  const paidInput = document.getElementById('s2PaidAmount');
  if (paidInput) {
    d.paidAmount = Number(paidInput.value) || 0;
    const hint = document.getElementById('s2PaidHint');
    if (hint) {
      const left = Math.max(t - d.paidAmount, 0);
      hint.textContent = `Balance ${curMoney(left, d.currency)} on credit for ${d.creditDays} day(s) — due ${addDays(d.dispatchDate, d.creditDays)}`;
    }
  }
}

function readProductRowsIntoDraft() {
  const wrap = document.getElementById('productRows');
  if (!wrap) return;
  wrap.querySelectorAll('[data-row]').forEach(row => {
    const i = Number(row.dataset.row);
    shipmentDraft.products[i].name = row.querySelector('.prodName').value.trim();
    shipmentDraft.products[i].quantity = row.querySelector('.prodQty').value;
    shipmentDraft.products[i].price = row.querySelector('.prodPrice').value;
  });
}

// ---------- STEP 3: parts + warranty, per product ----------
function renderStep3() {
  const box = SHIPMENT_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>${shipmentDraft.isEdit ? 'Edit' : 'Add'} Shipment</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(3)}
    <p style="font-size:13px;color:#64748b;margin-bottom:10px;">Add spare parts and warranty for each product (optional, but recommended).</p>
    <div id="partsWizard" style="display:flex;flex-direction:column;gap:16px;"></div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;">
      <button type="button" id="shipBackToProductsBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Back</button>
      <button type="button" id="saveShipmentBtn" style="padding:10px 16px;border:none;border-radius:8px;background:linear-gradient(135deg,#1665ff,#4c92ff);color:#fff;cursor:pointer;font-weight:600;">
        <i class="fa-solid fa-check"></i> Save Shipment
      </button>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#shipBackToProductsBtn').addEventListener('click', () => { shipmentStep = 2; renderShipmentStep(); });
  box.querySelector('#saveShipmentBtn').addEventListener('click', finalizeShipment);

  renderPartsWizard();
}

function renderPartsWizard() {
  const wrap = document.getElementById('partsWizard');
  wrap.innerHTML = shipmentDraft.products.map((p, pi) => `
    <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;" data-product="${pi}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong>${p.name || 'Unnamed product'}</strong>
        <span style="font-size:12px;color:#94a3b8;">Qty ${p.quantity || 0}</span>
      </div>

      <label style="font-size:12px;color:#64748b;">Warranty (for parts)</label>
      <input type="text" class="partWarranty" placeholder="e.g. 12 months" value="${p.warranty}" style="margin-bottom:6px;">
      <p style="font-size:11px;color:#94a3b8;margin:0 0 10px;">Status: <b>Assembly</b> parts go to Inventory's Spare Parts on receive; <b>Purchase</b>/<b>Warranty</b> parts go to Service Parts.</p>

      <div class="partsRows" style="display:flex;flex-direction:column;gap:8px;">
        ${p.parts.map((part, prtIdx) => `
          <div style="display:flex;gap:8px;align-items:center;" data-part="${prtIdx}">
            <input type="text" class="partName" placeholder="Part Name" value="${part.name}" style="flex:2;">
            <input type="number" min="0" class="partQty" placeholder="Qty" value="${part.quantity}" style="flex:1;">
            <select class="partStatus" style="flex:1.2;">
              <option value="assembly" ${part.status === 'assembly' || !part.status ? 'selected' : ''}>Assembly</option>
              <option value="purchase" ${part.status === 'purchase' ? 'selected' : ''}>Purchase</option>
              <option value="warranty" ${part.status === 'warranty' ? 'selected' : ''}>Warranty</option>
            </select>
            <button type="button" class="removePartBtn" data-index="${prtIdx}" style="border:none;background:#fee2e2;color:#dc2626;border-radius:8px;width:34px;height:34px;cursor:pointer;">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        `).join('')}
      </div>

      <button type="button" class="addPartBtn" style="margin-top:8px;padding:8px 12px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:12px;color:#334155;">
        <i class="fa-solid fa-plus"></i> Add Part
      </button>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-product]').forEach(section => {
    const pi = Number(section.dataset.product);

    section.querySelector('.partWarranty').addEventListener('input', (e) => {
      shipmentDraft.products[pi].warranty = e.target.value;
    });

    section.querySelector('.addPartBtn').addEventListener('click', () => {
      syncPartsFromDom(pi);
      shipmentDraft.products[pi].parts.push({ name: '', quantity: '', status: 'assembly' });
      renderPartsWizard();
    });

    section.querySelectorAll('.removePartBtn').forEach(btn => {
      btn.addEventListener('click', () => {
        syncPartsFromDom(pi);
        shipmentDraft.products[pi].parts.splice(Number(btn.dataset.index), 1);
        renderPartsWizard();
      });
    });
  });
}

function syncPartsFromDom(productIndex) {
  const section = document.querySelector(`#partsWizard [data-product="${productIndex}"]`);
  if (!section) return;
  shipmentDraft.products[productIndex].warranty = section.querySelector('.partWarranty').value;
  section.querySelectorAll('[data-part]').forEach(row => {
    const prtIdx = Number(row.dataset.part);
    shipmentDraft.products[productIndex].parts[prtIdx].name = row.querySelector('.partName').value.trim();
    shipmentDraft.products[productIndex].parts[prtIdx].quantity = row.querySelector('.partQty').value;
    shipmentDraft.products[productIndex].parts[prtIdx].status = row.querySelector('.partStatus').value;
  });
}

function syncAllPartsFromDom() {
  shipmentDraft.products.forEach((_, pi) => syncPartsFromDom(pi));
}

// ---------- FINALIZE ----------
async function finalizeShipment() {
  syncAllPartsFromDom();

  // drop empty part rows (name left blank)
  shipmentDraft.products.forEach(p => {
    p.parts = p.parts.filter(part => part.name);
  });

  if (shipmentDraft.isEdit) {
    try {
      const res = await apiFetch(`/shipment/update/${shipmentDraft.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values: toServerShape(shipmentDraft) })
      });
      if (!res.ok) throw new Error('update failed');
    } catch (err) {
      showResponseModal('Update failed', 'The shipment could not be updated.', false);
      return;
    }
    shipmentDraft.totalInr = Math.round(draftTotal(shipmentDraft) * shipmentDraft.exchangeRate * 100) / 100;
    const idx = shipments.findIndex(x => x.id === shipmentDraft.id);
    if (idx !== -1) shipments[idx] = shipmentDraft;
    closeModal('shipmentModal');
    shipmentDraft = null;
    renderCards();
    renderTable();
    showResponseModal('Shipment updated', 'The shipment has been updated successfully.', true);
    return;
  }

  shipmentDraft.createdAt = new Date().toISOString();

  try {
    const res = await apiFetch('/shipment/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerShape(shipmentDraft))
    });
    if (res.status === 400 || res.status === 422) {
      const err = await res.json().catch(() => ({}));
      showResponseModal('Shipment not saved', typeof err.detail === 'string' ? err.detail : 'Please check the payment details.', false);
      return;
    }
    if (res.ok) {
      const data = await res.json();
      if (data.shipment_id) shipmentDraft.id = data.shipment_id;
      shipmentDraft.customerId = data.customer_id || shipmentDraft.customerId;
      shipmentDraft.totalInr = Math.round(draftTotal(shipmentDraft) * shipmentDraft.exchangeRate * 100) / 100;
    }
  } catch (err) {
    // no backend route yet — shipment still gets added to local state below
    console.warn('shipment: saved locally only, server unavailable', err.message);
  }

  shipments.unshift(shipmentDraft);

  closeModal('shipmentModal');
  shipmentDraft = null;
  renderCards();
  renderTable();
  showResponseModal('Shipment added', 'The shipment has been saved successfully.', true);
}

// =========================================================
// INIT
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addShipmentBtn').addEventListener('click', openAddShipmentModal);
  document.getElementById('applyShipmentFilter').addEventListener('click', renderTable);
  document.getElementById('shipmentSearch').addEventListener('input', renderTable);
  wireShipmentCardClicks();
  loadShipments();
});

// expose for the shared notification bell (common_auth.js) to refresh this page's data
window.refreshCurrentPageData = loadShipments;