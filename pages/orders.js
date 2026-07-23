const orderState = { orders: [] };

document.addEventListener('DOMContentLoaded', () => {
  injectModal();
  loadOrders();
  wireHeaderButtons();
});

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
  const cardValues = document.querySelectorAll('.cards .card p');
  if (!cardValues.length) return;
  cardValues[0].textContent = orders.length;
  cardValues[1].textContent = orders.filter(o => o.status === 'placed').length;
  cardValues[2].textContent = orders.filter(o => o.status === 'delivered').length;
  cardValues[3].textContent = orders.filter(o => o.status === 'cancelled').length;
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
      <td>${o.order_id?.slice(0, 8) ?? ''}</td>
      <td>${o.product_name ?? ''}</td>
      <td>${o.company_name ?? ''}</td>
      <td>-</td>
      <td>${o.payment_mode ?? ''}</td>
      <td><span class="${statusClass(o.status)}">${o.status ?? ''}</span></td>
      <td>₹${o.total_mrp ?? o.price ?? 0}</td>
      <td>
        <button class="view-btn">👁</button>
        <button class="track-btn">Track</button>
        ${canManage ? '<button class="deliver-btn">Deliver</button>' : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => viewOrder(rowOrder(e))));
  tbody.querySelectorAll('.track-btn').forEach(btn => btn.addEventListener('click', e => trackOrder(rowOrder(e).order_id)));
  tbody.querySelectorAll('.deliver-btn').forEach(btn => btn.addEventListener('click', e => confirmDelivery(rowOrder(e).order_id)));
}

function rowOrder(e) {
  const tr = e.target.closest('tr');
  return orderState.orders.find(o => o.order_id === tr.dataset.orderId);
}

function wireHeaderButtons() {
  const buttons = document.querySelectorAll('header > div:last-child button');
  if (buttons[0]) buttons[0].addEventListener('click', () => {
    const id = prompt('Enter order ID to track:');
    if (id) trackOrder(id);
  });
  if (buttons[1]) buttons[1].addEventListener('click', exportOrdersCSV);
  if (buttons[2]) buttons[2].addEventListener('click', () => openModal('createModal'));

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

function exportOrdersCSV() {
  const header = ['Order ID', 'Product', 'Company', 'Payment Mode', 'Status', 'Total'];
  const rows = orderState.orders.map(o => [o.order_id, o.product_name, o.company_name, o.payment_mode, o.status, o.total_mrp]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'orders.csv';
  a.click();
}

async function trackOrder(orderId) {
  try {
    const res = await apiFetch(`/track_order/${orderId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'order not found');
    alert(`Order ${data.order_id}\nStatus: ${data.status}\nTotal: ₹${data.total_mrp}`);
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

async function confirmDelivery(orderId) {
  if (!confirm('Mark this order as delivered?')) return;
  try {
    const res = await apiFetch(`/order/confirm_delivery/${orderId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'update failed');
    await loadOrders();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

function viewOrder(o) {
  if (!o) return;
  alert(
    `Order ID: ${o.order_id}\nProduct: ${o.product_name}\nCompany: ${o.company_name}\n` +
    `GST: ${o.gst_number}\nPayment: ${o.payment_mode}\nStatus: ${o.status}\n` +
    `Price: ₹${o.price}  Tax: ${o.tax_rate}%  Discount: ₹${o.discount}\nTotal: ₹${o.total_mrp}`
  );
}

function injectModal() {
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

  modal.querySelector('#cancelCreateOrder').addEventListener('click', () => closeModal('createModal'));
  modal.querySelector('#createOrderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      product_name: fd.get('product_name'),
      product_id: fd.get('product_id'),
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