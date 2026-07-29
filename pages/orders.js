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
    const items = o.items || [];
    const productLabel = items.length
      ? `${items[0].product_name ?? ''}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
      : (o.product_name ?? '');
    const serialLabel = items.length
      ? (items.length === 1
          ? ((items[0].serial_numbers && items[0].serial_numbers.length) ? items[0].serial_numbers.join(', ') : '-')
          : `${items.length} items`)
      : '-';
    const companyName = o.customer?.company_name ?? o.company_name ?? '';

    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td>${o.order_id?.slice(0, 8) ?? ''}</td>
      <td>${productLabel}</td>
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
  if (exportBtn) exportBtn.addEventListener('click', exportOrdersCSV);
  // New Order button is wired inside injectCreateModal() so it can reset wizard state first.

  const searchInput = document.querySelector('header input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const filtered = orderState.orders.filter(o =>
        (o.order_id || '').toLowerCase().includes(term) ||
        (o.items || []).some(it => (it.product_name || '').toLowerCase().includes(term)) ||
        (o.customer?.company_name || o.company_name || '').toLowerCase().includes(term)
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
  const header = ['Order ID', 'Products', 'Company', 'Payment Mode', 'Status', 'Total'];
  const rows = orderState.orders.map(o => [
    o.order_id,
    (o.items || []).map(it => `${it.product_name} x${it.quantity}`).join(' | '),
    o.customer?.company_name ?? o.company_name ?? '',
    o.payment_mode,
    o.status,
    o.total_mrp
  ]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'orders.csv';
  a.click();
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
    <div class="detail"><small>Contractor</small><p>${customer.contractor_person ?? '-'} (${customer.contractor_number ?? '-'})</p></div>
    <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:#64748b;">
        <th>Product</th><th>Qty</th><th>Price</th><th>Tax</th><th>Line Total</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    <div class="detail"><small>Payment</small><p>${paymentDetailsLabel(o)}</p></div>
    <div class="detail"><small>Status</small><p>${o.status ?? ''}</p></div>
    <div class="detail"><small>Cancellation Reason</small><p>${o.status === 'cancelled' ? (o.cancel_reason || '-') : '-'}</p></div>
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

// ---------- New Order wizard ----------
const wiz = {
  customerId: '',      // set when existing customer picked
  customer: null,      // {company_name, company_address, gst_number, contractor_person, contractor_number, contractor_email}
  cart: {},             // product_id -> {product_id, product_name, price, tax_rate, quantity}
  paymentMode: '',
  discount: 0
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
  const products = invLookup.products;
  wizardBody().innerHTML = `
    <input id="prodFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:320px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#64748b;">
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

  const rowsBox = document.getElementById('prodRows');
  const renderRows = (list) => {
    rowsBox.innerHTML = list.map(p => `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}</small></td>
        <td>${p.quantity ?? 0}</td>
        <td>₹${p.price ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${wiz.cart[p.product_id]?.quantity ?? 0}"
              data-id="${p.product_id}" class="qtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`).join('');
    rowsBox.querySelectorAll('.qtyInput').forEach(inp => inp.addEventListener('input', () => {
      const p = products.find(x => x.product_id === inp.dataset.id);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
      inp.value = qty;
      if (qty > 0) {
        wiz.cart[p.product_id] = { product_id: p.product_id, product_name: p.product_name, price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0, quantity: qty };
      } else {
        delete wiz.cart[p.product_id];
      }
    }));
  };
  renderRows(products);

  document.getElementById('prodFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });

  document.getElementById('toPaymentBtn').addEventListener('click', () => {
    if (!Object.keys(wiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    renderPaymentStep();
  });
}

// Step 4: payment mode + conditional fields + discount
function renderPaymentStep() {
  wizardTitle('New Order — Payment');
  const cartItems = Object.values(wiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);

  wizardBody().innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `${i.product_name} × ${i.quantity} = ₹${(i.price * i.quantity).toFixed(2)}`).join('<br>')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">
      Subtotal: ₹${subtotal.toFixed(2)}
    </div>
    <select id="paymentMode" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
      <option value="">Select Payment Mode</option>
      ${PAYMENT_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
    </select>
    <div id="paymentExtra"></div>
    <input id="discountInput" type="number" min="0" placeholder="Discount (₹)" value="0" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;">
    <div style="display:flex;justify-content:space-between;margin-top:10px;">
      <button type="button" id="backBtn4" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="placeOrderBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Place Order</button>
    </div>`;

  document.getElementById('backBtn4').addEventListener('click', renderProductsStep);

  const modeSelect = document.getElementById('paymentMode');
  const extraBox = document.getElementById('paymentExtra');
  modeSelect.addEventListener('change', () => renderPaymentExtra(modeSelect.value, extraBox));

  document.getElementById('discountInput').addEventListener('input', e => wiz.discount = Number(e.target.value) || 0);

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
      product_id: i.product_id, product_name: i.product_name,
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: wiz.discount || 0
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