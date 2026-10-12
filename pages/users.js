const userState = {
  users: [], customers: [], orders: [], allocations: [], tab: 'users', userSearch: '',
  customerFilter: { text: '', field: 'credit_limit', min: '', max: '' }
};

const USER_ROLE_LABELS = { distributor: 'Employee-Sales Person', inventory_manager: 'Inventory Manager' };
function displayRole(role) {
  if (!role) return '';
  return USER_ROLE_LABELS[role] || (role.charAt(0).toUpperCase() + role.slice(1));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function overallInfo(x) {
  const diff = (Number(x.returned) || 0) - (Number(x.creditGiven) || 0);
  const color = (Number(x.creditGiven) || 0) > (Number(x.limit) || 0) ? '#d62828' : (diff < 0 ? '#f97316' : '#16a34a');
  return { diff, color, text: money(Math.abs(diff)) + (diff < 0 ? ' Dr' : diff > 0 ? ' Cr' : '') };
}

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString('en-GB') : '-';
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  loadCustomers();
  loadAllocations();
  wireTopActions();
  wireFilter();
  wireStaticModals();
  wireSectionTabs();
  wireCardClicks();
  wireCustomerFilter();
  wireHeaderSearch();
  wireExportButtons();
});

async function loadUsers() {
  try {
    const res = await apiFetch('/account/');
    if (!res.ok) throw new Error('failed to fetch users');
    const data = await res.json();
    userState.users = (data.dataset || []).slice().reverse();
    renderCards();
    renderTable(filteredUsers());
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load users.');
  }
}

async function loadAllocations() {
  try {
    const res = await apiFetch('/allocation/');
    if (res.ok) userState.allocations = (await res.json()).dataset || [];
  } catch (err) { console.error(err); }
}

async function loadCustomers() {
  try {
    const [cRes, oRes] = await Promise.all([apiFetch('/customer/'), apiFetch('/order/')]);
    if (!cRes.ok || !oRes.ok) throw new Error('failed to fetch customers');
    userState.customers = ((await cRes.json()).dataset || []).slice().reverse();
    userState.orders = (await oRes.json()).dataset || [];
    renderCards();
    renderCustomerTable();
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load companies.');
  }
}

function renderCards() {
  const users = userState.users;
  document.getElementById('cardTotal').textContent = users.length;
  document.getElementById('cardAdmins').textContent = users.filter(u => u.role === 'admin').length;
  document.getElementById('cardEmployees').textContent = users.filter(u => u.role === 'accounts').length;
  document.getElementById('cardTechnicians').textContent = users.filter(u => u.role === 'technician').length;
  document.getElementById('cardDistributors').textContent = users.filter(u => u.role === 'distributor').length;
  document.getElementById('cardInventoryManagers').textContent = users.filter(u => u.role === 'inventory_manager').length;
  document.getElementById('cardCustomers').textContent = userState.customers.length;
  const tabCount = document.getElementById('customerTabCount');
  if (tabCount) tabCount.textContent = userState.customers.length ? `(${userState.customers.length})` : '';
}

function roleBadgeClass(role) {
  if (role === 'admin') return 'high';
  if (role === 'accounts') return 'medium';
  if (role === 'technician') return 'medium';
  if (role === 'service_manager') return 'medium';
  if (role === 'assembly') return 'medium';
  return 'high';
}

function filteredUsers(roleArg, termArg) {
  const role = roleArg !== undefined ? roleArg : document.getElementById('roleFilter').value;
  const term = (termArg !== undefined ? termArg : userState.userSearch).trim().toLowerCase();
  return userState.users.filter(u =>
    (!role || role === 'All Roles' || u.role === role) &&
    (!term || `${u.username || ''} ${u.name || ''} ${u.full_name || ''}`.toLowerCase().includes(term)));
}

function renderTable(users) {
  const tbody = document.querySelector('#usersSection .table-container tbody');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.username = u.username;
    tr.innerHTML = `
      <td><a href="#" class="user-link" style="color:#1665ff;font-weight:600;text-decoration:none;">${esc(u.username)}</a></td>
      <td>${esc(u.full_name ?? u.name)}</td>
      <td><span class="stock ${roleBadgeClass(u.role)}">${displayRole(u.role)}</span></td>
      <td>${esc(u.company_name)}</td>
      <td>${esc(u.mobile_no ?? u.phone)}</td>
      <td>${u.role === 'distributor' ? esc(u.manager || '-') : '-'}</td>
      <td>
        <button class="icon-btn edit-btn"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn delete-btn"><i class="fa-solid fa-trash"></i></button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.user-link').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openUserDetail(rowUser(e)); }));
  tbody.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => openUserModal(rowUser(e))));
  tbody.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', e => openDeleteModal(rowUser(e))));
}

function openUserDetail(u) {
  if (!u) return;
  const modal = document.getElementById('userCardDetailModal');
  const box = modal.querySelector('.modal-content');
  const uname = u.username;
  const orders = userState.orders
    .filter(o => o.reference === uname || (!o.reference && o.creator?.raised_by === uname))
    .sort((a, b) => new Date(b.order_date) - new Date(a.order_date));
  const orderTotal = orders.reduce((t, o) => t + (Number(o.total_mrp) || 0), 0);
  const demos = userState.allocations
    .filter(a => a.allocation_type !== 'spare_part' && (a.allocated_by === uname || a.sales_person?.username === uname))
    .sort((a, b) => new Date(b.allotment_date || 0) - new Date(a.allotment_date || 0));
  const field = (label, value) => `<div style="flex:1;min-width:200px;"><small style="color:#64748b;">${label}</small><div style="font-weight:600;">${esc(value) || '-'}</div></div>`;
  const tile = (label, value) => `<div style="flex:1;min-width:120px;background:#f8fafc;border-radius:10px;padding:10px 12px;"><small style="color:#64748b;">${label}</small><div style="font-weight:700;font-size:16px;">${value}</div></div>`;
  const orderRows = orders.map(o => [
    fmtDate(o.order_date),
    esc((o.order_id || '').slice(0, 8)),
    esc(o.customer?.company_name) || '-',
    esc((o.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ')),
    esc(o.payment_mode || '-'),
    money(o.total_mrp),
    esc(o.status || '-')
  ]);
  const demoRows = demos.map(a => [
    fmtDate(a.allotment_date),
    esc((a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ')) || '-',
    esc((a.items || []).flatMap(i => i.serial_numbers || []).join(', ')) || '-',
    esc(a.customer?.company_name || a.sales_person?.name) || '-',
    fmtDate(a.return_due_date),
    a.return_status === 'returned' ? 'Returned' : (a.dispatch ? 'With customer' : 'Allocated')
  ]);
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3>${esc(u.full_name ?? u.name) || esc(uname)} <span style="color:#94a3b8;font-weight:400;">@${esc(uname)}</span></h3>
      <div style="display:flex;align-items:center;gap:10px;">
        <button type="button" class="user-export" style="padding:8px 14px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-download"></i> Export</button>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      ${field('Role', displayRole(u.role))}
      ${field('Company', u.company_name)}
      ${field('GST Number', u.gst_number)}
      ${field('Mobile', u.mobile_no ?? u.phone)}
      ${field('Email', u.email_id ?? u.email)}
      ${u.role === 'distributor' ? field('Team Manager', u.manager) : ''}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      ${tile('Reference Orders', orders.length)}
      ${tile('Order Value', money(orderTotal))}
      ${tile('Demo Units', demos.length)}
    </div>
    <h4 style="margin-bottom:8px;">Orders <span style="color:#94a3b8;font-weight:400;">(${orders.length})</span> <small style="color:#94a3b8;font-weight:400;">— orders referred by this user</small></h4>
    ${tableHTML(['Date', 'Order ID', 'Customer', 'Items', 'Payment', 'Total', 'Status'], orderRows)}
    <h4 style="margin:18px 0 8px;">Demo Units <span style="color:#94a3b8;font-weight:400;">(${demos.length})</span></h4>
    ${tableHTML(['Allotted', 'Items', 'Serial No.', 'Customer', 'Return Due', 'Status'], demoRows)}`;
  box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelector('.user-export').addEventListener('click', () => openUserExportModal({ users: [u], title: `Export — ${u.full_name ?? u.name ?? uname}` }));
  modal.style.display = 'flex';
}

function rowUser(e) {
  const tr = e.target.closest('tr');
  return userState.users.find(u => u.username === tr.dataset.username);
}

function wireTopActions() {
  document.querySelector('#usersSection .add-product').addEventListener('click', () => openUserModal(null));
}

function wireFilter() {
  document.querySelector('#usersSection .filter-btn').addEventListener('click', () => renderTable(filteredUsers()));
}

function wireStaticModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));
}

function wireSectionTabs() {
  const tabs = document.querySelectorAll('.sectionTab');
  const paint = () => {
    tabs.forEach(t => {
      const active = t.dataset.tab === userState.tab;
      t.style.background = active ? '#1665ff' : '#f1f5f9';
      t.style.color = active ? '#fff' : '#475569';
    });
    document.getElementById('usersSection').style.display = userState.tab === 'users' ? '' : 'none';
    document.getElementById('customersSection').style.display = userState.tab === 'customers' ? '' : 'none';
  };
  tabs.forEach(t => t.addEventListener('click', () => { userState.tab = t.dataset.tab; paint(); }));
  paint();
  window.showUserSection = tab => { userState.tab = tab; paint(); };
}

function wireHeaderSearch() {
  const input = document.querySelector('.right-header .search input');
  if (!input) return;
  input.addEventListener('input', () => {
    if (userState.tab === 'customers') {
      userState.customerFilter.text = input.value;
      const box = document.getElementById('custSearch');
      if (box) box.value = input.value;
      renderCustomerTable();
    } else {
      userState.userSearch = input.value;
      renderTable(filteredUsers());
    }
  });
}

// keeps big rupee amounts on one line so they never run into the next column
const nw = n => `<span style="white-space:nowrap;">${money(n)}</span>`;

function entryTime(x) {
  return new Date(x.return_date || x.debit_date || x.added_at || 0).getTime() || 0;
}

function customerStats(c) {
  const orders = userState.orders
    .filter(o => o.customer?.customer_id === c.customer_id)
    .sort((a, b) => new Date(b.order_date) - new Date(a.order_date));
  const orderCredit = orders.filter(o => o.payment_mode === 'Credit').reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);
  // manual Credit entries (old "Return" data, stored in `returns`)
  const returns = (c.returns || []).slice().sort((a, b) => entryTime(b) - entryTime(a));
  const manualReturned = returns.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  // manual Debit entries (stored in `debits`) — add to the Debit side
  const debits = (c.debits || []).slice().sort((a, b) => entryTime(b) - entryTime(a));
  const manualDebited = debits.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  // purchases made FROM this party (recorded by the Inventory add form). Paid ones are
  // history only; ones bought on credit count towards Credit.
  const purchases = (c.purchases || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const purchaseCredit = purchases.filter(p => p.payment_mode === 'credit').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const purchasePaid = purchases.filter(p => p.payment_mode !== 'credit').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const returned = manualReturned + purchaseCredit;      // total Credit
  const creditGiven = orderCredit + manualDebited;       // total Debit (order credit + manual debits)
  const limit = Number(c.credit_limit) || 0;
  const outstanding = Math.max(creditGiven - returned, 0);
  return {
    orders, returns, debits, purchases, manualReturned, manualDebited, orderCredit, purchaseCredit, purchasePaid,
    creditGiven, returned, limit, outstanding,
    available: limit - outstanding,
    totalOrders: orders.reduce((s, o) => s + (Number(o.total_mrp) || 0), 0)
  };
}

function customerRows(filter) {
  const f = filter || userState.customerFilter;
  const term = f.text.trim().toLowerCase();
  const min = f.min === '' ? null : Number(f.min);
  const max = f.max === '' ? null : Number(f.max);
  const fieldMap = { credit_limit: 'limit', credit_given: 'creditGiven', returned: 'returned', outstanding: 'outstanding', total_orders: 'totalOrders' };
  return userState.customers
    .map(c => ({ c, s: customerStats(c) }))
    .filter(({ c, s }) => {
      if (term) {
        const hay = `${c.company_name || ''} ${c.company_address || ''} ${c.gst_number || ''} ${c.contractor_person || ''} ${c.contractor_number || ''} ${c.contractor_email || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      const v = s[fieldMap[f.field]];
      if (min !== null && v < min) return false;
      if (max !== null && v > max) return false;
      return true;
    });
}

function renderCustomerTable() {
  const tbody = document.getElementById('customersTbody');
  const tfoot = document.getElementById('customersTfoot');
  if (!tbody) return;
  const rows = customerRows();
  tbody.innerHTML = rows.map(({ c, s }) => `
    <tr data-id="${esc(c.customer_id)}">
      <td class="wide"><strong>${esc(c.company_name)}</strong><br><small style="color:#94a3b8;">${esc(c.company_address)}</small></td>
      <td>${esc(c.gst_number) || '-'}</td>
      <td>${esc(c.contractor_person) || '-'}<br><small style="color:#94a3b8;">${esc(c.contractor_number)}</small></td>
      <td class="amt">${money(s.limit)}</td>
      <td class="amt">${money(s.creditGiven)}</td>
      <td class="amt" style="color:#16a34a;">${money(s.returned)}</td>
      <td class="amt"><strong style="color:${overallInfo(s).color};">${overallInfo(s).text}</strong></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn cust-history" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
        <button class="icon-btn cust-credit" title="Add Credit"><i class="fa-solid fa-circle-plus" style="color:#16a34a;"></i></button>
        <button class="icon-btn cust-debit" title="Add Debit"><i class="fa-solid fa-circle-minus" style="color:#d62828;"></i></button>
        <button class="icon-btn cust-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No companies found</td></tr>';

  const tot = rows.reduce((t, { s }) => ({
    limit: t.limit + s.limit, creditGiven: t.creditGiven + s.creditGiven,
    returned: t.returned + s.returned, outstanding: t.outstanding + s.outstanding
  }), { limit: 0, creditGiven: 0, returned: 0, outstanding: 0 });
  tfoot.innerHTML = `
    <tr>
      <td colspan="3">Total (${rows.length} ${rows.length === 1 ? 'company' : 'companies'})</td>
      <td class="amt">${money(tot.limit)}</td>
      <td class="amt">${money(tot.creditGiven)}</td>
      <td class="amt" style="color:#16a34a;">${money(tot.returned)}</td>
      <td class="amt"><strong style="color:${overallInfo(tot).color};">${overallInfo(tot).text}</strong></td>
      <td></td>
    </tr>`;

  const byId = e => userState.customers.find(c => c.customer_id === e.target.closest('tr').dataset.id);
  tbody.querySelectorAll('.cust-history').forEach(b => b.addEventListener('click', e => openCustomerHistory(byId(e))));
  tbody.querySelectorAll('.cust-credit').forEach(b => b.addEventListener('click', e => openCustomerHistory(byId(e), 'credit')));
  tbody.querySelectorAll('.cust-debit').forEach(b => b.addEventListener('click', e => openCustomerHistory(byId(e), 'debit')));
  tbody.querySelectorAll('.cust-edit').forEach(b => b.addEventListener('click', e => openCustomerEditModal(byId(e))));
}

function wireCustomerFilter() {
  const f = userState.customerFilter;
  document.getElementById('applyCustFilter').addEventListener('click', () => {
    f.text = document.getElementById('custSearch').value;
    f.field = document.getElementById('custAmountField').value;
    f.min = document.getElementById('custMin').value;
    f.max = document.getElementById('custMax').value;
    renderCustomerTable();
  });
  document.getElementById('resetCustFilter').addEventListener('click', () => {
    f.text = ''; f.field = 'credit_limit'; f.min = ''; f.max = '';
    document.getElementById('custSearch').value = '';
    document.getElementById('custAmountField').value = 'credit_limit';
    document.getElementById('custMin').value = '';
    document.getElementById('custMax').value = '';
    renderCustomerTable();
  });
}

function tableHTML(head, rows) {
  const th = 'style="text-align:left;padding:8px;"';
  const td = 'style="padding:8px;border-top:1px solid #eef1f6;"';
  return `
    <div style="overflow-x:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead style="background:#f8fafc;"><tr>${head.map(h => `<th ${th}>${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(r => `<tr>${r.map(c => `<td ${td}>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" style="text-align:center;color:#94a3b8;padding:24px;">Nothing to show</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function wireCardClicks() {
  document.querySelectorAll('.cards .card[data-card-filter]').forEach(card =>
    card.addEventListener('click', () => openUserCardDetail(card.dataset.cardFilter)));
}

const CARD_TITLES = { all: 'All Users', admin: 'Admins', accounts: 'Accounts', technician: 'Technicians', distributor: 'Employee-Sales Persons', inventory_manager: 'Inventory Managers', customers: 'All Companies' };

function userCardList(type) {
  return type === 'all' ? userState.users : userState.users.filter(u => u.role === type);
}

function openUserCardDetail(type) {
  const box = document.querySelector('#userCardDetailModal .modal-content');
  let table;
  let count;
  if (type === 'customers') {
    const rows = userState.customers.map(c => ({ c, s: customerStats(c) }));
    count = rows.length;
    table = tableHTML(['Company', 'GST', 'Contact', 'Credit Limit', 'Debit', 'Credit', 'Overall'],
      rows.map(({ c, s }) => [esc(c.company_name), esc(c.gst_number) || '-', `${esc(c.contractor_person) || '-'} ${esc(c.contractor_number)}`, nw(s.limit), nw(s.creditGiven), nw(s.returned), `<span style="white-space:nowrap;">${overallInfo(s).text}</span>`]));
  } else {
    const list = userCardList(type);
    count = list.length;
    table = tableHTML(['Username', 'Name', 'Role', 'Company', 'Mobile'],
      list.map(u => [esc(u.username), esc(u.full_name ?? u.name), displayRole(u.role), esc(u.company_name), esc(u.mobile_no ?? u.phone)]));
  }
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>${CARD_TITLES[type]} <span style="color:#94a3b8;font-weight:400;">(${count})</span></h3>
      <div style="display:flex;align-items:center;gap:10px;">
        <button type="button" class="card-export" style="padding:8px 14px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-download"></i> Export</button>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
    </div>${table}`;
  box.querySelector('.close').addEventListener('click', () => { document.getElementById('userCardDetailModal').style.display = 'none'; });
  box.querySelector('.card-export').addEventListener('click', () => {
    if (type === 'customers') openCompanyExportModal();
    else openUserExportModal({ type });
  });
  document.getElementById('userCardDetailModal').style.display = 'flex';
}

function openCustomerHistory(c, focusEntry) {
  if (!c) return;
  const s = customerStats(c);
  const modal = document.getElementById('customerHistoryModal');
  const box = modal.querySelector('.modal-content');
  const tile = (label, value, color) => `
    <div style="flex:1;min-width:170px;background:#f8fafc;border-radius:10px;padding:12px 14px;">
      <small style="color:#64748b;">${label}</small>
      <div style="font-weight:700;font-size:17px;white-space:nowrap;color:${color || '#0f172a'};">${value}</div>
    </div>`;
  const orderRows = s.orders.map(o => [
    fmtDate(o.order_date),
    esc((o.order_id || '').slice(0, 8)),
    esc((o.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ')),
    esc(o.payment_mode || '-'),
    nw(o.total_mrp),
    o.payment_mode === 'Credit' ? nw(o.total_mrp) : '-'
  ]);
  const entryRows = list => list.map(r => [fmtDate(r.return_date || r.debit_date), nw(r.amount), esc(r.note) || '-', esc(r.added_by) || '-']);
  const purchaseRows = s.purchases.map(p => [
    fmtDate(p.date),
    esc(`${p.product_name || ''}${p.model_no ? ' · ' + p.model_no : ''} x${p.quantity ?? ''}`),
    esc(p.lot_no) || '-',
    p.payment_mode === 'credit' ? 'Credit' : 'Paid',
    nw(p.amount),
    p.payment_mode === 'credit' ? nw(p.amount) : '-'
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const inputCss = 'padding:10px;border:1px solid #e2e8f0;border-radius:8px;';

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <h3>${esc(c.company_name)}</h3>
      <div>
        <button type="button" id="histEdit" style="border:1px solid #1665ff;background:#fff;color:#1665ff;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:12px;margin-right:8px;"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
    </div>
    <p style="font-size:13px;color:#64748b;margin-bottom:12px;">
      ${esc(c.company_address) || '-'} • GST: ${esc(c.gst_number) || '-'}<br>
      ${esc(c.contractor_person) || '-'} • ${esc(c.contractor_number) || '-'} • ${esc(c.contractor_email) || '-'}
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px;">
      ${tile('Credit Limit', money(s.limit))}
      ${tile('Debit', money(s.creditGiven), '#d62828')}
      ${tile('Credit', money(s.returned), '#16a34a')}
      ${tile('Overall', overallInfo(s).text, overallInfo(s).color)}
      ${tile('Available Credit', money(s.available), s.available < 0 ? '#d62828' : '#0f172a')}
    </div>

    <h4 style="margin-bottom:8px;">Add Credit / Debit</h4>
    <div id="histEntryForm" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:6px;">
      <input id="entAmount" type="number" min="0" step="0.01" placeholder="Amount (₹)" style="flex:1;min-width:150px;${inputCss}">
      <input id="entDate" type="date" value="${today}" style="${inputCss}">
      <input id="entNote" placeholder="Note (optional)" style="flex:2;min-width:200px;${inputCss}">
      <button type="button" id="creditSave" style="padding:10px 18px;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-circle-plus"></i> Add Credit</button>
      <button type="button" id="debitSave" style="padding:10px 18px;border:none;border-radius:8px;background:#d62828;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-circle-minus"></i> Add Debit</button>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin-bottom:18px;">Credit is added to the Credit total (payment / adjustment received). Debit is added to the Debit total (extra amount charged). Overall = Credit − Debit.</p>

    <h4 style="margin-bottom:8px;">Order History <span style="color:#94a3b8;font-weight:400;">(${s.orders.length})</span></h4>
    ${tableHTML(['Date', 'Order ID', 'Items', 'Payment', 'Order Total', 'Debit'], orderRows)}
    <p style="text-align:right;font-size:13px;margin:6px 0 18px;"><strong>Total orders: ${money(s.totalOrders)} • Order debit: ${money(s.orderCredit)} • Manual debits: ${money(s.manualDebited)} • Total debit: ${money(s.creditGiven)}</strong></p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px;margin-bottom:18px;">
      <div>
        <h4 style="margin-bottom:8px;color:#16a34a;">Credits <span style="color:#94a3b8;font-weight:400;">(${s.returns.length})</span></h4>
        ${tableHTML(['Date', 'Amount', 'Note', 'Added By'], entryRows(s.returns))}
        <p style="text-align:right;font-size:13px;margin-top:6px;"><strong>Manual credits: ${money(s.manualReturned)} • Credit purchases: ${money(s.purchaseCredit)} • Total credit: ${money(s.returned)}</strong></p>
      </div>
      <div>
        <h4 style="margin-bottom:8px;color:#d62828;">Debits <span style="color:#94a3b8;font-weight:400;">(${s.debits.length})</span></h4>
        ${tableHTML(['Date', 'Amount', 'Note', 'Added By'], entryRows(s.debits))}
        <p style="text-align:right;font-size:13px;margin-top:6px;"><strong>Total manual debits: ${money(s.manualDebited)}</strong></p>
      </div>
    </div>

    <h4 style="margin-bottom:8px;">Purchase History <span style="color:#94a3b8;font-weight:400;">(${s.purchases.length})</span> <small style="color:#94a3b8;font-weight:400;">— bought from this party via Inventory</small></h4>
    ${tableHTML(['Date', 'Item', 'Lot No.', 'Payment', 'Amount', 'Added to Credit'], purchaseRows)}
    <p style="text-align:right;font-size:13px;margin-top:6px;"><strong>Paid purchases: ${money(s.purchasePaid)} • Credit purchases: ${money(s.purchaseCredit)}</strong></p>`;

  box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelector('#histEdit').addEventListener('click', () => { modal.style.display = 'none'; openCustomerEditModal(c); });

  const saveEntry = async kind => {
    const amount = Number(box.querySelector('#entAmount').value);
    if (!amount || amount <= 0) { alert(`Enter a valid ${kind} amount.`); return; }
    const date = box.querySelector('#entDate').value;
    const url = kind === 'credit' ? `/customer/add_return/${c.customer_id}` : `/customer/add_debit/${c.customer_id}`;
    try {
      const res = await apiFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, note: box.querySelector('#entNote').value, return_date: date ? new Date(date).toISOString() : '' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `${kind} could not be added`);
      await loadCustomers();
      openCustomerHistory(userState.customers.find(x => x.customer_id === c.customer_id));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  };
  box.querySelector('#creditSave').addEventListener('click', () => saveEntry('credit'));
  box.querySelector('#debitSave').addEventListener('click', () => saveEntry('debit'));

  modal.style.display = 'flex';
  if (focusEntry) box.querySelector('#entAmount').focus();
}

function openCustomerEditModal(c) {
  if (!c) return;
  const modal = document.getElementById('customerEditModal');
  const box = modal.querySelector('.modal-content');
  const field = (name, label, value, type) => `
    <label style="font-size:13px;color:#64748b;">${label}</label>
    <input name="${name}" type="${type || 'text'}" value="${esc(value)}" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Edit Company</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="custEditForm" style="display:flex;flex-direction:column;gap:6px;">
      ${field('company_name', 'Company Name', c.company_name)}
      ${field('company_address', 'Address', c.company_address)}
      ${field('gst_number', 'GST Number', c.gst_number)}
      ${field('contractor_person', 'Contact Person', c.contractor_person)}
      ${field('contractor_number', 'Contact Number', c.contractor_number)}
      ${field('contractor_email', 'Contact Email', c.contractor_email, 'email')}
      ${field('credit_limit', 'Credit Limit (₹)', c.credit_limit ?? 0, 'number')}
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Save</button>
      </div>
    </form>`;
  box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelector('.cancel-btn').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelector('#custEditForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!String(fd.get('company_name')).trim()) { alert('Company name is required.'); return; }
    const updated_values = {
      company_name: fd.get('company_name').trim(),
      company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number'),
      contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'),
      contractor_email: fd.get('contractor_email'),
      credit_limit: Number(fd.get('credit_limit')) || 0
    };
    try {
      const res = await apiFetch(`/customer/update/${c.customer_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updated_values })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      modal.style.display = 'none';
      await loadCustomers();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}

function distributorOptions(selectedUsername, excludeUsername) {
  const distributors = userState.users.filter(u => u.role === 'distributor' && u.username !== excludeUsername);
  if (!distributors.length) return '<option value="">No existing employee-sales persons yet</option>';
  return '<option value="">Select Team Manager (optional)</option>' +
    distributors.map(d => `<option value="${d.username}" ${d.username === selectedUsername ? 'selected' : ''}>${d.name || d.username} (${d.username})</option>`).join('');
}

function openUserModal(existingUser) {
  const isEdit = !!existingUser;
  const modal = document.getElementById('userModal');
  const content = modal.querySelector('.modal-content');

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${isEdit ? 'Edit User' : 'Add User'}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="userForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="username" placeholder="Username" value="${existingUser?.username ?? ''}" ${isEdit ? 'disabled style="background:#f3f4f6;"' : 'required'}>
      ${isEdit ? '' : `
        <input name="password" type="password" placeholder="Password" required>
        <input name="confirm_password" type="password" placeholder="Confirm Password" required>
      `}
      <input name="name" placeholder="Full Name" value="${existingUser?.name ?? ''}" required>
      <input name="email_id" type="email" placeholder="Email" value="${existingUser?.email ?? existingUser?.email_id ?? ''}" required>
      <input name="mobile_no" placeholder="Mobile Number" value="${existingUser?.mobile_no ?? existingUser?.phone ?? ''}" required>
      <input name="company_name" placeholder="Company Name" value="${existingUser?.company_name ?? ''}" required>
      <input name="gst_number" placeholder="GST Number(if applicable)" value="${existingUser?.gst_number ?? ''}">
      <select name="role" id="roleSelect" required ${isEdit ? 'disabled style="background:#f3f4f6;"' : ''}>
        <option value="">Select Role</option>
        <option value="admin" ${existingUser?.role === 'admin' ? 'selected' : ''}>Admin</option>
        <option value="accounts" ${existingUser?.role === 'accounts' ? 'selected' : ''}>Accounts</option>
        <option value="service_manager" ${existingUser?.role === 'service_manager' ? 'selected' : ''}>Service Manager</option>
        <option value="assembly" ${existingUser?.role === 'assembly' ? 'selected' : ''}>Assembly</option>
        <option value="technician" ${existingUser?.role === 'technician' ? 'selected' : ''}>Technician</option>
        <option value="distributor" ${existingUser?.role === 'distributor' ? 'selected' : ''}>Employee-Sales Person</option>
        <option value="inventory_manager" ${existingUser?.role === 'inventory_manager' ? 'selected' : ''}>Inventory Manager</option>
      </select>
      <div id="managerBox" style="display:none;">
        <label style="font-size:13px;color:#64748b;">Team Manager</label>
        <select name="manager" id="managerSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-top:6px;"></select>
        <p style="font-size:12px;color:#94a3b8;margin-top:4px;">If this employee-sales person reports to another employee-sales person (sales manager), select them here — leave blank if they don't have one.</p>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </form>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  const roleSelect = content.querySelector('#roleSelect');
  const managerBox = content.querySelector('#managerBox');
  const managerSelect = content.querySelector('#managerSelect');

  const refreshManagerBox = () => {
    if (roleSelect.value === 'distributor') {
      managerBox.style.display = 'block';
      managerSelect.innerHTML = distributorOptions(existingUser?.manager, existingUser?.username);
    } else {
      managerBox.style.display = 'none';
    }
  };
  roleSelect.addEventListener('change', refreshManagerBox);
  refreshManagerBox();

  content.querySelector('#userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);

    if (isEdit) {
      const updated_values = {
        name: fd.get('name'),
        email_id: fd.get('email_id').trim().toLowerCase(),
        mobile_no: fd.get('mobile_no'),
        company_name: fd.get('company_name'),
        gst_number: fd.get('gst_number'),
      };
      if (existingUser.role === 'distributor') updated_values.manager = fd.get('manager') || '';
      try {
        const res = await apiFetch(`/login/update_account/${existingUser.username}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updated_values })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'update failed');
        modal.style.display = 'none';
        await loadUsers();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    } else {
      if (fd.get('password') !== fd.get('confirm_password')) { alert('Passwords do not match.'); return; }
      const payload = {
        username: fd.get('username').trim().toLowerCase(),
        password: fd.get('password'),
        confirm_password: fd.get('confirm_password'),
        name: fd.get('name'),
        email_id: fd.get('email_id').trim().toLowerCase(),
        mobile_no: fd.get('mobile_no'),
        company_name: fd.get('company_name'),
        gst_number: fd.get('gst_number'),
        role: fd.get('role'),
        manager: fd.get('role') === 'distributor' ? (fd.get('manager') || '') : ''
      };
      try {
        const res = await apiFetch('/account/create_account/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'account creation failed');
        modal.style.display = 'none';
        await loadUsers();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    }
  });

  modal.style.display = 'flex';
}

function openDeleteModal(u) {
  if (!u) return;
  const modal = document.getElementById('deleteModal');
  modal.style.display = 'flex';

  const oldBtn = modal.querySelector('.delete-btn');
  const deleteBtn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(deleteBtn);

  deleteBtn.addEventListener('click', async () => {
    try {
      const res = await apiFetch(`/login/delete_account/${u.username}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'delete failed');
      modal.style.display = 'none';
      await loadUsers();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// =========================================================
// Export (CSV)
//  - Users: 3 kinds of export (user details / orders / allocations & demo units),
//    for everyone in the current list or only for particular users.
//  - Companies: filters pre-filled from whatever is applied, editable before exporting.
// =========================================================
function downloadCSV(header, rows, filename) {
  const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '﻿' + [header, ...rows].map(r => r.map(q).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function wireExportButtons() {
  document.querySelectorAll('.export-users-btn').forEach(b => b.addEventListener('click', () => openUserExportModal({})));
  document.querySelectorAll('.export-customers-btn').forEach(b => b.addEventListener('click', () => openCompanyExportModal()));
}

function getExportModal() {
  let modal = document.getElementById('exportModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'exportModal';
    modal.className = 'modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1200;';
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
  }
  return modal;
}

async function ensureAllocations() {
  if (!userState.allocations || !userState.allocations.length) await loadAllocations();
  return userState.allocations || [];
}

// same rule as the user detail popup: orders referred by the user (or raised by them)
function orderPerson(o) {
  return o.reference || o.creator?.raised_by || '';
}

function allocTypeLabel(a) {
  if (a.allocation_type === 'spare_part') return 'Spare Part';
  if (a.allocation_type === 'demo_unit') return 'Demo Unit';
  return 'Product Allocation';
}

const EXPORT_KINDS = {
  details: { icon: 'fa-solid fa-id-card', label: 'User details', sub: 'Username, name, role, company, mobile, email, GST, team manager' },
  orders: { icon: 'fa-solid fa-cart-shopping', label: 'Orders', sub: 'Orders created / raised by the selected users' },
  allocations: { icon: 'fa-solid fa-people-carry-box', label: 'Allocations / Demo units', sub: 'Allocations and demo units given to or created by the selected users' }
};

function openUserExportModal(opts) {
  opts = opts || {};
  const modal = getExportModal();
  const fixed = opts.users || (opts.type ? userCardList(opts.type) : null);   // opened from a card -> that card's users
  const title = opts.title || (opts.type ? `Export — ${CARD_TITLES[opts.type]}` : 'Export Users');
  const inp = 'padding:10px;border:1px solid #e2e8f0;border-radius:8px;width:100%;';
  const lbl = 'font-size:13px;color:#64748b;';
  const roleNow = document.getElementById('roleFilter').value;
  const radioCard = (name, value, html, checked) => `
    <label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;cursor:pointer;">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} style="margin-top:4px;">
      <span>${html}</span>
    </label>`;

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:520px;max-width:94vw;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>${esc(title)}</h3>
        <button type="button" class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <form id="exportForm" style="display:flex;flex-direction:column;gap:8px;">
        <label style="${lbl}">What do you want to export?</label>
        ${Object.entries(EXPORT_KINDS).map(([v, k], i) =>
          radioCard('what', v, `<strong style="font-size:14px;"><i class="${k.icon}"></i> ${k.label}</strong><br><small style="color:#64748b;">${k.sub}</small>`, i === 0)).join('')}

        ${fixed ? '' : `
          <label style="${lbl};margin-top:6px;">Role</label>
          <select name="role" style="${inp}">
            ${[['', 'All Roles'], ['admin', 'Admin'], ['accounts', 'Accounts'], ['service_manager', 'Service Manager'], ['assembly', 'Assembly'], ['technician', 'Technician'], ['distributor', 'Employee-Sales Person'], ['inventory_manager', 'Inventory Manager']]
              .map(([v, l]) => `<option value="${v}" ${(roleNow === v || (v === '' && roleNow === 'All Roles')) ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <label style="${lbl}">Search (username or name)</label>
          <input name="text" style="${inp}" placeholder="Search username or name" value="${esc(userState.userSearch)}">`}

        <label style="${lbl};margin-top:6px;">For whom?</label>
        ${radioCard('scope', 'all', `<strong style="font-size:14px;">Everyone in this list</strong> <small style="color:#64748b;">(<span id="allCount">0</span> users)</small>`, true)}
        ${radioCard('scope', 'particular', `<strong style="font-size:14px;">Particular users only</strong>`, false)}

        <div id="pickBox" style="display:none;border:1px solid #e2e8f0;border-radius:10px;padding:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:13px;">
            <span><strong id="pickCount">0</strong> selected</span>
            <span>
              <button type="button" id="pickAll" style="border:none;background:none;color:#1665ff;cursor:pointer;">Select all</button> •
              <button type="button" id="pickNone" style="border:none;background:none;color:#1665ff;cursor:pointer;">Clear</button>
            </span>
          </div>
          <div id="pickList" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;"><i class="fa-solid fa-download"></i> Export</button>
        </div>
      </form>
    </div>`;

  const form = modal.querySelector('#exportForm');
  const roleSel = form.querySelector('[name=role]');
  const textInp = form.querySelector('[name=text]');
  const selected = new Set();
  const baseList = () => fixed || filteredUsers(roleSel ? roleSel.value : '', textInp ? textInp.value : '');
  const scopeVal = () => form.querySelector('[name=scope]:checked').value;
  const updatePickCount = () => { form.querySelector('#pickCount').textContent = baseList().filter(u => selected.has(u.username)).length; };

  const refresh = () => {
    const base = baseList();
    form.querySelector('#allCount').textContent = base.length;
    form.querySelector('#pickBox').style.display = scopeVal() === 'particular' ? 'block' : 'none';
    form.querySelector('#pickList').innerHTML = base.map(u => `
      <label style="display:flex;gap:8px;align-items:center;padding:4px 2px;cursor:pointer;font-size:13px;">
        <input type="checkbox" class="pick" value="${esc(u.username)}" ${selected.has(u.username) ? 'checked' : ''}>
        <span>${esc(u.full_name ?? u.name ?? u.username)} <small style="color:#94a3b8;">(${esc(u.username)}) • ${esc(displayRole(u.role))}</small></span>
      </label>`).join('') || '<p style="color:#94a3b8;font-size:13px;">No users match</p>';
    updatePickCount();
  };

  form.addEventListener('change', e => {
    if (e.target.classList.contains('pick')) {
      if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
      updatePickCount();
    } else {
      refresh();
    }
  });
  form.addEventListener('input', e => { if (e.target === textInp) refresh(); });
  form.querySelector('#pickAll').addEventListener('click', () => { baseList().forEach(u => selected.add(u.username)); refresh(); });
  form.querySelector('#pickNone').addEventListener('click', () => { selected.clear(); refresh(); });
  modal.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('.cancel-btn').addEventListener('click', () => { modal.style.display = 'none'; });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const base = baseList();
    const list = scopeVal() === 'all' ? base : base.filter(u => selected.has(u.username));
    if (!list.length) { alert(scopeVal() === 'all' ? 'No users match these filters.' : 'Select at least one user.'); return; }
    const what = form.querySelector('[name=what]:checked').value;
    const stamp = new Date().toISOString().slice(0, 10);
    const byUsername = new Map(list.map(u => [u.username, u]));
    const nameOf = u => u.full_name ?? u.name ?? '';

    try {
      if (what === 'details') {
        downloadCSV(['Username', 'Name', 'Role', 'Company', 'Mobile', 'Email', 'GST Number', 'Team Manager'],
          list.map(u => [u.username, nameOf(u), displayRole(u.role), u.company_name, u.mobile_no ?? u.phone,
            u.email_id ?? u.email ?? '', u.gst_number ?? '', u.role === 'distributor' ? (u.manager || '') : '']),
          `users_${stamp}.csv`);
      } else if (what === 'orders') {
        const rows = [];
        userState.orders.forEach(o => {
          const u = byUsername.get(orderPerson(o));
          if (!u) return;
          const items = o.items || [];
          const cr = o.creator || {};
          rows.push([u.username, nameOf(u), o.order_id, fmtDate(o.order_date), o.customer?.company_name, o.customer?.gst_number,
            items.map(i => `${i.product_name} x${i.quantity}`).join('; '),
            items.flatMap(i => i.serial_numbers || []).join('; '),
            o.payment_mode, o.total_mrp, o.status,
            cr.type === 'request' ? `Request (approved by ${cr.approved_by || '-'})` : 'Direct']);
        });
        if (!rows.length) { alert('No orders found for the selected users.'); return; }
        downloadCSV(['Username', 'Name', 'Order ID', 'Order Date', 'Company', 'GST', 'Items', 'Serial Numbers', 'Payment Mode', 'Order Total', 'Status', 'Created Via'],
          rows, `user_orders_${stamp}.csv`);
      } else {
        const allocations = await ensureAllocations();
        const rows = [];
        allocations.forEach(a => {
          if (a.allocation_type === 'spare_part') return;
          const u = byUsername.get(a.allocated_by) || byUsername.get(a.sales_person?.username);
          if (!u) return;
          const isSpare = a.allocation_type === 'spare_part';
          const items = isSpare ? [] : (a.items || []);
          const what2 = isSpare
            ? `${a.spare_part?.part_name || ''} x${a.spare_part?.quantity || 1}`
            : items.map(i => `${i.product_name} x${i.quantity}`).join('; ');
          rows.push([u.username, nameOf(u), a.allocation_id, allocTypeLabel(a), fmtDate(a.allotment_date),
            a.customer?.company_name || a.company_name || '', what2,
            items.flatMap(i => i.serial_numbers || []).join('; '),
            a.sales_person?.name || a.allocated_by || '', a.created_by || '',
            a.return_status === 'returned' ? 'Returned' : (a.dispatch ? 'With customer' : 'Allocated'), a.dispatch ? 'Yes' : 'No', a.dispatch?.invoice_no || '']);
        });
        if (!rows.length) { alert('No allocations / demo units found for the selected users.'); return; }
        downloadCSV(['Username', 'Name', 'Allocation ID', 'Type', 'Date', 'Company / Customer', 'Items / Part', 'Serial Numbers', 'Allocated To', 'Created By', 'Return Status', 'Dispatched', 'Invoice No'],
          rows, `user_allocations_${stamp}.csv`);
      }
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not export: ' + err.message);
      return;
    }
    modal.style.display = 'none';
  });

  refresh();
  modal.style.display = 'flex';
}

function openCompanyExportModal() {
  const modal = getExportModal();
  const inp = 'padding:10px;border:1px solid #e2e8f0;border-radius:8px;width:100%;';
  const lbl = 'font-size:13px;color:#64748b;';
  const f = userState.customerFilter;
  const amountOpts = [['credit_limit', 'Credit Limit'], ['credit_given', 'Debit'], ['returned', 'Credit'], ['outstanding', 'Overall'], ['total_orders', 'Total Orders']];

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:400px;max-width:94vw;max-height:88vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>Export Companies</h3>
        <button type="button" class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <form id="exportForm" style="display:flex;flex-direction:column;gap:8px;">
        <label style="${lbl}">Search (company, GST, contact, address)</label>
        <input name="text" style="${inp}" placeholder="Search" value="${esc(f.text)}">
        <label style="${lbl}">Amount field</label>
        <select name="field" style="${inp}">
          ${amountOpts.map(([v, l]) => `<option value="${v}" ${f.field === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <label style="${lbl}">Min amount</label>
        <input name="min" type="number" min="0" style="${inp}" placeholder="Min" value="${esc(f.min)}">
        <label style="${lbl}">Max amount</label>
        <input name="max" type="number" min="0" style="${inp}" placeholder="Max" value="${esc(f.max)}">
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;"><i class="fa-solid fa-download"></i> Export</button>
        </div>
      </form>
    </div>`;

  modal.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('.cancel-btn').addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#exportForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const stamp = new Date().toISOString().slice(0, 10);
    const rows = customerRows({ text: fd.get('text') || '', field: fd.get('field') || 'credit_limit', min: fd.get('min') ?? '', max: fd.get('max') ?? '' });
    if (!rows.length) { alert('No companies match these filters.'); return; }
    downloadCSV(['Company', 'Address', 'GST Number', 'Contact Person', 'Contact Number', 'Contact Email', 'Credit Limit', 'Debit', 'Credit', 'Overall', 'Total Orders'],
      rows.map(({ c, s }) => [c.company_name, c.company_address, c.gst_number, c.contractor_person, c.contractor_number, c.contractor_email,
        s.limit, s.creditGiven, s.returned, overallInfo(s).text, s.totalOrders]),
      `companies_${stamp}.csv`);
    modal.style.display = 'none';
  });
  modal.style.display = 'flex';
}