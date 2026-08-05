const invState = { products: [], activeProductId: null, editSerials: [], editRemovedSerials: [] };
let invPage = 1;
const INV_PAGE_SIZE = 7;

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
  wireModals();
  applyRolePermissions();
});

function applyRolePermissions() {
  const role = getRole();
  const canManage = role === 'admin' || role === 'employee';
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
    renderInventoryTable(invState.products);
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

function renderInventoryTable(products) {
  // API returns products in insertion (ascending) order — reverse so the
  // most recently added product shows at the top instead of the bottom.
  const sorted = [...products].reverse();

  const totalPages = Math.max(1, Math.ceil(sorted.length / INV_PAGE_SIZE));
  invPage = Math.min(Math.max(1, invPage), totalPages);
  const start = (invPage - 1) * INV_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + INV_PAGE_SIZE);

  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  const canManage = window.__invCanManage;
  const canDelete = window.__invCanDelete;

  pageRows.forEach(p => {
    const tr = document.createElement('tr');
    tr.dataset.productId = p.product_id;
    tr.innerHTML = `
      <td><input type="checkbox"></td>
      <td>${p.product_name ?? ''}</td>
      <td>${p.product_id ?? ''}</td>
      <td>${p.lot_no ?? ''}</td>
      <td>${p.supplier ?? ''}</td>
      <td>${p.purchase_date ?? ''}</td>
      <td><span class="stock ${stockClass(Number(p.quantity) || 0)}">${p.quantity ?? 0}</span></td>
      <td>₹${p.price ?? ''}</td>
      <td>${p.tax_rate ?? 0}%</td>
      <td>
        <button class="icon-btn view-btn"><i class="fa-solid fa-eye"></i></button>
        ${canManage ? '<button class="icon-btn edit-btn"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${canDelete ? '<button class="icon-btn delete delete-btn"><i class="fa-solid fa-trash"></i></button>' : ''}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', e => openViewModal(rowProduct(e))));
  tbody.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', e => openEditModal(rowProduct(e))));
  tbody.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', e => openDeleteModal(rowProduct(e))));

  renderTablePagination(document.querySelector('.pagination'), invPage, totalPages, p => {
    invPage = p;
    renderInventoryTable(products);
  });
}

function rowProduct(e) {
  const tr = e.target.closest('tr');
  return invState.products.find(p => p.product_id === tr.dataset.productId);
}

function wireTopActions() {
  document.querySelector('.add-product').addEventListener('click', () => {
    resetAddWizard();
    document.getElementById('addModal').style.display = 'flex';
    renderAddChoiceStep();
  });
  document.querySelector('.export').addEventListener('click', exportInventoryCSV);
}

function exportInventoryCSV() {
  openExportWizard({
    title: 'Export Inventory',
    statusOptions: null,
    dateField: 'purchase_date',
    dateLabel: 'Purchase Date',
    getRows: () => invState.products,
    onConfirm: (rows) => {
      const header = ['Product Name', 'Product ID', 'Lot No', 'Supplier', 'Purchase Date', 'Quantity', 'Price', 'Tax'];
      const csvRows = rows.map(p => [p.product_name, p.product_id, p.lot_no, p.supplier, p.purchase_date, p.quantity, p.price, p.tax_rate]);
      downloadCSV(header, csvRows, 'inventory.csv');
    }
  });
}

// ---------- Generic export filter wizard (status + date range, then CSV of only the matching rows) ----------
function downloadCSV(header, rows, filename) {
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
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

    const filtered = invState.products.filter(p =>
      (!name || (p.product_name || '').toLowerCase().includes(name)) &&
      (!id || (p.product_id || '').toLowerCase().includes(id)) &&
      (!supplier || (p.supplier || '').toLowerCase().includes(supplier)) &&
      (!date || p.purchase_date === date)
    );
    invPage = 1;
    renderInventoryTable(filtered);
  });
}

function openViewModal(p) {
  if (!p) return;
  const modal = document.getElementById('viewModal');
  const values = modal.querySelectorAll('.detail p');
  const fields = [p.product_name, p.product_id, p.lot_no, p.supplier, p.purchase_date, p.quantity, `₹${p.price}`, `${p.tax_rate}%`];
  values.forEach((el, i) => el.textContent = fields[i] ?? '');
  modal.style.display = 'flex';
}

function openEditModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
  invState.editSerials = [...(p.serial_numbers || [])];
  invState.editRemovedSerials = [];

  const modal = document.getElementById('editModal');
  const inputs = modal.querySelectorAll('form input');
  inputs[0].value = p.product_name ?? '';
  inputs[1].value = p.product_id ?? '';
  inputs[2].value = p.lot_no ?? '';
  inputs[3].value = p.supplier ?? '';
  inputs[4].value = p.purchase_date ?? '';
  inputs[5].value = p.quantity ?? '';
  inputs[6].value = p.price ?? '';
  inputs[7].value = p.tax_rate ?? '';

  renderEditSerialsUI();
  inputs[5].removeEventListener('input', renderEditSerialsUI);
  inputs[5].addEventListener('input', renderEditSerialsUI);

  modal.style.display = 'flex';
}

// Keeps the serial-number list in sync with whatever quantity is typed into
// the edit form: shows current serials (removable if quantity is going down),
// and prompts for new serial numbers if quantity is going up.
function renderEditSerialsUI() {
  const modal = document.getElementById('editModal');
  const quantityInput = modal.querySelectorAll('form input')[5];
  const targetQuantity = Number(quantityInput.value) || 0;
  const keptCount = invState.editSerials.length - invState.editRemovedSerials.length;

  const currentList = document.getElementById('currentSerialsList');
  currentList.innerHTML = invState.editSerials.map(s => {
    const removed = invState.editRemovedSerials.includes(s);
    return `<span data-serial="${s}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;
      background:${removed ? '#fee2e2' : '#eef3fb'};color:${removed ? '#991b1b' : '#005ca9'};text-decoration:${removed ? 'line-through' : 'none'};">
      ${s}
      <button type="button" class="serial-toggle-btn" data-serial="${s}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;">
        ${removed ? '↺' : '×'}
      </button>
    </span>`;
  }).join('') || '<span style="font-size:12px;color:#94a3b8;">No serial numbers on file.</span>';

  currentList.querySelectorAll('.serial-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = btn.dataset.serial;
      if (invState.editRemovedSerials.includes(s)) {
        invState.editRemovedSerials = invState.editRemovedSerials.filter(x => x !== s);
      } else {
        invState.editRemovedSerials.push(s);
      }
      renderEditSerialsUI();
    });
  });

  const msgBox = document.getElementById('serialDeltaMsg');
  const newBox = document.getElementById('newSerialsBox');
  const diff = targetQuantity - keptCount;

  if (diff > 0) {
    msgBox.textContent = `Quantity increased — add ${diff} new serial number(s) below.`;
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
    msgBox.textContent = `Quantity decreased — remove ${-diff} serial number(s) above (click × to mark for removal).`;
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
  document.getElementById('deleteModal').style.display = 'flex';
}

// ---------- Add Product wizard ----------
const addWiz = {
  productId: '',
  productName: '',
  modelNo: '',
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

// Step 1: existing product vs new product
function renderAddChoiceStep() {
  const body = addModalBody();
  addWizTitle('Add Product');
  body.innerHTML = `
    <p style="color:#64748b;margin-bottom:14px;">Are you restocking an existing product or adding a new one?</p>
    <div style="display:flex;gap:10px;">
      <button id="btnAddExisting" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-boxes-stacked"></i><br>Add Existing Product
      </button>
      <button id="btnAddNew" style="flex:1;padding:16px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;">
        <i class="fa-solid fa-plus"></i><br>New Product
      </button>
    </div>`;
  document.getElementById('btnAddExisting').addEventListener('click', renderExistingProductStep);
  document.getElementById('btnAddNew').addEventListener('click', renderNewProductStep);
}

// Step 2a: pick an existing product (deduped by product_id)
function renderExistingProductStep() {
  const body = addModalBody();
  addWizTitle('Select Product');

  const seen = new Set();
  const distinctProducts = [];
  invState.products.forEach(p => {
    if (!seen.has(p.product_id)) { seen.add(p.product_id); distinctProducts.push(p); }
  });

  body.innerHTML = `
    <input id="productFilter" placeholder="Search product name or ID..." style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;">
    <div id="productList" style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="margin-top:14px;">
      <button type="button" id="backAdd1" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
    </div>`;
  document.getElementById('backAdd1').addEventListener('click', renderAddChoiceStep);

  const listBox = document.getElementById('productList');
  const renderList = (list) => {
    if (!list.length) { listBox.innerHTML = '<small style="color:#94a3b8;">No products found.</small>'; return; }
    listBox.innerHTML = list.map(p => `
      <div class="prod-row" data-id="${p.product_id}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
        <strong>${p.product_name ?? ''}</strong><br>
        <small style="color:#64748b;">${p.product_id} ${p.model_no ? '• Model ' + p.model_no : ''}</small>
      </div>`).join('');
    listBox.querySelectorAll('.prod-row').forEach(row => row.addEventListener('click', () => {
      const p = list.find(x => x.product_id === row.dataset.id);
      addWiz.productId = p.product_id;
      addWiz.productName = p.product_name;
      addWiz.modelNo = p.model_no || '';
      renderLotDetailsStep();
    }));
  };
  renderList(distinctProducts);

  document.getElementById('productFilter').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    renderList(distinctProducts.filter(p => (p.product_name || '').toLowerCase().includes(term) || (p.product_id || '').toLowerCase().includes(term)));
  });
}

// Step 2b: new product basic info
function renderNewProductStep() {
  const body = addModalBody();
  addWizTitle('New Product');
  body.innerHTML = `
    <form id="newProductForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="product_name" placeholder="Product Name" required>
      <input name="product_id" placeholder="Product ID" required>
      <input name="model_no" placeholder="Model No." required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backAdd2" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;">Next</button>
      </div>
    </form>`;
  document.getElementById('backAdd2').addEventListener('click', renderAddChoiceStep);
  document.getElementById('newProductForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    addWiz.productId = fd.get('product_id').trim();
    addWiz.productName = fd.get('product_name').trim();
    addWiz.modelNo = fd.get('model_no').trim();
    renderLotDetailsStep();
  });
}

// Step 3: lot no, quantity, serial numbers (auto/manual), supplier + pricing
function renderLotDetailsStep() {
  const body = addModalBody();
  addWizTitle(`${addWiz.productName} — Lot Details`);
  body.innerHTML = `
    <form id="lotForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="lot_no" placeholder="Lot No." required>
      <input name="quantity" type="number" min="1" placeholder="Quantity" required>
      <input name="first_serial" placeholder="Serial No. (first unit)" required>
      <div id="serialModeBox" style="display:none;">
        <label style="font-size:13px;color:#64748b;">Remaining serial numbers</label>
        <div style="display:flex;gap:14px;margin:6px 0;font-size:13px;">
          <label><input type="radio" name="serial_mode" value="auto" checked> Auto-generate</label>
          <label><input type="radio" name="serial_mode" value="manual"> Enter manually</label>
        </div>
        <div id="manualSerialsBox" style="display:none;max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
        <div id="autoPreviewBox" style="font-size:12px;color:#64748b;"></div>
      </div>
      <input name="supplier_name" placeholder="Supplier Name" required>
      <input name="supplier_address" placeholder="Supplier Address" required>
      <input name="purchase_date" type="date" required>
      <input name="price" placeholder="Price" required>
      <input name="tax_rate" type="number" placeholder="Tax Rate (%)" required>
      <div style="display:flex;justify-content:space-between;margin-top:10px;">
        <button type="button" id="backAdd3" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">Back</button>
        <button type="submit" style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;">Save Product</button>
      </div>
    </form>`;

  document.getElementById('backAdd3').addEventListener('click', () => addWiz.productId && invState.products.some(p => p.product_id === addWiz.productId) ? renderExistingProductStep() : renderNewProductStep());

  const form = document.getElementById('lotForm');
  const qtyInput = form.querySelector('[name="quantity"]');
  const firstSerialInput = form.querySelector('[name="first_serial"]');
  const serialModeBox = document.getElementById('serialModeBox');
  const manualBox = document.getElementById('manualSerialsBox');
  const autoPreviewBox = document.getElementById('autoPreviewBox');

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

  function refreshSerialUI() {
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
      const preview = generateAutoSerials(firstSerial, quantity);
      autoPreviewBox.style.display = 'block';
      autoPreviewBox.textContent = `Will generate: ${preview.join(', ')}`;
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
    const quantity = Math.max(1, Number(fd.get('quantity')) || 1);
    const firstSerial = fd.get('first_serial').trim();

    let serials = [firstSerial];
    if (quantity > 1) {
      const mode = form.querySelector('[name="serial_mode"]:checked').value;
      if (mode === 'auto') {
        serials = generateAutoSerials(firstSerial, quantity);
      } else {
        const manualInputs = [...manualBox.querySelectorAll('.manualSerialInput')].map(i => i.value.trim());
        if (manualInputs.some(v => !v)) { alert('Please fill in all serial numbers.'); return; }
        serials = [firstSerial, ...manualInputs];
      }
    }
    if (new Set(serials).size !== serials.length) { alert('Serial numbers must be unique.'); return; }

    const payload = {
      product_name: addWiz.productName,
      product_id: addWiz.productId,
      model_no: addWiz.modelNo,
      lot_no: fd.get('lot_no'),
      quantity,
      serial_numbers: serials,
      supplier: fd.get('supplier_name'),
      supplier_address: fd.get('supplier_address'),
      purchase_date: fd.get('purchase_date'),
      price: fd.get('price'),
      tax_rate: Number(fd.get('tax_rate'))
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
    const inputs = e.target.querySelectorAll('input');
    const targetQuantity = Number(inputs[5].value);

    const new_serial_numbers = [...e.target.querySelectorAll('.new-serial-input')].map(i => i.value.trim());
    const remove_serial_numbers = [...invState.editRemovedSerials];
    const keptCount = invState.editSerials.length - remove_serial_numbers.length;

    if (targetQuantity > keptCount) {
      if (new_serial_numbers.some(v => !v)) {
        showResponseModal('Missing serial numbers', 'Please fill in every new serial number field before saving.', false);
        return;
      }
    }
    if (targetQuantity < keptCount) {
      showResponseModal('Remove more serial numbers', `Quantity is ${targetQuantity} but ${keptCount} serial number(s) are still on file — mark ${keptCount - targetQuantity} more for removal.`, false);
      return;
    }

    const updated_values = {
      product_name: inputs[0].value,
      lot_no: inputs[2].value,
      supplier: inputs[3].value,
      purchase_date: inputs[4].value,
      quantity: targetQuantity,
      price: inputs[6].value,
      tax_rate: Number(inputs[7].value)
    };
    try {
      const res = await apiFetch(`/inventory/update/${invState.activeProductId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values, new_serial_numbers, remove_serial_numbers })
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
      const res = await apiFetch(`/inventory/delete/${invState.activeProductId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'delete failed');
      document.getElementById('deleteModal').style.display = 'none';
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}