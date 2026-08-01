const spState = { allocations: [], products: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadMyAllocations();
  loadMyRequests();
  loadMyTeam();
  loadInventoryForDemo();
  wireFilter();
  injectAllotModal();
});

async function loadMyTeam() {
  try {
    const [teamRes, teamAllocRes] = await Promise.all([
      apiFetch('/account/my_team'),
      apiFetch('/allocation/team')
    ]);
    const teamData = await teamRes.json();
    const allocData = teamRes.ok && teamAllocRes.ok ? await teamAllocRes.json() : { dataset: [] };
    const team = teamData.dataset || [];
    if (!team.length) return; 
    document.getElementById('myTeamSection').style.display = '';
    renderMyTeam(team, allocData.dataset || []);
  } catch (err) {
    console.error(err);
  }
}

function renderMyTeam(team, teamAllocations) {
  const box = document.getElementById('myTeamList');
  if (!box) return;
  box.innerHTML = team.map(member => {
    const memberAllocs = teamAllocations.filter(a => a.allocated_by === member.username);
    const held = memberAllocs.filter(a => a.return_status !== 'returned').length;
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid fa-user"></i></div>
          <div>
            <h4>${member.name ?? member.username}</h4>
            <p>${member.company_name ?? ''} • ${member.mobile_no ?? ''}</p>
          </div>
        </div>
        <span class="status pending">${memberAllocs.length} allotted • ${held} with customers</span>
      </div>`;
  }).join('');
}

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

    spState.allocations = merged;
    renderWelcome();
    renderCards();
    renderTable(spState.allocations);
    renderDashboardPanels();
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

function statusPillClass(a) {
  const meta = returnMeta(a);
  if (a.return_status === 'returned') return 'delivered';
  if (meta.overdue) return 'cancelled';
  return 'pending';
}

function renderDashboardPanels() {
  const recentBox = document.getElementById('recentAllotmentsList');
  const dueBox = document.getElementById('returnsDueList');
  if (!recentBox || !dueBox) return;

  const recent = [...spState.allocations]
    .sort((a, b) => new Date(b.allotment_date) - new Date(a.allotment_date))
    .slice(0, 5);

  recentBox.innerHTML = recent.length ? recent.map(a => {
    const meta = returnMeta(a);
    const productLabel = (a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid fa-box"></i></div>
          <div>
            <h4>${a.customer?.company_name ?? 'Customer'}</h4>
            <p>${productLabel}</p>
          </div>
        </div>
        <span class="status ${statusPillClass(a)}">${meta.label}</span>
      </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">No demo units allotted yet.</p>';

  const dueSoon = spState.allocations
    .filter(a => a.return_status !== 'returned')
    .sort((a, b) => new Date(a.return_due_date) - new Date(b.return_due_date))
    .slice(0, 5);

  dueBox.innerHTML = dueSoon.length ? dueSoon.map(a => {
    const meta = returnMeta(a);
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid fa-clock"></i></div>
          <div>
            <h4>${a.customer?.company_name ?? 'Customer'}</h4>
            <p>Due ${a.return_due_date ? new Date(a.return_due_date).toLocaleDateString('en-GB') : '-'}</p>
          </div>
        </div>
        <span class="status ${statusPillClass(a)}">${meta.label}</span>
      </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">Nothing pending return.</p>';
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

function renderCards() {
  const allocations = spState.allocations;
  document.getElementById('cardTotal').textContent = allocations.length;
  document.getElementById('cardHeld').textContent = allocations.filter(a => a.return_status !== 'returned').length;
  document.getElementById('cardOverdue').textContent = allocations.filter(a => returnMeta(a).overdue).length;
  document.getElementById('cardReturned').textContent = allocations.filter(a => a.return_status === 'returned').length;
}

function renderTable(allocations) {
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  allocations.forEach(a => {
    const meta = returnMeta(a);
    const productLabel = (a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    const tr = document.createElement('tr');
    tr.dataset.id = a.allocation_id;
    const category = a.allocation_type === 'demo_unit' ? 'Demo' : (a.allocation_type ? 'Order' : '-');
    tr.innerHTML = `
      <td>${creatorLabel(a.allocated_by)}</td>
      <td>${category}</td>
      <td>${a.customer?.company_name ?? ''}</td>
      <td>${productLabel}</td>
      <td>${a.allotment_date ? new Date(a.allotment_date).toLocaleDateString('en-GB') : '-'}</td>
      <td>${a.return_due_date ? new Date(a.return_due_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="stock ${meta.cls}">${meta.label}</span></td>
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        ${a.return_status !== 'returned' ? '<button class="icon-btn return-btn"><i class="fa-solid fa-rotate-left"></i></button>' : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', e => openViewModal(rowAllocation(e))));
  tbody.querySelectorAll('.return-btn').forEach(b => b.addEventListener('click', e => markReturned(rowAllocation(e))));
}

function rowAllocation(e) {
  const tr = e.target.closest('tr');
  return spState.allocations.find(a => a.allocation_id === tr.dataset.id);
}

async function markReturned(a) {
  if (!a) return;
  if (!confirm('Mark this demo unit as returned by the customer?')) return;
  try {
    const res = await apiFetch(`/allocation/return/${a.allocation_id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'update failed');
    await loadMyAllocations();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

function openViewModal(a) {
  if (!a) return;
  const modal = document.getElementById('viewAllocationModal');
  const content = modal.querySelector('.modal-content');
  const meta = returnMeta(a);
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Demo Unit Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Allocation ID</small><p>${a.allocation_id ?? ''}</p></div>
    <div class="detail"><small>Customer</small><p>${a.customer?.company_name ?? ''} — ${a.customer?.contractor_person ?? ''} (${a.customer?.contractor_number ?? ''})</p></div>
    <div class="detail"><small>Products</small><p>${(a.items || []).map(i => `${i.product_name} x${i.quantity}${i.serial_numbers?.length ? ' (' + i.serial_numbers.join(', ') + ')' : ''}`).join('<br>')}</p></div>
    <div class="detail"><small>Allotment Date</small><p>${a.allotment_date ? new Date(a.allotment_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Return Due</small><p>${a.return_due_date ? new Date(a.return_due_date).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Status</small><p>${meta.label}</p></div>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const status = document.getElementById('statusFilter').value;
    const filtered = allocations_filtered(status);
    renderTable(filtered);
  });
}

function allocations_filtered(status) {
  if (!status || status === 'All Status') return spState.allocations;
  return spState.allocations.filter(a => {
    const meta = returnMeta(a);
    if (status === 'pending') return a.return_status !== 'returned' && !meta.overdue;
    if (status === 'overdue') return meta.overdue && a.return_status !== 'returned';
    if (status === 'returned') return a.return_status === 'returned';
    return true;
  });
}

// ---------- Allot Demo Unit wizard ----------
const spWiz = { customerId: '', customer: null, cart: {} };

function resetSpWiz() {
  spWiz.customerId = '';
  spWiz.customer = null;
  spWiz.cart = {};
}

function injectAllotModal() {
  const modal = document.getElementById('allotModal');
  const btn = document.querySelector('.top-actions .add-product');
  if (btn) btn.addEventListener('click', () => {
    resetSpWiz();
    resetOrderWiz();
    modal.style.display = 'flex';
    renderRequestTypeStep();
  });
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

function renderRequestTypeStep() {
  const body = wizBody();
  wizTitle('Create Request');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">What would you like to request?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnDemoReq" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-box-open"></i><br>Request Demo Unit
      </button>
      <button id="btnOrderReq" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-cart-shopping"></i><br>Create Order
      </button>
    </div>`;
  document.getElementById('btnDemoReq').addEventListener('click', renderCustomerTypeStep);
  document.getElementById('btnOrderReq').addEventListener('click', renderOrderCustomerTypeStep);
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

function renderCustomerTypeStep() {
  const body = wizBody();
  wizTitle('Customer');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing
      </button>
      <button id="btnNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New
      </button>
    </div>`;
  document.getElementById('btnExisting').addEventListener('click', renderExistingCustomerStep);
  document.getElementById('btnNew').addEventListener('click', renderNewCustomerStep);
}

function renderExistingCustomerStep() {
  const body = wizBody();
  wizTitle('Select Customer');
  body.innerHTML = `
    <input id="custSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="custResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="backBtn1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('backBtn1').addEventListener('click', renderCustomerTypeStep);

  const searchInput = document.getElementById('custSearch');
  const resultsBox = document.getElementById('custResults');
  const runSearch = async () => {
    resultsBox.innerHTML = '<small style="color:#94a3b8;">Searching...</small>';
    try {
      const term = searchInput.value.trim();
      const res = await apiFetch(`/customer/search?term=${encodeURIComponent(term)}`);
      const data = await res.json();
      const list = data.dataset || [];
      if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No customers found.</small>'; return; }
      resultsBox.innerHTML = list.map(c => `
        <div class="cust-row" data-id="${c.customer_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <strong>${c.company_name ?? ''}</strong><br>
          <small style="color:#64748b;">${c.gst_number ?? ''} • ${c.contractor_person ?? ''} • ${c.contractor_number ?? ''}</small>
        </div>`).join('');
      resultsBox.querySelectorAll('.cust-row').forEach(row => row.addEventListener('click', () => {
        const c = list.find(x => x.customer_id === row.dataset.id);
        spWiz.customerId = c.customer_id;
        spWiz.customer = c;
        renderProductsStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

function renderNewCustomerStep() {
  const body = wizBody();
  wizTitle('New Customer');
  body.innerHTML = `
    <form id="newCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company Name" required>
      <input name="company_address" placeholder="Company Address" required>
      <input name="gst_number" placeholder="GST Number" required>
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('backBtn2').addEventListener('click', renderCustomerTypeStep);
  document.getElementById('newCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'), company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'), contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'), contractor_email: fd.get('contractor_email') || ''
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      spWiz.customerId = data.customer_id;
      spWiz.customer = data.customer || payload;
      renderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function renderProductsStep() {
  const body = wizBody();
  wizTitle(`Demo Units for ${spWiz.customer?.company_name ?? ''}`);
  const products = spState.products;
  body.innerHTML = `
    <input id="prodFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Stock</th><th style="width:70px;">Qty</th></tr></thead>
        <tbody id="prodRows"></tbody>
      </table>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin-top:8px;">Return window: 7 days from allotment date.</p>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backCart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="allotBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;
  document.getElementById('backCart').addEventListener('click', () => spWiz.customerId ? renderExistingCustomerStep() : renderNewCustomerStep());

  const rowsBox = document.getElementById('prodRows');
  const renderRows = (list) => {
    rowsBox.innerHTML = list.map(p => `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}</small></td>
        <td>${p.quantity ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${spWiz.cart[p.product_id]?.quantity ?? 0}"
              data-id="${p.product_id}" class="qtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`).join('');
    rowsBox.querySelectorAll('.qtyInput').forEach(inp => inp.addEventListener('input', () => {
      const p = list.find(x => x.product_id === inp.dataset.id);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
      inp.value = qty;
      if (qty > 0) spWiz.cart[p.product_id] = { product_id: p.product_id, product_name: p.product_name, quantity: qty };
      else delete spWiz.cart[p.product_id];
    }));
  };
  renderRows(products);
  document.getElementById('prodFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });

  document.getElementById('allotBtn').addEventListener('click', async () => {
    if (!Object.keys(spWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    const payload = {
      customer_id: spWiz.customerId || '',
      customer: spWiz.customer || {},
      items: Object.values(spWiz.cart)
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

// ---------- My Requests panel ----------
async function loadMyRequests() {
  try {
    const res = await apiFetch('/request/mine');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    renderMyRequests((data.dataset || []).filter(r => r.request_type === 'demo_unit' || r.request_type === 'order'));
  } catch (err) {
    console.error(err);
  }
}

function requestStatusClass(status) {
  if (status === 'approved') return 'delivered';
  if (status === 'rejected') return 'cancelled';
  return 'pending';
}

function renderMyRequests(requests) {
  const box = document.getElementById('myRequestsList');
  if (!box) return;
  const sorted = [...requests].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  box.innerHTML = sorted.length ? sorted.map(r => {
    const isOrder = r.request_type === 'order';
    const productLabel = (r.details?.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    const customerLabel = r.details?.customer?.company_name || 'New customer';
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid ${isOrder ? 'fa-cart-shopping' : 'fa-paper-plane'}"></i></div>
          <div>
            <h4>${customerLabel} · ${isOrder ? 'Order' : 'Demo Unit'}</h4>
            <p>${productLabel}${r.status === 'rejected' && r.reason ? ' — ' + r.reason : ''}</p>
          </div>
        </div>
        <span class="status ${requestStatusClass(r.status)}">${r.status}</span>
      </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">No requests raised yet.</p>';
}

const orderWiz = { customerId: '', customer: null, cart: {}, discount: 0 };

const ORDER_PAYMENT_MODES = [
  { value: 'Credit', label: 'Credit' },
  { value: 'NetBanking', label: 'Net Banking' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'DemandDraft', label: 'Demand Draft' },
  { value: 'Cash', label: 'Cash' },
];

function resetOrderWiz() {
  orderWiz.customerId = '';
  orderWiz.customer = null;
  orderWiz.cart = {};
  orderWiz.discount = 0;
}

function renderOrderCustomerTypeStep() {
  const body = wizBody();
  wizTitle('Create Order — Customer');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Is this order for an existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnOExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing Customer
      </button>
      <button id="btnONew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New Customer
      </button>
    </div>
    <div style="margin-top:14px;">
      <button type="button" id="backReqType" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('btnOExisting').addEventListener('click', renderOrderExistingCustomerStep);
  document.getElementById('btnONew').addEventListener('click', renderOrderNewCustomerStep);
  document.getElementById('backReqType').addEventListener('click', renderRequestTypeStep);
}

function renderOrderExistingCustomerStep() {
  const body = wizBody();
  wizTitle('Create Order — Select Customer');
  body.innerHTML = `
    <input id="oCustSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="oCustResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="oBackBtn1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('oBackBtn1').addEventListener('click', renderOrderCustomerTypeStep);

  const searchInput = document.getElementById('oCustSearch');
  const resultsBox = document.getElementById('oCustResults');
  const runSearch = async () => {
    resultsBox.innerHTML = '<small style="color:#94a3b8;">Searching...</small>';
    try {
      const term = searchInput.value.trim();
      const res = await apiFetch(`/customer/search?term=${encodeURIComponent(term)}`);
      const data = await res.json();
      const list = data.dataset || [];
      if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No customers found.</small>'; return; }
      resultsBox.innerHTML = list.map(c => `
        <div class="cust-row" data-id="${c.customer_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <strong>${c.company_name ?? ''}</strong><br>
          <small style="color:#64748b;">${c.gst_number ?? ''} • ${c.contractor_person ?? ''} • ${c.contractor_number ?? ''}</small>
        </div>`).join('');
      resultsBox.querySelectorAll('.cust-row').forEach(row => row.addEventListener('click', () => {
        const c = list.find(x => x.customer_id === row.dataset.id);
        orderWiz.customerId = c.customer_id;
        orderWiz.customer = c;
        renderOrderProductsStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

function renderOrderNewCustomerStep() {
  const body = wizBody();
  wizTitle('Create Order — New Customer');
  body.innerHTML = `
    <form id="oNewCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Customer Name" required>
      <input name="company_address" placeholder="Customer Address" required>
      <input name="gst_number" placeholder="GST Number (if applicable)">
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email" required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="oBackBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('oBackBtn2').addEventListener('click', renderOrderCustomerTypeStep);
  document.getElementById('oNewCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'), company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'), contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'), contractor_email: fd.get('contractor_email')
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      orderWiz.customerId = data.customer_id;
      orderWiz.customer = data.customer || payload;
      renderOrderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function renderOrderProductsStep() {
  const body = wizBody();
  wizTitle(`Create Order — ${orderWiz.customer?.company_name ?? 'Products'}`);
  const products = spState.products;
  body.innerHTML = `
    <input id="oProdFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Price</th><th style="width:70px;">Qty</th></tr></thead>
        <tbody id="oProdRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="oBackCart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="oToPaymentBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Create Order</button>
    </div>`;
  document.getElementById('oBackCart').addEventListener('click', () => orderWiz.customerId ? renderOrderExistingCustomerStep() : renderOrderNewCustomerStep());

  const rowsBox = document.getElementById('oProdRows');
  const renderRows = (list) => {
    rowsBox.innerHTML = list.map(p => `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}</small></td>
        <td>₹${p.price ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${orderWiz.cart[p.product_id]?.quantity ?? 0}"
              data-id="${p.product_id}" class="oQtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`).join('');
    rowsBox.querySelectorAll('.oQtyInput').forEach(inp => inp.addEventListener('input', () => {
      const p = list.find(x => x.product_id === inp.dataset.id);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
      inp.value = qty;
      if (qty > 0) orderWiz.cart[p.product_id] = { product_id: p.product_id, product_name: p.product_name, price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0, quantity: qty };
      else delete orderWiz.cart[p.product_id];
    }));
  };
  renderRows(products);
  document.getElementById('oProdFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });

  document.getElementById('oToPaymentBtn').addEventListener('click', () => {
    if (!Object.keys(orderWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    renderOrderPaymentStep();
  });
}

function renderOrderPaymentStep() {
  const body = wizBody();
  wizTitle('Create Order — Payment');
  const cartItems = Object.values(orderWiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);

  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `${i.product_name} × ${i.quantity} = ₹${(i.price * i.quantity).toFixed(2)}`).join('<br>')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">
      Subtotal: ₹${subtotal.toFixed(2)}
    </div>
    <select id="oPaymentMode" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
      <option value="">Select Payment Mode</option>
      ${ORDER_PAYMENT_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
    </select>
    <div id="oPaymentExtra"></div>
    <input id="oDiscountInput" type="number" min="0" placeholder="Discount (₹)" value="0" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;">
    <div style="display:flex;justify-content:space-between;margin-top:10px;">
      <button type="button" id="oBackBtn4" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="oSendRequestBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;

  document.getElementById('oBackBtn4').addEventListener('click', renderOrderProductsStep);

  const modeSelect = document.getElementById('oPaymentMode');
  const extraBox = document.getElementById('oPaymentExtra');
  modeSelect.addEventListener('change', () => renderOrderPaymentExtra(modeSelect.value, extraBox));

  document.getElementById('oDiscountInput').addEventListener('input', e => orderWiz.discount = Number(e.target.value) || 0);

  document.getElementById('oSendRequestBtn').addEventListener('click', () => submitOrderRequest(modeSelect, extraBox));
}

function renderOrderPaymentExtra(mode, extraBox) {
  if (mode === 'Credit') {
    extraBox.innerHTML = `
      <label style="font-size:13px;color:#64748b;">Credit Period</label>
      <select id="oCreditDaysSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
        <option value="15">15 days</option>
        <option value="30">30 days</option>
        <option value="45">45 days</option>
        <option value="60">60 days</option>
        <option value="manual">Other (enter days)</option>
      </select>
      <input id="oCreditDaysManual" type="number" min="1" max="60" placeholder="Enter days (max 60)" style="display:none;width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
    const sel = document.getElementById('oCreditDaysSelect');
    const manual = document.getElementById('oCreditDaysManual');
    sel.addEventListener('change', () => manual.style.display = sel.value === 'manual' ? 'block' : 'none');
  } else if (mode === 'Cheque') {
    extraBox.innerHTML = `
      <input id="oChequeNumber" placeholder="Cheque Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oChequeDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oChequeBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'DemandDraft') {
    extraBox.innerHTML = `
      <input id="oDdNumber" placeholder="Demand Draft Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oDdDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oDdBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'UPI') {
    extraBox.innerHTML = `<input id="oUpiId" placeholder="UPI ID (e.g. name@bank)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else if (mode === 'NetBanking') {
    extraBox.innerHTML = `
      <input id="oNbBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oNbAccount" placeholder="Account Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oNbIfsc" placeholder="IFSC Code" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'Cash') {
    extraBox.innerHTML = `<input id="oCashReceivedBy" placeholder="Received By (Person Name)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else {
    extraBox.innerHTML = '';
  }
}

function buildOrderPaymentDetails(mode) {
  if (mode === 'Credit') {
    const sel = document.getElementById('oCreditDaysSelect');
    const manual = document.getElementById('oCreditDaysManual');
    const days = sel.value === 'manual' ? Number(manual.value) : Number(sel.value);
    if (!days || days < 1 || days > 60) throw new Error('Credit days must be between 1 and 60.');
    return { credit_days: days };
  }
  if (mode === 'Cheque') {
    const cheque_number = document.getElementById('oChequeNumber').value.trim();
    const cheque_date = document.getElementById('oChequeDate').value;
    const bank_name = document.getElementById('oChequeBank').value.trim();
    if (!cheque_number || !cheque_date) throw new Error('Cheque number and date are required.');
    return { cheque_number, cheque_date, bank_name };
  }
  if (mode === 'DemandDraft') {
    const dd_number = document.getElementById('oDdNumber').value.trim();
    const dd_date = document.getElementById('oDdDate').value;
    const bank_name = document.getElementById('oDdBank').value.trim();
    if (!dd_number || !dd_date) throw new Error('Demand draft number and date are required.');
    return { dd_number, dd_date, bank_name };
  }
  if (mode === 'UPI') {
    const upi_id = document.getElementById('oUpiId').value.trim();
    if (!upi_id) throw new Error('UPI ID is required.');
    return { upi_id };
  }
  if (mode === 'NetBanking') {
    const bank_name = document.getElementById('oNbBank').value.trim();
    const account_number = document.getElementById('oNbAccount').value.trim();
    const ifsc_code = document.getElementById('oNbIfsc').value.trim();
    if (!bank_name || !account_number || !ifsc_code) throw new Error('Bank name, account number and IFSC code are required.');
    return { bank_name, account_number, ifsc_code };
  }
  if (mode === 'Cash') {
    const received_by = document.getElementById('oCashReceivedBy').value.trim();
    if (!received_by) throw new Error('Received-by person name is required.');
    return { received_by };
  }
  return {};
}

async function submitOrderRequest(modeSelect, extraBox) {
  const mode = modeSelect.value;
  if (!mode) { alert('Please select a payment mode.'); return; }

  let payment_details;
  try {
    payment_details = buildOrderPaymentDetails(mode);
  } catch (err) {
    alert(err.message);
    return;
  }

  const payload = {
    customer_id: orderWiz.customerId || '',
    customer: orderWiz.customer || {},
    items: Object.values(orderWiz.cart).map(i => ({
      product_id: i.product_id, product_name: i.product_name,
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: orderWiz.discount || 0
  };

  try {
    const res = await apiFetch('/request/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'request failed');
    document.getElementById('allotModal').style.display = 'none';
    resetOrderWiz();
    alert('Request sent — admin/employee will review and approve it.');
    await loadMyRequests();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}