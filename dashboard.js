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

const dashState = { orders: [], services: [], accounts: [], allocations: [], inventory: [] };

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
    dashState.inventory = inventoryList;
    buildLookups();

    renderCards(orderList, inventoryList, accountList, serviceList);
    renderRecentOrders(orderList);
    renderInventoryStatus(inventoryList);
    renderServiceRequests(serviceList);
    renderTeamPanel();
    initDetails();

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
  const container = document.getElementById('recentOrdersList') || document.querySelector('.order-list');
  if (!container) return;
  container.innerHTML = '';

  const recent = [...orders]
    .sort((a, b) => new Date(b.order_date || 0) - new Date(a.order_date || 0))
    .slice(0, 5);

  if (!recent.length) { container.innerHTML = '<p class="dd-empty">No orders yet.</p>'; return; }

  recent.forEach(o => {
    const it = (o.items || [])[0] || {};
    const more = (o.items || []).length > 1 ? ` <small>+${o.items.length - 1} more</small>` : '';
    const div = document.createElement('div');
    div.className = 'order-item dd-row';
    div.tabIndex = 0;
    div.innerHTML = `
      <div class="order-left">
        <div class="order-icon"><i class="fa-solid fa-file-medical"></i></div>
        <div class="dd-meta">
          <h4>${ddDash(it.product_name)}${more}</h4>
          <p>ID: ${ddDash(it.product_id)} &nbsp;|&nbsp; Model: ${ddDash(it.model_no)}</p>
        </div>
      </div>
      <span class="status ${statusBadgeClass(o.status)}">${ddEsc(o.status ?? '')}</span>
      <strong>₹${o.total_mrp ?? o.price ?? 0}</strong>`;
    div.addEventListener('click', () => openOrderDetail(o));
    div.addEventListener('keydown', e => { if (e.key === 'Enter') openOrderDetail(o); });
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

const SERVICE_STATUS_CLASS = { active: 'pending', in_progress: 'processing', completed: 'delivered', rejected: 'cancelled' };

function renderServiceRequests(services) {
  const container = document.getElementById('serviceRequestsList');
  if (!container) return;
  container.innerHTML = '';

  if (!services.length) { container.innerHTML = '<p class="dd-empty">No service requests.</p>'; return; }

  services.slice(0, 6).forEach(s => {
    const p = serviceProduct(s);
    const div = document.createElement('div');
    div.className = 'service-item dd-row';
    div.tabIndex = 0;
    div.innerHTML = `
      <div class="dd-meta">
        <h4>${ddEsc(p.name)}</h4>
        <p class="dd-sub">ID: ${ddEsc(p.id)} &nbsp;|&nbsp; Model: ${ddEsc(p.model)}</p>
        <p class="dd-sub"><i class="fa-solid fa-user-gear"></i> ${ddEsc(assigneeName(s))}</p>
      </div>
      <span class="status ${SERVICE_STATUS_CLASS[s.status] || 'pending'}">${ddEsc(ddPretty(s.status))}</span>`;
    div.addEventListener('click', () => openServiceDetail(s));
    div.addEventListener('keydown', e => { if (e.key === 'Enter') openServiceDetail(s); });
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
    const roleLabel = member.role === 'distributor' ? 'Sales' : 'Technician';
    div.innerHTML = `
      <div>
        <h4>${member.name ?? member.username}</h4>
        <p>${member.username} • ${roleLabel}</p>
      </div>
      <span class="status ${member.role === 'distributor' ? 'processing' : 'pending'}">${roleLabel}</span>`;
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
        <p style="margin:2px 0 0;color:#64748b;font-size:13px;">${member.username} • ${member.role === 'distributor' ? 'Sales' : 'Technician'}</p>
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

// ---------- Details popups (cards, orders, inventory, services) ----------
const LOW_STOCK_LIMIT = 10;   // same rule as renderInventoryStatus
const ddEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ddDash = v => (v === undefined || v === null || v === '' ? '—' : ddEsc(v));
const ddPretty = s => String(s || 'pending').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const ddMoney = n => (n === undefined || n === null || n === '' || isNaN(n) ? '—' : '₹' + Number(n).toLocaleString('en-IN'));
const ddDate = d => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? ddEsc(d) : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const ddBadge = (status, cls) => `<span class="status ${cls}">${ddEsc(ddPretty(status))}</span>`;
const stockQty = i => Number(i.quantity) || 0;

const lookups = { serial: {}, product: {} };
function buildLookups() {
  lookups.serial = {}; lookups.product = {};
  dashState.orders.forEach(o => (o.items || []).forEach(it =>
    (it.serial_numbers || []).forEach(sn => { lookups.serial[sn] = it; })));
  dashState.inventory.forEach(i => { if (!lookups.product[i.product_id]) lookups.product[i.product_id] = i; });
}
function serviceProduct(s) {
  const o = lookups.serial[s.serial_no] || {};
  const p = lookups.product[s.product_id] || {};
  return {
    name: s.product_name || o.product_name || p.product_name || '—',
    id: s.product_id || o.product_id || '—',
    model: s.model_no || o.model_no || p.model_no || '—'
  };
}
function assigneeName(s) {
  const u = s.technician_alloted || s.technician_id;
  if (!u) return 'Unassigned';
  const acc = dashState.accounts.find(a => a.username === u);
  return acc ? (acc.name || acc.username) : u;
}

const dd = { modal: null, body: null, title: null, stack: [] };
function ddShow(title, html, push) {
  if (push) { dd.stack.push({ t: dd.title.textContent, h: dd.body.innerHTML, fn: dd.rowFn }); dd.rowFn = null; }
  dd.title.textContent = title;
  dd.body.innerHTML = html;
  dd.modal.classList.add('open');
}
function ddClose() { dd.modal.classList.remove('open'); dd.stack = []; }

const ddKV = pairs => `<div class="dd-grid">${pairs.map(([k, v]) => `<div><b>${ddEsc(k)}</b>${v}</div>`).join('')}</div>`;
function ddTable(heads, rows, clickable) {
  if (!rows.length) return '<p class="dd-empty">Nothing to show.</p>';
  return `<div class="dd-wrap"><table class="dd-table"><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r, i) => `<tr class="${clickable ? 'dd-row' : ''}" data-i="${i}">${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}
function ddList(title, heads, rows, onRow) {
  dd.rowFn = onRow || null;
  ddShow(title, ddTable(heads, rows, !!onRow));
}

async function lotDetail(it) {
  try {
    const q = new URLSearchParams({ product_id: it.product_id || '', model_no: it.model_no || '' });
    return (await fetchJSON('/inventory/detail?' + q)).product;
  } catch (e) {
    return dashState.inventory.find(i => i.product_id === it.product_id && (i.model_no || '') === (it.model_no || '')) || null;
  }
}

function inventoryBlock(lot, name) {
  if (!lot) return `<p class="dd-empty">No inventory record found for ${ddEsc(name)}.</p>`;
  const serials = lot.serial_numbers || [];
  return ddKV([
    ['Product', ddDash(lot.product_name)], ['Product ID', ddDash(lot.product_id)],
    ['Model No', ddDash(lot.model_no)], ['Category', ddPretty(lot.product_type || 'product')],
    ['Quantity in stock', ddDash(lot.quantity)], ['Lot No', ddDash(lot.lot_no)],
    ['Supplier', ddDash(lot.supplier)], ['Purchase date', ddDate(lot.purchase_date)],
    ['Price', ddDash(lot.price)], ['Tax rate', lot.tax_rate !== undefined ? ddEsc(lot.tax_rate) + '%' : '—'],
    ['Warranty until', lot.warranty_until ? ddDate(lot.warranty_until) : '—'], ['Warranty status', ddDash(lot.warranty_status)]
  ]) + (serials.length
    ? `<b style="font-size:12px;color:#64748b">Serial numbers in stock (${serials.length})</b>
       <div class="dd-serials">${serials.slice(0, 200).map(x => `<span class="dd-chip">${ddEsc(x)}</span>`).join('')}</div>` : '');
}

async function openInventoryItem(i) {
  ddShow('Inventory details', '<p class="dd-empty">Loading…</p>', true);
  const lot = await lotDetail(i);
  dd.body.innerHTML = '<button class="dd-back">← Back</button>' + inventoryBlock(lot || i, i.product_name);
}

async function openOrderDetail(o) {
  ddShow('Order details', '<p class="dd-empty">Loading…</p>', true);
  const c = o.customer || {};
  let html = '<button class="dd-back">← Back</button>' + ddKV([
    ['Order ID', ddDash(o.order_id)], ['Order date', ddDate(o.order_date)],
    ['Status', ddBadge(o.status, statusBadgeClass(o.status))], ['Payment mode', ddDash(o.payment_mode)],
    ['Customer', ddDash(c.company_name)], ['Contact', ddDash([c.contractor_person, c.contractor_number].filter(Boolean).join(' · '))],
    ['Discount', ddMoney(o.discount)], ['Total', ddMoney(o.total_mrp ?? o.price)]
  ]);
  for (const it of o.items || []) {
    const lot = await lotDetail(it);
    html += `<div class="dd-section">${ddEsc(it.product_name)} — Qty ${ddEsc(it.quantity)} × ${ddMoney(it.price)}</div>
      <b style="font-size:12px;color:#64748b">Serials sold</b>
      <div class="dd-serials">${(it.serial_numbers || []).map(x => `<span class="dd-chip">${ddEsc(x)}</span>`).join('') || '—'}</div>
      <div class="dd-section" style="font-size:13px">Inventory details</div>${inventoryBlock(lot, it.product_name)}`;
  }
  dd.body.innerHTML = html;
}

function openServiceDetail(s) {
  const p = serviceProduct(s);
  ddShow('Service details', '<button class="dd-back">← Back</button>' + ddKV([
    ['Product', ddEsc(p.name)], ['Product ID', ddEsc(p.id)], ['Model No', ddEsc(p.model)], ['Serial No', ddDash(s.serial_no)],
    ['Assigned to', ddEsc(assigneeName(s))], ['Status', ddBadge(s.status, SERVICE_STATUS_CLASS[s.status] || 'pending')],
    ['Issue', ddDash(s.issue)], ['Location', ddDash(s.location)],
    ['Purchase date', ddDate(s.purchase_date)], ['Raised on', ddDate(s.created_at)],
    ['Service charges', ddMoney(s.service_charges)], ['Spare parts', ddDash(s.spare_parts)],
    ['Created by', ddDash(s.created_by)], ['Reason / remarks', ddDash(s.reason)]
  ]), true);
}

const orderRow = o => { const it = (o.items || [])[0] || {};
  return [ddDash(it.product_name), ddDash(it.product_id), ddDash(it.model_no), ddDate(o.order_date), ddBadge(o.status, statusBadgeClass(o.status)), ddMoney(o.total_mrp ?? o.price)]; };
const invRow = i => [ddDash(i.product_name), ddDash(i.product_id), ddDash(i.model_no), ddPretty(i.product_type || 'product'), ddDash(stockQty(i))];
const ORDER_HEADS = ['Product', 'Product ID', 'Model No', 'Date', 'Status', 'Total'];
const INV_HEADS = ['Product', 'Product ID', 'Model No', 'Category', 'Qty'];

function openCard(key) {
  const { orders, inventory, accounts, services } = dashState;
  if (key === 'orders') ddList('All orders', ORDER_HEADS, orders.map(orderRow), i => openOrderDetail(orders[i]));
  else if (key === 'pending') {
    const list = orders.filter(o => o.status === 'placed');
    ddList('Pending orders', ORDER_HEADS, list.map(orderRow), i => openOrderDetail(list[i]));
  } else if (key === 'inventory') ddList('Inventory items', INV_HEADS, inventory.map(invRow), i => openInventoryItem(inventory[i]));
  else if (key === 'employees') {
    ddList('Employees', ['Name', 'Username', 'Role', 'Phone', 'Email'],
      accounts.map(a => [ddDash(a.name), ddDash(a.username), ddDash(ddPretty(a.role)), ddDash(a.phone), ddDash(a.email)]));
  } else if (key === 'services') {
    const list = services.filter(s => s.status !== 'completed' && s.status !== 'rejected');
    ddList('Active services', ['Product', 'Product ID', 'Model No', 'Assigned to', 'Status'],
      list.map(s => { const p = serviceProduct(s); return [ddEsc(p.name), ddEsc(p.id), ddEsc(p.model), ddEsc(assigneeName(s)), ddBadge(s.status, SERVICE_STATUS_CLASS[s.status] || 'pending')]; }),
      i => openServiceDetail(list[i]));
  }
}

function openStock(kind) {
  const f = { available: i => stockQty(i) > LOW_STOCK_LIMIT, low: i => stockQty(i) > 0 && stockQty(i) <= LOW_STOCK_LIMIT, out: i => stockQty(i) === 0 }[kind];
  const list = dashState.inventory.filter(f);
  ddList({ available: 'Stock available', low: 'Low stock items', out: 'Out of stock' }[kind], INV_HEADS, list.map(invRow), i => openInventoryItem(list[i]));
}

let detailsReady = false;
function initDetails() {
  if (detailsReady) return;           // listeners are attached only once
  detailsReady = true;
  dd.modal = document.getElementById('ddModal');
  dd.body = document.getElementById('ddBody');
  dd.title = document.getElementById('ddTitle');
  if (!dd.modal) return;

  document.getElementById('ddClose').addEventListener('click', ddClose);
  dd.modal.addEventListener('click', e => { if (e.target === dd.modal) ddClose(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ddClose(); });

  dd.body.addEventListener('click', e => {
    if (e.target.closest('.dd-back')) {
      const p = dd.stack.pop();
      if (p) { dd.title.textContent = p.t; dd.body.innerHTML = p.h; dd.rowFn = p.fn; }
      return;
    }
    const tr = e.target.closest('tr.dd-row');
    if (tr && dd.rowFn) dd.rowFn(Number(tr.dataset.i));
  });

  const activate = (el, fn) => {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  document.querySelectorAll('[data-card]').forEach(el => activate(el, () => openCard(el.dataset.card)));
  document.querySelectorAll('[data-stock]').forEach(el => activate(el, () => openStock(el.dataset.stock)));
}