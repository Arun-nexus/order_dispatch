const reportState = { orders: [], inventory: [], services: [], accounts: [], stockType: 'product' };
const reportCharts = {};

document.addEventListener('DOMContentLoaded', () => {
  loadReports();
  wireModalButtons();
  wireReportFilter();
  wireStockTabs();
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
    reportState.orders = orders.dataset || [];
    reportState.inventory = inventory.dataset || [];
    reportState.services = services.dataset || [];
    reportState.accounts = accounts.dataset || [];
    applyReportFilter();
  } catch (err) {
    console.error(err);
  }
}

function inDateRange(value, from, to) {
  if (!from && !to) return true;
  if (!value) return false;
  const d = new Date(value);
  if (from && d < new Date(`${from}T00:00:00`)) return false;
  if (to && d > new Date(`${to}T23:59:59`)) return false;
  return true;
}

function applyReportFilter() {
  const inputs = document.querySelectorAll('.filter-section input[type="date"]');
  const from = inputs[0]?.value || '';
  const to = inputs[1]?.value || '';
  const type = document.querySelector('.filter-section select')?.value || 'All Reports';

  const orders = reportState.orders.filter(o => inDateRange(o.order_date, from, to));
  const services = reportState.services.filter(s => inDateRange(s.created_at, from, to));

  renderKPIs(orders, reportState.inventory, services, reportState.accounts);
  renderCharts(orders, services);
  renderStockChart();
  renderQuickAnalytics(reportState.orders, reportState.services);
  applyReportVisibility(type);
}

function applyReportVisibility(type) {
  const map = {
    'All Reports': null,
    'Sales Report': ['orders', 'revenue'],
    'Revenue Report': ['revenue'],
    'Inventory Report': ['inventory'],
    'Service Report': ['services'],
    'User Report': ['users']
  };
  const allowed = map[type] || null;
  const show = (el, keys) => {
    if (!el) return;
    el.style.display = !allowed || keys.some(k => allowed.includes(k)) ? '' : 'none';
  };

  const cards = document.querySelectorAll('.cards .card');
  const cardKeys = [['revenue'], ['orders'], ['services'], ['inventory'], ['users']];
  cards.forEach((c, i) => show(c, cardKeys[i] || []));

  show(document.getElementById('revenueChart')?.parentElement.parentElement, ['revenue']);
  show(document.getElementById('serviceChart')?.parentElement.parentElement, ['services']);
  show(document.getElementById('ordersChart')?.parentElement.parentElement, ['orders']);
  show(document.getElementById('inventoryChart')?.parentElement.parentElement, ['inventory']);

  const minis = document.querySelectorAll('.analytics .mini-card');
  const miniKeys = [['orders'], ['revenue'], ['services']];
  minis.forEach((m, i) => show(m, miniKeys[i] || []));
}

function wireReportFilter() {
  const btn = document.querySelector('.filter-btn');
  if (btn) btn.addEventListener('click', applyReportFilter);
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

function makeChart(id, config) {
  if (reportCharts[id]) reportCharts[id].destroy();
  reportCharts[id] = new Chart(document.getElementById(id), config);
}

function renderCharts(orders, services) {
  if (typeof Chart === 'undefined') return;
  const revenueByMonth = groupByMonth(orders, 'order_date', o => Number(o.total_mrp) || 0);
  const ordersByMonth = groupByMonth(orders, 'order_date', () => 1);

  makeChart('revenueChart', {
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

  makeChart('serviceChart', {
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

  makeChart('ordersChart', {
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
}

function stockItems(type) {
  const grouped = {};
  reportState.inventory
    .filter(p => (p.product_type || 'product') === type)
    .forEach(p => {
      const key = `${p.product_name || ''}||${p.product_id || ''}||${p.model_no || ''}`;
      if (!grouped[key]) grouped[key] = { name: p.product_name || p.product_id || '-', id: p.product_id || '-', model: p.model_no || '-', quantity: 0 };
      grouped[key].quantity += Number(p.quantity) || 0;
    });
  return Object.values(grouped).sort((a, b) => b.quantity - a.quantity).slice(0, 6);
}

function renderStockChart() {
  if (typeof Chart === 'undefined') return;
  const top = stockItems(reportState.stockType);

  makeChart('inventoryChart', {
    type: 'bar',
    data: {
      labels: top.length ? top.map(p => [p.name, `ID: ${p.id} · Model: ${p.model}`]) : ['No items in this category'],
      datasets: [{
        label: 'Quantity in stock',
        data: top.length ? top.map(p => p.quantity) : [0],
        backgroundColor: '#22c55e'
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y' }
  });
}

function wireStockTabs() {
  const tabs = document.querySelectorAll('.stockTab');
  const paint = () => tabs.forEach(t => {
    const active = t.dataset.type === reportState.stockType;
    t.style.background = active ? '#1665ff' : '#f1f5f9';
    t.style.color = active ? '#fff' : '#475569';
  });
  tabs.forEach(t => t.addEventListener('click', () => {
    reportState.stockType = t.dataset.type;
    paint();
    renderStockChart();
  }));
  paint();
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