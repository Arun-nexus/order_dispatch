document.addEventListener('DOMContentLoaded', () => {
  loadReports();
  wireModalButtons();
});

async function fetchJSON(url) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return res.json();
}

async function loadReports() {
  try {
    const [orders, inventory, services, accounts] = await Promise.all([
      fetchJSON('/order/'),
      fetchJSON('/inventory/'),
      fetchJSON('/service/'),
      fetchJSON('/account/')
    ]);

    const orderList = orders.dataset || [];
    const inventoryList = inventory.dataset || [];
    const serviceList = services.dataset || [];
    const accountList = accounts.dataset || [];

    renderKPIs(orderList, inventoryList, serviceList, accountList);
    renderCharts(orderList, inventoryList, serviceList);
    renderQuickAnalytics(orderList, serviceList);

  } catch (err) {
    console.error(err);
  }
}

function renderKPIs(orders, inventory, services, accounts) {
  const totalRevenue = orders.reduce((sum, o) => sum + (Number(o.total_mrp) || 0), 0);
  const inventoryValue = inventory.reduce((sum, p) => sum + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0);

  const cardValues = document.querySelectorAll('.cards .card h2');
  if (cardValues[0]) cardValues[0].textContent = `₹${(totalRevenue / 100000).toFixed(1)}L`;
  if (cardValues[1]) cardValues[1].textContent = orders.length;
  if (cardValues[2]) cardValues[2].textContent = services.filter(s => s.status === 'completed').length;
  if (cardValues[3]) cardValues[3].textContent = `₹${(inventoryValue / 100000).toFixed(1)}L`;
  if (cardValues[4]) cardValues[4].textContent = accounts.length;
}

function groupByMonth(items, dateField, valueFn) {
  const buckets = {};
  items.forEach(item => {
    if (!item[dateField]) return;
    const d = new Date(item[dateField]);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets[key] = (buckets[key] || 0) + valueFn(item);
  });
  const sortedKeys = Object.keys(buckets).sort();
  return { labels: sortedKeys, values: sortedKeys.map(k => buckets[k]) };
}

function renderCharts(orders, inventory, services) {
  if (typeof Chart === 'undefined') return;
  const revenueByMonth = groupByMonth(orders, 'order_date', o => Number(o.total_mrp) || 0);
  const ordersByMonth = groupByMonth(orders, 'order_date', () => 1);

  new Chart(document.getElementById('revenueChart'), {
    type: 'line',
    data: {
      labels: revenueByMonth.labels.length ? revenueByMonth.labels : ['No dated orders yet'],
      datasets: [{
        label: 'Revenue (₹)',
        data: revenueByMonth.values.length ? revenueByMonth.values : [0],
        borderColor: '#1665ff',
        backgroundColor: 'rgba(22,101,255,.1)',
        fill: true,
        tension: 0.3
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  const statusCounts = { active: 0, in_progress: 0, completed: 0, rejected: 0 };
  services.forEach(s => { if (s.status in statusCounts) statusCounts[s.status]++; });

  new Chart(document.getElementById('serviceChart'), {
    type: 'doughnut',
    data: {
      labels: ['Active', 'In Progress', 'Completed', 'Rejected'],
      datasets: [{
        data: [statusCounts.active, statusCounts.in_progress, statusCounts.completed, statusCounts.rejected],
        backgroundColor: ['#1665ff', '#f59e0b', '#22c55e', '#ef4444']
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  new Chart(document.getElementById('ordersChart'), {
    type: 'bar',
    data: {
      labels: ordersByMonth.labels.length ? ordersByMonth.labels : ['No dated orders yet'],
      datasets: [{
        label: 'Orders',
        data: ordersByMonth.values.length ? ordersByMonth.values : [0],
        backgroundColor: '#4f8fff'
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  const topStock = [...inventory]
    .sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))
    .slice(0, 6);

  new Chart(document.getElementById('inventoryChart'), {
    type: 'bar',
    data: {
      labels: topStock.map(p => p.product_name || p.product_id),
      datasets: [{
        label: 'Quantity in stock',
        data: topStock.map(p => Number(p.quantity) || 0),
        backgroundColor: '#22c55e'
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y' }
  });
}

function renderQuickAnalytics(orders, services) {
  const today = new Date().toDateString();
  const todaysOrders = orders.filter(o => o.order_date && new Date(o.order_date).toDateString() === today);
  const todaysRevenue = todaysOrders.reduce((sum, o) => sum + (Number(o.total_mrp) || 0), 0);
  const pendingServices = services.filter(s => s.status === 'active' || s.status === 'in_progress').length;

  const miniValues = document.querySelectorAll('.analytics .mini-card h2');
  if (miniValues[0]) miniValues[0].textContent = todaysOrders.length;
  if (miniValues[1]) miniValues[1].textContent = `₹${todaysRevenue.toLocaleString('en-IN')}`;
  if (miniValues[2]) miniValues[2].textContent = pendingServices;
}

function wireModalButtons() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const generateBtn = document.querySelector('.generate');
  if (generateBtn) generateBtn.addEventListener('click', () => {
    alert('Report generation modal not implemented yet.');
  });

  document.querySelectorAll('.export').forEach(btn =>
    btn.addEventListener('click', () => {
      alert('Export modal not implemented yet.');
    }));
}