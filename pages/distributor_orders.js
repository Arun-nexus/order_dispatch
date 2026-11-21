const doState = { orders: [], products: [] };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let doPage = 1;
const DO_PAGE_SIZE = 50;

const PAYMENT_MODES = [
  { value: 'Credit', label: 'Credit' },
  { value: 'NetBanking', label: 'Net Banking' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
  { value: 'DemandDraft', label: 'Demand Draft' },
  { value: 'Cash', label: 'Cash' },
];

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
  ensureRequestCards();
  wireOrderCardClicks();
  loadOrders();
  loadInventoryForOrders();
  wireHeaderButtons();
  wireFilter();
  injectOrderModal();
  wireViewModalClose();
});

window.refreshCurrentPageData = () => { loadOrders(); };

async function loadOrders() {
  try {
    const res = await apiFetch('/order/');
    if (!res.ok) throw new Error('failed to fetch orders');
    const data = await res.json();
    const uname = getUsername();
    const mine = (data.dataset || []).filter(o => o.creator?.raised_by === uname || o.reference === uname);

    let convertRows = [];
    try {
      const rr = await apiFetch('/request/mine');
      if (rr.ok) {
        convertRows = ((await rr.json()).dataset || [])
          .filter(r => (r.request_type === 'convert_to_order' || r.request_type === 'order') && (r.status === 'pending' || r.status === 'rejected'))
          .map(r => {
            const isOrderReq = r.request_type === 'order';
            const items = (r.details?.items || []).map(i => ({ ...i, line_total: Number(((i.price || 0) * (i.quantity || 0)).toFixed(2)) }));
            const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0);
            const tax = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0) * ((i.tax_rate || 0) / 100), 0);
            const discount = isOrderReq ? (Number(r.details?.discount) || 0) : 0;
            const total = Math.max(subtotal + tax - discount, 0);
            return {
              _isRequest: true, _reqKind: isOrderReq ? 'order' : 'convert',
              order_id: r.request_id, customer: r.details?.customer || {}, items,
              payment_mode: isOrderReq ? (r.details?.payment_mode || '-') : '-',
              payment_details: isOrderReq ? (r.details?.payment_details || {}) : {},
              order_remarks: isOrderReq ? (r.details?.remarks || '') : '',
              ship_to_different: isOrderReq ? !!r.details?.ship_to_different : false,
              ship_to_address: isOrderReq ? (r.details?.ship_to_address || null) : null,
              subtotal: Number(subtotal.toFixed(2)), tax_total: Number(tax.toFixed(2)), discount,
              total_mrp: Number(total.toFixed(2)), order_date: r.created_at,
              attachments: (r.details?.attachments || r.attachments || []).map(a => ({ ...a, request_id: a.request_id || r.request_id })),
              status: r.status === 'rejected' ? 'request_rejected' : 'under_approval', reason: r.reason,
              creator: { raised_by: r.raised_by }
            };
          });
      }
    } catch (e) { console.error(e); }

    doState.orders = [...convertRows, ...mine.slice().reverse()];
    doPage = 1;
    renderCards(doState.orders);
    renderTable(doState.orders);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load your orders.');
    }
  }
}

async function loadInventoryForOrders() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) return;
    const data = await res.json();
    doState.products = data.dataset || [];
  } catch (err) {
    console.error(err);
  }
}

function renderCards(orders) {
  const today = new Date().toDateString();
  orders = orders.filter(o => !o._isRequest);
  const todaysOrders = orders.filter(o => o.order_date && new Date(o.order_date).toDateString() === today);
  const live = orders.filter(o => o.status !== 'cancelled');
  const todaysAmount = todaysOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);
  const salesAmount = live.reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('cardTotalOrders', orders.length);
  set('cardSalesAmount', slFmt(salesAmount));
  set('cardSalesToday', `Today: ${slFmt(todaysAmount)}`);
  set('cardTodayOrders', todaysOrders.length);
  set('cardDelivered', orders.filter(o => o.status === 'delivered').length);
  set('cardPendingOrders', orders.filter(o => o.status !== 'delivered' && o.status !== 'cancelled' && !isDispatched(o)).length);
  set('cardDispatched', orders.filter(o => isDispatched(o) && o.status !== 'delivered').length);
  set('cardPendingRequests', (doState.orders || []).filter(o => o._isRequest && o.status === 'under_approval').length);
  set('cardRejectedRequests', (doState.orders || []).filter(o => o._isRequest && o.status === 'request_rejected').length);
}

function isDispatched(o, status) {
  const s = status ?? o?.status;
  return s === 'dispatched' || (s === 'processing' && !!o?.dispatch);
}

function statusClass(status, o) {
  if (isDispatched(o, status)) return 'dispatched';
  const map = { placed: 'pending', processing: 'pending', dispatched: 'dispatched', delivered: 'delivered', cancelled: 'cancel', returned: 'cancel', under_approval: 'pending', request_rejected: 'cancel' };
  return map[status] || 'pending';
}

function statusLabel(status, o) {
  if (isDispatched(o, status)) return 'Dispatched';
  const map = { placed: 'Pending', processing: 'Processing', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned', under_approval: 'Under Approval', request_rejected: 'Rejected' };
  return map[status] || status || '';
}

function renderTable(orders) {
  const sorted = [...orders].sort((a, b) =>
    new Date(b.order_date || b.created_at || 0) - new Date(a.order_date || a.created_at || 0));

  const totalPages = Math.max(1, Math.ceil(sorted.length / DO_PAGE_SIZE));
  doPage = Math.min(Math.max(1, doPage), totalPages);
  const start = (doPage - 1) * DO_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + DO_PAGE_SIZE);

  const tbody = document.getElementById('ordersTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:#94a3b8;">No orders yet.</td></tr>`;
  }

  pageRows.forEach(o => {
    const items = o.items || [];
    let productLabel = '-';
    if (items.length) {
      const first = items[0];
      const model = first.model_no || ocvInv(first)?.model_no || '';
      productLabel = `${esc(first.product_name ?? '')}${model ? ` <small style="color:#64748b;">(${esc(model)})</small>` : ''}${items.length > 1 ? ` +${items.length - 1} more` : ''}`;
    }
    const companyName = o.customer?.company_name ?? '';
    const tr = document.createElement('tr');
    tr.dataset.orderId = o.order_id;
    tr.innerHTML = `
      <td>${o.order_id ? o.order_id.slice(0, 8) : '-'}${o._isRequest ? `<br><small style="color:#94a3b8;">${o._reqKind === 'convert' ? 'Request (demo → order)' : 'Request'}</small>` : ''}</td>
      <td>${esc(companyName)}</td>
      <td>${productLabel}</td>
      <td>${o.payment_mode ?? ''}</td>
      <td>₹${o.total_mrp ?? 0}</td>
      <td>${o.order_date ? new Date(o.order_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="${statusClass(o.status, o)}">${statusLabel(o.status, o)}</span>${o.status === 'placed' && o.remark ? `<br><small style="color:#94a3b8;">${esc(o.remark)}</small>` : ''}</td>
      <td><button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => openViewOrderModal(rowOrder(e))));

  renderTablePagination(document.querySelector('.pagination'), doPage, totalPages, p => {
    doPage = p;
    renderTable(orders);
  });
}

function rowOrder(e) {
  const tr = e.target.closest('tr');
  return doState.orders.find(o => o.order_id === tr.dataset.orderId);
}

const ocv = { key: '', title: '', base: [], f: {} };

function ocvEnsure() {
  if (!document.getElementById('ocvStyles')) {
    const st = document.createElement('style');
    st.id = 'ocvStyles';
    st.textContent = `
      #viewOrderModal{z-index:1100 !important}
      /* table headings in these popups/wizards were white on light grey */
      #viewOrderModal th,#orderModal th,#cardDetailModal th{background:#f1f5f9 !important;color:#334155 !important}
      .oc-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
      .oc-head h3{margin:0}
      .oc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
      .oc-bar select,.oc-bar input{padding:7px 9px;border:1px solid #e2e8f0;border-radius:8px;font-size:12.5px;background:#fff;color:#1e293b;min-width:0}
      .oc-bar input[type=text]{flex:1;min-width:150px}
      .oc-btn{padding:8px 12px;border:none;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600}
      .oc-btn.exp{background:#1665ff;color:#fff}
      .oc-btn.rst{background:#eef1f6;color:#334155}
      .oc-count{font-size:12px;color:#64748b;margin:0 0 8px}
      .oc-wrap{overflow:auto;max-height:58vh;border:1px solid #eef1f6;border-radius:10px}
      .oc-tbl{width:100%;font-size:12.5px;border-collapse:collapse;min-width:900px;color:#1e293b}
      .oc-tbl th{position:sticky;top:0;text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;white-space:nowrap}
      .oc-tbl td{padding:8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
      .oc-tbl tbody tr{cursor:pointer}
      .oc-tbl tbody tr:hover{background:#f8fbff}
      .oc-sub{display:block;font-size:11px;color:#64748b;margin-top:1px}
      .oc-line{margin-bottom:6px}
      .oc-line:last-child{margin-bottom:0}
      .oc-pill{padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:600;white-space:nowrap}
      .oc-pill.pending{background:#fef3c7;color:#92400e}
      .oc-pill.delivered{background:#dcfce7;color:#166534}
      .oc-pill.cancel{background:#fee2e2;color:#991b1b}
      .oc-pill.dispatched,span.dispatched{background:#dbeafe;color:#1e40af}
      span.dispatched{padding:4px 10px;border-radius:99px;font-size:12px;font-weight:600}
      .sl-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
      .sl-tab{padding:7px 14px;border:1px solid #e2e8f0;border-radius:99px;background:#fff;color:#334155;cursor:pointer;font-size:12.5px;font-weight:600}
      .sl-tab.on{background:#1665ff;border-color:#1665ff;color:#fff}
      .sl-bar input{padding:7px 9px;border:1px solid #e2e8f0;border-radius:8px;font-size:12.5px}
      .sl-main{display:flex;flex-wrap:wrap;gap:18px}
      .sl-chart{flex:1 1 520px;min-width:0}
      .sl-side{flex:0 0 290px;max-width:100%}
      .sl-kpi{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
      .sl-kpi div{background:#f8fafc;border:1px solid #eef1f6;border-radius:10px;padding:9px 11px}
      .sl-kpi span{display:block;font-size:11px;color:#64748b}
      .sl-kpi b{font-size:15px;color:#0f172a}
      .sl-list{max-height:290px;overflow:auto;border:1px solid #eef1f6;border-radius:10px}
      .sl-list table{width:100%;border-collapse:collapse;font-size:12.5px;color:#1e293b}
      .sl-list th{position:sticky;top:0;background:#f1f5f9;color:#334155;text-align:left;padding:7px 8px}
      .sl-list td{padding:6px 8px;border-bottom:1px solid #f1f5f9}
      .sl-list td:not(:first-child),.sl-list th:not(:first-child){text-align:right}`;
    document.head.appendChild(st);
  }
  let modal = document.getElementById('cardDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'cardDetailModal';
    modal.className = 'modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);justify-content:center;align-items:center;z-index:999;';
    modal.innerHTML = '<div class="modal-content" style="background:#fff;border-radius:16px;padding:26px;width:min(1100px,96vw);max-height:92vh;overflow-y:auto;"></div>';
    modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);
  }
  return modal;
}

function ocvInv(i) {
  const list = doState.products || [];
  return list.find(p => p.product_name === i.product_name && (p.model_no || '') === (i.model_no || ''))
    || list.find(p => p.product_name === i.product_name) || null;
}
function ocvIdent(i) {
  const p = ocvInv(i);
  if (p && (p.product_type === 'spare_parts' || p.product_type === 'service_parts')) return 'Belongs to: ' + (p.parent_product_name || '—');
  return [i.product_id || p?.product_id || '', i.model_no || p?.model_no || ''].filter(Boolean).join(' · ');
}
const ocvDay = o => (o.order_date || o.created_at || '').slice(0, 10);

function ocvBase(key) {
  const real = doState.orders.filter(o => !o._isRequest);
  const todayStr = new Date().toDateString();
  const todays = real.filter(o => o.order_date && new Date(o.order_date).toDateString() === todayStr);
  switch (key) {
    case 'total': return ['Total Orders', real];
    case 'todayAmount': return ["Today's Order Amount", todays];
    case 'today': return ["Today's Orders", todays];
    case 'delivered': return ['Delivered', real.filter(o => o.status === 'delivered')];
    case 'pending': return ['Pending', real.filter(o => o.status !== 'delivered' && o.status !== 'cancelled' && !isDispatched(o))];
    case 'dispatched': return ['Dispatched', real.filter(o => isDispatched(o) && o.status !== 'delivered')];
    case 'pendingReq': return ['Pending Requests', doState.orders.filter(o => o._isRequest && o.status === 'under_approval')];
    case 'rejectedReq': return ['Rejected Requests', doState.orders.filter(o => o._isRequest && o.status === 'request_rejected')];
    default: return ['Orders', doState.orders];
  }
}

function ocvFiltered() {
  const f = ocv.f, q = (f.q || '').toLowerCase();
  return ocv.base.filter(o => {
    if (f.status && statusLabel(o.status, o) !== f.status) return false;
    if (f.payment && (o.payment_mode || '-') !== f.payment) return false;
    if (f.company && (o.customer?.company_name || '') !== f.company) return false;
    if (f.from && ocvDay(o) < f.from) return false;
    if (f.to && ocvDay(o) > f.to) return false;
    if (q) {
      const hay = [o.order_id, o.customer?.company_name, o.customer?.gst_number,
      ...(o.items || []).map(i => `${i.product_name} ${i.product_id || ''} ${i.model_no || ''} ${ocvIdent(i)} ${(i.serial_numbers || []).join(' ')}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function ocvRowsHtml(list) {
  if (!list.length) return '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;">Nothing matches these filters.</td></tr>';
  return list.map(o => {
    const items = (o.items || []).map(i => `
      <div class="oc-line"><b>${esc(i.product_name)}</b> × ${esc(i.quantity ?? 0)}${i.price ? ` — ₹${esc(i.price)}` : ''}
        ${ocvIdent(i) ? `<span class="oc-sub">${esc(ocvIdent(i))}</span>` : ''}
        ${(i.serial_numbers || []).length ? `<span class="oc-sub">Serial: ${esc(i.serial_numbers.join(', '))}</span>` : ''}</div>`).join('') || '—';
    return `<tr data-id="${esc(o.order_id)}">
      <td>${esc((o.order_id || '').slice(0, 8))}${o._isRequest ? `<span class="oc-sub">${o._reqKind === 'convert' ? 'Request (demo → order)' : 'Request'}</span>` : ''}</td>
      <td><b>${esc(o.customer?.company_name || '-')}</b>${o.customer?.gst_number ? `<span class="oc-sub">GST: ${esc(o.customer.gst_number)}</span>` : ''}</td>
      <td>${items}</td>
      <td>${esc(o.payment_mode || '-')}${o.payment_mode && o.payment_mode !== '-' ? `<span class="oc-sub">${esc(paymentDetailsLabel(o))}</span>` : ''}</td>
      <td>₹${esc(o.total_mrp ?? 0)}</td>
      <td>${o.order_date ? new Date(o.order_date).toLocaleDateString('en-GB') : '-'}</td>
      <td><span class="oc-pill ${statusClass(o.status, o)}">${esc(statusLabel(o.status, o))}</span>${o.status === 'request_rejected' && o.reason ? `<span class="oc-sub">${esc(o.reason)}</span>` : ''}</td>
    </tr>`;
  }).join('');
}

function ocvPaint() {
  const list = ocvFiltered();
  const body = document.getElementById('ocBody');
  if (!body) return;
  body.innerHTML = ocvRowsHtml(list);
  const total = list.reduce((s, o) => s + (Number(o.total_mrp) || 0), 0);
  document.getElementById('ocCount').textContent = `${list.length} of ${ocv.base.length} record(s) · Total ₹${total.toFixed(2)}`;
  body.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => {
    openViewOrderModal(doState.orders.find(o => o.order_id === tr.dataset.id));
  }));
}

function ocvCsvCell(v) {
  const t = String(v ?? '');
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function ocvExport(list, base) {
  const head = ['Type', 'Order / Request ID', 'Company', 'Address', 'GST No.', 'Products (name x qty @ price - id/model or belongs to - serials)',
    'Payment Mode', 'Payment Details', 'Subtotal', 'Tax', 'Discount', 'Total', 'Date', 'Status', 'Rejection Reason',
    'Docket No.', 'Invoice No.', 'Invoice Date', 'Mode of Delivery'];
  const rows = list.map(o => [
    o._isRequest ? 'Request' : 'Order', o.order_id, o.customer?.company_name || '', o.customer?.company_address || '', o.customer?.gst_number || '',
    (o.items || []).map(i => `${i.product_name} x ${i.quantity ?? 0}${i.price ? ' @ ' + i.price : ''}${ocvIdent(i) ? ' - ' + ocvIdent(i) : ''}${(i.serial_numbers || []).length ? ' - ' + i.serial_numbers.join('/') : ''}`).join(' | '),
    o.payment_mode || '', o.payment_mode && o.payment_mode !== '-' ? paymentDetailsLabel(o) : '',
    o.subtotal ?? '', o.tax_total ?? '', o.discount ?? '', o.total_mrp ?? 0,
    (o.order_date || '').slice(0, 10), statusLabel(o.status, o), o.status === 'request_rejected' ? (o.reason || '') : '',
    o.dispatch?.docket_no || '', o.dispatch?.invoice_no || '', o.dispatch?.invoice_date || '', o.dispatch?.mode_of_delivery || '']);
  const csv = '﻿' + [head, ...rows].map(r => r.map(ocvCsvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${base}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function openOrderCardModal(key) {
  if (key === 'sales') return openSalesModal();
  const modal = ocvEnsure();
  const [title, base] = ocvBase(key);
  ocv.key = key; ocv.title = title; ocv.base = base; ocv.f = {};
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort();
  const opt = arr => arr.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div class="oc-head"><h3>${esc(title)} <span style="color:#94a3b8;font-weight:400;">(${base.length})</span></h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>
    <div class="oc-bar">
      <input type="text" id="ocF_q" placeholder="Search order ID, company, product, ID, model, serial...">
      <select id="ocF_status"><option value="">All Status</option>${opt(uniq(base.map(o => statusLabel(o.status, o))))}</select>
      <select id="ocF_payment"><option value="">All Payment</option>${opt(uniq(base.map(o => o.payment_mode || '-')))}</select>
      <select id="ocF_company"><option value="">All Customers</option>${opt(uniq(base.map(o => o.customer?.company_name)))}</select>
      <label style="font-size:12px;color:#64748b;">Date</label>
      <input type="date" id="ocF_from" title="From"><input type="date" id="ocF_to" title="To">
      <button class="oc-btn rst" id="ocF_reset">Reset</button>
      <button class="oc-btn exp" id="ocF_export"><i class="fa-solid fa-download"></i> Export CSV</button>
    </div>
    <p class="oc-count" id="ocCount"></p>
    <div class="oc-wrap"><table class="oc-tbl">
      <thead><tr><th>Order ID</th><th>Customer</th><th>Products</th><th>Payment</th><th>Amount</th><th>Date</th><th>Status</th></tr></thead>
      <tbody id="ocBody"></tbody></table></div>
    <p style="font-size:11.5px;color:#94a3b8;margin-top:8px;">Click a row to see full order details.</p>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelectorAll('.oc-bar select,.oc-bar input').forEach(el => {
    const k = el.id.replace('ocF_', '');
    el.addEventListener(el.type === 'text' ? 'input' : 'change', () => { ocv.f[k] = el.value; ocvPaint(); });
  });
  content.querySelector('#ocF_reset').addEventListener('click', () => {
    ocv.f = {}; content.querySelectorAll('.oc-bar select,.oc-bar input').forEach(el => el.value = ''); ocvPaint();
  });
  content.querySelector('#ocF_export').addEventListener('click', () =>
    ocvExport(ocvFiltered(), title.toLowerCase().replace(/[^a-z0-9]+/g, '_')));
  ocvPaint();
  modal.style.display = 'flex';
}

function ensureRequestCards() {
  const wrap = document.querySelector('.cards');
  if (!wrap) return;
  if (!document.getElementById('cardDispatched')) {
    wrap.insertAdjacentHTML('beforeend', `
      <div class="card"><div><span>Dispatched</span><h2 id="cardDispatched">0</h2><p>On the way to customer</p></div><i class="fa-solid fa-truck-fast"></i></div>`);
  }
  if (!document.getElementById('cardPendingRequests')) {
    wrap.insertAdjacentHTML('beforeend', `
      <div class="card"><div><span>Pending Requests</span><h2 id="cardPendingRequests">0</h2><p>Awaiting admin/accounts approval</p></div><i class="fa-solid fa-hourglass-half"></i></div>
      <div class="card"><div><span>Rejected Requests</span><h2 id="cardRejectedRequests">0</h2><p>Declined by admin/accounts</p></div><i class="fa-solid fa-circle-xmark"></i></div>`);
  }
  const sel = document.getElementById('statusFilter');
  if (sel && !sel.querySelector('option[value="request_rejected"]')) {
    sel.insertAdjacentHTML('beforeend', '<option value="request_rejected">Rejected</option>');
  }
}

function wireOrderCardClicks() {
  ocvEnsure();
  const map = {
    cardTotalOrders: 'total', cardSalesAmount: 'sales', cardDispatched: 'dispatched', cardTodayOrders: 'today', cardDelivered: 'delivered',
    cardPendingOrders: 'pending', cardPendingRequests: 'pendingReq', cardRejectedRequests: 'rejectedReq'
  };
  Object.entries(map).forEach(([id, key]) => {
    const card = document.getElementById(id)?.closest('.card');
    if (!card) return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openOrderCardModal(key));
  });
}

function wireHeaderButtons() {
  const searchInput = document.querySelector('header input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      const filtered = doState.orders.filter(o =>
        (o.order_id || '').toLowerCase().includes(term) ||
        (o.items || []).some(it => (it.product_name || '').toLowerCase().includes(term)) ||
        (o.items || []).some(it => (it.model_no || '').toLowerCase().includes(term)) ||
        (o.items || []).some(it => (it.serial_numbers || []).some(sn => (sn || '').toLowerCase().includes(term))) ||
        (o.customer?.company_name || '').toLowerCase().includes(term)
      );
      doPage = 1;
      renderTable(filtered);
    });
  }
}

function wireFilter() {
  const filterBtn = document.getElementById('applyOrderFilter');
  if (!filterBtn) return;
  filterBtn.addEventListener('click', () => {
    const statusVal = document.getElementById('statusFilter')?.value || '';
    const filtered = doState.orders.filter(o => {
      if (statusVal === 'delivered') return o.status === 'delivered';
      if (statusVal === 'under_approval') return o.status === 'under_approval';
      if (statusVal === 'request_rejected') return o.status === 'request_rejected';
      if (statusVal === 'dispatched') return !o._isRequest && isDispatched(o);
      if (statusVal === 'pending') return !o._isRequest && o.status !== 'delivered' && o.status !== 'cancelled' && !isDispatched(o);
      return true;
    });
    doPage = 1;
    renderTable(filtered);
  });
}

function paymentDetailsLabel(o) {
  const mode = o.payment_mode;
  const d = o.payment_details || {};
  if (mode === 'Credit') return `Credit — ${d.credit_days ?? '-'} days`;
  if (mode === 'Partial') {
    const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return `Partial — ${inr(d.paid_amount)} paid, ${inr(d.balance_amount)} due in ${d.credit_days ?? '-'} days${d.due_date ? ' (by ' + d.due_date + ')' : ''}`;
  }
  if (mode === 'Cheque') return `Cheque #${d.cheque_number ?? '-'} (${d.cheque_date ?? '-'})${d.bank_name ? ', ' + d.bank_name : ''}`;
  if (mode === 'DemandDraft') return `DD #${d.dd_number ?? '-'} (${d.dd_date ?? '-'})${d.bank_name ? ', ' + d.bank_name : ''}`;
  if (mode === 'UPI') return `UPI — ${d.upi_id ?? '-'}`;
  if (mode === 'NetBanking') return `Net Banking — ${d.bank_name ?? '-'}, A/C ${d.account_number ?? '-'}, IFSC ${d.ifsc_code ?? '-'}`;
  if (mode === 'Cash') return `Cash — received by ${d.received_by ?? '-'}`;
  return mode || '-';
}

/* ================= Rich "Order Details" view (same look as admin Orders page) ================= */
const ITEM_TYPE_LABELS = { spare_parts: 'Spare Part', service_parts: 'Service Part', accessories: 'Accessory' };
const orderMoney = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const orderDate = d => d ? new Date(d).toLocaleDateString('en-GB') : '-';

function orderCreatorLabel(o) {
  const c = o.creator;
  if (!c) return '-';
  if (c.type === 'request') return `${c.raised_by ?? '-'} → ${c.approved_by ?? '-'}`;
  return c.created_by ?? c.raised_by ?? '-';
}

function itemMeta(it) {
  const list = doState.products || [];
  const id = (it.product_id || '').trim();
  const model = it.model_no || '';
  const inv = list.find(p => id && p.product_id === id && (p.model_no || '') === model)
    || (id && list.find(p => p.product_id === id))
    || list.find(p => p.product_name === it.product_name && (p.model_no || '') === model)
    || list.find(p => p.product_name === it.product_name);
  const type = it.product_type || inv?.product_type || 'product';
  const parent = it.parent_product_name || it.belongs_to || inv?.parent_product_name || '';
  return { type, typeLabel: ITEM_TYPE_LABELS[type] || '', parent, inv };
}

function productCellHtml(it) {
  const m = itemMeta(it);
  const pid = it.product_id || m.inv?.product_id || '';
  const model = it.model_no || m.inv?.model_no || '';
  const sub = [pid ? `ID: ${esc(pid)}` : '', model ? `Model: ${esc(model)}` : ''].filter(Boolean).join(' · ');
  const part = m.typeLabel
    ? `<div style="margin-top:3px;"><span class="ov-chip">${m.typeLabel}</span>${m.parent ? ` <span class="ov-sub">belongs to: <strong style="color:var(--text-secondary);">${esc(m.parent)}</strong></span>` : ''}</div>`
    : '';
  return `<strong>${esc(it.product_name ?? '')}</strong>${sub ? `<div class="ov-sub">${sub}</div>` : ''}${part}`;
}

function ensureOrderViewStyles() {
  if (document.getElementById('ov-style')) return;
  const st = document.createElement('style');
  st.id = 'ov-style';
  st.textContent = `
    #viewOrderModal .ov-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #e2e8f0}
    #viewOrderModal .ov-head h3{margin:0 0 4px}
    #viewOrderModal .ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px;margin-bottom:18px}
    #viewOrderModal .ov-cell{background:#f8fafc;border-radius:10px;padding:10px 12px}
    #viewOrderModal .ov-cell small{display:block;color:#64748b;font-size:11px;margin-bottom:2px}
    #viewOrderModal .ov-cell p{margin:0;font-size:14px;color:#0f172a;word-break:break-word}
    #viewOrderModal .ov-title{font-size:13px;font-weight:600;color:#334155;margin:4px 0 8px}
    #viewOrderModal .ov-scroll{overflow-x:auto;margin-bottom:18px;border:1px solid #e2e8f0;border-radius:10px}
    #viewOrderModal .ov-table{width:100%;border-collapse:collapse;font-size:13px;color:#1e293b}
    #viewOrderModal .ov-table th{background:#f1f5f9 !important;color:#334155 !important;text-align:left;padding:9px 12px;font-weight:600;white-space:nowrap}
    #viewOrderModal .ov-table td{padding:9px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top}
    #viewOrderModal .ov-table tr:last-child td{border-bottom:none}
    #viewOrderModal .ov-sub{color:#94a3b8;font-size:12px}
    #viewOrderModal .ov-chip{display:inline-block;background:#eaf1ff;color:#1665ff;border-radius:999px;padding:1px 9px;font-size:11px;font-weight:600}
    #viewOrderModal .ov-serial{display:inline-block;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin:2px 4px 0 0;font-size:11px;color:#334155}
    #viewOrderModal .ov-bottom{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
    #viewOrderModal .ov-notes{flex:1;min-width:260px;display:grid;gap:10px}
    #viewOrderModal .ov-totals{width:300px;max-width:100%;background:#f8fafc;border-radius:12px;padding:12px 16px;margin-left:auto}
    #viewOrderModal .ov-totals div{display:flex;justify-content:space-between;padding:5px 0;font-size:14px;color:#334155}
    #viewOrderModal .ov-totals .ov-grand{border-top:1px solid #e2e8f0;margin-top:4px;padding-top:9px;font-weight:700;font-size:16px;color:#0f172a}
    #viewOrderModal .ov-attach a{display:block;color:#1665ff;font-size:14px;text-decoration:none}
    #viewOrderModal .ov-attach a:hover{text-decoration:underline}`;
  document.head.appendChild(st);
}

function openViewOrderModal(o) {
  if (!o) return;
  const modal = document.getElementById('viewOrderModal');
  if (!modal) return;
  ensureOrderViewStyles();
  const content = modal.querySelector('.modal-content');
  content.style.cssText = 'background:#fff;border-radius:16px;padding:26px;width:min(1000px,95vw);max-height:90vh;overflow-y:auto;';
  const items = o.items || [];
  const customer = o.customer || {};
  const d = o.dispatch || null;
  const e = esc;
  const cell = (label, val) => `<div class="ov-cell"><small>${label}</small><p>${val || '-'}</p></div>`;

  const itemsRows = items.length
    ? items.map(it => {
      const lineTotal = it.line_total ?? ((it.price || 0) * (it.quantity || 0));
      const serials = (it.serial_numbers || []).map(s => `<span class="ov-serial">${e(s)}</span>`).join('');
      return `<tr>
          <td>${productCellHtml(it)}</td>
          <td>${serials || '<span class="ov-sub">—</span>'}</td>
          <td>${it.quantity ?? 0}</td>
          <td>${orderMoney(it.price)}</td>
          <td>${it.tax_rate ?? 0}%</td>
          <td><strong>${orderMoney(lineTotal)}</strong></td>
        </tr>`;
    }).join('')
    : `<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No items</td></tr>`;

  const returnedHtml = (o.returned_items || []).length ? `
    <div class="ov-title">Returned Product(s)</div>
    <div class="ov-scroll"><table class="ov-table">
      <thead><tr><th>Product</th><th>Serial No(s)</th><th>Qty</th><th>Condition</th></tr></thead>
      <tbody>${o.returned_items.map(r => `<tr>
        <td>${productCellHtml(r)}</td>
        <td>${(r.serial_numbers && r.serial_numbers.length) ? r.serial_numbers.map(s => `<span class="ov-serial">${e(s)}</span>`).join('') : '—'}</td>
        <td>${r.quantity ?? 0}</td>
        <td><span class="${r.condition === 'faulty' ? 'cancel' : 'delivered'}">${r.condition === 'faulty' ? 'Faulty' : 'OK'}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  const sparePartsHtml = (o.spare_parts || []).length ? `
    <div class="ov-title">Spare Parts</div>
    <div class="ov-scroll"><table class="ov-table">
      <thead><tr><th>Name</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>${o.spare_parts.map(sp => `<tr><td>${e(sp.name ?? '')}${sp.belongs_to ? `<div class="ov-sub">belongs to: ${e(sp.belongs_to)}</div>` : ''}</td><td>${sp.quantity ?? 0}</td><td>${orderMoney(sp.price)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  const attachHtml = (o.attachments || []).length
    ? `<div class="ov-cell ov-attach"><small>Attachments</small>${o.attachments.map((a, i) =>
      `<a href="#" class="attach-link" data-i="${i}"><i class="fa-solid fa-paperclip"></i> ${e(a.name)}</a>`).join('')}</div>` : '';

  const shipTo = o.ship_to_different && o.ship_to_address
    ? cell('Ship To', e([o.ship_to_address.company_name, o.ship_to_address.address].filter(Boolean).join(', '))) : '';

  const notes = [
    o.status === 'request_rejected' ? cell('Rejection Reason', e(o.reason || '')) : '',
    o.status === 'cancelled' ? cell('Cancellation Reason', e(o.cancel_reason || '')) : '',
    o.status === 'returned' ? cell('Return Reason', e(o.return_reason || '')) : '',
    o.order_remarks ? cell('Order Remarks', e(o.order_remarks)) : '',
    o.status === 'placed' && o.remark ? cell('Remark', e(o.remark)) : '',
    (o.edit_history || []).length ? cell('Last Edit Remark', e(o.edit_history[o.edit_history.length - 1].remark || '')) : '',
    shipTo,
    o.converted_from_demo ? cell('Source', 'Converted from demo unit') : '',
    attachHtml
  ].join('');

  const warrantyCell = o._isRequest ? '' :
    cell('Warranty', (o.warranty_years ?? 1) > 1 ? `${o.warranty_years} Years (Extended, +${orderMoney(o.warranty_charge)})` : 'Standard (1 Year)');

  content.innerHTML = `
    <div class="ov-head">
      <div>
        <h3>${o._isRequest ? 'Request Details' : 'Order Details'}</h3>
        <span class="ov-sub">${o._isRequest ? 'Request ID' : 'Order ID'}: ${e(o.order_id ?? '')}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="${statusClass(o.status, o)}">${statusLabel(o.status, o)}</span>
        <button class="close" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
      </div>
    </div>

    <div class="ov-grid">
      ${cell('Company', e(customer.company_name ?? ''))}
      ${cell('Address', e(customer.company_address ?? ''))}
      ${cell('GST Number', e(customer.gst_number ?? ''))}
      ${cell('Contact', e([customer.contractor_person, customer.contractor_number].filter(Boolean).join(' · ')))}
      ${cell('Order Date', orderDate(o.order_date))}
      ${cell('Payment', e(paymentDetailsLabel(o)))}
      ${cell('Reference', e(o.reference || o.creator?.raised_by || ''))}
      ${cell('Created By', e(orderCreatorLabel(o)))}
      ${warrantyCell}
      ${d ? cell('Invoice', e([d.invoice_no, d.invoice_date].filter(Boolean).join(' · '))) : ''}
      ${d ? cell('Docket / Delivery', e([d.docket_no, d.mode_of_delivery].filter(Boolean).join(' · '))) : ''}
    </div>

    <div class="ov-title">Products</div>
    <div class="ov-scroll"><table class="ov-table">
      <thead><tr><th>Product</th><th>Serial No(s)</th><th>Qty</th><th>Price</th><th>Tax</th><th>Line Total</th></tr></thead>
      <tbody>${itemsRows}</tbody>
    </table></div>

    ${sparePartsHtml}
    ${returnedHtml}

    <div class="ov-bottom">
      <div class="ov-notes">${notes}</div>
      <div class="ov-totals">
        <div><span>Subtotal</span><span>${orderMoney(o.subtotal)}</span></div>
        <div><span>Tax</span><span>${orderMoney(o.tax_total)}</span></div>
        <div><span>Discount</span><span>- ${orderMoney(o.discount)}</span></div>
        <div class="ov-grand"><span>Total Amount</span><span>${orderMoney(o.total_mrp)}</span></div>
      </div>
    </div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelectorAll('.attach-link').forEach(link => link.addEventListener('click', async ev => {
    ev.preventDefault();
    const a = o.attachments[Number(link.dataset.i)];
    try {
      const res = await apiFetch(`/order_attachment/${a.request_id}/${a.stored_name}`);
      if (!res.ok) throw new Error('could not download file');
      const url = URL.createObjectURL(await res.blob());
      const tmp = document.createElement('a');
      tmp.href = url; tmp.download = a.name; tmp.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  }));
  modal.style.display = 'flex';
}

function wireViewModalClose() {
  const modal = document.getElementById('viewOrderModal');
  if (modal) modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });
}

const orderWiz = { customerId: '', customer: null, cart: {}, discount: 0, remarks: '', shipDiff: false, shipCompany: '', shipAddress: '' };

function resetOrderWiz() {
  orderWiz.customerId = '';
  orderWiz.customer = null;
  orderWiz.cart = {};
  orderWiz.discount = 0;
  orderWiz.remarks = '';
  orderWiz.shipDiff = false; orderWiz.shipCompany = ''; orderWiz.shipAddress = '';
}

function injectOrderModal() {
  const modal = document.getElementById('orderModal');
  if (!modal) return;
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.style.display = 'none'; });

  const btn = document.getElementById('createOrderBtn');
  if (btn) btn.addEventListener('click', () => { resetOrderWiz(); modal.style.display = 'flex'; renderCustomerTypeStep(); });
}

function wizBody() { return document.querySelector('#orderModal .modal-content'); }

function wizHeader(title) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${title}</h3>
      <button type="button" class="wizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>`;
}

function wireWizClose() {
  wizBody().querySelector('.wizClose')?.addEventListener('click', () => {
    document.getElementById('orderModal').style.display = 'none';
  });
}

function renderCustomerTypeStep() {
  wizBody().innerHTML = wizHeader('New Order — Customer') + `
    <p style="color:#64748b;margin-bottom:14px;">Is this order for an existing customer or a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-address-book"></i><br>Existing Customer
      </button>
      <button id="btnNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-user-plus"></i><br>New Customer
      </button>
    </div>`;
  wireWizClose();
  document.getElementById('btnExisting').addEventListener('click', renderExistingCustomerStep);
  document.getElementById('btnNew').addEventListener('click', renderNewCustomerStep);
}

function renderExistingCustomerStep() {
  wizBody().innerHTML = wizHeader('New Order — Select Customer') + `
    <input id="custSearch" placeholder="Search company, GST or contact person" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="custResults" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="display:flex;justify-content:flex-start;margin-top:14px;">
      <button type="button" id="backBtn1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  wireWizClose();
  document.getElementById('backBtn1').addEventListener('click', renderCustomerTypeStep);

  const searchInput = document.getElementById('custSearch');
  const resultsBox = document.getElementById('custResults');

  const runSearch = async () => {
    resultsBox.innerHTML = '<small style="color:#94a3b8;">Searching...</small>';
    try {
      const term = searchInput.value.trim();
      const res = await apiFetch(`/customer/search?term=${encodeURIComponent(term)}`);
      const data = await res.json();
      const list = data.dataset || [];
      if (!list.length) { resultsBox.innerHTML = '<small style="color:#94a3b8;">No customers found.</small>'; return; }
      resultsBox.innerHTML = list.map(c => `
        <div class="cust-row" data-id="${c.customer_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
          <strong>${esc(c.company_name ?? '')}</strong><br>
          <small style="color:#64748b;">${esc(c.gst_number ?? '')} • ${esc(c.contractor_person ?? '')} • ${esc(c.contractor_number ?? '')}</small>
        </div>`).join('');
      resultsBox.querySelectorAll('.cust-row').forEach(row => row.addEventListener('click', () => {
        const c = list.find(x => x.customer_id === row.dataset.id);
        orderWiz.customerId = c.customer_id;
        orderWiz.customer = c;
        renderProductsStep();
      }));
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultsBox.innerHTML = '<small style="color:#d62828;">Search failed.</small>';
    }
  };
  let debounce;
  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  runSearch();
}

function renderNewCustomerStep() {
  wizBody().innerHTML = wizHeader('New Order — New Customer') + `
    <form id="newCustForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company Name" required>
      <input name="company_address" placeholder="Company Address" required>
      <input name="gst_number" placeholder="GST Number (if applicable)">
      <input name="contractor_person" placeholder="Contact Person" required>
      <input name="contractor_number" placeholder="Contact Number" required>
      <input name="contractor_email" type="email" placeholder="Contact Email">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backBtn2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  wireWizClose();
  document.getElementById('backBtn2').addEventListener('click', renderCustomerTypeStep);
  document.getElementById('newCustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      company_name: fd.get('company_name'),
      company_address: fd.get('company_address'),
      gst_number: fd.get('gst_number') || '',
      contractor_person: fd.get('contractor_person'),
      contractor_number: fd.get('contractor_number'),
      contractor_email: fd.get('contractor_email') || '',
    };
    try {
      const res = await apiFetch('/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'customer creation failed');
      orderWiz.customerId = data.customer_id;
      orderWiz.customer = data.customer || payload;
      renderProductsStep();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function rowKeyFor(p) {
  const type = p.product_type || 'product';
  const parent = (type === 'spare_parts' || type === 'service_parts') ? (p.parent_product_name || '').trim().toLowerCase() : '';
  return `${(p.product_name || '').trim().toLowerCase()}||${(p.model_no || '').trim().toLowerCase()}||${type}||${parent}`;
}

function dedupeProducts(rawProducts) {
  const map = new Map();
  for (const p of rawProducts) {
    const type = p.product_type || 'product';
    const qty = Number(p.quantity) || 0;
    if (type === 'damaged' || qty <= 0) continue;
    const key = rowKeyFor(p);
    const prev = map.get(key);
    if (!prev) { map.set(key, { ...p, quantity: qty, _latest: p.purchase_date || '' }); continue; }
    const newer = (p.purchase_date || '') > prev._latest;
    const base = newer ? { ...p, _latest: p.purchase_date || '' } : prev;
    map.set(key, { ...base, quantity: prev.quantity + qty });
  }
  return Array.from(map.values());
}

function renderProductsStep() {
  const products = dedupeProducts(doState.products || []);
  wizBody().innerHTML = wizHeader(`New Order — ${esc(orderWiz.customer?.company_name ?? 'Products')}`) + `
    <div id="prodCatTabs" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;"></div>
    <input id="prodFilter" placeholder="Filter by name, ID or model..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;color:#fff;"><th>Product</th><th style="width:70px;">Qty</th><th style="width:100px;">Price</th></tr></thead>
        <tbody id="prodRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <button type="button" id="backBtn3" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="toPaymentBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
    </div>`;
  wireWizClose();
  document.getElementById('backBtn3').addEventListener('click', () => orderWiz.customerId ? renderExistingCustomerStep() : renderNewCustomerStep());

  const catTabsBox = document.getElementById('prodCatTabs');
  const categories = [
    { type: 'product', label: 'Products' },
    { type: 'accessories', label: 'Accessories' },
    { type: 'spare_parts', label: 'Spare Parts' },
    { type: 'service_parts', label: 'Service Parts' }
  ];
  let activeCategory = 'product';

  function paintCatTab(btn, active) {
    btn.style.border = active ? '1px solid #1665ff' : '1px solid #e2e8f0';
    btn.style.background = active ? '#eaf1ff' : '#f8fafc';
    btn.style.color = active ? '#1665ff' : '#334155';
    btn.style.borderRadius = '8px';
    btn.style.padding = '8px 14px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
  }

  catTabsBox.innerHTML = categories.map(c => `<button type="button" class="prod-cat-btn" data-type="${c.type}">${c.label}</button>`).join('');
  catTabsBox.querySelectorAll('.prod-cat-btn').forEach(btn => {
    paintCatTab(btn, btn.dataset.type === activeCategory);
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.type;
      catTabsBox.querySelectorAll('.prod-cat-btn').forEach(b => paintCatTab(b, b.dataset.type === activeCategory));
      applyFilters();
    });
  });

  const rowsBox = document.getElementById('prodRows');

  function productRowHtml(p) {
    const key = rowKeyFor(p);
    const cartLine = orderWiz.cart[key];
    const qtyInCart = cartLine?.quantity ?? '';
    const priceInCart = cartLine?.price ?? '';
    const isPart = p.product_type === 'spare_parts' || p.product_type === 'service_parts';
    const sub = [
      p.product_id ? 'ID: ' + esc(p.product_id) : '',
      p.model_no ? 'Model: ' + esc(p.model_no) : '',
      isPart ? 'Belongs to: ' + esc(p.parent_product_name || '—') : ''
    ].filter(Boolean).join(' · ');
    return `
      <tr>
        <td>${esc(p.product_name ?? '')}<br><small style="color:#94a3b8;">${sub}</small></td>
        <td><input type="number" min="0" inputmode="numeric" value="${qtyInCart}"
              placeholder="0" data-row-key="${esc(key)}" class="qtyInput"
              style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
        <td><input type="number" min="0" inputmode="decimal" value="${priceInCart}"
              placeholder="₹0" data-row-key="${esc(key)}" class="priceInput"
              style="width:85px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;"></td>
      </tr>`;
  }

  function renderRows(list) { rowsBox.innerHTML = list.map(productRowHtml).join(''); }

  function computeTypedQty(inp) {
    if (!inp || inp.value.trim() === '') return null;
    let qty = Math.floor(Math.max(0, Number(inp.value)));
    if (!Number.isFinite(qty)) qty = 0;
    return qty;
  }

  function computeTypedPrice(inp) {
    if (!inp || inp.value.trim() === '') return null;
    let price = Math.max(0, Number(inp.value));
    if (!Number.isFinite(price)) price = 0;
    return price;
  }

  function findRowInput(cls, key) {
    return [...rowsBox.querySelectorAll('.' + cls)].find(i => i.dataset.rowKey === key) || null;
  }

  function syncRowToCart(key, p) {
    const qtyInp = findRowInput('qtyInput', key);
    const priceInp = findRowInput('priceInput', key);
    const qty = computeTypedQty(qtyInp);

    if (qty === null || qty <= 0) { delete orderWiz.cart[key]; return; }

    const price = computeTypedPrice(priceInp) ?? 0;
    orderWiz.cart[key] = {
      product_id: p.product_id,
      product_name: p.product_name,
      model_no: p.model_no || '',
      product_type: p.product_type || 'product',
      price,
      tax_rate: Number(p.tax_rate) || 0,
      quantity: qty
    };
  }

  rowsBox.addEventListener('input', (e) => {
    const inp = e.target.closest('.qtyInput, .priceInput');
    if (!inp) return;
    const key = inp.dataset.rowKey;
    const p = products.find(x => rowKeyFor(x) === key);
    if (!p) return;
    syncRowToCart(key, p);
  });

  function currentCategoryProducts() {
    return products.filter(p => (p.product_type || 'product') === activeCategory);
  }

  function applyFilters() {
    const term = document.getElementById('prodFilter').value.trim().toLowerCase();
    const base = currentCategoryProducts();
    const filtered = term
      ? base.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term) || (p.model_no || '').toLowerCase().includes(term) || (p.parent_product_name || '').toLowerCase().includes(term))
      : base;
    renderRows(filtered);
  }

  applyFilters();
  if (!products.length) {
    rowsBox.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:16px;color:#94a3b8;">
      No products loaded. <button type="button" id="retryInvBtn" style="border:none;background:#eef2ff;color:#2563eb;padding:4px 10px;border-radius:6px;cursor:pointer;">Retry</button>
    </td></tr>`;
    document.getElementById('retryInvBtn')?.addEventListener('click', async () => {
      await loadInventoryForOrders();
      renderProductsStep();
    });
  }

  document.getElementById('prodFilter').addEventListener('input', applyFilters);

  document.getElementById('toPaymentBtn').addEventListener('click', () => {
    rowsBox.querySelectorAll('.qtyInput').forEach(inp => {
      const key = inp.dataset.rowKey;
      const p = products.find(x => rowKeyFor(x) === key);
      if (p) syncRowToCart(key, p);
    });
    const cartItems = Object.values(orderWiz.cart);
    if (!cartItems.length) { alert('Add quantity for at least one product.'); return; }
    if (cartItems.some(i => !i.price || i.price <= 0)) { alert('Enter a price for every product you added.'); return; }
    renderPaymentStep();
  });
}

function renderPaymentStep() {
  const cartItems = Object.values(orderWiz.cart);
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);

  wizBody().innerHTML = wizHeader('New Order — Payment') + `
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
      ${cartItems.map(i => `
        <div style="padding:4px 0;">
          <strong>${esc(i.product_name)}</strong> × ${i.quantity} = ₹${(i.price * i.quantity).toFixed(2)}
          ${(i.product_id || i.model_no) ? `<div style="font-size:11px;color:#94a3b8;">${[i.product_id ? 'ID: ' + esc(i.product_id) : '', i.model_no ? 'Model: ' + esc(i.model_no) : ''].filter(Boolean).join(' · ')}</div>` : ''}
        </div>`).join('')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">
      Subtotal: ₹${subtotal.toFixed(2)}
    </div>
    <select id="paymentMode" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
      <option value="">Select Payment Mode</option>
      ${PAYMENT_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
    </select>
    <div id="paymentExtra"></div>
    <input id="discountInput" type="number" min="0" placeholder="Discount (₹)" value="0" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;">
    <label style="font-size:13px;color:#475569;display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <input type="checkbox" id="shipDiffCheck" ${orderWiz.shipDiff ? 'checked' : ''}> Ship To address is different from Bill To
    </label>
    <div id="shipDiffFields" style="display:${orderWiz.shipDiff ? 'flex' : 'none'};flex-direction:column;gap:8px;margin-bottom:10px;">
      <input id="shipCompany" placeholder="Ship To — Company Name" value="${esc(orderWiz.shipCompany || '')}" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">
      <textarea id="shipAddress" rows="2" placeholder="Ship To — Address" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;">${esc(orderWiz.shipAddress || '')}</textarea>
    </div>
    <textarea id="orderRemarks" rows="3" maxlength="1000" placeholder="Remarks (optional) — anything related to this order" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:0 0 10px;box-sizing:border-box;resize:vertical;">${esc(orderWiz.remarks || '')}</textarea>
    <label style="font-size:13px;color:#64748b;">Attach P.O. / documents (optional — PDF, image, Excel, Word · max 5 files, 10 MB each)</label>
    <input id="orderFiles" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.doc,.docx" style="width:100%;padding:8px;border:1px dashed #cbd5e1;border-radius:8px;margin:6px 0 10px;">
    <div style="display:flex;justify-content:space-between;margin-top:10px;">
      <button type="button" id="backBtn4" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
      <button type="button" id="sendRequestBtn" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Send Request</button>
    </div>`;
  wireWizClose();
  document.getElementById('backBtn4').addEventListener('click', renderProductsStep);

  const modeSelect = document.getElementById('paymentMode');
  const extraBox = document.getElementById('paymentExtra');
  modeSelect.addEventListener('change', () => renderPaymentExtra(modeSelect.value, extraBox));

  document.getElementById('discountInput').addEventListener('input', e => orderWiz.discount = Number(e.target.value) || 0);
  document.getElementById('orderRemarks').addEventListener('input', e => orderWiz.remarks = e.target.value);
  document.getElementById('shipDiffCheck').addEventListener('change', e => {
    orderWiz.shipDiff = e.target.checked;
    document.getElementById('shipDiffFields').style.display = e.target.checked ? 'flex' : 'none';
  });
  document.getElementById('shipCompany').addEventListener('input', e => orderWiz.shipCompany = e.target.value);
  document.getElementById('shipAddress').addEventListener('input', e => orderWiz.shipAddress = e.target.value);

  document.getElementById('sendRequestBtn').addEventListener('click', () => submitOrderRequest(modeSelect, extraBox));
}

function renderPaymentExtra(mode, extraBox) {
  if (mode === 'Credit') {
    extraBox.innerHTML = `
      <label style="font-size:13px;color:#64748b;">Credit Period</label>
      <select id="creditDaysSelect" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
        <option value="15">15 days</option><option value="30">30 days</option>
        <option value="45">45 days</option><option value="60">60 days</option>
        <option value="manual">Other (enter days)</option>
      </select>
      <input id="creditDaysManual" type="number" min="1" max="60" placeholder="Enter days (max 60)" style="display:none;width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
    const sel = document.getElementById('creditDaysSelect');
    const manual = document.getElementById('creditDaysManual');
    sel.addEventListener('change', () => manual.style.display = sel.value === 'manual' ? 'block' : 'none');
  } else if (mode === 'Cheque') {
    extraBox.innerHTML = `
      <input id="chequeNumber" placeholder="Cheque Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="chequeDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="chequeBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'DemandDraft') {
    extraBox.innerHTML = `
      <input id="ddNumber" placeholder="Demand Draft Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="ddDate" type="date" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="ddBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'UPI') {
    extraBox.innerHTML = `<input id="upiId" placeholder="UPI ID (e.g. name@bank)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else if (mode === 'NetBanking') {
    extraBox.innerHTML = `
      <input id="nbBank" placeholder="Bank Name" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbAccount" placeholder="Account Number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">
      <input id="nbIfsc" placeholder="IFSC Code" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  } else if (mode === 'Cash') {
    extraBox.innerHTML = `<input id="cashReceivedBy" placeholder="Received By (Person Name)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;">`;
  } else {
    extraBox.innerHTML = '';
  }
}

function buildPaymentDetails(mode) {
  if (mode === 'Credit') {
    const sel = document.getElementById('creditDaysSelect');
    const manual = document.getElementById('creditDaysManual');
    const days = sel.value === 'manual' ? Number(manual.value) : Number(sel.value);
    if (!days || days < 1 || days > 60) throw new Error('Credit days must be between 1 and 60.');
    return { credit_days: days };
  }
  if (mode === 'Cheque') {
    const cheque_number = document.getElementById('chequeNumber').value.trim();
    const cheque_date = document.getElementById('chequeDate').value;
    const bank_name = document.getElementById('chequeBank').value.trim();
    if (!cheque_number || !cheque_date) throw new Error('Cheque number and date are required.');
    return { cheque_number, cheque_date, bank_name };
  }
  if (mode === 'DemandDraft') {
    const dd_number = document.getElementById('ddNumber').value.trim();
    const dd_date = document.getElementById('ddDate').value;
    const bank_name = document.getElementById('ddBank').value.trim();
    if (!dd_number || !dd_date) throw new Error('Demand draft number and date are required.');
    return { dd_number, dd_date, bank_name };
  }
  if (mode === 'UPI') {
    const upi_id = document.getElementById('upiId').value.trim();
    if (!upi_id) throw new Error('UPI ID is required.');
    return { upi_id };
  }
  if (mode === 'NetBanking') {
    const bank_name = document.getElementById('nbBank').value.trim();
    const account_number = document.getElementById('nbAccount').value.trim();
    const ifsc_code = document.getElementById('nbIfsc').value.trim();
    if (!bank_name || !account_number || !ifsc_code) throw new Error('Bank name, account number and IFSC code are required.');
    return { bank_name, account_number, ifsc_code };
  }
  if (mode === 'Cash') {
    const received_by = document.getElementById('cashReceivedBy').value.trim();
    if (!received_by) throw new Error('Received-by person name is required.');
    return { received_by };
  }
  return {};
}

async function submitOrderRequest(modeSelect, extraBox) {
  const mode = modeSelect.value;
  if (!mode) { alert('Please select a payment mode.'); return; }

  let payment_details;
  try {
    payment_details = buildPaymentDetails(mode);
  } catch (err) {
    alert(err.message);
    return;
  }

  if (orderWiz.shipDiff && (!(orderWiz.shipCompany || '').trim() || !(orderWiz.shipAddress || '').trim())) {
    alert('Please enter Ship To company name and address.');
    return;
  }

  const payload = {
    customer_id: orderWiz.customerId || '',
    customer: orderWiz.customer || {},
    items: Object.values(orderWiz.cart).map(i => ({
      product_id: i.product_id, product_name: i.product_name, model_no: i.model_no || '', product_type: i.product_type || '',
      quantity: i.quantity, price: i.price, tax_rate: i.tax_rate
    })),
    payment_mode: mode,
    payment_details,
    discount: orderWiz.discount || 0,
    remarks: (orderWiz.remarks || '').trim(),
    ship_to_different: !!orderWiz.shipDiff,
    ship_to_address: orderWiz.shipDiff ? { company_name: orderWiz.shipCompany.trim(), address: orderWiz.shipAddress.trim() } : null
  };

  try {
    const res = await apiFetch('/request/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'request failed');

    let uploadWarning = '';
    const chosen = Array.from(document.getElementById('orderFiles')?.files || []);
    if (chosen.length) {
      try {
        const fd = new FormData();
        chosen.forEach(f => fd.append('files', f));
        const up = await apiFetch(`/request/order/${data.request_id}/attachments`, { method: 'POST', body: fd });
        if (!up.ok) throw new Error((await up.json()).detail || 'upload failed');
      } catch (e) {
        uploadWarning = ` Files could not be attached: ${e.message}`;
      }
    }

    document.getElementById('orderModal').style.display = 'none';
    resetOrderWiz();
    alert('Order request sent — admin/accounts will review and approve it.' + uploadWarning);
    await loadOrders();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  }
}

const sl = { range: 'week', day: '' };
const slFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function slBuckets() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const b = [];
  if (sl.range === 'today' || sl.range === 'day') {
    const base = sl.range === 'day' && sl.day ? new Date(sl.day + 'T00:00:00') : new Date(y, m, d);
    for (let h = 0; h < 24; h++) b.push({ label: `${String(h).padStart(2, '0')}:00`, from: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h), to: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h + 1) });
  } else if (sl.range === 'week') {
    for (let i = 6; i >= 0; i--) {
      const f = new Date(y, m, d - i);
      b.push({ label: `${f.getDate()} ${MONTHS[f.getMonth()]}`, from: f, to: new Date(y, m, d - i + 1) });
    }
  } else if (sl.range === 'month') {
    const n = new Date(y, m + 1, 0).getDate();
    for (let i = 1; i <= n; i++) b.push({ label: `${i} ${MONTHS[m]}`, from: new Date(y, m, i), to: new Date(y, m, i + 1) });
  } else {
    for (let i = 0; i < 12; i++) b.push({ label: `${MONTHS[i]} ${y}`, from: new Date(y, i, 1), to: new Date(y, i + 1, 1) });
  }
  b.forEach(x => { x.amount = 0; x.count = 0; });
  doState.orders.filter(o => !o._isRequest && o.status !== 'cancelled' && o.order_date).forEach(o => {
    const t = new Date(o.order_date);
    const x = b.find(k => t >= k.from && t < k.to);
    if (x) { x.amount += Number(o.total_mrp) || 0; x.count++; }
  });
  return b;
}

function slChartSvg(b) {
  const W = 620, H = 280, L = 62, R = 16, T = 16, B = 44;
  const max = Math.max(...b.map(x => x.amount), 1);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const iw = W - L - R, ih = H - T - B;
  const px = i => L + (b.length === 1 ? iw / 2 : (i * iw) / (b.length - 1));
  const py = v => T + ih - (v / top) * ih;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i, y = py(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#e2e8f0"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${v >= 100000 ? (v / 100000).toFixed(1) + 'L' : v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : Math.round(v)}</text>`;
  }
  const every = Math.ceil(b.length / 8);
  b.forEach((x, i) => {
    if (i % every === 0 || i === b.length - 1) g += `<text x="${px(i)}" y="${H - 22}" text-anchor="middle" font-size="10" fill="#64748b">${x.label}</text>`;
  });
  const pts = b.map((x, i) => `${px(i)},${py(x.amount)}`).join(' ');
  const area = `${px(0)},${py(0)} ${pts} ${px(b.length - 1)},${py(0)}`;
  const dots = b.map((x, i) => `<circle cx="${px(i)}" cy="${py(x.amount)}" r="${b.length > 14 ? 3 : 4.5}" fill="#1665ff" stroke="#fff" stroke-width="1.5"><title>${x.label}: ${slFmt(x.amount)} (${x.count} order${x.count === 1 ? '' : 's'})</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:#fff"><polygon points="${area}" fill="#1665ff" fill-opacity=".08"/>${g}<polyline points="${pts}" fill="none" stroke="#1665ff" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>`;
}

function slPaint() {
  const b = slBuckets();
  const total = b.reduce((s, x) => s + x.amount, 0);
  const cnt = b.reduce((s, x) => s + x.count, 0);
  const best = b.reduce((a, x) => (x.amount > a.amount ? x : a), b[0]);
  document.getElementById('slChart').innerHTML = slChartSvg(b);
  document.getElementById('slKpi').innerHTML = `
    <div><span>Total Sales</span><b>${slFmt(total)}</b></div>
    <div><span>Orders</span><b>${cnt}</b></div>
    <div><span>Avg / Order</span><b>${slFmt(cnt ? total / cnt : 0)}</b></div>
    <div><span>Best ${sl.range === 'year' ? 'Month' : (sl.range === 'today' || sl.range === 'day') ? 'Hour' : 'Day'}</span><b>${best && best.amount ? esc(best.label) : '-'}</b></div>`;
  document.getElementById('slRows').innerHTML = b.map(x => `<tr><td>${x.label}</td><td>${x.count}</td><td>${slFmt(x.amount)}</td></tr>`).join('');
  document.querySelectorAll('.sl-tab').forEach(t => t.classList.toggle('on', t.dataset.r === sl.range));
}

function openSalesModal() {
  const modal = ocvEnsure();
  sl.range = 'week'; sl.day = '';
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div class="oc-head"><h3>Sales Amount</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button></div>
    <div class="sl-bar">
      <button class="sl-tab" data-r="today">Today</button>
      <button class="sl-tab" data-r="week">Week</button>
      <button class="sl-tab" data-r="month">Month</button>
      <button class="sl-tab" data-r="year">Year</button>
      <label style="font-size:12px;color:#64748b;margin-left:8px;">Pick day</label>
      <input type="date" id="slDay">
    </div>
    <div class="sl-main">
      <div class="sl-chart" id="slChart"></div>
      <div class="sl-side">
        <div class="sl-kpi" id="slKpi"></div>
        <div class="sl-list"><table><thead><tr><th>Period</th><th>Orders</th><th>Amount</th></tr></thead><tbody id="slRows"></tbody></table></div>
      </div>
    </div>
    <p style="font-size:11.5px;color:#94a3b8;margin-top:8px;">Cancelled orders and pending requests are excluded. Week = last 7 days.</p>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelectorAll('.sl-tab').forEach(t => t.addEventListener('click', () => {
    sl.range = t.dataset.r; sl.day = ''; content.querySelector('#slDay').value = ''; slPaint();
  }));
  content.querySelector('#slDay').addEventListener('change', e => {
    if (!e.target.value) return;
    sl.range = 'day'; sl.day = e.target.value; slPaint();
  });
  slPaint();
  modal.style.display = 'flex';
}