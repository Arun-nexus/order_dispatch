const AUTH = {
  tokenKey: 'acer_token',
  roleKey: 'acer_role',
  usernameKey: 'acer_username',
};

const ROLE_ACCESS = {
  admin:       ['main_dashboard.html', 'orders.html', 'inventory.html', 'service.html', 'users.html', 'reports.html'],
  employee:    ['main_dashboard.html', 'orders.html', 'inventory.html', 'service.html', 'reports.html'],
  technician:  ['main_dashboard.html', 'service.html'],
  distributor: ['main_dashboard.html', 'orders.html'],
};

const ROLE_HOME = {
  admin: 'main_dashboard.html',
  employee: 'main_dashboard.html',
  technician: 'service.html',
  distributor: 'orders.html',
};

function getToken() {
  return localStorage.getItem(AUTH.tokenKey);
}

function getRole() {
  return localStorage.getItem(AUTH.roleKey);
}

function getUsername() {
  return localStorage.getItem(AUTH.usernameKey);
}

function saveSession(token, role, username) {
  localStorage.setItem(AUTH.tokenKey, token);
  localStorage.setItem(AUTH.roleKey, role);
  localStorage.setItem(AUTH.usernameKey, username || '');
}

function clearSession() {
  localStorage.removeItem(AUTH.tokenKey);
  localStorage.removeItem(AUTH.roleKey);
  localStorage.removeItem(AUTH.usernameKey);
}

function loginPath() {
  return location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
}

function homePathFor(role) {
  const page = ROLE_HOME[role] || 'main_dashboard.html';
  if (page === 'main_dashboard.html') {
    return location.pathname.includes('/pages/') ? '../main_dashboard.html' : 'main_dashboard.html';
  }
  return location.pathname.includes('/pages/') ? page : `pages/${page}`;
}

function requireAuth() {
  const token = getToken();
  const role = getRole();
  if (!token || !role) {
    window.location.href = loginPath();
    return false;
  }
  return true;
}

function checkPageAccess() {
  const role = getRole();
  if (!role) return;
  const currentFile = location.pathname.split('/').pop() || 'main_dashboard.html';
  const allowed = ROLE_ACCESS[role] || [];
  if (!allowed.includes(currentFile)) {
    alert('Aapke role ko is page ki permission nahi hai.');
    window.location.href = homePathFor(role);
  }
}

function filterSidebarByRole() {
  const role = getRole();
  const allowed = ROLE_ACCESS[role] || [];
  document.querySelectorAll('.sidebar ul li a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const file = href.split('/').pop();
    if (file && !allowed.includes(file)) {
      a.closest('li').style.display = 'none';
    }
  });
}
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers || {}, {
    Authorization: token ? `Bearer ${token}` : '',
  });
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    alert('Session expired, please login again.');
    window.location.href = loginPath();
    throw new Error('unauthorized');
  }
  if (res.status === 403) {
    alert('Aapke role ko is action ki permission nahi hai.');
    throw new Error('forbidden');
  }
  return res;
}

function logoutNow() {
  clearSession();
  window.location.href = loginPath();
}

document.addEventListener('DOMContentLoaded', () => {
  if (requireAuth()) {
    checkPageAccess();
    filterSidebarByRole();
  }
});3