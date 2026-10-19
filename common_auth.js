const AUTH = {
  tokenKey: 'acer_token',
  roleKey: 'acer_role',
  usernameKey: 'acer_username',
};

const ROLE_ACCESS = {
  admin:           ['main_dashboard.html', 'qc.html', 'orders.html', 'inventory.html', 'service.html', 'allocated.html', 'dispatch.html', 'shipment.html', 'assembly.html', 'users.html', 'reports.html', 'create_account.html', 'attendance.html', 'work_report.html'],
  accounts:        ['main_dashboard.html', 'orders.html', 'inventory.html', 'service.html', 'allocated.html', 'dispatch.html', 'shipment.html', 'assembly.html', 'users.html', 'reports.html', 'work_report.html'],
  service_manager: ['service.html', 'inventory.html', 'dispatch.html','allocated.html', 'work_report.html'],
  assembly:        ['assembly.html', 'inventory.html', 'work_report.html'],
  technician:      ['technician.html','technician_dashboard.html', 'work_report.html'],
  distributor:     ['distributor.html', 'distributor_orders.html', 'distributor_team.html','technician.html', 'work_report.html'],
  inventory_manager: ['inventory.html', 'distributor.html', 'distributor_orders.html', 'assembly.html', 'shipment.html', 'work_report.html'],
  qc:              ['qc.html'],
};

const ROLE_HOME = {
  admin: 'main_dashboard.html',
  accounts: 'main_dashboard.html',
  service_manager: 'service.html',
  assembly: 'assembly.html',
  technician: 'technician.html',
  distributor: 'distributor.html',
  inventory_manager: 'inventory.html',
  qc: 'qc.html',
};

// Every page that can be granted from the hidden /access-control page.
const PAGE_CATALOG = [
  { file: 'main_dashboard.html',       label: 'Dashboard',            icon: 'fa-house' },
  { file: 'orders.html',               label: 'Orders',               icon: 'fa-cart-shopping' },
  { file: 'inventory.html',            label: 'Inventory',            icon: 'fa-boxes-stacked' },
  { file: 'shipment.html',             label: 'Shipment',             icon: 'fa-boxes-packing' },
  { file: 'assembly.html',             label: 'Assembly',             icon: 'fa-gears' },
  { file: 'service.html',              label: 'Service',              icon: 'fa-screwdriver-wrench' },
  { file: 'allocated.html',            label: 'Allocated',            icon: 'fa-people-carry-box' },
  { file: 'dispatch.html',             label: 'Dispatch',             icon: 'fa-truck-fast' },
  { file: 'attendance.html',           label: 'Attendance',           icon: 'fa-calendar-check' },
  { file: 'users.html',                label: 'Users',                icon: 'fa-users' },
  { file: 'reports.html',              label: 'Reports',              icon: 'fa-chart-column' },
  { file: 'qc.html',                   label: 'QC',                   icon: 'fa-clipboard-check' },
  { file: 'work_report.html',          label: 'Work Report',          icon: 'fa-list-check' },
  { file: 'distributor.html',          label: 'Distributor',          icon: 'fa-handshake' },
  { file: 'distributor_orders.html',   label: 'Distributor Orders',   icon: 'fa-cart-flatbed' },
  { file: 'distributor_team.html',     label: 'Distributor Team',     icon: 'fa-people-group' },
  { file: 'technician.html',           label: 'Technician',           icon: 'fa-user-gear' },
  { file: 'technician_dashboard.html', label: 'Technician Dashboard', icon: 'fa-gauge' },
  { file: 'create_account.html',       label: 'Create Account',       icon: 'fa-user-plus' },
];

// Hidden admin page (not in any sidebar): always open for admins, never grantable to others.
const ACCESS_PAGE = 'access_control.html';
const PAGES_KEY = 'acer_pages';

// Per-user override set from /access-control. null = no override -> the role's default pages.
function getCustomPages() {
  try {
    const v = JSON.parse(localStorage.getItem(PAGES_KEY));
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) { return null; }
}

function allowedPages(role) {
  const custom = getCustomPages();
  const list = custom || ROLE_ACCESS[role] || [];
  return role === 'admin' ? [...new Set([...list, ACCESS_PAGE])] : list;
}

// Only these two usernames can assign / manage work (any role, even admin). Must match WORK_MANAGERS in app.py.
const WORK_MANAGERS = ['prashant', 'arun'];

function isWorkManager(username) {
  return WORK_MANAGERS.includes(String(username ?? getUsername() ?? '').trim().toLowerCase());
}

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
  localStorage.removeItem(PAGES_KEY);
}

function loginPath() {
  return location.pathname.includes('/pages/') ? '/index.html' : 'index.html';
}

function homePathFor(role) {
  const allowed = allowedPages(role).filter(p => p !== ACCESS_PAGE);
  let page = ROLE_HOME[role] || 'main_dashboard.html';
  if (allowed.length && !allowed.includes(page)) page = allowed[0];
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
  if (currentFile === 'work.html') {
    if (!isWorkManager()) {
      alert('Only Director can assign work.');
      window.location.href = homePathFor(role);
    }
    return;
  }
  if (currentFile === 'work_report.html' && isWorkManager()) {
    window.location.href = 'work.html';
    return;
  }
  const allowed = allowedPages(role);
  if (!allowed.includes(currentFile)) {
    alert('Your role doesnt have access to do that action');
    window.location.href = homePathFor(role);
  }
}

function filterSidebarByRole() {
  const role = getRole();
  const allowed = allowedPages(role);
  document.querySelectorAll('.sidebar ul li a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const file = href.split('/').pop();
    if (file && !allowed.includes(file)) {
      a.closest('li').style.display = 'none';
    }
  });
}
// When an admin gave this user a custom page list, add sidebar links for granted pages the
// current page's sidebar doesn't have (e.g. an Orders link on a technician's sidebar).
function injectAllowedLinks() {
  const custom = getCustomPages();
  const ul = document.querySelector('.sidebar ul');
  if (!custom || !ul) return;
  const inPages = location.pathname.includes('/pages/');
  const present = new Set([...ul.querySelectorAll('a')].map(a => (a.getAttribute('href') || '').split('/').pop()));
  const logout = [...ul.querySelectorAll('li')].find(x => x.querySelector('a[onclick*="openLogoutModal"]'));
  PAGE_CATALOG.forEach(p => {
    if (!custom.includes(p.file) || present.has(p.file)) return;
    const href = p.file === 'main_dashboard.html' ? (inPages ? '../main_dashboard.html' : 'main_dashboard.html') : (inPages ? p.file : 'pages/' + p.file);
    const li = document.createElement('li');
    li.innerHTML = `<a href="${href}"><i class="fa-solid ${p.icon}"></i><span>${p.label}</span></a>`;
    if (logout) ul.insertBefore(li, logout); else ul.appendChild(li);
  });
}

// Keeps the stored page list in sync with what the admin set, without needing a re-login.
async function syncMyAccess() {
  try {
    const res = await fetch('/account/my_access', { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return;
    const data = await res.json();
    const fresh = Array.isArray(data.allowed_pages) && data.allowed_pages.length ? data.allowed_pages : null;
    if (JSON.stringify(fresh) !== JSON.stringify(getCustomPages())) {
      if (fresh) localStorage.setItem(PAGES_KEY, JSON.stringify(fresh)); else localStorage.removeItem(PAGES_KEY);
      location.reload();     // page guard + sidebar re-run with the new list
    }
  } catch (e) { /* offline / server busy: keep what we have */ }
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
    alert('Your role doesnt have access to do that action');
    throw new Error('forbidden');
  }
  return res;
}

// Sidebar scrolls on its own when the menu is taller than the screen
// (injected here so every page that loads common_auth.js gets it).
(function () {
  const st = document.createElement('style');
  st.textContent = `
    .sidebar { overflow-y: auto; overflow-x: hidden; max-height: 100vh; scrollbar-width: thin; }
    .sidebar::-webkit-scrollbar { width: 6px; }
    .sidebar::-webkit-scrollbar-thumb { background: rgba(255,255,255,.35); border-radius: 6px; }`;
  document.head.appendChild(st);
})();

function logoutNow() {
  clearSession();
  window.location.href = loginPath();
}

document.addEventListener('DOMContentLoaded', () => {
  if (requireAuth()) {
    checkPageAccess();
    injectAllowedLinks();
    filterSidebarByRole();
    syncMyAccess();
    initNotificationBell();
    initMessaging();
    initWorkPopup();
    if (getRole() === 'distributor') {
      setTimeout(() => ['sidebarUserRole', 'headerUserRole'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'Sales';
      }), 0);
    }
  }
});

// =========================================================
// Shared response popup ("wizard box") — replaces plain
// alert()/JS notifications for success & error messages.
// Available on every page since common_auth.js loads first.
// =========================================================
function ensureResponseModal() {
  let modal = document.getElementById('appResponseModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'appResponseModal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:2000;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;width:380px;max-width:90vw;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.2);">
      <div id="appResponseIcon" style="width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:26px;"></div>
      <h3 id="appResponseTitle" style="margin-bottom:8px;color:#0f172a;"></h3>
      <p id="appResponseMessage" style="color:#64748b;margin-bottom:22px;font-size:14px;line-height:1.5;"></p>
      <button id="appResponseOkBtn" style="border:none;border-radius:10px;padding:12px 28px;background:#1665ff;color:#fff;font-weight:600;cursor:pointer;">OK</button>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#appResponseOkBtn').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  return modal;
}

/**
 * Show a wizard-style popup instead of alert()/a toast notification.
 * @param {string} title
 * @param {string} message
 * @param {boolean} success - true = green check, false = red x
 */
function showResponseModal(title, message, success = true) {
  const modal = ensureResponseModal();
  const icon = modal.querySelector('#appResponseIcon');
  modal.querySelector('#appResponseTitle').textContent = title;
  modal.querySelector('#appResponseMessage').textContent = message;

  if (success) {
    icon.style.background = '#dcfce7';
    icon.style.color = '#16a34a';
    icon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
  } else {
    icon.style.background = '#fee2e2';
    icon.style.color = '#dc2626';
    icon.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
  }

  modal.style.display = 'flex';
}

// =========================================================
// Every plain alert() across the app now routes through the
// wizard popup instead of a native JS notification.
// =========================================================
const _nativeAlert = window.alert.bind(window);
window.alert = function (message) {
  const text = String(message ?? '');
  const lower = text.toLowerCase();
  const looksLikeError = /fail|error|cannot|not allow|invalid|required|denied|already|insufficient|missing|expired/.test(lower);
  showResponseModal(looksLikeError ? 'Something went wrong' : 'Notice', text, !looksLikeError);
};

// =========================================================
// Bell icon notifications — replaces on-screen "pending
// requests" panels. Admin/employee see every pending request
// with quick approve/reject; distributor/technician see the
// status of their own requests.
// =========================================================
let _notifPoll = null;

function ensureBellUI() {
  let bellBtn = document.getElementById('notifBell');
  if (!bellBtn) {
    // fall back to the first bell-icon button already in the header
    const icon = document.querySelector('.right-header i.fa-bell, .right-header i.fa-regular.fa-bell, header i.fa-bell');
    if (icon) bellBtn = icon.closest('button');
  }
  if (!bellBtn) return null;
  bellBtn.id = 'notifBell';
  bellBtn.style.position = 'relative';

  let badge = document.getElementById('notifBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'notifBadge';
    badge.style.cssText = 'display:none;position:absolute;top:2px;right:2px;background:#d62828;color:#fff;font-size:10px;border-radius:999px;padding:1px 5px;';
    badge.textContent = '0';
    bellBtn.style.position = 'relative';
    bellBtn.appendChild(badge);
  }

  let panel = document.getElementById('notifPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notifPanel';
    panel.style.cssText = 'display:none;position:absolute;top:110%;right:0;background:#fff;border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.18);width:340px;max-height:420px;overflow-y:auto;z-index:1500;padding:10px;';
    bellBtn.style.position = 'relative';
    (bellBtn.parentElement || document.body).style.position = 'relative';
    (bellBtn.parentElement || document.body).appendChild(panel);

    bellBtn.addEventListener('click', e => {
      e.stopPropagation();
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
      if (panel.style.display === 'block') loadNotifications();
    });
    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== bellBtn) panel.style.display = 'none';
    });
  }
  return { bellBtn, badge, panel };
}

function notifItemHtml(r, isManager) {
  const typeLabels = { demo_unit: 'Demo Unit', order: 'Order', spare_part: 'Spare Part', media_review: 'Service Media', status_update: 'Service Status Update', service: 'New Service', convert_to_order: 'Convert to Order', return_demo: 'Demo Return' };
  const label = typeLabels[r.request_type] || r.request_type;
  const who = r.raised_by ? `by ${rqEsc(r.raised_by)}` : '';
  let sub = '';
  if (['demo_unit', 'order', 'convert_to_order', 'return_demo'].includes(r.request_type)) {
    sub = (r.details?.items || []).map(i => `${rqEsc(i.product_name)} x${i.quantity}`).join(', ');
  } else if (r.request_type === 'spare_part') {
    sub = rqEsc(r.details?.note || '');
  } else if (r.request_type === 'service') {
    sub = `${rqEsc(r.details?.product_id || '')} — ${rqEsc(r.details?.issue || '')}`;
  } else if (r.request_type === 'media_review') {
    sub = `Service #${(r.details?.service_id || '').slice(0, 8)} uploaded media`;
  } else if (r.request_type === 'status_update') {
    sub = `Service #${(r.details?.service_id || '').slice(0, 8)} — change status to "${rqEsc((r.details?.service_status || '').replace('_', ' '))}"`;
  }
  let pill;
  if (r.status === 'pending') pill = '<span class="status pending">Pending</span>';
  else if (r.status === 'partially_approved') pill = `<span class="status pending">${isManager ? 'Partially approved' : 'Action needed'}</span>`;
  else if (r.status === 'approved' || r.status === 'partial_accepted') pill = `<span class="status delivered">${r.status === 'approved' ? 'approved' : 'partial accepted'}</span>`;
  else pill = `<span class="status cancelled">${rqEsc(r.status.replace('_', ' '))}</span>`;

  return `
    <div class="notif-item" data-rid="${r.request_id}" style="border-bottom:1px solid #eef1f6;padding:10px 4px;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          <strong style="font-size:13px;">${label}</strong> ${who}
          <p style="font-size:12px;color:#64748b;margin-top:2px;">${sub}${r.reason && r.status !== 'approved' ? ' — ' + rqEsc(r.reason) : ''}</p>
        </div>
        ${pill}
      </div>
      <p style="font-size:11px;color:#1665ff;margin-top:4px;">Tap to view details</p>
    </div>`;
}

let _notifData = {};

async function loadNotifications() {
  const role = getRole();
  const ui = ensureBellUI();
  if (!ui) return;

  try {
    const isManager = ['admin', 'accounts', 'service_manager', 'employee'].includes(role);
    const res = await apiFetch(isManager ? '/request/' : '/request/mine');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const all = data.dataset || [];
    const badgeCount = all.filter(r => r.status === (isManager ? 'pending' : 'partially_approved')).length;

    ui.badge.textContent = badgeCount;
    ui.badge.style.display = badgeCount ? 'block' : 'none';

    const sorted = [...all].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 25);
    _notifData = {};
    sorted.forEach(r => { _notifData[r.request_id] = r; });
    ui.panel.innerHTML = sorted.length
      ? `<h4 style="padding:6px 4px 10px;">Notifications</h4>` + sorted.map(r => notifItemHtml(r, isManager)).join('')
      : '<p style="padding:16px;color:#94a3b8;font-size:13px;">No notifications yet.</p>';

    ui.panel.querySelectorAll('.notif-item').forEach(el => el.addEventListener('click', () => {
      ui.panel.style.display = 'none';
      openRequestPopup(_notifData[el.dataset.rid]);
    }));
  } catch (err) {
    console.error(err);
  }
}

async function notifApprove(requestId) {
  try {
    const res = await apiFetch(`/request/approve/${requestId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'approval failed');
    showResponseModal('Request approved', 'The request was approved successfully.', true);
    await loadNotifications();
    if (typeof window.refreshCurrentPageData === 'function') window.refreshCurrentPageData();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Approval failed', err.message, false);
  }
}

async function notifReject(requestId) {
  try {
    const res = await apiFetch(`/request/reject/${requestId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Rejected from notifications' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'rejection failed');
    showResponseModal('Request rejected', 'The request was rejected.', true);
    await loadNotifications();
    if (typeof window.refreshCurrentPageData === 'function') window.refreshCurrentPageData();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Rejection failed', err.message, false);
  }
}

function rqEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rqItemLine(i) {
  const meta = [i.product_id, i.model_no].filter(Boolean).join(' · ');
  return `${rqEsc(i.product_name || '')}${meta ? ` <span style="color:#94a3b8;">(${rqEsc(meta)})</span>` : ''} x${i.quantity ?? 1}${i.price ? ' @ ₹' + rqEsc(i.price) : ''}`;
}

function partialInfoHtml(d) {
  const p = d && d.partial;
  if (!p) return '';
  const list = arr => (arr || []).map(i => `<div style="font-size:13px;margin:2px 0;">${rqItemLine(i)}</div>`).join('') || '-';
  return `
    <div style="border:1px solid #fde68a;background:#fffbeb;border-radius:10px;padding:10px 12px;margin:10px 0;">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#92400e;"><i class="fa-solid fa-circle-half-stroke"></i> Partial approval</div>
      <small style="color:#16a34a;font-weight:600;">Approved</small>${list(p.approved_items)}
      <small style="color:#d62828;font-weight:600;display:block;margin-top:6px;">Not approved</small>${list(p.unapproved_items)}
      <small style="color:#64748b;display:block;margin-top:6px;">Remarks by ${rqEsc(p.by || '-')}</small>
      <div style="font-size:13px;">${rqEsc(p.remarks || '-')}</div>
    </div>`;
}

function closeRequestPopup() {
  const el = document.getElementById('reqPopup');
  if (el) el.remove();
}

async function afterRequestAction(title, msg) {
  closeRequestPopup();
  showResponseModal(title, msg, true);
  await loadNotifications();
  if (typeof window.refreshCurrentPageData === 'function') window.refreshCurrentPageData();
  else if (typeof loadPendingRequests === 'function') loadPendingRequests();
}

async function rqPost(url, body, okTitle) {
  try {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'action failed');
    await afterRequestAction(okTitle, data.message || 'Done');
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Action failed', err.message, false);
  }
}

function openRequestPopup(r) {
  if (!r) return;
  closeRequestPopup();
  const role = getRole();
  const isManager = ['admin', 'accounts', 'service_manager', 'employee'].includes(role);
  const d = r.details || {};
  const items = d.items || [];
  const canAct = isManager && r.status === 'pending';
  const distAct = role === 'distributor' && r.status === 'partially_approved';
  const canPartial = canAct && ['demo_unit', 'order'].includes(r.request_type) && items.length > 1;
  const labels = { demo_unit: 'Demo Unit Request', order: 'Order Request', spare_part: 'Spare Part Request', media_review: 'Service Media Review', status_update: 'Status Change Request', service: 'New Service Request', convert_to_order: 'Convert Demo to Order', return_demo: 'Demo Return' };

  const itemRows = items.map((i, n) => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:10px;margin:6px 0;${canPartial ? 'cursor:pointer;' : ''}">
      ${canPartial ? `<input type="checkbox" class="rq-chk" data-i="${n}">` : ''}
      <span style="font-size:13px;">${rqItemLine(i)}</span>
    </label>`).join('');

  const rows = [];
  const row = (k, v) => { if (v) rows.push(`<div style="margin:6px 0;"><small style="color:#94a3b8;">${k}</small><p style="margin:0;font-size:13px;">${rqEsc(v)}</p></div>`); };
  row('Raised By', r.raised_by);
  row('Requested On', r.created_at ? new Date(r.created_at).toLocaleString('en-GB') : '');
  row('Customer', d.customer?.company_name);
  row('Remarks', d.remarks);
  row('Payment Mode', d.payment_mode);
  row('Discount', d.discount ? '₹' + d.discount : '');
  row('Spare Part', d.note);
  row('Service ID', d.service_id);
  row('Issue', d.issue);
  row('Requested Status', (d.service_status || '').replace('_', ' '));
  row('Reason', d.reason);
  row('Returned Through', d.returned_through);
  row('Status', (r.status || '').replace('_', ' '));
  if (r.status === 'rejected' || r.status === 'partial_rejected') row('Rejection Reason', r.reason);

  const btn = (cls, bg, txt) => `<button class="${cls}" style="flex:1;padding:9px 10px;border:none;border-radius:8px;background:${bg};color:#fff;cursor:pointer;font-size:13px;font-weight:600;">${txt}</button>`;
  let footer = '';
  if (canAct) {
    footer = `
      <textarea id="rqRemarks" rows="2" placeholder="${canPartial ? 'Remarks (required for partial approval, optional for reject)' : 'Reason (optional for reject)'}" style="width:100%;margin-top:10px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        ${btn('rq-approve', '#16a34a', 'Approve')}
        ${canPartial ? btn('rq-partial', '#d97706', 'Partial Approve') : ''}
        ${btn('rq-reject', '#d62828', 'Reject')}
      </div>
      ${canPartial ? '<p style="font-size:11px;color:#64748b;margin-top:6px;">For partial approval tick the products you approve; the rest go back to the distributor with your remarks.</p>' : ''}`;
  } else if (distAct) {
    footer = `
      <textarea id="rqRemarks" rows="2" placeholder="Reason (optional)" style="width:100%;margin-top:10px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        ${btn('rq-accept', '#16a34a', 'Accept approved items')}
        ${btn('rq-decline', '#d62828', 'Reject')}
      </div>
      <p style="font-size:11px;color:#64748b;margin-top:6px;">Accepting raises a new request for the approved products only. Rejecting closes this request permanently.</p>`;
  }

  const overlay = document.createElement('div');
  overlay.id = 'reqPopup';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:2000;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:22px;width:min(480px,94vw);max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;">${labels[r.request_type] || 'Request'}</h3>
        <button class="rq-close" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
      </div>
      ${itemRows ? `<small style="color:#94a3b8;">Products</small>${itemRows}` : ''}
      ${rows.join('')}
      ${partialInfoHtml(d)}
      ${footer}
    </div>`;
  document.body.appendChild(overlay);

  const q = s => overlay.querySelector(s);
  const remarks = () => (q('#rqRemarks')?.value || '').trim();
  overlay.addEventListener('click', e => { if (e.target === overlay) closeRequestPopup(); });
  q('.rq-close').addEventListener('click', closeRequestPopup);

  q('.rq-approve')?.addEventListener('click', () => {
    if (r.request_type === 'convert_to_order') {
      closeRequestPopup();
      if (typeof openInvoiceModal === 'function') return openInvoiceModal(r);
      return showResponseModal('Invoice details needed', 'Approve this request from the Allocated page.', false);
    }
    if (r.request_type === 'status_update') {
      return showResponseModal('Use Service page', "Complete this from the Service page's Update Status action.", false);
    }
    closeRequestPopup();
    notifApprove(r.request_id);
  });
  q('.rq-reject')?.addEventListener('click', () => rqPost(`/request/reject/${r.request_id}`, { reason: remarks() }, 'Request rejected'));
  q('.rq-partial')?.addEventListener('click', () => {
    const picked = [...overlay.querySelectorAll('.rq-chk:checked')].map(c => Number(c.dataset.i));
    if (!picked.length) return showResponseModal('Select products', 'Tick at least one product to approve.', false);
    if (picked.length === items.length) return showResponseModal('Select fewer products', 'All products are ticked, use Approve instead.', false);
    if (!remarks()) return showResponseModal('Remarks required', 'Write why the other products are not approved.', false);
    rqPost(`/request/partial_approve/${r.request_id}`, { approved_indexes: picked, remarks: remarks() }, 'Partially approved');
  });
  q('.rq-accept')?.addEventListener('click', () => rqPost(`/request/partial_respond/${r.request_id}`, { accept: true, reason: remarks() }, 'Accepted'));
  q('.rq-decline')?.addEventListener('click', () => rqPost(`/request/partial_respond/${r.request_id}`, { accept: false, reason: remarks() }, 'Request closed'));
}

function initNotificationBell() {
  const ui = ensureBellUI();
  if (!ui) return;
  loadNotifications();
  if (_notifPoll) clearInterval(_notifPoll);
  _notifPoll = setInterval(loadNotifications, 30000);
}

let _msgPoll = null;
const _msgState = { users: [], selected: new Set(), tab: 'inbox', inbox: [], search: '', replyTo: null, replyDraft: '', convs: [], activeChat: null, picking: false, thread: [] };

function msgEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msgRoleLabel(role) {
  if (role === 'distributor') return 'Sales';
  const r = String(role || '').replace(/_/g, ' ');
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function ensureMessageUI() {
  let btn = document.getElementById('msgBtn');
  if (!btn) {
    const icon = document.querySelector('.right-header i.fa-envelope, header i.fa-envelope');
    if (icon) btn = icon.closest('button');
  }
  if (!btn) return null;
  btn.id = 'msgBtn';
  btn.style.position = 'relative';

  let badge = document.getElementById('msgBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'msgBadge';
    badge.style.cssText = 'display:none;position:absolute;top:2px;right:2px;background:#d62828;color:#fff;font-size:10px;border-radius:999px;padding:1px 5px;';
    badge.textContent = '0';
    btn.appendChild(badge);
  }

  let modal = document.getElementById('msgModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'msgModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1900;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:24px;width:min(560px,94vw);max-height:90vh;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,.2);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="color:#0f172a;">Messages</h3>
          <button type="button" id="msgClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <button type="button" class="msgTab" data-tab="compose" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;">Broadcast</button>
          <button type="button" class="msgTab" data-tab="inbox" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;">Chats <span id="msgTabCount"></span></button>
          ${getRole() === 'admin' ? '<button type="button" class="msgTab" data-tab="team" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;">Team</button>' : ''}
        </div>
        <div id="msgBody"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#msgClose').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelectorAll('.msgTab').forEach(t => t.addEventListener('click', () => {
      _msgState.tab = t.dataset.tab;
      _msgState.activeChat = null;
      _msgState.picking = false;
      renderMessageModal();
    }));
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _msgState.tab = 'inbox';
      _msgState.activeChat = null;
      _msgState.picking = false;
      modal.style.display = 'flex';
      renderMessageModal();
    });
  }
  return { btn, badge, modal };
}

function paintMsgTabs() {
  document.querySelectorAll('#msgModal .msgTab').forEach(t => {
    const active = t.dataset.tab === _msgState.tab;
    t.style.background = active ? '#1665ff' : '#f1f5f9';
    t.style.color = active ? '#fff' : '#475569';
  });
}

function renderMessageModal() {
  paintMsgTabs();
  if (_msgState.tab === 'inbox') renderMessageInbox();
  else if (_msgState.tab === 'team' && getRole() === 'admin') renderMessageTeam();
  else renderMessageCompose();
}

async function renderMessageCompose() {
  const body = document.getElementById('msgBody');
  body.innerHTML = `
    <input id="msgSearch" placeholder="Search by name, username or role (e.g. Sales)" value="${msgEsc(_msgState.search)}" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;">
      <span id="msgSelCount" style="color:#64748b;"></span>
      <span>
        <a href="#" id="msgSelAll" style="color:#1665ff;margin-right:12px;">Select all shown</a>
        <a href="#" id="msgSelNone" style="color:#64748b;">Clear</a>
      </span>
    </div>
    <div id="msgUserList" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;border:1px solid #eef1f6;border-radius:10px;padding:8px;"></div>
    <textarea id="msgText" rows="4" maxlength="2000" placeholder="Write your message..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-top:12px;resize:vertical;"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;">
      <button type="button" id="msgSend" style="padding:10px 18px;border:none;border-radius:8px;background:#1665ff;color:#fff;font-weight:600;cursor:pointer;"><i class="fa-solid fa-paper-plane"></i> Send</button>
    </div>`;

  const list = document.getElementById('msgUserList');
  if (!_msgState.users.length) {
    list.innerHTML = '<small style="color:#94a3b8;">Loading...</small>';
    try {
      const res = await apiFetch('/message/recipients');
      const data = await res.json();
      _msgState.users = data.dataset || [];
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') list.innerHTML = '<small style="color:#d62828;">Could not load users.</small>';
      return;
    }
  }

  const visible = () => {
    const term = _msgState.search.trim().toLowerCase();
    return _msgState.users.filter(u => `${u.name || ''} ${u.username || ''} ${u.role || ''} ${msgRoleLabel(u.role)}`.toLowerCase().includes(term));
  };
  const updateCount = () => {
    const n = _msgState.selected.size;
    document.getElementById('msgSelCount').textContent = n ? `${n} selected` : 'Select one or more people';
  };
  const draw = () => {
    const users = visible();
    if (!users.length) { list.innerHTML = '<small style="color:#94a3b8;">No users found.</small>'; updateCount(); return; }
    list.innerHTML = users.map(u => `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;">
        <input type="checkbox" class="msgUserChk" value="${msgEsc(u.username)}" ${_msgState.selected.has(u.username) ? 'checked' : ''}>
        <span style="flex:1;"><strong>${msgEsc(u.name || u.username)}</strong><br><small style="color:#64748b;">${msgEsc(u.username)}</small></span>
        <span style="font-size:11px;font-weight:600;color:#1665ff;background:#eef3fb;border-radius:999px;padding:2px 10px;">${msgEsc(msgRoleLabel(u.role))}</span>
      </label>`).join('');
    list.querySelectorAll('.msgUserChk').forEach(c => c.addEventListener('change', () => {
      if (c.checked) _msgState.selected.add(c.value); else _msgState.selected.delete(c.value);
      updateCount();
    }));
    updateCount();
  };

  document.getElementById('msgSearch').addEventListener('input', e => { _msgState.search = e.target.value; draw(); });
  document.getElementById('msgSelAll').addEventListener('click', e => { e.preventDefault(); visible().forEach(u => _msgState.selected.add(u.username)); draw(); });
  document.getElementById('msgSelNone').addEventListener('click', e => { e.preventDefault(); _msgState.selected.clear(); draw(); });
  document.getElementById('msgSend').addEventListener('click', sendMessage);
  draw();
}

async function sendMessage() {
  const text = document.getElementById('msgText').value.trim();
  const recipients = [..._msgState.selected];
  if (!recipients.length) { showResponseModal('Select recipients', 'Choose at least one person to message.', false); return; }
  if (!text) { showResponseModal('Empty message', 'Write a message before sending.', false); return; }
  const sendBtn = document.getElementById('msgSend');
  sendBtn.disabled = true;
  try {
    const res = await apiFetch('/message/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients, body: text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'message could not be sent');
    _msgState.selected.clear();
    _msgState.search = '';
    document.getElementById('msgModal').style.display = 'none';
    showResponseModal('Message sent', `Sent to ${data.sent} person${data.sent > 1 ? 's' : ''}.`, true);
  } catch (err) {
    sendBtn.disabled = false;
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Send failed', err.message, false);
  }
}

let _msgThreadPoll = null;

function msgInitials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function msgTicks(m) {
  if (m.read) return '<span style="color:#53bdeb;">✓✓</span>';
  if (m.delivered) return '<span style="color:#94a3b8;">✓✓</span>';
  return '<span style="color:#94a3b8;">✓</span>';
}

function msgListTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function msgDayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadMessageInbox() {
  const ui = ensureMessageUI();
  if (!ui) return;
  try {
    const res = await apiFetch('/message/conversations');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    _msgState.convs = data.dataset || [];
    const unread = _msgState.convs.reduce((n, c) => n + (c.unread || 0), 0);
    ui.badge.textContent = unread;
    ui.badge.style.display = unread ? 'block' : 'none';
    const tabCount = document.getElementById('msgTabCount');
    if (tabCount) tabCount.textContent = unread ? `(${unread})` : '';
    if (ui.modal.style.display === 'flex' && _msgState.tab === 'inbox' && !_msgState.activeChat && !_msgState.picking) drawChatList();
  } catch (err) {
    console.error(err);
  }
}

function drawMessageInbox() {
  if (_msgState.activeChat) return;
  if (_msgState.picking) drawChatPicker();
  else drawChatList();
}

function drawChatList() {
  const body = document.getElementById('msgBody');
  if (!body) return;
  const rows = _msgState.convs.map(c => {
    const last = c.last || {};
    return `
      <div class="msgConv" data-u="${msgEsc(c.username)}" style="display:flex;gap:12px;align-items:center;padding:10px 6px;border-bottom:1px solid #f1f5f9;cursor:pointer;">
        <div style="width:42px;height:42px;border-radius:50%;background:#1665ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0;">${msgEsc(msgInitials(c.name))}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <strong style="color:#0f172a;font-size:14px;">${msgEsc(c.name)}</strong>
            <span style="font-size:11px;color:${c.unread ? '#16a34a' : '#94a3b8'};">${msgListTime(last.created_at)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
            <span style="font-size:13px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${last.mine ? msgTicks(last) + ' ' : ''}${msgEsc(last.body)}</span>
            ${c.unread ? `<span style="background:#16a34a;color:#fff;font-size:11px;border-radius:999px;padding:1px 7px;font-weight:600;">${c.unread}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('') || '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">No chats yet.</p>';
  body.innerHTML = `
    <div style="text-align:right;margin-bottom:6px;"><button type="button" id="msgNewChat" style="padding:6px 14px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-size:12px;font-weight:600;"><i class="fa-solid fa-pen-to-square"></i> New chat</button></div>
    <div style="max-height:400px;overflow-y:auto;">${rows}</div>`;
  document.getElementById('msgNewChat').addEventListener('click', () => { _msgState.picking = true; drawChatPicker(); });
  body.querySelectorAll('.msgConv').forEach(el => el.addEventListener('click', () => {
    const c = _msgState.convs.find(x => x.username === el.dataset.u);
    if (c) openChat({ username: c.username, name: c.name, role: c.role });
  }));
}

async function drawChatPicker() {
  const body = document.getElementById('msgBody');
  if (!body) return;
  body.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
      <button type="button" id="msgPickBack" style="border:none;background:none;font-size:16px;cursor:pointer;"><i class="fa-solid fa-arrow-left"></i></button>
      <input id="msgPickSearch" placeholder="Search name, username or role" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
    </div>
    <div id="msgPickList" style="max-height:360px;overflow-y:auto;"></div>`;
  document.getElementById('msgPickBack').addEventListener('click', () => { _msgState.picking = false; drawChatList(); });
  const list = document.getElementById('msgPickList');
  if (!_msgState.users.length) {
    list.innerHTML = '<small style="color:#94a3b8;">Loading...</small>';
    try {
      const res = await apiFetch('/message/recipients');
      const data = await res.json();
      _msgState.users = data.dataset || [];
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') list.innerHTML = '<small style="color:#d62828;">Could not load users.</small>';
      return;
    }
  }
  const draw = () => {
    const term = document.getElementById('msgPickSearch').value.trim().toLowerCase();
    const users = _msgState.users.filter(u => `${u.name || ''} ${u.username || ''} ${u.role || ''} ${msgRoleLabel(u.role)}`.toLowerCase().includes(term));
    list.innerHTML = users.map(u => `
      <div class="msgPickItem" data-u="${msgEsc(u.username)}" style="display:flex;gap:12px;align-items:center;padding:8px 6px;border-bottom:1px solid #f1f5f9;cursor:pointer;">
        <div style="width:36px;height:36px;border-radius:50%;background:#1665ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;">${msgEsc(msgInitials(u.name || u.username))}</div>
        <span style="flex:1;"><strong>${msgEsc(u.name || u.username)}</strong><br><small style="color:#64748b;">${msgEsc(u.username)}</small></span>
        <span style="font-size:11px;font-weight:600;color:#1665ff;background:#eef3fb;border-radius:999px;padding:2px 10px;">${msgEsc(msgRoleLabel(u.role))}</span>
      </div>`).join('') || '<small style="color:#94a3b8;">No users found.</small>';
    list.querySelectorAll('.msgPickItem').forEach(el => el.addEventListener('click', () => {
      const u = _msgState.users.find(x => x.username === el.dataset.u);
      if (u) openChat({ username: u.username, name: u.name || u.username, role: u.role });
    }));
  };
  document.getElementById('msgPickSearch').addEventListener('input', draw);
  draw();
}

async function openChat(chat) {
  _msgState.activeChat = chat;
  _msgState.picking = false;
  _msgState.thread = [];
  drawThreadShell();
  await fetchThread(true);
  if (_msgThreadPoll) clearInterval(_msgThreadPoll);
  _msgThreadPoll = setInterval(() => {
    const modal = document.getElementById('msgModal');
    if (!_msgState.activeChat || !modal || modal.style.display !== 'flex') {
      clearInterval(_msgThreadPoll);
      _msgThreadPoll = null;
      return;
    }
    fetchThread(false);
  }, 4000);
}

function closeChat() {
  _msgState.activeChat = null;
  _msgState.thread = [];
  if (_msgThreadPoll) { clearInterval(_msgThreadPoll); _msgThreadPoll = null; }
  loadMessageInbox();
  drawChatList();
}

function drawThreadShell() {
  const body = document.getElementById('msgBody');
  const chat = _msgState.activeChat;
  if (!body || !chat) return;
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid #e2e8f0;margin-bottom:8px;">
      <button type="button" id="msgChatBack" style="border:none;background:none;font-size:16px;cursor:pointer;"><i class="fa-solid fa-arrow-left"></i></button>
      <div style="width:36px;height:36px;border-radius:50%;background:#1665ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;">${msgEsc(msgInitials(chat.name))}</div>
      <div><strong style="color:#0f172a;">${msgEsc(chat.name)}</strong><br><small style="color:#64748b;">${msgEsc(msgRoleLabel(chat.role))}</small></div>
    </div>
    <div id="msgThreadList" style="height:340px;overflow-y:auto;background:#efeae2;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:4px;"></div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:flex-end;">
      <textarea id="msgChatText" rows="1" maxlength="2000" placeholder="Type a message" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:20px;resize:none;max-height:100px;"></textarea>
      <button type="button" id="msgChatSend" style="width:42px;height:42px;border:none;border-radius:50%;background:#16a34a;color:#fff;cursor:pointer;"><i class="fa-solid fa-paper-plane"></i></button>
    </div>`;
  document.getElementById('msgChatBack').addEventListener('click', closeChat);
  document.getElementById('msgChatSend').addEventListener('click', sendChatMessage);
  const box = document.getElementById('msgChatText');
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 100) + 'px';
  });
  box.focus();
}

function drawThreadMessages(forceScroll) {
  const list = document.getElementById('msgThreadList');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  let lastDay = '';
  list.innerHTML = _msgState.thread.map(m => {
    const d = new Date(m.created_at);
    const day = d.toDateString();
    const sep = day !== lastDay ? `<div style="align-self:center;background:#fff;color:#64748b;font-size:11px;border-radius:8px;padding:2px 10px;margin:6px 0;">${msgDayLabel(m.created_at)}</div>` : '';
    lastDay = day;
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${sep}
      <div style="max-width:78%;align-self:${m.mine ? 'flex-end' : 'flex-start'};background:${m.mine ? '#d9fdd3' : '#fff'};border-radius:10px;padding:6px 10px;box-shadow:0 1px 1px rgba(0,0,0,.08);">
        <div style="font-size:14px;color:#0f172a;white-space:pre-wrap;word-break:break-word;">${msgEsc(m.body)}</div>
        <div style="text-align:right;font-size:10px;color:#94a3b8;margin-top:2px;">${time} ${m.mine ? msgTicks(m) : ''}</div>
      </div>`;
  }).join('') || '<p style="margin:auto;color:#94a3b8;font-size:13px;">Say hi 👋</p>';
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
}

async function fetchThread(force) {
  const chat = _msgState.activeChat;
  if (!chat) return;
  try {
    const res = await apiFetch(`/message/thread/${encodeURIComponent(chat.username)}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    if (_msgState.activeChat !== chat) return;
    const next = data.dataset || [];
    const sig = a => a.map(m => m.message_id + (m.read ? 'r' : m.delivered ? 'd' : 's')).join();
    if (force || sig(next) !== sig(_msgState.thread)) {
      _msgState.thread = next;
      drawThreadMessages(force);
    }
    if (force) loadMessageInbox();
  } catch (err) {
    console.error(err);
  }
}

async function sendChatMessage() {
  const chat = _msgState.activeChat;
  const box = document.getElementById('msgChatText');
  if (!chat || !box) return;
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  box.style.height = 'auto';
  try {
    const res = await apiFetch('/message/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [chat.username], body: text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'message could not be sent');
    await fetchThread(true);
  } catch (err) {
    box.value = text;
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Send failed', err.message, false);
  }
}

async function renderMessageInbox() {
  const body = document.getElementById('msgBody');
  if (_msgState.activeChat) { drawThreadShell(); drawThreadMessages(true); return; }
  body.innerHTML = '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">Loading...</p>';
  await loadMessageInbox();
  drawMessageInbox();
}

async function renderMessageTeam() {
  const body = document.getElementById('msgBody');
  body.innerHTML = '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">Loading...</p>';
  let all = [];
  try {
    const res = await apiFetch('/message/all');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    all = data.dataset || [];
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') body.innerHTML = '<p style="padding:16px;color:#d62828;font-size:13px;text-align:center;">Could not load team chats.</p>';
    return;
  }

  const groups = {};
  all.forEach(m => {
    const key = m.batch_id || m.message_id;
    if (!groups[key]) groups[key] = { from_name: m.from_name || m.from_username, from_username: m.from_username, from_role: m.from_role, body: m.body, created_at: m.created_at, to: [] };
    groups[key].to.push({ name: m.to_name || m.to_username, username: m.to_username, read: m.read });
  });
  const chats = Object.values(groups).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  body.innerHTML = `
    <input id="msgTeamSearch" placeholder="Search by person or message" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <p id="msgTeamCount" style="font-size:12px;color:#64748b;margin-bottom:8px;"></p>
    <div id="msgTeamList" style="max-height:380px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>`;

  const list = document.getElementById('msgTeamList');
  const draw = () => {
    const term = document.getElementById('msgTeamSearch').value.trim().toLowerCase();
    const shown = chats.filter(c => !term || `${c.from_name} ${c.from_username} ${c.body} ${c.to.map(t => t.name + ' ' + t.username).join(' ')}`.toLowerCase().includes(term));
    document.getElementById('msgTeamCount').textContent = `${shown.length} message${shown.length === 1 ? '' : 's'}`;
    list.innerHTML = shown.map(c => `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;margin-bottom:4px;">
          <strong style="color:#0f172a;">${msgEsc(c.from_name)} <span style="font-weight:400;">(${msgEsc(msgRoleLabel(c.from_role))})</span></strong>
          <span>${c.created_at ? new Date(c.created_at).toLocaleString('en-GB') : ''}</span>
        </div>
        <div style="font-size:12px;color:#64748b;margin-bottom:6px;">To: ${c.to.map(t => `<span style="display:inline-block;background:${t.read ? '#f1f5f9' : '#fff4e0'};border-radius:999px;padding:1px 8px;margin:0 4px 2px 0;" title="${t.read ? 'Read' : 'Unread'}">${msgEsc(t.name)}</span>`).join('')}</div>
        <div style="font-size:14px;color:#334155;white-space:pre-wrap;">${msgEsc(c.body)}</div>
      </div>`).join('') || '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">No messages yet.</p>';
  };
  document.getElementById('msgTeamSearch').addEventListener('input', draw);
  draw();
}

function initMessaging() {
  const ui = ensureMessageUI();
  if (!ui) return;
  loadMessageInbox();
  if (_msgPoll) clearInterval(_msgPoll);
  _msgPoll = setInterval(loadMessageInbox, 30000);
}

// =========================================================
// Resizable wizard / popup boxes — every modal on every page gets a
// "smaller / larger" control (bar sticks to the top of the box, next to the
// close button). Three sizes: normal (the page's own size) -> large -> full
// screen. The chosen size is remembered per box. Works for boxes that are
// rebuilt step by step (wizards) because the control is re-added whenever a
// box's content is replaced.
// =========================================================
(function () {
  const SKIP = /delete|logout|appresponse|overflow|confirm/i;   // tiny yes/no dialogs don't need it
  const MAX_LEVEL = 2;
  const LS = 'acer_modal_size_';

  const st = document.createElement('style');
  st.textContent = `
    .ab-size-1 { box-sizing: border-box !important; width: min(1200px, 96vw) !important; max-width: 96vw !important; max-height: 94vh !important; }
    .ab-size-2 { box-sizing: border-box !important; width: 100vw !important; max-width: 100vw !important; height: 100vh !important; max-height: 100vh !important;
                 border-radius: 0 !important; font-size: 15px; }
    .ab-size-1 [style*="max-height"] { max-height: 62vh !important; }
    .ab-size-2 [style*="max-height"] { max-height: calc(100vh - 240px) !important; }
    .ab-size-2 #msgThreadList, .ab-size-1 #msgThreadList { height: calc(100vh - 340px) !important; max-height: none !important; }
    .ab-size-2 table, .ab-size-1 table { font-size: 14px; }
    .ab-bar { position: sticky; top: 0; z-index: 30; height: 0; overflow: visible; }
    .ab-bar-inner { position: absolute; right: 30px; top: -2px; display: flex; gap: 4px; }
    .ab-bar button { width: 26px; height: 26px; border: 1px solid #e2e8f0; border-radius: 7px; background: #fff;
                     color: #475569; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; }
    .ab-bar button:hover:not(:disabled) { background: #eef3fb; color: #1665ff; border-color: #bfd4ff; }
    .ab-bar button:disabled { opacity: .35; cursor: default; }`;
  document.head.appendChild(st);

  const levelOf = box => box.classList.contains('ab-size-2') ? 2 : box.classList.contains('ab-size-1') ? 1 : 0;

  function setLevel(box, lvl, remember) {
    lvl = Math.max(0, Math.min(MAX_LEVEL, lvl));
    box.classList.remove('ab-size-1', 'ab-size-2');
    if (lvl) box.classList.add('ab-size-' + lvl);
    const bar = box.querySelector(':scope > .ab-bar');
    if (bar) {
      bar.querySelector('.ab-smaller').disabled = lvl === 0;
      bar.querySelector('.ab-larger').disabled = lvl === MAX_LEVEL;
    }
    if (remember && box.dataset.abKey) {
      try { localStorage.setItem(LS + box.dataset.abKey, String(lvl)); } catch (e) { /* ignore */ }
    }
  }

  function addBar(box) {
    if (box.querySelector(':scope > .ab-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'ab-bar';
    bar.innerHTML = `<div class="ab-bar-inner">
      <button type="button" class="ab-smaller" title="Smaller"><i class="fa-solid fa-compress"></i></button>
      <button type="button" class="ab-larger" title="Larger / full screen"><i class="fa-solid fa-expand"></i></button></div>`;
    bar.querySelector('.ab-smaller').addEventListener('click', e => { e.stopPropagation(); setLevel(box, levelOf(box) - 1, true); });
    bar.querySelector('.ab-larger').addEventListener('click', e => { e.stopPropagation(); setLevel(box, levelOf(box) + 1, true); });
    box.insertBefore(bar, box.firstChild);
    setLevel(box, levelOf(box), false);   // sync disabled state
  }

  function enhance(box, key) {
    if (!box || box.dataset.abReady === '1') return;
    box.dataset.abReady = '1';
    box.dataset.abKey = key;
    let saved = 0;
    try { saved = Number(localStorage.getItem(LS + key)) || 0; } catch (e) { /* ignore */ }
    if (saved) box.classList.add('ab-size-' + Math.min(MAX_LEVEL, saved));
    addBar(box);
    // wizards rebuild box.innerHTML on every step — put the control back
    new MutationObserver(() => addBar(box)).observe(box, { childList: true });
  }

  // an overlay is a fixed full-screen element holding one box
  function scan(root) {
    const overlays = (root.matches && root.matches('.modal, #msgModal')) ? [root] : [];
    if (root.querySelectorAll) root.querySelectorAll('.modal, #msgModal').forEach(m => overlays.push(m));
    overlays.forEach(m => {
      const key = m.id || m.className;
      if (SKIP.test(key)) return;
      const box = m.querySelector(':scope > .modal-content') || (m.id === 'msgModal' ? m.firstElementChild : null);
      if (box) enhance(box, key);
    });
  }

  function init() {
    scan(document.body);
    new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1 && n.matches && n.matches('.modal, #msgModal')) scan(n); })))
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

const _workState = { modalId: null, incoming: false, kind: 'new', poll: null, sig: '', checking: false };

function workFmt(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d) ? '-' : `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function workPriorityPill(p) {
  const map = {
    urgent: ['var(--danger-bg)', 'var(--danger-dark)'],
    high: ['var(--warning-bg)', 'var(--warning-dark)'],
    normal: ['var(--info-bg)', 'var(--primary-dark)'],
    low: ['var(--bg-hover)', 'var(--text-muted)']
  };
  const [bg, fg] = map[p] || map.normal;
  return `<span style="background:${bg};color:${fg};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:capitalize;">${msgEsc(p || 'normal')}</span>`;
}

function workStatusPill(s) {
  const map = {
    open: ['var(--warning-bg)', 'var(--warning-dark)', 'Open'],
    in_progress: ['var(--info-bg)', 'var(--primary-dark)', 'In Progress'],
    done: ['var(--success-bg)', 'var(--success-dark)', 'Done']
  };
  const [bg, fg, label] = map[s] || map.open;
  return `<span style="background:${bg};color:${fg};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;">${label}</span>`;
}

function ensureWorkModal() {
  let m = document.getElementById('workModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'workModal';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);justify-content:center;align-items:center;z-index:1950;';
  m.innerHTML = '<div id="workModalBox" style="background:var(--bg-white,#fff);border-radius:16px;padding:22px;width:min(560px,94vw);max-height:92vh;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,.25);"></div>';
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => { if (e.target === m) closeWorkModal(); });
  return m;
}

function closeWorkModal() {
  const m = document.getElementById('workModal');
  if (m) m.style.display = 'none';
  if (_workState.poll) { clearInterval(_workState.poll); _workState.poll = null; }
  _workState.modalId = null;
  _workState.sig = '';
  if (typeof window.onWorkChanged === 'function') window.onWorkChanged();
  refreshWorkBadge();
}

async function openWorkModal(workId, incoming, kind) {
  const m = ensureWorkModal();
  _workState.modalId = workId;
  _workState.incoming = !!incoming;
  _workState.kind = kind || 'new';
  _workState.sig = '';
  m.style.display = 'flex';
  await refreshWorkModal(true);
  if (_workState.poll) clearInterval(_workState.poll);
  _workState.poll = setInterval(() => refreshWorkModal(false), 5000);
}

async function refreshWorkModal(first) {
  const id = _workState.modalId;
  if (!id) return;
  try {
    const res = await apiFetch(`/work/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'work could not be loaded');
    if (id !== _workState.modalId) return;
    const w = data.work;
    const sig = `${(w.replies || []).length}|${w.status}`;
    if (!first && sig === _workState.sig) return;
    _workState.sig = sig;
    drawWorkModal(w);
  } catch (err) {
    if (first && err.message !== 'unauthorized' && err.message !== 'forbidden') {
      closeWorkModal();
      showResponseModal('Work', err.message, false);
    }
  }
}

function drawWorkModal(w) {
  const box = document.getElementById('workModalBox');
  if (!box) return;
  const draftEl = document.getElementById('workReplyText');
  const draft = draftEl ? draftEl.value : '';
  const me = getUsername();
  const admin = isWorkManager();
  const replies = w.replies || [];
  const bubbles = replies.map(r => {
    if (r.type === 'system') {
      return `<div style="align-self:center;background:var(--bg-white,#fff);color:var(--text-muted);font-size:11px;border-radius:8px;padding:3px 10px;">${msgEsc(r.body)} · ${workFmt(r.created_at)}</div>`;
    }
    const mine = r.by === me;
    return `<div style="max-width:80%;align-self:${mine ? 'flex-end' : 'flex-start'};background:${mine ? '#d9fdd3' : 'var(--bg-white,#fff)'};border-radius:10px;padding:6px 10px;box-shadow:0 1px 1px rgba(0,0,0,.08);">
      ${mine ? '' : `<div style="font-size:11px;font-weight:600;color:var(--primary);">${msgEsc(r.by_name || r.by)}</div>`}
      <div style="font-size:13.5px;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;">${msgEsc(r.body)}</div>
      <div style="text-align:right;font-size:10px;color:var(--text-light);margin-top:2px;">${workFmt(r.created_at)}</div>
    </div>`;
  }).join('') || '<p style="margin:auto;color:var(--text-light);font-size:13px;">No replies yet.</p>';

  const statusBtns = [];
  if (w.status === 'done') statusBtns.push(['open', 'Reopen', 'var(--bg-hover)', 'var(--text-secondary)']);
  else {
    if (!admin && w.status === 'open') statusBtns.push(['in_progress', 'Start Work', 'var(--info-bg)', 'var(--primary-dark)']);
    statusBtns.push(['done', 'Mark as Done', 'var(--success-bg)', 'var(--success-dark)']);
  }

  const reportLink = location.pathname.includes('/pages/') ? 'work_report.html' : 'pages/work_report.html';
  box.innerHTML = `
    ${_workState.incoming && !admin ? (_workState.kind === 'reminder'
      ? `<div style="display:flex;align-items:center;gap:8px;background:var(--danger-bg);color:var(--danger-dark);border-radius:10px;padding:8px 12px;margin-bottom:12px;font-weight:600;font-size:13px;"><i class="fa-solid fa-triangle-exclamation"></i> Reminder: this work from ${msgEsc(w.assigned_by_name || w.assigned_by)} is still not done. It will keep showing every 24 hours until you mark it as Done.</div>`
      : `<div style="display:flex;align-items:center;gap:8px;background:var(--warning-bg);color:var(--warning-dark);border-radius:10px;padding:8px 12px;margin-bottom:12px;font-weight:600;font-size:13px;"><i class="fa-solid fa-bell"></i> New work from ${msgEsc(w.assigned_by_name || w.assigned_by)}</div>`) : ''}
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;">
      <div>
        <h3 style="color:var(--text-primary);margin:0 0 6px;">${msgEsc(w.title)}</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">${workPriorityPill(w.priority)} ${workStatusPill(w.status)}</div>
      </div>
      <button type="button" id="workModalClose" style="border:none;background:none;font-size:22px;cursor:pointer;color:var(--text-muted);">&times;</button>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.7;">
      ${admin ? `Assigned to <strong>${msgEsc(w.assigned_to_name || w.assigned_to)}</strong> (${msgEsc(msgRoleLabel(w.assigned_to_role))})<br>` : `Assigned by <strong>${msgEsc(w.assigned_by_name || w.assigned_by)}</strong><br>`}
      Created ${workFmt(w.created_at)}${w.due_date ? ` · Due <strong>${msgEsc(new Date(w.due_date).toLocaleDateString('en-GB'))}</strong>` : ''}
    </div>
    ${w.description ? `<div style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13.5px;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;margin-bottom:10px;">${msgEsc(w.description)}</div>` : ''}
    <div id="workThread" style="height:230px;overflow-y:auto;background:#efeae2;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:5px;">${bubbles}</div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:flex-end;">
      <textarea id="workReplyText" rows="1" maxlength="2000" placeholder="Write a reply..." style="flex:1;padding:10px;border:1px solid var(--border);border-radius:20px;resize:none;max-height:100px;font-family:inherit;"></textarea>
      <button type="button" id="workReplySend" style="width:42px;height:42px;border:none;border-radius:50%;background:var(--success-dark);color:#fff;cursor:pointer;"><i class="fa-solid fa-paper-plane"></i></button>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center;">
      ${statusBtns.map(([s, label, bg, fg]) => `<button type="button" class="workStatusBtn" data-s="${s}" style="padding:8px 14px;border:none;border-radius:8px;background:${bg};color:${fg};font-weight:600;font-size:12.5px;cursor:pointer;">${label}</button>`).join('')}
      ${_workState.incoming && !admin ? `<a href="${reportLink}" style="margin-left:auto;font-size:12.5px;color:var(--primary);font-weight:600;text-decoration:none;">Open Work Report →</a>` : ''}
    </div>`;

  const thread = box.querySelector('#workThread');
  thread.scrollTop = thread.scrollHeight;
  const ta = box.querySelector('#workReplyText');
  ta.value = draft;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendWorkReply(w.work_id); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
  });
  if (draft) ta.focus();
  box.querySelector('#workModalClose').addEventListener('click', closeWorkModal);
  box.querySelector('#workReplySend').addEventListener('click', () => sendWorkReply(w.work_id));
  box.querySelectorAll('.workStatusBtn').forEach(b => b.addEventListener('click', () => setWorkStatus(w.work_id, b.dataset.s)));
}

async function sendWorkReply(workId) {
  const ta = document.getElementById('workReplyText');
  if (!ta) return;
  const body = ta.value.trim();
  if (!body) return;
  ta.value = '';
  try {
    const res = await apiFetch(`/work/${workId}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'reply could not be sent');
    _workState.sig = '';
    await refreshWorkModal(true);
    if (typeof window.onWorkChanged === 'function') window.onWorkChanged();
  } catch (err) {
    ta.value = body;
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Reply failed', err.message, false);
  }
}

async function setWorkStatus(workId, status) {
  try {
    const res = await apiFetch(`/work/${workId}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'status could not be updated');
    _workState.sig = '';
    await refreshWorkModal(true);
    if (typeof window.onWorkChanged === 'function') window.onWorkChanged();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Update failed', err.message, false);
  }
}

async function pollWorkPopup() {
  if (isWorkManager() || _workState.modalId || _workState.checking) return;
  _workState.checking = true;
  try {
    const res = await apiFetch('/work/popup');
    if (!res.ok) return;
    const data = await res.json();
    const next = (data.dataset || [])[0];
    if (!next) return;
    await openWorkModal(next.work_id, true, next.popup_kind);
    await apiFetch(`/work/${next.work_id}/seen`, { method: 'POST' });
  } catch (err) {
    console.error(err);
  } finally {
    _workState.checking = false;
  }
}

async function refreshWorkBadge() {
  const badge = document.getElementById('workNavBadge');
  if (!badge) return;
  try {
    const admin = isWorkManager();
    const res = await apiFetch(admin ? '/work/all' : '/work/mine');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.dataset || [];
    const n = admin ? list.filter(w => w.admin_unread).length : list.filter(w => w.status !== 'done').length;
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
  } catch (err) {
    console.error(err);
  }
}

function injectWorkSidebarLink() {
  const ul = document.querySelector('.sidebar ul');
  if (!ul || ul.querySelector('a[data-work-link]')) return;
  const admin = isWorkManager();
  const file = admin ? 'work.html' : 'work_report.html';
  const href = location.pathname.includes('/pages/') ? file : `pages/${file}`;
  const li = document.createElement('li');
  if (location.pathname.split('/').pop() === file) li.className = 'active';
  li.innerHTML = `<a href="${href}" data-work-link="1"><i class="fa-solid fa-clipboard-list"></i><span>${admin ? 'Work' : 'Work Report'}</span><b id="workNavBadge" style="display:none;margin-left:auto;background:#d62828;color:#fff;font-size:10px;border-radius:999px;padding:1px 6px;"></b></a>`;
  const logout = [...ul.querySelectorAll('li')].find(x => /logout/i.test(x.textContent));
  ul.insertBefore(li, logout || null);
}

function initWorkPopup() {
  // no Work Report link / popups for users who can't open that page (e.g. QC, or pages limited from /access-control)
  if (!allowedPages(getRole()).includes('work_report.html') && !isWorkManager()) return;
  injectWorkSidebarLink();
  refreshWorkBadge();
  setInterval(refreshWorkBadge, 15000);
  if (isWorkManager()) return;
  pollWorkPopup();
  setInterval(pollWorkPopup, 5000);
}
(function installPwa() {
  const head = document.head;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); head.appendChild(el); };
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
  add('link', { rel: 'manifest', href: '/manifest.json' });
  add('link', { rel: 'stylesheet', href: '/css/mobile-fold.css?v=8' });
  add('link', { rel: 'apple-touch-icon', href: '/icons/icon-192.png' });
  add('meta', { name: 'theme-color', content: '#1665ff' });
  {
    const mount = () => {
      const sb = document.querySelector('.sidebar');
      if (!sb || document.getElementById('navToggle')) return;
      const btn = document.createElement('button');
      btn.id = 'navToggle';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Menu');
      btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
      const bd = document.createElement('div');
      bd.className = 'sidebar-backdrop';
      const toggle = open => document.body.classList.toggle('nav-open', open);
      btn.addEventListener('click', () => toggle(!document.body.classList.contains('nav-open')));
      bd.addEventListener('click', () => toggle(false));
      sb.addEventListener('click', e => { if (e.target.closest('a') && !e.target.closest('a[onclick]')) toggle(false); });
      document.body.append(btn, bd);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();


(function topTableScroll() {
  const wrappers = [];
  const WRAP = '.table-container, .tbl-wrap, div[style*="overflow-x"]';
  const ratio = () => Math.min(3, Math.max(1, window.innerWidth / (screen.width || window.innerWidth)));
  function setup(w) {
    const bar = document.createElement('div');
    bar.className = 'top-scroll';
    const thumb = document.createElement('div');
    bar.appendChild(thumb);
    w.parentNode.insertBefore(bar, w);

    const layout = () => {
      const r = ratio();
      bar.style.height = Math.round(18 * r) + 'px';
      const sw = w.scrollWidth, cw = w.clientWidth, bw = bar.clientWidth;
      if (sw <= cw + 1 || !bw) {
        thumb.style.width = '100%';
        thumb.style.transform = 'translateX(0)';
        bar.classList.add('idle');
        return;
      }
      bar.classList.remove('idle');
      const tw = Math.max(bw * cw / sw, 40 * r);
      thumb.style.width = tw + 'px';
      thumb.style.transform = `translateX(${(w.scrollLeft / (sw - cw)) * (bw - tw)}px)`;
    };

    const scrollToX = (clientX, grab) => {
      const rect = bar.getBoundingClientRect();
      const sw = w.scrollWidth, cw = w.clientWidth, bw = bar.clientWidth;
      const tw = thumb.getBoundingClientRect().width;
      const x = Math.min(Math.max(clientX - rect.left - grab, 0), bw - tw);
      w.scrollLeft = (x / (bw - tw)) * (sw - cw);
    };

    let dragging = false, grab = 0;
    bar.addEventListener('pointerdown', e => {
      if (bar.classList.contains('idle')) return;
      const tr = thumb.getBoundingClientRect();
      grab = (e.clientX >= tr.left && e.clientX <= tr.right) ? e.clientX - tr.left : tr.width / 2;
      dragging = true;
      bar.setPointerCapture(e.pointerId);
      scrollToX(e.clientX, grab);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', e => { if (dragging) scrollToX(e.clientX, grab); });
    const stop = () => { dragging = false; };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    w.addEventListener('scroll', layout);
    if (window.ResizeObserver) new ResizeObserver(layout).observe(w);
    w._syncTop = layout;
    wrappers.push(w);
    layout();
  }
  function scan() {
    document.querySelectorAll('table').forEach(t => {
      if (t.closest('.top-scroll')) return;
      let w = t.closest(WRAP);
      if (!w) {
        if (!t.parentNode) return;
        w = document.createElement('div');
        w.className = 'tbl-wrap';
        t.parentNode.insertBefore(w, t);
        w.appendChild(t);
      }
      if (!w._syncTop && w.parentNode) setup(w);
    });
    wrappers.forEach(w => { if (w.isConnected) w._syncTop(); });
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };
  const start = () => {
    scan();
    new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', queue);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

window.addEventListener('load', () => {
  if (typeof getRole === 'function' && getRole() === 'distributor') {
    ['sidebarUserRole', 'headerUserRole'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = 'Sales';
    });
  }
});

(function addQcLink() {
  const mount = () => {
    if (typeof getRole !== 'function' || !['admin', 'qc'].includes(getRole()) || getCustomPages()) return;
    const ul = document.querySelector('.sidebar ul');
    if (!ul || ul.querySelector('a[href$="qc.html"]')) return;
    const inPages = location.pathname.includes('/pages/');
    const li = document.createElement('li');
    li.innerHTML = `<a href="${inPages ? 'qc.html' : 'pages/qc.html'}"><i class="fa-solid fa-clipboard-check"></i><span>QC</span></a>`;
    const logout = [...ul.querySelectorAll('li')].find(x => x.querySelector('a[onclick*="openLogoutModal"]'));
    if (logout) ul.insertBefore(li, logout); else ul.appendChild(li);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();