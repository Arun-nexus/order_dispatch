const AUTH = {
  tokenKey: 'acer_token',
  roleKey: 'acer_role',
  usernameKey: 'acer_username',
};

const ROLE_ACCESS = {
  admin:           ['main_dashboard.html', 'orders.html', 'inventory.html', 'service.html', 'allocated.html', 'dispatch.html', 'shipment.html', 'assembly.html', 'users.html', 'reports.html', 'create_account.html', 'attendance.html'],
  accounts:        ['main_dashboard.html', 'orders.html', 'inventory.html', 'service.html', 'allocated.html', 'dispatch.html', 'shipment.html', 'assembly.html', 'reports.html'],
  service_manager: ['service.html', 'inventory.html', 'dispatch.html','allocated.html'],
  assembly:        ['assembly.html', 'inventory.html'],
  technician:      ['technician.html','technician_dashboard.html'],
  distributor:     ['distributor.html', 'distributor_orders.html', 'distributor_team.html','technician.html'],
  inventory_manager: ['inventory.html', 'distributor.html', 'distributor_orders.html', 'assembly.html', 'shipment.html'],
};

const ROLE_HOME = {
  admin: 'main_dashboard.html',
  accounts: 'main_dashboard.html',
  service_manager: 'service.html',
  assembly: 'assembly.html',
  technician: 'technician.html',
  distributor: 'distributor.html',
  inventory_manager: 'inventory.html',
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
  return location.pathname.includes('/pages/') ? '/index.html' : 'index.html';
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
    alert('Your role doesnt have access to do that action');
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
    filterSidebarByRole();
    initNotificationBell();
    initMessaging();
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

function notifItemHtml(r, canAct) {
  const typeLabels = { demo_unit: 'Demo Unit', order: 'Order', spare_part: 'Spare Part', media_review: 'Service Media', status_update: 'Service Status Update', service: 'New Service' };
  const label = typeLabels[r.request_type] || r.request_type;
  const who = r.raised_by ? `by ${r.raised_by}` : '';
  let sub = '';
  if (r.request_type === 'demo_unit' || r.request_type === 'order') {
    sub = (r.details?.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
  } else if (r.request_type === 'spare_part') {
    sub = r.details?.note || '';
  } else if (r.request_type === 'service') {
    sub = `${r.details?.product_id || ''} — ${r.details?.issue || ''}`;
  } else if (r.request_type === 'media_review') {
    sub = `Service #${(r.details?.service_id || '').slice(0, 8)} uploaded media`;
  } else if (r.request_type === 'status_update') {
    const svcId = (r.details?.service_id || '').slice(0, 8);
    const newStatus = (r.details?.service_status || '').replace('_', ' ');
    sub = `Service #${svcId} — change status to "${newStatus}"${r.details?.reason ? ' — ' + r.details.reason : ''}`;
  }
  const statusPill = r.status === 'pending'
    ? '<span class="status pending">Pending</span>'
    : `<span class="status ${r.status === 'approved' ? 'delivered' : 'cancelled'}">${r.status}${r.resolved_by ? ' by ' + r.resolved_by : ''}</span>`;

  const isStatusUpdate = r.request_type === 'status_update';
  const actions = (canAct && r.status === 'pending' && !isStatusUpdate) ? `
    <div style="display:flex;gap:6px;margin-top:6px;">
      <button class="notif-approve" data-id="${r.request_id}" style="flex:1;padding:6px 8px;border:none;border-radius:6px;background:#16a34a;color:#fff;cursor:pointer;font-size:12px;">Approve</button>
      <button class="notif-reject" data-id="${r.request_id}" style="flex:1;padding:6px 8px;border:none;border-radius:6px;background:#d62828;color:#fff;cursor:pointer;font-size:12px;">Reject</button>
    </div>` : (canAct && r.status === 'pending' && isStatusUpdate ? `
    <p style="font-size:11px;color:#94a3b8;margin-top:4px;">Complete this from the Service page's Update Status action.</p>` : '');

  return `
    <div class="notif-item" style="border-bottom:1px solid #eef1f6;padding:10px 4px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          <strong style="font-size:13px;">${label}</strong> ${who}
          <p style="font-size:12px;color:#64748b;margin-top:2px;">${sub}${r.status === 'rejected' && r.reason ? ' — ' + r.reason : ''}</p>
        </div>
        ${statusPill}
      </div>
      ${actions}
    </div>`;
}

async function loadNotifications() {
  const role = getRole();
  const ui = ensureBellUI();
  if (!ui) return;

  try {
    const isManager = role === 'admin' || role === 'employee';
    const res = await apiFetch(isManager ? '/request/' : '/request/mine');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const all = data.dataset || [];
    const pendingCount = all.filter(r => r.status === 'pending').length;

    ui.badge.textContent = pendingCount;
    ui.badge.style.display = pendingCount ? 'block' : 'none';

    const sorted = [...all].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 25);
    ui.panel.innerHTML = sorted.length
      ? `<h4 style="padding:6px 4px 10px;">Notifications</h4>` + sorted.map(r => notifItemHtml(r, isManager)).join('')
      : '<p style="padding:16px;color:#94a3b8;font-size:13px;">No notifications yet.</p>';

    if (isManager) {
      ui.panel.querySelectorAll('.notif-approve').forEach(btn => btn.addEventListener('click', () => notifApprove(btn.dataset.id)));
      ui.panel.querySelectorAll('.notif-reject').forEach(btn => btn.addEventListener('click', () => notifReject(btn.dataset.id)));
    }
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

function initNotificationBell() {
  const ui = ensureBellUI();
  if (!ui) return;
  loadNotifications();
  if (_notifPoll) clearInterval(_notifPoll);
  _notifPoll = setInterval(loadNotifications, 30000);
}

let _msgPoll = null;
const _msgState = { users: [], selected: new Set(), tab: 'compose', inbox: [], search: '' };

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
          <button type="button" class="msgTab" data-tab="compose" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;">New Message</button>
          <button type="button" class="msgTab" data-tab="inbox" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;">Inbox <span id="msgTabCount"></span></button>
        </div>
        <div id="msgBody"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#msgClose').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelectorAll('.msgTab').forEach(t => t.addEventListener('click', () => {
      _msgState.tab = t.dataset.tab;
      renderMessageModal();
    }));
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _msgState.tab = 'compose';
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

async function loadMessageInbox() {
  const ui = ensureMessageUI();
  if (!ui) return;
  try {
    const res = await apiFetch('/message/inbox');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    _msgState.inbox = (data.dataset || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const unread = _msgState.inbox.filter(m => !m.read).length;
    ui.badge.textContent = unread;
    ui.badge.style.display = unread ? 'block' : 'none';
    const tabCount = document.getElementById('msgTabCount');
    if (tabCount) tabCount.textContent = unread ? `(${unread})` : '';
    if (ui.modal.style.display === 'flex' && _msgState.tab === 'inbox') drawMessageInbox();
  } catch (err) {
    console.error(err);
  }
}

function drawMessageInbox() {
  const body = document.getElementById('msgBody');
  if (!body) return;
  if (!_msgState.inbox.length) {
    body.innerHTML = '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">No messages yet.</p>';
    return;
  }
  const hasUnread = _msgState.inbox.some(m => !m.read);
  body.innerHTML = `
    ${hasUnread ? '<div style="text-align:right;margin-bottom:8px;"><a href="#" id="msgReadAll" style="color:#1665ff;font-size:12px;">Mark all as read</a></div>' : ''}
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${_msgState.inbox.map(m => `
        <div class="msgItem" data-id="${msgEsc(m.message_id)}" style="border:1px solid ${m.read ? '#e2e8f0' : '#bfd4ff'};background:${m.read ? '#fff' : '#f0f6ff'};border-radius:10px;padding:10px 12px;cursor:pointer;">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;margin-bottom:4px;">
            <strong style="color:#0f172a;">${msgEsc(m.from_name || m.from_username)} <span style="font-weight:400;color:#64748b;">(${msgEsc(msgRoleLabel(m.from_role))})</span></strong>
            <span>${m.created_at ? new Date(m.created_at).toLocaleString('en-GB') : ''}</span>
          </div>
          <div style="font-size:14px;color:#334155;white-space:pre-wrap;">${msgEsc(m.body)}</div>
        </div>`).join('')}
    </div>`;
  body.querySelectorAll('.msgItem').forEach(el => el.addEventListener('click', async () => {
    const m = _msgState.inbox.find(x => x.message_id === el.dataset.id);
    if (!m || m.read) return;
    try {
      await apiFetch(`/message/read/${m.message_id}`, { method: 'POST' });
      m.read = true;
      loadMessageInbox();
      drawMessageInbox();
    } catch (err) { console.error(err); }
  }));
  const readAll = document.getElementById('msgReadAll');
  if (readAll) readAll.addEventListener('click', async e => {
    e.preventDefault();
    try {
      await apiFetch('/message/read_all', { method: 'POST' });
      _msgState.inbox.forEach(m => { m.read = true; });
      loadMessageInbox();
      drawMessageInbox();
    } catch (err) { console.error(err); }
  });
}

async function renderMessageInbox() {
  const body = document.getElementById('msgBody');
  body.innerHTML = '<p style="padding:16px;color:#94a3b8;font-size:13px;text-align:center;">Loading...</p>';
  await loadMessageInbox();
  drawMessageInbox();
}

function initMessaging() {
  const ui = ensureMessageUI();
  if (!ui) return;
  loadMessageInbox();
  if (_msgPoll) clearInterval(_msgPoll);
  _msgPoll = setInterval(loadMessageInbox, 30000);
}