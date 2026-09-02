const doState = { orders: [], products: [] };
let doPage = 1;
const DO_PAGE_SIZE = 7;

const PAYMENT_MODES = [
  { value: 'Credit', label: 'Credit' },
  { value: 'NetBanking', label: 'Net Banking' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'DemandDraft', label: 'Demand Draft' },
  { value: 'Cash', label: 'Cash' },
];

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
  loadOrders();
  loadInventoryForOrders();
  wireHeaderButtons();
  wireFilter();
  injectOrderModal();
  wireViewModalClose();
});

window.refreshCurrentPageData = () => { loadOrders(); };

// ---------- Load / render ----------
async function loadOrders() {
  try {
    const res = await apiFetch('/order/');
    if (!res.ok) throw new Error('failed to fetch orders');
    const data = await res.json();
    const uname = getUsername();
    // Distributors only ever get orders into the system via an approved
    // /request/order — those come back with creator.type === "request" and
    // creator.raised_by set to whoever raised it. Filter to just this user's.
    const mine = (data.dataset || []).filter(o => o.creator?.raised_by === uname);
    doState.orders = mine.slice().reverse();
    doPage = 1;
    renderCards(doState.orders);
    renderTable(doState.orders);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load your orders.');
    }
  }
}

async function loadInventoryForOrders() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) return;
    const data = await res.json();
    doState.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

function renderCards(orders) {
  const today = new Date().toDateString();
  const todaysOrders = orders.filter(o => o.order_date && new Date(o.order_date).toDateString() === today);
  const todaysAmount = todaysOrders.reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('cardTotalOrders', orders.length);
  set('cardTodayAmount', `₹${todaysAmount.toFixed(2)}`);
  set('cardTodayOrders', todaysOrders.length);
  set('cardDelivered', orders.filter(o => o.status === 'delivered').length);
  set('cardPendingOrders', orders.filter(o => o.status !== 'delivered' && o.status !== 'cancelled').length);
}

function statusClass(status) {
  const map = { placed: 'pending', processing: 'pending', delivered: 'delivered', cancelled: 'cancel' };
  return map[status] || 'pending';
}

function renderTable(orders) {
  const sorted = [...orders].sort((a, b) =>
    new Date(b.order_date || b.created_at || 0) - new Date(a.order_date || a.created_at || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / DO_PAGE_SIZE));
  doPage = Math.min(Math.max(1, doPage), totalPages);
  const start = (doPage - 1) * DO_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + DO_PAGE_SIZE);

  const tbody = document.getElementById('ordersTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:#94a3b8;">No orders yet.</td></tr>`;
  }

  pageRows.forEach(o => {
    const items = o.items || [];
    const productLabel = items.length
      ? `${items[0].product_name ?? ''}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
      : '-';
    const companyName = o.customer?.company_name ?? '';
    const tr = document.createElement('tr');
    tr.dataset.orderId = o.order_id;
    tr.innerHTML = `
      <td>${o.order_id ? o.order_id.slice(0, 8) : '-'}</td>
      <td>${companyName}</td>
      <td>${productLabel}</td>
      <td>${o.payment_mode ?? ''}</td>
      <td>₹${o.total_mrp ?? 0}</td>
      <td>${o.order_date ? new Date(o.order_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="${statusClass(o.status)}">${o.status ?? ''}</span></td>
      <td><button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => openViewOrderModal(rowOrder(e))));

  renderTablePagination(document.querySelector('.pagination'), doPage, totalPages, p => {
    doPage = p;
    renderTable(orders);
  });
}

function rowOrder(e) {
  const tr = e.target.closest('tr');
  return doState.orders.find(o => o.order_id === tr.dataset.orderId);
}

// ---------- Header search + filter ----------
function wireHeaderButtons() {
  const searchInput = document.querySelector('header input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const filtered = doState.orders.filter(o =>
        (o.order_id || '').toLowerCase().includes(term) ||
        (o.items || []).some(it => (it.product_name || '').toLowerCase().includes(term)) ||
        (o.customer?.company_name || '').toLowerCase().includes(term)
      );
      doPage = 1;
      renderTable(filtered);
    });
  }
}

function wireFilter() {
  const filterBtn = document.getElementById('applyOrderFilter');
  if (!filterBtn) return;
  filterBtn.addEventListener('click', () => {
    const statusVal = document.getElementById('statusFilter')?.value || '';
    const wantedStatus = statusVal === 'delivered' ? 'delivered' : (statusVal === 'pending' ? null : null);
    const filtered = doState.orders.filter(o => {
      if (statusVal === 'delivered') return o.status === 'delivered';
      if (statusVal === 'pending') return o.status !== 'delivered' && o.status !== 'cancelled';
      return true;
    });
    doPage = 1;
    renderTable(filtered);
  });
}

// ---------- View Order modal ----------
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
  const content = modal.querySelector('.modal-content');
  const items = o.items || [];
  const customer = o.customer || {};

  const itemsRows = items.length
    ? items.map(it => `<tr>
        <td>${it.product_name ?? ''}</td>
        <td>${it.quantity ?? 0}</td>
        <td>₹${it.price ?? 0}</td>
        <td>₹${(it.line_total ?? ((it.price || 0) * (it.quantity || 0))).toFixed ? (it.line_total ?? ((it.price || 0) * (it.quantity || 0))).toFixed(2) : it.line_total}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No items</td></tr>`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Order Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Order ID</small><p>${o.order_id ?? ''}</p></div>
    <div class="detail"><small>Company</small><p>${customer.company_name ?? '-'}</p></div>
    <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Qty</th><th>Price</th><th>Line Total</th></tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    <div class="detail"><small>Payment</small><p>${paymentDetailsLabel(o)}</p></div>
    <div class="detail"><small>Status</small><p>${o.status ?? ''}</p></div>
    <div class="detail"><small>Subtotal / Tax / Discount</small><p>₹${o.subtotal ?? 0} / ₹${(o.tax_total ?? 0).toFixed ? o.tax_total.toFixed(2) : o.tax_total} / ₹${o.discount ?? 0}</p></div>
    <div class="detail"><small>Total Amount</small><p>₹${o.total_mrp ?? 0}</p></div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}

function wireViewModalClose() {
  const modal = document.getElementById('viewOrderModal');
  if (modal) modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

// ---------- Create Order wizard (raises an approval request — distributors
// can't create orders directly, only admin/employee can) ----------
const orderWiz = { customerId: '', customer: null, cart: {}, discount: 0 };

function resetOrderWiz() {
  orderWiz.customerId = '';
  orderWiz.customer = null;
  orderWiz.cart = {};
  orderWiz.discount = 0;
}

function injectOrderModal() {
  const modal = document.getElementById('orderModal');
  if (!modal) return;
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });

  const btn = document.getElementById('createOrderBtn');
  if (btn) btn.addEventListener('click', () => { resetOrderWiz(); modal.style.display = 'flex'; renderCustomerTypeStep(); });
}

function wizBody() { return document.querySelector('#orderModal .modal-content'); }

function wizHeader(title) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${title}</h3>
      <button type="button" class="wizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>`;
}

function wireWizClose() {
  wizBody().querySelector('.wizClose')?.addEventListener('click', () => {
    document.getElementById('orderModal').style.display = 'none';
  });
}

// Step 1: existing vs new customer
function renderCustomerTypeStep() {
  wizBody().innerHTML = wizHeader('New Order — Customer') + `
    <p style="color:#64748b;margin-bottom:14px;">Is this order for an existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing Customer
      </button>
      <button id="btnNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New Customer
      </button>
    </div>`;
  wireWizClose();
  document.getElementById('btnExisting').addEventListener('click', renderExistingCustomerStep);
  document.getElementById('btnNew').addEventListener('click', renderNewCustomerStep);
}

// Step 2a: search + pick existing customer
function renderExistingCustomerStep() {
  wizBody().innerHTML = wizHeader('New Order — Select Customer') + `
    <input id="custSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="custResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="display:flex;justify-content:flex-start;margin-top:14px;">
      <button type="button" id="backBtn1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  wireWizClose();
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
        <div class="cust-row" data-id="${c.customer_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <strong>${c.company_name ?? ''}</strong><br>
          <small style="color:#64748b;">${c.gst_number ?? ''} • ${c.contractor_person ?? ''} • ${c.contractor_number ?? ''}</small>
        </div>`).join('');
      resultsBox.querySelectorAll('.cust-row').forEach(row => row.addEventListener('click', () => {
        const c = list.find(x => x.customer_id === row.dataset.id);
        orderWiz.customerId = c.customer_id;
        orderWiz.customer = c;
        renderProductsStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

// Step 2b: new customer form
function renderNewCustomerStep() {
  wizBody().innerHTML = wizHeader('New Order — New Customer') + `
    <form id="newCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Customer Name" required>
      <input name="company_address" placeholder="Customer Address" required>
      <input name="gst_number" placeholder="GST Number (if applicable)">
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  wireWizClose();
  document.getElementById('backBtn2').addEventListener('click', renderCustomerTypeStep);
  document.getElementById('newCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'),
      company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number') || '',
      contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'),
      contractor_email: fd.get('contractor_email') || '',
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      orderWiz.customerId = data.customer_id;
      orderWiz.customer = data.customer || payload;
      renderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// Multiple inventory entries can share the same product_id (e.g. separate
// batches/lots). Showing them as separate rows would let the user type into
// two different rows for "the same" product — since the cart is keyed by
// product_id, only the last one edited would actually stick. Collapse them
// into a single row per product_id.
// A row is only "the same product" when product_id + product_name + model_no
// ALL match — if even one differs, it's a different, independent product and
// gets its own row and its own cart line. (Same rule as orders.js.)
function rowKeyFor(p) { return `${p.product_id}||${p.product_name || ''}||${p.model_no || ''}`; }

function dedupeProducts(rawProducts) {
  const map = new Map();
  for (const p of rawProducts) {
    const key = rowKeyFor(p);
    if (!map.has(key)) map.set(key, { ...p });
  }
  return Array.from(map.values());
}

// Step 3: product picker with quantity + manually entered price per row
function renderProductsStep() {
  const products = dedupeProducts(doState.products || []);
  wizBody().innerHTML = wizHeader(`New Order — ${orderWiz.customer?.company_name ?? 'Products'}`) + `
    <div id="prodCatTabs" style="display:flex;gap:8px;margin-bottom:10px;"></div>
    <input id="prodFilter" placeholder="Filter products..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th style="width:70px;">Qty</th><th style="width:100px;">Price</th></tr></thead>
        <tbody id="prodRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backBtn3" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="toPaymentBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
    </div>`;
  wireWizClose();
  document.getElementById('backBtn3').addEventListener('click', () => orderWiz.customerId ? renderExistingCustomerStep() : renderNewCustomerStep());

  // ---------- Category tabs: Products / Accessories / Spare Parts ----------
  // Filters the same product table by product_type, same pattern used on
  // the admin Orders page and the Inventory page.
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
    const key = rowKeyFor(p);
    const cartLine = orderWiz.cart[key];
    const qtyInCart = cartLine?.quantity ?? '';
    const priceInCart = cartLine?.price ?? '';
    return `
      <tr>
        <td>${p.product_name ?? ''}<br><small style="color:#94a3b8;">${p.product_id}${p.model_no ? ' — ' + p.model_no : ''}</small></td>
        <td><input type="number" min="0" inputmode="numeric" value="${qtyInCart}"
              placeholder="0" data-row-key="${key}" class="qtyInput"
              style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
        <td><input type="number" min="0" inputmode="decimal" value="${priceInCart}"
              placeholder="₹0" data-row-key="${key}" class="priceInput"
              style="width:85px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`;
  }

  function renderRows(list) { rowsBox.innerHTML = list.map(productRowHtml).join(''); }

  function computeTypedQty(inp) {
    if (!inp || inp.value.trim() === '') return null;
    let qty = Math.floor(Math.max(0, Number(inp.value)));
    if (!Number.isFinite(qty)) qty = 0;
    return qty;
  }

  function computeTypedPrice(inp) {
    if (!inp || inp.value.trim() === '') return null;
    let price = Math.max(0, Number(inp.value));
    if (!Number.isFinite(price)) price = 0;
    return price;
  }

  // Price is entered manually here instead of being pulled from the catalog
  // — the cart line is only ever built (or updated) from whatever is
  // currently in the row's Qty and Price fields, not from p.price.
  function syncRowToCart(key, p) {
    const qtyInp = rowsBox.querySelector(`.qtyInput[data-row-key="${key}"]`);
    const priceInp = rowsBox.querySelector(`.priceInput[data-row-key="${key}"]`);
    const qty = computeTypedQty(qtyInp);

    if (qty === null || qty <= 0) { delete orderWiz.cart[key]; return; }

    const price = computeTypedPrice(priceInp) ?? 0;
    orderWiz.cart[key] = {
      product_id: p.product_id,
      product_name: p.product_name,
      model_no: p.model_no || '',
      price,
      tax_rate: Number(p.tax_rate) || 0,
      quantity: qty
    };
  }

  rowsBox.addEventListener('input', (e) => {
    const inp = e.target.closest('.qtyInput, .priceInput');
    if (!inp) return;
    const key = inp.dataset.rowKey;
    const p = products.find(x => rowKeyFor(x) === key);
    if (!p) return;
    syncRowToCart(key, p);
  });

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
    rowsBox.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:16px;color:#94a3b8;">
      No products loaded. <button type="button" id="retryInvBtn" style="border:none;background:#eef2ff;color:#2563eb;padding:4px 10px;border-radius:6px;cursor:pointer;">Retry</button>
    </td></tr>`;
    document.getElementById('retryInvBtn')?.addEventListener('click', async () => {
      await loadInventoryForOrders();
      renderProductsStep();
    });
  }

  document.getElementById('prodFilter').addEventListener('input', applyFilters);

  document.getElementById('toPaymentBtn').addEventListener('click', () => {
    const cartItems = Object.values(orderWiz.cart);
    if (!cartItems.length) { alert('Add quantity for at least one product.'); return; }
    if (cartItems.some(i => !i.price || i.price <= 0)) { alert('Enter a price for every product you added.'); return; }
    renderPaymentStep();
  });
}

// Step 4: payment mode + conditional fields + discount, then send for approval
function renderPaymentStep() {
  const cartItems = Object.values(orderWiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);

  wizBody().innerHTML = wizHeader('New Order — Payment') + `
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
      <button type="button" id="sendRequestBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;
  wireWizClose();
  document.getElementById('backBtn4').addEventListener('click', renderProductsStep);

  const modeSelect = document.getElementById('paymentMode');
  const extraBox = document.getElementById('paymentExtra');
  modeSelect.addEventListener('change', () => renderPaymentExtra(modeSelect.value, extraBox));

  document.getElementById('discountInput').addEventListener('input', e => orderWiz.discount = Number(e.target.value) || 0);

  document.getElementById('sendRequestBtn').addEventListener('click', () => submitOrderRequest(modeSelect, extraBox));
}

function renderPaymentExtra(mode, extraBox) {
  if (mode === 'Credit') {
    extraBox.innerHTML = `
      <label style="font-size:13px;color:#64748b;">Credit Period</label>
      <select id="creditDaysSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
        <option value="15">15 days</option><option value="30">30 days</option>
        <option value="45">45 days</option><option value="60">60 days</option>
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
    extraBox.innerHTML = `<input id="upiId" placeholder="UPI ID (e.g. name@bank)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else if (mode === 'NetBanking') {
    extraBox.innerHTML = `
      <input id="nbBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbAccount" placeholder="Account Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbIfsc" placeholder="IFSC Code" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'Cash') {
    extraBox.innerHTML = `<input id="cashReceivedBy" placeholder="Received By (Person Name)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
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

async function submitOrderRequest(modeSelect, extraBox) {
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
    customer_id: orderWiz.customerId || '',
    customer: orderWiz.customer || {},
    items: Object.values(orderWiz.cart).map(i => ({
      product_id: i.product_id, product_name: i.product_name, model_no: i.model_no || '',
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: orderWiz.discount || 0
  };

  try {
    const res = await apiFetch('/request/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'request failed');
    document.getElementById('orderModal').style.display = 'none';
    resetOrderWiz();
    alert('Order request sent — admin/employee will review and approve it.');
    await loadOrders();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}