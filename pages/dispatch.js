const dispState = { pendingOrders: [], pendingSpare: [], pendingProductAlloc: [], dispatchedOrders: [], dispatchedSpare: [], dispatchedProductAlloc: [], searchQuery: '', activeFilters: null };
let dispPage = 1;
let dispAssemblyDates = {};   // serial -> assembling date (from backend)
let dispUserNames = {};   // username -> display name (for the form's REF box)
const DISP_PAGE_SIZE = 30;

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
  wireHeaderSearch();
  wireDispatchCardClicks();
  wireDispatchExport();
  setInterval(loadDispatchQueue, 60 * 1000);
});

// ---------- Cards -> click to see details ----------
function dispatchRowState(d) {
  const hasDispatch = !!d.dispatch;
  const hasDocket = hasDispatch && !!d.dispatch.docket_no;
  return !hasDispatch ? 'pending' : hasDocket ? 'dispatched' : 'in_progress';
}

function dispatchCardTypeLabel(kind) {
  return kind === 'order' ? 'Order' : kind === 'product_allocation' ? 'Product' : 'Spare Part';
}

function dispatchCardRows(cardType) {
  const today = new Date().toDateString();
  const all = combinedRows();
  if (cardType === 'total_pending') return all.filter(r => dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'orders_pending') return all.filter(r => r.kind === 'order' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'spare_pending') return all.filter(r => r.kind === 'spare_part' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'product_pending') return all.filter(r => r.kind === 'product_allocation' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'dispatched_today') return all.filter(r => r.data.dispatch?.dispatched_at && new Date(r.data.dispatch.dispatched_at).toDateString() === today);
  if (cardType === 'total_dispatched') return all.filter(r => !!r.data.dispatch);
  return [];
}

const DISPATCH_CARD_TITLES = {
  total_pending: 'Total Pending',
  orders_pending: 'Orders Pending',
  spare_pending: 'Spare Parts Pending',
  product_pending: 'Products Pending',
  dispatched_today: 'Dispatched Today',
  total_dispatched: 'Total Dispatched'
};

const dispCV = { type: '', base: [], f: {} };
const DISP_STATE_LABELS = { pending: 'Pending', in_progress: 'In Progress', dispatched: 'Dispatched' };

function cvEnsureStyles() {
  if (document.getElementById('cvStyles')) return;
  const st = document.createElement('style');
  st.id = 'cvStyles';
  st.textContent = `
    .cv-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
    .cv-head h3{margin:0}
    .cv-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
    .cv-bar select,.cv-bar input{padding:7px 9px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;background:var(--bg-white);min-width:0}
    .cv-bar input[type=text]{flex:1;min-width:150px}
    .cv-bar label{font-size:12px;color:var(--text-muted)}
    .cv-btn{padding:8px 12px;border:none;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600}
    .cv-btn.exp{background:var(--primary);color:#fff}
    .cv-btn.rst{background:var(--bg-hover);color:var(--text-secondary)}
    .cv-count{font-size:12px;color:var(--text-muted);margin:0 0 8px}
    .cv-wrap{overflow:auto;max-height:58vh;border:1px solid var(--border);border-radius:10px}
    .cv-tbl{width:100%;font-size:12.5px;border-collapse:collapse;min-width:760px}
    .cv-tbl th{position:sticky;top:0;background:var(--bg-light);color:var(--text-secondary);text-align:left;padding:8px;border-bottom:1px solid var(--border);white-space:nowrap}
    .cv-tbl td{color:var(--text-primary);padding:8px;border-bottom:1px solid var(--bg-hover);vertical-align:top}
    .cv-tbl tbody tr.cv-row{cursor:pointer}
    .cv-tbl tbody tr.cv-row:hover{background:var(--bg-light)}
    .cv-hint{font-size:11.5px;color:var(--text-light);margin-top:8px}
  `;
  document.head.appendChild(st);
}

function cvPlain(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html ?? '');
  return d.textContent.replace(/\s+/g, ' ').trim();
}

function cvDownloadCsv(head, rows, fileBase) {
  const cell = v => {
    const t = String(v ?? '');
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${fileBase}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function dispatchStatusHtml(d) {
  const s = dispatchRowState(d);
  if (s === 'pending') return '<span class="pending">Pending</span>';
  if (s === 'dispatched') return d.status === 'delivered' ? '<span class="delivered">Delivered</span>' : '<span class="delivered">Dispatched</span>';
  return '<span style="background:var(--warning-bg);color:var(--warning-dark);padding:3px 10px;border-radius:999px;font-size:12px;">In Progress</span>';
}

function dispCvFiltered() {
  const f = dispCV.f;
  const q = (f.q || '').toLowerCase();
  return dispCV.base.filter(row => {
    const d = row.data;
    if (f.kind && row.kind !== f.kind) return false;
    if (f.state && dispatchRowState(d) !== f.state) return false;
    const day = rowBestDate(d) ? new Date(rowBestDate(d)).toISOString().slice(0, 10) : '';
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (q) {
      const hay = [d.dispatch?.docket_no, d.dispatch?.dispatched_through, d.dispatch?.invoice_no, cvPlain(productLabel(row)), cvPlain(billToLabel(row)),
      ...rowSerialNumbers(row)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const DISP_CV_HEAD = ['Type', 'Date', 'Product', 'Qty', 'Bill To / Service', 'Docket No.', 'Courier / Transport', 'Invoice No.', 'Status'];

function dispCvCells(row) {
  return [
    dispatchCardTypeLabel(row.kind),
    dateLabel(row),
    productLabel(row),
    quantityLabel(row),
    billToLabel(row),
    row.data.dispatch?.docket_no ?? '-',
    row.data.dispatch?.dispatched_through || '-',
    row.data.dispatch?.invoice_no ?? '-',
    dispatchStatusHtml(row.data)
  ];
}

function dispCvExportRows(row) {
  const d = row.data;
  const head = [dispatchCardTypeLabel(row.kind), dateLabel(row)];
  const tail = [cvPlain(billToLabel(row)), d.dispatch?.docket_no ?? '-', d.dispatch?.dispatched_through || '-', d.dispatch?.invoice_no ?? '-', cvPlain(dispatchStatusHtml(d))];
  if ((row.kind === 'order' || row.kind === 'product_allocation') && (d.items || []).length) {
    return d.items.map(i => {
      const meta = [i.product_id, i.model_no].filter(Boolean).join(' · ');
      return [...head, `${i.product_name ?? ''}${meta ? ' (' + meta + ')' : ''}`, i.quantity ?? 0, ...tail];
    });
  }
  return [[...head, d.spare_part?.part_name || '', d.spare_part?.quantity ?? '-', ...tail]];
}

function dispCvPaint() {
  const body = document.getElementById('cvBody');
  if (!body) return;
  const list = dispCvFiltered();
  body.innerHTML = list.map((row, i) => `<tr class="cv-row" data-i="${i}">${dispCvCells(row).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${DISP_CV_HEAD.length}" style="text-align:center;color:var(--text-light);padding:20px;">Nothing matches these filters.</td></tr>`;
  document.getElementById('cvCount').textContent = `${list.length} of ${dispCV.base.length} record(s)`;
  body.querySelectorAll('tr.cv-row').forEach(tr => tr.addEventListener('click', () => {
    const vm = document.getElementById('viewDispatchModal');
    if (vm) vm.style.zIndex = 1100;
    openViewDispatchModal(list[Number(tr.dataset.i)]);
  }));
}

function openDispatchCardDetailModal(cardType) {
  const modal = document.getElementById('dispatchCardDetailModal');
  if (!modal) return;
  cvEnsureStyles();
  dispCV.type = cardType;
  dispCV.base = dispatchCardRows(cardType);
  dispCV.f = {};
  const fixedKind = { orders_pending: 'order', spare_pending: 'spare_part', product_pending: 'product_allocation' }[cardType];

  const content = modal.querySelector('.modal-content');
  content.style.width = 'min(1100px,95vw)';
  content.innerHTML = `
    <div class="cv-head"><h3>${DISPATCH_CARD_TITLES[cardType] || ''}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>
    <div class="cv-bar">
      <input type="text" data-f="q" placeholder="Search docket, invoice, product, serial, bill to...">
      ${fixedKind ? '' : `<select data-f="kind"><option value="">All Categories</option><option value="order">Orders</option><option value="spare_part">Spare Parts</option><option value="product_allocation">Allocated Products</option></select>`}
      <select data-f="state"><option value="">All Status</option><option value="pending">Pending</option><option value="in_progress">In Progress</option><option value="dispatched">Dispatched</option></select>
      <label>Date</label>
      <input type="date" data-f="from" title="From"><input type="date" data-f="to" title="To">
      <button class="cv-btn rst" id="cvReset">Reset</button>
      <button class="cv-btn exp" id="cvExport"><i class="fa-solid fa-download"></i> Export CSV</button>
      <button class="cv-btn exp" id="cvPrint"><i class="fa-solid fa-print"></i> Print</button>
    </div>
    <p class="cv-count" id="cvCount"></p>
    <div class="cv-wrap"><table class="cv-tbl">
      <thead><tr>${DISP_CV_HEAD.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody id="cvBody"></tbody></table></div>
    <p class="cv-hint">Click a row to see full details.</p>`;

  content.querySelector('.close').addEventListener('click', () => { modal.style.display = 'none'; });
  content.querySelectorAll('[data-f]').forEach(el => el.addEventListener(el.type === 'text' ? 'input' : 'change', e => {
    dispCV.f[el.dataset.f] = e.target.value;
    dispCvPaint();
  }));
  content.querySelector('#cvReset').addEventListener('click', () => {
    dispCV.f = {};
    content.querySelectorAll('[data-f]').forEach(el => { el.value = ''; });
    dispCvPaint();
  });
  content.querySelector('#cvExport').addEventListener('click', () => {
    cvDownloadCsv(DISP_CV_HEAD, dispCvFiltered().flatMap(dispCvExportRows),
      (DISPATCH_CARD_TITLES[cardType] || 'dispatch').toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  });
  content.querySelector('#cvPrint').addEventListener('click', () => {
    if (typeof A4Print === 'undefined') { alert('print_a4.js is not loaded.'); return; }
    A4Print.table(dispatchPrintOpts(DISPATCH_CARD_TITLES[cardType] || 'Dispatch', dispCvFiltered()));
  });
  dispCvPaint();
  modal.style.display = 'flex';
}

function dispatchPrintOpts(title, rows) {
  return {
    title: title + ' - Dispatch',
    subtitle: 'Dispatch queue',
    head: DISP_CV_HEAD,
    rows: rows.flatMap(dispCvExportRows)
  };
}

function wireDispatchExport() {
  const btn = document.querySelector('.top-actions .export');
  if (!btn) return;
  if (typeof A4Print !== 'undefined') A4Print.attachNextTo(btn, () => dispatchPrintOpts('Dispatch', getFilteredRows()));
  btn.addEventListener('click', () => {
    const rows = getFilteredRows();
    if (!rows.length) { alert('Nothing to export for the current filters.'); return; }
    cvDownloadCsv(DISP_CV_HEAD, rows.flatMap(dispCvExportRows), 'dispatch');
  });
}

function wireDispatchCardClicks() {
  document.querySelectorAll('.card-clickable').forEach(card => {
    card.addEventListener('click', () => openDispatchCardDetailModal(card.dataset.card));
  });
  const modal = document.getElementById('dispatchCardDetailModal');
  if (modal) modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

// ---------- Header search (docket, invoice, product, serial number) ----------
function wireHeaderSearch() {
  const input = document.querySelector('.search input');
  if (!input) return;
  input.addEventListener('input', () => {
    dispState.searchQuery = input.value.trim().toLowerCase();
    dispPage = 1;
    renderTable(getFilteredRows());
  });
}

function rowSerialNumbers(row) {
  if (row.kind === 'spare_part') return [];
  return (row.data.items || []).flatMap(i => i.serial_numbers || []);
}

// Combines the header search box with whatever the type/status "Apply
// Filter" bar last set, so any action that reloads data (confirm dispatch,
// add docket, etc.) re-renders the SAME filtered/searched view.
function getFilteredRows() {
  let rows = combinedRows();

  const q = dispState.searchQuery;
  if (q) {
    rows = rows.filter(row => {
      const d = row.data;
      const docket = (d.dispatch?.docket_no || '').toLowerCase();
      const invoice = (d.dispatch?.invoice_no || '').toLowerCase();
      const courier = (d.dispatch?.dispatched_through || '').toLowerCase();
      const product = productLabel(row).toLowerCase();
      const serials = rowSerialNumbers(row).map(s => (s || '').toLowerCase());
      return docket.includes(q) || invoice.includes(q) || courier.includes(q) || product.includes(q) ||
        serials.some(s => s.includes(q));
    });
  }

  const f = dispState.activeFilters;
  if (f) {
    rows = rows.filter(row => {
      const typeOk = !f.type || row.kind === f.type;
      const hasDispatch = !!row.data.dispatch;
      const hasDocket = hasDispatch && !!row.data.dispatch.docket_no;
      const state = !hasDispatch ? 'pending' : hasDocket ? 'dispatched' : 'in_progress';
      const statusOk = !f.status || f.status === state;
      return typeOk && statusOk;
    });
  }

  return rows;
}

async function loadDispatchUsers() {
  if (Object.keys(dispUserNames).length) return;
  try {
    const res = await apiFetch('/account/users');
    if (res.ok) ((await res.json()).dataset || []).forEach(u => { if (u.username) dispUserNames[u.username] = u.name || u.username; });
  } catch (e) { /* names are optional - falls back to the username */ }
}

function odfPersonName(username) {
  return username ? (dispUserNames[username] || username) : '';
}

async function loadDispatchQueue() {
  loadDispatchUsers();
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
    dispAssemblyDates = data.assembly_dates || {};
    dispPage = 1;
    updateCards();
    renderTable(getFilteredRows());
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

function dateLabel(row) {
  const dt = rowBestDate(row.data);
  return dt ? new Date(dt).toLocaleDateString('en-GB') : '-';
}

function productLabel(row) {
  if (row.kind === 'order' || row.kind === 'product_allocation') {
    return (row.data.items || []).map(i => {
      const meta = [i.product_id, i.model_no].filter(Boolean).join(' · ');
      return `<div style="margin-bottom:4px;">${i.product_name ?? ''}${meta ? `<br><small style="color:#94a3b8;">${meta}</small>` : ''}</div>`;
    }).join('');
  }
  return row.data.spare_part?.part_name || '';
}

function quantityLabel(row) {
  if (row.kind === 'order' || row.kind === 'product_allocation') {
    return (row.data.items || []).map(i => `<div style="margin-bottom:4px;">${i.quantity ?? 0}</div>`).join('');
  }
  return row.data.spare_part?.quantity ?? '-';
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
  const sorted = [...rows].sort((a, b) => {
    const aPending = !a.data.dispatch;
    const bPending = !b.data.dispatch;
    if (aPending !== bPending) return aPending ? -1 : 1;
    return new Date(rowBestDate(b.data) || 0) - new Date(rowBestDate(a.data) || 0);
  });

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
        ? `<span class="delivered">${d.status === 'delivered' ? 'Delivered' : 'Dispatched'}</span>`
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
      <td>${dateLabel(row)}</td>
      <td>${productLabel(row)}</td>
      <td>${quantityLabel(row)}</td>
      <td>${billToLabel(row)}</td>
      <td>${d.dispatch?.docket_no ?? '-'}</td>
      <td>${d.dispatch?.dispatched_through || '-'}</td>
      <td>${d.dispatch?.invoice_no ?? '-'}</td>
      <td>${statusHtml}</td>
      <td>
        <button class="icon-btn view-dispatch-btn" title="View Details"><i class="fa-solid fa-eye"></i></button>
        <button class="icon-btn print-form-btn" title="Order Dispatch Form (View / Edit / Print)"><i class="fa-solid fa-print"></i></button>
        <button class="icon-btn qc-form-btn" title="QC Forms (SOP-07)"><i class="fa-solid fa-clipboard-check"></i></button>
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

  tbody.querySelectorAll('.print-form-btn').forEach(btn => btn.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const row = combinedRows().find(r => (kind === 'order' ? r.data.order_id : r.data.allocation_id) === id && r.kind === kind);
    if (row) openDispatchForm(row);
  }));

  tbody.querySelectorAll('.qc-form-btn').forEach(btn => btn.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const row = combinedRows().find(r => (kind === 'order' ? r.data.order_id : r.data.allocation_id) === id && r.kind === kind);
    if (row) openQcFormFor(row);
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
    dispState.activeFilters = (type || status) ? { type, status } : null;
    dispPage = 1;
    renderTable(getFilteredRows());
  });
}

// ---------- View Details modal ----------
const DV_LABELS = {
  dispatched_through: 'Courier / Transport', mode_of_delivery: 'Mode of Delivery', gst_number: 'GST No.', total_mrp: 'Total Amount',
  company_name: 'Company', company_address: 'Address', phone_number: 'Phone', contact_number: 'Contact No.', serial_numbers: 'Serial No.',
  model_no: 'Model No.', product_id: 'Product ID', tax_rate: 'Tax Rate (%)', order_id: 'Order ID', allocation_id: 'Allocation ID',
  service_id: 'Service ID', part_name: 'Part Name', created_by: 'Created By', allocated_by: 'Allocated By'
};
function dvEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dvLabel(k) {
  return DV_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function dvFmt(k, v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) {
    const t = new Date(v);
    if (!isNaN(t)) return v.length > 10 ? t.toLocaleString('en-GB') : t.toLocaleDateString('en-GB');
  }
  if (typeof v === 'number' && /(price|amount|mrp|total|discount|charge)/i.test(k) && !/(rate|percent|qty|quantity)/i.test(k)) return '\u20b9' + v;
  return String(v);
}
function dvFlat(obj, prefix, out, skip) {
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (skip.includes(k) || v === null || v === undefined || v === '') return;
    if (typeof v === 'string' && v.startsWith('data:')) return;
    const label = prefix ? `${prefix} \u2013 ${dvLabel(k)}` : dvLabel(k);
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (v.every(x => x === null || typeof x !== 'object')) out.push([label, v.map(x => dvFmt(k, x)).join(', ')]);
      else v.forEach((x, i) => dvFlat(x, `${label} ${i + 1}`, out, skip));
    } else if (typeof v === 'object') {
      dvFlat(v, label, out, skip);
    } else {
      out.push([label, dvFmt(k, v)]);
    }
  });
  return out;
}
function dvRow(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<div class="detail"><small>${dvEsc(label)}</small><p>${dvEsc(value)}</p></div>`;
}
function dvRows(obj, skip) {
  return dvFlat(obj, '', [], ['_id', 'image', 'password'].concat(skip || [])).map(([l, v]) => dvRow(l, v)).join('');
}
function dvSection(title, html) {
  return html ? `<h4 style="margin:16px 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;">${title}</h4>${html}` : '';
}
function dvItemBlock(it) {
  return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px;margin-bottom:8px;">${dvRows(it)}</div>`;
}

function dvPick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}
function dvTile(label, value, hl) {
  if (value === undefined || value === null || value === '') return '';
  return `<div style="background:${hl ? '#eef4ff' : '#f7f8fd'};${hl ? 'border:1px solid #bfd4ff;' : ''}border-radius:12px;padding:12px 14px;min-width:0;">
    <div style="font-size:12px;color:#64748b;margin-bottom:4px;">${dvEsc(label)}</div>
    <div style="font-size:14.5px;color:#1e293b;font-weight:500;word-break:break-word;">${dvEsc(value)}</div></div>`;
}
function dvTileGrid(tilesHtml) {
  return tilesHtml ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">${tilesHtml}</div>` : '';
}
function dvLeftoverTiles(obj, skip, prefix) {
  return dvFlat(obj, prefix || '', [], ['_id', 'image', 'password'].concat(skip || [])).map(([l, v]) => dvTile(l, v)).join('');
}
function dvChips(arr) {
  return (arr || []).map(x => `<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:8px;padding:2px 8px;font-size:12px;margin:2px 4px 2px 0;">${dvEsc(x)}</span>`).join('');
}
function dvTitle(t) {
  return `<h4 style="margin:18px 0 8px;font-size:13px;color:#334155;">${t}</h4>`;
}
function dvProductsTable(items, withPrice) {
  if (!items.length) return '';
  const th = 'padding:12px 14px;text-align:left;color:#334155;white-space:nowrap;';
  const td = 'padding:12px 14px;border-top:1px solid #eef1f6;vertical-align:top;';
  const rows = items.map(it => {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price);
    const tax = Number(it.tax_rate) || 0;
    const line = !isNaN(price) && it.price !== undefined && it.price !== '' ? qty * price * (1 + tax / 100) : null;
    return `<tr>
      <td style="${td}"><strong>${dvEsc(it.product_name ?? '')}</strong><br><small style="color:#94a3b8;">${dvEsc([it.product_id && 'ID: ' + it.product_id, it.model_no && 'Model: ' + it.model_no].filter(Boolean).join(' \u00b7 '))}</small></td>
      <td style="${td}">${dvChips(it.serial_numbers) || '-'}</td>
      <td style="${td}">${qty}</td>
      ${withPrice ? `<td style="${td}">${it.price !== undefined && it.price !== '' ? '\u20b9' + Number(it.price).toLocaleString('en-IN') : '-'}</td>
      <td style="${td}">${it.tax_rate !== undefined && it.tax_rate !== '' ? it.tax_rate + '%' : '-'}</td>
      <td style="${td}"><strong>${line === null ? '-' : '\u20b9' + line.toLocaleString('en-IN')}</strong></td>` : ''}
    </tr>`;
  }).join('');
  return `<div style="border:1px solid #e2e8f0;border-radius:12px;overflow-x:auto;">
    <table style="width:100%;min-width:480px;border-collapse:collapse;font-size:13.5px;">
      <thead><tr style="background:#eaf2ff;"><th style="${th}">Product</th><th style="${th}">Serial No(s)</th><th style="${th}">Qty</th>${withPrice ? `<th style="${th}">Price</th><th style="${th}">Tax</th><th style="${th}">Line Total</th>` : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}
function dvTotalsBox(d) {
  const items = d.items || [];
  let sub = 0, tax = 0;
  items.forEach(it => {
    const base = (Number(it.quantity) || 0) * (Number(it.price) || 0);
    sub += base;
    tax += base * (Number(it.tax_rate) || 0) / 100;
  });
  const disc = Number(d.discount) || 0;
  const total = d.total_mrp !== undefined && d.total_mrp !== '' ? Number(d.total_mrp) : sub + tax - disc;
  const money = n => '\u20b9' + Number(n || 0).toLocaleString('en-IN');
  const line = (k, v, strong) => `<div style="display:flex;justify-content:space-between;padding:6px 0;${strong ? 'border-top:1px solid #e2e8f0;margin-top:6px;padding-top:12px;font-weight:700;font-size:15px;' : ''}"><span>${k}</span><span>${v}</span></div>`;
  return `<div style="background:#f7f8fd;border-radius:12px;padding:12px 18px;width:min(360px,100%);margin:14px 0 0 auto;font-size:14px;">
    ${line('Subtotal', money(sub))}${line('Tax', money(tax))}${line('Discount', '- ' + money(disc))}${line('Total Amount', money(total), true)}</div>`;
}

function openViewDispatchModal(row) {
  const modal = document.getElementById('viewDispatchModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const d = row.data;
  const disp = d.dispatch || null;
  const c = d.customer || {};
  const idLabel = row.kind === 'order' ? 'Order ID' : 'Allocation ID';
  const idValue = row.kind === 'order' ? d.order_id : d.allocation_id;

  let infoTiles = '';
  let productsHtml = '';
  let totalsHtml = '';
  if (row.kind === 'order') {
    const usedTop = ['dispatch', 'items', 'customer', 'attachments', 'order_id', 'status', 'total_mrp', 'discount', 'order_date', 'payment_mode', 'credit_days', 'payment_terms', 'reference', 'reference_name', 'created_by', 'warranty', 'warranty_period'];
    const usedCust = ['company_name', 'gst_number', 'gst_no', 'gstin', 'phone_number', 'contact_number', 'contact', 'phone', 'mobile', 'contact_person'];
    const pay = [dvPick(d, ['payment_mode', 'payment_terms']), d.credit_days ? `${d.credit_days} days` : ''].filter(Boolean).join(' \u2014 ');
    const files = (d.attachments || []).map(a => (typeof a === 'string' ? a : a.filename || a.name || a.original_name || 'file')).join(', ');
    infoTiles = dvTileGrid(
      dvTile('Company', c.company_name)
      + dvTile('GST Number', dvPick(c, ['gst_number', 'gst_no', 'gstin']))
      + dvTile('Contact', [dvPick(c, ['contact_person']), dvPick(c, ['phone_number', 'contact_number', 'contact', 'phone', 'mobile'])].filter(Boolean).join(' \u00b7 '))
      + dvTile('Order Date', d.order_date ? new Date(d.order_date).toLocaleDateString('en-GB') : '')
      + dvTile('Payment', pay)
      + dvTile('Reference', dvPick(d, ['reference', 'reference_name']))
      + dvTile('Created By', d.created_by)
      + dvTile('Warranty', dvPick(d, ['warranty', 'warranty_period']))
      + dvTile('Attachments', files)
      + dvLeftoverTiles(c, usedCust, 'Customer')
      + dvLeftoverTiles(d, usedTop));
    productsHtml = dvTitle('Products') + dvProductsTable(d.items || [], true);
    totalsHtml = dvTotalsBox(d);
  } else if (row.kind === 'product_allocation') {
    const usedTop = ['dispatch', 'items', 'sales_person', 'allocation_id', 'company_name', 'address', 'gst_number', 'phone_number', 'allotment_date', 'return_due_date', 'created_by', 'allocated_by', 'remarks', 'status'];
    infoTiles = dvTileGrid(
      dvTile('Sales Person', [d.sales_person?.name, d.sales_person?.contact_number].filter(Boolean).join(' \u00b7 '))
      + dvTile('Company', d.company_name)
      + dvTile('Address', d.address)
      + dvTile('GST Number', d.gst_number)
      + dvTile('Phone', d.phone_number)
      + dvTile('Allotment Date', d.allotment_date ? new Date(d.allotment_date).toLocaleDateString('en-GB') : '')
      + dvTile('Return Due', d.return_due_date ? new Date(d.return_due_date).toLocaleDateString('en-GB') : '')
      + dvTile('Created By', dvPick(d, ['created_by', 'allocated_by']))
      + dvTile('Remarks', d.remarks)
      + dvLeftoverTiles(d.sales_person, ['name', 'contact_number'], 'Sales Person')
      + dvLeftoverTiles(d, usedTop));
    productsHtml = dvTitle('Products') + dvProductsTable(d.items || [], false);
  } else {
    const usedTop = ['dispatch', 'spare_part', 'allocation_id', 'status'];
    infoTiles = dvTileGrid(
      dvTile('Part Name', d.spare_part?.part_name)
      + dvTile('Quantity', d.spare_part?.quantity)
      + dvTile('Service ID', d.spare_part?.service_id)
      + dvLeftoverTiles(d.spare_part, ['part_name', 'quantity', 'service_id'], 'Spare Part')
      + dvLeftoverTiles(d, usedTop));
  }

  let dispatchHtml;
  if (disp) {
    const handled = ['image', 'image_drive_link', 'media_updated_at', 'docket_no', 'dispatched_through', 'mode_of_delivery', 'invoice_no', 'invoice_date', 'dispatched_by', 'ship_to_different', 'ship_to_address', 'dispatched_at'];
    const ship = disp.ship_to_different
      ? [disp.ship_to_address?.company_name, disp.ship_to_address?.address].filter(Boolean).join(', ')
      : 'Same as bill to';
    const photo = typeof disp.image === 'string' && disp.image.startsWith('data:image')
      ? `<div style="margin-top:10px;"><div style="font-size:12px;color:#64748b;margin-bottom:6px;">Packaging / Handover Photo</div><img src="${disp.image}" alt="Dispatch photo" style="max-width:100%;border-radius:12px;"></div>`
      : disp.image_drive_link
        ? `<div style="margin-top:10px;"><a href="${dvEsc(disp.image_drive_link)}" target="_blank" rel="noopener">View packaging / handover photo</a></div>`
        : '';
    dispatchHtml = dvTitle('Dispatch') + dvTileGrid(
      dvTile('Courier / Transport', disp.dispatched_through || '-', true)
      + dvTile('Docket No.', disp.docket_no || '-')
      + dvTile('Mode of Delivery', (disp.mode_of_delivery || '').replace(/_/g, ' '))
      + dvTile('Invoice No.', disp.invoice_no)
      + dvTile('Invoice Date', disp.invoice_date ? new Date(disp.invoice_date).toLocaleDateString('en-GB') : '')
      + dvTile('Dispatched By', disp.dispatched_by)
      + dvTile('Ship To', ship)
      + dvTile('Dispatched At', disp.dispatched_at ? new Date(disp.dispatched_at).toLocaleString('en-GB') : '')
      + dvLeftoverTiles(disp, handled)) + photo;
  } else {
    dispatchHtml = dvTitle('Dispatch') + dvTileGrid(dvTile('Dispatch', 'Not yet dispatched'));
  }

  content.style.width = 'min(980px, 96vw)';
  content.style.maxHeight = '88vh';
  content.style.overflowY = 'auto';
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid #eef1f6;">
      <div>
        <h3 style="margin:0;">Dispatch Details</h3>
        <div style="font-size:12.5px;color:#94a3b8;margin-top:4px;word-break:break-all;">${idLabel}: ${dvEsc(idValue ?? '')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:14px;color:#475569;">${cvPlain(dispatchStatusHtml(d))}</span>
        <button class="cv-btn exp" id="viewPrintForm" title="Order Dispatch Form"><i class="fa-solid fa-print"></i> Dispatch Form</button>
        <button class="cv-btn exp" id="viewQcForm" title="QC Forms (SOP-07)"><i class="fa-solid fa-clipboard-check"></i> QC Form</button>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
    </div>
    ${infoTiles}
    ${dispatchHtml}
    ${productsHtml}
    ${totalsHtml}`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('#viewPrintForm').addEventListener('click', () => openDispatchForm(row));
  content.querySelector('#viewQcForm').addEventListener('click', () => openQcFormFor(row));
  modal.style.display = 'flex';
}

// ---------- Order Dispatch Form (Excel form -> editable A4 print) ----------
// Fills only what the system already has; every other box is left blank and
// stays editable inside the form before printing.
function odfDateTime(v) {
  if (!v) return '';
  const dt = new Date(v);
  if (isNaN(dt)) return '';
  const day = dt.toLocaleDateString('en-GB');
  const hasTime = typeof v === 'string' && v.includes('T') && !/T00:00:00(\.0+)?(Z|[+-]00:?00)?$/.test(v);
  return hasTime ? `${day} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : day;
}

function odfDefaults(row) {
  const d = row.data, disp = d.dispatch || {};
  let company = '', address = '', ref = '', lines = [], serials = [], mfg = [];

  if (row.kind === 'order' || row.kind === 'product_allocation') {
    const items = d.items || [];
    lines = items.map((it, i) => `${i + 1}. ${it.product_name ?? ''}${it.model_no ? ' (' + it.model_no + ')' : ''}  -  Qty: ${it.quantity ?? 0}`);
    serials = items.filter(it => (it.serial_numbers || []).length).map(it => `${it.product_name ?? ''}: ${it.serial_numbers.join(', ')}`);
    // Manufacturing date = assembling date of the unit (only filled when an assembly record exists)
    items.forEach(it => {
      const days = [...new Set((it.serial_numbers || []).map(sn => dispAssemblyDates[sn]).filter(Boolean)
        .map(v => new Date(v)).filter(x => !isNaN(x)).map(x => x.toLocaleDateString('en-GB')))];
      if (days.length) mfg.push(`${it.product_name ?? ''}: ${days.join(', ')}`);
    });
  }
  if (row.kind === 'order') {
    const c = d.customer || {};
    company = c.company_name || '';
    address = c.company_address || '';
    ref = odfPersonName(d.reference || d.creator?.raised_by);
  } else if (row.kind === 'product_allocation') {
    company = d.sales_person?.name || d.company_name || '';
    address = d.address || '';
    ref = d.sales_person?.name || '';
    lines.unshift('ALLOCATED / DEMO PRODUCT');
  } else {
    company = `Service #${(d.spare_part?.service_id || '').slice(0, 8)} (Spare Part)`;
    ref = odfPersonName(d.allocated_by);
    lines = ['SPARE PART FOR SERVICE', `1. ${d.spare_part?.part_name ?? ''}  -  Qty: ${d.spare_part?.quantity ?? '-'}`];
  }

  const extra = [];
  if (disp.invoice_date) extra.push(`Invoice Date: ${new Date(disp.invoice_date).toLocaleDateString('en-GB')}`);
  if (disp.docket_no) extra.push(`Docket No.: ${String(disp.docket_no).toUpperCase()}`);
  if (disp.ship_to_different) extra.push(`SHIP TO: ${disp.ship_to_address?.company_name ?? ''}${disp.ship_to_address?.address ? ', ' + disp.ship_to_address.address : ''}`);

  // mode of dispatch -> tick the matching box of the form
  const mode = disp.mode_of_delivery || '';
  const through = disp.dispatched_through || '';
  const out = { hand: '', porter: '', courier: '', others: '' };
  if (mode === 'self_pickup') out.hand = '\u2714';
  else if (mode === 'courier') out.courier = ['\u2714', through].filter(Boolean).join(' ');
  else if (mode) out.others = [mode.charAt(0).toUpperCase() + mode.slice(1), through].filter(Boolean).join(' - ');

  return {
    inv: disp.invoice_no ? String(disp.invoice_no).toUpperCase() : '',
    ref,
    date: new Date().toLocaleDateString('en-GB'),
    party: company,
    address,
    details: [...lines, ...(extra.length ? ['', ...extra] : [])].join('\n'),
    ...out,
    recv: row.kind === 'order' ? odfDateTime(d.order_date) : odfDateTime(d.allotment_date || d.created_at),
    serials: serials.join('\n'),
    mfg: mfg.join('\n'),
    handover: disp.docket_no ? `Docket No.: ${String(disp.docket_no).toUpperCase()}` : ''
  };
}

function openQcFormFor(row) {
  if (typeof openQcForms !== 'function') { alert('qc_forms.js is not loaded.'); return; }
  openQcForms(row, { assemblyDates: dispAssemblyDates, personName: odfPersonName });
}

function openDispatchForm(row) {
  if (typeof A4Print === 'undefined') { alert('print_a4.js is not loaded.'); return; }
  const d = row.data;
  A4Print.form(`${row.kind}:${d.order_id || d.allocation_id}`, odfDefaults(row));
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

      <input name="dispatched_through" placeholder="By (Courier / Transporter Name)" value="${existing?.dispatched_through ?? ''}" required>

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
      dispatched_through: fd.get('dispatched_through').trim(),
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