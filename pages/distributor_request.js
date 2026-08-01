const reqPageState = { requests: [], allocations: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadRequestsPage();
  wireFilters();
});

window.refreshCurrentPageData = loadRequestsPage;

async function loadRequestsPage() {
  try {
    const [reqRes, allocRes] = await Promise.all([
      apiFetch('/request/mine'),
      apiFetch('/allocation/mine')
    ]);
    if (!reqRes.ok) throw new Error('failed to fetch requests');
    const reqData = await reqRes.json();
    const allocData = allocRes.ok ? await allocRes.json() : { dataset: [] };

    reqPageState.requests = reqData.dataset || [];
    reqPageState.allocations = allocData.dataset || [];

    renderCards();
    renderDueSoon();
    renderRequestsTable(reqPageState.requests);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your requests.');
  }
}

function daysLeft(a) {
  return Math.ceil((new Date(a.return_due_date) - new Date()) / (1000 * 60 * 60 * 24));
}

function renderCards() {
  const requests = reqPageState.requests;
  const dueSoon = reqPageState.allocations.filter(a => a.return_status !== 'returned' && daysLeft(a) > 0 && daysLeft(a) <= 3);
  const overdue = reqPageState.allocations.filter(a => a.return_status !== 'returned' && daysLeft(a) <= 0);

  document.getElementById('cardDueSoon').textContent = dueSoon.length;
  document.getElementById('cardOverdue').textContent = overdue.length;
  document.getElementById('cardPending').textContent = requests.filter(r => r.status === 'pending').length;
  document.getElementById('cardTotalRequests').textContent = requests.length;
}

function renderDueSoon() {
  const box = document.getElementById('dueSoonList');
  if (!box) return;
  const dueSoon = reqPageState.allocations
    .filter(a => a.return_status !== 'returned' && daysLeft(a) > 0 && daysLeft(a) <= 3)
    .sort((a, b) => new Date(a.return_due_date) - new Date(b.return_due_date));

  box.innerHTML = dueSoon.length ? dueSoon.map(a => {
    const productLabel = (a.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
    return `
      <div class="order-item">
        <div class="order-left">
          <div class="order-icon"><i class="fa-solid fa-hourglass-half"></i></div>
          <div>
            <h4>${a.customer?.company_name ?? 'Customer'}</h4>
            <p>${productLabel} — due ${new Date(a.return_due_date).toLocaleDateString('en-GB')}</p>
          </div>
        </div>
        <span class="status pending">${daysLeft(a)}d left</span>
      </div>`;
  }).join('') : '<p style="color:#94a3b8;padding:10px;">Nothing due back within 3 days.</p>';
}

function requestStatusClass(status) {
  if (status === 'approved') return 'delivered';
  if (status === 'rejected') return 'cancelled';
  return 'pending';
}

function renderRequestsTable(requests) {
  const tbody = document.getElementById('myRequestsTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const sorted = [...requests].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  sorted.forEach(r => {
    const isOrder = r.request_type === 'order';
    const isDemo = r.request_type === 'demo_unit';
    const typeLabel = isOrder ? 'Order' : isDemo ? 'Demo Unit' : 'Spare Part';
    const customerLabel = isDemo || isOrder ? (r.details?.customer?.company_name || 'New customer') : `Service #${(r.details?.service_id || '').slice(0, 8)}`;
    const productLabel = (isDemo || isOrder) ? (r.details?.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ') : (r.details?.note || '-');
    const paymentLabel = isOrder ? (r.details?.payment_mode || '-') : '-';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td>${customerLabel}</td>
      <td>${productLabel}</td>
      <td>${paymentLabel}</td>
      <td>${r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="status ${requestStatusClass(r.status)}">${r.status}</span></td>
      <td>${r.status === 'rejected' ? (r.reason || '-') : '-'}</td>`;
    tbody.appendChild(tr);
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;">No requests raised yet.</td></tr>';
  }
}

function wireFilters() {
  const applyBtn = document.getElementById('applyRequestFilter');
  if (!applyBtn) return;
  applyBtn.addEventListener('click', () => {
    const status = document.getElementById('statusFilter').value;
    const type = document.getElementById('typeFilter').value;
    const filtered = reqPageState.requests.filter(r =>
      (!status || r.status === status) && (!type || r.request_type === type)
    );
    renderRequestsTable(filtered);
  });
}