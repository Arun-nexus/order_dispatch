const orderState = { orders: [], activeOrderId: null };
const invLookup = { products: [] };
let ordersPage = 1;
const ORDERS_PAGE_SIZE = 7;

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
  injectCreateModal();
  loadOrders();
  loadInventoryForOrders();
  wireHeaderButtons();
  wireFilter();
  wireDetailModals();
  loadOrderRequests();
});

async function loadInventoryForOrders() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) return;
    const data = await res.json();
    invLookup.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

function findStock(productId) {
  const id = productId.trim();
  return invLookup.products
    .filter(p => p.product_id === id)
    .reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
}

async function loadOrders() {
  try {
    const res = await apiFetch('/order/');
    if (!res.ok) throw new Error('failed to fetch orders');
    const data = await res.json();
    orderState.orders = (data.dataset || []).slice().reverse();
    ordersPage = 1;
    renderOrdersTable(orderState.orders);
    updateCards(orderState.orders);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load order data.');
    }
  }
}

function updateCards(orders) {
  const cardValues = document.querySelectorAll('.cards .card h2');
  if (!cardValues.length) return;
  const today = new Date().toDateString();
  const todaysOrders = orders.filter(o => o.order_date && new Date(o.order_date).toDateString() === today);
  cardValues[0].textContent = orders.length;
  if (cardValues[1]) cardValues[1].textContent = todaysOrders.length;
  if (cardValues[2]) cardValues[2].textContent = orders.filter(o => o.status === 'placed').length;
  if (cardValues[3]) cardValues[3].textContent = orders.filter(o => o.status === 'delivered').length;
  if (cardValues[4]) cardValues[4].textContent = orders.filter(o => o.status === 'cancelled').length;
}

function statusClass(status) {
  const map = { placed: 'pending', delivered: 'delivered', cancelled: 'cancel' };
  return map[status] || 'pending';
}

function orderCreatorLabel(o) {
  const c = o.creator;
  if (!c) return '-';
  if (c.type === 'request') return `${c.raised_by ?? '-'} → ${c.approved_by ?? '-'}`;
  return c.created_by ?? '-';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function openOrderHistoryModal(o) {
  if (!o) return;
  const modal = document.getElementById('orderHistoryModal');
  const list = modal?.querySelector('.history-list');
  if (!modal || !list) return;

  const fmt = ts => ts ? new Date(ts).toLocaleString('en-GB') : '-';
  const entries = [];

  entries.push(`
    <div style="border-left:3px solid #1665ff;padding-left:10px;">
      <strong>Created by ${escapeHtml(orderCreatorLabel(o))}</strong>
      <div style="color:#94a3b8;font-size:12px;">${fmt(o.order_date)}</div>
    </div>`);

  (o.edit_history || []).forEach(h => {
    entries.push(`
      <div style="border-left:3px solid #f59e0b;padding-left:10px;">
        <strong>Edited by ${escapeHtml(h.edited_by)}</strong>
        <div style="color:#94a3b8;font-size:12px;">${fmt(h.edited_at)}</div>
        <div style="margin-top:4px;">${escapeHtml(h.remark)}</div>
      </div>`);
  });

  list.innerHTML = entries.join('');
  modal.style.display = 'flex';
}

function renderOrdersTable(orders) {
  const sorted = [...orders].sort((a, b) =>
    new Date(b.order_date || b.created_at || 0) - new Date(a.order_date || a.created_at || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / ORDERS_PAGE_SIZE));
  ordersPage = Math.min(Math.max(1, ordersPage), totalPages);
  const start = (ordersPage - 1) * ORDERS_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + ORDERS_PAGE_SIZE);

  const tbody = document.querySelector('table tbody');
  tbody.innerHTML = '';

  const role = getRole();
  const canManage = role === 'admin' || role === 'employee';

  pageRows.forEach(o => {
    const tr = document.createElement('tr');
    tr.dataset.orderId = o.order_id;
    const items = o.items || [];
    const firstItem = items[0] || {};
    const productLabel = items.length
      ? `${firstItem.product_name ?? ''}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
      : (o.product_name ?? '');
    const productSubLabel = items.length === 1
      ? [firstItem.product_id, firstItem.model_no].filter(Boolean).join(' · ')
      : (items.length > 1 ? '' : [o.product_id, o.model_no].filter(Boolean).join(' · '));
    const serialLabel = items.length
      ? (items.length === 1
          ? ((items[0].serial_numbers && items[0].serial_numbers.length) ? items[0].serial_numbers[0]: '-')
          : `${items.length} items`)
      : '-';
    const companyName = o.customer?.contractor_person ?? o.customer?.company_name ?? o.company_name ?? '';
    const creatorLabel = orderCreatorLabel(o);

    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td><button type="button" class="creator-cell" style="background:none;border:none;padding:0;color:#1665ff;cursor:pointer;font:inherit;text-align:left;" title="View who created and edited this order">${creatorLabel}</button></td>
      <td>${productLabel}${productSubLabel ? `<br><small style="color:#94a3b8;">${productSubLabel}</small>` : ''}</td>
      <td>${serialLabel}</td>
      <td>${companyName}</td>
      <td>${o.payment_mode ?? ''}</td>
      <td>${o.order_date ? new Date(o.order_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="${statusClass(o.status)}">${o.status ?? ''}</span></td>
      <td>₹${o.total_mrp ?? o.price ?? 0}</td>
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        ${canManage ? '<button class="icon-btn ellipsis-btn"><i class="fa-solid fa-ellipsis"></i></button>' : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => openViewOrderModal(rowOrder(e))));
  tbody.querySelectorAll('.ellipsis-btn').forEach(btn => btn.addEventListener('click', e => openOrderActionMenu(rowOrder(e), e)));
  tbody.querySelectorAll('.creator-cell').forEach(btn => btn.addEventListener('click', e => openOrderHistoryModal(rowOrder(e))));

  renderTablePagination(document.querySelector('.pagination'), ordersPage, totalPages, p => {
    ordersPage = p;
    renderOrdersTable(orders);
  });
}

function rowOrder(e) {
  const tr = e.target.closest('tr');
  return orderState.orders.find(o => o.order_id === tr.dataset.orderId);
}

// ---------- Order action menu (Edit / Update Status) ----------
function openOrderActionMenu(o, evt) {
  if (!o) return;
  closeOrderActionMenu();

  const btn = evt.target.closest('button');
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.id = 'orderActionMenu';
  // position:fixed (not absolute) — getBoundingClientRect() is viewport-relative,
  // so the menu must use the same coordinate system, otherwise it drifts away
  // from the button as soon as the page is scrolled.
  menu.style.cssText = 'position:fixed;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1200;min-width:160px;';

  const items = [
    { label: 'Edit', action: () => openEditOrderModal(o) },
    { label: 'Update Status', action: () => openOrderStatusModal(o) },
  ];

  items.forEach(item => {
    const b = document.createElement('button');
    b.textContent = item.label;
    b.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;border-radius:6px;cursor:pointer;font-size:14px;';
    b.onmouseenter = () => b.style.background = '#f1f5f9';
    b.onmouseleave = () => b.style.background = 'none';
    b.addEventListener('click', () => { closeOrderActionMenu(); item.action(); });
    menu.appendChild(b);
  });

  document.body.appendChild(menu);

  // Estimate menu size (it's off-DOM-flow so offsetHeight is only accurate
  // once appended) and flip/clamp so it always stays anchored to the button
  // and never runs off the edge of the screen.
  const menuRect = menu.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpwards = spaceBelow < menuRect.height + 10 && rect.top > menuRect.height + 10;

  menu.style.top = openUpwards ? `${rect.top - menuRect.height - 6}px` : `${rect.bottom + 6}px`;
  const left = Math.min(Math.max(10, rect.left - 120), window.innerWidth - menuRect.width - 10);
  menu.style.left = `${left}px`;

  setTimeout(() => {
    document.addEventListener('click', closeOrderActionMenuOnClickAway);
    window.addEventListener('scroll', closeOrderActionMenu, { capture: true, once: true });
    window.addEventListener('resize', closeOrderActionMenu, { once: true });
  }, 0);
}

function closeOrderActionMenu() {
  const existing = document.getElementById('orderActionMenu');
  if (existing) existing.remove();
  document.removeEventListener('click', closeOrderActionMenuOnClickAway);
  window.removeEventListener('scroll', closeOrderActionMenu, { capture: true });
  window.removeEventListener('resize', closeOrderActionMenu);
}

function closeOrderActionMenuOnClickAway(e) {
  const menu = document.getElementById('orderActionMenu');
  if (menu && !menu.contains(e.target)) closeOrderActionMenu();
}

function openEditOrderModal(o) {
  orderState.activeOrderId = o.order_id;
  const modal = document.getElementById('editOrderModal');
  if (!modal) return;
  const inputs = modal.querySelectorAll('input');
  const select = modal.querySelector('select');
  const remarkBox = modal.querySelector('.edit-remark');
  const item = o.items?.[0] || {};
  const customer = o.customer || {};
  inputs[0].value = item.product_name ?? '';
  inputs[1].value = item.product_id ?? '';
  inputs[2].value = item.quantity ?? 1;
  inputs[3].value = (item.serial_numbers && item.serial_numbers[0]) ?? '';
  inputs[4].value = customer.company_name ?? '';
  inputs[5].value = customer.gst_number ?? '';
  inputs[6].value = item.price ?? '';
  inputs[7].value = item.tax_rate ?? '';
  inputs[8].value = o.discount ?? 0;
  if (remarkBox) remarkBox.value = ''; // every edit needs its own fresh remark
  if (select) [...select.options].forEach(opt => opt.selected = opt.value === o.payment_mode);
  modal.style.display = 'flex';
}

function openOrderStatusModal(o) {
  orderState.activeOrderId = o.order_id;
  const modal = document.getElementById('orderStatusModal');
  if (!modal) return;
  const select = modal.querySelector('select');
  const reasonBox = modal.querySelector('.cancel-reason');
  if (select) [...select.options].forEach(opt => opt.selected = opt.value === o.status);
  if (reasonBox) {
    reasonBox.value = o.status === 'cancelled' ? (o.cancel_reason || '') : '';
    reasonBox.style.display = o.status === 'cancelled' ? 'block' : 'none';
  }
  modal.style.display = 'flex';
}

function wireHeaderButtons() {
  const exportBtn = document.querySelector('.top-actions .export');
  if (exportBtn) exportBtn.addEventListener('click', exportOrdersCSV);
  // New Order button is wired inside injectCreateModal() so it can reset wizard state first.

  const searchInput = document.querySelector('header input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const filtered = orderState.orders.filter(o =>
        (o.order_id || '').toLowerCase().includes(term) ||
        (o.items || []).some(it => (it.product_name || '').toLowerCase().includes(term)) ||
        (o.items || []).some(it => (it.serial_numbers || []).some(sn => (sn || '').toLowerCase().includes(term))) ||
        (o.customer?.company_name || o.company_name || '').toLowerCase().includes(term)
      );
      orderState.currentBase = filtered;
      ordersPage = 1;
      renderOrdersTable(applySort(filtered));
    });
  }

  wireSortBy();
}

function applySort(list) {
  const sortBy = document.getElementById('orderSortBy')?.value || 'newest';
  const sorted = [...list];
  switch (sortBy) {
    case 'oldest': sorted.sort((a, b) => new Date(a.order_date || 0) - new Date(b.order_date || 0)); break;
    case 'amount_high': sorted.sort((a, b) => (Number(b.total_mrp) || 0) - (Number(a.total_mrp) || 0)); break;
    case 'amount_low': sorted.sort((a, b) => (Number(a.total_mrp) || 0) - (Number(b.total_mrp) || 0)); break;
    case 'order_id': sorted.sort((a, b) => (a.order_id || '').localeCompare(b.order_id || '')); break;
    default: sorted.sort((a, b) => new Date(b.order_date || 0) - new Date(a.order_date || 0));
  }
  return sorted;
}

function wireSortBy() {
  const filterSection = document.querySelector('.filter-section');
  if (!filterSection || document.getElementById('orderSortBy')) return;
  const box = document.createElement('div');
  box.className = 'filter-box';
  box.innerHTML = `
    <i class="fa-solid fa-arrow-down-wide-short"></i>
    <select id="orderSortBy">
      <option value="newest">Newest First</option>
      <option value="oldest">Oldest First</option>
      <option value="amount_high">Amount: High to Low</option>
      <option value="amount_low">Amount: Low to High</option>
      <option value="order_id">Order ID</option>
    </select>`;
  const filterBtn = filterSection.querySelector('.filter-btn');
  filterSection.insertBefore(box, filterBtn);

  document.getElementById('orderSortBy').addEventListener('change', () => {
    const base = orderState.currentBase || orderState.orders;
    ordersPage = 1;
    renderOrdersTable(applySort(base));
  });
}

// ---------- Apply Filter (Status / Payment Mode / Date) ----------
function wireFilter() {
  const filterBtn = document.querySelector('.filter-btn');
  if (!filterBtn) return;

  filterBtn.addEventListener('click', () => {
    const selects = document.querySelectorAll('.filter-section select');
    const dateInput = document.querySelector('.filter-section input[type="date"]');
    const statusVal = selects[0]?.value || '';
    const paymentVal = selects[1]?.value || '';
    const dateVal = dateInput?.value || '';

    const statusMap = { 'Pending': 'placed', 'Processing': 'processing', 'Delivered': 'delivered', 'Cancelled': 'cancelled' };
    const wantedStatus = statusMap[statusVal];

    const filtered = orderState.orders.filter(o => {
      const statusOk = !wantedStatus || o.status === wantedStatus;
      const paymentOk = !paymentVal || o.payment_mode === paymentVal;
      const dateOk = !dateVal || (o.order_date && new Date(o.order_date).toISOString().slice(0, 10) === dateVal);
      return statusOk && paymentOk && dateOk;
    });

    orderState.currentBase = filtered;
    ordersPage = 1;
    renderOrdersTable(applySort(filtered));
  });
}

function exportOrdersCSV() {
  openExportWizard({
    title: 'Export Orders',
    statusOptions: ['placed', 'processing', 'delivered', 'cancelled'],
    dateField: 'order_date',
    dateLabel: 'Order Date',
    getRows: () => orderState.orders,
    onConfirm: (rows) => {
      const header = ['Order ID', 'Products', 'Company', 'Payment Mode', 'Status', 'Total'];
      const csvRows = rows.map(o => [
        o.order_id,
        (o.items || []).map(it => `${it.product_name} x${it.quantity}`).join(' | '),
        o.customer?.company_name ?? o.company_name ?? '',
        o.payment_mode,
        o.status,
        o.total_mrp
      ]);
      downloadCSV(header, csvRows, 'orders.csv');
    }
  });
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function downloadCSV(header, rows, filename) {
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function openExportWizard({ title, statusOptions, dateField, dateLabel, getRows, onConfirm }) {
  let modal = document.getElementById('exportWizardModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'exportWizardModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1200;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:360px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>${title}</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:#64748b;">Status</label>
        <select name="status" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  modal.querySelector('#exportWizardForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = fd.get('status');
    const dateFrom = fd.get('dateFrom');
    const dateTo = fd.get('dateTo');

    const filtered = getRows().filter(row => {
      if (status && row.status !== status) return false;
      if (dateField && (dateFrom || dateTo)) {
        const rowDate = row[dateField] ? new Date(row[dateField]) : null;
        if (!rowDate) return false;
        if (dateFrom && rowDate < new Date(dateFrom)) return false;
        if (dateTo && rowDate > new Date(dateTo + 'T23:59:59')) return false;
      }
      return true;
    });

    modal.style.display = 'none';
    onConfirm(filtered);
  });

  modal.style.display = 'flex';
}

// ---------- View / Track / Deliver overlay modals ----------
function paymentDetailsLabel(o) {
  const mode = o.payment_mode;
  const d = o.payment_details || {};
  if (mode === 'Credit') return `Credit — ${d.credit_days ?? '-'} days`;
  if (mode === 'Cheque') return `Cheque #${d.cheque_number ?? '-'} (${d.cheque_date ?? '-'})${d.bank_name ? ', ' + d.bank_name : ''}`;
  if (mode === 'DemandDraft') return `DD #${d.dd_number ?? '-'} (${d.dd_date ?? '-'})${d.bank_name ? ', ' + d.bank_name : ''}`;
  if (mode === 'UPI') return `UPI — ${d.upi_id ?? '-'}`;
  if (mode === 'NetBanking') return `Net Banking — ${d.bank_name ?? '-'}, A/C ${d.account_number ?? '-'}, IFSC ${d.ifsc_code ?? '-'}`;
  if (mode === 'Cash') return `Cash — received by ${d.received_by ?? '-'}`;
  return mode || '-';
}

function openViewOrderModal(o) {
  if (!o) return;
  const modal = document.getElementById('viewOrderModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const items = o.items || [];
  const customer = o.customer || {};

  const itemsRows = items.length
    ? items.map(it => `<tr>
        <td>${it.product_name ?? ''}${it.serial_numbers?.length ? `<br><small style="color:#94a3b8;">${it.serial_numbers.join(', ')}</small>` : ''}</td>
        <td>${it.quantity ?? 0}</td>
        <td>₹${it.price ?? 0}</td>
        <td>${it.tax_rate ?? 0}%</td>
        <td>₹${(it.line_total ?? ((it.price || 0) * (it.quantity || 0))).toFixed ? (it.line_total ?? ((it.price || 0) * (it.quantity || 0))).toFixed(2) : it.line_total}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No items</td></tr>`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Order Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Order ID</small><p>${o.order_id ?? ''}</p></div>
    <div class="detail"><small>Company</small><p>${customer.company_name ?? '-'}</p></div>
    <div class="detail"><small>GST Number</small><p>${customer.gst_number ?? '-'}</p></div>
    <div class="detail"><small>Contact name and number </small><p>${customer.contractor_person ?? '-'} (${customer.contractor_number ?? '-'})</p></div>
    <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:#fff;">
        <th>Product</th><th>Qty</th><th>Price</th><th>Tax</th><th>Line Total</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    ${(o.spare_parts || []).length ? `
    <div class="detail"><small>Spare Parts</small></div>
    <table style="width:100%;font-size:13px;margin:0 0 10px;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:#fff;">
        <th>Name</th><th>Qty</th><th>Price</th>
      </tr></thead>
      <tbody>${o.spare_parts.map(sp => `<tr>
        <td>${sp.name ?? ''}</td><td>${sp.quantity ?? 0}</td><td>₹${sp.price ?? 0}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}
    <div class="detail"><small>Payment</small><p>${paymentDetailsLabel(o)}</p></div>
    <div class="detail"><small>Status</small><p>${o.status ?? ''}</p></div>
    <div class="detail"><small>Cancellation Reason</small><p>${o.status === 'cancelled' ? (o.cancel_reason || '-') : '-'}</p></div>
    <div class="detail"><small>Warranty</small><p>${(o.warranty_years ?? 1) > 1 ? `${o.warranty_years} Years (Extended, +₹${o.warranty_charge ?? 0})` : 'Standard (1 Year)'}</p></div>
    <div class="detail"><small>Subtotal / Tax / Discount</small><p>₹${o.subtotal ?? 0} / ₹${(o.tax_total ?? 0).toFixed ? o.tax_total.toFixed(2) : o.tax_total} / ₹${o.discount ?? 0}</p></div>
    <div class="detail"><small>Total Amount</small><p>₹${o.total_mrp ?? 0}</p></div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireDetailModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const editForm = document.querySelector('#editOrderModal form');
  if (editForm) {
    editForm.addEventListener('submit', async e => {
      e.preventDefault();
      const inputs = editForm.querySelectorAll('input');
      const select = editForm.querySelector('select');
      const quantity = Math.max(1, Math.floor(Number(inputs[2].value)) || 1);
      const price = Number(inputs[6].value);
      const tax_rate = Number(inputs[7].value);
      const discount = Number(inputs[8].value || 0);
      const remarkBox = editForm.querySelector('.edit-remark');
      const remark = remarkBox ? remarkBox.value.trim() : '';
      if (!remark) {
        alert('Please add a remark describing this edit.');
        remarkBox?.focus();
        return;
      }
      const updated_order_value = {
        product_name: inputs[0].value,
        quantity,
        serial_no: inputs[3].value.trim().toLowerCase(),
        company_name: inputs[4].value,
        gst_number: inputs[5].value,
        price,
        tax_rate,
        discount,
        payment_mode: select ? select.value : undefined,
        remark
      };
      try {
        const res = await apiFetch(`/order/update/${orderState.activeOrderId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updated_order_value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'update failed');
        document.getElementById('editOrderModal').style.display = 'none';
        await loadOrders();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    });
  }

  const statusForm = document.querySelector('#orderStatusModal form');
  if (statusForm) {
    const statusSelect = statusForm.querySelector('select');
    const reasonBox = statusForm.querySelector('.cancel-reason');
    if (statusSelect && reasonBox) {
      statusSelect.addEventListener('change', () => {
        reasonBox.style.display = statusSelect.value === 'cancelled' ? 'block' : 'none';
      });
    }
    statusForm.addEventListener('submit', async e => {
      e.preventDefault();
      const select = statusForm.querySelector('select');
      const newStatus = select.value;
      const reason = reasonBox ? reasonBox.value.trim() : '';
      if (newStatus === 'cancelled' && !reason) {
        alert('Please provide a reason for cancellation.');
        return;
      }
      const updated_order_value = { status: newStatus };
      if (newStatus === 'cancelled') updated_order_value.cancel_reason = reason;
      try {
        const res = await apiFetch(`/order/update/${orderState.activeOrderId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updated_order_value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'status update failed');
        document.getElementById('orderStatusModal').style.display = 'none';
        await loadOrders();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    });
  }
}

// ---------- New Order wizard ----------
const wiz = {
  customerId: '',      // set when existing customer picked
  customer: null,      // {company_name, company_address, gst_number, contractor_person, contractor_number, contractor_email}
  cart: {},             // product_id -> {product_id, product_name, price, tax_rate, quantity}
  paymentMode: '',
  discount: 0,
  warrantyYears: 1,
  warrantyCharge: 0
};

const PAYMENT_MODES = [
  { value: 'Credit', label: 'Credit' },
  { value: 'NetBanking', label: 'Net Banking' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'DemandDraft', label: 'Demand Draft' },
  { value: 'Cash', label: 'Cash' },
];

function resetWizard() {
  wiz.customerId = '';
  wiz.customer = null;
  wiz.cart = {};
  wiz.paymentMode = '';
  wiz.discount = 0;
  wiz.warrantyYears = 1;
  wiz.warrantyCharge = 0;
}

function injectCreateModal() {
  const modal = document.createElement('div');
  modal.id = 'createModal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;justify-content:center;align-items:center;z-index:999;';
  modal.innerHTML = `
    <div id="wizardBox" style="background:#fff;border-radius:14px;padding:24px;width:460px;max-height:86vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 id="wizardTitle">New Order</h3>
        <button type="button" id="wizardClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <div id="wizardBody"></div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#wizardClose').addEventListener('click', () => closeModal('createModal'));
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal('createModal'); });

  const newOrderBtn = document.querySelector('.top-actions .add-product');
  if (newOrderBtn) newOrderBtn.addEventListener('click', () => { resetWizard(); openModal('createModal'); renderCustomerTypeStep(); });
}

function wizardBody() { return document.getElementById('wizardBody'); }
function wizardTitle(t) { document.getElementById('wizardTitle').textContent = t; }

// Step 1: existing vs new customer
function renderCustomerTypeStep() {
  wizardTitle('New Order — Customer');
  wizardBody().innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Is this order for an existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing Customer
      </button>
      <button id="btnNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New Customer
      </button>
    </div>`;
  document.getElementById('btnExisting').addEventListener('click', renderExistingCustomerStep);
  document.getElementById('btnNew').addEventListener('click', renderNewCustomerStep);
}

// Step 2a: search + pick existing customer
function renderExistingCustomerStep() {
  wizardTitle('New Order — Select Customer');
  wizardBody().innerHTML = `
    <input id="custSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="custResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="display:flex;justify-content:flex-start;margin-top:14px;">
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
        <div class="cust-row" data-id="${c.customer_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div>
            <strong>${c.company_name ?? ''}</strong><br>
            <small style="color:#64748b;">${c.gst_number ?? ''} • ${c.contractor_person ?? ''} • ${c.contractor_number ?? ''}</small>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button type="button" class="cust-edit icon-btn" data-id="${c.customer_id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="cust-delete icon-btn" data-id="${c.customer_id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`).join('');
      resultsBox.querySelectorAll('.cust-row').forEach(row => row.addEventListener('click', () => {
        const c = list.find(x => x.customer_id === row.dataset.id);
        wiz.customerId = c.customer_id;
        wiz.customer = c;
        renderProductsStep();
      }));
      resultsBox.querySelectorAll('.cust-edit').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const c = list.find(x => x.customer_id === btn.dataset.id);
        renderEditCustomerForm(c);
      }));
      resultsBox.querySelectorAll('.cust-delete').forEach(btn => btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete this customer? This cannot be undone.')) return;
        try {
          const res = await apiFetch(`/customer/delete/${btn.dataset.id}`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || 'delete failed');
          runSearch();
        } catch (err) {
          if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
        }
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };

  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

// Edit an existing customer from the search results
function renderEditCustomerForm(c) {
  wizardTitle('Edit Customer');
  wizardBody().innerHTML = `
    <form id="editCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company Name" value="${c.company_name ?? ''}" required>
      <input name="company_address" placeholder="Company Address" value="${c.company_address ?? ''}" required>
      <input name="gst_number" placeholder="GST Number" value="${c.gst_number ?? ''}" required>
      <input name="contractor_person" placeholder="Contractor Person" value="${c.contractor_person ?? ''}" required>
      <input name="contractor_number" placeholder="Contractor Number" value="${c.contractor_number ?? ''}" required>
      <input name="contractor_email" type="email" placeholder="Contractor Email" value="${c.contractor_email ?? ''}" required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="cancelEditCust" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Save</button>
      </div>
    </form>`;
  document.getElementById('cancelEditCust').addEventListener('click', renderExistingCustomerStep);
  document.getElementById('editCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const updated_values = {
      company_name: fd.get('company_name'),
      company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'),
      contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'),
      contractor_email: fd.get('contractor_email'),
    };
    try {
      const res = await apiFetch(`/customer/update/${c.customer_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      renderExistingCustomerStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// Step 2b: new customer form
function renderNewCustomerStep() {
  wizardTitle('New Order — New Customer');
  wizardBody().innerHTML = `
    <form id="newCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Customer Name" required>
      <input name="company_address" placeholder="customer Address" required>
      <input name="gst_number" placeholder="GST Number(if applicable)">
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email" required>
      <div style = padding-left:5px;><small><p>Credit Limit</p></small></div>
      <input name="credit_limit" type="number" min="0" step="0.01" placeholder="Credit Limit (₹)" value="0">
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
      company_name: fd.get('company_name'),
      company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'),
      contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'),
      contractor_email: fd.get('contractor_email'),
      credit_limit: Number(fd.get('credit_limit')) || 0,
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      wiz.customerId = data.customer_id;
      wiz.customer = data.customer || payload;
      renderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// Step 3: product picker with quantity per row
function renderProductsStep() {
  wizardTitle(`New Order — ${wiz.customer?.company_name ?? 'Products'}`);
  // Inventory stores one document per lot/purchase-batch, so the same
  // product_id can appear as several separate rows here (e.g. 3 lots of
  // 50+80+73). Rows are still listed one-per-lot exactly as before (nothing
  // that used to be visible disappears) — only the "Stock" number and the
  // quantity cap are computed from the TOTAL across all of that product's
  // lots, to match what the backend's get_available_quantity() actually
  // checks against (it also sums across lots by product_id).
  const products = invLookup.products || [];
  const totalQtyByProductId = new Map();
  for (const p of products) {
    const key = p.product_id;
    totalQtyByProductId.set(key, (totalQtyByProductId.get(key) || 0) + (Number(p.quantity) || 0));
  }
  const stockFor = (p) => totalQtyByProductId.get(p.product_id) ?? (Number(p.quantity) || 0);

  wizardBody().innerHTML = `
    <div id="prodCatTabs" style="display:flex;gap:8px;margin-bottom:10px;"></div>
    <input id="prodFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="margin-top:14px;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;">
          <th>Product</th><th>Stock</th><th>Price</th><th style="width:70px;">Qty</th>
        </tr></thead>
        <tbody id="prodRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backBtn3" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="toPaymentBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Create Order</button>
    </div>`;

  document.getElementById('backBtn3').addEventListener('click', () => wiz.customerId ? renderExistingCustomerStep() : renderNewCustomerStep());

  // ---------- Category tabs: Products / Accessories / Spare Parts ----------
  // Filters the same product table by product_type, same pattern as the
  // category tabs on the Inventory page.
  const catTabsBox = document.getElementById('prodCatTabs');
  const categories = [
    { type: 'product', label: 'Products' },
    { type: 'accessories', label: 'Accessories' },
    { type: 'spare_parts', label: 'Spare Parts' }
  ];
  let activeCategory = 'product';

  function paintCatTab(btn, active) {
    btn.style.border = active ? '1px solid #1665ff' : '1px solid #e2e8f0';
    btn.style.background = active ? '#eaf1ff' : '#f8fafc';
    btn.style.color = active ? '#1665ff' : '#334155';
    btn.style.borderRadius = '8px';
    btn.style.padding = '8px 14px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
  }

  catTabsBox.innerHTML = categories.map(c => `<button type="button" class="prod-cat-btn" data-type="${c.type}">${c.label}</button>`).join('');
  catTabsBox.querySelectorAll('.prod-cat-btn').forEach(btn => {
    paintCatTab(btn, btn.dataset.type === activeCategory);
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.type;
      catTabsBox.querySelectorAll('.prod-cat-btn').forEach(b => paintCatTab(b, b.dataset.type === activeCategory));
      applyFilters();
    });
  });

  const rowsBox = document.getElementById('prodRows');

  function productRowHtml(p) {
    const qtyInCart = wiz.cart[p.product_id]?.quantity ?? '';
    return `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}${p.model_no ? ' · ' + p.model_no : ''}</small></td>
        <td>${stockFor(p)}</td>
        <td>₹${p.price ?? 0}</td>
        <td><input type="number" min="0" inputmode="numeric" value="${qtyInCart}"
              placeholder="0" data-product-id="${p.product_id}" class="qtyInput"
              style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`;
  }

  function renderRows(list) {
    rowsBox.innerHTML = list.map(productRowHtml).join('');
  }

  function computeTypedQty(inp) {
    if (inp.value.trim() === '') return null;
    let qty = Math.floor(Math.max(0, Number(inp.value)));
    if (!Number.isFinite(qty)) qty = 0;
    return qty;
  }

  function applyQtyToCart(productId, p, qty) {
    if (qty === null || qty <= 0) {
      delete wiz.cart[productId];
      return;
    }
    wiz.cart[productId] = {
      product_id: p.product_id,
      product_name: p.product_name,
      model_no: p.model_no || '',
      price: Number(p.price) || 0,
      tax_rate: Number(p.tax_rate) || 0,
      quantity: qty
    };
  }

  // One delegated listener on the container, attached ONCE — survives every
  // re-render from the filter box, so there's no risk of listeners not being
  // (re)attached to freshly created rows.
  //
  // IMPORTANT: this only reads the field and updates the cart — it never
  // rewrites inp.value while the user is mid-keystroke. Doing that used to
  // move the caret to the end of the field on every digit typed, which on
  // mobile keyboards made it impossible to type more than one digit (each
  // new digit landed in the wrong place or got wiped by the cap). The stock
  // cap is enforced separately, only once the user leaves the field.
  rowsBox.addEventListener('input', (e) => {
    const inp = e.target.closest('.qtyInput');
    if (!inp) return;

    const productId = inp.dataset.productId;
    const p = products.find(x => x.product_id === productId);
    if (!p) return;

    applyQtyToCart(productId, p, computeTypedQty(inp));
  });

  // Enforce the stock cap once the user is done typing (blur doesn't bubble,
  // so this needs capture:true to work through delegation).
  rowsBox.addEventListener('blur', (e) => {
    const inp = e.target.closest('.qtyInput');
    if (!inp) return;

    const productId = inp.dataset.productId;
    const p = products.find(x => x.product_id === productId);
    if (!p) return;

    let qty = computeTypedQty(inp);
    if (qty === null) return;

    // only enforce a cap when we actually have a real stock number for this
    // product — missing/undefined stock data should never silently zero out
    // what the user is typing. Use the TOTAL across all of this product's
    // lots (stockFor), not just this one row's lot, so ordering more than a
    // single lot but less than the true total isn't wrongly capped/rejected.
    const stock = stockFor(p);
    const hasKnownStock = Number.isFinite(stock);
    if (hasKnownStock) {
      if (qty > stock) {
        qty = stock;
        inp.value = qty || '';
        alert(stock > 0
          ? `Only ${stock} unit(s) of ${p.product_name} are in stock — quantity adjusted.`
          : `${p.product_name} is out of stock.`);
      }
    }

    applyQtyToCart(productId, p, qty);
  }, true);

  function currentCategoryProducts() {
    return products.filter(p => (p.product_type || 'product') === activeCategory);
  }

  function applyFilters() {
    const term = document.getElementById('prodFilter').value.trim().toLowerCase();
    const base = currentCategoryProducts();
    const filtered = term
      ? base.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term) || (p.model_no || '').toLowerCase().includes(term))
      : base;
    renderRows(filtered);
  }

  applyFilters();
  if (!products.length) {
    rowsBox.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:16px;color:#94a3b8;">
      No products loaded. <button type="button" id="retryInvBtn" style="border:none;background:#eef2ff;color:#2563eb;padding:4px 10px;border-radius:6px;cursor:pointer;">Retry</button>
    </td></tr>`;
    document.getElementById('retryInvBtn')?.addEventListener('click', async () => {
      await loadInventoryForOrders();
      renderProductsStep();
    });
  }

  document.getElementById('prodFilter').addEventListener('input', applyFilters);

  document.getElementById('toPaymentBtn').addEventListener('click', () => {
    if (!Object.keys(wiz.cart).length) { alert('Add quantity for at least one item — a product, accessory or spare part.'); return; }
    renderPaymentStep();
  });
}

// Step 4: payment mode + conditional fields + discount
function renderPaymentStep() {
  wizardTitle('New Order — Payment');
  const cartItems = Object.values(wiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  if (wiz.warrantyYears === undefined) wiz.warrantyYears = 1;
  if (wiz.warrantyCharge === undefined) wiz.warrantyCharge = 0;

  wizardBody().innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `${i.product_name} × ${i.quantity} = ₹${(i.price * i.quantity).toFixed(2)}`).join('<br>')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">
      Subtotal: ₹${subtotal.toFixed(2)}
    </div>
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#334155;">Warranty</label>
      <div style="display:flex;gap:14px;margin:8px 0;font-size:13px;">
        <label><input type="radio" name="warrantyChoice" value="standard" ${wiz.warrantyYears <= 1 ? 'checked' : ''}> Standard (1 Year)</label>
        <label><input type="radio" name="warrantyChoice" value="extend" ${wiz.warrantyYears > 1 ? 'checked' : ''}> Extend Warranty</label>
      </div>
      <div id="extendWarrantyBox" style="display:${wiz.warrantyYears > 1 ? 'flex' : 'none'};gap:10px;">
        <select id="warrantyYearsSelect" style="flex:1;padding:8px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="2" ${wiz.warrantyYears === 2 ? 'selected' : ''}>2 Years</option>
          <option value="3" ${wiz.warrantyYears === 3 ? 'selected' : ''}>3 Years</option>
          <option value="4" ${wiz.warrantyYears === 4 ? 'selected' : ''}>4 Years</option>
          <option value="5" ${wiz.warrantyYears === 5 ? 'selected' : ''}>5 Years</option>
        </select>
        <input id="warrantyChargeInput" type="number" min="0" placeholder="Additional Charge (₹)" value="${wiz.warrantyCharge || ''}" style="flex:1;padding:8px;border:1px solid #e2e8f0;border-radius:8px;">
      </div>
    </div>
    <select id="paymentMode" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
      <option value="">Select Payment Mode</option>
      ${PAYMENT_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
    </select>
    <div id="paymentExtra"></div>
    <div style = "padding-left:8px" ><small><p>Discount<p><small></div>
    <input id="discountInput" type="number" min="0" placeholder="Discount (₹)" value="0" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;">
    <div id="grandTotalBox" style="font-size:13px;color:#334155;margin-bottom:10px;"></div>
    <div style="display:flex;justify-content:space-between;margin-top:10px;">
      <button type="button" id="backBtn4" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="placeOrderBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Place Order</button>
    </div>`;

  document.getElementById('backBtn4').addEventListener('click', renderProductsStep);

  const modeSelect = document.getElementById('paymentMode');
  const extraBox = document.getElementById('paymentExtra');
  modeSelect.addEventListener('change', () => renderPaymentExtra(modeSelect.value, extraBox));

  const discountInput = document.getElementById('discountInput');
  const warrantyChargeInput = document.getElementById('warrantyChargeInput');
  const warrantyYearsSelect = document.getElementById('warrantyYearsSelect');
  const extendBox = document.getElementById('extendWarrantyBox');

  function refreshGrandTotal() {
    const total = subtotal - (wiz.discount || 0) + (wiz.warrantyCharge || 0);
    document.getElementById('grandTotalBox').textContent = `Grand Total (excl. tax): ₹${total.toFixed(2)}`;
  }

  discountInput.addEventListener('input', e => { wiz.discount = Number(e.target.value) || 0; refreshGrandTotal(); });

  document.querySelectorAll('[name="warrantyChoice"]').forEach(r => r.addEventListener('change', () => {
    if (r.value === 'extend' && r.checked) {
      wiz.warrantyYears = Number(warrantyYearsSelect?.value) || 2;
      extendBox.style.display = 'flex';
    } else if (r.value === 'standard' && r.checked) {
      wiz.warrantyYears = 1;
      wiz.warrantyCharge = 0;
      extendBox.style.display = 'none';
    }
    refreshGrandTotal();
  }));
  if (warrantyYearsSelect) warrantyYearsSelect.addEventListener('change', () => { wiz.warrantyYears = Number(warrantyYearsSelect.value) || 2; });
  if (warrantyChargeInput) warrantyChargeInput.addEventListener('input', e => { wiz.warrantyCharge = Number(e.target.value) || 0; refreshGrandTotal(); });

  refreshGrandTotal();
  document.getElementById('placeOrderBtn').addEventListener('click', () => submitOrder(modeSelect, extraBox));
}

function renderPaymentExtra(mode, extraBox) {
  if (mode === 'Credit') {
    extraBox.innerHTML = `
      <label style="font-size:13px;color:#64748b;">Credit Period</label>
      <select id="creditDaysSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
        <option value="15">15 days</option>
        <option value="30">30 days</option>
        <option value="45">45 days</option>
        <option value="60">60 days</option>
        <option value="manual">Other (enter days)</option>
      </select>
      <input id="creditDaysManual" type="number" min="1" max="60" placeholder="Enter days (max 60)" style="display:none;width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
    const sel = document.getElementById('creditDaysSelect');
    const manual = document.getElementById('creditDaysManual');
    sel.addEventListener('change', () => manual.style.display = sel.value === 'manual' ? 'block' : 'none');
  } else if (mode === 'Cheque') {
    extraBox.innerHTML = `
      <input id="chequeNumber" placeholder="Cheque Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="chequeDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="chequeBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'DemandDraft') {
    extraBox.innerHTML = `
      <input id="ddNumber" placeholder="Demand Draft Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="ddDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="ddBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'UPI') {
    extraBox.innerHTML = `
      <input id="upiId" placeholder="UPI ID (e.g. name@bank)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else if (mode === 'NetBanking') {
    extraBox.innerHTML = `
      <input id="nbBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbAccount" placeholder="Account Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbIfsc" placeholder="IFSC Code" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'Cash') {
    extraBox.innerHTML = `
      <input id="cashReceivedBy" placeholder="Received By (Person Name)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else {
    extraBox.innerHTML = '';
  }
}

function buildPaymentDetails(mode) {
  if (mode === 'Credit') {
    const sel = document.getElementById('creditDaysSelect');
    const manual = document.getElementById('creditDaysManual');
    const days = sel.value === 'manual' ? Number(manual.value) : Number(sel.value);
    if (!days || days < 1 || days > 60) throw new Error('Credit days must be between 1 and 60.');
    return { credit_days: days };
  }
  if (mode === 'Cheque') {
    const cheque_number = document.getElementById('chequeNumber').value.trim();
    const cheque_date = document.getElementById('chequeDate').value;
    const bank_name = document.getElementById('chequeBank').value.trim();
    if (!cheque_number || !cheque_date) throw new Error('Cheque number and date are required.');
    return { cheque_number, cheque_date, bank_name };
  }
  if (mode === 'DemandDraft') {
    const dd_number = document.getElementById('ddNumber').value.trim();
    const dd_date = document.getElementById('ddDate').value;
    const bank_name = document.getElementById('ddBank').value.trim();
    if (!dd_number || !dd_date) throw new Error('Demand draft number and date are required.');
    return { dd_number, dd_date, bank_name };
  }
  if (mode === 'UPI') {
    const upi_id = document.getElementById('upiId').value.trim();
    if (!upi_id) throw new Error('UPI ID is required.');
    return { upi_id };
  }
  if (mode === 'NetBanking') {
    const bank_name = document.getElementById('nbBank').value.trim();
    const account_number = document.getElementById('nbAccount').value.trim();
    const ifsc_code = document.getElementById('nbIfsc').value.trim();
    if (!bank_name || !account_number || !ifsc_code) throw new Error('Bank name, account number and IFSC code are required.');
    return { bank_name, account_number, ifsc_code };
  }
  if (mode === 'Cash') {
    const received_by = document.getElementById('cashReceivedBy').value.trim();
    if (!received_by) throw new Error('Received-by person name is required.');
    return { received_by };
  }
  return {};
}

async function submitOrder(modeSelect, extraBox) {
  const mode = modeSelect.value;
  if (!mode) { alert('Please select a payment mode.'); return; }

  if (wiz.warrantyYears > 1 && (!wiz.warrantyCharge || wiz.warrantyCharge <= 0)) {
    alert('Please enter the additional charge for the extended warranty.');
    return;
  }

  let payment_details;
  try {
    payment_details = buildPaymentDetails(mode);
  } catch (err) {
    alert(err.message);
    return;
  }

  const payload = {
    customer_id: wiz.customerId || '',
    customer: wiz.customer || {},
    items: Object.values(wiz.cart).map(i => ({
      product_id: i.product_id, product_name: i.product_name, model_no: i.model_no || '',
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: wiz.discount || 0,
    warranty_years: wiz.warrantyYears || 1,
    warranty_charge: wiz.warrantyYears > 1 ? (wiz.warrantyCharge || 0) : 0
  };

  try {
    const res = await apiFetch('/order/create_order/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'order creation failed');
    closeModal('createModal');
    resetWizard();
    await loadOrders();
    await loadInventoryForOrders();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
// ---------- Order Requests (raised by distributors) ----------
async function loadOrderRequests() {
  const role = getRole();
  if (role !== 'admin' && role !== 'employee') return;
  try {
    const res = await apiFetch('/request/');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    const pending = (data.dataset || []).filter(r => r.request_type === 'order' && r.status === 'pending');
    const section = document.getElementById('orderRequestsSection');
    if (section) section.style.display = pending.length ? '' : 'none';
    renderOrderRequests(pending);
  } catch (err) {
    console.error(err);
  }
}

function renderOrderRequests(requests) {
  const box = document.getElementById('orderRequestsList');
  if (!box) return;
  const sorted = [...requests].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  box.innerHTML = sorted.length ? sorted.map(r => {
    const productLabel = (r.details?.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    const customerLabel = r.details?.customer?.company_name || 'New customer';
    const subtotal = (r.details?.items || []).reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0);
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid fa-cart-shopping"></i></div>
          <div>
            <h4>${customerLabel}</h4>
            <p>${productLabel} — ₹${subtotal.toFixed(2)} • raised by ${r.raised_by ?? ''}</p>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="icon-btn oreq-approve" data-id="${r.request_id}" title="Approve"><i class="fa-solid fa-check" style="color:#16a34a;"></i></button>
          <button class="icon-btn oreq-reject" data-id="${r.request_id}" title="Reject"><i class="fa-solid fa-xmark" style="color:#d62828;"></i></button>
        </div>
      </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">No pending order requests.</p>';

  box.querySelectorAll('.oreq-approve').forEach(btn => btn.addEventListener('click', () => approveOrderRequest(btn.dataset.id)));
  box.querySelectorAll('.oreq-reject').forEach(btn => btn.addEventListener('click', () => rejectOrderRequest(btn.dataset.id)));
}

async function approveOrderRequest(requestId) {
  if (!confirm('Approve this request and create the order? Stock will be deducted.')) return;
  try {
    const res = await apiFetch(`/request/approve/${requestId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'approval failed');
    await loadOrders();
    await loadInventoryForOrders();
    await loadOrderRequests();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

async function rejectOrderRequest(requestId) {
  const reason = prompt('Reason for rejecting this request:') || '';
  try {
    const res = await apiFetch(`/request/reject/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'rejection failed');
    await loadOrderRequests();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}