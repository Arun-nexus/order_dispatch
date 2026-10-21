/* ---- A4 print support: print_a4.js is loaded on demand (safe if it is missing) ---- */
(function () { if (typeof A4Print === 'undefined' && !document.getElementById('a4printjs')) { const s = document.createElement('script'); s.id = 'a4printjs'; s.src = 'print_a4.js'; document.head.appendChild(s); } })();
function a4Ready(cb, n) { n = n || 0; if (typeof A4Print !== 'undefined') return cb(); if (n < 50) setTimeout(() => a4Ready(cb, n + 1), 200); }
function a4Intercept(head, rows, name) { return typeof A4Print !== 'undefined' && A4Print.intercept(head, rows, name); }
function a4WizardPrint(modal, title) { if (typeof A4Print !== 'undefined') A4Print.wizardPrint(modal, title); }
function a4Twin(btn, title) { if (btn) a4Ready(() => A4Print.attachTwin(btn, title)); }
const svcState = { services: [], orders: [], activeServiceId: null, assignees: [], hologramPool: [], search: '', filters: null, installs: [], demo: [], requests: [], inventory: [], view: 'services', status: 'all' };

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  if (['services', 'installs', 'demo', 'requests'].includes(tab)) svcView = tab;
  if (params.get('installation')) svcView = 'installs';
  svcState.status = svcView === 'requests' ? 'pending' : 'all';
  loadServices();
  loadInstallations();
  loadDemo();
  loadRequests();
  wireModals();
  wireHeaderSearch();
  wireToolbar();
  populateTechnicianFilter();
  loadAvailableHologramParts();
  renderAll();
});

window.refreshCurrentPageData = () => { loadServices(); loadInstallations(); loadDemo(); loadRequests(); };

// Powers the part-swap rows in the "Update Status" -> Completed form: only
// service_parts that actually have a hologram number on file can be picked,
// so a technician can never type a part/hologram combo that doesn't exist
// in inventory (which used to silently create mismatched/bad records).
async function loadAvailableHologramParts() {
  try {
    const res = await apiFetch('/service/available_hologram_parts');
    if (res.ok) {
      const data = await res.json();
      svcState.hologramPool = data.dataset || [];
    }
  } catch (err) {
    console.warn('service: could not load available hologram parts', err.message);
  }
}

function wireHeaderSearch() {
  const input = document.querySelector('.search input');
  if (!input) return;
  input.addEventListener('input', () => {
    svcState.search = input.value.trim().toLowerCase();
    svcSearch = svcState.search;
    renderMain();
  });
}

function getFilteredServices() {
  let list = svcState.services;
  const q = svcState.search;
  if (q) {
    list = list.filter(s =>
      (s.serial_no || '').toLowerCase().includes(q) ||
      (s.product_id || '').toLowerCase().includes(q) ||
      serviceProductInfo(s).name.toLowerCase().includes(q) ||
      serviceProductInfo(s).model.toLowerCase().includes(q) ||
      (s.service_id || '').toLowerCase().includes(q) ||
      (s.company_name || '').toLowerCase().includes(q)
    );
  }
  const f = svcState.filters;
  if (f) {
    list = list.filter(s =>
      (!f.status || s.status === f.status) &&
      (!f.technician || s.technician_alloted === f.technician) &&
      (!f.date || s.purchase_date === f.date)
    );
  }
  return list;
}

// every assignable person (all users except admin) as flat options — no role grouping/labels
function assigneeOptionsHtml(placeholder) {
  return `<option value="">${placeholder}</option>` + svcState.assignees
    .map(u => `<option value="${esc(u.username)}">${esc(u.username)}${u.name && u.name !== u.username ? ' — ' + esc(u.name) : ''}</option>`)
    .join('');
}

async function populateTechnicianFilter() {
  const select = document.getElementById('techFilter');
  if (!select) return;
  await loadAssignees();
  const current = select.value;
  select.innerHTML = assigneeOptionsHtml('Technician');
  if (current && [...select.options].some(o => o.value === current)) select.value = current;
}

async function loadServices() {
  try {
    const [svcRes, orderRes] = await Promise.all([
      apiFetch('/service/'),
      apiFetch('/order/')
    ]);
    if (!svcRes.ok) throw new Error('failed to fetch services');
    const svcData = await svcRes.json();
    const orderData = orderRes.ok ? await orderRes.json() : { dataset: [] };

    svcState.services = (svcData.dataset || []).slice().reverse();
    svcState.orders = orderData.dataset || [];
    renderAll();

    const svcId = new URLSearchParams(location.search).get('service');
    if (svcId && !svcState._svcLink) {
      svcState._svcLink = true;
      const t = svcState.services.find(x => x.service_id === svcId);
      if (t) openViewModal(t);
    }
    const reviewId = new URLSearchParams(location.search).get('review');
    if (reviewId) {
      history.replaceState(null, '', location.pathname);   // a refresh should not re-open it
      const target = svcState.services.find(x => x.service_id === reviewId);
      if (target) openReviewModal(target);
    }
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load service data.');
    }
  }
}

// Everyone except admins can be assigned a service. /account/users lists all accounts
// (admin / accounts / service_manager may call it); if that is refused, fall back to the
// technician + distributor lists so the dropdown is never empty.
async function loadAssignees() {
  let list = [];
  try {
    const res = await apiFetch('/account/users');
    if (res.ok) {
      list = ((await res.json()).dataset || []).filter(u => u.username && u.role !== 'admin');
    } else {
      const [t, d] = await Promise.all([apiFetch('/account/technicians'), apiFetch('/account/distributors')]);
      const tech = t.ok ? (await t.json()).dataset || [] : [];
      const dist = d.ok ? (await d.json()).dataset || [] : [];
      list = [...tech, ...dist].filter(u => u.username);
    }
  } catch (err) {
    console.error(err);
  }
  const seen = new Set();
  svcState.assignees = list
    .filter(u => !seen.has(u.username) && seen.add(u.username))
    .sort((x, y) => x.username.localeCompare(y.username));
  return svcState.assignees;
}

// Product ID is a fixed blank value now (see DEFAULT_PRODUCT_ID below), so it
// can't identify an order line any more — only match on it when it has content.
const hasRealProductId = s => !!String(s.product_id ?? '').trim();

function findOrderItemForService(s) {
  const items = svcState.orders.flatMap(o => o.items || []);
  return (s.serial_no && items.find(it => (it.serial_numbers || []).includes(s.serial_no)))
    || (hasRealProductId(s) ? items.find(it => it.product_id === s.product_id) : null)
    || null;
}

function serviceProductInfo(s) {
  const it = findOrderItemForService(s) || {};
  const pid = hasRealProductId(s) ? String(s.product_id).trim() : '';
  return { name: s.product_name || it.product_name || pid || '-', model: s.model_no || it.model_no || '-' };
}

function fmtSchedule(v) {
  if (!v) return '-';
  const d = new Date(v);
  return isNaN(d) ? esc(v) : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function toLocalInput(v) {
  const d = v ? new Date(v) : new Date(Date.now() + 86400000);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openRescheduleModal(s) {
  const old = document.getElementById('svcRescheduleModal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'svcRescheduleModal';
  modal.className = 'modal';
  modal.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1300;';
  modal.innerHTML = `
    <div class="modal-content" style="background:#fff;border-radius:16px;padding:26px;width:420px;max-width:92vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3>Reschedule Service</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <p style="font-size:13px;color:var(--text-light);margin-bottom:10px;">Currently: ${fmtSchedule(s.scheduled_date)}</p>
      <label style="font-size:13px;">New date &amp; time</label>
      <input type="datetime-local" id="svcReschedWhen" value="${toLocalInput(s.scheduled_date)}" style="width:100%;padding:9px;margin:6px 0 12px;border:1px solid var(--border);border-radius:8px;">
      <label style="font-size:13px;">Reason</label>
      <textarea id="svcReschedReason" rows="3" style="width:100%;padding:9px;margin:6px 0 12px;border:1px solid var(--border);border-radius:8px;"></textarea>
      <p id="svcReschedErr" style="color:#dc2626;font-size:13px;min-height:16px;"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="cancel" style="padding:9px 16px;border:1px solid var(--border);background:#fff;border-radius:8px;cursor:pointer;">Cancel</button>
        <button class="save" style="padding:9px 16px;border:none;background:#2563eb;color:#fff;border-radius:8px;cursor:pointer;">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.close').onclick = close;
  modal.querySelector('.cancel').onclick = close;
  modal.querySelector('.save').onclick = async () => {
    const when = modal.querySelector('#svcReschedWhen').value;
    const err = modal.querySelector('#svcReschedErr');
    if (!when) { err.textContent = 'Pick a date and time.'; return; }
    try {
      const res = await apiFetch(`/service/reschedule/${encodeURIComponent(s.service_id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: new Date(when).toISOString(), reason: modal.querySelector('#svcReschedReason').value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { err.textContent = data.detail || 'Could not reschedule.'; return; }
      close();
      await loadServices();
    } catch (e) { err.textContent = 'Could not reschedule.'; }
  };
}





function statusBadge(status) {
  const map = { active: 'pending', in_progress: 'progress', pending_approval: 'progress', completed: 'completed', rejected: 'rejected' };
  return map[status] || 'pending';
}

// finds the order this service's product belongs to by searching each order's
// line items (orders store items[].serial_numbers, not a top-level serial_no)
function findOrderForService(s) {
  if (!s.serial_no) return hasRealProductId(s) ? svcState.orders.find(o => (o.items || []).some(it => it.product_id === s.product_id)) : undefined;
  return svcState.orders.find(o => (o.items || []).some(it => (it.serial_numbers || []).includes(s.serial_no)))
    || (hasRealProductId(s) ? svcState.orders.find(o => (o.items || []).some(it => it.product_id === s.product_id)) : undefined);
}

// warranty = manual override (warranty_until) if admin/employee set one, else order_date + 365 days
function computeWarranty(s) {
  if (s.warranty_until) {
    const until = new Date(s.warranty_until);
    const daysLeft = Math.ceil((until - new Date()) / 86400000);
    return { until, daysLeft, underWarranty: daysLeft >= 0, manual: true };
  }
  const order = findOrderForService(s);
  if (!order || !order.order_date) return null;
  const until = new Date(order.order_date);
  until.setDate(until.getDate() + 365);
  const daysLeft = Math.ceil((until - new Date()) / 86400000);
  return { until, daysLeft, underWarranty: daysLeft >= 0, manual: false };
}

function warrantyCellHtml(s) {
  const w = computeWarranty(s);
  if (!w) return '<span class="pending">No order match</span>';
  const label = w.underWarranty ? `Under Warranty (${w.daysLeft}d left)` : 'Expired';
  const cls = w.underWarranty ? 'delivered' : 'cancelled';
  return `<span class="${cls}">${label}</span>${w.manual ? ' <small>(extended)</small>' : ''}`;
}

function renderServiceTable(services) {
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  services.forEach(s => {
    const tr = document.createElement('tr');
    tr.dataset.serviceId = s.service_id;

    let actionsHtml;
    if (s.status === 'rejected') {
      actionsHtml = `
        <button class="reason-btn">View Reason</button>
        <button class="icon-btn ellipsis-btn"><i class="fa-solid fa-ellipsis"></i></button>`;
    } else {
      actionsHtml = `
        ${s.status === 'pending_approval' ? '<button class="reason-btn review-btn" style="background:#16a34a;color:#fff;">Review</button>' : ''}
        <button class="icon-btn location-btn"><i class="fa-solid fa-location-dot"></i></button>
        <button class="icon-btn image-btn"><i class="fa-solid fa-image"></i></button>
        <button class="icon-btn ellipsis-btn"><i class="fa-solid fa-ellipsis"></i></button>`;
    }

    const returnCell = s.status === 'rejected'
      ? '-'
      : `<span class="${s.manager_confirmed_return ? 'confirmed' : 'pending'}">${s.manager_confirmed_return ? 'Confirmed' : 'Pending'}</span>`;

    tr.innerHTML = `
      <td>${esc(s.company_name || '-')}</td>
      <td>${serviceProductInfo(s).name}</td>
      <td>${serviceProductInfo(s).model}</td>
      <td>${s.serial_no ?? ''}</td>
      <td><div class="tech">${s.technician_alloted ?? ''}</div></td>
      <td>${s.issue ?? ''}</td>
      <td>${(s.location || 'indoor') === 'outdoor' ? 'Field' : 'Inhouse'}${s.address ? '<br><small style="color:#64748b;">' + esc(s.address) + '</small>' : ''}</td>
      <td>${warrantyCellHtml(s)}</td>
      <td><span class="${statusBadge(s.status)}">${(s.status ?? '').replace('_', ' ')}</span></td>
      <td>${returnCell}</td>
      <td>${s.created_by ?? ''}</td>
      <td>${s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '-'}</td>
      <td>${actionsHtml}</td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', e => {
      if (e.target.closest('button, a, input, select')) return;
      const svc = svcState.services.find(x => x.service_id === tr.dataset.serviceId);
      if (svc) openViewModal(svc);
    });
  });
  tbody.querySelectorAll('.location-btn').forEach(btn =>
    btn.addEventListener('click', e => alert('Technician location tracking is not yet implemented on the backend.')));
  tbody.querySelectorAll('.image-btn').forEach(btn => btn.addEventListener('click', e => openImageModal(rowService(e))));
  tbody.querySelectorAll('.ellipsis-btn').forEach(btn => btn.addEventListener('click', e => openActionMenu(rowService(e), e)));
  tbody.querySelectorAll('.reason-btn:not(.review-btn)').forEach(btn => btn.addEventListener('click', e => openReasonModal(rowService(e))));
  tbody.querySelectorAll('.review-btn').forEach(btn => btn.addEventListener('click', e => openReviewModal(rowService(e))));
}

function rowService(e) {
  const tr = e.target.closest('tr');
  return svcState.services.find(s => s.service_id === tr.dataset.serviceId);
}

// ---------- Action menu (replaces old confirm()-chain approach) ----------
function openActionMenu(s, evt) {
  if (!s) return;
  closeActionMenu();

  const role = getRole();
  const canManage = role === 'admin' || role === 'employee';

  const menu = document.createElement('div');
  menu.id = 'svcActionMenu';
  menu.style.cssText = 'position:fixed;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1200;min-width:200px;visibility:hidden;';
  const rect = evt.target.closest('button').getBoundingClientRect();

  const items = [
    { label: 'View Details', action: () => openViewModal(s) },
    { label: 'Update Status', action: () => openStatusModal(s) },
  ];
  if (s.status !== 'completed' && s.status !== 'rejected') items.push({ label: 'Reschedule', action: () => openRescheduleModal(s) });
  if (s.status === 'pending_approval') items.unshift({ label: 'Review & Approve', action: () => openReviewModal(s) });
  if (canManage) {
    items.push({ label: 'Manager Confirm Return', action: () => managerConfirmReturn(s.service_id) });
    items.push({ label: 'Extend Warranty', action: () => extendWarranty(s.service_id) });
  }

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;border-radius:6px;cursor:pointer;font-size:14px;';
    btn.onmouseenter = () => btn.style.background = 'var(--bg-hover)';
    btn.onmouseleave = () => btn.style.background = 'none';
    btn.addEventListener('click', () => { closeActionMenu(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // now that it's in the DOM we know its real size — clamp/flip so it never
  // opens off the edge of the screen, and matches where the button actually is
  const menuRect = menu.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpwards = spaceBelow < menuRect.height + 10 && rect.top > menuRect.height + 10;
  menu.style.top = openUpwards ? `${rect.top - menuRect.height - 6}px` : `${rect.bottom + 6}px`;
  menu.style.left = `${Math.min(Math.max(10, rect.left - 150), window.innerWidth - menuRect.width - 10)}px`;
  menu.style.visibility = 'visible';

  setTimeout(() => document.addEventListener('click', closeActionMenuOnClickAway), 0);
}

function closeActionMenu() {
  const existing = document.getElementById('svcActionMenu');
  if (existing) existing.remove();
  document.removeEventListener('click', closeActionMenuOnClickAway);
}

function closeActionMenuOnClickAway(e) {
  const menu = document.getElementById('svcActionMenu');
  if (menu && !menu.contains(e.target)) closeActionMenu();
}

function openViewModal(s) {
  const modal = document.getElementById('viewModal');
  if (!modal) return;
  const values = modal.querySelectorAll('.detail p');
  const listedOn = s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '-';
  const fields = [s.service_id, serviceProductInfo(s).name, serviceProductInfo(s).model, s.serial_no, s.technician_alloted, s.purchase_date, s.issue, s.spare_parts || 'None', s.service_charges != null ? `₹${s.service_charges}` : 'Not set', s.created_by || '-', listedOn];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
  let extra = modal.querySelector('.svc-schedule-extra');
  if (!extra) {
    extra = document.createElement('div');
    extra.className = 'svc-schedule-extra';
    modal.querySelector('.modal-content').appendChild(extra);
  }
  const hist = (s.schedule_history || []).slice().reverse().map(h =>
    `<li style="margin-bottom:4px;">${fmtSchedule(h.from)} &rarr; <b>${fmtSchedule(h.to)}</b> by ${esc(h.by)}${h.reason ? ' - ' + esc(h.reason) : ''}</li>`).join('');
  extra.innerHTML = `<div class="detail"><small>Company</small><p>${esc(s.company_name || '-')}</p></div>${s.address ? `<div class="detail"><small>Address</small><p>${esc(s.address)}</p></div>` : ''}<div class="detail"><small>Scheduled For</small><p>${fmtSchedule(s.scheduled_date)}</p></div>
    <div class="detail"><small>Status</small><p>${esc((s.status || '').replace('_', ' '))}</p></div>
    ${hist ? `<div class="detail"><small>Reschedule History</small><ul style="font-size:13px;padding-left:18px;margin-top:4px;">${hist}</ul></div>` : ''}`;
  modal.style.display = 'flex';
}

function openImageModal(s) {
  const modal = document.getElementById('imageModal');
  if (!modal) return;

  const hasImage = !!s.image;
  const hasVideo = !!s.video;

  if (!hasImage && !hasVideo) {
    alert('Image or video was not present for this service.');
    return;
  }

  const img = modal.querySelector('img');
  const video = modal.querySelector('video');

  if (hasImage) { img.src = s.image; img.style.display = 'block'; } else { img.style.display = 'none'; img.removeAttribute('src'); }
  if (hasVideo) { video.src = s.video; video.style.display = 'block'; } else { video.style.display = 'none'; video.removeAttribute('src'); }

  modal.style.display = 'flex';
}

function openReasonModal(s) {
  const modal = document.getElementById('reasonModel');
  if (!modal) return;
  const p = modal.querySelector('.reason-text');
  if (p) p.textContent = s.reason || 'No reason provided.';
  modal.style.display = 'flex';
}

function openStatusModal(s) {
  svcState.activeServiceId = s.service_id;
  const modal = document.getElementById('statusModal');
  if (!modal) return;
  loadAvailableHologramParts();  // refresh stock right before the technician picks a part
  modal.style.display = 'flex';
}

async function managerConfirmReturn(serviceId) {
  try {
    const res = await apiFetch(`/service/manager_confirm/${serviceId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'confirmation failed');
    await loadServices();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

async function extendWarranty(serviceId) {
  const newDate = prompt('Enter new warranty end date (YYYY-MM-DD):');
  if (!newDate) return;
  try {
    const res = await apiFetch(`/service/extend_warranty/${serviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warranty_until: newDate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'warranty extension failed');
    await loadServices();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

// ---------- Review a technician's service report: approve the faulty part return, or send it back ----------
function closeReviewModal() {
  const m = document.getElementById('svcReviewModal');
  if (m) m.remove();
}

async function openReviewModal(s) {
  if (!s) return;
  closeReviewModal();
  const info = serviceProductInfo(s);
  const parts = s.faulty_parts || [];
  const spare = s.spare_needed === true;
  const row = (l, v) => `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px;"><span style="width:150px;color:#64748b;flex:none;">${l}</span><span style="flex:1;">${v}</span></div>`;
  const thumb = (src, cap) => src ? `<figure style="margin:0;"><img src="${src}" style="width:150px;height:110px;object-fit:cover;border-radius:8px;cursor:zoom-in;" onclick="window.open(this.src)"><figcaption style="font-size:11px;color:#64748b;margin-top:2px;">${cap}</figcaption></figure>` : '';

  const wrap = document.createElement('div');
  wrap.id = 'svcReviewModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1300;';
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;width:680px;max-width:96vw;max-height:92vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3>Review service report</h3>
        <button type="button" id="rvClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      ${row('Service ID', esc(s.service_id))}
      ${row('Product', esc(info.name) + (info.model ? ' · ' + esc(info.model) : ''))}
      ${row('Technician', esc(s.technician_alloted || '-'))}
      ${row('Serial (ticket)', esc(s.serial_no || '-'))}
      ${row('Serial (entered)', esc(s.tech_serial_no || '-') + (s.serial_mismatch ? ' <b style="color:#d97706;">— differs from the ticket</b>' : ''))}
      ${row('Issue', esc(s.issue || '-'))}
      ${row('Report submitted', s.report_submitted_at ? new Date(s.report_submitted_at).toLocaleString('en-GB') : '-')}
      ${row('Work done', esc(s.work_done || '-'))}
      ${row('Spare part', spare ? `${parts.length} faulty part${parts.length > 1 ? 's' : ''} to be returned` : 'Not needed')}
      ${spare ? `
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin:8px 0;">
          <thead style="background:#f8fafc;"><tr><th style="text-align:left;padding:6px;">Part</th><th style="text-align:left;padding:6px;">Faulty hologram</th><th style="text-align:left;padding:6px;">New hologram</th></tr></thead>
          <tbody>${parts.map(p => `<tr><td style="padding:6px;border-top:1px solid #eef2f7;">${esc(p.part_name)}</td><td style="padding:6px;border-top:1px solid #eef2f7;">${esc(p.old_hologram_number)}</td><td style="padding:6px;border-top:1px solid #eef2f7;">${esc(p.new_hologram_number || '-')}</td></tr>`).join('')}</tbody>
        </table>` : ''}
      <div id="rvPhotos" style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0;color:#94a3b8;font-size:13px;">Loading photos...</div>
      <label style="display:block;font-size:13px;font-weight:600;margin:10px 0 4px;">Service charges (₹) *</label>
      <input id="rvCharges" type="number" min="0" step="0.01" value="${s.service_charges != null ? esc(s.service_charges) : ''}" placeholder="Enter the service charges" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">
      <div id="rvBack" style="display:none;margin-top:10px;">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">Reason for sending back *</label>
        <textarea id="rvReason" rows="3" placeholder="Tell the technician what to fix" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;"></textarea>
      </div>
      <p id="rvErr" style="color:#d62828;font-size:13px;min-height:18px;margin-top:8px;"></p>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
        <button type="button" id="rvSendBack" style="border:none;border-radius:8px;background:#fee2e2;color:#b91c1c;padding:10px 16px;cursor:pointer;font-weight:600;">Send back</button>
        <button type="button" id="rvApprove" style="border:none;border-radius:8px;background:#16a34a;color:#fff;padding:10px 16px;cursor:pointer;font-weight:600;">${spare ? 'Approve faulty part return &amp; complete' : 'Approve &amp; complete'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap) closeReviewModal(); });
  wrap.querySelector('#rvClose').addEventListener('click', closeReviewModal);

  const err = m => { wrap.querySelector('#rvErr').textContent = m || ''; };
  wrap.querySelector('#rvApprove').addEventListener('click', () => approveReport(s, wrap, err));
  wrap.querySelector('#rvSendBack').addEventListener('click', () => sendBackReport(s, wrap, err));

  try {
    const res = await apiFetch(`/service/media/${encodeURIComponent(s.service_id)}`);
    const media = await res.json();
    if (!res.ok) throw new Error(media.detail || 'photos unavailable');
    const html = thumb(media.damage_image, 'Damaged product')
      + media.faulty_parts.map(p => thumb(p.image, `Faulty part: ${esc(p.part_name)}`)).join('')
      + thumb(media.final_image, 'After repair');
    const box = wrap.querySelector('#rvPhotos');
    if (box) box.innerHTML = html || 'No photos.';
  } catch (e) {
    const box = wrap.querySelector('#rvPhotos');
    if (box && e.message !== 'unauthorized' && e.message !== 'forbidden') box.textContent = 'Photos could not be loaded.';
  }
}

async function approveReport(s, wrap, err) {
  err('');
  const raw = wrap.querySelector('#rvCharges').value.trim();
  const charges = raw === '' ? null : Number(raw);
  if (charges === null && s.service_charges == null) { err('Enter the service charges before approving.'); return; }
  if (charges !== null && (!isFinite(charges) || charges < 0)) { err('Service charges must be a valid amount.'); return; }
  const spare = s.spare_needed === true;
  if (!confirm(spare ? 'Confirm that the faulty part(s) have been returned? The service will be marked completed.' : 'Approve this report? The service will be marked completed.')) return;

  const btn = wrap.querySelector('#rvApprove');
  btn.disabled = true;
  try {
    const res = await apiFetch(`/service/approve_completion/${encodeURIComponent(s.service_id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service_charges: charges })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not approve');
    closeReviewModal();
    showResponseModal('Service completed',
      data.hologram_mismatch ? 'Approved. Note: a faulty hologram number did not match the assembly record - please check the damaged inventory entry.'
        : 'Approved. The faulty part(s) were added to the damaged inventory.', true);
    await loadServices();
  } catch (e) {
    if (e.message !== 'unauthorized' && e.message !== 'forbidden') err(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function sendBackReport(s, wrap, err) {
  err('');
  const box = wrap.querySelector('#rvBack');
  const reason = wrap.querySelector('#rvReason');
  if (box.style.display === 'none') { box.style.display = 'block'; reason.focus(); err('Write the reason, then press Send back again.'); return; }
  if (!reason.value.trim()) { err('Write the reason for sending the report back.'); return; }

  const btn = wrap.querySelector('#rvSendBack');
  btn.disabled = true;
  try {
    const res = await apiFetch(`/service/send_back/${encodeURIComponent(s.service_id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not send back');
    closeReviewModal();
    showResponseModal('Sent back', 'The technician has been notified and can fix and resubmit the report.', true);
    await loadServices();
  } catch (e) {
    if (e.message !== 'unauthorized' && e.message !== 'forbidden') err(e.message);
  } finally {
    btn.disabled = false;
  }
}


function exportServicesCSV() {
  openExportWizard({
    title: 'Export Services',
    statusOptions: ['active', 'in_progress', 'pending_approval', 'completed', 'rejected'],
    dateField: 'purchase_date',
    dateLabel: 'Purchase Date',
    getRows: getFilteredServices,
    onConfirm: (rows) => {
      const header = ['Service ID', 'Product', 'Model', 'Serial No', 'Technician', 'Issue', 'Location', 'Warranty Until', 'Status', 'Created By', 'Listed On'];
      const csvRows = rows.map(s => [s.service_id, serviceProductInfo(s).name, serviceProductInfo(s).model, s.serial_no, s.technician_alloted, s.issue, s.location, s.warranty_until || '', s.status, s.created_by || '', s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '']);
      downloadCSV(header, csvRows, 'services.csv');
    }
  });
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function downloadCSV(header, rows, filename) {
  if (a4Intercept(header, rows, filename)) return;
  const q = v => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [header, ...rows].map(r => r.map(q).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function openExportWizard({ title, statusOptions, dateField, dateLabel, getRows, onConfirm }) {
  let modal = document.getElementById('exportWizardModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'exportWizardModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1200;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:360px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>${title}</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px;">${getRows().length} record(s) match the filters currently applied on this page. The options below narrow it further.</p>
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:var(--text-muted);">Status</label>
        <select name="status" style="padding:10px;border:1px solid var(--border);border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:var(--text-muted);">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:var(--text-muted);">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:var(--border);cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

  a4WizardPrint(modal, title);
  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  modal.querySelector('#exportWizardForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = fd.get('status');
    const dateFrom = fd.get('dateFrom');
    const dateTo = fd.get('dateTo');

    const filtered = getRows().filter(row => {
      if (status && row.status !== status) return false;
      if (dateField && (dateFrom || dateTo)) {
        const rowDate = row[dateField] ? new Date(row[dateField]) : null;
        if (!rowDate) return false;
        if (dateFrom && rowDate < new Date(dateFrom)) return false;
        if (dateTo && rowDate > new Date(dateTo + 'T23:59:59')) return false;
      }
      return true;
    });

    modal.style.display = 'none';
    onConfirm(filtered);
  });

  modal.style.display = 'flex';
}


// --- Create Service modal (injected: service.html ships a "new-service"
// button but no matching modal markup) ---
// Product ID is never typed in by hand — new service requests always use this
// fixed value (a single space). The serial number identifies the unit.
const DEFAULT_PRODUCT_ID = ' ';

async function openCreateModal() {
  let modal = document.getElementById('createServiceModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'createServiceModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1000;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:26px;width:460px;">
        <h2 style="margin-bottom:18px;">New Service Request</h2>
        <form id="createServiceForm" style="display:flex;flex-direction:column;gap:12px;">
          <select name="location" required>
            <option value="indoor">Inhouse</option>
            <option value="outdoor">Field</option>
          </select>
          <textarea name="address" id="createAddress" placeholder="Field service address *" style="display:none;min-height:56px;"></textarea>
          <input name="company_name" placeholder="Company Name" required>
          <input name="product_name" placeholder="Product Name" required>
          <input name="model_no" placeholder="Model No." required>
          <input name="serial_no" placeholder="Serial No" required>
          <select name="technician_id" id="technicianSelect" required>
            <option value="">Select person</option>
          </select>
          <input name="purchase_date" type="date" required>
          <textarea name="issue" placeholder="Issue description" required style="min-height:80px;"></textarea>
          <textarea name="spare_parts" placeholder="Spare parts requested (optional)" style="min-height:50px;"></textarea>
          <label style="font-size:12px;color:var(--text-muted);">Image proof (optional, max 2MB)</label>
          <input type="file" name="image_file" accept="image/*">
          <label style="font-size:12px;color:var(--text-muted);">Video proof (optional, max 20MB)</label>
          <input type="file" name="video_file" accept="video/*">
          <p id="createServiceMediaError" style="color:var(--danger);font-size:12px;display:none;"></p>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" id="cancelCreateService" style="padding:10px 16px;border:none;border-radius:8px;background:var(--border);cursor:pointer;">Cancel</button>
            <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;">Create</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#cancelCreateService').addEventListener('click', () => modal.style.display = 'none');
    const locSel = modal.querySelector('select[name="location"]');
    const addrBox = modal.querySelector('#createAddress');
    locSel.addEventListener('change', () => { addrBox.style.display = locSel.value === 'outdoor' ? 'block' : 'none'; });
    modal.querySelector('#createServiceForm').addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const errorBox = document.getElementById('createServiceMediaError');
      errorBox.style.display = 'none';

      const imageFile = form.querySelector('[name="image_file"]').files[0];
      const videoFile = form.querySelector('[name="video_file"]').files[0];

      if (fd.get('location') === 'outdoor' && !(fd.get('address') || '').trim()) {
        errorBox.textContent = 'Enter the address for a field service.';
        errorBox.style.display = 'block';
        return;
      }

      const MAX_IMAGE_BYTES = 2 * 1024 * 1024;   // 2MB
      const MAX_VIDEO_BYTES = 20 * 1024 * 1024;  // 20MB

      if (imageFile && imageFile.size > MAX_IMAGE_BYTES) {
        errorBox.textContent = `Image is ${(imageFile.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`;
        errorBox.style.display = 'block';
        return;
      }
      if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
        errorBox.textContent = `Video is ${(videoFile.size / 1024 / 1024).toFixed(1)}MB — must be 20MB or under.`;
        errorBox.style.display = 'block';
        return;
      }

      const payload = {
        product_id: DEFAULT_PRODUCT_ID,
        company_name: (fd.get('company_name') || '').trim(),
        product_name: (fd.get('product_name') || '').trim(),
        model_no: (fd.get('model_no') || '').trim(),
        location: fd.get('location'),
        serial_no: (fd.get('serial_no') || '').trim().toLowerCase(),
        technician_id: fd.get('technician_id'),
        purchase_date: fd.get('purchase_date'),
        issue: fd.get('issue'),
        spare_parts: fd.get('spare_parts') || '',
        address: fd.get('location') === 'outdoor' ? (fd.get('address') || '').trim() : ''
      };

      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading...';

      try {
        payload.image = imageFile ? await readFileAsBase64(imageFile) : '';
        payload.video = videoFile ? await readFileAsBase64(videoFile) : '';

        const res = await apiFetch('/services/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'service creation failed');
        modal.style.display = 'none';
        form.reset();
        addrBox.style.display = 'none';
        if (payload.video) {
          showResponseModal('Service created', 'Service was created. Admin/employee have been notified to review the uploaded video.', true);
        }
        await loadServices();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create';
      }
    });
  }

  // refresh the technician dropdown every time the modal opens, so it always
  // reflects current usernames from Users → technician accounts
  const select = modal.querySelector('#technicianSelect');
  select.innerHTML = '<option value="">Loading...</option>';
  await loadAssignees();
  select.innerHTML = svcState.assignees.length
    ? assigneeOptionsHtml('Select person')
    : '<option value="">No users found — add one from Users</option>';

  modal.style.display = 'flex';
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const statusForm = document.querySelector('#statusModal form');
  if (statusForm) {
    let spareUsed = false;
    const spareBtns = statusForm.querySelectorAll('.spare-used-btn');
    const partsList = statusForm.querySelector('.parts-used-list');
    const addPartBtn = statusForm.querySelector('.add-part-btn');
    const sparePartsText = statusForm.querySelector('.spare-parts-text');

    const partRowHtml = () => `
      <div class="part-row" style="display:flex;gap:6px;align-items:center;">
        <select class="part-name-select" style="flex:1;">
          <option value="">Select part…</option>
          ${svcState.hologramPool.map(p => `<option value="${p.part_name}">${p.part_name} (${p.hologram_numbers.length} available)</option>`).join('')}
        </select>
        <input type="text" class="part-old-hologram-input" placeholder="Old hologram no." style="flex:1;">
        <select class="part-new-hologram-select" style="flex:1;" disabled>
          <option value="">Select part first…</option>
        </select>
        <button type="button" class="remove-part-btn" style="border:none;background:var(--border);border-radius:6px;padding:8px 10px;cursor:pointer;">&times;</button>
      </div>`;

    const addPartRow = () => {
      partsList.insertAdjacentHTML('beforeend', partRowHtml());
      const row = partsList.lastElementChild;
      row.querySelector('.remove-part-btn').addEventListener('click', e => {
        e.target.closest('.part-row').remove();
      });
      const nameSelect = row.querySelector('.part-name-select');
      const hologramSelect = row.querySelector('.part-new-hologram-select');
      nameSelect.addEventListener('change', () => {
        const chosen = svcState.hologramPool.find(p => p.part_name === nameSelect.value);
        const numbers = chosen ? chosen.hologram_numbers : [];
        hologramSelect.disabled = !numbers.length;
        hologramSelect.innerHTML = numbers.length
          ? `<option value="">Select hologram no.…</option>${numbers.map(h => `<option value="${h}">${h}</option>`).join('')}`
          : `<option value="">No hologram numbers on file</option>`;
      });
    };
    addPartBtn.addEventListener('click', addPartRow);

    const renderSpareUsed = () => {
      spareBtns.forEach(b => {
        const active = (b.dataset.used === 'true') === spareUsed;
        b.style.background = active ? 'var(--primary)' : '#fff';
        b.style.color = active ? '#fff' : 'var(--primary)';
      });
      partsList.style.display = spareUsed ? 'flex' : 'none';
      addPartBtn.style.display = spareUsed ? 'block' : 'none';
      sparePartsText.style.display = spareUsed ? 'none' : 'block';
      if (spareUsed && !partsList.children.length) addPartRow();
    };
    spareBtns.forEach(b => b.addEventListener('click', () => {
      spareUsed = b.dataset.used === 'true';
      renderSpareUsed();
    }));
    renderSpareUsed();

    statusForm.addEventListener('submit', async e => {
      e.preventDefault();
      const select = statusForm.querySelector('select');
      const reasonBox = statusForm.querySelector('textarea:not(.spare-parts-text)');
      const chargesBox = statusForm.querySelector('.service-charges-input');

      const statusMap = { 'Active': 'active', 'In Progress': 'in_progress', 'Completed': 'completed', 'Rejected': 'rejected' };
      const service_status = statusMap[select.value] || select.value.toLowerCase().replace(' ', '_');

      let parts_used = [];
      if (spareUsed) {
        parts_used = [...partsList.querySelectorAll('.part-row')].map(row => ({
          part_name: row.querySelector('.part-name-select').value.trim(),
          old_hologram_number: row.querySelector('.part-old-hologram-input').value.trim(),
          new_hologram_number: row.querySelector('.part-new-hologram-select').value.trim()
        }));
        if (service_status === 'completed') {
          if (!parts_used.length || parts_used.some(p => !p.part_name || !p.old_hologram_number || !p.new_hologram_number)) {
            alert('Every spare part needs a part selected, its old hologram number, and a new hologram number chosen from stock.');
            return;
          }
        }
      }
      const spare_parts = spareUsed ? parts_used.map(p => p.part_name).join(', ') : sparePartsText.value;

      if (service_status === 'completed' && !spare_parts.trim()) {
        alert('Spare part used must be written before marking the service as Completed.');
        return;
      }
      if (service_status === 'completed' && (chargesBox.value === '' || Number(chargesBox.value) < 0)) {
        alert('Service charges must be entered before marking the service as Completed.');
        return;
      }
      if (service_status === 'rejected' && !reasonBox.value.trim()) {
        alert('Reason must be provided before rejecting a service.');
        return;
      }

      const payload = {
        service_status,
        reason: reasonBox ? reasonBox.value : '',
        spare_parts,
        spare_parts_used: spareUsed,
        parts_used,
        service_charges: chargesBox.value !== '' ? Number(chargesBox.value) : null
      };

      try {
        const res = await apiFetch(`/service/update/${svcState.activeServiceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'status update failed');
        document.getElementById('statusModal').style.display = 'none';
        statusForm.reset();
        spareUsed = false;
        partsList.innerHTML = '';
        renderSpareUsed();
        await loadServices();
        if (data.hologram_mismatch) {
          alert('This hologram number was not associated with that serial number.');
        }
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    });
  }
}

let svcView = 'services';
let svcSearch = '';

const SVC_HEAD = ['Company', 'Product Name', 'Model No.', 'Serial No.', 'Technician', 'Issue', 'Location', 'Warranty', 'Status', 'Return Approval', 'Created By', 'Listed On', 'Actions'];
// A technician's own installation request = unassigned installation raised by somebody else.
// Approving it assigns the installation to whoever raised it.
const instMeS = () => (typeof getUsername === 'function' ? (getUsername() || '') : '');
const instIsRequest = i => !i.technician_id && !!i.requested_by && i.requested_by !== instMeS() && i.status !== 'completed';
async function approveInstallRequest(i) {
  try {
    await svcPost(`/installation/assign/${encodeURIComponent(i.installation_id)}`, { technician_id: i.requested_by });
    await Promise.all([loadInstallations(), loadRequests()]);
  } catch (e) { if (e.message !== 'unauthorized' && e.message !== 'forbidden') alert(e.message); }
}
const INST_LABEL = { requested: 'Requested', scheduled: 'Scheduled', in_progress: 'In progress', pending_approval: 'Completion review', completed: 'Completed' };
const IN_S = 'width:100%;padding:9px;margin:6px 0 10px;border:1px solid var(--border);border-radius:8px;box-sizing:border-box;';
const B_PRI = 'padding:9px 16px;border:none;background:#1665ff;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;';
const B_GRY = 'padding:9px 16px;border:none;background:#e2e8f0;color:#0f172a;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;';
const B_GRN = 'padding:8px 14px;border:none;background:#16a34a;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;';
const B_RED = 'padding:8px 14px;border:none;background:#dc2626;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;';
const B_ICO = 'border:none;background:#f1f5f9;border-radius:8px;padding:8px 10px;cursor:pointer;color:#334155;';
const V_BTN = `<button type="button" data-act="view" title="View" style="${B_ICO}"><i class="fa-solid fa-eye"></i></button>`;

async function svcPost(url, body) {
  const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Request failed.');
  return data;
}

function svcModal(title, bodyHtml, width) {
  const old = document.getElementById('svcGenericModal');
  if (old) old.remove();
  const m = document.createElement('div');
  m.id = 'svcGenericModal';
  m.className = 'modal';
  m.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:1300;';
  m.innerHTML = `<div class="modal-content" style="background:#fff;border-radius:16px;padding:26px;width:${width || 460}px;max-width:94vw;max-height:92vh;overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;"><h3>${title}</h3>
    <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>${bodyHtml}</div>`;
  document.body.appendChild(m);
  m.querySelector('.close').onclick = () => m.remove();
  return m;
}

const dRowS = (label, value) => `<div class="detail"><small>${label}</small><p>${value || '-'}</p></div>`;

function demoItemsS(a) {
  return (a.items || []).map(it => ({
    name: it.product_name || it.product_id || '-', model: it.model_no || it.model_number || '-',
    serials: (it.serial_numbers || []).join(', ') || '-', qty: it.quantity || (it.serial_numbers || []).length || 1
  }));
}
const allocWhenS = a => a.created_at || a.allocated_at || a.allocation_date || '';
const demoReturnPending = a => !!a.return_status && !/^(returned|approved|rejected)$/i.test(String(a.return_status));
const demoReturnReq = a => (svcState.returnReqs || []).find(r => r.status === 'pending' && [r.allocation_id, (r.details || {}).allocation_id].includes(a.allocation_id));
async function approveDemoReturn(a) {
  try {
    const r = demoReturnReq(a);
    if (r) await svcPost(`/request/approve/${encodeURIComponent(r.request_id)}`, {});
    else await svcPost(`/allocation/return/${encodeURIComponent(a.allocation_id)}`, {});
    await Promise.all([loadDemo(), loadRequests()]);
  } catch (e) { if (e.message !== 'unauthorized' && e.message !== 'forbidden') alert(e.message); }
}
function rejectDemoReturn(a) {
  const r = demoReturnReq(a);
  if (!r) { alert('This return has no request to reject. Contact admin.'); return; }
  const m = svcModal('Reject Return', `<p style="font-size:13px;color:var(--text-light);">Return requested by ${esc(a.allocated_by || '-')}</p>
    <label style="font-size:13px;">Reason (shown to the technician)</label><textarea id="rjReason" rows="3" style="${IN_S}"></textarea>${formFooter('Reject')}`);
  bindForm(m, async (mm, err) => {
    const reason = mm.querySelector('#rjReason').value.trim();
    if (!reason) { err.textContent = 'Write a reason.'; return; }
    await svcPost(`/request/reject/${encodeURIComponent(r.request_id)}`, { reason });
    mm.remove(); await Promise.all([loadDemo(), loadRequests()]);
  });
}
const demoStatusS = a => (a.return_status ? String(a.return_status).replace(/_/g, ' ') : 'with technician');

async function loadInstallations() {
  try {
    const res = await apiFetch('/installation/');
    const data = await res.json();
    svcState.installs = res.ok ? data.dataset || [] : [];
  } catch (e) { svcState.installs = []; }
  renderAll();
  const id = new URLSearchParams(location.search).get('installation');
  if (id && !svcState._instLink) {
    svcState._instLink = true;
    const i = svcState.installs.find(x => x.installation_id === id);
    if (i) openInstallDetailS(i);
  }
}

async function loadDemo() {
  try {
    const res = await apiFetch('/allocation/');
    const data = await res.json();
    svcState.demo = res.ok ? (data.dataset || []).filter(a => a.allocation_type === 'demo_unit') : [];
  } catch (e) { svcState.demo = []; }
  renderAll();
}

async function loadRequests() {
  try {
    const res = await apiFetch('/request/');
    const data = await res.json();
    svcState.returnReqs = res.ok ? (data.dataset || []).filter(r => /return/i.test(r.request_type || '')) : [];
    svcState.requests = res.ok ? (data.dataset || []).filter(r => r.request_type === 'reschedule' || r.request_type === 'spare_part')
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)) : [];
  } catch (e) { svcState.requests = []; }
  renderAll();
}

async function loadInventoryOptions() {
  try {
    const res = await apiFetch('/inventory/');
    const data = await res.json();
    const map = {};
    (res.ok ? data.dataset || [] : []).filter(r => !r.product_type || r.product_type === 'product').forEach(r => {
      const key = `${r.product_id}||${r.model_no || ''}`;
      if (!map[key]) map[key] = { product_id: r.product_id, product_name: r.product_name, model_no: r.model_no || '', qty: 0 };
      map[key].qty += Number(r.quantity) || 0;
    });
    svcState.inventory = Object.values(map).sort((a, b) => String(a.product_name).localeCompare(String(b.product_name)));
  } catch (e) { svcState.inventory = []; }
}

const SVC_VIEWS = {
  services: {
    title: 'Services', info: 'Manage all product services from one place',
    statuses: [['all', 'All'], ['active', 'Active'], ['in_progress', 'In Progress'], ['pending_approval', 'Awaiting Approval'], ['completed', 'Completed'], ['rejected', 'Rejected']],
    list: () => svcState.services, statusOf: s => s.status,
    button: { label: '<i class="fa-solid fa-plus"></i> Add Service', fn: () => openCreateModal() },
    date: true, exp: true
  },
  installs: {
    title: 'Installations', info: 'Approve technician requests (assigned to the requester) or assign and schedule installations yourself',
    cols: ['Product', 'Model No.', 'Customer', 'Address', 'Technician', 'Status', 'Scheduled', 'Requested By', 'Actions'],
    statuses: [['all', 'All'], ['requested', 'Requested'], ['scheduled', 'Scheduled'], ['in_progress', 'In Progress'], ['pending_approval', 'Completion review'], ['completed', 'Completed']],
    list: () => svcState.installs, statusOf: i => i.status, techOf: i => i.technician_id || '',
    text: i => [i.product_name, i.model_no, i.company_name, i.address, i.serial_no, i.technician_id].join(' '),
    cells: i => [esc(i.product_name), esc(i.model_no || '-'), esc(i.company_name), esc(i.address || '-'),
    i.technician_id ? esc(i.technician_id) : (instIsRequest(i) ? `<span style="color:#d97706;font-weight:600;">Request from ${esc(i.requested_by)}</span>` : '<span style="color:#dc2626;font-weight:600;">Unassigned</span>'),
    `<span class="progress">${esc(INST_LABEL[i.status] || i.status)}</span>`, i.scheduled_date ? fmtSchedule(i.scheduled_date) : '-', esc(i.requested_by || '-')],
    actions: i => V_BTN + (i.status === 'pending_approval' ? `<button type="button" data-act="review" style="${B_GRN}">Review</button>` : '') + (instIsRequest(i) ? `<button type="button" data-act="approve" style="${B_GRN}">Approve</button>` : '') + (i.status !== 'completed' ? `<button type="button" data-act="assign" style="${B_GRY}">${i.technician_id ? 'Reassign' : 'Assign'}</button><button type="button" data-act="sched" style="${B_GRY}">${i.scheduled_date ? 'Reschedule' : 'Schedule'}</button>` : ''),
    act: { view: i => openInstallDetailS(i), review: i => openInstallReview(i), approve: i => approveInstallRequest(i), assign: i => openAssignInstall(i), sched: i => openScheduleInstall(i) },
    open: i => openInstallDetailS(i),
    button: { label: '<i class="fa-solid fa-plus"></i> New Installation', fn: () => openNewInstallS() },
    empty: 'No installations found.'
  },
  demo: {
    title: 'Demo Units', info: 'Demo units held by technicians — hand over or assign new ones from stock',
    cols: ['Product', 'Model No.', 'Serial No.', 'Assigned To', 'Status', 'Allocated On', 'Actions'],
    statuses: [['all', 'All'], ['with technician', 'With technician'], ['other', 'Returned / return pending']],
    list: () => svcState.demo, statusOf: a => (demoStatusS(a) === 'with technician' ? 'with technician' : 'other'), techOf: a => a.allocated_by || '',
    text: a => demoItemsS(a).map(x => x.name + ' ' + x.model + ' ' + x.serials).join(' ') + ' ' + (a.allocated_by || ''),
    cells: a => {
      const it = demoItemsS(a); const f = it[0] || { name: '-', model: '-', serials: '-' };
      return [esc(f.name) + (it.length > 1 ? ` <small style="color:#64748b;">+${it.length - 1} more</small>` : ''), esc(f.model), esc(f.serials),
      esc(a.allocated_by || '-'), `<span class="progress">${esc(demoStatusS(a))}</span>`, allocWhenS(a) ? fmtSchedule(allocWhenS(a)) : '-'];
    },
    actions: a => V_BTN + (demoReturnPending(a) ? `<button type="button" data-act="appr" style="${B_GRN}">Approve return</button><button type="button" data-act="rej" style="${B_RED}">Reject</button>` : '') + (!a.return_status ? `<button type="button" data-act="reassign" style="${B_GRY}">Reassign</button>` : ''),
    act: { view: a => openDemoDetailS(a), reassign: a => openReassignDemo(a), appr: a => approveDemoReturn(a), rej: a => rejectDemoReturn(a) },
    open: a => openDemoDetailS(a),
    button: { label: '<i class="fa-solid fa-plus"></i> Assign Demo Unit', fn: () => openAssignDemo() },
    empty: 'No demo units found.'
  },
  requests: {
    title: 'Technician Requests', info: 'Technicians cannot change a date or take an installation themselves — approve or reject their requests here',
    cols: ['Raised By', 'Type', 'Item', 'Current Date', 'Requested Date', 'Reason', 'Status', 'Raised On', 'Actions'],
    statuses: [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']],
    list: () => requestRowsS(), statusOf: r => r.status, techOf: r => r.raised_by || '',
    text: r => [r.raised_by, (r.details || {}).label, (r.details || {}).reason, (r.details || {}).note].join(' '),
    cells: r => {
      const d = r.details || {};
      if (r.request_type === 'spare_part') return [esc(r.raised_by), 'Spare part request', esc(sparePartNamesS(r) || '-'), '-', '-',
        `Needs spare part for service #${esc(String(d.service_id || '').slice(0, 8))}`,
        `<span class="${r.status === 'approved' ? 'completed' : r.status === 'rejected' ? 'rejected' : 'pending'}">${esc(r.status)}</span>`, r.created_at ? fmtSchedule(r.created_at) : '-'];
      if (r._inst) return [esc(r.raised_by), 'Installation request', esc(d.label || '-'), '-', '-', 'Wants to take this installation', `<span class="pending">${esc(r.status)}</span>`, r.created_at ? fmtSchedule(r.created_at) : '-'];
      return [esc(r.raised_by), d.kind === 'installation' ? 'Installation reschedule' : 'Service reschedule', esc(d.label || '-'), d.current_date ? fmtSchedule(d.current_date) : '-',
      `<b>${fmtSchedule(d.requested_date)}</b>`, esc(d.reason || '-'),
      `<span class="${r.status === 'approved' ? 'completed' : r.status === 'rejected' ? 'rejected' : 'pending'}">${esc(r.status)}</span>`,
      r.created_at ? fmtSchedule(r.created_at) : '-'];
    },
    actions: r => r.status === 'pending' ? `<button type="button" data-act="approve" style="${B_GRN}">Approve</button>` + (r._inst ? '' : `<button type="button" data-act="reject" style="${B_RED}">Reject</button>`) : V_BTN,
    act: { view: r => (r._inst ? openInstallDetailS(r._inst) : openRequestDetailS(r)), approve: r => (r._inst ? approveInstallRequest(r._inst) : approveReschedule(r)), reject: r => openRejectReschedule(r) },
    open: r => (r._inst ? openInstallDetailS(r._inst) : openRequestDetailS(r)),
    empty: 'No requests from technicians.'
  }
};

// reschedule requests + technicians' installation requests, in one list
function requestRowsS() {
  const inst = svcState.installs.filter(i => i.requested_by && i.requested_by !== instMeS() && (i.status !== 'completed' || i.technician_id === i.requested_by) && (!i.technician_id || i.technician_id === i.requested_by))
    .map(i => ({ request_id: 'inst:' + i.installation_id, _inst: i, raised_by: i.requested_by, status: i.technician_id ? 'approved' : 'pending',
      created_at: i.created_at || i.requested_on || null, details: { label: `${i.product_name || ''} · ${i.company_name || ''}` } }));
  return svcState.requests.concat(inst).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function setSvcView(v) {
  svcView = v;
  svcState.status = v === 'requests' ? 'pending' : 'all';
  const t = document.getElementById('techFilter'); if (t) t.value = '';
  renderAll();
}

function syncFilters() {
  const t = document.getElementById('techFilter');
  const d = document.getElementById('dateFilter');
  svcState.filters = {
    status: svcState.status === 'all' ? '' : svcState.status,
    technician: t ? t.value : '',
    date: svcView === 'services' && d ? d.value : ''
  };
}

function visibleRowsS() {
  const v = SVC_VIEWS[svcView];
  syncFilters();
  const f = svcState.filters, q = svcState.search;
  return v.list().filter(x => (!f.status || v.statusOf(x) === f.status) && (!f.technician || v.techOf(x) === f.technician) && (!q || v.text(x).toLowerCase().includes(q)));
}

function renderAll() {
  renderCats();
  renderChipsS();
  renderMain();
}

function renderCats() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const sv = svcState.services;
  set('catServices', sv.length);
  set('catServicesSub', `${sv.filter(s => s.status === 'pending_approval').length} awaiting approval`);
  const open = svcState.installs.filter(i => i.status !== 'completed');
  set('catInstalls', open.length);
  set('catInstallsSub', `${open.filter(i => i.status === 'pending_approval').length} completion review · ${open.filter(instIsRequest).length} awaiting approval · ${open.filter(i => !i.technician_id && !instIsRequest(i)).length} unassigned`);
  const held = svcState.demo.filter(a => !a.return_status);
  set('catDemo', held.length);
  { const rp = svcState.demo.filter(demoReturnPending).length; set('catDemoSub', rp ? `${rp} return awaiting approval` : 'with technicians'); }
  set('catRequests', requestRowsS().filter(r => r.status === 'pending').length);
  set('catRequestsSub', 'waiting for you');
  document.querySelectorAll('#catCards .cat-card').forEach(c => c.classList.toggle('active', c.dataset.view === svcView));
}

function renderChipsS() {
  const v = SVC_VIEWS[svcView];
  document.getElementById('viewTitle').textContent = v.title;
  let info = v.info;
  if (svcView === 'services') {
    const faulty = svcState.services.filter(s => s.status === 'pending_approval').reduce((n, s) => n + (Number(s.faulty_part_count) || 0), 0);
    info += ` · Faulty parts to return: ${faulty}`;
  }
  document.getElementById('viewInfo').textContent = info;
  const all = v.list();
  const box = document.getElementById('statusChips');
  box.innerHTML = v.statuses.map(([k, label]) => {
    const n = k === 'all' ? all.length : all.filter(x => v.statusOf(x) === k).length;
    return `<button type="button" class="chip${svcState.status === k ? ' active' : ''}" data-k="${esc(k)}">${label} (${n})</button>`;
  }).join('');
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { svcState.status = c.dataset.k; renderChipsS(); renderMain(); }));
  const btn = document.getElementById('viewAction');
  if (v.button) { btn.style.display = ''; btn.innerHTML = v.button.label; btn.onclick = v.button.fn; } else { btn.style.display = 'none'; btn.onclick = null; }
  document.getElementById('dateBox').style.display = v.date ? '' : 'none';
  document.getElementById('exportBtn').style.display = v.exp ? '' : 'none';
}

function renderMain() {
  const v = SVC_VIEWS[svcView];
  const head = document.getElementById('mainHead');
  if (svcView === 'services') {
    head.innerHTML = `<tr>${SVC_HEAD.map(c => `<th>${c}</th>`).join('')}</tr>`;
    syncFilters();
    renderServiceTable(getFilteredServices());
    return;
  }
  const rows = visibleRowsS();
  head.innerHTML = `<tr>${v.cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const tbody = document.getElementById('mainBody');
  tbody.innerHTML = rows.length ? rows.map((x, n) => `<tr data-n="${n}" style="cursor:pointer;">${v.cells(x).map(c => `<td>${c}</td>`).join('')}<td style="white-space:nowrap;"><div style="display:flex;gap:6px;align-items:center;">${v.actions(x)}</div></td></tr>`).join('')
    : `<tr><td colspan="${v.cols.length}" style="text-align:center;color:#94a3b8;padding:28px;">${v.empty}</td></tr>`;
  tbody.querySelectorAll('tr[data-n]').forEach(tr => {
    const item = rows[Number(tr.dataset.n)];
    tr.addEventListener('click', e => { if (!e.target.closest('button')) v.open(item); });
    tr.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => v.act[b.dataset.act](item)));
  });
}

function wireToolbar() {
  document.querySelectorAll('#catCards .cat-card').forEach(c => c.addEventListener('click', () => setSvcView(c.dataset.view)));
  const t = document.getElementById('techFilter');
  const d = document.getElementById('dateFilter');
  if (t) t.addEventListener('change', renderMain);
  if (d) d.addEventListener('change', renderMain);
  const ex = document.getElementById('exportBtn');
  if (ex) ex.addEventListener('click', exportServicesCSV);
}

function techSelectHtml(id, current, placeholder) {
  return `<select id="${id}" style="${IN_S}"><option value="">${placeholder}</option>${svcState.assignees.map(u => `<option value="${esc(u.username)}"${u.username === current ? ' selected' : ''}>${esc(u.username)}${u.name && u.name !== u.username ? ' — ' + esc(u.name) : ''}</option>`).join('')}</select>`;
}

function formFooter(saveLabel) {
  return `<p class="m-err" style="color:#dc2626;font-size:13px;min-height:16px;margin-bottom:6px;"></p>
    <div style="display:flex;justify-content:flex-end;gap:10px;"><button type="button" class="m-cancel" style="${B_GRY}">Cancel</button><button type="button" class="m-save" style="${B_PRI}">${saveLabel}</button></div>`;
}

function bindForm(m, onSave) {
  const err = m.querySelector('.m-err');
  m.querySelector('.m-cancel').onclick = () => m.remove();
  m.querySelector('.m-save').onclick = async () => {
    err.textContent = '';
    try { await onSave(m, err); } catch (e) { if (e.message !== 'unauthorized' && e.message !== 'forbidden') err.textContent = e.message; }
  };
}

async function openAssignInstall(i) {
  await loadAssignees();
  const m = svcModal('Assign Installation', `<p style="font-size:13px;color:var(--text-light);">${esc(i.product_name)} · ${esc(i.company_name)}</p>
    <label style="font-size:13px;">Technician</label>${techSelectHtml('asTech', i.technician_id, 'Select technician')}${formFooter('Assign')}`);
  bindForm(m, async (mm, err) => {
    const tech = mm.querySelector('#asTech').value;
    if (!tech) { err.textContent = 'Select a technician.'; return; }
    await svcPost(`/installation/assign/${encodeURIComponent(i.installation_id)}`, { technician_id: tech });
    mm.remove();
    await loadInstallations();
  });
}

function openScheduleInstall(i) {
  const m = svcModal(i.scheduled_date ? 'Reschedule Installation' : 'Schedule Installation', `<p style="font-size:13px;color:var(--text-light);">${esc(i.product_name)} · ${esc(i.company_name)}</p>
    <label style="font-size:13px;">Date &amp; time</label><input type="datetime-local" id="scWhen" value="${toLocalInput(i.scheduled_date || i.preferred_date)}" style="${IN_S}">
    <label style="font-size:13px;">Note</label><textarea id="scNote" rows="3" style="${IN_S}"></textarea>${formFooter('Save')}`);
  bindForm(m, async (mm, err) => {
    const when = mm.querySelector('#scWhen').value;
    if (!when) { err.textContent = 'Pick a date and time.'; return; }
    await svcPost(`/installation/schedule/${encodeURIComponent(i.installation_id)}`, { scheduled_date: new Date(when).toISOString(), note: mm.querySelector('#scNote').value });
    mm.remove();
    await loadInstallations();
  });
}

async function openNewInstallS() {
  await loadAssignees();
  const f = (name, ph, req) => `<input name="${name}" placeholder="${ph}" ${req ? 'data-req="1"' : ''} style="${IN_S}">`;
  const m = svcModal('New Installation', `${f('product_name', 'Product name *', 1)}${f('model_no', 'Model No.')}${f('serial_no', 'Serial No.')}
    ${f('company_name', 'Customer / company *', 1)}${f('address', 'Installation address *', 1)}${f('contact_person', 'Contact person')}${f('contact_number', 'Contact number')}
    <label style="font-size:13px;">Technician (optional)</label>${techSelectHtml('niTech', '', 'Leave unassigned')}
    <label style="font-size:13px;">Preferred date (optional)</label><input name="preferred_date" type="datetime-local" style="${IN_S}">
    <textarea name="notes" placeholder="Notes" rows="2" style="${IN_S}"></textarea>${formFooter('Create')}`);
  bindForm(m, async (mm, err) => {
    const body = {};
    mm.querySelectorAll('input[name], textarea[name]').forEach(el => { body[el.name] = el.value.trim(); });
    if ([...mm.querySelectorAll('[data-req]')].some(el => !el.value.trim())) { err.textContent = 'Fill in all the fields marked *.'; return; }
    body.technician_id = mm.querySelector('#niTech').value;
    if (body.preferred_date) body.preferred_date = new Date(body.preferred_date).toISOString();
    await svcPost('/installation/create', body);
    mm.remove();
    await loadInstallations();
  });
}

function openInstallReview(i) {
  const img = i.completion_image || i.completion_proof || i.proof_image || i.image || '';
  const m = svcModal('Review Installation Completion', `
    <p style="font-size:13px;color:var(--text-light);">${esc(i.product_name)} · ${esc(i.company_name)} — by ${esc(i.technician_id || '-')}</p>
    ${img ? `<img src="${esc(img)}" alt="Installation photo" style="max-width:100%;border-radius:10px;margin:10px 0;">` : '<p style="color:#94a3b8;font-size:13px;margin:10px 0;">Photo not available in the list response.</p>'}
    ${i.completion_note || i.note_by_technician ? dRowS('Technician note', esc(i.completion_note || i.note_by_technician)) : ''}
    <label style="font-size:13px;">Reason (needed only to reject)</label><textarea id="rvReason" rows="2" style="${IN_S}"></textarea>
    <p class="m-err" style="color:#dc2626;font-size:13px;min-height:16px;"></p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button type="button" id="rvReject" style="${B_RED}">Reject</button>
      <button type="button" id="rvApprove" style="${B_GRN}">Approve &amp; complete</button>
    </div>`, 520);
  const err = m.querySelector('.m-err');
  const run = async (status, note) => {
    try {
      await svcPost(`/installation/status/${encodeURIComponent(i.installation_id)}`, { status, note });
      m.remove(); await loadInstallations();
    } catch (e) { if (e.message !== 'unauthorized' && e.message !== 'forbidden') err.textContent = e.message; }
  };
  m.querySelector('#rvApprove').onclick = () => run('completed', 'Approved');
  m.querySelector('#rvReject').onclick = () => {
    const r = m.querySelector('#rvReason').value.trim();
    if (!r) { err.textContent = 'Write a reason to reject.'; return; }
    run('in_progress', r);
  };
}

function openInstallDetailS(i) {
  const hist = (i.schedule_history || []).slice().reverse().map(h =>
    `<li>${fmtSchedule(h.from)} &rarr; <b>${fmtSchedule(h.to)}</b> by ${esc(h.by)}${h.note ? ' - ' + esc(h.note) : ''}</li>`).join('');
  svcModal('Installation Details', `
    ${dRowS('Status', esc(INST_LABEL[i.status] || i.status))}${dRowS('Product', esc(i.product_name))}${dRowS('Model No.', esc(i.model_no))}${dRowS('Serial No.', esc(i.serial_no))}
    ${dRowS('Customer', esc(i.company_name))}${dRowS('Address', esc(i.address))}${dRowS('Contact', esc([i.contact_person, i.contact_number].filter(Boolean).join(' · ')))}
    ${dRowS('Technician', esc(i.technician_id || 'Not assigned'))}${dRowS('Preferred Date', i.preferred_date ? fmtSchedule(i.preferred_date) : '-')}
    ${dRowS('Scheduled For', fmtSchedule(i.scheduled_date))}${dRowS('Requested By', esc(i.requested_by))}${i.notes ? dRowS('Notes', esc(i.notes)) : ''}
    ${hist ? dRowS('Schedule History', `<ul style="font-size:13px;padding-left:18px;">${hist}</ul>`) : ''}`, 520);
}

function openDemoDetailS(a) {
  const it = demoItemsS(a);
  const cust = a.customer || {};
  svcModal('Demo Unit Details', `
    ${dRowS('Assigned To', esc(a.allocated_by))}${dRowS('Status', esc(demoStatusS(a)))}${dRowS('Allocated On', allocWhenS(a) ? fmtSchedule(allocWhenS(a)) : '-')}
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;margin:10px 0;"><table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead style="background:var(--bg-light);"><tr>${['Product', 'Model No.', 'Serial No(s).', 'Qty'].map(h => `<th style="text-align:left;padding:8px;">${h}</th>`).join('')}</tr></thead>
      <tbody>${it.map(x => `<tr><td style="padding:8px;border-top:1px solid var(--border);">${esc(x.name)}</td><td style="padding:8px;border-top:1px solid var(--border);">${esc(x.model)}</td><td style="padding:8px;border-top:1px solid var(--border);">${esc(x.serials)}</td><td style="padding:8px;border-top:1px solid var(--border);">${esc(x.qty)}</td></tr>`).join('')}</tbody></table></div>
    ${cust.company_name ? dRowS('Customer', esc(cust.company_name)) : ''}${a.remarks ? dRowS('Remarks', esc(a.remarks)) : ''}`, 620);
}

async function openReassignDemo(a) {
  await loadAssignees();
  const f = demoItemsS(a)[0] || { name: '-', model: '-' };
  const m = svcModal('Reassign Demo Unit', `<p style="font-size:13px;color:var(--text-light);">${esc(f.name)} · ${esc(f.model)} · now with ${esc(a.allocated_by || '-')}</p>
    <label style="font-size:13px;">Hand over to</label>${techSelectHtml('rdTech', a.allocated_by, 'Select technician')}${formFooter('Reassign')}`);
  bindForm(m, async (mm, err) => {
    const tech = mm.querySelector('#rdTech').value;
    if (!tech) { err.textContent = 'Select a technician.'; return; }
    await svcPost(`/allocation/reassign_demo/${encodeURIComponent(a.allocation_id)}`, { technician_id: tech });
    mm.remove();
    await loadDemo();
  });
}

async function openAssignDemo() {
  await Promise.all([loadAssignees(), loadInventoryOptions()]);
  const rowHtml = () => `<div class="ad-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
    <select class="ad-prod" style="${IN_S}margin:0;flex:1;"><option value="">Select product</option>${svcState.inventory.map((p, n) => `<option value="${n}">${esc(p.product_name)}${p.model_no ? ' (' + esc(p.model_no) + ')' : ''} — ${p.qty} in stock</option>`).join('')}</select>
    <input class="ad-qty" type="number" min="1" value="1" style="${IN_S}margin:0;width:70px;">
    <button type="button" class="ad-rm" style="${B_ICO}">&times;</button></div>`;
  const m = svcModal('Assign Demo Unit', `<label style="font-size:13px;">Technician</label>${techSelectHtml('adTech', '', 'Select technician')}
    <label style="font-size:13px;">Products from stock</label><div id="adRows">${rowHtml()}</div>
    <button type="button" id="adAdd" style="${B_GRY}margin-bottom:10px;">+ Add product</button>
    <label style="font-size:13px;display:block;">Remarks</label><textarea id="adRemarks" rows="2" style="${IN_S}"></textarea>${formFooter('Assign')}`, 520);
  const rows = m.querySelector('#adRows');
  const bindRm = () => rows.querySelectorAll('.ad-rm').forEach(b => b.onclick = () => { if (rows.children.length > 1) b.closest('.ad-row').remove(); });
  bindRm();
  m.querySelector('#adAdd').onclick = () => { rows.insertAdjacentHTML('beforeend', rowHtml()); bindRm(); };
  bindForm(m, async (mm, err) => {
    const tech = mm.querySelector('#adTech').value;
    if (!tech) { err.textContent = 'Select a technician.'; return; }
    const items = [...rows.querySelectorAll('.ad-row')].map(r => {
      const p = svcState.inventory[r.querySelector('.ad-prod').value];
      return p ? { product_id: p.product_id, product_name: p.product_name, model_no: p.model_no, quantity: Number(r.querySelector('.ad-qty').value) || 0 } : null;
    });
    if (!items.length || items.some(x => !x || x.quantity < 1)) { err.textContent = 'Select a product and quantity in every row.'; return; }
    await svcPost('/allocation/assign_demo', { technician_id: tech, items, remarks: mm.querySelector('#adRemarks').value });
    mm.remove();
    await loadDemo();
  });
}

function openRequestDetailS(r) {
  const d = r.details || {};
  if (r.request_type === 'spare_part') {
    svcModal('Spare Part Request', `${dRowS('Raised By', esc(r.raised_by))}${dRowS('Service ID', esc(d.service_id))}
      ${dRowS('Parts needed', esc(sparePartNamesS(r)))}
      ${(d.parts || []).map(p => dRowS(esc(p.part_name || 'Part'), 'Faulty hologram ' + esc(p.old_hologram_number || '-'))).join('')}
      ${dRowS('Status', esc(r.status))}${r.status === 'rejected' && r.reason ? dRowS('Rejection Reason', esc(r.reason)) : ''}${dRowS('Resolved By', esc(r.resolved_by))}
      ${r.status === 'pending' ? '<p style="font-size:12px;color:#64748b;margin-top:10px;">Approve opens the Allocated page with this service and part added — you only choose the hologram number(s).</p>' : ''}`);
    return;
  }
  svcModal('Reschedule Request', `${dRowS('Raised By', esc(r.raised_by))}${dRowS('Item', esc(d.label))}${dRowS('Current Date', d.current_date ? fmtSchedule(d.current_date) : '-')}
    ${dRowS('Requested Date', fmtSchedule(d.requested_date))}${dRowS('Reason', esc(d.reason))}${dRowS('Status', esc(r.status))}
    ${r.status === 'rejected' && r.reason ? dRowS('Rejection Reason', esc(r.reason)) : ''}${dRowS('Resolved By', esc(r.resolved_by))}`);
}

// parts a technician asked for (structured list, or the plain note for older requests)
function sparePartNamesS(r) {
  const d = r.details || {};
  const names = (d.parts || []).map(p => p.part_name).filter(Boolean);
  return names.length ? names.join(', ') : (d.note || '');
}

async function approveReschedule(r) {
  try {
    const out = await svcPost(`/request/approve/${encodeURIComponent(r.request_id)}`, {});
    // spare part: go to the Allocated page with this service + the requested part(s) already added
    if (out && out.pending_allocation && out.redirect) { window.location.href = out.redirect; return; }
    await Promise.all([loadRequests(), loadServices(), loadInstallations()]);
  } catch (e) { if (e.message !== 'unauthorized' && e.message !== 'forbidden') alert(e.message); }
}

function openRejectReschedule(r) {
  const m = svcModal('Reject Request', `<p style="font-size:13px;color:var(--text-light);">${esc((r.details || {}).label)} — requested by ${esc(r.raised_by)}</p>
    <label style="font-size:13px;">Reason (shown to the technician)</label><textarea id="rjReason" rows="3" style="${IN_S}"></textarea>${formFooter('Reject')}`);
  bindForm(m, async (mm, err) => {
    const reason = mm.querySelector('#rjReason').value.trim();
    if (!reason) { err.textContent = 'Write a reason.'; return; }
    await svcPost(`/request/reject/${encodeURIComponent(r.request_id)}`, { reason });
    mm.remove();
    await loadRequests();
  });
}

function wireTopActions() { }