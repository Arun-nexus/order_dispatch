const spState = { allocations: [], products: [], myRequests: [] };
let spPage = 1;
const SP_PAGE_SIZE = 7;

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
    renderCards();
    renderTable(spState.allocations);
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
  document.getElementById('cardNotReturned').textContent = allocations.filter(a => a.return_status !== 'returned').length;
  document.getElementById('cardOverdue').textContent = allocations.filter(a => returnMeta(a).overdue).length;
}

function renderTable(allocations) {
  const sorted = [...allocations].sort((a, b) =>
    new Date(b.allotment_date || b.created_at || 0) - new Date(a.allotment_date || a.created_at || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / SP_PAGE_SIZE));
  spPage = Math.min(Math.max(1, spPage), totalPages);
  const start = (spPage - 1) * SP_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + SP_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  pageRows.forEach(a => {
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

  renderTablePagination(document.querySelector('.pagination'), spPage, totalPages, p => {
    spPage = p;
    renderTable(allocations);
  });
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
    spPage = 1;
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
    modal.style.display = 'flex';
    renderCustomerTypeStep();
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
    spState.myRequests = (data.dataset || []).filter(r => r.request_type === 'demo_unit' || r.request_type === 'order');
    renderMyRequests(spState.myRequests);
    renderPendingRequestsCard();
  } catch (err) {
    console.error(err);
  }
}

function renderPendingRequestsCard() {
  const card = document.getElementById('cardPendingRequests');
  if (card) card.textContent = spState.myRequests.filter(r => r.status === 'pending' && r.request_type === 'demo_unit').length;

  const rejectedCard = document.getElementById('cardRejectedRequests');
  if (rejectedCard) rejectedCard.textContent = spState.myRequests.filter(r => r.status === 'rejected' && r.request_type === 'demo_unit').length;
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