const invState = { products: [], activeProductId: null, activeModelNo: '', activeProductType: 'product', activeCategory: null, searchQuery: '', activeFilters: null, editSerials: [], editRemovedSerials: [], editFaultySerials: [], editHolograms: [], editHologramQuantity: 0 };
let invPage = 1;
const INV_PAGE_SIZE = 20;

// Some inventory documents were created before product_id was required and
// can have product_id === "". An empty string can never appear as a URL
// path segment (the /inventory/*/{product_id} routes simply won't match a
// missing segment), so we substitute this sentinel whenever we need to
// target such a record over the network — app.py decodes it back to "".
const EMPTY_PRODUCT_ID_SENTINEL = '__blank_id__';
function urlProductId(id) {
  const v = (id ?? '').toString().trim();
  return encodeURIComponent(v ? v : EMPTY_PRODUCT_ID_SENTINEL);
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
      <p style="color:#64748b;font-size:13px;margin-bottom:10px;">Search a serial number to see its full lifetime record — when it was added to inventory, assembled, sold/demoed, returned, and every service raised against it.</p>
      <div style="display:flex;gap:8px;">
        <input id="serialRecordInput" placeholder="Enter serial number" value="${prefill ? escapeHtmlInv(prefill) : ''}" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
        <button type="button" id="serialRecordSearchBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Search</button>
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
    if (!serial) { resultsBox.innerHTML = '<p style="color:#d62828;font-size:13px;">Enter a serial number to search.</p>'; return; }
    resultsBox.innerHTML = '<p style="color:#94a3b8;font-size:13px;">Searching...</p>';
    try {
      const res = await apiFetch(`/inventory/serial_history/${encodeURIComponent(serial)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'search failed');
      resultsBox.innerHTML = renderSerialTimeline(data.events || [], serial);
    } catch (err) {
      if (err.message === 'unauthorized' || err.message === 'forbidden') return;
      resultsBox.innerHTML = `<p style="color:#d62828;font-size:13px;">${escapeHtmlInv(err.message)}</p>`;
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
    return `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:16px;">No record found for serial number <strong>${escapeHtmlInv(serial)}</strong>.</p>`;
  }
  return `
    <div style="font-size:13px;color:#334155;margin-bottom:10px;">Lifetime record for <strong>${escapeHtmlInv(serial)}</strong> (${events.length} event${events.length > 1 ? 's' : ''})</div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${events.map(ev => `
        <div style="border-left:3px solid #1665ff;padding-left:12px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <strong style="font-size:13px;"><i class="fa-solid ${SERIAL_EVENT_ICONS[ev.type] || 'fa-circle-dot'}" style="margin-right:6px;color:#1665ff;"></i>${escapeHtmlInv(ev.label)}</strong>
            <small style="color:#94a3b8;">${ev.date ? new Date(ev.date).toLocaleDateString('en-GB') : '-'}</small>
          </div>
          <p style="font-size:12px;color:#64748b;margin-top:4px;">${escapeHtmlInv(serialEventDetailLine(ev))}</p>
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

// ---------- Cards -> click to see details ----------
function wireCardClicks() {
  document.querySelectorAll('.card-clickable').forEach(card => {
    card.addEventListener('click', () => openCardDetailModal(card.dataset.card));
  });
}

function openCardDetailModal(cardType) {
  const modal = document.getElementById('cardDetailModal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  const products = invState.products;

  const rowsHtml = (list, cols) => list.length
    ? `<table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="text-align:left;">${cols.map(c => `<th style="padding:6px 4px;border-bottom:1px solid #eef1f6;">${c.label}</th>`).join('')}</tr></thead>
        <tbody>${list.map(p => `<tr>${cols.map(c => `<td style="padding:6px 4px;border-bottom:1px solid #f5f7fa;">${c.cell(p)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`
    : '<p style="color:#94a3b8;text-align:center;padding:16px;">No items to show.</p>';

  let title = '';
  let bodyHtml = '';

  if (cardType === 'total_products') {
    title = 'All Products';
    bodyHtml = rowsHtml(products, [
      { label: 'Product Name', cell: p => p.product_name ?? '' },
      { label: 'Product ID', cell: p => p.product_id ?? '' },
      { label: 'Quantity', cell: p => p.quantity ?? 0 }
    ]);
  } else if (cardType === 'total_stock') {
    title = 'Stock by Product';
    const sorted = [...products].sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    bodyHtml = rowsHtml(sorted, [
      { label: 'Product Name', cell: p => p.product_name ?? '' },
      { label: 'Quantity', cell: p => `<span class="stock ${stockClass(Number(p.quantity) || 0)}">${p.quantity ?? 0}</span>` }
    ]);
  } else if (cardType === 'low_stock') {
    title = 'Low Stock Items (≤ 10 units)';
    const lowItems = products.filter(p => (Number(p.quantity) || 0) <= 10);
    bodyHtml = `
      <div id="lowStockCategoryFilter" style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding:10px 12px;background:#f8fafc;border-radius:10px;font-size:13px;">
        ${Object.entries(PRODUCT_TYPE_LABELS).map(([val, label]) => `
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" class="lowStockTypeChk" value="${val}" checked> ${label}
          </label>`).join('')}
      </div>
      <div id="lowStockRowsWrap"></div>`;
  } else if (cardType === 'suppliers') {
    title = 'Suppliers';
    const bySupplier = {};
    products.forEach(p => {
      const s = p.supplier || 'Unknown';
      bySupplier[s] = (bySupplier[s] || 0) + 1;
    });
    const list = Object.keys(bySupplier).sort().map(s => ({ supplier: s, count: bySupplier[s] }));
    bodyHtml = rowsHtml(list, [
      { label: 'Supplier', cell: p => p.supplier },
      { label: 'Products Supplied', cell: p => p.count }
    ]);
  } else if (cardType === 'inventory_value') {
    title = 'Inventory Value by Product';
    const withValue = products.map(p => ({ ...p, __value: (Number(p.price) || 0) * (Number(p.quantity) || 0) }))
      .sort((a, b) => b.__value - a.__value);
    bodyHtml = rowsHtml(withValue, [
      { label: 'Product Name', cell: p => p.product_name ?? '' },
      { label: 'Quantity', cell: p => p.quantity ?? 0 },
      { label: 'Price', cell: p => `₹${p.price ?? 0}` },
      { label: 'Value', cell: p => `₹${p.__value}` }
    ]);
  }

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>${title}</h3>
      <div>
        ${cardType === 'low_stock' ? '<button id="lowStockExportBtn" style="margin-right:10px;padding:8px 14px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;"><i class="fa-solid fa-download"></i> Export</button>' : ''}
        <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
      </div>
    </div>
    ${bodyHtml}`;

  if (cardType === 'low_stock') {
    const lowItems = products.filter(p => (Number(p.quantity) || 0) <= 10);
    const wrap = content.querySelector('#lowStockRowsWrap');
    const cols = [
      { label: 'Product Name', cell: p => p.product_name ?? '' },
      { label: 'Product ID', cell: p => p.product_id ?? '' },
      { label: 'Model No.', cell: p => p.model_no ?? '' },
      { label: 'Type', cell: p => productTypeLabel(p.product_type || 'product') },
      { label: 'Quantity', cell: p => `<span class="stock low">${p.quantity ?? 0}</span>` }
    ];
    const getChecked = () => Array.from(content.querySelectorAll('.lowStockTypeChk:checked')).map(c => c.value);
    const filteredItems = () => {
      const allowed = getChecked();
      return lowItems.filter(p => allowed.includes(p.product_type || 'product'));
    };
    const rerender = () => { wrap.innerHTML = rowsHtml(filteredItems(), cols); };
    rerender();
    content.querySelectorAll('.lowStockTypeChk').forEach(chk => chk.addEventListener('change', rerender));
    content.querySelector('#lowStockExportBtn').addEventListener('click', () => exportLowStockToExcel(filteredItems()));
  }

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
  modal.style.display = 'flex';
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
    btn.style.border = active ? '1px solid #1665ff' : '1px solid #e2e8f0';
    btn.style.background = active ? '#eaf1ff' : '#f8fafc';
    btn.style.color = active ? '#1665ff' : '#334155';
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

function wireHeaderSearch() {
  const input = document.getElementById('headerSearchInput') || document.querySelector('.search input');
  const suggestBox = document.getElementById('headerSearchSuggestions');
  if (!input) return;

  input.addEventListener('input', () => {
    invState.searchQuery = input.value.trim().toLowerCase();
    invPage = 1;
    renderInventoryTable(getFilteredInventory());
    renderSearchSuggestions(input, suggestBox);
  });

  input.addEventListener('focus', () => renderSearchSuggestions(input, suggestBox));

  document.addEventListener('click', e => {
    if (!suggestBox) return;
    if (e.target !== input && !suggestBox.contains(e.target)) suggestBox.style.display = 'none';
  });
}

// Shows up to 8 matching product names/IDs (deduped) from whatever is
// currently loaded in the table, so the person can jump straight to a match
// instead of reading the whole filtered table to find it. Purely a picker —
// selecting one just fills the search box with that exact value, which then
// drives the same getFilteredInventory() the table already uses.
function renderSearchSuggestions(input, suggestBox) {
  if (!suggestBox) return;
  const q = input.value.trim().toLowerCase();
  if (!q) { suggestBox.style.display = 'none'; suggestBox.innerHTML = ''; return; }

  const seen = new Set();
  const matches = [];
  for (const p of invState.products) {
    const name = p.product_name || '';
    const id = p.product_id || '';
    if (!name.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue;
    const key = `${name}||${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ name, id, type: p.product_type || 'product' });
    if (matches.length >= 8) break;
  }

  if (!matches.length) { suggestBox.style.display = 'none'; suggestBox.innerHTML = ''; return; }

  suggestBox.innerHTML = matches.map(m => `
    <div class="search-suggestion-item" data-value="${(m.name || m.id).replace(/"/g, '&quot;')}"
      style="padding:9px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #f1f5f9;">
      <span>${m.name || '(no name)'}</span>
      <span style="color:#94a3b8;">${m.id || ''}</span>
    </div>`).join('');

  suggestBox.querySelectorAll('.search-suggestion-item').forEach(item => {
    item.addEventListener('mouseenter', () => item.style.background = '#f8fafc');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('click', () => {
      input.value = item.dataset.value;
      invState.searchQuery = input.value.trim().toLowerCase();
      invPage = 1;
      renderInventoryTable(getFilteredInventory());
      suggestBox.style.display = 'none';
    });
  });

  suggestBox.style.display = 'block';
}

// Combines whatever category tab / header search / "Apply Filter" criteria
// are currently active on invState and returns the resulting view. Used both
// by the individual filter controls AND by loadInventory(), so that any
// action which re-fetches data (delete, edit save, add, etc.) re-renders the
// SAME filtered view the user was looking at instead of silently snapping
// back to the full unfiltered product list.
function getFilteredInventory() {
  let list = invState.activeCategory
    ? invState.products.filter(p => (p.product_type || 'product') === invState.activeCategory)
    : invState.products;

  const q = invState.searchQuery;
  if (q) {
    // serial-number matching moved out of this quick search — the list no
    // longer carries serial_numbers (that was the bulk of its payload).
    // Use the "Record" search (top-actions) to look up a product by serial.
    list = list.filter(p =>
      (p.product_name || '').toLowerCase().includes(q) ||
      (p.product_id || '').toLowerCase().includes(q) ||
      (p.model_no || '').toLowerCase().includes(q) ||
      (p.supplier || '').toLowerCase().includes(q)
    );
  }

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
  // matches the backend's require_role("service_manager", "admin", "accounts")
  // on /inventory/create and /inventory/update — 'employee' isn't a real role,
  // it was leftover from before roles were split into accounts/service_manager/assembly
  const canManage = role === 'admin' || role === 'accounts' || role === 'service_manager';
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
  const idCell = p => p.product_id ?? '';
  const modelCell = p => p.model_no ?? '';
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

  switch (category) {
    case 'product':
      return [
        { label: 'Product Name', cell: nameCell },
        { label: 'Product ID', cell: idCell },
        { label: 'Model No.', cell: modelCell },
        { label: 'Receiving Date', cell: dateCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Price', cell: priceCell },
        { label: 'Tax', cell: taxCell }
      ];
    case 'spare_parts':
      return [
        { label: 'Product Name', cell: p => p.parent_product_name ?? '—' },
        { label: 'Part Name', cell: nameCell },
        { label: 'Shipment Received Date', cell: dateCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Status', cell: statusBadge }
      ];
    case 'service_parts':
      return [
        { label: 'Product Name', cell: p => p.parent_product_name ?? '—' },
        { label: 'Part Name', cell: nameCell },
        { label: 'Shipment Received Date', cell: dateCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Status', cell: statusBadge },
        { label: 'Type', cell: p => p.part_category ? (p.part_category === 'warranty' ? 'Warranty' : 'Purchase') : '—' }
      ];
    case 'damaged':
      return [
        { label: 'Product Name', cell: nameCell },
        { label: 'Product ID', cell: idCell },
        { label: 'Model No.', cell: modelCell },
        { label: 'Received Date', cell: p => p.damage_date ?? p.purchase_date ?? '' },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Warranty Period', cell: warrantyPeriodCell },
        { label: 'Reason of Damage', cell: p => p.reason_of_damage ?? p.reason ?? '—' },
        { label: 'Status', cell: p => p.damage_status ?? 'Damaged' }
      ];
    default: // no category filter active — table stays exactly as it is today
      return [
        { label: 'Product Name', cell: nameCell },
        { label: 'Product ID', cell: idCell },
        { label: 'Model No.', cell: modelCell },
        { label: 'Type', cell: typeCell },
        { label: 'Supplier', cell: supplierCell },
        { label: 'Purchase Date', cell: dateCell },
        { label: 'Quantity', cell: qtyCell },
        { label: 'Price', cell: priceCell },
        { label: 'Tax', cell: taxCell }
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
    tr.dataset.productId = p.product_id;
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
      product_type: p.product_type || ''
    });
    const res = await apiFetch(`/inventory/detail?${params}`);
    if (!res.ok) return p;
    const data = await res.json();
    return { ...p, ...data.product };
  } catch (err) {
    console.error(err);
    return p;
  }
}

function rowProduct(e) {
  const tr = e.target.closest('tr');
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
async function handleRepairClick(p) {
  if (!p) return;
  const isProduct = Array.isArray(p.serial_numbers) && p.serial_numbers.length > 0;
  const confirmMsg = isProduct
    ? 'Send this product for in-house warranty repair? A service record will be created for it.'
    : 'Mark this part to be sent back to the parent company?';
  if (!confirm(confirmMsg)) return;

  try {
    const qs = p.model_no ? `?model_no=${encodeURIComponent(p.model_no)}` : '';
    const res = await apiFetch(`/inventory/repair/${urlProductId(p.product_id)}${qs}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'repair action failed');
    alert(data.mode === 'product'
      ? `Sent for in-house warranty repair. Service ID: ${data.service_id}`
      : 'Marked to send to parent company.');
    await loadInventory();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
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
  if (exportCategory === 'all') return invState.products;
  return invState.products.filter(p => (p.product_type || 'product') === exportCategory);
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
  menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1300;min-width:220px;';
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#64748b;">Export which category?</div>` +
    EXPORT_CATEGORIES.map(c => `
    <button type="button" class="export-cat-opt" data-cat="${c.value}" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:#1e293b;">
      <i class="fa-solid ${c.icon}" style="width:16px;"></i>&nbsp; ${c.label}
    </button>`).join('');
  document.body.appendChild(menu);

  menu.querySelectorAll('.export-cat-opt').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = '#f1f5f9');
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
  menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:6px;z-index:1300;min-width:240px;';
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `
    <button type="button" class="export-type-opt" data-mode="detailed" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:#1e293b;">
      <i class="fa-solid fa-list" style="width:16px;"></i>&nbsp; Detailed (serial number wise)
    </button>
    <button type="button" class="export-type-opt" data-mode="summary" style="display:block;width:100%;text-align:left;padding:10px 12px;border:none;background:none;cursor:pointer;border-radius:6px;font-size:13px;color:#1e293b;">
      <i class="fa-solid fa-layer-group" style="width:16px;"></i>&nbsp; Summary (product + quantity)
    </button>`;
  document.body.appendChild(menu);

  menu.querySelectorAll('.export-type-opt').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = '#f1f5f9');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', () => {
      menu.remove();
      if (btn.dataset.mode === 'summary') exportInventorySummaryCSV();
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

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCSV(header, rows, filename) {
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
      <form id="exportWizardForm" style="display:flex;flex-direction:column;gap:10px;">
        ${statusOptions ? `
        <label style="font-size:13px;color:#64748b;">Status</label>
        <select name="status" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
          <option value="">All Statuses</option>
          ${statusOptions.map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>` : ''}
        ${dateField ? `
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} From</label>
        <input type="date" name="dateFrom">
        <label style="font-size:13px;color:#64748b;">${dateLabel || 'Date'} To</label>
        <input type="date" name="dateTo">` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
          <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Export</button>
        </div>
      </form>
    </div>`;

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
    const [nameBox, idBox, supplierBox, dateBox] = document.querySelectorAll('.filter-box input');
    const name = nameBox.value.trim().toLowerCase();
    const id = idBox.value.trim().toLowerCase();
    const supplier = supplierBox.value.trim().toLowerCase();
    const date = dateBox.value;

    invState.activeFilters = (name || id || supplier || date) ? { name, id, supplier, date } : null;
    invPage = 1;
    renderInventoryTable(getFilteredInventory());
  });
}

function openViewModal(p) {
  if (!p) return;
  const modal = document.getElementById('viewModal');
  const values = modal.querySelectorAll('.detail p');
  const fields = [p.product_name, p.product_id, productTypeLabel(p.product_type), p.lot_no, p.supplier, p.purchase_date, p.quantity, `₹${p.price}`, `${p.tax_rate}%`];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
  const serialBox = document.getElementById('viewSerialNumbers');
  if (serialBox) serialBox.textContent = (p.serial_numbers || []).length ? p.serial_numbers.join(', ') : 'None on file';

  const hologramRow = document.getElementById('viewHologramRow');
  const hologramStatusEl = document.getElementById('viewHologramStatus');
  const hologramListEl = document.getElementById('viewHologramList');
  if (hologramRow && hologramStatusEl && hologramListEl) {
    if (p.product_type === 'spare_parts' || p.product_type === 'service_parts') {
      const holograms = hologramNumbersOf(p);
      const qty = Number(p.quantity) || 0;
      const status = statusFromHologram(p);
      hologramStatusEl.textContent = `${status} — ${holograms.length} of ${qty} unit(s) have a hologram number on file`;
      hologramListEl.textContent = holograms.length ? holograms.join(', ') : 'None on file';
      hologramRow.style.display = '';
    } else {
      hologramRow.style.display = 'none';
    }
  }

  const warrantyRow = document.getElementById('viewWarrantyRow');
  const warrantyStatus = document.getElementById('viewWarrantyStatus');
  if (warrantyRow && warrantyStatus) {
    if (p.product_type === 'spare_parts' && p.warranty_until) {
      const label = p.warranty_status === 'over warranty' ? 'Over Warranty' : 'Under Warranty';
      warrantyStatus.textContent = `${label} (until ${p.warranty_until})`;
      warrantyRow.style.display = '';
    } else if (p.product_type === 'service_parts' && p.part_category) {
      if (p.warranty_until) {
        const label = p.warranty_status === 'over warranty' ? 'Over Warranty' : 'Under Warranty';
        const prefix = p.part_category === 'warranty' ? 'Warranty' : 'Purchase';
        warrantyStatus.textContent = `${prefix} — ${label} (until ${p.warranty_until})`;
      } else {
        warrantyStatus.textContent = 'Purchase';
      }
      warrantyRow.style.display = '';
    } else {
      warrantyRow.style.display = 'none';
    }
  }
  modal.style.display = 'flex';
}

function openEditModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
  invState.activeModelNo = p.model_no || '';
  invState.activeProductType = p.product_type || 'product';
  invState.editSerials = [...(p.serial_numbers || [])];
  invState.editRemovedSerials = [];
  invState.editFaultySerials = [];

  const modal = document.getElementById('editModal');
  const form = modal.querySelector('form');
  form.elements['product_name'].value = p.product_name ?? '';
  form.elements['product_id'].value = p.product_id ?? '';
  form.elements['model_no'].value = p.model_no ?? '';
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
  }

  wireEditSerialFileUpload();

  modal.style.display = 'flex';
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
    <span data-hologram="${h}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;background:#eef3fb;color:#005ca9;">
      ${h}
      <button type="button" class="hologram-remove-btn" data-hologram="${h}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;">×</button>
    </span>`).join('') || '<span style="font-size:12px;color:#94a3b8;">No hologram numbers on file.</span>';

  list.querySelectorAll('.hologram-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => submitHologramChange({ remove: [btn.dataset.hologram] }));
  });

  let status = 'Pending', color = '#64748b';
  if (count > 0 && qty && count >= qty) { status = 'Active'; color = '#16a34a'; }
  else if (count > 0) { status = 'Partial'; color = '#b45309'; }
  statusMsg.textContent = `${status} — ${count} of ${qty} unit(s) have a hologram number on file${count < qty ? ` (${qty - count} remaining)` : ''}.`;
  statusMsg.style.color = color;
}

// Sends a hologram add/remove to the server immediately (independent of the
// main "Save" button) so the partial/leftover logic can be validated against
// the quantity that's actually on record right now.
async function submitHologramChange({ add = [], remove = [] }) {
  try {
    const res = await apiFetch(`/inventory/update/${urlProductId(invState.activeProductId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updated_values: {},
        new_hologram_numbers: add,
        remove_hologram_numbers: remove,
        model_no: invState.activeModelNo
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
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Hologram update failed', err.message, false);
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
      preview.style.color = '#0369a1';
      submitHologramChange({ add: holograms });
    }, (msg) => { preview.innerHTML = `<span style="color:#b91c1c;">${msg}</span>`; }, { lowercase: false });
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
    }, (msg) => { preview.innerHTML = `<span style="color:#b91c1c;">${msg}</span>`; });
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
    const bg = removed ? '#fee2e2' : (faulty ? '#fff4e5' : '#eef3fb');
    const color = removed ? '#991b1b' : (faulty ? '#b45309' : '#005ca9');
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
  }).join('') || '<span style="font-size:12px;color:#94a3b8;">No serial numbers on file.</span>';

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
    msgBox.style.color = '#64748b';
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
    msgBox.style.color = '#005ca9';
    const existingInputs = newBox.querySelectorAll('input');
    const existingValues = [...existingInputs].map(i => i.value);
    newBox.innerHTML = '';
    for (let i = 0; i < diff; i++) {
      const input = document.createElement('input');
      input.className = 'new-serial-input';
      input.placeholder = `New serial number #${i + 1}`;
      input.value = existingValues[i] || '';
      input.style.cssText = 'padding:8px 10px;border:1px solid #dbe5f1;border-radius:8px;';
      newBox.appendChild(input);
    }
  } else if (diff < 0) {
    msgBox.textContent = `Quantity decreased — mark ${-diff} serial number(s) above as faulty or for removal (click a chip to cycle through: faulty → removal → normal).`;
    msgBox.style.color = '#b45309';
    newBox.innerHTML = '';
  } else {
    msgBox.textContent = 'Quantity matches the serial numbers on file.';
    msgBox.style.color = '#16a34a';
    newBox.innerHTML = '';
  }
}

function openDeleteModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
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
    <p style="color:#64748b;margin-bottom:14px;">What are you adding?</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      ${ADD_TYPES.map(t => `
        <button type="button" class="add-type-btn" data-type="${t.type}" style="padding:16px 10px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
          <i class="fa-solid ${t.icon}"></i><br><strong>${t.label}</strong><br><small style="color:#94a3b8;">${t.hint}</small>
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
  const lbl = t => `<label style="font-size:12px;color:#64748b;margin-bottom:-6px;">${t}</label>`;
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
      <input name="supplier_name" placeholder="Supplier Name (optional)">
      <input name="supplier_address" placeholder="Supplier Address (optional)">
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backPart" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Save</button>
      </div>
    </form>`;
  document.getElementById('backPart').addEventListener('click', renderAddTypeStep);

  document.getElementById('partForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const quantity = Math.max(1, Number(fd.get('quantity')) || 1);
    const category = isService ? (fd.get('part_category') || '') : '';
    const warrantyUntil = fd.get('warranty_until') || '';
    if (category === 'warranty' && !warrantyUntil) { alert('Warranty Until is required for a warranty part.'); return; }
    const holograms = (fd.get('hologram_numbers') || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (new Set(holograms).size !== holograms.length) { alert('Hologram numbers must be unique.'); return; }
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
      supplier: fd.get('supplier_name') || '',
      supplier_address: fd.get('supplier_address') || '',
      purchase_date: fd.get('purchase_date'),
      price: '0',
      tax_rate: 0
    };
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
  });
}

// Step 3: lot no, quantity, serial numbers (auto/manual), supplier + pricing
function renderLotDetailsStep() {
  const body = addModalBody();
  addWizTitle(`Add ${productTypeLabel(addWiz.productType)}`);
  const isFaulty = addWiz.productType === 'damaged';
  const req = isFaulty ? '' : 'required';   // supplier / price details are optional for faulty units
  const lbl = t => `<label style="font-size:12px;color:#64748b;margin-bottom:-6px;">${t}</label>`;
  body.innerHTML = `
    <form id="lotForm" style="display:flex;flex-direction:column;gap:10px;">
      <input type="hidden" name="product_type" id="lotProductType" value="${addWiz.productType}">
      <input name="product_name" placeholder="Product Name" required>
      <input name="product_id" placeholder="Product ID" required>
      <input name="model_no" placeholder="Model No." required>
      <input name="lot_no" placeholder="Lot No." ${req}>
      <input name="quantity" type="number" min="1" placeholder="Quantity" required>
      <input name="first_serial" id="firstSerialInput" placeholder="Serial No. (first unit)">
      <div id="serialOptionalMsg" style="display:none;font-size:12px;color:#64748b;">Serial numbers are optional for this type — leave blank to skip, or add them below.</div>
      <div id="fileSerialBox" style="border:1px dashed #94a3b8;border-radius:8px;padding:8px;">
        <label style="font-size:12px;color:#64748b;">Or add by file — upload an Excel/CSV of serial numbers</label>
        <input type="file" id="serialFileInput" accept=".xlsx,.xls,.csv" style="width:100%;padding:6px 0;font-size:12px;">
        <div id="fileSerialPreview" style="font-size:12px;color:#0369a1;margin-top:4px;"></div>
      </div>
      <div id="serialModeBox" style="display:none;">
        <label style="font-size:13px;color:#64748b;">Remaining serial numbers</label>
        <div style="display:flex;gap:14px;margin:6px 0;font-size:13px;">
          <label><input type="radio" name="serial_mode" value="auto" checked> Auto-generate</label>
          <label><input type="radio" name="serial_mode" value="manual"> Enter manually</label>
        </div>
        <div id="manualSerialsBox" style="display:none;max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
        <div id="autoPreviewBox" style="font-size:12px;color:#64748b;"></div>
      </div>
      <input name="supplier_name" placeholder="Supplier Name${isFaulty ? ' (optional)' : ''}" ${req}>
      <input name="supplier_address" placeholder="Supplier Address${isFaulty ? ' (optional)' : ''}" ${req}>
      ${lbl(isFaulty ? 'Received Date' : 'Receiving Date')}
      <input name="purchase_date" type="date" required>
      <input name="price" placeholder="Price${isFaulty ? ' (optional)' : ''}" ${req}>
      <input name="tax_rate" type="number" placeholder="Tax Rate (%)${isFaulty ? ' (optional)' : ''}" ${req}>
      ${isFaulty ? `${lbl('Warranty Until (optional)')}
      <input name="warranty_until" type="date">
      <textarea name="reason" rows="2" placeholder="Reason of damage" required></textarea>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backAdd3" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Save Product</button>
      </div>
    </form>`;

  document.getElementById('backAdd3').addEventListener('click', renderAddTypeStep);

  const form = document.getElementById('lotForm');
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
        `<button type="button" id="clearFileSerials" style="border:none;background:none;color:#b91c1c;cursor:pointer;font-size:12px;">Clear</button>`;
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
    }, (msg) => { fileSerialPreview.innerHTML = `<span style="color:#b91c1c;">${msg}</span>`; });
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
      inp.style.cssText = 'width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:6px;';
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
        return `<span data-s="${s}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;margin:2px;border-radius:14px;font-size:11px;${removed ? 'background:#fee2e2;color:#b91c1c;text-decoration:line-through;' : 'background:#e0f2fe;color:#0369a1;'}">
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

  form.addEventListener('submit', async e => {
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

    if (serials.length) {
      if (new Set(serials).size !== serials.length) { alert('Serial numbers must be unique.'); return; }

      const existingSerials = new Set(invState.products.flatMap(p => p.serial_numbers || []).map(s => (s || '').toLowerCase()));
      const duplicates = serials.filter(s => existingSerials.has(s));
      if (duplicates.length) { alert(`These serial number(s) already exist in inventory: ${duplicates.join(', ')}`); return; }
    }

    const payload = {
      product_name: fd.get('product_name').trim(),
      product_id: fd.get('product_id').trim(),
      model_no: fd.get('model_no').trim(),
      product_type: fd.get('product_type') || 'product',
      warranty_until: fd.get('warranty_until') || '',
      reason: (fd.get('reason') || '').trim(),
      lot_no: fd.get('lot_no'),
      quantity,
      serial_numbers: serials,
      supplier: fd.get('supplier_name'),
      supplier_address: fd.get('supplier_address'),
      purchase_date: fd.get('purchase_date'),
      price: fd.get('price') || '0',
      tax_rate: Number(fd.get('tax_rate')) || 0
    };

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
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const editForm = document.querySelector('#editModal form');
  if (editForm) editForm.addEventListener('submit', async e => {
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
      if (targetQuantity < keptCount) {
        showResponseModal('Mark more serial numbers', `Quantity is ${targetQuantity} but ${keptCount} serial number(s) are still on file — mark ${keptCount - targetQuantity} more as faulty or for removal.`, false);
        return;
      }
    }

    const updated_values = {
      product_name: form.elements['product_name'].value,
      product_id: form.elements['product_id'].value,
      model_no: form.elements['model_no'].value,
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
      const res = await apiFetch(`/inventory/update/${urlProductId(invState.activeProductId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values, new_serial_numbers, remove_serial_numbers, faulty_serial_numbers, model_no: invState.activeModelNo })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      document.getElementById('editModal').style.display = 'none';
      showResponseModal('Product updated', 'Inventory was updated successfully.', true);
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') showResponseModal('Update failed', err.message, false);
    }
  });

  const deleteBtn = document.querySelector('#deleteModal .delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    try {
      const res = await apiFetch(`/inventory/delete/${urlProductId(invState.activeProductId)}?model_no=${encodeURIComponent(invState.activeModelNo || '')}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'delete failed');
      document.getElementById('deleteModal').style.display = 'none';
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}