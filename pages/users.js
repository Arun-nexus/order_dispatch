const userState = { users: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  wireTopActions();
  wireFilter();
  wireStaticModals();
});

async function loadUsers() {
  try {
    const res = await apiFetch('/account/');
    if (!res.ok) throw new Error('failed to fetch users');
    const data = await res.json();
    userState.users = (data.dataset || []).slice().reverse();
    renderCards();
    renderTable(userState.users);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load users.');
  }
}

function renderCards() {
  const users = userState.users;
  document.getElementById('cardTotal').textContent = users.length;
  document.getElementById('cardAdmins').textContent = users.filter(u => u.role === 'admin').length;
  document.getElementById('cardEmployees').textContent = users.filter(u => u.role === 'employee').length;
  document.getElementById('cardTechnicians').textContent = users.filter(u => u.role === 'technician').length;
  document.getElementById('cardDistributors').textContent = users.filter(u => u.role === 'distributor').length;
}

function roleBadgeClass(role) {
  if (role === 'admin') return 'high';
  if (role === 'employee') return 'medium';
  if (role === 'technician') return 'medium';
  return 'high';
}

function renderTable(users) {
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.username = u.username;
    tr.innerHTML = `
      <td>${u.username ?? ''}</td>
      <td>${u.full_name ?? ''}</td>
      <td><span class="stock ${roleBadgeClass(u.role)}">${u.role ?? ''}</span></td>
      <td>${u.company_name ?? ''}</td>
      <td>${u.mobile_no ?? u.phone ?? ''}</td>
      <td>${u.role === 'distributor' ? (u.manager || '-') : '-'}</td>
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
  document.querySelector('.add-product').addEventListener('click', () => openUserModal(null));
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const role = document.getElementById('roleFilter').value;
    const filtered = (!role || role === 'All Roles') ? userState.users : userState.users.filter(u => u.role === role);
    renderTable(filtered);
  });
}

function wireStaticModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));
}

function distributorOptions(selectedUsername, excludeUsername) {
  const distributors = userState.users.filter(u => u.role === 'distributor' && u.username !== excludeUsername);
  if (!distributors.length) return '<option value="">No existing distributors yet</option>';
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
        <option value="employee" ${existingUser?.role === 'employee' ? 'selected' : ''}>Employee</option>
        <option value="technician" ${existingUser?.role === 'technician' ? 'selected' : ''}>Technician</option>
        <option value="distributor" ${existingUser?.role === 'distributor' ? 'selected' : ''}>Distributor</option>
      </select>
      <div id="managerBox" style="display:none;">
        <label style="font-size:13px;color:#64748b;">Team Manager</label>
        <select name="manager" id="managerSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-top:6px;"></select>
        <p style="font-size:12px;color:#94a3b8;margin-top:4px;">If this distributor reports to another distributor (sales manager), select them here — leave blank if they don't have one.</p>
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