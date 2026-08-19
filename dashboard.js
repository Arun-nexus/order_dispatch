document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  setTodayDate();
});

function setTodayDate() {
  const dateBox = document.querySelector('.date-box span');
  if (!dateBox) return;
  const today = new Date();
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  dateBox.textContent = today.toLocaleDateString('en-GB', options).replace(/ /g, ' ');
}

async function fetchJSON(url) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return res.json();
}

const dashState = { orders: [], services: [], accounts: [], allocations: [] };

async function loadDashboard() {
  try {
    const [orders, inventory, accounts, services, allocations] = await Promise.all([
      fetchJSON('/order/'),
      fetchJSON('/inventory/'),
      fetchJSON('/account/'),
      fetchJSON('/service/'),
      fetchJSON('/allocation/')
    ]);

    const orderList = orders.dataset || [];
    const inventoryList = inventory.dataset || [];
    const accountList = accounts.dataset || [];
    const serviceList = services.dataset || [];
    const allocationList = allocations.dataset || [];

    dashState.orders = orderList;
    dashState.services = serviceList;
    dashState.accounts = accountList;
    dashState.allocations = allocationList;

    renderCards(orderList, inventoryList, accountList, serviceList);
    renderRecentOrders(orderList);
    renderInventoryStatus(inventoryList);
    renderServiceRequests(serviceList);
    renderTeamPanel();

  } catch (err) {
    console.error(err);
  }
}

function renderCards(orders, inventory, accounts, services) {
  const cardValues = document.querySelectorAll('.cards .card h2');
  // main_dashboard.html card order: Total Orders, Pending Orders, Inventory Items, Total Employees, Active Services
  if (cardValues[0]) cardValues[0].textContent = orders.length;
  if (cardValues[1]) cardValues[1].textContent = orders.filter(o => o.status === 'placed').length;
  if (cardValues[2]) cardValues[2].textContent = inventory.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  if (cardValues[3]) cardValues[3].textContent = accounts.length;
  if (cardValues[4]) cardValues[4].textContent = services.filter(s => s.status !== 'completed' && s.status !== 'rejected').length;
}

function statusBadgeClass(status) {
  const map = {
    placed: 'pending',
    delivered: 'delivered',
    processing: 'processing',
    shipped: 'shipped',
    cancelled: 'cancelled'
  };
  return map[status] || 'pending';
}

function renderRecentOrders(orders) {
  const container = document.querySelector('.order-list');
  if (!container) return;
  container.innerHTML = '';

  const recent = [...orders]
    .sort((a, b) => new Date(b.order_date || 0) - new Date(a.order_date || 0))
    .slice(0, 5);

  recent.forEach(o => {
    const div = document.createElement('div');
    div.className = 'order-item';
    div.innerHTML = `
      <div class="order-left">
        <div class="order-icon"><i class="fa-solid fa-file-medical"></i></div>
        <div>
          <h4>${o.order_id?.slice(0, 8) ?? ''}</h4>
          <p>${o.order_date ? new Date(o.order_date).toLocaleDateString() : ''}</p>
        </div>
      </div>
      <span class="status ${statusBadgeClass(o.status)}">${o.status ?? ''}</span>
      <strong>₹${o.total_mrp ?? o.price ?? 0}</strong>`;
    container.appendChild(div);
  });
}

function renderInventoryStatus(inventory) {
  const items = document.querySelectorAll('.inventory-status .inventory-item');
  if (!items.length) return;

  const total = inventory.length || 1;
  const available = inventory.filter(p => Number(p.quantity) > 10).length;
  const low = inventory.filter(p => Number(p.quantity) > 0 && Number(p.quantity) <= 10).length;
  const out = inventory.filter(p => Number(p.quantity) === 0).length;

  const counts = [available, low, out];
  items.forEach((item, i) => {
    const pct = Math.round((counts[i] / total) * 100);
    item.querySelector('.inventory-head strong').textContent = counts[i];
    item.querySelector('.progress-fill').style.width = `${pct}%`;
    item.querySelector('small').textContent = `${pct}%`;
  });
}

function renderServiceRequests(services) {
  const container = document.getElementById('serviceRequestsList');
  if (!container) return;
  container.innerHTML = '';

  const statusMap = {
    active: 'pending',
    in_progress: 'processing',
    completed: 'delivered',
    rejected: 'cancelled'
  };

  services.slice(0, 4).forEach(s => {
    const div = document.createElement('div');
    div.className = 'service-item';
    div.innerHTML = `
      <div>
        <h4>${s.service_id?.slice(0, 8) ?? ''}</h4>
        <p>${s.purchase_date ?? ''}</p>
      </div>
      <span class="status ${statusMap[s.status] || 'pending'}">${s.status ?? ''}</span>`;
    container.appendChild(div);
  });
}

// ---------- My Team panel ----------
function renderTeamPanel() {
  const container = document.getElementById('teamMemberList');
  if (!container) return;
  container.innerHTML = '';

  const team = dashState.accounts.filter(a => a.role === 'distributor' || a.role === 'technician');
  if (!team.length) {
    container.innerHTML = '<p style="font-size:13px;color:#94a3b8;padding:8px;">No distributors or technicians yet.</p>';
    return;
  }

  team.forEach(member => {
    const div = document.createElement('div');
    div.className = 'service-item';
    div.style.cursor = 'pointer';
    div.innerHTML = `
      <div>
        <h4>${member.name ?? member.username}</h4>
        <p>${member.username} • ${member.role === 'distributor' ? 'Distributor' : 'Technician'}</p>
      </div>
      <span class="status ${member.role === 'distributor' ? 'processing' : 'pending'}">${member.role === 'distributor' ? 'Distributor' : 'Technician'}</span>`;
    div.addEventListener('click', () => openTeamReportModal(member));
    container.appendChild(div);
  });
}

function isThisMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function computeMemberStats(username) {
  const today = new Date().toDateString();

  const myOrders = dashState.orders.filter(o => o.creator?.raised_by === username || o.creator?.created_by === username);
  const todayOrders = myOrders.filter(o => o.order_date && new Date(o.order_date).toDateString() === today).length;
  const monthlyOrders = myOrders.filter(o => isThisMonth(o.order_date)).length;

  const myServices = dashState.services.filter(s => s.technician_alloted === username);
  const completedServices = myServices.filter(s => s.status === 'completed').length;
  const activeServices = myServices.filter(s => s.status === 'active').length;
  const inProgressServices = myServices.filter(s => s.status === 'in_progress').length;

  const myDemoUnits = dashState.allocations.filter(a => a.allocation_type === 'demo_unit' && a.allocated_by === username);
  const demoAllotted = myDemoUnits.length;
  const demoPendingReturn = myDemoUnits.filter(a => a.return_status !== 'returned').length;

  return {
    todayOrders, monthlyOrders,
    totalServices: myServices.length, completedServices, activeServices, inProgressServices,
    demoAllotted, demoPendingReturn
  };
}

function openTeamReportModal(member) {
  const modal = document.getElementById('teamReportModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const stats = computeMemberStats(member.username);

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h3 style="margin:0;">${member.name ?? member.username}</h3>
        <p style="margin:2px 0 0;color:#64748b;font-size:13px;">${member.username} • ${member.role === 'distributor' ? 'Distributor' : 'Technician'}</p>
      </div>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
      <div style="background:#f8fafc;border-radius:8px;padding:10px;">
        <small style="color:#64748b;">Today's Orders</small>
        <h3 style="margin:4px 0 0;">${stats.todayOrders}</h3>
      </div>
      <div style="background:#f8fafc;border-radius:8px;padding:10px;">
        <small style="color:#64748b;">This Month's Orders</small>
        <h3 style="margin:4px 0 0;">${stats.monthlyOrders}</h3>
      </div>
    </div>

    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#334155;">Services</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:13px;">
        <div>Total: <strong>${stats.totalServices}</strong></div>
        <div>Completed: <strong>${stats.completedServices}</strong></div>
        <div>Active: <strong>${stats.activeServices}</strong></div>
        <div>In Progress: <strong>${stats.inProgressServices}</strong></div>
      </div>
    </div>

    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;">
      <label style="font-size:13px;font-weight:600;color:#334155;">Demo Units</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:13px;">
        <div>Allotted: <strong>${stats.demoAllotted}</strong></div>
        <div>Return Pending: <strong>${stats.demoPendingReturn}</strong></div>
      </div>
    </div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
  modal.style.display = 'flex';
}