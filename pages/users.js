const userState = { users: [], activeUsername: null };

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  wireTopActions();
  wireFilter();
  wireModals();
});

async function loadUsers() {
  try {
    const res = await apiFetch('/account/');
    if (!res.ok) throw new Error('failed to fetch users');
    const data = await res.json();
    userState.users = data.dataset || [];
    renderUsersTable(userState.users);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load users data.');
    }
  }
}

function roleClass(role) {
  const map = {
    admin: 'admin-role',
    employee: 'employee-role',
    technician: 'tech-role',
    distributor: 'distributor-role'
  };
  return map[role] || 'employee-role';
}

function renderUsersTable(users) {
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.username = u.username;
    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td>${u.user_id?.slice(0, 8) ?? ''}</td>
      <td>${u.username ?? ''}</td>
      <td>${u.full_name ?? ''}</td>
      <td>${u.email_id ?? ''}</td>
      <td>${u.mobile_no ?? ''}</td>
      <td>${u.company_name ?? ''}</td>
      <td>${u.gst_number ?? ''}</td>
      <td><span class="${roleClass(u.role)}">${u.role ?? ''}</span></td>
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        <button class="icon-btn edit-btn"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn delete delete-btn"><i class="fa-solid fa-trash"></i></button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => openViewModal(rowUser(e))));
  tbody.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', e => openEditModal(rowUser(e))));
  tbody.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', e => openDeleteModal(rowUser(e))));
}

function rowUser(e) {
  const tr = e.target.closest('tr');
  return userState.users.find(u => u.username === tr.dataset.username);
}

function wireTopActions() {
  document.querySelector('.add-user').addEventListener('click', () => {
    document.querySelector('#addModal form').reset();
    document.getElementById('addModal').style.display = 'flex';
  });
  document.querySelector('.export').addEventListener('click', exportUsersCSV);
}

function exportUsersCSV() {
  const header = ['User ID', 'Username', 'Full Name', 'Email', 'Phone', 'Company', 'GST Number', 'Role'];
  const rows = userState.users.map(u => [u.user_id, u.username, u.full_name, u.email_id, u.mobile_no, u.company_name, u.gst_number, u.role]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'users.csv';
  a.click();
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const searchBox = document.querySelector('.filter-box input');
    const roleSelect = document.querySelector('.filter-box select');
    const companyBox = document.querySelectorAll('.filter-box input')[1];

    const term = searchBox.value.trim().toLowerCase();
    const role = roleSelect.value.trim().toLowerCase();
    const company = companyBox.value.trim().toLowerCase();

    const filtered = userState.users.filter(u => {
      const haystack = `${u.username} ${u.email_id} ${u.mobile_no}`.toLowerCase();
      const roleOk = role === 'all roles' || !role || (u.role || '').toLowerCase() === role;
      const companyOk = !company || (u.company_name || '').toLowerCase().includes(company);
      return (!term || haystack.includes(term)) && roleOk && companyOk;
    });
    renderUsersTable(filtered);
  });
}

function openViewModal(u) {
  if (!u) return;
  const modal = document.getElementById('viewModal');
  const values = modal.querySelectorAll('.detail p');
  const fields = [u.user_id, u.username, u.full_name, u.mobile_no, u.email_id, u.company_name, u.gst_number, u.role];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
  modal.style.display = 'flex';
}

function openEditModal(u) {
  if (!u) return;
  userState.activeUsername = u.username;
  const modal = document.getElementById('editModal');
  const inputs = modal.querySelectorAll('form input');
  const select = modal.querySelector('form select');
  inputs[0].value = u.username ?? '';
  inputs[1].value = u.full_name ?? '';
  inputs[2].value = u.mobile_no ?? '';
  inputs[3].value = u.email_id ?? '';
  inputs[4].value = u.company_name ?? '';
  inputs[5].value = u.gst_number ?? '';
  if (select) {
    [...select.options].forEach(opt => {
      opt.selected = opt.value.toLowerCase() === (u.role || '').toLowerCase()
        || opt.textContent.trim().toLowerCase() === (u.role || '').toLowerCase();
    });
  }
  modal.style.display = 'flex';
}

function openDeleteModal(u) {
  if (!u) return;
  userState.activeUsername = u.username;
  document.getElementById('deleteModal').style.display = 'flex';
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  document.querySelector('#addModal form').addEventListener('submit', async e => {
    e.preventDefault();
    const inputs = e.target.querySelectorAll('input');
    const select = e.target.querySelector('select');
    const role = select.value.trim().toLowerCase();
    const password = inputs[6].value;

    const payload = {
      username: inputs[0].value,
      password,
      confirm_password: password,
      name: inputs[1].value,
      email_id: inputs[3].value,
      gst_number: inputs[5].value,
      company_name: inputs[4].value,
      mobile_no: inputs[2].value,
      role
    };

    try {
      const res = await apiFetch('/account/create_account/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'account creation failed');
      document.getElementById('addModal').style.display = 'none';
      await loadUsers();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });

  document.querySelector('#editModal form').addEventListener('submit', async e => {
    e.preventDefault();
    const inputs = e.target.querySelectorAll('input');
    const select = e.target.querySelector('select');
    const updated_values = {
      full_name: inputs[1].value,
      mobile_no: inputs[2].value,
      email_id: inputs[3].value,
      company_name: inputs[4].value,
      gst_number: inputs[5].value,
      role: select.value.trim().toLowerCase()
    };
    try {
      const res = await apiFetch(`/login/update_account/${userState.activeUsername}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      document.getElementById('editModal').style.display = 'none';
      await loadUsers();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });

  document.querySelector('#deleteModal .delete-btn').addEventListener('click', async () => {
    try {
      const res = await apiFetch(`/login/delete_account/${userState.activeUsername}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'delete failed');
      document.getElementById('deleteModal').style.display = 'none';
      await loadUsers();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}