const invState = { products: [], activeProductId: null };

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
    invState.products = data.dataset || [];
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
  const tbody = document.querySelector('.table-container tbody');
  tbody.innerHTML = '';

  const canManage = window.__invCanManage;
  const canDelete = window.__invCanDelete;

  products.forEach(p => {
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
}

function rowProduct(e) {
  const tr = e.target.closest('tr');
  return invState.products.find(p => p.product_id === tr.dataset.productId);
}

function wireTopActions() {
  document.querySelector('.add-product').addEventListener('click', () => {
    document.querySelector('#addModal form').reset();
    document.getElementById('addModal').style.display = 'flex';
  });
  document.querySelector('.export').addEventListener('click', exportInventoryCSV);
}

function exportInventoryCSV() {
  const header = ['Product Name', 'Product ID', 'Lot No', 'Supplier', 'Purchase Date', 'Quantity', 'Price', 'Tax'];
  const rows = invState.products.map(p => [p.product_name, p.product_id, p.lot_no, p.supplier, p.purchase_date, p.quantity, p.price, p.tax_rate]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'inventory.csv';
  a.click();
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
  modal.style.display = 'flex';
}

function openDeleteModal(p) {
  if (!p) return;
  invState.activeProductId = p.product_id;
  document.getElementById('deleteModal').style.display = 'flex';
}

function wireModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));

  const addForm = document.querySelector('#addModal form');
  if (addForm) addForm.addEventListener('submit', async e => {
    e.preventDefault();
    const inputs = e.target.querySelectorAll('input');
    const payload = {
      product_name: inputs[0].value,
      product_id: inputs[1].value,
      lot_no: inputs[2].value,
      supplier: inputs[3].value,
      purchase_date: inputs[4].value,
      quantity: Number(inputs[5].value),
      price: inputs[6].value,
      tax_rate: Number(inputs[7].value)
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
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });

  const editForm = document.querySelector('#editModal form');
  if (editForm) editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const inputs = e.target.querySelectorAll('input');
    const updated_values = {
      product_name: inputs[0].value,
      lot_no: inputs[2].value,
      supplier: inputs[3].value,
      purchase_date: inputs[4].value,
      quantity: Number(inputs[5].value),
      price: inputs[6].value,
      tax_rate: Number(inputs[7].value)
    };
    try {
      const res = await apiFetch(`/inventory/update/${invState.activeProductId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated_values })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'update failed');
      document.getElementById('editModal').style.display = 'none';
      await loadInventory();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
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