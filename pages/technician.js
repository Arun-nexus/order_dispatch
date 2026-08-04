const techState = { services: [], allocations: [] };
let techPage = 1;
const TECH_PAGE_SIZE = 7;

function renderTablePagination(container, page, totalPages, onChange) {
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = `<button class="page-btn" data-page="prev"><i class="fa-solid fa-angle-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="page${i === page ? ' active-page' : ''}" data-page="${i}">${i}</button>`;
  }
  html += `<button class="page-btn" data-page="next"><i class="fa-solid fa-angle-right"></i></button>`;
  container.innerHTML = html;
  container.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => {
    const d = btn.dataset.page;
    if (d === 'prev') onChange(Math.max(1, page - 1));
    else if (d === 'next') onChange(Math.min(totalPages, page + 1));
    else onChange(Number(d));
  }));
}

document.addEventListener('DOMContentLoaded', () => {
  loadMyServices();
  loadMyRequests();
  wireFilter();
  wireStaticModals();
});

window.refreshCurrentPageData = () => { loadMyServices(); loadMyRequests(); };

async function loadMyRequests() {
  try {
    const res = await apiFetch('/request/mine');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    renderMyRequests((data.dataset || []).filter(r => r.request_type === 'spare_part' || r.request_type === 'status_update'));
  } catch (err) {
    console.error(err);
  }
}

function requestStatusClass(status) {
  if (status === 'approved') return 'delivered';
  if (status === 'rejected') return 'cancelled';
  return 'pending';
}

function renderMyRequests(requests) {
  const box = document.getElementById('myRequestsList');
  if (!box) return;
  const sorted = [...requests].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  box.innerHTML = sorted.length ? sorted.map(r => {
    const isStatusReq = r.request_type === 'status_update';
    const label = isStatusReq
      ? `Change status to "${(r.details?.service_status || '').replace('_', ' ')}"`
      : (r.details?.note ?? '');
    return `
    <div class="order-item">
      <div class="order-left">
        <div class="order-icon"><i class="fa-solid fa-gears"></i></div>
        <div>
          <h4>Service #${(r.details?.service_id || '').slice(0, 8)}</h4>
          <p>${label}${r.status === 'rejected' && r.reason ? ' — ' + r.reason : ''}</p>
        </div>
      </div>
      <span class="status ${requestStatusClass(r.status)}">${r.status}</span>
    </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">No spare part requests yet.</p>';
}

async function loadMyServices() {
  try {
    const [svcRes, allocRes] = await Promise.all([
      apiFetch('/service/my'),
      apiFetch('/allocation/')
    ]);
    const svcData = await svcRes.json();
    const allocData = await allocRes.json();
    if (!svcRes.ok) throw new Error('failed to fetch services');

    techState.services = svcData.dataset || [];
    techState.allocations = allocData.dataset || [];

    techPage = 1;
    renderCards();
    renderTable(techState.services);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your services.');
  }
}

function myServiceIds() {
  return new Set(techState.services.map(s => s.service_id));
}

function mySparePartAllocations() {
  const ids = myServiceIds();
  return techState.allocations.filter(a => a.allocation_type === 'spare_part' && ids.has(a.spare_part?.service_id));
}

function isOverdue(a) {
  if (a.return_status === 'returned') return false;
  return new Date(a.return_due_date) - new Date() <= 0;
}

function renderCards() {
  const services = techState.services;
  const parts = mySparePartAllocations();

  document.getElementById('cardTotal').textContent = services.length;
  document.getElementById('cardActive').textContent = services.filter(s => s.status === 'active').length;
  document.getElementById('cardCompleted').textContent = services.filter(s => s.status === 'completed').length;
  document.getElementById('cardRejected').textContent = services.filter(s => s.status === 'rejected').length;

  const today = new Date().toDateString();
  const earnedToday = services
    .filter(s => s.status === 'completed' && s.purchase_date && new Date(s.purchase_date).toDateString() === today)
    .reduce((sum, s) => sum + (Number(s.service_charges) || 0), 0);

  const totalServiceCost = services
    .filter(s => s.status === 'completed')
    .reduce((sum, s) => sum + (Number(s.service_charges) || 0), 0);
  document.getElementById('cardServiceCost').textContent = `₹${totalServiceCost.toFixed(2)}`;

}

function statusBadgeClass(status) {
  if (status === 'completed') return 'high';
  if (status === 'in_progress') return 'medium';
  if (status === 'rejected') return 'low';
  return 'medium';
}

function renderTable(services) {
  // Newest services first; fall back to reversing the raw (ascending) API
  // order if no date field is present.
  const hasDates = services.some(s => s.purchase_date || s.created_at);
  const sorted = hasDates
    ? [...services].sort((a, b) => new Date(b.purchase_date || b.created_at || 0) - new Date(a.purchase_date || a.created_at || 0))
    : [...services].reverse();

  const totalPages = Math.max(1, Math.ceil(sorted.length / TECH_PAGE_SIZE));
  techPage = Math.min(Math.max(1, techPage), totalPages);
  const start = (techPage - 1) * TECH_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + TECH_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  pageRows.forEach(s => {
    const tr = document.createElement('tr');
    tr.dataset.id = s.service_id;
    tr.innerHTML = `
      <td>${s.service_id?.slice(0, 8) ?? ''}</td>
      <td>${s.product_id ?? ''}</td>
      <td>${s.serial_no ?? ''}</td>
      <td>${s.issue ?? ''}</td>
      <td>${s.location ?? ''}</td>
      <td><span class="stock ${statusBadgeClass(s.status)}">${s.status ?? ''}</span></td>
      <td>${s.service_charges != null ? '₹' + s.service_charges : 'Not set'}</td>
      <td>${s.warranty_until ?? '-'}</td>
      <td>
        <button class="icon-btn view-btn" title="View"><i class="fa-solid fa-eye"></i></button>
        <button class="icon-btn img-btn" title="Upload Image"><i class="fa-solid fa-image"></i></button>
        <button class="icon-btn vid-btn" title="Upload Video"><i class="fa-solid fa-video"></i></button>
        <button class="icon-btn spare-btn" title="Request Spare Part"><i class="fa-solid fa-gears"></i></button>
        <button class="icon-btn status-btn" title="Update Status"><i class="fa-solid fa-pen"></i></button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', e => openViewModal(rowService(e))));
  tbody.querySelectorAll('.img-btn').forEach(b => b.addEventListener('click', e => openUploadModal(rowService(e), 'image')));
  tbody.querySelectorAll('.vid-btn').forEach(b => b.addEventListener('click', e => openUploadModal(rowService(e), 'video')));
  tbody.querySelectorAll('.spare-btn').forEach(b => b.addEventListener('click', e => openSparePartModal(rowService(e))));
  tbody.querySelectorAll('.status-btn').forEach(b => b.addEventListener('click', e => openStatusModal(rowService(e))));

  renderTablePagination(document.querySelector('.pagination'), techPage, totalPages, p => {
    techPage = p;
    renderTable(services);
  });
}

function rowService(e) {
  const tr = e.target.closest('tr');
  return techState.services.find(s => s.service_id === tr.dataset.id);
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const status = document.getElementById('statusFilter').value;
    const filtered = status && status !== 'All Status'
      ? techState.services.filter(s => s.status === status)
      : techState.services;
    techPage = 1;
    renderTable(filtered);
  });
}

// ---------- View modal ----------
function openViewModal(s) {
  if (!s) return;
  const modal = document.getElementById('viewModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Service Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Service ID</small><p>${s.service_id ?? ''}</p></div>
    <div class="detail"><small>Product ID</small><p>${s.product_id ?? ''}</p></div>
    <div class="detail"><small>Serial No.</small><p>${s.serial_no ?? ''}</p></div>
    <div class="detail"><small>Purchase Date</small><p>${s.purchase_date ?? ''}</p></div>
    <div class="detail"><small>Issue</small><p>${s.issue ?? ''}</p></div>
    <div class="detail"><small>Spare Parts Used</small><p>${s.spare_parts || '-'}</p></div>
    <div class="detail"><small>Spare Part Requested</small><p>${s.spare_parts_requested || '-'}</p></div>
    <div class="detail"><small>Service Charges</small><p>${s.service_charges != null ? '₹' + s.service_charges : 'Not set by admin/employee yet'}</p></div>
    <div style="display:flex;gap:10px;margin-top:10px;">
      ${s.image ? '<button id="viewImgBtn" style="padding:8px 12px;border:none;border-radius:8px;background:#eee;cursor:pointer;">View Image</button>' : ''}
      ${s.video ? '<button id="viewVidBtn" style="padding:8px 12px;border:none;border-radius:8px;background:#eee;cursor:pointer;">View Video</button>' : ''}
    </div>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  const imgBtn = content.querySelector('#viewImgBtn');
  const vidBtn = content.querySelector('#viewVidBtn');
  if (imgBtn) imgBtn.addEventListener('click', () => showMedia('image', s.image));
  if (vidBtn) vidBtn.addEventListener('click', () => showMedia('video', s.video));
  modal.style.display = 'flex';
}

function showMedia(type, src) {
  const modal = document.getElementById('mediaModal');
  const img = modal.querySelector('img');
  const vid = modal.querySelector('video');
  if (type === 'image') {
    img.src = src; img.style.display = 'block';
    vid.style.display = 'none'; vid.pause();
  } else {
    vid.src = src; vid.style.display = 'block';
    img.style.display = 'none';
  }
  modal.style.display = 'flex';
}

function wireStaticModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));
}

// ---------- Upload image/video modal ----------
function openUploadModal(s, kind) {
  if (!s) return;
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Upload ${kind === 'image' ? 'Image' : 'Video'}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="uploadForm" style="display:flex;flex-direction:column;gap:10px;">
      <input type="file" name="file" accept="${kind === 'image' ? 'image/*' : 'video/*'}" required>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Upload</button>
      </div>
    </form>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  content.querySelector('#uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    const file = e.target.file.files[0];
    if (!file) return;

    const maxBytes = kind === 'image' ? 2 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > maxBytes) {
      showResponseModal(
        'File too large',
        `${kind === 'image' ? 'Image' : 'Video'} is ${(file.size / 1024 / 1024).toFixed(1)}MB — must be ${kind === 'image' ? '2MB' : '20MB'} or under.`,
        false
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const payload = kind === 'image' ? { image: reader.result } : { video: reader.result };
      try {
        const res = await apiFetch(`/service/upload_media/${s.service_id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'upload failed');
        modal.style.display = 'none';
        if (kind === 'video') {
          showResponseModal('Video uploaded', 'Admin/employee have been notified to review and download this video.', true);
        }
        await loadMyServices();
      } catch (err) {
        if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
      }
    };
    reader.readAsDataURL(file);
  });
  modal.style.display = 'flex';
}

// ---------- Request spare part modal ----------
function openSparePartModal(s) {
  if (!s) return;
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Request Spare Part</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="color:#64748b;font-size:13px;margin-bottom:10px;">Your admin/employee will see this request and allocate the part from Allocated page.</p>
    <form id="spareForm" style="display:flex;flex-direction:column;gap:10px;">
      <textarea name="note" placeholder="Spare part name / details needed" style="min-height:70px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>${s.spare_parts_requested || ''}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Send Request</button>
      </div>
    </form>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('#spareForm').addEventListener('submit', async e => {
    e.preventDefault();
    const note = e.target.note.value.trim();
    try {
      const res = await apiFetch(`/service/request_spare_part/${s.service_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      modal.style.display = 'none';
      await loadMyServices();
      await loadMyRequests();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}

// ---------- Update status modal ----------
function openStatusModal(s) {
  if (!s) return;
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Update Service Status</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="statusForm" style="display:flex;flex-direction:column;gap:10px;">
      <select name="service_status" required>
        <option value="">Select Status</option>
        <option value="active">Active</option>
        <option value="in_progress">In Progress</option>
        <option value="completed">Completed</option>
        <option value="rejected">Rejected</option>
      </select>
      <textarea name="reason" placeholder="Reason (required if Rejected)" style="min-height:60px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;"></textarea>
      <textarea name="spare_parts" placeholder="Spare part used (required if Completed)" style="min-height:60px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">${s.spare_parts || ''}</textarea>
      <label style="font-size:13px;color:#64748b;"><input type="checkbox" name="spare_parts_used"> Spare parts were used for this repair</label>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Update</button>
      </div>
    </form>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  content.querySelector('#statusForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      service_status: fd.get('service_status'),
      reason: fd.get('reason') || '',
      spare_parts: fd.get('spare_parts') || '',
      spare_parts_used: fd.get('spare_parts_used') === 'on'
    };
    try {
      const res = await apiFetch(`/service/request_status_update/${s.service_id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      modal.style.display = 'none';
      showResponseModal('Status update requested', 'Your status change has been sent to admin/employee for approval.', true);
      await loadMyServices();
      await loadMyRequests();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
  modal.style.display = 'flex';
}