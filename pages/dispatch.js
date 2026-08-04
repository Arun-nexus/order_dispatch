const dispState = { pendingOrders: [], pendingSpare: [], dispatchedOrders: [], dispatchedSpare: [] };
let dispPage = 1;
const DISP_PAGE_SIZE = 7;

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
  loadDispatchQueue();
  wireFilter();
  setInterval(loadDispatchQueue, 60 * 1000);
});

async function loadDispatchQueue() {
  try {
    const res = await apiFetch('/dispatch/');
    if (!res.ok) throw new Error('failed to fetch dispatch queue');
    const data = await res.json();
    dispState.pendingOrders = data.pending_orders || [];
    dispState.pendingSpare = data.pending_spare_parts || [];
    dispState.dispatchedOrders = data.dispatched_orders || [];
    dispState.dispatchedSpare = data.dispatched_spare_parts || [];
    dispPage = 1;
    updateCards();
    renderTable(combinedRows());
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load dispatch queue.');
  }
}

function combinedRows() {
  const orderRows = [...dispState.pendingOrders, ...dispState.dispatchedOrders].map(o => ({ kind: 'order', data: o }));
  const spareRows = [...dispState.pendingSpare, ...dispState.dispatchedSpare].map(a => ({ kind: 'spare_part', data: a }));
  return [...orderRows, ...spareRows];
}

function updateCards() {
  const today = new Date().toDateString();
  const dispatchedToday = [...dispState.dispatchedOrders, ...dispState.dispatchedSpare]
    .filter(x => x.dispatch?.dispatched_at && new Date(x.dispatch.dispatched_at).toDateString() === today).length;

  document.getElementById('cardTotalPending').textContent = dispState.pendingOrders.length + dispState.pendingSpare.length;
  document.getElementById('cardOrdersPending').textContent = dispState.pendingOrders.length;
  document.getElementById('cardSparePending').textContent = dispState.pendingSpare.length;
  document.getElementById('cardDispatchedToday').textContent = dispatchedToday;
  document.getElementById('cardTotalDispatched').textContent = dispState.dispatchedOrders.length + dispState.dispatchedSpare.length;
}

function referenceLabel(row) {
  if (row.kind === 'order') return `#${(row.data.order_id || '').slice(0, 8)}`;
  return `Service #${(row.data.spare_part?.service_id || '').slice(0, 8)}`;
}

function productLabel(row) {
  if (row.kind === 'order') return (row.data.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
  return row.data.spare_part?.part_name || '';
}

function billToLabel(row) {
  if (row.kind === 'order') {
    const c = row.data.customer || {};
    return c.company_name || '-';
  }
  return `Service #${(row.data.spare_part?.service_id || '').slice(0, 8)}`;
}

function rowBestDate(d) {
  return d.dispatch?.dispatched_at || d.order_date || d.allotment_date || d.created_at || null;
}

function renderTable(rows) {
  const sorted = [...rows].sort((a, b) => new Date(rowBestDate(b.data) || 0) - new Date(rowBestDate(a.data) || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / DISP_PAGE_SIZE));
  dispPage = Math.min(Math.max(1, dispPage), totalPages);
  const start = (dispPage - 1) * DISP_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + DISP_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  pageRows.forEach(row => {
    const d = row.data;
    const isDispatched = !!d.dispatch;
    const tr = document.createElement('tr');
    tr.dataset.id = row.kind === 'order' ? d.order_id : d.allocation_id;
    tr.dataset.kind = row.kind;

    tr.innerHTML = `
      <td>${row.kind === 'order' ? 'Order' : 'Spare Part'}</td>
      <td>${referenceLabel(row)}</td>
      <td>${productLabel(row)}</td>
      <td>${billToLabel(row)}</td>
      <td>${d.dispatch?.docket_no ?? '-'}</td>
      <td>${d.dispatch?.invoice_no ?? '-'}</td>
      <td><span class="${isDispatched ? 'delivered' : 'pending'}">${isDispatched ? 'Dispatched' : 'Pending'}</span></td>
      <td>${isDispatched ? '-' : '<button class="confirm-dispatch-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Confirm Dispatch</button>'}</td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.confirm-dispatch-btn').forEach(btn => btn.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const row = combinedRows().find(r => (kind === 'order' ? r.data.order_id : r.data.allocation_id) === id && r.kind === kind);
    if (row) openDispatchModal(row);
  }));

  renderTablePagination(document.querySelector('.pagination'), dispPage, totalPages, p => {
    dispPage = p;
    renderTable(rows);
  });
}

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const type = document.getElementById('typeFilter').value;
    const status = document.getElementById('statusFilter').value;
    const filtered = combinedRows().filter(row => {
      const typeOk = !type || row.kind === type;
      const isDispatched = !!row.data.dispatch;
      const statusOk = !status || (status === 'dispatched' ? isDispatched : !isDispatched);
      return typeOk && statusOk;
    });
    renderTable(filtered);
  });
}

// ---------- Confirm Dispatch modal ----------
function openDispatchModal(row) {
  const modal = document.getElementById('dispatchModal');
  const content = modal.querySelector('.modal-content');
  const billTo = row.kind === 'order'
    ? `${row.data.customer?.company_name || ''}${row.data.customer?.company_address ? ', ' + row.data.customer.company_address : ''}`
    : `Service #${(row.data.spare_part?.service_id || '').slice(0, 8)} (technician location)`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Confirm Dispatch</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="dispatchForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="docket_no" placeholder="Docket No." required>

      <div>
        <label style="font-size:12px;color:#64748b;">Bill To Address</label>
        <input value="${billTo}" disabled style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f3f4f6;">
      </div>

      <label style="font-size:13px;color:#475569;display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="shipDifferentCheck"> Ship to a different address
      </label>
      <div id="shipToFields" style="display:none;flex-direction:column;gap:10px;">
        <input name="ship_company_name" placeholder="Ship To — Company Name">
        <input name="ship_address" placeholder="Ship To — Address">
      </div>

      <input name="invoice_no" placeholder="Invoice No." required>
      <input name="invoice_date" type="date" required>

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Confirm</button>
      </div>
    </form>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  const shipCheck = content.querySelector('#shipDifferentCheck');
  const shipFields = content.querySelector('#shipToFields');
  shipCheck.addEventListener('change', () => {
    shipFields.style.display = shipCheck.checked ? 'flex' : 'none';
  });

  content.querySelector('#dispatchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const shipDifferent = shipCheck.checked;
    const payload = {
      docket_no: fd.get('docket_no'),
      invoice_no: fd.get('invoice_no'),
      invoice_date: fd.get('invoice_date'),
      ship_to_different: shipDifferent,
      ship_to_address: shipDifferent ? { company_name: fd.get('ship_company_name') || '', address: fd.get('ship_address') || '' } : null
    };

    const endpoint = row.kind === 'order'
      ? `/dispatch/confirm/order/${row.data.order_id}`
      : `/dispatch/confirm/spare_part/${row.data.allocation_id}`;

    try {
      const res = await apiFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'dispatch confirmation failed');
      modal.style.display = 'none';
      await loadDispatchQueue();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });

  modal.style.display = 'flex';
}