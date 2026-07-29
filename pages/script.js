const svcState = { services: [], orders: [], activeServiceId: null, technicians: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadServices();
  wireTopActions();
  wireFilters();
  wireModals();
});

async function loadServices() {
  try {
    const [svcRes, orderRes] = await Promise.all([
      apiFetch('/service/'),
      apiFetch('/order/')
    ]);
    if (!svcRes.ok) throw new Error('failed to fetch services');
    const svcData = await svcRes.json();
    const orderData = orderRes.ok ? await orderRes.json() : { dataset: [] };

    svcState.services = svcData.dataset || [];
    svcState.orders = orderData.dataset || [];
    renderServiceTable(svcState.services);
    updateCards(svcState.services);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load service data.');
    }
  }
}

async function loadTechnicians() {
  try {
    const res = await apiFetch('/account/technicians');
    if (!res.ok) throw new Error('failed to fetch technicians');
    const data = await res.json();
    svcState.technicians = data.dataset || [];
  } catch (err) {
    console.error(err);
    svcState.technicians = [];
  }
  return svcState.technicians;
}

function updateCards(services) {
  const values = document.querySelectorAll('.cards .card h2');
  if (!values.length) return;
  values[0].textContent = services.length;
  values[1].textContent = services.filter(s => s.status === 'active').length;
  values[2].textContent = services.filter(s => s.status === 'in_progress').length;
  values[3].textContent = services.filter(s => s.status === 'completed').length;
  values[4].textContent = services.filter(s => s.status === 'rejected').length;
}

function statusBadge(status) {
  const map = { active: 'pending', in_progress: 'progress', completed: 'completed', rejected: 'rejected' };
  return map[status] || 'pending';
}

// finds the order this service's product belongs to (matches serial_no first, falls back to product_id)
function findOrderForService(s) {
  return svcState.orders.find(o => s.serial_no && o.serial_no === s.serial_no)
      || svcState.orders.find(o => o.product_id === s.product_id);
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
        <button class="icon-btn location-btn"><i class="fa-solid fa-location-dot"></i></button>
        <button class="icon-btn image-btn"><i class="fa-solid fa-image"></i></button>
        <button class="icon-btn ellipsis-btn"><i class="fa-solid fa-ellipsis"></i></button>`;
    }

    const returnCell = s.status === 'rejected'
      ? '-'
      : `<span class="${s.manager_confirmed_return ? 'confirmed' : 'pending'}">${s.manager_confirmed_return ? 'Confirmed' : 'Pending'}</span>`;

    tr.innerHTML = `
      <td>#${s.service_id?.slice(0, 8) ?? ''}</td>
      <td>${s.product_id ?? ''}</td>
      <td>${s.serial_no ?? ''}</td>
      <td><div class="tech">${s.technician_alloted ?? ''}</div></td>
      <td>${s.issue ?? ''}</td>
      <td>${(s.location || 'indoor').charAt(0).toUpperCase() + (s.location || 'indoor').slice(1)}</td>
      <td>${warrantyCellHtml(s)}</td>
      <td><span class="${statusBadge(s.status)}">${(s.status ?? '').replace('_', ' ')}</span></td>
      <td>${returnCell}</td>
      <td>${actionsHtml}</td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.location-btn').forEach(btn =>
    btn.addEventListener('click', e => alert('Technician location tracking is not yet implemented on the backend.')));
  tbody.querySelectorAll('.image-btn').forEach(btn => btn.addEventListener('click', e => openImageModal(rowService(e))));
  tbody.querySelectorAll('.ellipsis-btn').forEach(btn => btn.addEventListener('click', e => openActionMenu(rowService(e), e)));
  tbody.querySelectorAll('.reason-btn').forEach(btn => btn.addEventListener('click', e => openReasonModal(rowService(e))));
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
  menu.style.cssText = 'position:absolute;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1200;min-width:200px;';
  const rect = evt.target.closest('button').getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(10, rect.left - 150)}px`;

  const items = [
    { label: 'View Details', action: () => openViewModal(s) },
    { label: 'Update Status', action: () => openStatusModal(s) },
  ];
  if (canManage) {
    items.push({ label: 'Manager Confirm Return', action: () => managerConfirmReturn(s.service_id) });
    items.push({ label: 'Extend Warranty', action: () => extendWarranty(s.service_id) });
  }

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;border-radius:6px;cursor:pointer;font-size:14px;';
    btn.onmouseenter = () => btn.style.background = '#f1f5f9';
    btn.onmouseleave = () => btn.style.background = 'none';
    btn.addEventListener('click', () => { closeActionMenu(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
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
  const fields = [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.purchase_date, s.issue, s.spare_parts || 'None'];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
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

function wireTopActions() {
  const newServiceBtn = document.querySelector('.new-service');
  if (newServiceBtn) newServiceBtn.addEventListener('click', openCreateModal);

  const exportBtn = document.querySelector('.export');
  if (exportBtn) exportBtn.addEventListener('click', exportServicesCSV);
}

function exportServicesCSV() {
  const header = ['Service ID', 'Product ID', 'Serial No', 'Technician', 'Issue', 'Location', 'Status'];
  const rows = svcState.services.map(s => [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.issue, s.location, s.status]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'services.csv';
  a.click();
}

function wireFilters() {
  const filterBtn = document.querySelector('.filter-btn');
  if (!filterBtn) return;
  filterBtn.addEventListener('click', () => {
    const selects = document.querySelectorAll('.filter-box select');
    const dateInput = document.querySelector('.filter-box input[type="date"]');
    const status = selects[0]?.value?.toLowerCase().replace('-', '_');
    const technician = selects[1]?.value;
    const date = dateInput?.value;

    const filtered = svcState.services.filter(s =>
      (!status || status === 'status' || s.status === status) &&
      (!technician || technician === 'Technician' || s.technician_alloted === technician) &&
      (!date || s.purchase_date === date)
    );
    renderServiceTable(filtered);
  });
}

// --- Create Service modal (injected: service.html ships a "new-service"
// button but no matching modal markup) ---
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
          <input name="product_id" placeholder="Product" required>
          <select name="location" required>
            <option value="indoor">Inhouse</option>
            <option value="outdoor">Field</option>
          </select>
          <input name="serial_no" placeholder="Serial No" required>
          <select name="technician_id" id="technicianSelect" required>
            <option value="">Select Technician</option>
          </select>
          <input name="purchase_date" type="date" required>
          <textarea name="issue" placeholder="Issue description" required style="min-height:80px;"></textarea>
          <textarea name="spare_parts" placeholder="Spare parts requested (optional)" style="min-height:50px;"></textarea>
          <input name="image" placeholder="Image URL (optional)">
          <input name="video" placeholder="Video URL (optional)">
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" id="cancelCreateService" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
            <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Create</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#cancelCreateService').addEventListener('click', () => modal.style.display = 'none');
    modal.querySelector('#createServiceForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());

      // outdoor services must reference a serial number that actually exists in Orders
      if (payload.location === 'outdoor') {
        const matchInOrders = svcState.orders.some(o => o.serial_no === payload.serial_no);
        if (!matchInOrders) {
          alert('This Serial No. was not found in Orders. Outdoor services must match an existing order.');
          return;
        }
      }

      try {
        const res = await apiFetch('/services/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'service creation failed');
        modal.style.display = 'none';
        e.target.reset();
        await loadServices();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    });
  }

  // refresh the technician dropdown every time the modal opens, so it always
  // reflects current usernames from Users → technician accounts
  const select = modal.querySelector('#technicianSelect');
  select.innerHTML = '<option value="">Loading technicians...</option>';
  const technicians = await loadTechnicians();
  if (!technicians.length) {
    select.innerHTML = '<option value="">No technicians found — add one from Users</option>';
  } else {
    select.innerHTML = '<option value="">Select Technician</option>' +
      technicians.map(t => `<option value="${t.username}">${t.username}${t.name ? ' — ' + t.name : ''}</option>`).join('');
  }

  modal.style.display = 'flex';
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const statusForm = document.querySelector('#statusModal form');
  if (statusForm) {
    statusForm.addEventListener('submit', async e => {
      e.preventDefault();
      const select = statusForm.querySelector('select');
      const textareas = statusForm.querySelectorAll('textarea');
      const reasonBox = textareas[0];
      const sparePartsBox = textareas[1];

      const statusMap = { 'Active': 'active', 'In Progress': 'in_progress', 'Completed': 'completed', 'Rejected': 'rejected' };
      const service_status = statusMap[select.value] || select.value.toLowerCase().replace(' ', '_');

      if (service_status === 'completed' && !sparePartsBox.value.trim()) {
        alert('Spare part used must be written before marking the service as Completed.');
        return;
      }
      if (service_status === 'rejected' && !reasonBox.value.trim()) {
        alert('Reason must be provided before rejecting a service.');
        return;
      }

      const payload = {
        service_status,
        reason: reasonBox ? reasonBox.value : '',
        spare_parts: sparePartsBox ? sparePartsBox.value : '',
        spare_parts_used: false
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
        await loadServices();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    });
  }
}