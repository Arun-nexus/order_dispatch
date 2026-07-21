const svcState = { services: [], activeServiceId: null };

document.addEventListener('DOMContentLoaded', () => {
  patchMarkupBugs();
  loadServices();
  wireTopActions();
  wireFilters();
  wireModals();
});

function patchMarkupBugs() {
  document.querySelectorAll('[id]').forEach(el => {
    if (el.id !== el.id.trim()) el.id = el.id.trim();
  });
  document.querySelectorAll('.model').forEach(el => el.classList.add('modal'));
  document.querySelectorAll('.model-content').forEach(el => el.classList.add('modal-content'));
  document.querySelectorAll('.model-header').forEach(el => el.classList.add('modal-header'));
  document.querySelectorAll('.model-footer').forEach(el => el.classList.add('modal-footer'));
}

async function loadServices() {
  try {
    const res = await fetch('/service/');
    if (!res.ok) throw new Error('failed to fetch services');
    const data = await res.json();
    svcState.services = data.dataset || [];
    renderServiceTable(svcState.services);
    updateCards(svcState.services);
  } catch (err) {
    console.error(err);
    alert('Could not load service data.');
  }
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
      <td><span class="${statusBadge(s.status)}">${(s.status ?? '').replace('_', ' ')}</span></td>
      <td>${returnCell}</td>
      <td>${actionsHtml}</td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.location-btn').forEach(btn =>
    btn.addEventListener('click', e => alert('Technician location tracking is not yet implemented on the backend.')));
  tbody.querySelectorAll('.image-btn').forEach(btn => btn.addEventListener('click', e => openImageModal(rowService(e))));
  tbody.querySelectorAll('.ellipsis-btn').forEach(btn => btn.addEventListener('click', e => openActionMenu(rowService(e))));
  tbody.querySelectorAll('.reason-btn').forEach(btn => btn.addEventListener('click', e => openReasonModal(rowService(e))));
}

function rowService(e) {
  const tr = e.target.closest('tr');
  return svcState.services.find(s => s.service_id === tr.dataset.serviceId);
}

function openActionMenu(s) {
  if (!s) return;
  // Simple menu: view details or update status.
  const choice = confirm('OK = View Details, Cancel = Update Status');
  if (choice) openViewModal(s); else openStatusModal(s);
}

function openViewModal(s) {
  const modal = document.getElementById('viewModal');
  if (!modal) return;
  const values = modal.querySelectorAll('.detail p, .details p');
  const fields = [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.purchase_date, s.issue, s.spare_parts || 'None'];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
  modal.style.display = 'flex';
}

function openImageModal(s) {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  const img = modal.querySelector('img');
  if (img && s.image) img.src = s.image;
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

function wireTopActions() {
  const newServiceBtn = document.querySelector('.new-service');
  if (newServiceBtn) newServiceBtn.addEventListener('click', openCreateModal);

  const exportBtn = document.querySelector('.export');
  if (exportBtn) exportBtn.addEventListener('click', exportServicesCSV);
}

function exportServicesCSV() {
  const header = ['Service ID', 'Product ID', 'Serial No', 'Technician', 'Issue', 'Status'];
  const rows = svcState.services.map(s => [s.service_id, s.product_id, s.serial_no, s.technician_alloted, s.issue, s.status]);
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
function openCreateModal() {
  let modal = document.getElementById('createServiceModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'createServiceModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1000;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:26px;width:460px;">
        <h2 style="margin-bottom:18px;">New Service Request</h2>
        <form id="createServiceForm" style="display:flex;flex-direction:column;gap:12px;">
          <input name="product_id" placeholder="Product ID" required>
          <input name="serial_no" placeholder="Serial No" required>
          <input name="technician_id" placeholder="Technician ID" required>
          <input name="purchase_date" type="date" required>
          <textarea name="issue" placeholder="Issue description" required style="min-height:80px;"></textarea>
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
      try {
        const res = await fetch('/services/create', {
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
        alert(err.message);
      }
    });
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
      const reasonBox = statusForm.querySelector('textarea');

      const statusMap = { 'Active': 'active', 'In Progress': 'in_progress', 'Completed': 'completed', 'Rejected': 'rejected' };
      const service_status = statusMap[select.value] || select.value.toLowerCase().replace(' ', '_');

      const payload = {
        service_status,
        reason: reasonBox ? reasonBox.value : '',
        spare_parts_used: false
      };

      try {
        const res = await fetch(`/service/update/${svcState.activeServiceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'status update failed');
        document.getElementById('statusModal').style.display = 'none';
        await loadServices();
      } catch (err) {
        alert(err.message);
      }
    });
  }
}
