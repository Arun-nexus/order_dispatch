const allocState = { allocations: [], products: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadAllocations();
  loadInventoryForAllocation();
  wireTopActions();
  wireFilter();
  injectAllocateModal();
  setInterval(() => renderAllocationsTable(allocState.allocations), 60 * 1000); // keep countdowns fresh
});

async function loadAllocations() {
  try {
    const res = await apiFetch('/allocation/');
    if (!res.ok) throw new Error('failed to fetch allocations');
    const data = await res.json();
    allocState.allocations = data.dataset || [];
    renderAllocationsTable(allocState.allocations);
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

function returnMeta(a) {
  if (a.return_status === 'returned') return { label: 'Returned', cls: 'high', overdue: false };
  const due = new Date(a.return_due_date);
  const now = new Date();
  const msLeft = due - now;
  if (msLeft <= 0) return { label: 'Overdue', cls: 'low', overdue: true };
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  return { label: `${daysLeft}d left`, cls: daysLeft <= 2 ? 'medium' : 'high', overdue: false };
}

function updateAllocationCards(allocations) {
  const values = document.querySelectorAll('.cards .card h2');
  if (!values.length) return;
  const pending = allocations.filter(a => a.return_status !== 'returned' && !returnMeta(a).overdue).length;
  const overdue = allocations.filter(a => a.return_status !== 'returned' && returnMeta(a).overdue).length;
  const returned = allocations.filter(a => a.return_status === 'returned').length;
  values[0].textContent = allocations.length;
  if (values[1]) values[1].textContent = pending;
  if (values[2]) values[2].textContent = overdue;
  if (values[3]) values[3].textContent = returned;
}

function renderAllocationsTable(allocations) {
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  allocations.forEach(a => {
    const meta = returnMeta(a);
    const isSpare = a.allocation_type === 'spare_part';
    const productLabel = isSpare
      ? `${a.spare_part?.part_name ?? ''} x${a.spare_part?.quantity ?? 1}`
      : (a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    const whoLabel = isSpare
      ? `Service #${(a.spare_part?.service_id || '').slice(0, 8)}`
      : (a.sales_person?.name ?? '');

    const tr = document.createElement('tr');
    tr.dataset.id = a.allocation_id;
    tr.innerHTML = `
      <td>${a.allocation_id?.slice(0, 8) ?? ''}</td>
      <td>${isSpare ? 'Spare Part' : 'Product'}</td>
      <td>${productLabel}</td>
      <td>${whoLabel}</td>
      <td>${a.allotment_date ? new Date(a.allotment_date).toLocaleDateString('en-GB') : '-'}</td>
      <td>${a.return_due_date ? new Date(a.return_due_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="stock ${meta.cls}">${meta.label}</span></td>
      <td>
        <button class="icon-btn view-alloc-btn"><i class="fa-solid fa-eye"></i></button>
        ${a.return_status !== 'returned' ? '<button class="icon-btn return-alloc-btn"><i class="fa-solid fa-rotate-left"></i></button>' : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-alloc-btn').forEach(btn => btn.addEventListener('click', e => openViewAllocationModal(rowAllocation(e))));
  tbody.querySelectorAll('.return-alloc-btn').forEach(btn => btn.addEventListener('click', e => markReturned(rowAllocation(e))));
}

function rowAllocation(e) {
  const tr = e.target.closest('tr');
  return allocState.allocations.find(a => a.allocation_id === tr.dataset.id);
}

async function markReturned(a) {
  if (!a) return;
  if (!confirm('Mark this allocation as returned?')) return;
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
    : `<div class="detail"><small>Products</small><p>${(a.items || []).map(i => `${i.product_name} x${i.quantity}${i.serial_numbers?.length ? ' (' + i.serial_numbers.join(', ') + ')' : ''}`).join('<br>')}</p></div>
       <div class="detail"><small>Sales Person</small><p>${a.sales_person?.name ?? ''} — ${a.sales_person?.contact_number ?? ''}</p></div>
       <div class="detail"><small>Company / Address</small><p>${a.company_name ?? ''}, ${a.address ?? ''}</p></div>`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Allocation Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Allocation ID</small><p>${a.allocation_id ?? ''}</p></div>
    ${itemsHtml}
    <div class="detail"><small>Allotment Date</small><p>${a.allotment_date ? new Date(a.allotment_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Return Due</small><p>${a.return_due_date ? new Date(a.return_due_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Status</small><p>${meta.label}</p></div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireTopActions() {
  const exportBtn = document.querySelector('.top-actions .export');
  if (exportBtn) exportBtn.addEventListener('click', exportAllocationsCSV);
  // Allocate button is wired inside injectAllocateModal()
}

function exportAllocationsCSV() {
  const header = ['Allocation ID', 'Type', 'Product/Spare Part', 'Sales Person/Service', 'Allotment Date', 'Return Due', 'Status'];
  const rows = allocState.allocations.map(a => {
    const isSpare = a.allocation_type === 'spare_part';
    return [
      a.allocation_id,
      isSpare ? 'Spare Part' : 'Product',
      isSpare ? `${a.spare_part?.part_name} x${a.spare_part?.quantity}` : (a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(' | '),
      isSpare ? a.spare_part?.service_id : a.sales_person?.name,
      a.allotment_date,
      a.return_due_date,
      returnMeta(a).label
    ];
  });
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a2 = document.createElement('a');
  a2.href = URL.createObjectURL(blob);
  a2.download = 'allocations.csv';
  a2.click();
}

function wireFilter() {
  const filterBtn = document.querySelector('.filter-btn');
  if (!filterBtn) return;
  filterBtn.addEventListener('click', () => {
    const [statusSel] = document.querySelectorAll('.filter-box select');
    const [dateBox] = document.querySelectorAll('.filter-box input[type="date"]');
    const status = statusSel.value;
    const date = dateBox.value;

    const filtered = allocState.allocations.filter(a => {
      const meta = returnMeta(a);
      const statusOk = status === 'All Status' || !status
        || (status === 'Pending' && a.return_status !== 'returned' && !meta.overdue)
        || (status === 'Overdue' && meta.overdue && a.return_status !== 'returned')
        || (status === 'Returned' && a.return_status === 'returned');
      const dateOk = !date || (a.allotment_date || '').startsWith(date);
      return statusOk && dateOk;
    });
    renderAllocationsTable(filtered);
  });
}

// ---------- Allocate wizard ----------
const allocWiz = {
  type: '',              // 'product' | 'spare'
  salesPersonId: '',
  salesPerson: null,
  cart: {},               // product_id -> {product_id, product_name, quantity}
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
        <i class="fa-solid fa-box"></i><br>Product to Sales Person
      </button>
      <button id="btnAllocSpare" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-screwdriver-wrench"></i><br>Spare Part to Service
      </button>
    </div>`;
  document.getElementById('btnAllocProduct').addEventListener('click', () => { allocWiz.type = 'product'; renderSalesPersonTypeStep(); });
  document.getElementById('btnAllocSpare').addEventListener('click', () => { allocWiz.type = 'spare'; renderActiveServicesStep(); });
}

// ----- Product allocation flow -----
function renderSalesPersonTypeStep() {
  const body = allocModalBody();
  allocWizTitle('Sales Person');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Existing sales person or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnSpExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing
      </button>
      <button id="btnSpNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New
      </button>
    </div>
    <div style="margin-top:14px;">
      <button type="button" id="backAllocType" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('backAllocType').addEventListener('click', renderAllocTypeStep);
  document.getElementById('btnSpExisting').addEventListener('click', renderExistingSalesPersonStep);
  document.getElementById('btnSpNew').addEventListener('click', renderNewSalesPersonStep);
}

function renderExistingSalesPersonStep() {
  const body = allocModalBody();
  allocWizTitle('Select Sales Person');
  body.innerHTML = `
    <input id="spSearch" placeholder="Search name, company or contact" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="spResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="backSp1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('backSp1').addEventListener('click', renderSalesPersonTypeStep);

  const searchInput = document.getElementById('spSearch');
  const resultsBox = document.getElementById('spResults');
  const runSearch = async () => {
    resultsBox.innerHTML = '<small style="color:#94a3b8;">Searching...</small>';
    try {
      const term = searchInput.value.trim();
      const res = await apiFetch(`/salesperson/search?term=${encodeURIComponent(term)}`);
      const data = await res.json();
      const list = data.dataset || [];
      if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No sales persons found.</small>'; return; }
      resultsBox.innerHTML = list.map(sp => `
        <div class="sp-row" data-id="${sp.sales_person_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <strong>${sp.name ?? ''}</strong><br>
          <small style="color:#64748b;">${sp.company_name ?? ''} • ${sp.contact_number ?? ''}</small>
        </div>`).join('');
      resultsBox.querySelectorAll('.sp-row').forEach(row => row.addEventListener('click', () => {
        const sp = list.find(x => x.sales_person_id === row.dataset.id);
        allocWiz.salesPersonId = sp.sales_person_id;
        allocWiz.salesPerson = sp;
        renderProductCartStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

function renderNewSalesPersonStep() {
  const body = allocModalBody();
  allocWizTitle('New Sales Person');
  body.innerHTML = `
    <form id="newSpForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="name" placeholder="Sales Person Name" required>
      <input name="company_name" placeholder="Company Name" required>
      <input name="address" placeholder="Address" required>
      <input name="contact_number" placeholder="Contact Number" required>
      <input name="email" type="email" placeholder="Email">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backSp2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('backSp2').addEventListener('click', renderSalesPersonTypeStep);
  document.getElementById('newSpForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      name: fd.get('name'), company_name: fd.get('company_name'), address: fd.get('address'),
      contact_number: fd.get('contact_number'), email: fd.get('email') || ''
    };
    try {
      const res = await apiFetch('/salesperson/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'creation failed');
      allocWiz.salesPersonId = data.sales_person_id;
      allocWiz.salesPerson = data.sales_person || payload;
      renderProductCartStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function renderProductCartStep() {
  const body = allocModalBody();
  allocWizTitle(`Products for ${allocWiz.salesPerson?.name ?? ''}`);
  const products = allocState.products;
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
  document.getElementById('backCart').addEventListener('click', () => allocWiz.salesPersonId ? renderExistingSalesPersonStep() : renderNewSalesPersonStep());

  const rowsBox = document.getElementById('allocProdRows');
  const renderRows = (list) => {
    rowsBox.innerHTML = list.map(p => `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}</small></td>
        <td>${p.quantity ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${allocWiz.cart[p.product_id]?.quantity ?? 0}"
              data-id="${p.product_id}" class="allocQtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`).join('');
    rowsBox.querySelectorAll('.allocQtyInput').forEach(inp => inp.addEventListener('input', () => {
      const p = list.find(x => x.product_id === inp.dataset.id);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
      inp.value = qty;
      if (qty > 0) allocWiz.cart[p.product_id] = { product_id: p.product_id, product_name: p.product_name, quantity: qty };
      else delete allocWiz.cart[p.product_id];
    }));
  };
  renderRows(products);
  document.getElementById('allocProdFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });

  document.getElementById('toDetailsBtn').addEventListener('click', () => {
    if (!Object.keys(allocWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
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
      <input name="company_name" placeholder="Company Name" value="${allocWiz.salesPerson?.company_name ?? ''}" required>
      <input name="address" placeholder="Address" value="${allocWiz.salesPerson?.address ?? ''}" required>
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
  document.getElementById('backDetails').addEventListener('click', renderProductCartStep);
  document.getElementById('allotmentForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      sales_person_id: allocWiz.salesPersonId || '',
      sales_person: allocWiz.salesPerson || {},
      items: Object.values(allocWiz.cart),
      company_name: fd.get('company_name'),
      address: fd.get('address')
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