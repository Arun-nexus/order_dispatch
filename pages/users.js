const userState = {
  users: [], customers: [], orders: [], tab: 'users', userSearch: '',
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

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString('en-GB') : '-';
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  loadCustomers();
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
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load customers.');
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
      <td>${esc(u.username)}</td>
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

  tbody.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => openUserModal(rowUser(e))));
  tbody.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', e => openDeleteModal(rowUser(e))));
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

function customerStats(c) {
  const orders = userState.orders
    .filter(o => o.customer?.customer_id === c.customer_id)
    .sort((a, b) => new Date(b.order_date) - new Date(a.order_date));
  const creditGiven = orders.filter(o => o.payment_mode === 'Credit').reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);
  const returns = (c.returns || []).slice().sort((a, b) => new Date(b.return_date) - new Date(a.return_date));
  const returned = returns.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const limit = Number(c.credit_limit) || 0;
  const outstanding = Math.max(creditGiven - returned, 0);
  return {
    orders, returns, creditGiven, returned, limit, outstanding,
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
      <td><strong>${esc(c.company_name)}</strong><br><small style="color:#94a3b8;">${esc(c.company_address)}</small></td>
      <td>${esc(c.gst_number) || '-'}</td>
      <td>${esc(c.contractor_person) || '-'}<br><small style="color:#94a3b8;">${esc(c.contractor_number)}</small></td>
      <td>${money(s.limit)}</td>
      <td>${money(s.creditGiven)}</td>
      <td>${money(s.returned)}</td>
      <td><strong style="color:${s.outstanding > 0 ? '#d62828' : '#16a34a'};">${money(s.outstanding)}</strong></td>
      <td>
        <button class="icon-btn cust-history" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
        <button class="icon-btn cust-return" title="Add Return"><i class="fa-solid fa-rotate-left"></i></button>
        <button class="icon-btn cust-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No customers found</td></tr>';

  const tot = rows.reduce((t, { s }) => ({
    limit: t.limit + s.limit, creditGiven: t.creditGiven + s.creditGiven,
    returned: t.returned + s.returned, outstanding: t.outstanding + s.outstanding
  }), { limit: 0, creditGiven: 0, returned: 0, outstanding: 0 });
  tfoot.innerHTML = `
    <tr style="font-weight:700;background:#f8fafc;">
      <td colspan="3">Total (${rows.length} customer${rows.length === 1 ? '' : 's'})</td>
      <td>${money(tot.limit)}</td>
      <td>${money(tot.creditGiven)}</td>
      <td>${money(tot.returned)}</td>
      <td>${money(tot.outstanding)}</td>
      <td></td>
    </tr>`;

  const byId = e => userState.customers.find(c => c.customer_id === e.target.closest('tr').dataset.id);
  tbody.querySelectorAll('.cust-history').forEach(b => b.addEventListener('click', e => openCustomerHistory(byId(e))));
  tbody.querySelectorAll('.cust-return').forEach(b => b.addEventListener('click', e => openCustomerHistory(byId(e), true)));
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

function openUserCardDetail(type) {
  const titles = { all: 'All Users', admin: 'Admins', accounts: 'Accounts', technician: 'Technicians', distributor: 'Employee-Sales Persons', inventory_manager: 'Inventory Managers', customers: 'All Customers' };
  const box = document.querySelector('#userCardDetailModal .modal-content');
  let table;
  let count;
  if (type === 'customers') {
    const rows = userState.customers.map(c => ({ c, s: customerStats(c) }));
    count = rows.length;
    table = tableHTML(['Company', 'GST', 'Contact', 'Credit Limit', 'Credit Given', 'Returned', 'Outstanding'],
      rows.map(({ c, s }) => [esc(c.company_name), esc(c.gst_number) || '-', `${esc(c.contractor_person) || '-'} ${esc(c.contractor_number)}`, money(s.limit), money(s.creditGiven), money(s.returned), money(s.outstanding)]));
  } else {
    const list = type === 'all' ? userState.users : userState.users.filter(u => u.role === type);
    count = list.length;
    table = tableHTML(['Username', 'Name', 'Role', 'Company', 'Mobile'],
      list.map(u => [esc(u.username), esc(u.full_name ?? u.name), displayRole(u.role), esc(u.company_name), esc(u.mobile_no ?? u.phone)]));
  }
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>${titles[type]} <span style="color:#94a3b8;font-weight:400;">(${count})</span></h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>${table}`;
  box.querySelector('.close').addEventListener('click', () => { document.getElementById('userCardDetailModal').style.display = 'none'; });
  document.getElementById('userCardDetailModal').style.display = 'flex';
}

function openCustomerHistory(c, focusReturn) {
  if (!c) return;
  const s = customerStats(c);
  const modal = document.getElementById('customerHistoryModal');
  const box = modal.querySelector('.modal-content');
  const tile = (label, value, color) => `
    <div style="flex:1;min-width:120px;background:#f8fafc;border-radius:10px;padding:10px 12px;">
      <small style="color:#64748b;">${label}</small>
      <div style="font-weight:700;font-size:16px;color:${color || '#0f172a'};">${value}</div>
    </div>`;
  const orderRows = s.orders.map(o => [
    fmtDate(o.order_date),
    esc((o.order_id || '').slice(0, 8)),
    esc((o.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ')),
    esc(o.payment_mode || '-'),
    money(o.total_mrp),
    o.payment_mode === 'Credit' ? money(o.total_mrp) : '-'
  ]);
  const returnRows = s.returns.map(r => [fmtDate(r.return_date), money(r.amount), esc(r.note) || '-', esc(r.added_by) || '-']);
  const today = new Date().toISOString().slice(0, 10);

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
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      ${tile('Credit Limit', money(s.limit))}
      ${tile('Credit Given', money(s.creditGiven))}
      ${tile('Returned', money(s.returned), '#16a34a')}
      ${tile('Outstanding', money(s.outstanding), s.outstanding > 0 ? '#d62828' : '#16a34a')}
      ${tile('Available Credit', money(s.available), s.available < 0 ? '#d62828' : '#0f172a')}
    </div>

    <h4 style="margin-bottom:8px;">Add Return</h4>
    <div id="histReturnForm" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;">
      <input id="retAmount" type="number" min="0" step="0.01" placeholder="Amount (₹)" style="flex:1;min-width:120px;padding:9px;border:1px solid #e2e8f0;border-radius:8px;">
      <input id="retDate" type="date" value="${today}" style="padding:9px;border:1px solid #e2e8f0;border-radius:8px;">
      <input id="retNote" placeholder="Note (optional)" style="flex:2;min-width:160px;padding:9px;border:1px solid #e2e8f0;border-radius:8px;">
      <button type="button" id="retSave" style="padding:9px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600;">Add Return</button>
    </div>

    <h4 style="margin-bottom:8px;">Order History <span style="color:#94a3b8;font-weight:400;">(${s.orders.length})</span></h4>
    ${tableHTML(['Date', 'Order ID', 'Items', 'Payment', 'Order Total', 'Credit Given'], orderRows)}
    <p style="text-align:right;font-size:13px;margin:6px 0 18px;"><strong>Total orders: ${money(s.totalOrders)} • Total credit given: ${money(s.creditGiven)}</strong></p>

    <h4 style="margin-bottom:8px;">Returns <span style="color:#94a3b8;font-weight:400;">(${s.returns.length})</span></h4>
    ${tableHTML(['Date', 'Amount', 'Note', 'Added By'], returnRows)}
    <p style="text-align:right;font-size:13px;margin-top:6px;"><strong>Total returned: ${money(s.returned)}</strong></p>`;

  box.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  box.querySelector('#histEdit').addEventListener('click', () => { modal.style.display = 'none'; openCustomerEditModal(c); });
  box.querySelector('#retSave').addEventListener('click', async () => {
    const amount = Number(box.querySelector('#retAmount').value);
    if (!amount || amount <= 0) { alert('Enter a valid return amount.'); return; }
    const date = box.querySelector('#retDate').value;
    try {
      const res = await apiFetch(`/customer/add_return/${c.customer_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, note: box.querySelector('#retNote').value, return_date: date ? new Date(date).toISOString() : '' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'return could not be added');
      await loadCustomers();
      openCustomerHistory(userState.customers.find(x => x.customer_id === c.customer_id));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
  if (focusReturn) box.querySelector('#retAmount').focus();
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
      <h3>Edit Customer</h3>
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
// Export (CSV) — same filters as the on-screen lists, pre-filled
// from whatever is currently applied, editable before exporting.
// =========================================================
function downloadCSV(header, rows, filename) {
  const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [header, ...rows].map(r => r.map(q).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function wireExportButtons() {
  document.querySelectorAll('.export-users-btn').forEach(b => b.addEventListener('click', () => openExportModal('users')));
  document.querySelectorAll('.export-customers-btn').forEach(b => b.addEventListener('click', () => openExportModal('customers')));
}

function openExportModal(type) {
  let modal = document.getElementById('exportModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'exportModal';
    modal.className = 'modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1200;';
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
  }
  const inp = 'padding:10px;border:1px solid #e2e8f0;border-radius:8px;width:100%;';
  const lbl = 'font-size:13px;color:#64748b;';
  const isUsers = type === 'users';
  const f = userState.customerFilter;
  const roleNow = document.getElementById('roleFilter').value;
  const amountOpts = [['credit_limit', 'Credit Limit'], ['credit_given', 'Credit Given'], ['returned', 'Returned'], ['outstanding', 'Outstanding'], ['total_orders', 'Total Orders']];

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:400px;max-width:94vw;max-height:88vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>Export ${isUsers ? 'Users' : 'Customers'}</h3>
        <button type="button" class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <form id="exportForm" style="display:flex;flex-direction:column;gap:8px;">
        ${isUsers ? `
          <label style="${lbl}">Role</label>
          <select name="role" style="${inp}">
            ${[['', 'All Roles'], ['admin', 'Admin'], ['accounts', 'Accounts'], ['service_manager', 'Service Manager'], ['assembly', 'Assembly'], ['technician', 'Technician'], ['distributor', 'Employee-Sales Person'], ['inventory_manager', 'Inventory Manager']]
              .map(([v, l]) => `<option value="${v}" ${(roleNow === v || (v === '' && roleNow === 'All Roles')) ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <label style="${lbl}">Search (username or name)</label>
          <input name="text" style="${inp}" placeholder="Search username or name" value="${esc(userState.userSearch)}">
        ` : `
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
        `}
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
    if (isUsers) {
      const list = filteredUsers(fd.get('role') || '', fd.get('text') || '');
      if (!list.length) { alert('No users match these filters.'); return; }
      downloadCSV(['Username', 'Name', 'Role', 'Company', 'Mobile', 'Email', 'GST Number', 'Team Manager'],
        list.map(u => [u.username, u.full_name ?? u.name, displayRole(u.role), u.company_name, u.mobile_no ?? u.phone,
          u.email_id ?? u.email ?? '', u.gst_number ?? '', u.role === 'distributor' ? (u.manager || '') : '']),
        `users_${stamp}.csv`);
    } else {
      const rows = customerRows({ text: fd.get('text') || '', field: fd.get('field') || 'credit_limit', min: fd.get('min') ?? '', max: fd.get('max') ?? '' });
      if (!rows.length) { alert('No customers match these filters.'); return; }
      downloadCSV(['Company', 'Address', 'GST Number', 'Contact Person', 'Contact Number', 'Contact Email', 'Credit Limit', 'Credit Given', 'Returned', 'Outstanding', 'Total Orders'],
        rows.map(({ c, s }) => [c.company_name, c.company_address, c.gst_number, c.contractor_person, c.contractor_number, c.contractor_email,
          s.limit, s.creditGiven, s.returned, s.outstanding, s.totalOrders]),
        `customers_${stamp}.csv`);
    }
    modal.style.display = 'none';
  });
  modal.style.display = 'flex';
}