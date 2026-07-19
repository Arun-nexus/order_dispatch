// dashboard.js — populates the main dashboard (index.html) from the API
// Requires: <script src="dashboard.js"></script> added before </body> in index.html

document.addEventListener('DOMContentLoaded', loadDashboard);

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return res.json();
}

async function loadDashboard() {
  try {
    const [orders, inventory, accounts, services] = await Promise.all([
      fetchJSON('/order/'),
      fetchJSON('/inventory/'),
      fetchJSON('/account/'),
      fetchJSON('/service/')
    ]);

    const orderList = orders.dataset || [];
    const inventoryList = inventory.dataset || [];
    const accountList = accounts.dataset || [];
    const serviceList = services.dataset || [];

    renderCards(orderList, inventoryList, accountList, serviceList);
    renderRecentOrders(orderList);
    renderInventoryStatus(inventoryList);
    renderServiceRequests(serviceList);

  } catch (err) {
    console.error(err);
  }
}

function renderCards(orders, inventory, accounts, services) {
  const cardValues = document.querySelectorAll('.cards .card h2');
  if (cardValues[0]) cardValues[0].textContent = orders.length;
  if (cardValues[1]) cardValues[1].textContent = inventory.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  if (cardValues[2]) cardValues[2].textContent = accounts.length;
  if (cardValues[3]) cardValues[3].textContent = services.filter(s => s.status !== 'completed' && s.status !== 'rejected').length;
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
    div.className = 'order';
    div.innerHTML = `
      <div class="order-left">
        <div class="order-icon"><i class="fa-solid fa-file-medical"></i></div>
        <div>
          <h4>${o.order_id?.slice(0, 8) ?? ''}</h4>
          <p>${o.order_date ? new Date(o.order_date).toLocaleDateString() : ''}</p>
        </div>
      </div>
      <span class="badge ${statusBadgeClass(o.status)}">${o.status ?? ''}</span>
      <strong>₹${o.total_mrp ?? o.price ?? 0}</strong>`;
    container.appendChild(div);
  });
}

function renderInventoryStatus(inventory) {
  const items = document.querySelectorAll('.inventory .inventory-item');
  if (!items.length) return;

  const total = inventory.length || 1;
  const available = inventory.filter(p => Number(p.quantity) > 10).length;
  const low = inventory.filter(p => Number(p.quantity) > 0 && Number(p.quantity) <= 10).length;
  const out = inventory.filter(p => Number(p.quantity) === 0).length;

  const counts = [available, low, out];
  items.forEach((item, i) => {
    const pct = Math.round((counts[i] / total) * 100);
    item.querySelector('.inventory-head strong').textContent = counts[i];
    item.querySelector('.progress-bar').style.width = `${pct}%`;
    item.querySelector('small').textContent = `${pct}%`;
  });
}

function renderServiceRequests(services) {
  const container = document.querySelector('.service-list');
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
    div.className = 'service';
    div.innerHTML = `
      <div>
        <h4>${s.service_id?.slice(0, 8) ?? ''}</h4>
        <p>${s.purchase_date ?? ''}</p>
      </div>
      <span class="badge ${statusMap[s.status] || 'pending'}">${s.status ?? ''}</span>`;
    container.appendChild(div);
  });
}
