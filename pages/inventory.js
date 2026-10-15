/* ---- A4 print support: print_a4.js is loaded on demand (safe if it is missing) ---- */
(function () { if (typeof A4Print === 'undefined' && !document.getElementById('a4printjs')) { const s = document.createElement('script'); s.id = 'a4printjs'; s.src = 'print_a4.js'; document.head.appendChild(s); } })();
function a4Ready(cb, n) { n = n || 0; if (typeof A4Print !== 'undefined') return cb(); if (n < 50) setTimeout(() => a4Ready(cb, n + 1), 200); }
function a4Intercept(head, rows, name) { return typeof A4Print !== 'undefined' && A4Print.intercept(head, rows, name); }
function a4WizardPrint(modal, title) { if (typeof A4Print !== 'undefined') A4Print.wizardPrint(modal, title); }
function a4Twin(btn, title) { if (btn) a4Ready(() => A4Print.attachTwin(btn, title)); }
const invState = { products: [], activeProductId: null, activeModelNo: '', activeId: '', searchId: '', activeProductType: 'product', activeCategory: null, searchQuery: '', activeFilters: null, editSerials: [], editRemovedSerials: [], editFaultySerials: [], editHolograms: [], editHologramQuantity: 0 };
let invPage = 1;
const INV_PAGE_SIZE = 20;

// Some inventory documents were created before product_id was required and
// can have product_id === "". An empty string can never appear as a URL
// path segment (the /inventory/*/{product_id} routes simply won't match a
// missing segment), so we substitute this sentinel whenever we need to
// target such a record over the network — app.py decodes it back to "".
const EMPTY_PRODUCT_ID_SENTINEL = '__blank_id__';

// Product ID is no longer typed in by hand anywhere on this page. Every
// product created or edited from here gets this fixed value (a single space).
const DEFAULT_PRODUCT_ID = ' ';
// A space-only id gets trimmed away if it is sent as a URL path segment, so it
// travels as this sentinel instead — app.py decodes it back to " ".
const SPACE_PRODUCT_ID_SENTINEL = '__space_id__';

function urlProductId(id) {
  const raw = (id ?? '').toString();
  if (raw && !raw.trim()) return encodeURIComponent(SPACE_PRODUCT_ID_SENTINEL);
  const v = raw.trim();
  return encodeURIComponent(v ? v : EMPTY_PRODUCT_ID_SENTINEL);
}

function refreshIfMissing(err) {
  if (err && /not found|invalid id/i.test(err.message || '')) loadInventory();
}

function lockOnce(fn) {
  let busy = false;
  return async function (ev) {
    if (busy) { if (ev && ev.preventDefault) ev.preventDefault(); return; }
    busy = true;
    const root = ev && ev.target && ev.target.querySelectorAll ? ev.target : null;
    const btns = root ? [...root.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')] : [];
    if (ev && ev.currentTarget && ev.currentTarget.tagName === 'BUTTON') btns.push(ev.currentTarget);
    btns.forEach(b => { b.disabled = true; });
    try { return await fn.apply(this, arguments); }
    finally { busy = false; btns.forEach(b => { b.disabled = false; }); }
  };
}

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
  loadInventory();
  wireTopActions();
  wireFilter();
  wireCategoryFilter();
  wireHeaderSearch();
  wireModals();
  wireCardClicks();
  wireSerialRecordModal();
  applyRolePermissions();
});

// ---------- "Record" — full lifetime history lookup by serial number ----------
function wireSerialRecordModal() {
  const btn = document.querySelector('.top-actions .record-search');
  const modal = document.getElementById('serialRecordModal');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => openSerialRecordModal());

  function renderSearchForm(prefill) {
    const content = modal.querySelector('.modal-content');
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3>Record — Serial Number History</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px;">Search a serial number to see its full lifetime record — when it was added to inventory, assembled, sold/demoed, returned, and every service raised against it.</p>
      <div style="display:flex;gap:8px;">
        <input id="serialRecordInput" placeholder="Enter serial number" value="${prefill ? escapeHtmlInv(prefill) : ''}" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;">
        <button type="button" id="serialRecordSearchBtn" style="padding:10px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;">Search</button>
      </div>
      <div id="serialRecordResults" style="margin-top:16px;"></div>`;

    content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
    const input = content.querySelector('#serialRecordInput');
    const search = () => runSerialSearch(input.value.trim());
    content.querySelector('#serialRecordSearchBtn').addEventListener('click', search);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    if (prefill) search();
    input.focus();
  }

  async function runSerialSearch(serial) {
    const resultsBox = modal.querySelector('#serialRecordResults');
    if (!serial) { resultsBox.innerHTML = '<p style="color:var(--danger);font-size:13px;">Enter a serial number to search.</p>'; return; }
    resultsBox.innerHTML = '<p style="color:var(--text-light);font-size:13px;">Searching...</p>';
    // serials are stored lowercase (see wireEditSerialFileUpload / the add-product
    // wizard) — lowercase here too so a serial typed in a different case still matches.
    // server matches case-insensitively (stored serials are not all lowercase)
    const normalizedSerial = serial.trim();
    try {
      const res = await apiFetch(`/inventory/serial_history/${encodeURIComponent(normalizedSerial)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'search failed');
      resultsBox.innerHTML = renderSerialTimeline(data.events || [], serial);
    } catch (err) {
      if (err.message === 'unauthorized' || err.message === 'forbidden') return;
      resultsBox.innerHTML = `<p style="color:var(--danger);font-size:13px;">${escapeHtmlInv(err.message)}</p>`;
    }
  }

  function openSerialRecordModal(prefill) {
    renderSearchForm(prefill);
    modal.style.display = 'flex';
  }

  // Allow other parts of the page (e.g. a row's serial number) to jump
  // straight into a search for that serial.
  window.openSerialRecordModal = openSerialRecordModal;
}

function escapeHtmlInv(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

const SERIAL_EVENT_ICONS = {
  inventory: 'fa-warehouse',
  assembly: 'fa-gears',
  order: 'fa-cart-shopping',
  order_return: 'fa-rotate-left',
  allocation: 'fa-people-carry-box',
  allocation_return: 'fa-rotate-left',
  service: 'fa-screwdriver-wrench',
};

function serialEventDetailLine(ev) {
  const d = ev.details || {};
  switch (ev.type) {
    case 'inventory':
      return `${d.product_name ?? ''} ${d.model_no ? '· ' + d.model_no : ''} — Supplier: ${d.supplier ?? '-'}${d.reason ? ` — ${d.reason}` : ''}`;
    case 'assembly':
      return `${d.product_name ?? ''} — Assembly #${(d.assembly_id || '').slice(0, 8)}${d.hologram_number ? ' — Hologram ' + d.hologram_number : ''} — ${d.status ?? ''}`;
    case 'order':
      return `${d.product_name ?? ''} — Order #${(d.order_id || '').slice(0, 8)} — ${d.company_name ?? '-'} — Status: ${d.status ?? ''}`;
    case 'order_return':
      return `Order #${(d.order_id || '').slice(0, 8)} — Condition: ${d.condition ?? '-'} — Reason: ${d.reason ?? '-'}`;
    case 'allocation':
      return `${d.product_name ?? ''} — To: ${d.to ?? '-'}${d.allocated_by ? ' (by ' + d.allocated_by + ')' : ''} — Status: ${d.return_status ?? ''}`;
    case 'allocation_return':
      return `Allocation #${(d.allocation_id || '').slice(0, 8)} — by ${d.returned_by ?? '-'}${d.faulty ? ' — Faulty' + (d.issue ? ': ' + d.issue : '') : ' — OK'}`;
    case 'service':
      return `Service #${(d.service_id || '').slice(0, 8)} — ${d.issue ?? ''} — Status: ${d.status ?? ''}`;
    default:
      return '';
  }
}

function renderSerialTimeline(events, serial) {
  if (!events.length) {
    return `<p style="color:var(--text-light);font-size:13px;text-align:center;padding:16px;">No record found for serial number <strong>${escapeHtmlInv(serial)}</strong>.</p>`;
  }
  return `
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">Lifetime record for <strong>${escapeHtmlInv(serial)}</strong> (${events.length} event${events.length > 1 ? 's' : ''})</div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${events.map(ev => `
        <div style="border-left:3px solid var(--primary);padding-left:12px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <strong style="font-size:13px;"><i class="fa-solid ${SERIAL_EVENT_ICONS[ev.type] || 'fa-circle-dot'}" style="margin-right:6px;color:var(--primary);"></i>${escapeHtmlInv(ev.label)}</strong>
            <small style="color:var(--text-light);">${ev.date ? new Date(ev.date).toLocaleDateString('en-GB') : '-'}</small>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">${escapeHtmlInv(serialEventDetailLine(ev))}</p>
        </div>`).join('')}
    </div>`;
}

function exportLowStockToExcel(lowItems) {
  const rows = lowItems.map(p => ({
    'Product Name': p.product_name ?? '',
    'Product ID': p.product_id ?? '',
    'Model No.': p.model_no ?? '',
    'Quantity': p.quantity ?? 0
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Low Stock');
  XLSX.writeFile(wb, `low_stock_${Date.now()}.xlsx`);
}

// ---------- Cards -> click to see details (filters + export + row click) ----------
function wireCardClicks() {
  document.querySelectorAll('.card-clickable').forEach(card => {
    card.addEventListener('click', () => openCardDetailModal(card.dataset.card));
  });
}

const ivMoney = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ivQty = p => Number(p.quantity) || 0;
const ivType = p => p.product_type || 'product';
const ivIsPart = p => p.product_type === 'spare_parts' || p.product_type === 'service_parts';
const ivStockState = p => (ivQty(p) === 0 ? 'out' : ivQty(p) <= 10 ? 'low' : 'ok');
const IV_STOCK_LABELS = { ok: 'In Stock', low: 'Low Stock (≤ 10)', out: 'Out of Stock' };
const ivUniq = arr => [...new Set(arr.filter(v => v !== undefined && v !== null && v !== ''))];

// Product / accessory / damaged -> name + "ID · Model". Spare / service part -> part name + "Belongs to".
function itemIdentityHtml(p) {
  const name = `<strong>${escapeHtmlInv(p.product_name ?? '')}</strong>`;
  if (ivIsPart(p)) {
    return `${name}<div class="iv-sub">Belongs to: <b style="color:var(--text-secondary);">${escapeHtmlInv(p.parent_product_name || '—')}</b></div>`;
  }
  const sub = [(p.product_id || '').trim() ? `ID: ${escapeHtmlInv(p.product_id)}` : '', p.model_no ? `Model: ${escapeHtmlInv(p.model_no)}` : ''].filter(Boolean).join(' · ');
  return `${name}${sub ? `<div class="iv-sub">${sub}</div>` : ''}`;
}
const ITEM_CSV_HEADS = ['Name', 'Product ID', 'Model No', 'Belongs To'];
const itemIdentityCsv = p => ivIsPart(p)
  ? [p.product_name, '', '', p.parent_product_name || '']
  : [p.product_name, p.product_id, p.model_no, ''];

function ensureInvStyles() {
  if (document.getElementById('iv-style')) return;
  const st = document.createElement('style');
  st.id = 'iv-style';
  st.textContent = `
    .iv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)}
    .iv-head h3{margin:0 0 4px}
    .iv-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px;margin-bottom:12px}
    .iv-filter{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-muted)}
    .iv-filter select{padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:#fff;color:var(--text-primary);min-width:130px}
    .iv-count{margin-left:auto;font-size:12px;color:var(--text-muted);padding-bottom:9px}
    .iv-export{border:none;border-radius:8px;padding:8px 14px;background:var(--primary);color:#fff;font-weight:600;font-size:13px;cursor:pointer}
    .iv-summary{font-size:13px;color:var(--text-secondary);margin-bottom:10px}
    .iv-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
    .iv-table{width:100%;border-collapse:collapse;font-size:13px}
    .iv-table th{background:var(--bg-hover);color:var(--text-secondary);text-align:left;padding:9px 12px;font-weight:600;white-space:nowrap}
    .iv-table td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
    .iv-table tr:last-child td{border-bottom:none}
    .iv-table tr.iv-row{cursor:pointer}
    .iv-table tr.iv-row:hover td{background:var(--bg-light)}
    .iv-sub{color:var(--text-light);font-size:12px;margin-top:1px}
    .iv-empty{color:var(--text-light);text-align:center;padding:18px}
    .iv-hint{font-size:12px;color:var(--text-light);margin:-4px 0 10px}
    .iv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px;margin-bottom:18px}
    .iv-cell{background:var(--bg-light);border-radius:10px;padding:10px 12px}
    .iv-cell small{display:block;color:var(--text-muted);font-size:11px;margin-bottom:2px}
    .iv-cell p{margin:0;font-size:14px;color:var(--text-primary);word-break:break-word}
    .iv-title{font-size:13px;font-weight:600;color:var(--text-secondary);margin:4px 0 8px}
    .iv-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:170px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:16px}
    .iv-chip{background:var(--bg-hover);border-radius:6px;padding:2px 9px;font-size:12px;color:var(--text-secondary)}
    .iv-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}`;
  document.head.appendChild(st);
}

// cfg = { title, source, filters:[{key,label,options:[[v,l]],test(p,v)}], columns:[{label,cell}],
//         csvHeads, csvRow(row), aggregate?(list), summary?(rows), open?:true, file }
function invCardView(cfg) {
  const modal = document.getElementById('cardDetailModal');
  if (!modal) return;
  ensureInvStyles();
  const content = modal.querySelector('.modal-content');
  content.style.cssText = 'background:#fff;border-radius:16px;padding:26px;width:min(980px,95vw);max-height:88vh;overflow-y:auto;';
  const sel = {};
  let shown = [];

  content.innerHTML = `
    <div class="iv-head">
      <h3>${cfg.title}</h3>
      <button class="close" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
    </div>
    <div class="iv-toolbar">
      ${cfg.filters.map(f => `
        <label class="iv-filter"><span>${f.label}</span>
          <select data-key="${f.key}"><option value="">All</option>
            ${f.options.map(([v, l]) => `<option value="${escapeHtmlInv(v)}">${escapeHtmlInv(l)}</option>`).join('')}
          </select></label>`).join('')}
      <span class="iv-count"></span>
      <button type="button" class="iv-export"><i class="fa-solid fa-file-export"></i> Export</button>
    </div>
    <div class="iv-summary"></div>
    ${cfg.open ? '<p class="iv-hint">Click a row to see its full details.</p>' : ''}
    <div class="iv-results"></div>`;

  const paint = () => {
    const list = cfg.source.filter(p => cfg.filters.every(f => !sel[f.key] || f.test(p, sel[f.key])));
    shown = cfg.aggregate ? cfg.aggregate(list) : list;
    content.querySelector('.iv-results').innerHTML = shown.length
      ? `<div class="iv-scroll"><table class="iv-table"><thead><tr>${cfg.columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
         <tbody>${shown.map((r, i) => `<tr class="${cfg.open ? 'iv-row' : ''}" data-i="${i}">${cfg.columns.map(c => `<td>${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="iv-empty">No items to show.</p>';
    content.querySelector('.iv-count').textContent = `${shown.length} item${shown.length === 1 ? '' : 's'}`;
    content.querySelector('.iv-summary').innerHTML = cfg.summary ? cfg.summary(shown) : '';
    if (cfg.open) content.querySelectorAll('tr.iv-row').forEach(tr =>
      tr.addEventListener('click', async () => openViewModal(await fetchProductDetail(shown[Number(tr.dataset.i)]))));
  };

  content.querySelectorAll('.iv-filter select').forEach(s => s.addEventListener('change', () => { sel[s.dataset.key] = s.value; paint(); }));
  a4Twin(content.querySelector('.iv-export'), cfg.title || cfg.file);
  content.querySelector('.iv-export').addEventListener('click', () => {
    if (!shown.length) { alert('Nothing to export for the selected filters.'); return; }
    if (a4Intercept(cfg.csvHeads, shown.map(cfg.csvRow), cfg.file)) return;
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cfg.csvHeads, ...shown.map(cfg.csvRow)].map(r => r.map(q).join(','));
    const tag = Object.values(sel).filter(Boolean).join('_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
    a.download = `${cfg.file}${tag ? '_' + tag.replace(/[^\w-]+/g, '_') : ''}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
  paint();
  modal.style.display = 'flex';
}

function openCardDetailModal(cardType) {
  const products = invState.products;
  const catFilter = {
    key: 'cat', label: 'Category',
    options: Object.entries(PRODUCT_TYPE_LABELS).filter(([k]) => products.some(p => ivType(p) === k)),
    test: (p, v) => ivType(p) === v
  };
  const stockFilter = (keys) => ({ key: 'stock', label: 'Stock', options: keys.map(k => [k, IV_STOCK_LABELS[k]]), test: (p, v) => ivStockState(p) === v });
  const supFilter = {
    key: 'sup', label: 'Supplier', options: ivUniq(products.map(p => p.supplier)).sort().map(s => [s, s]),
    test: (p, v) => p.supplier === v
  };
  const catCell = p => `<span class="stock ${productTypeBadgeClass(p.product_type)}">${productTypeLabel(p.product_type)}</span>${partCategoryBadgeHtml(p)}`;
  const qtyCell = p => `<span class="stock ${stockClass(ivQty(p))}">${ivQty(p)}</span>`;
  const itemCol = { label: 'Item', cell: itemIdentityHtml };
  const baseCsvHeads = [...ITEM_CSV_HEADS, 'Category', 'Supplier', 'Qty', 'Price', 'Tax %'];
  const baseCsvRow = p => [...itemIdentityCsv(p), productTypeLabel(p.product_type), p.supplier, ivQty(p), p.price, p.tax_rate];

  if (cardType === 'total_products') {
    invCardView({
      title: 'All Products', source: products, file: 'inventory_products', open: true,
      filters: [catFilter, stockFilter(['ok', 'low', 'out']), supFilter],
      columns: [itemCol, { label: 'Category', cell: catCell }, { label: 'Supplier', cell: p => escapeHtmlInv(p.supplier ?? '') }, { label: 'Qty', cell: qtyCell }],
      csvHeads: baseCsvHeads, csvRow: baseCsvRow
    });
  } else if (cardType === 'total_stock') {
    invCardView({
      title: 'Stock by Product', file: 'inventory_stock', open: true,
      source: [...products].sort((a, b) => ivQty(b) - ivQty(a)),
      filters: [catFilter, stockFilter(['ok', 'low', 'out'])],
      columns: [itemCol, { label: 'Category', cell: catCell }, { label: 'Qty', cell: qtyCell }],
      summary: rows => `Total units: <strong>${rows.reduce((s, p) => s + ivQty(p), 0)}</strong>`,
      csvHeads: baseCsvHeads, csvRow: baseCsvRow
    });
  } else if (cardType === 'low_stock') {
    invCardView({
      title: 'Low Stock Items (≤ 10 units)', file: 'inventory_low_stock', open: true,
      source: products.filter(p => ivQty(p) <= 10),
      filters: [catFilter, stockFilter(['low', 'out'])],
      columns: [itemCol, { label: 'Category', cell: catCell }, { label: 'Qty', cell: p => `<span class="stock low">${ivQty(p)}</span>` }],
      csvHeads: baseCsvHeads, csvRow: baseCsvRow
    });
  } else if (cardType === 'suppliers') {
    invCardView({
      title: 'Suppliers', file: 'inventory_suppliers', source: products,
      filters: [catFilter],
      aggregate: list => {
        const by = {};
        list.forEach(p => {
          const s = p.supplier || 'Unknown';
          const r = by[s] || (by[s] = { supplier: s, count: 0, units: 0, value: 0 });
          r.count++; r.units += ivQty(p); r.value += (Number(p.price) || 0) * ivQty(p);
        });
        return Object.values(by).sort((a, b) => a.supplier.localeCompare(b.supplier));
      },
      columns: [
        { label: 'Supplier', cell: r => `<strong>${escapeHtmlInv(r.supplier)}</strong>` },
        { label: 'Products Supplied', cell: r => r.count },
        { label: 'Units', cell: r => r.units },
        { label: 'Value', cell: r => ivMoney(r.value) }
      ],
      csvHeads: ['Supplier', 'Products Supplied', 'Units', 'Value (INR)'],
      csvRow: r => [r.supplier, r.count, r.units, r.value]
    });
  } else if (cardType === 'service_parts_status' || cardType === 'spare_parts_status') {
    const partType = cardType === 'service_parts_status' ? 'service_parts' : 'spare_parts';
    const parts = products.filter(p => p.product_type === partType);
    const filters = [
      { key: 'status', label: 'Status', options: [['active', 'Active'], ['pending', 'Pending']],
        test: (p, v) => (statusFromHologram(p) === 'Active') === (v === 'active') },
      { key: 'parent', label: 'Belongs To', options: ivUniq(parts.map(p => p.parent_product_name)).sort().map(s => [s, s]),
        test: (p, v) => p.parent_product_name === v },
      { key: 'warranty', label: 'Warranty', options: [['under warranty', 'Under Warranty'], ['over warranty', 'Over Warranty']],
        test: (p, v) => p.warranty_status === v }
    ];
    if (partType === 'service_parts') filters.push({ key: 'pc', label: 'Type', options: [['purchase', 'Purchase'], ['warranty', 'Warranty']], test: (p, v) => p.part_category === v });
    const holo = p => (typeof p.hologram_count === 'number' ? p.hologram_count : hologramNumbersOf(p).length);
    const stBadge = p => {
      const st = statusFromHologram(p);
      const color = st === 'Active' ? 'var(--success-dark)' : (st === 'Partial' ? 'var(--warning-dark)' : 'var(--text-muted)');
      return `<span style="color:${color};font-weight:600;">${st === 'Active' ? 'Active' : 'Pending'}${st === 'Partial' ? ' (partial)' : ''}</span>`;
    };
    const warr = p => p.warranty_status ? `<span class="stock ${p.warranty_status === 'over warranty' ? 'low' : 'high'}">${p.warranty_status === 'over warranty' ? 'Over' : 'Under'} Warranty</span>` : '—';
    invCardView({
      title: partType === 'service_parts' ? 'Service Parts — Active / Pending' : 'Spare Parts — Active / Pending',
      file: partType, source: parts, filters, open: true,
      summary: rows => { const a = rows.filter(p => statusFromHologram(p) === 'Active').length; return `Active: <strong>${a}</strong> · Pending: <strong>${rows.length - a}</strong>`; },
      columns: [
        { label: 'Part', cell: itemIdentityHtml }, { label: 'Qty', cell: qtyCell },
        { label: 'Holograms', cell: p => `${holo(p)} / ${ivQty(p)}` }, { label: 'Warranty', cell: warr }, { label: 'Status', cell: stBadge }
      ],
      csvHeads: ['Part Name', 'Belongs To', 'Qty', 'Holograms', 'Status', 'Warranty', 'Warranty Until', 'Supplier', 'Type'],
      csvRow: p => [p.product_name, p.parent_product_name, ivQty(p), holo(p), statusFromHologram(p), p.warranty_status, p.warranty_until, p.supplier, p.part_category]
    });
  } else if (cardType === 'inventory_value') {
    invCardView({
      title: 'Inventory Value by Product', file: 'inventory_value', open: true,
      source: products.map(p => ({ ...p, __value: (Number(p.price) || 0) * ivQty(p) })).sort((a, b) => b.__value - a.__value),
      filters: [catFilter, supFilter],
      summary: rows => `Total value: <strong>${ivMoney(rows.reduce((s, p) => s + p.__value, 0))}</strong>`,
      columns: [itemCol, { label: 'Category', cell: catCell }, { label: 'Qty', cell: qtyCell }, { label: 'Price', cell: p => ivMoney(p.price) }, { label: 'Value', cell: p => `<strong>${ivMoney(p.__value)}</strong>` }],
      csvHeads: [...ITEM_CSV_HEADS, 'Category', 'Qty', 'Price', 'Value (INR)'],
      csvRow: p => [...itemIdentityCsv(p), productTypeLabel(p.product_type), ivQty(p), p.price, p.__value]
    });
  }
}

// ---------- Product type (Product / Spare Parts / Damaged Product) helpers ----------
const PRODUCT_TYPE_LABELS = {
  product: 'Product',
  spare_parts: 'Spare Parts',
  service_parts: 'Service Parts',
  damaged: 'Damaged Product',
  accessories: 'Accessories'
};

function productTypeLabel(type) {
  return PRODUCT_TYPE_LABELS[type] || PRODUCT_TYPE_LABELS.product;
}

function productTypeBadgeClass(type) {
  if (type === 'spare_parts') return 'medium';
  if (type === 'service_parts') return 'medium';
  if (type === 'damaged') return 'low';
  if (type === 'accessories') return 'medium';
  return 'high';
}

// service_parts entries carry a part_category ("purchase" | "warranty") so
// the two never merge into one entry — show that as its own badge
function partCategoryBadgeHtml(p) {
  if (p.product_type !== 'service_parts' || !p.part_category) return '';
  const label = p.part_category === 'warranty' ? 'Warranty' : 'Purchase';
  return `<span class="stock medium" style="margin-left:4px;">${label}</span>`;
}

// warranty badge for service_parts entries synced from a shipment's
// "warranty" parts — server computes warranty_status fresh on every fetch
function warrantyBadgeHtml(p) {
  if (!['warranty', 'purchase'].includes(p.part_category) || !p.warranty_until) return '';
  const over = p.warranty_status === 'over warranty';
  return `<span class="stock ${over ? 'low' : 'high'}" style="margin-left:4px;">${over ? 'Over Warranty' : 'Under Warranty'}</span>`;
}

// serial numbers are optional for these types — accessories are sometimes
// unserialized, and spare/service parts are tracked purely by quantity.
// Normalized (trim + lowercase) so a stray casing/whitespace difference
// coming from the DB (e.g. legacy "Accessories") never falls through to
// the strict serial-count-must-match-quantity path.
function isSerialOptionalType(type) {
  const t = (type || '').trim().toLowerCase();
  return t === 'accessories' || t === 'spare_parts' || t === 'service_parts';
}

// ---------- Reading serial numbers out of an uploaded Excel/CSV file ----------
// Flattens every non-empty cell across the whole sheet into a de-duplicated
// list of serial numbers, so any layout (one column, one row, multiple
// columns) works without asking the user to format the file a certain way.
function parseSerialsFromFile(file, onDone, onError, { lowercase = true } = {}) {
  if (typeof XLSX === 'undefined') {
    onError('Excel reader failed to load. Check your connection and try again.');
    return;
  }
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const values = [];
      rows.forEach(row => {
        (row || []).forEach(cell => {
          const val = String(cell ?? '').trim();
          if (val && val.toLowerCase() !== 'serial number' && val.toLowerCase() !== 'serial no'
            && val.toLowerCase() !== 'hologram number' && val.toLowerCase() !== 'hologram no') {
            values.push(lowercase ? val.toLowerCase() : val);
          }
        });
      });
      const unique = [...new Set(values)];
      if (!unique.length) { onError('No values were found in that file.'); return; }
      onDone(unique);
    } catch (err) {
      onError('Could not read that file. Please upload a valid Excel or CSV file.');
    }
  };
  reader.onerror = () => onError('Could not read that file.');
  reader.readAsArrayBuffer(file);
}

// ---------- Category filter tabs (Product / Spare Parts / Damaged Product) ----------
function wireCategoryFilter() {
  const buttons = document.querySelectorAll('.cat-filter-btn');
  if (!buttons.length) return;

  const paint = (btn, active) => {
    btn.style.border = active ? '1px solid var(--primary)' : '1px solid var(--border)';
    btn.style.background = active ? 'var(--info-bg)' : 'var(--bg-light)';
    btn.style.color = active ? 'var(--primary)' : 'var(--text-secondary)';
    btn.style.borderRadius = '8px';
    btn.style.padding = '8px 14px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
  };
  buttons.forEach(btn => paint(btn, false));

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      invState.activeCategory = invState.activeCategory === type ? null : type; // click again to clear
      buttons.forEach(b => paint(b, b.dataset.type === invState.activeCategory));
      invPage = 1;
      renderInventoryTable(getFilteredInventory());
    });
  });
}

const SEARCH_FIELDS = ['product_name', 'product_id', 'model_no', 'supplier', 'lot_no', 'parent_product_name', 'part_category'];

function normSearch(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();
}

function searchTokens(q) {
  return normSearch(q).split(' ').filter(Boolean);
}

function scoreProduct(p, tokens) {
  if (!p._hay) {
    p._hay = '|' + SEARCH_FIELDS.map(f => normSearch(p[f])).join('|');
    p._hayC = p._hay.replace(/[ |]/g, '');
    p._name = normSearch(p.product_name);
    p._ids = [normSearch(p.product_id), normSearch(p.model_no)];
  }
  let score = 0;
  for (const t of tokens) {
    if (p._hay.includes(t)) score += (p._hay.includes('|' + t) || p._hay.includes(' ' + t)) ? 3 : 1;
    else if (p._hayC.includes(t)) score += 0.5;
    else return 0;
  }
  const q = tokens.join(' ');
  if (p._name === q) score += 10;
  else if (p._name.startsWith(q)) score += 5;
  if (p._ids.includes(q)) score += 8;
  return score;
}

function rankProducts(list, q) {
  const tokens = searchTokens(q);
  if (!tokens.length) return list;
  return list
    .map((p, i) => ({ p, i, s: scoreProduct(p, tokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .map(x => x.p);
}

function highlightHtml(text, tokens) {
  const s = String(text ?? '');
  tokens = tokens.filter(t => t.length > 1);
  if (!tokens.length) return escapeHtmlInv(s);
  const re = new RegExp('(' + tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return s.split(re).map((part, i) => i % 2
    ? `<mark style="background:#fde68a;color:inherit;padding:0">${escapeHtmlInv(part)}</mark>`
    : escapeHtmlInv(part)).join('');
}

function wireHeaderSearch() {
  const input = document.getElementById('headerSearchInput') || document.querySelector('.search input');
  const suggestBox = document.getElementById('headerSearchSuggestions');
  if (!input) return;

  let timer = null;
  let activeIdx = -1;

  const closeBox = () => {
    if (!suggestBox) return;
    suggestBox.style.display = 'none';
    suggestBox.innerHTML = '';
    activeIdx = -1;
  };

  const pick = item => {
    input.value = item.dataset.value;
    invState.searchQuery = '';
    invState.searchId = item.dataset.id || '';
    invPage = 1;
    renderInventoryTable(getFilteredInventory());
    closeBox();
  };

  const paintActive = () => {
    const items = suggestBox.querySelectorAll('.search-suggestion-item');
    items.forEach((it, i) => { it.style.background = i === activeIdx ? 'var(--bg-light)' : ''; });
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    invState.searchQuery = input.value.trim().toLowerCase();
    invState.searchId = '';
    invPage = 1;
    renderSearchSuggestions(input, suggestBox);
    activeIdx = -1;
    clearTimeout(timer);
    timer = setTimeout(() => renderInventoryTable(getFilteredInventory()), 120);
  });

  input.addEventListener('focus', () => { if (input.value.trim() && !invState.searchId) renderSearchSuggestions(input, suggestBox); });

  input.addEventListener('keydown', e => {
    if (!suggestBox || suggestBox.style.display === 'none') return;
    const items = suggestBox.querySelectorAll('.search-suggestion-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % items.length; paintActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length; paintActive(); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); pick(items[activeIdx]); }
    else if (e.key === 'Escape') closeBox();
  });

  if (suggestBox) suggestBox.addEventListener('click', e => {
    const item = e.target.closest('.search-suggestion-item');
    if (item) pick(item);
  });

  document.addEventListener('click', e => {
    if (!suggestBox) return;
    if (e.target !== input && !suggestBox.contains(e.target)) closeBox();
  });
}

function renderSearchSuggestions(input, suggestBox) {
  if (!suggestBox) return;
  const q = input.value.trim();
  const tokens = searchTokens(q);
  if (!tokens.length) { suggestBox.style.display = 'none'; suggestBox.innerHTML = ''; return; }

  const base = invState.activeCategory
    ? invState.products.filter(p => (p.product_type || 'product') === invState.activeCategory)
    : invState.products;
  const matches = rankProducts(base, q).slice(0, 8);

  if (!matches.length) {
    suggestBox.innerHTML = '<div style="padding:9px 12px;font-size:13px;color:var(--text-light);">No matches</div>';
    suggestBox.style.display = 'block';
    return;
  }

  suggestBox.innerHTML = matches.map(p => {
    const name = p.product_name || '';
    const sub = [p.product_id, p.model_no, p.parent_product_name, productTypeLabel(p.product_type || 'product')].filter(Boolean).join(' · ');
    return `
    <div class="search-suggestion-item" data-id="${escapeHtmlInv(p._id)}" data-value="${escapeHtmlInv(name || p.product_id)}"
      style="padding:9px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--bg-hover);">
      <span>${highlightHtml(name, tokens) || '(no name)'}</span>
      <span style="color:var(--text-light);text-align:right;">${highlightHtml(sub, tokens)}</span>
    </div>`;
  }).join('');

  suggestBox.querySelectorAll('.search-suggestion-item').forEach(item => {
    item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-light)');
    item.addEventListener('mouseleave', () => item.style.background = '');
  });

  suggestBox.style.display = 'block';
}

// Combines whatever category tab / header search / "Apply Filter" criteria
// are currently active on invState and returns the resulting view. Used both
// by the individual filter controls AND by loadInventory(), so that any
// action which re-fetches data (delete, edit save, add, etc.) re-renders the
// SAME filtered view the user was looking at instead of silently snapping
// back to the full unfiltered product list.
function getFilteredInventory(ignoreCategory) {
  let list = invState.activeCategory && !ignoreCategory
    ? invState.products.filter(p => (p.product_type || 'product') === invState.activeCategory)
    : invState.products;

  if (invState.searchId) list = list.filter(p => p._id === invState.searchId);
  if (invState.searchQuery) list = rankProducts(list, invState.searchQuery).reverse();

  const f = invState.activeFilters;
  if (f) {
    list = list.filter(p =>
      (!f.name || (p.product_name || '').toLowerCase().includes(f.name)) &&
      (!f.id || (p.product_id || '').toLowerCase().includes(f.id)) &&
      (!f.supplier || (p.supplier || '').toLowerCase().includes(f.supplier)) &&
      (!f.date || p.purchase_date === f.date)
    );
  }

  return list;
}

function applyRolePermissions() {
  const role = getRole();
  // matches the backend's require_role("service_manager", "admin", "accounts", "inventory_manager")
  // on /inventory/create and /inventory/update — 'employee' isn't a real role,
  // it was leftover from before roles were split into accounts/service_manager/assembly
  const canManage = role === 'admin' || role === 'accounts' || role === 'service_manager' || role === 'inventory_manager';
  const canDelete = role === 'admin';
  if (!canManage) {
    const addBtn = document.querySelector('.add-product');
    if (addBtn) addBtn.style.display = 'none';
  }
  // delete buttons are re-hidden per row after each render too (renderInventoryTable),
  // this just covers the static "Add Product" button up front.
  window.__invCanManage = canManage;
  window.__invCanDelete = canDelete;
}

async function loadInventory() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) throw new Error('failed to fetch inventory');
    const data = await res.json();
    invState.products = (data.dataset || []).slice().reverse();
    invPage = 1;
    renderInventoryTable(getFilteredInventory());
    updateInventoryCards(invState.products);
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      alert('Could not load inventory data.');
    }
  }
}

function updateInventoryCards(products) {
  const cardValues = document.querySelectorAll('.cards .card h2');
  if (!cardValues.length) return;
  const totalStock = products.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  const lowStock = products.filter(p => (Number(p.quantity) || 0) <= 10).length;
  const suppliers = new Set(products.map(p => p.supplier).filter(Boolean)).size;
  const inventoryValue = products.reduce((sum, p) => sum + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0);

  // inventory.html card order: Total Products, Total Stock, Low Stock, Suppliers, Inventory Value
  cardValues[0].textContent = products.length;
  if (cardValues[1]) cardValues[1].textContent = totalStock;
  if (cardValues[2]) cardValues[2].textContent = lowStock;
  if (cardValues[3]) cardValues[3].textContent = suppliers;
  if (cardValues[4]) cardValues[4].textContent = `₹${(inventoryValue / 100000).toFixed(1)}L`;

  // Service Parts / Spare Parts cards — Active = hologram numbers on file for every unit,
  // Pending = not fully hologram-tagged yet (none or only some units), same rule as the table's status
  const setPartCard = (type, totalId, statusId) => {
    const list = products.filter(p => p.product_type === type);
    let active = 0, pending = 0;
    list.forEach(p => { if (statusFromHologram(p) === 'Active') active++; else pending++; });
    const totalEl = document.getElementById(totalId);
    const statusEl = document.getElementById(statusId);
    if (totalEl) totalEl.textContent = list.length;
    if (statusEl) statusEl.textContent = `Active: ${active} · Pending: ${pending}`;
  };
  setPartCard('service_parts', 'cardServicePartsTotal', 'cardServicePartsStatus');
  setPartCard('spare_parts', 'cardSparePartsTotal', 'cardSparePartsStatus');
}

// spare_parts / service_parts only: has at least one hologram number on file vs none
function isPartProduct(p) { return p.product_type === 'spare_parts' || p.product_type === 'service_parts'; }
function partHologramCount(p) {
  return typeof p.hologram_count === 'number' ? p.hologram_count : hologramNumbersOf(p).length;
}


function stockClass(qty) {
  if (qty > 50) return 'high';
  if (qty > 10) return 'medium';
  return 'low';
}

// Column sets per category — the header labels/cells shown adapt to whichever
// filter tab is active, so irrelevant columns (e.g. Model No. for spare parts)
// don't clutter the table.
// hologram numbers are tracked one-per-unit (parallel to quantity, not to
// serial numbers) — hologram_numbers is the array; hologram_no is the old
// single-string field, kept here only as a fallback for un-migrated records
function hologramNumbersOf(p) {
  if (Array.isArray(p.hologram_numbers)) return p.hologram_numbers;
  return p.hologram_no ? [p.hologram_no] : [];
}

function statusFromHologram(p) {
  if (p.product_type !== 'spare_parts' && p.product_type !== 'service_parts') return 'Pending';
  // the main list only sends hologram_count (a number); the full hologram_numbers
  // array is only present after fetchProductDetail (view/edit modals)
  const count = typeof p.hologram_count === 'number' ? p.hologram_count : hologramNumbersOf(p).length;
  const qty = Number(p.quantity) || 0;
  if (count === 0) return 'Pending';
  if (qty && count >= qty) return 'Active';
  return 'Partial';
}

function columnsForCategory(category) {
  const typeCell = p => `<span class="stock ${productTypeBadgeClass(p.product_type)}">${productTypeLabel(p.product_type)}</span>${partCategoryBadgeHtml(p)}${warrantyBadgeHtml(p)}`;
  const qtyCell = p => `<span class="stock ${stockClass(Number(p.quantity) || 0)}">${p.quantity ?? 0}</span>`;
  const priceCell = p => `₹${p.price ?? ''}`;
  const taxCell = p => `${p.tax_rate ?? 0}%`;
  const dateCell = p => p.purchase_date ?? '';
  const supplierCell = p => p.supplier ?? '';
  const nameCell = p => p.product_name ?? '';
  const modelCell = p => p.model_no ?? '';
  // Mixed (no category filter) view: a part is identified by its own name +
  // which product it belongs to, not by product_id/model_no (those are
  // always empty for parts) — so the single "Product" column shows whichever
  // identity actually applies, instead of a part's row showing a bare name
  // with no id/model and no link back to its parent product.
  const identityCell = p => {
    const isPart = p.product_type === 'spare_parts' || p.product_type === 'service_parts';
    if (isPart) {
      const belongs = p.parent_product_name
        ? `<br><small style="color:var(--text-light);">Belongs to: ${escapeHtmlInv(p.parent_product_name)}</small>`
        : '';
      return `${escapeHtmlInv(p.product_name ?? '')}${belongs}`;
    }
    const meta = [(p.product_id || '').trim(), p.model_no].filter(Boolean).join(' · ');
    return `${escapeHtmlInv(p.product_name ?? '')}${meta ? `<br><small style="color:var(--text-light);">${meta}</small>` : ''}`;
  };
  // shipment stores warranty length in months (e.g. "12 months"); the backend
  // adds that to the received_date and stores it as warranty_until. Here we
  // just subtract today's date from that to show how many days are left.
  const daysRemaining = (warrantyUntil) => {
    if (!warrantyUntil) return null;
    const until = new Date(warrantyUntil + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((until - today) / (1000 * 60 * 60 * 24));
  };
  const warrantyPeriodCell = p => {
    const days = daysRemaining(p.warranty_until);
    if (days === null) return '—';
    if (days < 0) return `<span class="stock low">Expired ${Math.abs(days)}d ago</span>`;
    if (days === 0) return `<span class="stock low">Expires today</span>`;
    return `<span class="stock ${days <= 30 ? 'medium' : 'high'}">${days} day${days === 1 ? '' : 's'} left</span>`;
  };
  const statusBadge = p => {
    const s = statusFromHologram(p);
    const cls = s === 'Active' ? 'high' : (s === 'Partial' ? 'medium' : 'low');
    return `<span class="stock ${cls}">${s}</span>`;
  };
  // Who added this lot, and — if it's since been edited by someone else —
  // who last updated it. Mirrors how the order page attributes each order
  // to whoever raised/actioned it.
  const addedByCell = p => {
    const addedBy = p.created_by ? escapeHtmlInv(p.created_by) : '—';
    const updatedBy = p.updated_by && p.updated_by !== p.created_by ? escapeHtmlInv(p.updated_by) : '';
    return `${addedBy}${updatedBy ? `<br><small style="color:var(--text-light);">Updated by ${updatedBy}</small>` : ''}`;
  };

  switch (category) {
    case 'product':
      return [
        { label: 'Product Name', cell: nameCell },
        { label: 'Model No.', cell: modelCell },
        { label: 'Receiving Date', cell: dateCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Price', cell: priceCell },
        { label: 'Tax', cell: taxCell },
        { label: 'Added By', cell: addedByCell }
      ];
    case 'spare_parts':
      return [
        { label: 'Product Name', cell: p => p.parent_product_name ?? '—' },
        { label: 'Part Name', cell: nameCell },
        { label: 'Shipment Received Date', cell: dateCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Status', cell: statusBadge },
        { label: 'Added By', cell: addedByCell }
      ];
    case 'service_parts':
      return [
        { label: 'Product Name', cell: p => p.parent_product_name ?? '—' },
        { label: 'Part Name', cell: nameCell },
        { label: 'Shipment Received Date', cell: dateCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Status', cell: statusBadge },
        { label: 'Type', cell: p => p.part_category ? (p.part_category === 'warranty' ? 'Warranty' : 'Purchase') : '—' },
        { label: 'Added By', cell: addedByCell }
      ];
    case 'damaged':
      return [
        { label: 'Product Name', cell: nameCell },
        { label: 'Model No.', cell: modelCell },
        { label: 'Received Date', cell: p => p.damage_date ?? p.purchase_date ?? '' },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Reason of Damage', cell: p => p.reason_of_damage ?? p.reason ?? '—' },
        { label: 'Status', cell: p => p.damage_status ?? 'Damaged' },
        { label: 'Added By', cell: addedByCell }
      ];
    default: // no category filter active (mixed products + parts)
      return [
        { label: 'Product', cell: identityCell },
        { label: 'Type', cell: typeCell },
        { label: 'Supplier', cell: supplierCell },
        { label: 'Purchase Date', cell: dateCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Price', cell: priceCell },
        { label: 'Tax', cell: taxCell },
        { label: 'Added By', cell: addedByCell }
      ];
  }
}

function renderTableHeader(category) {
  const headRow = document.querySelector('.table-container thead tr');
  if (!headRow) return;
  const columns = columnsForCategory(category);
  headRow.innerHTML = `<th></th>${columns.map(c => `<th>${c.label}</th>`).join('')}<th>Actions</th>`;
}

function renderInventoryTable(products) {
  // API returns products in insertion (ascending) order — reverse so the
  // most recently added product shows at the top instead of the bottom.
  const sorted = [...products].reverse();

  const totalPages = Math.max(1, Math.ceil(sorted.length / INV_PAGE_SIZE));
  invPage = Math.min(Math.max(1, invPage), totalPages);
  const start = (invPage - 1) * INV_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + INV_PAGE_SIZE);

  const columns = columnsForCategory(invState.activeCategory);
  renderTableHeader(invState.activeCategory);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  const canManage = window.__invCanManage;
  const canDelete = window.__invCanDelete;

  pageRows.forEach(p => {
    const tr = document.createElement('tr');
    tr.dataset.productId = p.product_id ?? '';
    tr._product = p;
    tr.dataset.modelNo = p.model_no || '';
    tr.dataset.productType = p.product_type || 'product';
    const isDamaged = p.product_type === 'damaged';
    tr.innerHTML = `
      <td><input type="checkbox"></td>
      ${columns.map(c => `<td>${c.cell(p)}</td>`).join('')}
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        ${canManage ? '<button class="icon-btn edit-btn"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${isDamaged
          ? (canManage ? '<button class="icon-btn repair-btn" title="Repair"><i class="fa-solid fa-screwdriver-wrench"></i></button>' : '')
          : (canDelete ? '<button class="icon-btn delete delete-btn"><i class="fa-solid fa-trash"></i></button>' : '')}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', async e => openViewModal(await fetchProductDetail(rowProduct(e)))));
  tbody.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', async e => openEditModal(await fetchProductDetail(rowProduct(e)))));
  tbody.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', e => openDeleteModal(rowProduct(e))));
  tbody.querySelectorAll('.repair-btn').forEach(btn => btn.addEventListener('click', async e => handleRepairClick(await fetchProductDetail(rowProduct(e)))));

  renderTablePagination(document.querySelector('.pagination'), invPage, totalPages, p => {
    invPage = p;
    renderInventoryTable(products);
  });
}

// The main list no longer carries serial_numbers/hologram_numbers (that was
// the bulk of its payload — this is what was making the page slow). View,
// Edit, and Repair need that per-row detail, so they fetch it fresh here
// instead of reading it off the cached row. Falls back to the cached row
// (serials just won't show) if the fetch fails, so a network hiccup doesn't
// hard-block the modal from opening at all.
async function fetchProductDetail(p) {
  if (!p) return p;
  try {
    const params = new URLSearchParams({
      product_id: p.product_id || '',
      model_no: p.model_no || '',
      product_type: p.product_type || '',
      lot_id: p._id || ''
    });
    const res = await apiFetch(`/inventory/detail?${params}`);
    if (!res.ok) {
      // surface the backend's actual error (e.g. a 500's real cause) in the
      // console instead of silently falling back — makes it obvious when
      // the fallback (serial-less cached row) is being used, and why.
      try { console.error('fetchProductDetail failed:', res.status, await res.json()); } catch (_) {}
      return p;
    }
    const data = await res.json();
    // parts have no product_id, so an older backend (without lot_id support) can hand back a
    // different lot — never merge another lot's data into this row
    if (p._id && data.product && data.product._id && data.product._id !== p._id) return p;
    return { ...p, ...data.product };
  } catch (err) {
    console.error(err);
    return p;
  }
}

function rowProduct(e) {
  const tr = e.target.closest('tr');
  if (tr && tr._product) return tr._product;
  return invState.products.find(p =>
    p.product_id === tr.dataset.productId &&
    (p.model_no || '') === tr.dataset.modelNo &&
    (p.product_type || 'product') === tr.dataset.productType
  );
}

// Repair action on a Damaged Product row (replaces Delete there):
// - has serial numbers -> it's a full product -> opens a service record for
//   in-house warranty repair (issue = "Inhouse Warranty")
// - no serial numbers -> it's a part (e.g. swapped out during a service) ->
//   not serviceable in-house, so it's just flagged "Send to Parent Company"
//   in this row's Status column instead
let repairBusy = false;
async function handleRepairClick(p) {
  if (!p || repairBusy) return;
  const isProduct = Array.isArray(p.serial_numbers) && p.serial_numbers.length > 0;
  const confirmMsg = isProduct
    ? 'Send this product for in-house warranty repair? A service record will be created for it.'
    : 'Mark this part to be sent back to the parent company?';
  if (!confirm(confirmMsg)) return;

  repairBusy = true;
  try {
    const res = await apiFetch(`/inventory/repair/${p._id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'repair action failed');
    alert(data.mode === 'product'
      ? `Sent for in-house warranty repair. Service ID: ${data.service_id}`
      : 'Marked to send to parent company.');
    await loadInventory();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
  } finally {
    repairBusy = false;
  }
}

function wireTopActions() {
  document.querySelector('.add-product').addEventListener('click', () => {
    resetAddWizard();
    document.getElementById('addModal').style.display = 'flex';
    renderAddTypeStep();
  });
  document.querySelector('.export').addEventListener('click', (e) => openExportCategoryMenu(e.currentTarget));
}

// Export step 1: pick the category (Product / Service Parts / Spare Parts / Faulty /
// Accessories / All). Everything after this (detailed vs summary, date range) only
// covers the chosen category.
const EXPORT_CATEGORIES = [
  { value: 'product', label: 'Product', icon: 'fa-box' },
  { value: 'service_parts', label: 'Service Parts', icon: 'fa-screwdriver-wrench' },
  { value: 'spare_parts', label: 'Spare Parts', icon: 'fa-gears' },
  { value: 'damaged', label: 'Faulty', icon: 'fa-triangle-exclamation' },
  { value: 'accessories', label: 'Accessories', icon: 'fa-plug' },
  { value: 'all', label: 'All', icon: 'fa-boxes-stacked' }
];
let exportCategory = 'all';

function exportRowsForCategory() {
  const base = getFilteredInventory(true);
  if (exportCategory === 'all') return base;
  return base.filter(p => (p.product_type || 'product') === exportCategory);
}

function exportCategoryLabel() {
  return EXPORT_CATEGORIES.find(c => c.value === exportCategory)?.label || 'All';
}

function exportFileName(base) {
  return exportCategory === 'all' ? `${base}.csv` : `${base}_${exportCategory}.csv`;
}

function openExportCategoryMenu(anchorBtn) {
  document.getElementById('exportTypeMenu')?.remove();
  document.getElementById('exportCategoryMenu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'exportCategoryMenu';
  menu.style.cssText = 'position:absolute;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1300;min-width:220px;';
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:var(--text-muted);">Export which category?</div><div style="padding:0 12px 6px;font-size:11px;color:var(--text-light);">Search and filters applied on this page are included.</div>` +
    EXPORT_CATEGORIES.map(c => `
    <button type="button" class="export-cat-opt" data-cat="${c.value}" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-primary);">
      <i class="fa-solid ${c.icon}" style="width:16px;"></i>&nbsp; ${c.label}${c.value === invState.activeCategory ? ' (current view)' : ''}
    </button>`).join('');
  document.body.appendChild(menu);

  menu.querySelectorAll('.export-cat-opt').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = 'var(--bg-hover)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', () => {
      exportCategory = btn.dataset.cat;
      menu.remove();
      openExportTypeMenu(anchorBtn);
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function closeMenu(ev) {
      if (!menu.isConnected) { document.removeEventListener('click', closeMenu); return; }
      if (!menu.contains(ev.target) && ev.target !== anchorBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

// Small popup so the user can pick which export they want before the usual
// date-range wizard opens: the original serial-wise detailed export, or a
// one-line-per-product summary (name+id+model concatenated, quantity next to it).
function openExportTypeMenu(anchorBtn) {
  let menu = document.getElementById('exportTypeMenu');
  if (menu) menu.remove();

  menu = document.createElement('div');
  menu.id = 'exportTypeMenu';
  menu.style.cssText = 'position:absolute;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1300;min-width:240px;';
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `
    <button type="button" class="export-type-opt" data-mode="detailed" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-primary);">
      <i class="fa-solid fa-list" style="width:16px;"></i>&nbsp; Detailed (serial number wise)
    </button>
    <button type="button" class="export-type-opt" data-mode="summary" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-primary);">
      <i class="fa-solid fa-layer-group" style="width:16px;"></i>&nbsp; Summary (product + quantity)
    </button>
    <button type="button" class="export-type-opt" data-mode="single" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-primary);">
      <i class="fa-solid fa-magnifying-glass" style="width:16px;"></i>&nbsp; Specific Product (choose one)
    </button>`;
  document.body.appendChild(menu);

  menu.querySelectorAll('.export-type-opt').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = 'var(--bg-hover)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', () => {
      menu.remove();
      if (btn.dataset.mode === 'summary') exportInventorySummaryCSV();
      else if (btn.dataset.mode === 'single') openSpecificProductPicker();
      else exportInventoryCSV();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function closeMenu(ev) {
      if (!menu.isConnected) { document.removeEventListener('click', closeMenu); return; }
      if (!menu.contains(ev.target) && ev.target !== anchorBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

function exportInventoryCSV() {
  openExportWizard({
    title: `Export Inventory — ${exportCategoryLabel()}`,
    statusOptions: null,
    dateField: 'purchase_date',
    dateLabel: 'Purchase Date',
    getRows: exportRowsForCategory,
    onConfirm: async (rows) => {
      // the cached list no longer carries serial_numbers/hologram_numbers —
      // fetch each row's full detail first for this "serial number wise" export
      const fullRows = await Promise.all(rows.map(fetchProductDetail));
      const header = fullRows.map(p => `${p.product_name} (${p.product_id}) - ${p.model_no || ''}`);
      // parts have no serial numbers — their per-unit identifiers are hologram numbers
      const columns = fullRows.map(p => (p.serial_numbers && p.serial_numbers.length)
        ? p.serial_numbers
        : ((p.product_type === 'spare_parts' || p.product_type === 'service_parts') ? hologramNumbersOf(p) : []));
      const maxLen = Math.max(0, ...columns.map(c => c.length));
      const csvRows = [];
      for (let i = 0; i < maxLen; i++) {
        csvRows.push(columns.map(col => col[i] ?? ''));
      }
      downloadCSV(header, csvRows, exportFileName('inventory'));
    }
  });
}

// One row per product: name + id + model no. concatenated into a single
// label, with the current quantity right next to it.
function exportInventorySummaryCSV() {
  openExportWizard({
    title: `Export Inventory Summary — ${exportCategoryLabel()}`,
    statusOptions: null,
    dateField: 'purchase_date',
    dateLabel: 'Purchase Date',
    getRows: exportRowsForCategory,
    onConfirm: (rows) => {
      const header = ['Product', 'Quantity'];
      const csvRows = rows.map(p => {
        const label = `${p.product_name || ''} (${p.product_id || ''})${p.model_no ? ' - ' + p.model_no : ''}`;
        return [label, Number(p.quantity) || 0];
      });
      downloadCSV(header, csvRows, exportFileName('inventory_summary'));
    }
  });
}

// ---------- Export a single, specifically-chosen product ----------
// Lets the user search/pick exactly one product (scoped to the category
// already chosen in step 1) instead of exporting a whole category, and
// downloads a CSV where Product Name, Product ID and Model Number are each
// their own clearly-labelled column (rather than folded into one string).
function openSpecificProductPicker() {
  document.getElementById('exportSingleProductModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'exportSingleProductModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1300;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:26px;width:380px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3>Export Specific Product</h3>
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <input id="singleProductSearch" placeholder="Search by product name, ID or model no." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;box-sizing:border-box;">
      <div id="singleProductList" style="margin-top:10px;max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;"></div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('.close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  const listBox = modal.querySelector('#singleProductList');
  const searchInput = modal.querySelector('#singleProductSearch');

  function renderList(query) {
    const q = (query || '').trim().toLowerCase();
    const rows = exportRowsForCategory().filter(p => !q ||
      (p.product_name || '').toLowerCase().includes(q) ||
      (p.product_id || '').toLowerCase().includes(q) ||
      (p.model_no || '').toLowerCase().includes(q));

    if (!rows.length) {
      listBox.innerHTML = '<p style="color:var(--text-light);font-size:13px;text-align:center;padding:10px;">No matching product.</p>';
      return;
    }

    listBox.innerHTML = rows.map((p, i) => `
      <button type="button" class="single-product-opt" data-idx="${i}" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:var(--bg-light);cursor:pointer;border-radius:8px;font-size:13px;color:var(--text-primary);">
        <strong>${escapeHtmlInv(p.product_name || '')}</strong><br>
        <small style="color:var(--text-muted);">ID: ${escapeHtmlInv((p.product_id || '').trim() || '-')} &nbsp;·&nbsp; Model: ${escapeHtmlInv(p.model_no || '-')}</small>
      </button>`).join('');

    listBox.querySelectorAll('.single-product-opt').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--info-bg)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'var(--bg-light)');
      btn.addEventListener('click', () => {
        modal.remove();
        exportSingleProductCSV(rows[Number(btn.dataset.idx)]);
      });
    });
  }

  searchInput.addEventListener('input', () => renderList(searchInput.value));
  renderList('');
  searchInput.focus();
}

async function exportSingleProductCSV(product) {
  if (!product) return;
  const p = await fetchProductDetail(product);
  const isPart = p.product_type === 'spare_parts' || p.product_type === 'service_parts';
  const unitLabel = isPart ? 'Hologram Number' : 'Serial Number';
  const units = isPart ? hologramNumbersOf(p) : (p.serial_numbers || []);

  const header = ['Product Name', 'Product ID', 'Model Number', unitLabel, 'Quantity'];
  const qty = Number(p.quantity) || 0;
  const csvRows = units.length
    ? units.map(u => [p.product_name || '', p.product_id || '', p.model_no || '', u, qty])
    : [[p.product_name || '', p.product_id || '', p.model_no || '', '', qty]];

  const safeName = (p.product_name || 'product').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  downloadCSV(header, csvRows, `product_${safeName}.csv`);
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCSV(header, rows, filename) {
  if (a4Intercept(header, rows, filename)) return;
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
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
      <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px;">${getRows().length} record(s) match the filters currently applied on this page. The options below narrow it further.</p>
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:var(--text-muted);">Status</label>
        <select name="status" style="padding:10px;border:1px solid var(--border);border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:var(--text-muted);">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:var(--text-muted);">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:var(--border);cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

  a4WizardPrint(modal, title);
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

function wireFilter() {
  document.querySelector('.filter-btn').addEventListener('click', () => {
    const [nameBox, supplierBox, dateBox] = document.querySelectorAll('.filter-box input');
    const name = nameBox.value.trim().toLowerCase();
    const supplier = supplierBox.value.trim().toLowerCase();
    const date = dateBox.value;

    invState.activeFilters = (name || supplier || date) ? { name, supplier, date } : null;
    invPage = 1;
    renderInventoryTable(getFilteredInventory());
  });
}

function openViewModal(p) {
  if (!p) return;
  ensureInvStyles();
  const modal = document.getElementById('viewModal');
  if (!modal) return;
  modal.style.zIndex = 1100;           // above the card popup if opened from there
  const content = modal.querySelector('.modal-content');
  content.style.cssText = 'background:#fff;border-radius:16px;padding:26px;width:min(960px,95vw);max-height:90vh;overflow-y:auto;';
  const e = escapeHtmlInv;
  const part = ivIsPart(p);
  const qty = ivQty(p);
  const cell = (label, val) => `<div class="iv-cell"><small>${label}</small><p>${val === undefined || val === null || val === '' ? '—' : val}</p></div>`;
  const dateTxt = d => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB'); };

  const serials = p.serial_numbers || [];
  const holograms = hologramNumbersOf(p);
  const stockState = ivStockState(p);
  const stockBadge = `<span class="stock ${stockState === 'ok' ? stockClass(qty) : 'low'}">${qty}</span> <span class="iv-sub">${IV_STOCK_LABELS[stockState]}</span>`;

  let warranty = '';
  if (p.warranty_until) {
    const over = p.warranty_status === 'over warranty';
    const left = typeof p.warranty_days_left === 'number' && !over ? ` · ${p.warranty_days_left} day(s) left` : '';
    warranty = `<span class="stock ${over ? 'low' : 'high'}">${over ? 'Over Warranty' : 'Under Warranty'}</span> <span class="iv-sub">until ${e(dateTxt(p.warranty_until))}${left}</span>`;
  }
  const holoStatus = part ? `${statusFromHologram(p)} — ${holograms.length} of ${qty} unit(s) tagged` : '';

  const identityCells = part
    ? cell('Part Name', e(p.product_name ?? '')) + cell('Belongs To (Product)', e(p.parent_product_name || ''))
    : cell('Product Name', e(p.product_name ?? '')) + cell('Product ID', e(p.product_id || '')) + cell('Model No.', e(p.model_no || ''));

  const SHOW = 300;
  const chips = (arr) => arr.slice(0, SHOW).map(s => `<span class="iv-chip">${e(s)}</span>`).join('') + (arr.length > SHOW ? `<span class="iv-sub">+${arr.length - SHOW} more</span>` : '');

  content.innerHTML = `
    <div class="iv-head">
      <div>
        <h3>${e(p.product_name ?? 'Product Details')}</h3>
        <div class="iv-tags">
          <span class="stock ${productTypeBadgeClass(p.product_type)}">${productTypeLabel(p.product_type)}</span>${partCategoryBadgeHtml(p)}
        </div>
      </div>
      <button class="close" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
    </div>

    <div class="iv-grid">
      ${identityCells}
      ${cell('Quantity in Stock', stockBadge)}
      ${cell('Lot No.', e(p.lot_no || ''))}
      ${cell(part ? 'Shipment Received Date' : 'Purchase / Receiving Date', e(dateTxt(p.purchase_date)))}
      ${cell('Supplier', e(p.supplier || ''))}
      ${p.supplier_address ? cell('Supplier Address', e(p.supplier_address)) : ''}
      ${cell('Price (per unit)', ivMoney(p.price))}
      ${cell('Tax', `${p.tax_rate ?? 0}%`)}
      ${cell('Stock Value', ivMoney((Number(p.price) || 0) * qty))}
      ${warranty ? cell('Warranty', warranty) : ''}
      ${part ? cell('Hologram Status', e(holoStatus)) : ''}
      ${p.product_type === 'damaged' ? cell('Reason of Damage', e(p.reason_of_damage ?? p.reason ?? '')) : ''}
      ${p.product_type === 'damaged' ? cell('Damage Status', e(p.damage_status ?? 'Damaged')) : ''}
      ${cell('Added By', e(p.created_by || ''))}
      ${p.updated_by ? cell('Last Updated By', e(p.updated_by)) : ''}
    </div>

    ${part ? `
      <div class="iv-title">Hologram Numbers (${holograms.length})</div>
      <div class="iv-chips">${holograms.length ? chips(holograms) : '<span class="iv-sub">None on file</span>'}</div>` : ''}

    <div class="iv-title">Serial Numbers (${serials.length})</div>
    <div class="iv-chips">${serials.length ? chips(serials) : '<span class="iv-sub">None on file</span>'}</div>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.onclick = ev => { if (ev.target === modal) modal.style.display = 'none'; };
  modal.style.display = 'flex';
}

function openEditModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
  invState.activeId = p._id || '';
  invState.activeModelNo = p.model_no || '';
  invState.activeProductType = p.product_type || 'product';
  invState.editSerials = [...(p.serial_numbers || [])];
  invState.editRemovedSerials = [];
  invState.editFaultySerials = [];

  const modal = document.getElementById('editModal');
  const form = modal.querySelector('form');
  form.elements['product_name'].value = p.product_name ?? '';
  form.elements['model_no'].value = p.model_no ?? '';
  form.elements['parent_product_name'].value = p.parent_product_name ?? '';
  form.elements['lot_no'].value = p.lot_no ?? '';
  form.elements['supplier'].value = p.supplier ?? '';
  form.elements['purchase_date'].value = p.purchase_date ?? '';
  form.elements['quantity'].value = p.quantity ?? '';
  form.elements['price'].value = p.price ?? '';
  form.elements['tax_rate'].value = p.tax_rate ?? '';

  const typeSelect = document.getElementById('editProductType');
  if (typeSelect) {
    const normalizedType = (p.product_type || 'product').trim().toLowerCase();
    // guard against a value that doesn't match any <option> (legacy casing,
    // stray whitespace, or an unrecognized type) leaving the select with no
    // selection at all, which would silently disable the serial-optional bypass
    typeSelect.value = [...typeSelect.options].some(o => o.value === normalizedType) ? normalizedType : 'product';
  }

  invState.editHolograms = [...hologramNumbersOf(p)];
  invState.editHologramQuantity = Number(p.quantity) || 0;
  toggleHologramSection(p.product_type || 'product');
  toggleTypeSpecificFields(p.product_type || 'product');
  renderHologramUI();
  wireHologramControls();

  renderEditSerialsUI();
  const quantityInput = form.elements['quantity'];
  quantityInput.removeEventListener('input', renderEditSerialsUI);
  quantityInput.addEventListener('input', renderEditSerialsUI);
  quantityInput.removeEventListener('input', syncEditHologramQuantity);
  quantityInput.addEventListener('input', syncEditHologramQuantity);

  if (typeSelect) {
    typeSelect.removeEventListener('change', renderEditSerialsUI);
    typeSelect.addEventListener('change', renderEditSerialsUI);
    typeSelect.removeEventListener('change', onEditTypeChangeForHologram);
    typeSelect.addEventListener('change', onEditTypeChangeForHologram);
    typeSelect.removeEventListener('change', onEditTypeChangeForTypeFields);
    typeSelect.addEventListener('change', onEditTypeChangeForTypeFields);
  }

  wireEditSerialFileUpload();

  modal.style.display = 'flex';
}

// Parts (spare_parts/service_parts) are identified by their own name + which
// product they belong to, not by product_id/model_no (those stay empty for
// parts) — so the edit form swaps between the two identity shapes based on
// the selected type, same idea as toggleHologramSection below.
function toggleTypeSpecificFields(type) {
  const isPart = type === 'spare_parts' || type === 'service_parts';
  const nameInput = document.getElementById('editProductNameInput');
  const parentInput = document.getElementById('editParentProductName');
  const idModelWrap = document.getElementById('editIdModelWrap');
  if (nameInput) nameInput.placeholder = isPart ? 'Part Name' : 'Product Name';
  if (parentInput) parentInput.style.display = isPart ? 'block' : 'none';
  if (idModelWrap) idModelWrap.style.display = isPart ? 'none' : 'flex';
}

function onEditTypeChangeForTypeFields() {
  const typeSelect = document.getElementById('editProductType');
  toggleTypeSpecificFields(typeSelect ? typeSelect.value : 'product');
}

// hologram numbers are only tracked on spare_parts / service_parts entries —
// "product" units get theirs via the per-serial service/assembly workflow instead
function toggleHologramSection(type) {
  const section = document.getElementById('editHologramSection');
  if (section) section.style.display = (type === 'spare_parts' || type === 'service_parts') ? 'block' : 'none';
}

function onEditTypeChangeForHologram() {
  const typeSelect = document.getElementById('editProductType');
  toggleHologramSection(typeSelect ? typeSelect.value : 'product');
}

// keeps the hologram status line's "of N quantity" number in sync while the
// user is typing a new quantity into the edit form (named fn so the
// add/removeEventListener pairing in openEditModal actually works)
function syncEditHologramQuantity() {
  const modal = document.getElementById('editModal');
  const quantityInput = modal.querySelector('form').elements['quantity'];
  invState.editHologramQuantity = Number(quantityInput.value) || 0;
  renderHologramUI();
}

// ---------- Hologram numbers (per-unit, spare_parts / service_parts) ----------
// Renders the chip list + status line ("Active"/"Partial"/"Pending") based on
// how many hologram numbers are on file vs. the quantity on record.
function renderHologramUI() {
  const list = document.getElementById('currentHologramList');
  const statusMsg = document.getElementById('hologramStatusMsg');
  if (!list || !statusMsg) return;

  const holograms = invState.editHolograms;
  const qty = invState.editHologramQuantity;
  const count = holograms.length;

  list.innerHTML = holograms.map(h => `
    <span data-hologram="${h}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;background:var(--info-bg);color:var(--primary-dark);">
      ${h}
      <button type="button" class="hologram-remove-btn" data-hologram="${h}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;">×</button>
    </span>`).join('') || '<span style="font-size:12px;color:var(--text-light);">No hologram numbers on file.</span>';

  list.querySelectorAll('.hologram-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => submitHologramChange({ remove: [btn.dataset.hologram] }));
  });

  let status = 'Pending', color = 'var(--text-muted)';
  if (count > 0 && qty && count >= qty) { status = 'Active'; color = 'var(--success-dark)'; }
  else if (count > 0) { status = 'Partial'; color = 'var(--warning-dark)'; }
  statusMsg.textContent = `${status} — ${count} of ${qty} unit(s) have a hologram number on file${count < qty ? ` (${qty - count} remaining)` : ''}.`;
  statusMsg.style.color = color;
}

// Sends a hologram add/remove to the server immediately (independent of the
// main "Save" button) so the partial/leftover logic can be validated against
// the quantity that's actually on record right now.
let hologramBusy = false;
async function submitHologramChange({ add = [], remove = [] }) {
  if (hologramBusy) return;
  hologramBusy = true;
  try {
    const res = await apiFetch(`/inventory/update/${invState.activeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updated_values: {},
        new_hologram_numbers: add,
        remove_hologram_numbers: remove
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'could not update hologram numbers');

    if (remove.length) invState.editHolograms = invState.editHolograms.filter(h => !remove.includes(h));
    if (add.length) invState.editHolograms = invState.editHolograms.concat(add.slice(0, data.hologram_added));
    renderHologramUI();
    await loadInventory();

    if ((data.hologram_leftover || []).length) {
      openHologramOverflowModal(data.hologram_added, data.hologram_leftover);
    }
  } catch (err) {
    refreshIfMissing(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Hologram update failed', err.message, false);
  } finally {
    hologramBusy = false;
  }
}

// Shown when an uploaded/typed batch of hologram numbers has more entries
// than there are remaining unit slots — offers exporting the unused ones.
function openHologramOverflowModal(added, leftover) {
  const modal = document.getElementById('hologramOverflowModal');
  const msg = document.getElementById('hologramOverflowMsg');
  const listBox = document.getElementById('hologramOverflowList');
  if (!modal || !msg || !listBox) return;

  msg.textContent = `${added} hologram number(s) were added. ${leftover.length} extra hologram number(s) didn't fit — quantity is already fully covered.`;
  listBox.textContent = leftover.join(', ');
  modal.dataset.leftover = JSON.stringify(leftover);
  modal.style.display = 'flex';
}

function exportHologramLeftoverToExcel(leftover) {
  const ws = XLSX.utils.aoa_to_sheet([['Hologram Number'], ...leftover.map(h => [h])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leftover Hologram Numbers');
  XLSX.writeFile(wb, `leftover_hologram_numbers_${Date.now()}.xlsx`);
}

function wireHologramControls() {
  const addBtn = document.getElementById('hologramManualAddBtn');
  const manualInput = document.getElementById('hologramManualInput');
  const fileBtn = document.getElementById('hologramFileBtn');
  const fileInput = document.getElementById('hologramFileInput');
  const preview = document.getElementById('hologramFilePreview');
  if (!addBtn || !fileBtn) return;

  // clone-replace to drop old listeners since this is re-wired on every open
  const newAddBtn = addBtn.cloneNode(true);
  addBtn.parentNode.replaceChild(newAddBtn, addBtn);
  const newFileBtn = fileBtn.cloneNode(true);
  fileBtn.parentNode.replaceChild(newFileBtn, fileBtn);
  const newFileInput = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(newFileInput, fileInput);

  newAddBtn.addEventListener('click', () => {
    const val = manualInput.value.trim();
    if (!val) return;
    manualInput.value = '';
    submitHologramChange({ add: [val] });
  });

  newFileBtn.addEventListener('click', () => newFileInput.click());
  newFileInput.addEventListener('change', () => {
    const file = newFileInput.files[0];
    if (!file) return;
    parseSerialsFromFile(file, (holograms) => {
      preview.textContent = `${holograms.length} hologram number(s) read from file — adding...`;
      preview.style.color = 'var(--primary-dark)';
      submitHologramChange({ add: holograms });
    }, (msg) => { preview.innerHTML = `<span style="color:var(--danger-dark);">${msg}</span>`; }, { lowercase: false });
  });

  const overflowClose = document.getElementById('hologramOverflowCloseBtn');
  const overflowExport = document.getElementById('hologramOverflowExportBtn');
  if (overflowClose) overflowClose.onclick = () => { document.getElementById('hologramOverflowModal').style.display = 'none'; };
  if (overflowExport) overflowExport.onclick = () => {
    const modal = document.getElementById('hologramOverflowModal');
    const leftover = JSON.parse(modal.dataset.leftover || '[]');
    exportHologramLeftoverToExcel(leftover);
  };
}

// "Add by file" for the edit modal: lets the user upload an Excel/CSV of
// serial numbers instead of typing each new one in by hand when quantity
// goes up. Re-wired on every open so listeners don't stack across opens.
function wireEditSerialFileUpload() {
  const btn = document.getElementById('editSerialFileBtn');
  const fileInput = document.getElementById('editSerialFileInput');
  const preview = document.getElementById('editFileSerialPreview');
  if (!btn || !fileInput) return;

  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  const newFileInput = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(newFileInput, fileInput);

  newBtn.addEventListener('click', () => newFileInput.click());
  newFileInput.addEventListener('change', () => {
    const file = newFileInput.files[0];
    if (!file) return;
    parseSerialsFromFile(file, (serials) => {
      const modal = document.getElementById('editModal');
      const quantityInput = modal.querySelector('form').elements['quantity'];
      const keptCount = invState.editSerials.length - invState.editRemovedSerials.length - invState.editFaultySerials.length;
      quantityInput.value = keptCount + serials.length;
      renderEditSerialsUI();
      const newInputs = document.querySelectorAll('#newSerialsBox .new-serial-input');
      newInputs.forEach((inp, i) => { inp.value = serials[i] || ''; });
      preview.textContent = `${serials.length} serial number(s) loaded from file.`;
    }, (msg) => { preview.innerHTML = `<span style="color:var(--danger-dark);">${msg}</span>`; });
  });
}

// Cycles one serial number through: normal -> faulty -> marked for removal
// -> normal. A lot that's already IN the Damaged Product category skips the
// "faulty" step (it's already damaged) and goes straight to removal.
function cycleEditSerialState(s) {
  const typeSelect = document.getElementById('editProductType');
  const currentType = (typeSelect ? typeSelect.value : invState.activeProductType) || 'product';
  const isRemoved = invState.editRemovedSerials.includes(s);
  const isFaulty = invState.editFaultySerials.includes(s);

  if (isRemoved) {
    invState.editRemovedSerials = invState.editRemovedSerials.filter(x => x !== s);
  } else if (isFaulty) {
    invState.editFaultySerials = invState.editFaultySerials.filter(x => x !== s);
    invState.editRemovedSerials.push(s);
  } else if (currentType === 'damaged') {
    invState.editRemovedSerials.push(s);
  } else {
    invState.editFaultySerials.push(s);
  }
  renderEditSerialsUI();
}

// Keeps the serial-number list in sync with whatever quantity is typed into
// the edit form: shows current serials (removable if quantity is going down),
// and prompts for new serial numbers if quantity is going up. Each serial
// chip cycles through three states on click: normal -> faulty (goes to the
// Damaged Product category on save) -> marked for removal (write-off, gone
// from stock entirely) -> back to normal.
function renderEditSerialsUI() {
  const modal = document.getElementById('editModal');
  const quantityInput = modal.querySelector('form').elements['quantity'];
  const targetQuantity = Number(quantityInput.value) || 0;
  const keptCount = invState.editSerials.length - invState.editRemovedSerials.length - invState.editFaultySerials.length;
  const typeSelect = document.getElementById('editProductType');
  const serialOptional = isSerialOptionalType(typeSelect ? typeSelect.value : 'product');

  const currentList = document.getElementById('currentSerialsList');
  currentList.innerHTML = invState.editSerials.map(s => {
    const removed = invState.editRemovedSerials.includes(s);
    const faulty = invState.editFaultySerials.includes(s);
    const bg = removed ? 'var(--danger-bg)' : (faulty ? 'var(--warning-bg)' : 'var(--info-bg)');
    const color = removed ? 'var(--danger-dark)' : (faulty ? 'var(--warning-dark)' : 'var(--primary-dark)');
    const icon = removed ? '↺' : (faulty ? '✕' : '×');
    const title = removed
      ? 'Marked for removal — click to restore to normal'
      : (faulty ? 'Marked faulty — click to mark for removal instead' : 'Click to mark this unit faulty');
    return `<span data-serial="${s}" title="${title}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;
      background:${bg};color:${color};text-decoration:${removed ? 'line-through' : 'none'};">
      ${faulty ? '<i class="fa-solid fa-triangle-exclamation" style="font-size:10px;"></i>' : ''}${s}
      <button type="button" class="serial-toggle-btn" data-serial="${s}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;">
        ${icon}
      </button>
    </span>`;
  }).join('') || '<span style="font-size:12px;color:var(--text-light);">No serial numbers on file.</span>';

  currentList.querySelectorAll('.serial-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => cycleEditSerialState(btn.dataset.serial));
  });

  const msgBox = document.getElementById('serialDeltaMsg');
  const newBox = document.getElementById('newSerialsBox');
  const fileBtn = document.getElementById('editSerialFileBtn');
  const diff = targetQuantity - keptCount;

  // serial numbers are optional for some types, so quantity can move freely
  // without needing to add/remove serials to match it
  if (serialOptional) {
    msgBox.textContent = 'Serial numbers are optional for this product type.';
    msgBox.style.color = 'var(--text-muted)';
    newBox.innerHTML = '';
    if (fileBtn) fileBtn.style.display = 'none';
    return;
  }

  if (fileBtn) fileBtn.style.display = diff > 0 ? 'inline-block' : 'none';
  if (diff <= 0) {
    const preview = document.getElementById('editFileSerialPreview');
    if (preview) preview.textContent = '';
  }

  if (diff > 0) {
    msgBox.textContent = `Quantity increased — add ${diff} new serial number(s) below, or upload them from a file.`;
    msgBox.style.color = 'var(--primary-dark)';
    const existingInputs = newBox.querySelectorAll('input');
    const existingValues = [...existingInputs].map(i => i.value);
    newBox.innerHTML = '';
    for (let i = 0; i < diff; i++) {
      const input = document.createElement('input');
      input.className = 'new-serial-input';
      input.placeholder = `New serial number #${i + 1}`;
      input.value = existingValues[i] || '';
      input.style.cssText = 'padding:8px 10px;border:1px solid var(--border);border-radius:8px;';
      newBox.appendChild(input);
    }
  } else if (diff < 0) {
    msgBox.textContent = `Quantity decreased — mark ${-diff} serial number(s) above as faulty or for removal (click a chip to cycle through: faulty → removal → normal).`;
    msgBox.style.color = 'var(--warning-dark)';
    newBox.innerHTML = '';
  } else {
    msgBox.textContent = 'Quantity matches the serial numbers on file.';
    msgBox.style.color = 'var(--success-dark)';
    newBox.innerHTML = '';
  }
}

function openDeleteModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
  invState.activeId = p._id || '';
  invState.activeModelNo = p.model_no || '';
  const msg = document.querySelector('#deleteModal p');
  if (msg) msg.textContent = `Are you sure you want to delete "${p.product_name}"? This action cannot be undone.`;
  document.getElementById('deleteModal').style.display = 'flex';
}

// ---------- Add Product wizard ----------
const addWiz = {
  productId: '',
  productName: '',
  modelNo: '',
  productType: 'product',
  lotNo: '',
  quantity: 1,
  serials: [],
  supplierName: '',
  supplierAddress: '',
  purchaseDate: '',
  price: '',
  taxRate: ''
};

function resetAddWizard() {
  addWiz.productId = '';
  addWiz.productName = '';
  addWiz.modelNo = '';
  addWiz.productType = 'product';
  addWiz.lotNo = '';
  addWiz.quantity = 1;
  addWiz.serials = [];
  addWiz.supplierName = '';
  addWiz.supplierAddress = '';
  addWiz.purchaseDate = '';
  addWiz.price = '';
  addWiz.taxRate = '';
}

function addModalBody() {
  const modal = document.getElementById('addModal');
  let content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="addWizTitle">Add Product</h3>
      <button type="button" id="addWizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div id="addWizBody"></div>`;
  content.querySelector('#addWizClose').addEventListener('click', () => modal.style.display = 'none');
  return document.getElementById('addWizBody');
}

function addWizTitle(t) { document.getElementById('addWizTitle').textContent = t; }

// ---------- Supplier / company picker (shared by the lot + part forms) ----------
// Companies come from the same customers collection the Orders page creates, so a
// supplier is picked from existing parties — or typed in manually (saved as a new
// company with the same schema: address, GST, contact person / number / email).
const supplierState = { companies: [] };

async function loadSupplierCompanies() {
  try {
    const res = await apiFetch('/customer/company_list');
    if (!res.ok) return;
    const data = await res.json();
    supplierState.companies = data.dataset || [];
  } catch (err) { /* picker still works in manual mode */ }
}

// ---------- payment block (Paid / Partial / Credit + credit days) shared by the lot and part forms ----------
function paymentBlockHTML(selId, hintId, required, emptyLabel) {
  const inp = 'padding:10px;border:1px solid var(--border);border-radius:8px;';
  return `
      <select name="payment_mode" id="${selId}" ${required ? 'required' : ''} style="${inp}">
        <option value="">${emptyLabel}</option>
        <option value="paid">Paid (full)</option>
        <option value="partial">Partial (part now, rest later)</option>
        <option value="credit">Credit (pay later)</option>
      </select>
      <div class="payExtra" style="display:none;flex-direction:column;gap:8px;background:var(--warning-bg);border:1px solid var(--warning-bg);border-radius:10px;padding:10px;">
        <div class="payPaidWrap" style="display:none;flex-direction:column;gap:4px;">
          <label style="font-size:12px;color:var(--warning-dark);font-weight:600;">Amount paid now (₹)</label>
          <input name="paid_amount" type="number" min="0" step="any" placeholder="e.g. half of the total" style="${inp}">
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label class="payDaysLabel" style="font-size:12px;color:var(--warning-dark);font-weight:600;">In how many days will the payment be made?</label>
          <input name="credit_days" type="number" min="1" max="365" step="1" placeholder="Credit time (days)" style="${inp}">
        </div>
      </div>
      <div id="${hintId}" style="display:none;font-size:12px;border-radius:8px;padding:8px 10px;"></div>`;
}

function paymentTotal(form) {
  const qty = Math.max(0, Number(form.querySelector('[name="quantity"]').value) || 0);
  const price = Number(String(form.querySelector('[name="price"]').value).replace(/,/g, '')) || 0;
  const tax = Number(form.querySelector('[name="tax_rate"]').value) || 0;
  return Math.round(price * qty * (1 + tax / 100) * 100) / 100;
}

function paymentDueDate(form) {
  const days = Number(form.querySelector('[name="credit_days"]').value) || 0;
  const base = form.querySelector('[name="purchase_date"]').value || new Date().toISOString().slice(0, 10);
  const d = new Date(base);
  if (!days || isNaN(d)) return '';
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// returns an error message, or '' when the payment fields are fine
function validatePaymentFields(form) {
  const mode = form.querySelector('[name="payment_mode"]').value;
  if (mode !== 'partial' && mode !== 'credit') return '';
  const days = Number(form.querySelector('[name="credit_days"]').value);
  if (!Number.isInteger(days) || days < 1 || days > 365) return 'Enter in how many days (1-365) the payment will be made.';
  if (mode === 'partial') {
    const paid = Number(form.querySelector('[name="paid_amount"]').value) || 0;
    const total = paymentTotal(form);
    if (paid <= 0) return 'Enter the amount paid now for a partial payment.';
    if (total > 0 && paid >= total) return 'Partial payment must be less than the total — choose Paid instead.';
  }
  return '';
}

function readPaymentFields(form) {
  const mode = form.querySelector('[name="payment_mode"]').value;
  return {
    payment_mode: mode || '',
    paid_amount: mode === 'partial' ? (Number(form.querySelector('[name="paid_amount"]').value) || 0) : 0,
    credit_days: (mode === 'partial' || mode === 'credit') ? (Number(form.querySelector('[name="credit_days"]').value) || 0) : 0
  };
}

// shows/hides the extra fields and keeps the coloured hint under the select up to date
function wirePaymentBlock(form, selId, hintId) {
  const sel = form.querySelector('#' + selId);
  const hint = form.querySelector('#' + hintId);
  const extra = form.querySelector('.payExtra');
  const refresh = () => {
    const mode = sel.value;
    extra.style.display = (mode === 'partial' || mode === 'credit') ? 'flex' : 'none';
    form.querySelector('.payPaidWrap').style.display = mode === 'partial' ? 'flex' : 'none';
    form.querySelector('.payDaysLabel').textContent = mode === 'partial'
      ? 'In how many days will the remaining payment be made?' : 'In how many days will the payment be made?';
    if (!mode) { hint.style.display = 'none'; return; }
    const total = paymentTotal(form);
    const fmt = n => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const sup = readSupplier(form).supplier;
    const due = paymentDueDate(form);
    const dueTxt = due ? `, due on ${due}` : '';
    hint.style.display = 'block';
    if (!sup) {
      hint.style.cssText += 'background:var(--warning-bg);color:var(--warning-dark);';
      hint.textContent = 'Select a company above so this purchase can be recorded against it.';
    } else if (mode === 'credit') {
      hint.style.cssText += 'background:var(--danger-bg);color:var(--danger-dark);';
      hint.textContent = `Credit: ${fmt(total)} will be added to "${sup}" under Credit (Users → Companies) and shown in its history${dueTxt}.`;
    } else if (mode === 'partial') {
      const paid = Number(form.querySelector('[name="paid_amount"]').value) || 0;
      hint.style.cssText += 'background:var(--warning-bg);color:var(--warning-dark);';
      hint.textContent = `Partial: ${fmt(paid)} paid now, ${fmt(Math.max(total - paid, 0))} of ${fmt(total)} goes on Credit for "${sup}"${dueTxt}.`;
    } else {
      hint.style.cssText += 'background:var(--success-bg);color:var(--success-dark);';
      hint.textContent = `Paid: ${fmt(total)} is noted in "${sup}" history only — nothing added to Credit.`;
    }
  };
  sel.addEventListener('change', refresh);
  form.addEventListener('supplierchange', refresh);
  ['quantity', 'price', 'tax_rate', 'paid_amount', 'credit_days', 'purchase_date'].forEach(n => {
    const el = form.querySelector(`[name="${n}"]`);
    if (el) { el.addEventListener('input', refresh); el.addEventListener('change', refresh); }
  });
  return refresh;
}

function supplierBlockHTML(optional) {
  const inp = 'padding:10px;border:1px solid var(--border);border-radius:8px;';
  return `
    <div id="supplierBlock" style="display:flex;flex-direction:column;gap:8px;">
      <label style="font-size:12px;color:var(--text-muted);margin-bottom:-4px;">Supplier / Company${optional ? ' (optional)' : ''}</label>
      <select name="supplier_pick" id="supplierPick" ${optional ? '' : 'required'} style="${inp}">
        <option value="">Select company…</option>
        <option value="__manual__">＋ Type company details manually</option>
      </select>
      <div id="supplierExisting" style="display:none;font-size:12px;color:var(--text-secondary);background:var(--bg-hover);border-radius:8px;padding:8px 10px;line-height:1.6;"></div>
      <div id="supplierManual" style="display:none;flex-direction:column;gap:8px;border:1px dashed var(--text-light);border-radius:8px;padding:10px;">
        <input name="supplier_name" placeholder="Company Name" style="${inp}">
        <input name="supplier_address" placeholder="Company Address" style="${inp}">
        <input name="supplier_gst" placeholder="GST Number" style="${inp}">
        <input name="supplier_contact_person" placeholder="Contact Person" style="${inp}">
        <input name="supplier_contact_number" placeholder="Contact Number" style="${inp}">
        <input name="supplier_contact_email" type="email" placeholder="Contact Email" style="${inp}">
      </div>
    </div>`;
}

function initSupplierPicker(form, optional) {
  const pick = form.querySelector('#supplierPick');
  const existingBox = form.querySelector('#supplierExisting');
  const manualBox = form.querySelector('#supplierManual');
  const nameInput = manualBox.querySelector('[name="supplier_name"]');

  const fillOptions = () => {
    const keep = pick.value;
    const manualOpt = pick.querySelector('option[value="__manual__"]');
    pick.querySelectorAll('option[data-company]').forEach(o => o.remove());
    supplierState.companies.forEach(c => {
      const o = document.createElement('option');
      o.value = c.customer_id;
      o.dataset.company = '1';
      o.textContent = c.company_name;
      pick.insertBefore(o, manualOpt);
    });
    pick.value = keep;
  };

  const sync = () => {
    const v = pick.value;
    const c = supplierState.companies.find(x => x.customer_id === v);
    manualBox.style.display = v === '__manual__' ? 'flex' : 'none';
    nameInput.required = v === '__manual__';
    if (c) {
      existingBox.style.display = 'block';
      existingBox.innerHTML = [c.company_address, c.gst_number ? 'GST: ' + c.gst_number : '',
        [c.contractor_person, c.contractor_number, c.contractor_email].filter(Boolean).join(' • ')]
        .filter(Boolean).map(escapeHtmlInv).join('<br>') || 'No extra details on file for this company.';
    } else {
      existingBox.style.display = 'none';
    }
    form.dispatchEvent(new Event('supplierchange'));
  };
  pick.addEventListener('change', sync);
  fillOptions();
  sync();
  // companies load in the background; add them to the dropdown once they arrive
  loadSupplierCompanies().then(() => { fillOptions(); sync(); });
}

// Reads the picker back into the payload fields the backend expects.
function readSupplier(form) {
  const fd = new FormData(form);
  const v = fd.get('supplier_pick') || '';
  const c = supplierState.companies.find(x => x.customer_id === v);
  if (c) {
    return {
      supplier: c.company_name, supplier_address: c.company_address || '', supplier_gst: c.gst_number || '',
      supplier_contact_person: c.contractor_person || '', supplier_contact_number: c.contractor_number || '',
      supplier_contact_email: c.contractor_email || ''
    };
  }
  if (v === '__manual__') {
    return {
      supplier: (fd.get('supplier_name') || '').trim(), supplier_address: (fd.get('supplier_address') || '').trim(),
      supplier_gst: (fd.get('supplier_gst') || '').trim(), supplier_contact_person: (fd.get('supplier_contact_person') || '').trim(),
      supplier_contact_number: (fd.get('supplier_contact_number') || '').trim(), supplier_contact_email: (fd.get('supplier_contact_email') || '').trim()
    };
  }
  return { supplier: '', supplier_address: '', supplier_gst: '', supplier_contact_person: '', supplier_contact_number: '', supplier_contact_email: '' };
}

// Step 1: pick the category first — the next form asks for exactly the details
// that category's table and view-details modal show.
const ADD_TYPES = [
  { type: 'product', label: 'Product', icon: 'fa-box', hint: 'Finished units with serial numbers' },
  { type: 'spare_parts', label: 'Spare Parts', icon: 'fa-gears', hint: 'Assembly parts, tracked by quantity' },
  { type: 'service_parts', label: 'Service Parts', icon: 'fa-screwdriver-wrench', hint: 'Purchase / warranty parts' },
  { type: 'damaged', label: 'Faulty', icon: 'fa-triangle-exclamation', hint: 'Damaged units with reason' },
  { type: 'accessories', label: 'Accessories', icon: 'fa-plug', hint: 'Serial numbers optional' }
];

function renderAddTypeStep() {
  const body = addModalBody();
  addWizTitle('Add to Inventory');
  body.innerHTML = `
    <p style="color:var(--text-muted);margin-bottom:14px;">What are you adding?</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      ${ADD_TYPES.map(t => `
        <button type="button" class="add-type-btn" data-type="${t.type}" style="padding:16px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg-light);cursor:pointer;">
          <i class="fa-solid ${t.icon}"></i><br><strong>${t.label}</strong><br><small style="color:var(--text-light);">${t.hint}</small>
        </button>`).join('')}
    </div>`;
  body.querySelectorAll('.add-type-btn').forEach(btn => btn.addEventListener('click', () => {
    addWiz.productType = btn.dataset.type;
    if (addWiz.productType === 'spare_parts' || addWiz.productType === 'service_parts') renderPartDetailsStep();
    else renderLotDetailsStep();
  }));
}

// Spare parts / service parts: same fields as their table + view-details
// (product it belongs to, part name, received date, warranty, quantity, hologram numbers).
function renderPartDetailsStep() {
  const body = addModalBody();
  const isService = addWiz.productType === 'service_parts';
  addWizTitle(`Add ${productTypeLabel(addWiz.productType)}`);
  const lbl = t => `<label style="font-size:12px;color:var(--text-muted);margin-bottom:-6px;">${t}</label>`;
  body.innerHTML = `
    <form id="partForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="parent_product_name" placeholder="Product Name (this part belongs to)" required>
      <input name="part_name" placeholder="Part Name" required>
      ${isService ? `<select name="part_category" required>
        <option value="">Select type (Purchase / Warranty)</option>
        <option value="purchase">Purchase</option>
        <option value="warranty">Warranty</option>
      </select>` : ''}
      ${lbl('Shipment Received Date')}
      <input name="purchase_date" type="date" required>
      ${lbl(isService ? 'Warranty Until (required for Warranty type)' : 'Warranty Until (optional)')}
      <input name="warranty_until" type="date">
      <input name="quantity" type="number" min="1" placeholder="Quantity" required>
      <textarea name="hologram_numbers" rows="2" placeholder="Hologram numbers (optional, one per unit — comma or new line separated)"></textarea>
      <input name="lot_no" placeholder="Lot No. (optional)">
      ${supplierBlockHTML(false)}
      <input name="price" type="number" min="0" step="any" placeholder="Price (per unit)" required>
      <input name="tax_rate" type="number" min="0" step="any" placeholder="Tax Rate (%)" required>
      ${lbl('Payment — how was this purchase paid?')}
      ${paymentBlockHTML('partPaymentMode', 'partPaymentHint', true, 'Select payment type')}
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backPart" style="padding:10px 16px;border-radius:8px;border:none;background:var(--border);cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:var(--success-dark);color:#fff;cursor:pointer;">Save</button>
      </div>
    </form>`;
  document.getElementById('backPart').addEventListener('click', renderAddTypeStep);
  const partFormEl = document.getElementById('partForm');
  initSupplierPicker(partFormEl, false);
  wirePaymentBlock(partFormEl, 'partPaymentMode', 'partPaymentHint');

  document.getElementById('partForm').addEventListener('submit', lockOnce(async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const quantity = Math.max(1, Number(fd.get('quantity')) || 1);
    const category = isService ? (fd.get('part_category') || '') : '';
    const warrantyUntil = fd.get('warranty_until') || '';
    if (category === 'warranty' && !warrantyUntil) { alert('Warranty Until is required for a warranty part.'); return; }
    // hologram numbers are allowed to repeat — no uniqueness guard here.
    const holograms = (fd.get('hologram_numbers') || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (holograms.length > quantity) { alert('Hologram numbers cannot be more than the quantity.'); return; }

    const payload = {
      product_name: fd.get('part_name').trim(),
      product_id: '',
      model_no: '',
      product_type: addWiz.productType,
      parent_product_name: fd.get('parent_product_name').trim(),
      part_category: category,
      warranty_until: warrantyUntil,
      hologram_numbers: holograms,
      quantity,
      serial_numbers: [],
      lot_no: fd.get('lot_no') || '',
      ...readSupplier(e.target),
      purchase_date: fd.get('purchase_date'),
      price: String(fd.get('price') || '0'),
      tax_rate: Number(fd.get('tax_rate')) || 0,
      ...readPaymentFields(e.target)
    };
    if (!payload.supplier) { alert('Please select or enter the company this part was purchased from.'); return; }
    const payErr = validatePaymentFields(e.target);
    if (payErr) { alert(payErr); return; }
    try {
      const res = await apiFetch('/inventory/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'creation failed');
      document.getElementById('addModal').style.display = 'none';
      resetAddWizard();
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  }));
}

// Step 3: lot no, quantity, serial numbers (auto/manual), supplier + pricing
function renderLotDetailsStep() {
  const body = addModalBody();
  addWizTitle(`Add ${productTypeLabel(addWiz.productType)}`);
  const isFaulty = addWiz.productType === 'damaged';
  const req = isFaulty ? '' : 'required';   // supplier / price details are optional for faulty units
  const lbl = t => `<label style="font-size:12px;color:var(--text-muted);margin-bottom:-6px;">${t}</label>`;
  body.innerHTML = `
    <form id="lotForm" style="display:flex;flex-direction:column;gap:10px;">
      <input type="hidden" name="product_type" id="lotProductType" value="${addWiz.productType}">
      <input name="product_name" placeholder="Product Name" required>
      <input name="model_no" placeholder="Model No." required>
      <input name="lot_no" placeholder="Lot No." ${req}>
      <input name="quantity" type="number" min="1" placeholder="Quantity" required>
      <input name="first_serial" id="firstSerialInput" placeholder="Serial No. (first unit)">
      <div id="serialOptionalMsg" style="display:none;font-size:12px;color:var(--text-muted);">Serial numbers are optional for this type — leave blank to skip, or add them below.</div>
      <div id="fileSerialBox" style="border:1px dashed var(--text-light);border-radius:8px;padding:8px;">
        <label style="font-size:12px;color:var(--text-muted);">Or add by file — upload an Excel/CSV of serial numbers</label>
        <input type="file" id="serialFileInput" accept=".xlsx,.xls,.csv" style="width:100%;padding:6px 0;font-size:12px;">
        <div id="fileSerialPreview" style="font-size:12px;color:var(--primary-dark);margin-top:4px;"></div>
      </div>
      <div id="serialModeBox" style="display:none;">
        <label style="font-size:13px;color:var(--text-muted);">Remaining serial numbers</label>
        <div style="display:flex;gap:14px;margin:6px 0;font-size:13px;">
          <label><input type="radio" name="serial_mode" value="auto" checked> Auto-generate</label>
          <label><input type="radio" name="serial_mode" value="manual"> Enter manually</label>
        </div>
        <div id="manualSerialsBox" style="display:none;max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
        <div id="autoPreviewBox" style="font-size:12px;color:var(--text-muted);"></div>
      </div>
      ${supplierBlockHTML(isFaulty)}
      ${lbl(isFaulty ? 'Received Date' : 'Receiving Date')}
      <input name="purchase_date" type="date" required>
      <input name="price" placeholder="Price (per unit)${isFaulty ? ' (optional)' : ''}" ${req}>
      <input name="tax_rate" type="number" placeholder="Tax Rate (%)${isFaulty ? ' (optional)' : ''}" ${req}>
      ${lbl('Payment — how was this purchase paid?')}
      ${paymentBlockHTML('lotPaymentMode', 'paymentHint', !isFaulty, isFaulty ? 'Select payment (optional)' : 'Select payment type')}
      ${isFaulty ? `${lbl('Warranty Until (optional)')}
      <input name="warranty_until" type="date">
      <textarea name="reason" rows="2" placeholder="Reason of damage" required></textarea>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backAdd3" style="padding:10px 16px;border-radius:8px;border:none;background:var(--border);cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:var(--success-dark);color:#fff;cursor:pointer;">Save Product</button>
      </div>
    </form>`;

  document.getElementById('backAdd3').addEventListener('click', renderAddTypeStep);

  const form = document.getElementById('lotForm');
  initSupplierPicker(form, isFaulty);

  // live hint: total amount, and what Credit / Partial does on the company ledger
  wirePaymentBlock(form, 'lotPaymentMode', 'paymentHint');
  const typeSelect = document.getElementById('lotProductType');
  const qtyInput = form.querySelector('[name="quantity"]');
  const firstSerialInput = document.getElementById('firstSerialInput');
  const serialOptionalMsg = document.getElementById('serialOptionalMsg');
  const serialModeBox = document.getElementById('serialModeBox');
  const manualBox = document.getElementById('manualSerialsBox');
  const autoPreviewBox = document.getElementById('autoPreviewBox');
  const fileSerialInput = document.getElementById('serialFileInput');
  const fileSerialPreview = document.getElementById('fileSerialPreview');
  let fileSerials = [];
  let usingFileSerials = false;

  // serial number is required for every type except accessories
  function syncSerialRequirement() {
    const optional = isSerialOptionalType(typeSelect.value);
    firstSerialInput.required = !optional;
    serialOptionalMsg.style.display = optional ? 'block' : 'none';
  }
  typeSelect.addEventListener('change', () => { syncSerialRequirement(); refreshSerialUI(); });
  syncSerialRequirement();

  fileSerialInput.addEventListener('change', () => {
    const file = fileSerialInput.files[0];
    if (!file) return;
    parseSerialsFromFile(file, (serials) => {
      fileSerials = serials;
      usingFileSerials = true;
      qtyInput.value = serials.length;
      qtyInput.readOnly = true;
      firstSerialInput.value = serials[0];
      firstSerialInput.readOnly = true;
      serialModeBox.style.display = 'none';
      fileSerialPreview.innerHTML = `${serials.length} serial number(s) loaded from file. ` +
        `<button type="button" id="clearFileSerials" style="border:none;background:none;color:var(--danger-dark);cursor:pointer;font-size:12px;">Clear</button>`;
      document.getElementById('clearFileSerials').addEventListener('click', () => {
        usingFileSerials = false;
        fileSerials = [];
        fileSerialInput.value = '';
        qtyInput.readOnly = false;
        firstSerialInput.readOnly = false;
        firstSerialInput.value = '';
        fileSerialPreview.innerHTML = '';
        refreshSerialUI();
      });
    }, (msg) => { fileSerialPreview.innerHTML = `<span style="color:var(--danger-dark);">${msg}</span>`; });
  });

  function generateAutoSerials(firstSerial, quantity) {
    const match = firstSerial.match(/^(.*?)(\d+)$/);
    const serials = [firstSerial];
    if (!match) {
      for (let i = 2; i <= quantity; i++) serials.push(`${firstSerial}-${i}`);
      return serials;
    }
    const [, prefix, numStr] = match;
    const width = numStr.length;
    const start = parseInt(numStr, 10);
    for (let i = 1; i < quantity; i++) {
      serials.push(`${prefix}${String(start + i).padStart(width, '0')}`);
    }
    return serials;
  }

  function renderManualInputs(quantity, firstSerial) {
    manualBox.innerHTML = '';
    for (let i = 2; i <= quantity; i++) {
      const inp = document.createElement('input');
      inp.placeholder = `Serial No. ${i}`;
      inp.className = 'manualSerialInput';
      inp.style.cssText = 'width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;';
      manualBox.appendChild(inp);
    }
  }

  let autoSerials = [];
  let autoRemoved = new Set();

  function renderAutoChips() {
    const remaining = autoSerials.filter(s => !autoRemoved.has(s));
    autoPreviewBox.innerHTML = `<div style="margin-bottom:6px;">Will generate ${remaining.length} unit(s) — click × to drop one:</div>` +
      autoSerials.map(s => {
        const removed = autoRemoved.has(s);
        return `<span data-s="${s}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;margin:2px;border-radius:14px;font-size:11px;${removed ? 'background:var(--danger-bg);color:var(--danger-dark);text-decoration:line-through;' : 'background:var(--info-bg);color:var(--primary-dark);'}">
          ${s}<button type="button" class="auto-serial-toggle" data-s="${s}" style="border:none;background:none;cursor:pointer;font-weight:700;color:inherit;">${removed ? '↺' : '×'}</button></span>`;
      }).join('');
    autoPreviewBox.querySelectorAll('.auto-serial-toggle').forEach(btn => btn.addEventListener('click', () => {
      const s = btn.dataset.s;
      if (autoRemoved.has(s)) {
        autoRemoved.delete(s);
      } else {
        const stillRemaining = autoSerials.filter(x => !autoRemoved.has(x));
        if (stillRemaining.length <= 1) { alert('At least one serial number / unit must remain.'); return; }
        autoRemoved.add(s);
      }
      renderAutoChips();
    }));
  }

  function refreshSerialUI() {
    if (usingFileSerials) return;
    const quantity = Math.max(1, Number(qtyInput.value) || 1);
    const firstSerial = firstSerialInput.value.trim();
    if (quantity <= 1 || !firstSerial) {
      serialModeBox.style.display = 'none';
      return;
    }
    serialModeBox.style.display = 'block';
    const mode = form.querySelector('[name="serial_mode"]:checked').value;
    if (mode === 'auto') {
      manualBox.style.display = 'none';
      autoPreviewBox.style.display = 'block';
      autoSerials = generateAutoSerials(firstSerial, quantity);
      autoRemoved = new Set();
      renderAutoChips();
    } else {
      autoPreviewBox.style.display = 'none';
      manualBox.style.display = 'flex';
      renderManualInputs(quantity, firstSerial);
    }
  }

  qtyInput.addEventListener('input', refreshSerialUI);
  firstSerialInput.addEventListener('input', refreshSerialUI);
  form.querySelectorAll('[name="serial_mode"]').forEach(r => r.addEventListener('change', refreshSerialUI));

  form.addEventListener('submit', lockOnce(async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const productType = fd.get('product_type') || 'product';
    const serialOptional = isSerialOptionalType(productType);
    let quantity, serials;

    if (usingFileSerials) {
      serials = fileSerials;
      quantity = serials.length;
    } else {
      quantity = Math.max(1, Number(fd.get('quantity')) || 1);
      const firstSerial = (fd.get('first_serial') || '').trim().toLowerCase();

      if (serialOptional && !firstSerial) {
        // accessories can be listed with no serial numbers at all
        serials = [];
      } else {
        serials = [firstSerial];
        if (quantity > 1) {
          const mode = form.querySelector('[name="serial_mode"]:checked').value;
          if (mode === 'auto') {
            serials = autoSerials.filter(s => !autoRemoved.has(s)).map(s => s.toLowerCase());
            quantity = serials.length;
          } else {
            const manualInputs = [...manualBox.querySelectorAll('.manualSerialInput')].map(i => i.value.trim().toLowerCase());
            if (manualInputs.some(v => !v)) { alert('Please fill in all serial numbers.'); return; }
            serials = [firstSerial, ...manualInputs];
          }
        }
      }
    }

    // duplicate-serial guard only applies to product_type "product" — other
    // types (accessories/damaged) are allowed to reuse a serial number
    // (e.g. a unit moving into "damaged" under the serial it already had).
    if (serials.length && productType === 'product') {
      if (new Set(serials).size !== serials.length) { alert('Serial numbers must be unique.'); return; }

      const existingSerials = new Set(invState.products.flatMap(p => p.serial_numbers || []).map(s => (s || '').toLowerCase()));
      const duplicates = serials.filter(s => existingSerials.has(s));
      if (duplicates.length) { alert(`These serial number(s) already exist in inventory: ${duplicates.join(', ')}`); return; }
    }

    const payload = {
      product_name: fd.get('product_name').trim(),
      product_id: DEFAULT_PRODUCT_ID,
      model_no: fd.get('model_no').trim(),
      product_type: fd.get('product_type') || 'product',
      warranty_until: fd.get('warranty_until') || '',
      reason: (fd.get('reason') || '').trim(),
      lot_no: fd.get('lot_no'),
      quantity,
      serial_numbers: serials,
      ...readSupplier(form),
      purchase_date: fd.get('purchase_date'),
      price: fd.get('price') || '0',
      tax_rate: Number(fd.get('tax_rate')) || 0,
      ...readPaymentFields(form)
    };
    if (payload.payment_mode && !payload.supplier) { alert('Select the company this purchase was made from.'); return; }
    const payErr = validatePaymentFields(form);
    if (payErr) { alert(payErr); return; }

    try {
      const res = await apiFetch('/inventory/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'creation failed');
      document.getElementById('addModal').style.display = 'none';
      resetAddWizard();
      await loadInventory();
      if (data.ledger && data.ledger.error) alert(data.ledger.error);
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  }));
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const editForm = document.querySelector('#editModal form');
  if (editForm) editForm.addEventListener('submit', lockOnce(async e => {
    e.preventDefault();
    const form = e.target;
    const targetQuantity = Number(form.elements['quantity'].value);

    const new_serial_numbers = [...e.target.querySelectorAll('.new-serial-input')].map(i => i.value.trim().toLowerCase());
    const remove_serial_numbers = [...invState.editRemovedSerials];
    const faulty_serial_numbers = [...invState.editFaultySerials];
    const keptCount = invState.editSerials.length - remove_serial_numbers.length - faulty_serial_numbers.length;

    const typeSelect = document.getElementById('editProductType');
    const serialOptional = isSerialOptionalType(typeSelect ? typeSelect.value : 'product');

    // accessories: quantity and serial count don't have to match, so skip
    // all the strict sync checks below
    if (!serialOptional) {
      if (targetQuantity > keptCount) {
        if (new_serial_numbers.some(v => !v)) {
          showResponseModal('Missing serial numbers', 'Please fill in every new serial number field before saving.', false);
          return;
        }
        // duplicate-serial guard only applies to product_type "product" —
        // other types are allowed to reuse a serial number already on file.
        const editType = typeSelect ? typeSelect.value : 'product';
        if (editType === 'product') {
          const existingSerials = new Set(
            invState.products.flatMap(p => p.serial_numbers || [])
              .filter(s => !invState.editSerials.includes(s))
              .map(s => (s || '').toLowerCase())
          );
          const duplicates = new_serial_numbers.filter(s => existingSerials.has(s));
          if (duplicates.length) {
            showResponseModal('Duplicate serial numbers', `These serial number(s) already exist in inventory: ${duplicates.join(', ')}`, false);
            return;
          }
        }
      }
      if (targetQuantity < keptCount) {
        showResponseModal('Mark more serial numbers', `Quantity is ${targetQuantity} but ${keptCount} serial number(s) are still on file — mark ${keptCount - targetQuantity} more as faulty or for removal.`, false);
        return;
      }
    }

    const editType = typeSelect ? typeSelect.value : 'product';
    const editIsPart = editType === 'spare_parts' || editType === 'service_parts';
    const updated_values = {
      product_name: form.elements['product_name'].value,
      // id/model belong to physical products only; parts are identified by
      // parent_product_name instead, so each is only sent for its own type —
      // keeps a part's doc from picking up stray empty id/model fields and
      // vice versa.
      ...(editIsPart
        ? { parent_product_name: form.elements['parent_product_name'].value, product_id: '', model_no: '' }
        : { product_id: DEFAULT_PRODUCT_ID, model_no: form.elements['model_no'].value }),
      lot_no: form.elements['lot_no'].value,
      supplier: form.elements['supplier'].value,
      purchase_date: form.elements['purchase_date'].value,
      quantity: targetQuantity,
      price: form.elements['price'].value,
      tax_rate: Number(form.elements['tax_rate'].value),
      product_type: typeSelect ? typeSelect.value : 'product'
    };
    try {
      // invState.activeProductId / invState.activeModelNo are the ORIGINAL id and
      // model number, used to locate the record being edited. Any new id/model
      // typed into the form travels inside updated_values as a rename request.
      const res = await apiFetch(`/inventory/update/${invState.activeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values, new_serial_numbers, remove_serial_numbers, faulty_serial_numbers })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      document.getElementById('editModal').style.display = 'none';
      showResponseModal('Product updated', 'Inventory was updated successfully.', true);
      await loadInventory();
    } catch (err) {
      refreshIfMissing(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Update failed', err.message, false);
    }
  }));

  const deleteBtn = document.querySelector('#deleteModal .delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', lockOnce(async () => {
    try {
      const res = await apiFetch(`/inventory/delete/${invState.activeId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'delete failed');
      document.getElementById('deleteModal').style.display = 'none';
      await loadInventory();
    } catch (err) {
      refreshIfMissing(err);
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  }));
}