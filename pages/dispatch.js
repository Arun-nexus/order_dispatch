const dispState = { pendingOrders: [], pendingSpare: [], pendingProductAlloc: [], dispatchedOrders: [], dispatchedSpare: [], dispatchedProductAlloc: [], searchQuery: '', activeFilters: null };
let dispPage = 1;
let dispAssemblyDates = {};   
let dispUserNames = {};   
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

function dispatchRowState(d) {
  const hasDispatch = !!d.dispatch;
  const hasDocket = hasDispatch && !!d.dispatch.docket_no;
  return !hasDispatch ? 'pending' : hasDocket ? 'dispatched' : 'in_progress';
}

function dispatchCardTypeLabel(kind) {
  return kind === 'order' ? 'Order' : kind === 'product_allocation' ? 'Product' : kind === 'service' ? 'Service' : 'Spare Part';
}

function dispatchCardRows(cardType) {
  const today = new Date().toDateString();
  const all = combinedRows();
  if (cardType === 'total_pending') return all.filter(r => dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'orders_pending') return all.filter(r => r.kind === 'order' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'spare_pending') return all.filter(r => r.kind === 'spare_part' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'product_pending') return all.filter(r => r.kind === 'product_allocation' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'service_pending') return all.filter(r => r.kind === 'service' && dispatchRowState(r.data) !== 'dispatched');
  if (cardType === 'dispatched_today') return all.filter(r => r.data.dispatch?.dispatched_at && new Date(r.data.dispatch.dispatched_at).toDateString() === today);
  if (cardType === 'total_dispatched') return all.filter(r => !!r.data.dispatch);
  return [];
}

const DISPATCH_CARD_TITLES = {
  total_pending: 'Total Pending',
  orders_pending: 'Orders Pending',
  spare_pending: 'Spare Parts Pending',
  product_pending: 'Products Pending',
  service_pending: 'Services Pending',
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
  if ((row.kind === 'order' || row.kind === 'product_allocation' || row.kind === 'service') && (d.items || []).length) {
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
  const fixedKind = { orders_pending: 'order', spare_pending: 'spare_part', product_pending: 'product_allocation', service_pending: 'service' }[cardType];

  const content = modal.querySelector('.modal-content');
  content.style.width = 'min(1100px,95vw)';
  content.innerHTML = `
    <div class="cv-head"><h3>${DISPATCH_CARD_TITLES[cardType] || ''}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>
    <div class="cv-bar">
      <input type="text" data-f="q" placeholder="Search docket, invoice, product, serial, bill to...">
      ${fixedKind ? '' : `<select data-f="kind"><option value="">All Categories</option><option value="order">Orders</option><option value="spare_part">Spare Parts</option><option value="product_allocation">Allocated Products</option><option value="service">Services</option></select>`}
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
    dispState.pendingServices = data.pending_services || [];
    dispState.dispatchedServices = data.dispatched_services || [];
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
  const serviceRows = [...(dispState.pendingServices || []), ...(dispState.dispatchedServices || [])].map(a => ({ kind: 'service', data: a }));
  return [...orderRows, ...spareRows, ...productAllocRows, ...serviceRows];
}

function updateCards() {
  const today = new Date().toDateString();
  const dispatchedToday = [...dispState.dispatchedOrders, ...dispState.dispatchedSpare, ...dispState.dispatchedProductAlloc, ...(dispState.dispatchedServices || [])]
    .filter(x => x.dispatch?.dispatched_at && new Date(x.dispatch.dispatched_at).toDateString() === today).length;

  document.getElementById('cardTotalPending').textContent = dispState.pendingOrders.length + dispState.pendingSpare.length + dispState.pendingProductAlloc.length + (dispState.pendingServices || []).length;
  document.getElementById('cardOrdersPending').textContent = dispState.pendingOrders.length;
  document.getElementById('cardSparePending').textContent = dispState.pendingSpare.length;
  const productPendingCard = document.getElementById('cardProductAllocPending');
  if (productPendingCard) productPendingCard.textContent = dispState.pendingProductAlloc.length;
  document.getElementById('cardDispatchedToday').textContent = dispatchedToday;
  document.getElementById('cardTotalDispatched').textContent = dispState.dispatchedOrders.length + dispState.dispatchedSpare.length + dispState.dispatchedProductAlloc.length + (dispState.dispatchedServices || []).length;
}

function dateLabel(row) {
  const dt = rowBestDate(row.data);
  return dt ? new Date(dt).toLocaleDateString('en-GB') : '-';
}

function productLabel(row) {
  if (row.kind === 'order' || row.kind === 'product_allocation' || row.kind === 'service') {
    return (row.data.items || []).map(i => {
      const meta = [i.product_id, i.model_no].filter(Boolean).join(' · ');
      return `<div style="margin-bottom:4px;">${i.product_name ?? ''}${meta ? `<br><small style="color:#94a3b8;">${meta}</small>` : ''}</div>`;
    }).join('');
  }
  return row.data.spare_part?.part_name || '';
}

function quantityLabel(row) {
  if (row.kind === 'order' || row.kind === 'product_allocation' || row.kind === 'service') {
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
  if (row.kind === 'service') return row.data.company_name || `Service #${(row.data.service_id || '').slice(0, 8)}`;
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

    const typeLabel = dispatchCardTypeLabel(row.kind);
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
        <button class="icon-btn label-btn" data-key="${labelKey(row)}" title="Shipping Label (6x4 in)"><i class="fa-solid fa-tag"></i></button>
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

  tbody.querySelectorAll('.label-btn').forEach(btn => btn.addEventListener('click', () => {
    const row = labelRowByKey(btn.dataset.key);
    if (row) openLabelDialog(row);
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
  const idLabel = row.kind === 'order' ? 'Order ID' : row.kind === 'service' ? 'Service ID' : 'Allocation ID';
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
  } else if (row.kind === 'service') {
    infoTiles = dvTileGrid(
      dvTile('Company', d.company_name)
      + dvTile('Issue', d.issue)
      + dvTile('Purchase Date', d.purchase_date)
      + dvTile('Service Charges', d.service_charges)
      + dvTile('Approved By', d.approved_by)
      + dvTile('Approved At', d.approved_at ? new Date(d.approved_at).toLocaleDateString('en-GB') : ''));
    productsHtml = dvTitle('Products') + dvProductsTable(d.items || [], false);
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
        <button class="cv-btn exp" id="viewLabel" title="Shipping Label (6x4 in)"><i class="fa-solid fa-tag"></i> Label</button>
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
  content.querySelector('#viewLabel').addEventListener('click', () => openLabelDialog(row));
  content.querySelector('#viewQcForm').addEventListener('click', () => openQcFormFor(row));
  modal.style.display = 'flex';
}

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

  if (row.kind === 'order' || row.kind === 'product_allocation' || row.kind === 'service') {
    const items = d.items || [];
    lines = items.map((it, i) => `${i + 1}. ${it.product_name ?? ''}${it.model_no ? ' (' + it.model_no + ')' : ''}  -  Qty: ${it.quantity ?? 0}`);
    serials = items.filter(it => (it.serial_numbers || []).length).map(it => `${it.product_name ?? ''}: ${it.serial_numbers.join(', ')}`);
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
  } else if (row.kind === 'service') {
    company = d.company_name || '';
    ref = odfPersonName(d.approved_by);
    lines.unshift('SERVICED PRODUCT RETURN');
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
  const reqShip = row.kind === 'order' && !existing && row.data.ship_to_different && row.data.ship_to_address ? row.data.ship_to_address : null;
  const shipOn = !!(existing?.ship_to_different || reqShip);
  const shipVal = existing?.ship_to_address || reqShip || {};
  const billTo = row.kind === 'order'
    ? `${row.data.customer?.company_name || ''}${row.data.customer?.company_address ? ', ' + row.data.customer.company_address : ''}`
    : row.kind === 'service'
      ? row.data.company_name || ''
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
        <input type="checkbox" id="shipDifferentCheck" ${shipOn ? 'checked' : ''}> Ship to a different address${reqShip ? ' <small style="color:#d97706;">(requested by distributor)</small>' : ''}
      </label>
      <div id="shipToFields" style="display:${shipOn ? 'flex' : 'none'};flex-direction:column;gap:10px;">
        <input name="ship_company_name" placeholder="Ship To — Company Name" value="${String(shipVal.company_name ?? '').replace(/"/g, '&quot;')}">
        <input name="ship_address" placeholder="Ship To — Address" value="${String(shipVal.address ?? '').replace(/"/g, '&quot;')}">
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
      : row.kind === 'service'
        ? `/dispatch/confirm/service/${row.data.service_id}`
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

// ===== Shipping Label (6 x 4 in, 2 per A4 page) : dispatch record se Bill To / Ship To / receiver mobile auto-fill =====
const LABEL_CO = {
  name: 'Acer Biomedicals LLP',
  address: 'Industrial Unit No 80, Block - G, Sector - 63, Noida - 201301, Uttar Pradesh',
  tel: '0120-4166921',
  mob: '9319855917'
};
const LABEL_LOGO = 'data:image/png;base64,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';

function labelKey(row) {
  const d = row.data;
  return row.kind + ':' + (row.kind === 'order' ? d.order_id : (d.allocation_id || d.service_id));
}

function labelPhone(raw) {
  const first = String(raw ?? '').split(/[,;\/]/)[0];
  const dg = first.replace(/\D/g, '');
  if (dg.length < 10) return dg;
  const t = dg.slice(-10);
  return t.slice(0, 5) + ' ' + t.slice(5);
}

function labelData(row) {
  const d = row.data, disp = d.dispatch || {}, c = d.customer || {};
  let name = '', addr = '', phone = '';
  if (row.kind === 'order') {
    name = c.company_name || '';
    addr = c.company_address || '';
    phone = dvPick(c, ['contractor_number', 'phone_number', 'contact_number', 'contact', 'phone', 'mobile']);
  } else if (row.kind === 'product_allocation') {
    const sp = d.sales_person?.name;
    name = [d.company_name, sp ? `(${sp})` : ''].filter(Boolean).join(' ') || sp || '';
    addr = d.address || '';
    phone = d.phone_number || d.sales_person?.contact_number || d.contact_number || '';
  } else if (row.kind === 'service') {
    name = d.company_name || `Service #${(d.service_id || '').slice(0, 8)}`;
    addr = d.address || d.company_address || '';
    phone = d.phone_number || d.contact_number || '';
  } else {
    name = `Service #${(d.spare_part?.service_id || '').slice(0, 8)} (Spare Part)`;
  }

  // ship-to: dispatch confirm hua to uska ship_to_address, nahi to distributor ki request, nahi to bill-to wahi
  const reqShip = row.kind === 'order' && !d.dispatch && d.ship_to_different && d.ship_to_address ? d.ship_to_address : null;
  const sh = disp.ship_to_different ? disp.ship_to_address : reqShip;
  const ship = sh && (sh.company_name || sh.address)
    ? { name: sh.company_name || name, addr: sh.address || '' }
    : { name, addr };

  const mode = String(disp.mode_of_delivery || '').replace(/_/g, ' ');
  const via = [mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : '', disp.dispatched_through || ''].filter(Boolean).join(' · ');
  return {
    bill: { name, addr },
    ship,
    phone: labelPhone(phone),
    invoice: disp.invoice_no ? String(disp.invoice_no).toUpperCase() : '',
    date: disp.invoice_date ? new Date(disp.invoice_date).toLocaleDateString('en-GB') : '',
    via,
    docket: disp.docket_no ? String(disp.docket_no).toUpperCase() : ''
  };
}

function labelSizeClass(p) {
  const n = (p.name + ' ' + p.addr).length;
  return n > 230 ? ' xs' : n > 150 ? ' sm' : '';
}

function labelHtml(row) {
  const L = labelData(row);
  const meta = [['Invoice', L.invoice], ['Date', L.date], ['Via', L.via], ['Docket', L.docket]]
    .filter(m => m[1]).map(m => `<span>${m[0]} <b>${dvEsc(m[1])}</b></span>`).join('');
  const box = (title, p, cls) => `<div class="box ${cls}"><h4>${title}</h4><p class="n">${dvEsc(p.name)}</p><p class="a${labelSizeClass(p)}">${dvEsc(p.addr)}</p></div>`;
  return `<div class="label">
    <div class="top"><img src="${LABEL_LOGO}" alt=""><div class="co"><b>${dvEsc(LABEL_CO.name)}</b><span>${dvEsc(LABEL_CO.address)}</span></div></div>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="addr">${box('Bill To', L.bill, '')}${box('Ship To', L.ship, 'ship')}</div>
    <div class="bottom">
      <div class="from"><b>From: ${dvEsc(LABEL_CO.name)}</b>${dvEsc(LABEL_CO.address.replace(', Uttar Pradesh', ''))}<br>Tel ${dvEsc(LABEL_CO.tel)} · ${dvEsc(LABEL_CO.mob)}</div>
      <div class="mob">${L.phone ? `<small>Receiver M.O.B.</small><strong>${dvEsc(L.phone)}</strong>` : ''}</div>
    </div>
    <div class="foot">${dvEsc(LABEL_CO.name)}</div>
  </div>`;
}

const LABEL_CSS = `
  :root{--brand:#005CA9;--navy:#0B2F5B;--ink:#16202e;--muted:#6b7a90;--line:#d9e1ec;--tint:#f4f8fc}
  *{box-sizing:border-box;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4 portrait;margin:0}
  html,body{background:#fff;font-family:'Inter','Segoe UI',Arial,sans-serif;color:var(--ink)}
  .sheet{width:210mm;height:297mm;padding:22mm 0 0;display:flex;flex-direction:column;align-items:center;gap:12mm;page-break-after:always;break-after:page;overflow:hidden}
  .sheet:last-child{page-break-after:auto;break-after:auto}
  .label{width:576px;height:384px;background:#fff;border:1px solid #c5d0de;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;flex:none}
  .top{display:flex;align-items:center;gap:14px;padding:14px 18px 12px;border-bottom:2px solid var(--brand)}
  .top img{height:38px}
  .top .co{border-left:1px solid var(--line);padding-left:14px;line-height:1.3}
  .top .co b{font-size:15px;color:var(--navy);letter-spacing:.2px}
  .top .co span{display:block;font-size:10.5px;color:var(--muted)}
  .meta{display:flex;flex-wrap:wrap;gap:4px 18px;padding:7px 18px;background:var(--tint);font-size:10px;color:var(--muted);border-bottom:1px solid var(--line)}
  .meta b{color:var(--ink);font-weight:600}
  .addr{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 18px 0;flex:1;min-height:0}
  .box{border:1px solid var(--line);border-radius:8px;padding:9px 12px 8px;overflow:hidden}
  .box h4{font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--brand);font-weight:700;margin-bottom:5px}
  .box.ship{border-color:var(--brand);box-shadow:inset 3px 0 0 var(--brand)}
  .box p{font-size:12px;line-height:1.38;font-weight:600;text-transform:uppercase;word-break:break-word}
  .box p.n{font-size:13px;color:var(--navy);margin-bottom:2px}
  .box p.a.sm{font-size:10.5px}.box p.a.xs{font-size:9.5px;line-height:1.3}
  .bottom{display:flex;justify-content:space-between;align-items:center;padding:10px 18px 12px;gap:14px}
  .from{font-size:10px;line-height:1.5;color:var(--muted)}
  .from b{display:block;color:var(--ink);font-size:11px;font-weight:600}
  .mob{text-align:right}
  .mob small{display:block;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
  .mob strong{font-size:19px;color:var(--navy);letter-spacing:.6px;font-weight:700;white-space:nowrap}
  .foot{background:var(--navy);color:#cfe0f3;font-size:9px;letter-spacing:2.2px;text-align:center;padding:6px;text-transform:uppercase}
`;

function printLabels(rows) {
  if (!rows || !rows.length) { alert('No label to print.'); return; }
  let sheets = '';
  for (let i = 0; i < rows.length; i += 2) {
    sheets += `<div class="sheet">${labelHtml(rows[i])}${rows[i + 1] ? labelHtml(rows[i + 1]) : ''}</div>`;
  }
  const old = document.getElementById('labelPrintFrame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'labelPrintFrame';
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Dispatch Labels</title><style>${LABEL_CSS}</style></head><body>${sheets}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  }, 400);
}

function labelRowByKey(key) {
  return combinedRows().find(r => labelKey(r) === key);
}

function openLabelDialog(row) {
  const old = document.getElementById('labelDialog');
  if (old) old.remove();
  const L = labelData(row);
  const ov = document.createElement('div');
  ov.id = 'labelDialog';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2000;display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = `
    <div style="background:var(--bg-white,#fff);border-radius:14px;padding:20px 22px;width:min(340px,92vw);box-shadow:0 20px 50px rgba(15,23,42,.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <h3 style="margin:0;font-size:16px;">Print Shipping Label</h3>
        <button type="button" id="lblX" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:14px;">${dvEsc(L.ship.name)}</div>
      <label style="font-size:12px;color:#64748b;">Number of labels</label>
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0 6px;">
        <button type="button" id="lblMinus" style="width:36px;height:36px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:18px;cursor:pointer;">&minus;</button>
        <input id="lblQty" type="number" min="1" max="200" value="1" style="flex:1;min-width:0;text-align:center;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;font-weight:600;">
        <button type="button" id="lblPlus" style="width:36px;height:36px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:18px;cursor:pointer;">+</button>
      </div>
      <div id="lblPages" style="font-size:12px;color:#64748b;margin-bottom:16px;">1 A4 page (2 labels per page)</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button type="button" id="lblCancel" style="padding:9px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="button" id="lblGo" style="padding:9px 16px;border:none;border-radius:8px;background:var(--primary,#1665ff);color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-print"></i> Print</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const qty = ov.querySelector('#lblQty');
  const val = () => Math.min(200, Math.max(1, parseInt(qty.value, 10) || 1));
  const refresh = () => {
    const n = val();
    const pages = Math.ceil(n / 2);
    ov.querySelector('#lblPages').textContent = `${pages} A4 page${pages > 1 ? 's' : ''} (2 labels per page)`;
  };
  const close = () => ov.remove();
  qty.addEventListener('input', refresh);
  ov.querySelector('#lblMinus').addEventListener('click', () => { qty.value = Math.max(1, val() - 1); refresh(); });
  ov.querySelector('#lblPlus').addEventListener('click', () => { qty.value = Math.min(200, val() + 1); refresh(); });
  ov.querySelector('#lblX').addEventListener('click', close);
  ov.querySelector('#lblCancel').addEventListener('click', close);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  const go = () => { const n = val(); close(); printLabels(Array(n).fill(row)); };
  ov.querySelector('#lblGo').addEventListener('click', go);
  qty.addEventListener('keydown', e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); });
  qty.focus(); qty.select();
}