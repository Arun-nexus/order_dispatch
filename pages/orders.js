const orderState = { orders: [], activeOrderId: null };
const invLookup = { products: [] };

document.addEventListener('DOMContentLoaded', () => {
  injectCreateModal();
  loadOrders();
  loadInventoryForOrders();
  wireHeaderButtons();
  wireFilter();
  wireDetailModals();
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
  const p = invLookup.products.find(p => p.product_id === productId.trim());
  return p ? Number(p.quantity) || 0 : null;
}

async function loadOrders() {
  try {
    const res = await apiFetch('/order/');
    if (!res.ok) throw new Error('failed to fetch orders');
    const data = await res.json();
    orderState.orders = data.dataset || [];
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

function renderOrdersTable(orders) {
  const tbody = document.querySelector('table tbody');
  tbody.innerHTML = '';

  const role = getRole();
  const canManage = role === 'admin' || role === 'employee';

  orders.forEach(o => {
    const tr = document.createElement('tr');
    tr.dataset.orderId = o.order_id;
    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td>${o.order_id?.slice(0, 8) ?? ''}</td>
      <td>${o.product_name ?? ''}</td>
      <td>${o.serial_no ?? '-'}</td>
      <td>${o.company_name ?? ''}</td>
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
}

function rowOrder(e) {
  const tr = e.target.closest('tr');
  return orderState.orders.find(o => o.order_id === tr.dataset.orderId);
}

// ---------- Order action menu (Edit / Update Status) ----------
function openOrderActionMenu(o, evt) {
  if (!o) return;
  closeOrderActionMenu();

  const menu = document.createElement('div');
  menu.id = 'orderActionMenu';
  menu.style.cssText = 'position:absolute;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1200;min-width:160px;';
  const rect = evt.target.closest('button').getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(10, rect.left - 120)}px`;

  const items = [
    { label: 'Edit', action: () => openEditOrderModal(o) },
    { label: 'Update Status', action: () => openOrderStatusModal(o) },
  ];

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;border-radius:6px;cursor:pointer;font-size:14px;';
    btn.onmouseenter = () => btn.style.background = '#f1f5f9';
    btn.onmouseleave = () => btn.style.background = 'none';
    btn.addEventListener('click', () => { closeOrderActionMenu(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeOrderActionMenuOnClickAway), 0);
}

function closeOrderActionMenu() {
  const existing = document.getElementById('orderActionMenu');
  if (existing) existing.remove();
  document.removeEventListener('click', closeOrderActionMenuOnClickAway);
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
  inputs[0].value = o.product_name ?? '';
  inputs[1].value = o.product_id ?? '';
  inputs[2].value = o.serial_no ?? '';
  inputs[3].value = o.company_name ?? '';
  inputs[4].value = o.gst_number ?? '';
  inputs[5].value = o.price ?? '';
  inputs[6].value = o.tax_rate ?? '';
  inputs[7].value = o.discount ?? 0;
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
  const newOrderBtn = document.querySelector('.top-actions .add-product');
  if (exportBtn) exportBtn.addEventListener('click', exportOrdersCSV);
  if (newOrderBtn) newOrderBtn.addEventListener('click', () => openModal('createModal'));

  const searchInput = document.querySelector('header input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const filtered = orderState.orders.filter(o =>
        (o.order_id || '').toLowerCase().includes(term) ||
        (o.product_name || '').toLowerCase().includes(term) ||
        (o.company_name || '').toLowerCase().includes(term)
      );
      renderOrdersTable(filtered);
    });
  }
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
      const paymentOk = !paymentVal || paymentVal.startsWith('All')
        || (o.payment_mode || '').toLowerCase().replace(/\s/g, '').includes(paymentVal.toLowerCase().replace(/\s/g, ''));
      const dateOk = !dateVal || (o.order_date && new Date(o.order_date).toISOString().slice(0, 10) === dateVal);
      return statusOk && paymentOk && dateOk;
    });

    renderOrdersTable(filtered);
  });
}

function exportOrdersCSV() {
  const header = ['Order ID', 'Product', 'Serial No', 'Company', 'Payment Mode', 'Status', 'Total'];
  const rows = orderState.orders.map(o => [o.order_id, o.product_name, o.serial_no, o.company_name, o.payment_mode, o.status, o.total_mrp]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'orders.csv';
  a.click();
}

// ---------- View / Track / Deliver overlay modals ----------
function openViewOrderModal(o) {
  if (!o) return;
  const modal = document.getElementById('viewOrderModal');
  if (!modal) return;
  const values = modal.querySelectorAll('.detail p');
  const fields = [
    o.order_id, o.product_name, o.serial_no || '-', o.company_name, o.gst_number,
    o.payment_mode, o.status, o.status === 'cancelled' ? (o.cancel_reason || '-') : '-',
    `₹${o.price ?? 0}  |  ${o.tax_rate ?? 0}%  |  ₹${o.discount ?? 0}`,
    `₹${o.total_mrp ?? o.price ?? 0}`
  ];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
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
      const price = Number(inputs[5].value);
      const tax_rate = Number(inputs[6].value);
      const discount = Number(inputs[7].value || 0);
      const updated_order_value = {
        product_name: inputs[0].value,
        serial_no: inputs[2].value,
        company_name: inputs[3].value,
        gst_number: inputs[4].value,
        price,
        tax_rate,
        discount,
        total_mrp: price + (tax_rate * price / 100) - discount,
        payment_mode: select ? select.value : undefined
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

// ---------- New Order modal ----------
function injectCreateModal() {
  const modal = document.createElement('div');
  modal.id = 'createModal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;justify-content:center;align-items:center;z-index:999;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:24px;width:420px;">
      <h3 style="margin-bottom:16px;">New Order</h3>
      <form id="createOrderForm" style="display:flex;flex-direction:column;gap:10px;">
        <input name="product_name" placeholder="Product Name" required>
        <input name="product_id" placeholder="Product ID" required>
        <small id="stockInfo" style="color:#64748b;"></small>
        <input name="serial_no" placeholder="Serial No" required>
        <input name="company_name" placeholder="Company Name" required>
        <input name="gst_number" placeholder="GST Number" required>
        <select name="payment_mode" required>
          <option value="">Payment Mode</option>
          <option value="UPI">UPI</option>
          <option value="Card">Card</option>
          <option value="Cash">Cash</option>
          <option value="NetBanking">Net Banking</option>
        </select>
        <input name="price" type="number" placeholder="Price" required>
        <input name="tax_rate" type="number" placeholder="Tax Rate (%)" required>
        <input name="discount" type="number" placeholder="Discount" value="0">
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" id="cancelCreateOrder" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Cancel</button>
          <button type="submit" class="primary" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Create</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);

  const productIdInput = modal.querySelector('input[name="product_id"]');
  const stockInfo = modal.querySelector('#stockInfo');
  productIdInput.addEventListener('input', () => {
    const stock = findStock(productIdInput.value);
    if (!productIdInput.value.trim()) { stockInfo.textContent = ''; return; }
    if (stock === null) { stockInfo.textContent = 'Product not found in inventory'; stockInfo.style.color = '#d62828'; }
    else if (stock <= 0) { stockInfo.textContent = 'Out of stock'; stockInfo.style.color = '#d62828'; }
    else { stockInfo.textContent = `In stock: ${stock} units available`; stockInfo.style.color = '#22c55e'; }
  });

  modal.querySelector('#cancelCreateOrder').addEventListener('click', () => closeModal('createModal'));
  modal.querySelector('#createOrderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const stock = findStock(fd.get('product_id'));
    if (stock === null) { alert('Product ID not found in inventory.'); return; }
    if (stock <= 0) { alert('This product is out of stock.'); return; }
    const payload = {
      product_name: fd.get('product_name'),
      product_id: fd.get('product_id'),
      serial_no: fd.get('serial_no'),
      company_name: fd.get('company_name'),
      gst_number: fd.get('gst_number'),
      payment_mode: fd.get('payment_mode'),
      price: Number(fd.get('price')),
      tax_rate: Number(fd.get('tax_rate')),
      discount: Number(fd.get('discount') || 0)
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
      e.target.reset();
      await loadOrders();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }