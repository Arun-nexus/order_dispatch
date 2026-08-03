const ordState = { orders: [], products: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadOrdersPage();
  loadProductsForOrder();
  wireOrderFilter();
  injectOrderModal();
});

window.refreshCurrentPageData = loadOrdersPage;

function isSameDay(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function orderAmount(o) {
  const subtotal = (o.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  return Math.max(0, subtotal - (Number(o.discount) || 0));
}

function orderStatusMeta(o) {
  if (o.status === 'delivered') return { label: 'Delivered', cls: 'delivered' };
  return { label: 'Pending', cls: 'pending' };
}

async function loadOrdersPage() {
  try {
    const res = await apiFetch('/order/');
    if (!res.ok) throw new Error('failed to fetch orders');
    const data = await res.json();
    const uname = getUsername();
    ordState.orders = (data.dataset || []).filter(o =>
      o.creator?.raised_by === uname || o.creator?.created_by === uname
    );
    renderOrderCards();
    renderOrdersTable(ordState.orders);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your orders.');
  }
}

async function loadProductsForOrder() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) throw new Error('failed to fetch inventory');
    const data = await res.json();
    ordState.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

function renderOrderCards() {
  const orders = ordState.orders;
  document.getElementById('cardTotalOrders').textContent = orders.length;

  const todayOrders = orders.filter(o => isSameDay(o.order_date));
  const todayAmount = todayOrders.reduce((s, o) => s + orderAmount(o), 0);
  document.getElementById('cardTodayAmount').textContent = `₹${todayAmount.toFixed(2)}`;
  document.getElementById('cardTodayOrders').textContent = todayOrders.length;

  document.getElementById('cardDelivered').textContent = orders.filter(o => o.status === 'delivered').length;
  document.getElementById('cardPendingOrders').textContent = orders.filter(o => o.status !== 'delivered').length;
}

function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const sorted = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  sorted.forEach(o => {
    const meta = orderStatusMeta(o);
    const productLabel = (o.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    const tr = document.createElement('tr');
    tr.dataset.id = o.order_id;
    tr.innerHTML = `
      <td>${(o.order_id || '').slice(0, 8)}</td>
      <td>${o.customer?.company_name ?? ''}</td>
      <td>${productLabel}</td>
      <td>${o.payment_mode ?? '-'}</td>
      <td>₹${orderAmount(o).toFixed(2)}</td>
      <td>${o.order_date ? new Date(o.order_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="status ${meta.cls}">${meta.label}</span></td>
      <td><button class="icon-btn view-order-btn"><i class="fa-solid fa-eye"></i></button></td>`;
    tbody.appendChild(tr);
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">No orders yet.</td></tr>';
  }

  tbody.querySelectorAll('.view-order-btn').forEach(b => b.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const o = ordState.orders.find(x => x.order_id === tr.dataset.id);
    openViewOrderModal(o);
  }));
}

function openViewOrderModal(o) {
  if (!o) return;
  const meta = orderStatusMeta(o);
  const modal = document.getElementById('viewOrderModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Order Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Order ID</small><p>${o.order_id ?? ''}</p></div>
    <div class="detail"><small>Customer</small><p>${o.customer?.company_name ?? ''} — ${o.customer?.contractor_person ?? ''} (${o.customer?.contractor_number ?? ''})</p></div>
    <div class="detail"><small>Products</small><p>${(o.items || []).map(i => `${i.product_name} x${i.quantity} @ ₹${i.price ?? 0}${i.serial_numbers?.length ? ' (' + i.serial_numbers.join(', ') + ')' : ''}`).join('<br>')}</p></div>
    <div class="detail"><small>Payment Mode</small><p>${o.payment_mode ?? '-'}</p></div>
    <div class="detail"><small>Discount</small><p>₹${o.discount ?? 0}</p></div>
    <div class="detail"><small>Amount</small><p>₹${orderAmount(o).toFixed(2)}</p></div>
    <div class="detail"><small>Order Date</small><p>${o.created_at ? new Date(o.created_at).toLocaleString() : '-'}</p></div>
    <div class="detail"><small>Status</small><p>${meta.label}</p></div>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireOrderFilter() {
  const btn = document.getElementById('applyOrderFilter');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const status = document.getElementById('statusFilter').value;
    let filtered = ordState.orders;
    if (status === 'delivered') filtered = ordState.orders.filter(o => o.status === 'delivered');
    if (status === 'pending') filtered = ordState.orders.filter(o => o.status !== 'delivered');
    renderOrdersTable(filtered);
  });
}

// ---------- Create Order wizard ----------
const orderWiz = { customerId: '', customer: null, cart: {}, discount: 0 };

const ORDER_PAYMENT_MODES = [
  { value: 'Credit', label: 'Credit' },
  { value: 'NetBanking', label: 'Net Banking' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'DemandDraft', label: 'Demand Draft' },
  { value: 'Cash', label: 'Cash' },
];

function resetOrderWiz() {
  orderWiz.customerId = '';
  orderWiz.customer = null;
  orderWiz.cart = {};
  orderWiz.discount = 0;
}

function injectOrderModal() {
  const modal = document.getElementById('orderModal');
  const btn = document.getElementById('createOrderBtn');
  if (btn) btn.addEventListener('click', () => {
    resetOrderWiz();
    modal.style.display = 'flex';
    renderOrderCustomerTypeStep();
  });
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

function wizBody() {
  const modal = document.getElementById('orderModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="wizTitle">Create Order</h3>
      <button type="button" id="wizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div id="wizStepBody"></div>`;
  content.querySelector('#wizClose').addEventListener('click', () => modal.style.display = 'none');
  return document.getElementById('wizStepBody');
}
function wizTitle(t) { document.getElementById('wizTitle').textContent = t; }

function renderOrderCustomerTypeStep() {
  const body = wizBody();
  wizTitle('Create Order — Customer');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Is this order for an existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnOExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing Customer
      </button>
      <button id="btnONew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New Customer
      </button>
    </div>`;
  document.getElementById('btnOExisting').addEventListener('click', renderOrderExistingCustomerStep);
  document.getElementById('btnONew').addEventListener('click', renderOrderNewCustomerStep);
}

function renderOrderExistingCustomerStep() {
  const body = wizBody();
  wizTitle('Create Order — Select Customer');
  body.innerHTML = `
    <input id="oCustSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="oCustResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="oBackBtn1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('oBackBtn1').addEventListener('click', renderOrderCustomerTypeStep);

  const searchInput = document.getElementById('oCustSearch');
  const resultsBox = document.getElementById('oCustResults');
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
        orderWiz.customerId = c.customer_id;
        orderWiz.customer = c;
        renderOrderProductsStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

function renderOrderNewCustomerStep() {
  const body = wizBody();
  wizTitle('Create Order — New Customer');
  body.innerHTML = `
    <form id="oNewCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Customer Name" required>
      <input name="company_address" placeholder="Customer Address" required>
      <input name="gst_number" placeholder="GST Number (if applicable)">
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email" required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="oBackBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('oBackBtn2').addEventListener('click', renderOrderCustomerTypeStep);
  document.getElementById('oNewCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'), company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'), contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'), contractor_email: fd.get('contractor_email')
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      orderWiz.customerId = data.customer_id;
      orderWiz.customer = data.customer || payload;
      renderOrderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function renderOrderProductsStep() {
  const body = wizBody();
  wizTitle(`Create Order — ${orderWiz.customer?.company_name ?? 'Products'}`);
  const products = ordState.products;
  body.innerHTML = `
    <input id="oProdFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Price</th><th style="width:70px;">Qty</th></tr></thead>
        <tbody id="oProdRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="oBackCart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="oToPaymentBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
    </div>`;
  document.getElementById('oBackCart').addEventListener('click', () => orderWiz.customerId ? renderOrderExistingCustomerStep() : renderOrderNewCustomerStep());

  const rowsBox = document.getElementById('oProdRows');
  const renderRows = (list) => {
    rowsBox.innerHTML = list.map(p => `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}</small></td>
        <td>₹${p.price ?? 0}</td>
        <td><input type="number" min="0" max="${p.quantity ?? 0}" value="${orderWiz.cart[p.product_id]?.quantity ?? 0}"
              data-id="${p.product_id}" class="oQtyInput" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`).join('');
    rowsBox.querySelectorAll('.oQtyInput').forEach(inp => inp.addEventListener('input', () => {
      const p = list.find(x => x.product_id === inp.dataset.id);
      const qty = Math.max(0, Math.min(Number(inp.value) || 0, Number(p.quantity) || 0));
      inp.value = qty;
      if (qty > 0) orderWiz.cart[p.product_id] = { product_id: p.product_id, product_name: p.product_name, price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0, quantity: qty };
      else delete orderWiz.cart[p.product_id];
    }));
  };
  renderRows(products);
  document.getElementById('oProdFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderRows(products.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });

  document.getElementById('oToPaymentBtn').addEventListener('click', () => {
    if (!Object.keys(orderWiz.cart).length) { alert('Add quantity for at least one product.'); return; }
    renderOrderPaymentStep();
  });
}

function renderOrderPaymentStep() {
  const body = wizBody();
  wizTitle('Create Order — Payment');
  const cartItems = Object.values(orderWiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);

  body.innerHTML = `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `${i.product_name} × ${i.quantity} = ₹${(i.price * i.quantity).toFixed(2)}`).join('<br>')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">
      Subtotal: ₹${subtotal.toFixed(2)}
    </div>
    <select id="oPaymentMode" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
      <option value="">Select Payment Mode</option>
      ${ORDER_PAYMENT_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
    </select>
    <div id="oPaymentExtra"></div>
    <input id="oDiscountInput" type="number" min="0" placeholder="Discount (₹)" value="0" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;">
    <div style="display:flex;justify-content:space-between;margin-top:10px;">
      <button type="button" id="oBackBtn4" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="oSendRequestBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;

  document.getElementById('oBackBtn4').addEventListener('click', renderOrderProductsStep);

  const modeSelect = document.getElementById('oPaymentMode');
  const extraBox = document.getElementById('oPaymentExtra');
  modeSelect.addEventListener('change', () => renderOrderPaymentExtra(modeSelect.value, extraBox));

  document.getElementById('oDiscountInput').addEventListener('input', e => orderWiz.discount = Number(e.target.value) || 0);

  document.getElementById('oSendRequestBtn').addEventListener('click', () => submitOrderRequest(modeSelect, extraBox));
}

function renderOrderPaymentExtra(mode, extraBox) {
  if (mode === 'Credit') {
    extraBox.innerHTML = `
      <label style="font-size:13px;color:#64748b;">Credit Period</label>
      <select id="oCreditDaysSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
        <option value="15">15 days</option>
        <option value="30">30 days</option>
        <option value="45">45 days</option>
        <option value="60">60 days</option>
        <option value="manual">Other (enter days)</option>
      </select>
      <input id="oCreditDaysManual" type="number" min="1" max="60" placeholder="Enter days (max 60)" style="display:none;width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
    const sel = document.getElementById('oCreditDaysSelect');
    const manual = document.getElementById('oCreditDaysManual');
    sel.addEventListener('change', () => manual.style.display = sel.value === 'manual' ? 'block' : 'none');
  } else if (mode === 'Cheque') {
    extraBox.innerHTML = `
      <input id="oChequeNumber" placeholder="Cheque Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oChequeDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oChequeBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'DemandDraft') {
    extraBox.innerHTML = `
      <input id="oDdNumber" placeholder="Demand Draft Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oDdDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oDdBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'UPI') {
    extraBox.innerHTML = `<input id="oUpiId" placeholder="UPI ID (e.g. name@bank)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else if (mode === 'NetBanking') {
    extraBox.innerHTML = `
      <input id="oNbBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oNbAccount" placeholder="Account Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="oNbIfsc" placeholder="IFSC Code" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'Cash') {
    extraBox.innerHTML = `<input id="oCashReceivedBy" placeholder="Received By (Person Name)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else {
    extraBox.innerHTML = '';
  }
}

function buildOrderPaymentDetails(mode) {
  if (mode === 'Credit') {
    const sel = document.getElementById('oCreditDaysSelect');
    const manual = document.getElementById('oCreditDaysManual');
    const days = sel.value === 'manual' ? Number(manual.value) : Number(sel.value);
    if (!days || days < 1 || days > 60) throw new Error('Credit days must be between 1 and 60.');
    return { credit_days: days };
  }
  if (mode === 'Cheque') {
    const cheque_number = document.getElementById('oChequeNumber').value.trim();
    const cheque_date = document.getElementById('oChequeDate').value;
    const bank_name = document.getElementById('oChequeBank').value.trim();
    if (!cheque_number || !cheque_date) throw new Error('Cheque number and date are required.');
    return { cheque_number, cheque_date, bank_name };
  }
  if (mode === 'DemandDraft') {
    const dd_number = document.getElementById('oDdNumber').value.trim();
    const dd_date = document.getElementById('oDdDate').value;
    const bank_name = document.getElementById('oDdBank').value.trim();
    if (!dd_number || !dd_date) throw new Error('Demand draft number and date are required.');
    return { dd_number, dd_date, bank_name };
  }
  if (mode === 'UPI') {
    const upi_id = document.getElementById('oUpiId').value.trim();
    if (!upi_id) throw new Error('UPI ID is required.');
    return { upi_id };
  }
  if (mode === 'NetBanking') {
    const bank_name = document.getElementById('oNbBank').value.trim();
    const account_number = document.getElementById('oNbAccount').value.trim();
    const ifsc_code = document.getElementById('oNbIfsc').value.trim();
    if (!bank_name || !account_number || !ifsc_code) throw new Error('Bank name, account number and IFSC code are required.');
    return { bank_name, account_number, ifsc_code };
  }
  if (mode === 'Cash') {
    const received_by = document.getElementById('oCashReceivedBy').value.trim();
    if (!received_by) throw new Error('Received-by person name is required.');
    return { received_by };
  }
  return {};
}

async function submitOrderRequest(modeSelect, extraBox) {
  const mode = modeSelect.value;
  if (!mode) { showResponseModal('Payment mode required', 'Please select a payment mode.', false); return; }

  let payment_details;
  try {
    payment_details = buildOrderPaymentDetails(mode);
  } catch (err) {
    showResponseModal('Missing payment details', err.message, false);
    return;
  }

  const payload = {
    customer_id: orderWiz.customerId || '',
    customer: orderWiz.customer || {},
    items: Object.values(orderWiz.cart).map(i => ({
      product_id: i.product_id, product_name: i.product_name,
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: orderWiz.discount || 0
  };

  try {
    const res = await apiFetch('/request/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'request failed');
    document.getElementById('orderModal').style.display = 'none';
    resetOrderWiz();
    showResponseModal('Request sent', 'Your order request has been sent — admin/employee will review and approve it. It will appear here once approved.', true);
    await loadOrdersPage();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Request failed', err.message, false);
  }
}