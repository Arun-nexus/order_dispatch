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

// =========================================================
// LOAD + CARDS + TABLE
// =========================================================

// server stores snake_case (shipment_id, company_name, dispatch_date, ...);
// the UI below works with the camelCase shape used while building the wizard.
function fromServerShape(s) {
  return {
    id: s.shipment_id || s.id,
    companyName: s.company_name,
    companyAddress: s.company_address,
    dispatchDate: s.dispatch_date,
    receivedDate: s.received_date || '',
    createdAt: s.created_at,
    products: (s.products || []).map(p => ({
      name: p.product_name,
      quantity: p.quantity,
      price: p.price,
      warranty: p.warranty || '',
      parts: (p.parts || []).map(part => ({ name: part.part_name, quantity: part.quantity })),
    })),
  };
}

function toServerShape(s) {
  return {
    company_name: s.companyName,
    company_address: s.companyAddress,
    dispatch_date: s.dispatchDate,
    received_date: s.receivedDate || '',
    products: (s.products || []).map(p => ({
      product_name: p.name,
      quantity: Number(p.quantity) || 0,
      price: Number(p.price) || 0,
      warranty: p.warranty || '',
      parts: (p.parts || []).map(part => ({ part_name: part.name, quantity: Number(part.quantity) || 0 })),
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

function renderCards() {
  const now = new Date();
  const thisMonth = shipments.filter(s => {
    const d = new Date(s.createdAt || s.dispatchDate);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const today = shipments.filter(s => (s.createdAt || '').slice(0, 10) === todayStr()).length;
  const received = shipments.filter(s => shipmentStatus(s) === 'received').length;
  const pending = shipments.filter(s => shipmentStatus(s) === 'pending').length;

  document.getElementById('cardThisMonth').textContent = thisMonth;
  document.getElementById('cardToday').textContent = today;
  document.getElementById('cardReceived').textContent = received;
  document.getElementById('cardPending').textContent = pending;
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
          ${status === 'pending' ? `<button class="icon-btn" data-action="receive" data-id="${s.id}" title="Mark Received"><i class="fa-solid fa-truck-ramp-box"></i></button>` : ''}
          <button class="icon-btn" data-action="delete" data-id="${s.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action="view"]').forEach(b => b.addEventListener('click', () => openViewModal(b.dataset.id)));
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
    <div class="detail"><small>Dispatch Date</small><p>${s.dispatchDate || '—'}</p></div>
    <div class="detail"><small>Received Date</small><p>${s.receivedDate || 'Not received yet'}</p></div>
    <hr style="margin:14px 0;border:none;border-top:1px solid #eef1f6;">
    <h4 style="margin-bottom:10px;">Products</h4>
    ${(s.products || []).map(p => `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-weight:600;">
          <span>${p.name}</span>
          <span>${money(p.price)} x ${p.quantity}</span>
        </div>
        ${p.warranty ? `<p style="font-size:12px;color:#64748b;margin-top:4px;">Warranty: ${p.warranty}</p>` : ''}
        ${(p.parts && p.parts.length) ? `
          <p style="font-size:12px;font-weight:600;color:#334155;margin-top:8px;">Parts</p>
          <ul style="margin:4px 0 0 18px;font-size:13px;color:#475569;">
            ${p.parts.map(part => `<li>${part.name} — qty ${part.quantity}</li>`).join('')}
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
    try {
      await apiFetch(`/shipment/mark_received/${editingShipmentId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ received_date: date })
      });
    } catch (err) { /* local-only fallback, ignore */ }
    closeModal('receivedModal');
    renderCards();
    renderTable();
    showResponseModal('Shipment updated', 'Received date has been saved.', true);
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

function openAddShipmentModal() {
  shipmentDraft = {
    id: newId(),
    companyName: '',
    companyAddress: '',
    dispatchDate: todayStr(),
    receivedDate: '',
    products: []
  };
  shipmentStep = 1;
  renderShipmentStep();
  openModal('shipmentModal');
}

function renderShipmentStep() {
  if (shipmentStep === 1) return renderStep1();
  if (shipmentStep === 2) return renderStep2();
  return renderStep3();
}

// ---------- STEP 1: company details ----------
function renderStep1() {
  const box = SHIPMENT_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>Add Shipment</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(1)}
    <form id="shipStep1Form" style="display:flex;flex-direction:column;gap:10px;">
      <input id="s1CompanyName" placeholder="Company Name" value="${shipmentDraft.companyName}" required>
      <textarea id="s1CompanyAddress" placeholder="Company Address" rows="3" required>${shipmentDraft.companyAddress}</textarea>
      <label style="font-size:13px;color:#64748b;">Shipment Dispatch Date</label>
      <input type="date" id="s1DispatchDate" value="${shipmentDraft.dispatchDate}" required>
      <label style="font-size:13px;color:#64748b;">Shipment Received Date <span style="color:#94a3b8;">(optional — can be added later)</span></label>
      <input type="date" id="s1ReceivedDate" value="${shipmentDraft.receivedDate}">
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" id="shipCancelBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Next: Add Products</button>
      </div>
    </form>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#shipCancelBtn').addEventListener('click', () => closeModal('shipmentModal'));
  box.querySelector('#shipStep1Form').addEventListener('submit', (e) => {
    e.preventDefault();
    shipmentDraft.companyName = document.getElementById('s1CompanyName').value.trim();
    shipmentDraft.companyAddress = document.getElementById('s1CompanyAddress').value.trim();
    shipmentDraft.dispatchDate = document.getElementById('s1DispatchDate').value;
    shipmentDraft.receivedDate = document.getElementById('s1ReceivedDate').value; // may stay empty
    shipmentStep = 2;
    renderShipmentStep();
  });
}

// ---------- STEP 2: products ----------
function renderStep2() {
  const box = SHIPMENT_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>Add Shipment</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(2)}
    <p style="font-size:13px;color:#64748b;margin-bottom:10px;">Add every product going out in this shipment.</p>
    <div id="productRows" style="display:flex;flex-direction:column;gap:10px;"></div>
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

  box.querySelector('#shipNextToPartsBtn').addEventListener('click', () => {
    readProductRowsIntoDraft();
    const valid = shipmentDraft.products.filter(p => p.name && p.quantity);
    if (!valid.length) {
      showResponseModal('Add a product', 'Please add at least one product with a name and quantity.', false);
      return;
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
      <input type="number" min="0" class="prodPrice" placeholder="Price" value="${p.price}" style="flex:1;">
      <button type="button" class="removeProdBtn" data-index="${i}" style="border:none;background:#fee2e2;color:#dc2626;border-radius:8px;width:38px;height:38px;cursor:pointer;">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `).join('');

  wrap.querySelectorAll('.removeProdBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      readProductRowsIntoDraft();
      shipmentDraft.products.splice(Number(btn.dataset.index), 1);
      if (!shipmentDraft.products.length) addProductRow();
      renderProductRows();
    });
  });
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
      <h3>Add Shipment</h3>
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
      <input type="text" class="partWarranty" placeholder="e.g. 12 months" value="${p.warranty}" style="margin-bottom:10px;">

      <div class="partsRows" style="display:flex;flex-direction:column;gap:8px;">
        ${p.parts.map((part, prtIdx) => `
          <div style="display:flex;gap:8px;align-items:center;" data-part="${prtIdx}">
            <input type="text" class="partName" placeholder="Part Name" value="${part.name}" style="flex:2;">
            <input type="number" min="0" class="partQty" placeholder="Qty" value="${part.quantity}" style="flex:1;">
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
      shipmentDraft.products[pi].parts.push({ name: '', quantity: '' });
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

  shipmentDraft.createdAt = new Date().toISOString();

  try {
    const res = await apiFetch('/shipment/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerShape(shipmentDraft))
    });
    if (res.ok) {
      const data = await res.json();
      if (data.shipment_id) shipmentDraft.id = data.shipment_id;
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
  loadShipments();
});

// expose for the shared notification bell (common_auth.js) to refresh this page's data
window.refreshCurrentPageData = loadShipments;