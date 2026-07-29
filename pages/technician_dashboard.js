const techDashState = { services: [], allocations: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadTechDashboard();
  setTodayDate();
});

function setTodayDate() {
  const dateBox = document.querySelector('.date-box span');
  if (!dateBox) return;
  const today = new Date();
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  dateBox.textContent = today.toLocaleDateString('en-GB', options).replace(/ /g, ' ');
}

async function loadTechDashboard() {
  try {
    const [svcRes, allocRes] = await Promise.all([
      apiFetch('/service/my'),
      apiFetch('/allocation/')
    ]);
    const svcData = await svcRes.json();
    const allocData = await allocRes.json();
    if (!svcRes.ok) throw new Error('failed to fetch services');

    techDashState.services = svcData.dataset || [];
    techDashState.allocations = allocData.dataset || [];

    renderCards();
    renderStatusBreakdown();
    renderRecentServices();
    renderSpareParts();
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your dashboard.');
  }
}

function isThisMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function monthServices() {
  return techDashState.services.filter(s => isThisMonth(s.purchase_date));
}

function myServiceIds() {
  return new Set(techDashState.services.map(s => s.service_id));
}

function mySparePartAllocations() {
  const ids = myServiceIds();
  return techDashState.allocations.filter(a => a.allocation_type === 'spare_part' && ids.has(a.spare_part?.service_id));
}

function isOverdue(a) {
  if (a.return_status === 'returned') return false;
  return new Date(a.return_due_date) - new Date() <= 0;
}

function renderCards() {
  const month = monthServices();
  const completed = month.filter(s => s.status === 'completed');
  const pending = month.filter(s => s.status === 'active' || s.status === 'in_progress');
  const rejected = month.filter(s => s.status === 'rejected');
  const revenue = completed.reduce((sum, s) => sum + (Number(s.service_charges) || 0), 0);
  const partsUsed = techDashState.services.filter(s => s.spare_parts_used || s.spare_parts).length;
  const partsOverdue = mySparePartAllocations().filter(isOverdue).length;

  document.getElementById('cardTotalMonth').textContent = month.length;
  document.getElementById('cardCompleted').textContent = completed.length;
  document.getElementById('cardPending').textContent = pending.length;
  document.getElementById('cardRejected').textContent = rejected.length;
  document.getElementById('cardRevenue').textContent = `₹${revenue.toFixed(2)}`;
  document.getElementById('cardPartsUsed').textContent = partsUsed;
  document.getElementById('cardPartsOverdue').textContent = partsOverdue;
}

function renderStatusBreakdown() {
  const month = monthServices();
  const total = month.length || 1;
  const completed = month.filter(s => s.status === 'completed').length;
  const pending = month.filter(s => s.status === 'active' || s.status === 'in_progress').length;
  const rejected = month.filter(s => s.status === 'rejected').length;

  const items = document.querySelectorAll('.inventory-status .inventory-item');
  const counts = [completed, pending, rejected];
  items.forEach((item, i) => {
    const pct = Math.round((counts[i] / total) * 100);
    item.querySelector('.inventory-head strong').textContent = counts[i];
    item.querySelector('.progress-fill').style.width = `${pct}%`;
    item.querySelector('small').textContent = `${pct}%`;
  });
}

function statusMap(status) {
  const map = { active: 'pending', in_progress: 'processing', completed: 'delivered', rejected: 'cancelled' };
  return map[status] || 'pending';
}

function renderRecentServices() {
  const container = document.getElementById('recentServiceList');
  if (!container) return;
  container.innerHTML = '';

  const recent = [...techDashState.services]
    .sort((a, b) => new Date(b.purchase_date || 0) - new Date(a.purchase_date || 0))
    .slice(0, 5);

  recent.forEach(s => {
    const div = document.createElement('div');
    div.className = 'order-item';
    div.innerHTML = `
      <div class="order-left">
        <div class="order-icon"><i class="fa-solid fa-file-medical"></i></div>
        <div>
          <h4>${s.service_id?.slice(0, 8) ?? ''}</h4>
          <p>${s.purchase_date ? new Date(s.purchase_date).toLocaleDateString() : ''}</p>
        </div>
      </div>
      <span class="status ${statusMap(s.status)}">${s.status ?? ''}</span>
      <strong>${s.service_charges != null ? '₹' + s.service_charges : '-'}</strong>`;
    container.appendChild(div);
  });
}

function renderSpareParts() {
  const container = document.getElementById('sparePartList');
  if (!container) return;
  container.innerHTML = '';

  const parts = mySparePartAllocations().slice(0, 4);
  parts.forEach(a => {
    const overdue = isOverdue(a);
    const label = a.return_status === 'returned' ? 'delivered' : overdue ? 'cancelled' : 'processing';
    const text = a.return_status === 'returned' ? 'Returned' : overdue ? 'Overdue' : 'Held';
    const div = document.createElement('div');
    div.className = 'service-item';
    div.innerHTML = `
      <div>
        <h4>${a.spare_part?.part_name ?? ''}</h4>
        <p>Service ${a.spare_part?.service_id?.slice(0, 8) ?? ''}</p>
      </div>
      <span class="status ${label}">${text}</span>`;
    container.appendChild(div);
  });
}