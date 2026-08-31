const dispState = { pendingOrders: [], pendingSpare: [], pendingProductAlloc: [], dispatchedOrders: [], dispatchedSpare: [], dispatchedProductAlloc: [] };
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
    dispState.pendingProductAlloc = data.pending_product_allocations || [];
    dispState.dispatchedOrders = data.dispatched_orders || [];
    dispState.dispatchedSpare = data.dispatched_spare_parts || [];
    dispState.dispatchedProductAlloc = data.dispatched_product_allocations || [];
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
  const productAllocRows = [...dispState.pendingProductAlloc, ...dispState.dispatchedProductAlloc].map(a => ({ kind: 'product_allocation', data: a }));
  return [...orderRows, ...spareRows, ...productAllocRows];
}

function updateCards() {
  const today = new Date().toDateString();
  const dispatchedToday = [...dispState.dispatchedOrders, ...dispState.dispatchedSpare, ...dispState.dispatchedProductAlloc]
    .filter(x => x.dispatch?.dispatched_at && new Date(x.dispatch.dispatched_at).toDateString() === today).length;

  document.getElementById('cardTotalPending').textContent = dispState.pendingOrders.length + dispState.pendingSpare.length + dispState.pendingProductAlloc.length;
  document.getElementById('cardOrdersPending').textContent = dispState.pendingOrders.length;
  document.getElementById('cardSparePending').textContent = dispState.pendingSpare.length;
  const productPendingCard = document.getElementById('cardProductAllocPending');
  if (productPendingCard) productPendingCard.textContent = dispState.pendingProductAlloc.length;
  document.getElementById('cardDispatchedToday').textContent = dispatchedToday;
  document.getElementById('cardTotalDispatched').textContent = dispState.dispatchedOrders.length + dispState.dispatchedSpare.length + dispState.dispatchedProductAlloc.length;
}

function referenceLabel(row) {
  if (row.kind === 'order') return `#${(row.data.order_id || '').slice(0, 8)}`;
  if (row.kind === 'product_allocation') return `#${(row.data.allocation_id || '').slice(0, 8)}`;
  return `Service #${(row.data.spare_part?.service_id || '').slice(0, 8)}`;
}

function productLabel(row) {
  if (row.kind === 'order') return (row.data.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
  if (row.kind === 'product_allocation') return (row.data.items || []).map(i => `${i.product_name} x${i.quantity}`).join(', ');
  return row.data.spare_part?.part_name || '';
}

function billToLabel(row) {
  if (row.kind === 'order') {
    const c = row.data.customer || {};
    return c.company_name || '-';
  }
  if (row.kind === 'product_allocation') {
    return row.data.sales_person?.name || row.data.company_name || '-';
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
    const hasDispatch = !!d.dispatch;
    const hasDocket = hasDispatch && !!d.dispatch.docket_no;
    const statusHtml = !hasDispatch
      ? `<span class="pending">Pending</span>`
      : hasDocket
        ? `<span class="delivered">Dispatched</span>`
        : `<span style="background:#fef3c7;color:#b45309;padding:3px 10px;border-radius:999px;font-size:12px;">In Progress</span>`;
    const actionHtml = !hasDispatch
      ? '<button class="confirm-dispatch-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Confirm Dispatch</button>'
      : hasDocket
        ? '-'
        : '<button class="add-docket-btn" style="padding:6px 12px;border:none;border-radius:8px;background:#b45309;color:#fff;cursor:pointer;">Add Docket No.</button>';
    const tr = document.createElement('tr');
    tr.dataset.id = row.kind === 'order' ? d.order_id : d.allocation_id;
    tr.dataset.kind = row.kind;

    const typeLabel = row.kind === 'order' ? 'Order' : row.kind === 'product_allocation' ? 'Product' : 'Spare Part';
    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td>${referenceLabel(row)}</td>
      <td>${productLabel(row)}</td>
      <td>${billToLabel(row)}</td>
      <td>${d.dispatch?.docket_no ?? '-'}</td>
      <td>${d.dispatch?.invoice_no ?? '-'}</td>
      <td>${statusHtml}</td>
      <td>
        <button class="icon-btn view-dispatch-btn" title="View Details"><i class="fa-solid fa-eye"></i></button>
        ${actionHtml}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-dispatch-btn').forEach(btn => btn.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const row = combinedRows().find(r => (kind === 'order' ? r.data.order_id : r.data.allocation_id) === id && r.kind === kind);
    if (row) openViewDispatchModal(row);
  }));

  tbody.querySelectorAll('.confirm-dispatch-btn').forEach(btn => btn.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const row = combinedRows().find(r => (kind === 'order' ? r.data.order_id : r.data.allocation_id) === id && r.kind === kind);
    if (row) openDispatchModal(row);
  }));

  tbody.querySelectorAll('.add-docket-btn').forEach(btn => btn.addEventListener('click', e => {
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
      const hasDispatch = !!row.data.dispatch;
      const hasDocket = hasDispatch && !!row.data.dispatch.docket_no;
      const state = !hasDispatch ? 'pending' : hasDocket ? 'dispatched' : 'in_progress';
      const statusOk = !status || status === state;
      return typeOk && statusOk;
    });
    renderTable(filtered);
  });
}

// ---------- View Details modal ----------
function openViewDispatchModal(row) {
  const modal = document.getElementById('viewDispatchModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const d = row.data;
  const disp = d.dispatch || null;

  let bodyHtml = '';
  if (row.kind === 'order') {
    const items = d.items || [];
    const customer = d.customer || {};
    const itemsRows = items.length
      ? items.map(it => `<tr>
          <td>${it.product_name ?? ''}<br><small style="color:#94a3b8;">${[it.product_id, it.model_no].filter(Boolean).join(' · ')}</small>${it.serial_numbers?.length ? `<br><small style="color:#94a3b8;">${it.serial_numbers.join(', ')}</small>` : ''}</td>
          <td>${it.quantity ?? 0}</td>
          <td>₹${it.price ?? 0}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;color:#94a3b8;">No items</td></tr>`;

    bodyHtml = `
      <div class="detail"><small>Order ID</small><p>${d.order_id ?? ''}</p></div>
      <div class="detail"><small>Company</small><p>${customer.company_name ?? '-'}</p></div>
      <div class="detail"><small>Status</small><p>${d.status ?? ''}</p></div>
      <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <div class="detail"><small>Total Amount</small><p>₹${d.total_mrp ?? 0}</p></div>`;
  } else if (row.kind === 'product_allocation') {
    const items = d.items || [];
    const itemsRows = items.length
      ? items.map(it => `<tr>
          <td>${it.product_name ?? ''}<br><small style="color:#94a3b8;">${[it.product_id, it.model_no].filter(Boolean).join(' · ')}</small>${it.serial_numbers?.length ? `<br><small style="color:#94a3b8;">${it.serial_numbers.join(', ')}</small>` : ''}</td>
          <td>${it.quantity ?? 0}</td>
        </tr>`).join('')
      : `<tr><td colspan="2" style="text-align:center;color:#94a3b8;">No items</td></tr>`;

    bodyHtml = `
      <div class="detail"><small>Allocation ID</small><p>${d.allocation_id ?? ''}</p></div>
      <div class="detail"><small>Sales Person</small><p>${d.sales_person?.name ?? '-'}</p></div>
      <div class="detail"><small>Address</small><p>${d.address ?? '-'}</p></div>
      <table style="width:100%;font-size:13px;margin:10px 0;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th>Qty</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>`;
  } else {
    bodyHtml = `
      <div class="detail"><small>Allocation ID</small><p>${d.allocation_id ?? ''}</p></div>
      <div class="detail"><small>Part Name</small><p>${d.spare_part?.part_name ?? '-'}</p></div>
      <div class="detail"><small>Quantity</small><p>${d.spare_part?.quantity ?? '-'}</p></div>
      <div class="detail"><small>Service ID</small><p>${d.spare_part?.service_id ?? '-'}</p></div>`;
  }

  const dispatchHtml = disp ? `
    <div class="detail"><small>Docket No.</small><p>${disp.docket_no ?? '-'}</p></div>
    <div class="detail"><small>Invoice No.</small><p>${disp.invoice_no ?? '-'}</p></div>
    <div class="detail"><small>Invoice Date</small><p>${disp.invoice_date ? new Date(disp.invoice_date).toLocaleDateString('en-GB') : '-'}</p></div>
    <div class="detail"><small>Mode of Delivery</small><p>${disp.mode_of_delivery ?? '-'}</p></div>
    <div class="detail"><small>Ship To</small><p>${disp.ship_to_different ? `${disp.ship_to_address?.company_name ?? ''}, ${disp.ship_to_address?.address ?? ''}` : 'Same as bill to'}</p></div>
    <div class="detail"><small>Dispatched At</small><p>${disp.dispatched_at ? new Date(disp.dispatched_at).toLocaleString('en-GB') : '-'}</p></div>
  ` : `<div class="detail"><small>Dispatch</small><p>Not yet dispatched</p></div>`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Dispatch Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${bodyHtml}
    <hr style="margin:14px 0;border:none;border-top:1px solid #eef1f6;">
    ${dispatchHtml}`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
}
function openDispatchModal(row) {
  const modal = document.getElementById('dispatchModal');
  const content = modal.querySelector('.modal-content');
  const existing = row.data.dispatch || null;
  const billTo = row.kind === 'order'
    ? `${row.data.customer?.company_name || ''}${row.data.customer?.company_address ? ', ' + row.data.customer.company_address : ''}`
    : row.kind === 'product_allocation'
      ? `${row.data.sales_person?.name || ''}${row.data.address ? ', ' + row.data.address : ''}`
      : `Service #${(row.data.spare_part?.service_id || '').slice(0, 8)} (technician location)`;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${existing ? 'Update Dispatch' : 'Confirm Dispatch'}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <form id="dispatchForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="docket_no" placeholder="Docket No. (optional)" value="${existing?.docket_no ?? ''}">

      <div>
        <label style="font-size:12px;color:#64748b;">Bill To Address</label>
        <input value="${billTo}" disabled style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f3f4f6;">
      </div>

      <label style="font-size:13px;color:#475569;display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="shipDifferentCheck" ${existing?.ship_to_different ? 'checked' : ''}> Ship to a different address
      </label>
      <div id="shipToFields" style="display:${existing?.ship_to_different ? 'flex' : 'none'};flex-direction:column;gap:10px;">
        <input name="ship_company_name" placeholder="Ship To — Company Name" value="${existing?.ship_to_address?.company_name ?? ''}">
        <input name="ship_address" placeholder="Ship To — Address" value="${existing?.ship_to_address?.address ?? ''}">
      </div>

      <select name="mode_of_delivery" required>
        <option value="" disabled ${!existing?.mode_of_delivery ? 'selected' : ''}>Mode of Delivery</option>
        <option value="road" ${existing?.mode_of_delivery === 'road' ? 'selected' : ''}>Road</option>
        <option value="air" ${existing?.mode_of_delivery === 'air' ? 'selected' : ''}>Air</option>
        <option value="rail" ${existing?.mode_of_delivery === 'rail' ? 'selected' : ''}>Rail</option>
        <option value="courier" ${existing?.mode_of_delivery === 'courier' ? 'selected' : ''}>Courier</option>
        <option value="self_pickup" ${existing?.mode_of_delivery === 'self_pickup' ? 'selected' : ''}>Self Pickup</option>
      </select>

      <input name="invoice_no" placeholder="Invoice No." value="${existing?.invoice_no ?? ''}" required>
      <input name="invoice_date" type="date" value="${existing?.invoice_date ? existing.invoice_date.slice(0, 10) : ''}" required>

      <div>
        <label style="font-size:12px;color:#64748b;">Packaging / Handover Photo (optional)</label>
        <input type="file" name="image" accept="image/*" style="width:100%;padding:6px 0;">
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">${existing ? 'Update' : 'Confirm'}</button>
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

    const imageFile = e.target.image.files[0];
    if (imageFile) {
      const maxBytes = 2 * 1024 * 1024;
      if (imageFile.size > maxBytes) {
        alert(`Image is ${(imageFile.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`);
        return;
      }
    }

    const buildPayload = (imageDataUrl) => ({
      docket_no: fd.get('docket_no') ? fd.get('docket_no').trim().toLowerCase() : null,
      invoice_no: fd.get('invoice_no').trim().toLowerCase(),
      invoice_date: fd.get('invoice_date'),
      mode_of_delivery: fd.get('mode_of_delivery'),
      ship_to_different: shipDifferent,
      ship_to_address: shipDifferent ? { company_name: fd.get('ship_company_name') || '', address: fd.get('ship_address') || '' } : null,
      image: imageDataUrl || null
    });

    const endpoint = row.kind === 'order'
      ? `/dispatch/confirm/order/${row.data.order_id}`
      : `/dispatch/confirm/spare_part/${row.data.allocation_id}`;

    const sendConfirmation = async (payload) => {
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
    };

    if (imageFile) {
      const reader = new FileReader();
      reader.onload = () => sendConfirmation(buildPayload(reader.result));
      reader.readAsDataURL(imageFile);
    } else {
      await sendConfirmation(buildPayload(null));
    }
  });

  modal.style.display = 'flex';
}