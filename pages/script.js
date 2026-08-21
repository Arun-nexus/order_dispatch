const svcState = { services: [], orders: [], activeServiceId: null, technicians: [] };

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadServices();
  wireTopActions();
  wireFilters();
  wireModals();
  wireHeaderSearch();
  populateTechnicianFilter();
});

function wireHeaderSearch() {
  const input = document.querySelector('.search input');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { renderServiceTable(svcState.services); return; }
    const filtered = svcState.services.filter(s =>
      (s.serial_no || '').toLowerCase().includes(q) ||
      (s.product_id || '').toLowerCase().includes(q) ||
      (s.product_name || '').toLowerCase().includes(q) ||
      (s.service_id || '').toLowerCase().includes(q)
    );
    renderServiceTable(filtered);
  });
}

async function populateTechnicianFilter() {
  const select = document.querySelectorAll('.filter-box select')[1];
  if (!select) return;
  const { technicians, distributors } = await loadTechnicians();
  const current = select.value;
  let html = '<option value="">Technician</option>';
  if (technicians.length) {
    html += '<optgroup label="Technicians">' +
      technicians.map(t => `<option value="${t.username}">${t.username}${t.name ? ' — ' + t.name : ''}</option>`).join('') +
      '</optgroup>';
  }
  if (distributors.length) {
    html += '<optgroup label="Distributors">' +
      distributors.map(d => `<option value="${d.username}">${d.username}${d.name ? ' — ' + d.name : ''}</option>`).join('') +
      '</optgroup>';
  }
  select.innerHTML = html;
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
    const [techRes, distRes] = await Promise.all([
      apiFetch('/account/technicians'),
      apiFetch('/account/distributors')
    ]);
    const techData = techRes.ok ? await techRes.json() : { dataset: [] };
    const distData = distRes.ok ? await distRes.json() : { dataset: [] };
    svcState.technicians = techData.dataset || [];
    svcState.distributors = distData.dataset || [];
  } catch (err) {
    console.error(err);
    svcState.technicians = [];
    svcState.distributors = [];
  }
  return { technicians: svcState.technicians, distributors: svcState.distributors };
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

// finds the order this service's product belongs to by searching each order's
// line items (orders store items[].serial_numbers, not a top-level serial_no)
function findOrderForService(s) {
  if (!s.serial_no) return svcState.orders.find(o => (o.items || []).some(it => it.product_id === s.product_id));
  return svcState.orders.find(o => (o.items || []).some(it => (it.serial_numbers || []).includes(s.serial_no)))
      || svcState.orders.find(o => (o.items || []).some(it => it.product_id === s.product_id));
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
  menu.style.cssText = 'position:fixed;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1200;min-width:200px;visibility:hidden;';
  const rect = evt.target.closest('button').getBoundingClientRect();

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
  const fields = [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.purchase_date, s.issue, s.spare_parts || 'None', s.service_charges != null ? `₹${s.service_charges}` : 'Not set'];
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
  openExportWizard({
    title: 'Export Services',
    statusOptions: ['active', 'in_progress', 'completed', 'rejected'],
    dateField: 'purchase_date',
    dateLabel: 'Purchase Date',
    getRows: () => svcState.services,
    onConfirm: (rows) => {
      const header = ['Service ID', 'Product ID', 'Serial No', 'Technician', 'Issue', 'Location', 'Status'];
      const csvRows = rows.map(s => [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.issue, s.location, s.status]);
      downloadCSV(header, csvRows, 'services.csv');
    }
  });
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function downloadCSV(header, rows, filename) {
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
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
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:#64748b;">Status</label>
        <select name="status" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

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
          <label style="font-size:12px;color:#64748b;">Image proof (optional, max 2MB)</label>
          <input type="file" name="image_file" accept="image/*">
          <label style="font-size:12px;color:#64748b;">Video proof (optional, max 20MB)</label>
          <input type="file" name="video_file" accept="video/*">
          <p id="createServiceMediaError" style="color:#d62828;font-size:12px;display:none;"></p>
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
      const form = e.target;
      const fd = new FormData(form);
      const errorBox = document.getElementById('createServiceMediaError');
      errorBox.style.display = 'none';

      const imageFile = form.querySelector('[name="image_file"]').files[0];
      const videoFile = form.querySelector('[name="video_file"]').files[0];

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
        product_id: fd.get('product_id'),
        location: fd.get('location'),
        serial_no: (fd.get('serial_no') || '').trim().toLowerCase(),
        technician_id: fd.get('technician_id'),
        purchase_date: fd.get('purchase_date'),
        issue: fd.get('issue'),
        spare_parts: fd.get('spare_parts') || ''
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
  const { technicians, distributors } = await loadTechnicians();

  if (!technicians.length && !distributors.length) {
    select.innerHTML = '<option value="">No technicians/distributors found — add one from Users</option>';
  } else {
    let html = '<option value="">Select Technician/Distributor</option>';
    if (technicians.length) {
      html += '<optgroup label="Technicians">' +
        technicians.map(t => `<option value="${t.username}">${t.username}${t.name ? ' — ' + t.name : ''}</option>`).join('') +
        '</optgroup>';
    }
    if (distributors.length) {
      html += '<optgroup label="Distributors">' +
        distributors.map(d => `<option value="${d.username}">${d.username}${d.name ? ' — ' + d.name : ''}</option>`).join('') +
        '</optgroup>';
    }
    select.innerHTML = html;
  }

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
        <input type="text" class="part-name-input" placeholder="Part name" style="flex:1;">
        <input type="text" class="part-old-hologram-input" placeholder="Old hologram no." style="flex:1;">
        <input type="text" class="part-new-hologram-input" placeholder="New hologram no." style="flex:1;">
        <button type="button" class="remove-part-btn" style="border:none;background:#eee;border-radius:6px;padding:8px 10px;cursor:pointer;">&times;</button>
      </div>`;

    const addPartRow = () => {
      partsList.insertAdjacentHTML('beforeend', partRowHtml());
      partsList.lastElementChild.querySelector('.remove-part-btn').addEventListener('click', e => {
        e.target.closest('.part-row').remove();
      });
    };
    addPartBtn.addEventListener('click', addPartRow);

    const renderSpareUsed = () => {
      spareBtns.forEach(b => {
        const active = (b.dataset.used === 'true') === spareUsed;
        b.style.background = active ? '#1665ff' : '#fff';
        b.style.color = active ? '#fff' : '#1665ff';
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
          part_name: row.querySelector('.part-name-input').value.trim(),
          old_hologram_number: row.querySelector('.part-old-hologram-input').value.trim(),
          new_hologram_number: row.querySelector('.part-new-hologram-input').value.trim()
        }));
        if (service_status === 'completed') {
          if (!parts_used.length || parts_used.some(p => !p.part_name || !p.old_hologram_number || !p.new_hologram_number)) {
            alert('Every spare part needs a name, its old hologram number and its new hologram number.');
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