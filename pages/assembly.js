// =========================================================
// assembly.js
// Powers pages/assembly.html — cards, table/filtering, and the
// 3-step "Add Assembly" wizard:
//   1) Product details (name, ID, model no., quantity to build)
//   2) Parts used — pulled from inventory's spare_parts stock (only parts
//      that already carry hologram numbers show up here) and/or added
//      locally (never touches inventory). Exactly one inventory part must
//      have quantity == assembly quantity — that's the hologram-bearing part.
//   3) Serial numbers only, auto-generated per unit, editable. Hologram
//      numbers are NOT entered here — the server pulls one per unit from
//      the hologram-bearing part's stock when the assembly is saved.
//
// Edit Assembly (admin + assembly roles only, pending assemblies only):
//   parts can be added / removed / changed while the assembly is in progress;
//   the backend deducts or restocks inventory spare_parts by the difference.
//
// Talks to the real backend: GET/POST /assembly/... and
// GET /assembly/available_parts (see app.py + manage_assembly.py).
// Spare-part stock itself is fed by shipment.js: a shipment part marked
// "assembly" lands in inventory (product_type="spare_parts") as soon as
// that shipment is marked received; hologram numbers are added afterward
// via inventory.js's edit modal (serial-wise, from Excel or by hand).
// =========================================================

let assemblies = [];
let availableParts = [];      // [{part_name, quantity}] — inventory spare_parts stock
let assemblyDraft = null;
let assemblyStep = 1;
let inventoryProducts = [];   // distinct finished products already in inventory (for "Existing product" mode)
let deletingAssemblyId = null;

const ASSEMBLY_MODAL = () => document.querySelector('#assemblyModal .modal-content');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// =========================================================
// SERVER <-> UI SHAPE
// =========================================================

function fromServerShapeAssembly(a) {
  return {
    id: a.assembly_id,
    productName: a.product_name,
    productId: a.product_id,
    modelNumber: a.model_number,
    quantity: a.quantity,
    partsUsed: (a.parts_used || []).map(p => ({ name: p.part_name, quantity: p.quantity, source: p.source, belongsTo: partBelongs(p) })),
    serials: (a.serials || []).map(s => ({ serial: s.serial_number, hologram: s.hologram_number })),
    status: a.status,
    approvedSerials: a.approved_serials || [],
    createdAt: a.created_at,
    hologramPart: a.hologram_part || '',
    hologramPartBelongs: a.hologram_part_belongs_to || '',
    editHistory: a.edit_history || [],
  };
}

function toServerShapeAssembly(a) {
  return {
    product_name: a.productName,
    product_id: a.productId || '',
    model_number: a.modelNumber || '',
    quantity: Number(a.quantity) || 0,
    parts_used: (a.partsUsed || []).map(p => ({
      part_name: p.name, quantity: Number(p.quantity) || 0, source: p.source, belongs_to: p.belongsTo || '',
    })),
    serials: (a.serials || []).map(s => ({ serial_number: s })),
  };
}

// =========================================================
// LOAD + CARDS + TABLE
// =========================================================

async function loadAssemblies() {
  try {
    const res = await apiFetch('/assembly/');
    if (res.ok) {
      const data = await res.json();
      assemblies = (data.dataset || []).map(fromServerShapeAssembly);
    }
  } catch (err) {
    console.warn('assembly: could not load assemblies', err.message);
  }
  renderCards();
  renderTable();
}

async function loadAvailableParts() {
  try {
    const res = await apiFetch('/assembly/available_parts');
    if (res.ok) {
      const data = await res.json();
      availableParts = data.dataset || [];
    }
  } catch (err) {
    console.warn('assembly: could not load available parts', err.message);
  }
  const el = document.getElementById('cardAvailableShipment');
  if (el) el.textContent = availableParts.length;
}

function assemblyCardList(type) {
  const now = new Date();
  if (type === 'month') return assemblies.filter(a => {
    const d = new Date(a.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  if (type === 'today') return assemblies.filter(a => (a.createdAt || '').slice(0, 10) === todayStr());
  if (type === 'pending') return assemblies.filter(a => a.status === 'pending');
  if (type === 'awaiting') return assemblies.filter(a => isApprovalStatus(a.status));
  return [];
}

function renderCards() {
  document.getElementById('cardThisMonth').textContent = assemblyCardList('month').length;
  document.getElementById('cardToday').textContent = assemblyCardList('today').length;
  document.getElementById('cardPending').textContent = assemblyCardList('pending').length;
  document.getElementById('cardAwaiting').textContent = assemblyCardList('awaiting').length;
  document.getElementById('cardAvailableShipment').textContent = availableParts.length;
}

function openAssemblyCardDetailModal(type) {
  const titles = {
    month: 'Assemblies Built This Month',
    today: 'Assemblies Built Today',
    parts: 'Hologram-tagged Parts',
    pending: 'Pending Assemblies',
    awaiting: 'Assemblies Awaiting Approval',
  };
  const th = 'style="text-align:left;padding:8px;"';
  const td = 'style="padding:8px;border-top:1px solid #eef1f6;"';
  let head;
  let rows;
  if (type === 'parts') {
    head = ['Part', 'Belongs To', 'Hologram-tagged in Stock', 'Total Qty'];
    rows = availableParts.map(p => [p.part_name, partBelongs(p) || '—', p.hologram_available ?? 0, p.quantity ?? 0]);
  } else {
    head = ['Product', 'Product ID', 'Model No.', 'Qty', 'Status', 'Created'];
    rows = assemblyCardList(type).map(a => [a.productName, a.productId || '—', a.modelNumber || '—', a.quantity, statusPill(a), (a.createdAt || '').slice(0, 10)]);
  }
  const box = document.querySelector('#assemblyCardDetailModal .modal-content');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>${titles[type]} <span style="color:#94a3b8;font-weight:400;">(${rows.length})</span></h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div style="overflow-x:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead style="background:#f8fafc;"><tr>${head.map(h => `<th ${th}>${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(r => `<tr>${r.map(c => `<td ${td}>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" style="text-align:center;color:#94a3b8;padding:24px;">Nothing to show</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('assemblyCardDetailModal'));
  openModal('assemblyCardDetailModal');
}

function wireAssemblyCardClicks() {
  document.querySelectorAll('[data-card-filter]').forEach(card => {
    card.addEventListener('click', () => openAssemblyCardDetailModal(card.dataset.cardFilter));
  });
}

// product/model a spare part belongs to (backend field name tolerant)
function partBelongs(p) {
  return p.belongs_to || p.belongs_to_product || p.part_belongs_to || p.product_name || p.parent_product || '';
}

// inventory parts are identified by part name + the product they belong to
const PART_SEP = '||';
function partKey(name, belongs) { return (name || '') + PART_SEP + (belongs || ''); }

function sourceLabel(p) {
  return p.source === 'local' ? 'Local parts' : 'Inventory (spare parts)';
}

const APPROVER_ROLES = ['admin', 'accounts'];
function canApproveAssembly() { return APPROVER_ROLES.includes(getRole()); }
function isApprovalStatus(st) { return st === 'pending_approval' || st === 'partially_approved'; }

function statusPill(a) {
  const total = (a.serials || []).length;
  const done = (a.approvedSerials || []).length;
  if (a.status === 'completed') return '<span class="status delivered">Fully Approved</span>';
  if (a.status === 'partially_approved') return `<span class="status pending" style="background:#fff4e0;color:#b45309;">Partially Approved (${done}/${total})</span>`;
  if (a.status === 'pending_approval') return '<span class="status pending" style="background:#e8f0ff;color:#1665ff;">Awaiting Approval</span>';
  return '<span class="status pending">Pending</span>';
}

function renderTable() {
  const tbody = document.getElementById('assemblyTbody');
  const statusFilter = document.getElementById('statusFilter').value;
  const search = (document.getElementById('assemblySearch').value || '').toLowerCase();

  const rows = assemblies.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search) {
      const hay = (a.productName + ' ' + a.productId + ' ' + (a.serials || []).map(s => s.serial).join(' ')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No assemblies yet</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(a => {
    const pill = statusPill(a);
    const usesInventory = (a.partsUsed || []).some(p => p.source !== 'local');
    const usesLocal = (a.partsUsed || []).some(p => p.source === 'local');
    const sourceSummary = usesInventory && usesLocal ? 'Inventory + Local'
      : usesInventory ? 'Inventory (spare parts)'
      : usesLocal ? 'Local parts' : '—';
    return `
      <tr>
        <td>${a.productName}</td>
        <td>${a.productId || '—'}</td>
        <td>${a.modelNumber || '—'}</td>
        <td>${a.quantity}</td>
        <td>${sourceSummary}</td>
        <td>${pill}</td>
        <td>${(a.createdAt || '').slice(0, 10)}</td>
        <td>
          <button class="icon-btn" data-action="view" data-id="${a.id}" title="View"><i class="fa-solid fa-eye"></i></button>
          <button class="icon-btn" data-action="export" data-id="${a.id}" title="Export Serials"><i class="fa-solid fa-file-excel"></i></button>
          ${a.status === 'pending' && canEditAssembly() ? `<button class="icon-btn" data-action="edit" data-id="${a.id}" title="Edit Assembly"><i class="fa-solid fa-pen-to-square"></i></button>` : ''}
          ${a.status === 'pending' ? `<button class="icon-btn" data-action="complete" data-id="${a.id}" title="Submit for Approval"><i class="fa-solid fa-paper-plane"></i></button>` : ''}
          ${isApprovalStatus(a.status) && canApproveAssembly() ? `<button class="icon-btn" data-action="approve" data-id="${a.id}" title="Approve Serials"><i class="fa-solid fa-clipboard-check"></i></button>` : ''}
          <button class="icon-btn" data-action="delete" data-id="${a.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action="view"]').forEach(b => b.addEventListener('click', () => openViewAssemblyModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="export"]').forEach(b => b.addEventListener('click', () => exportAssemblySerials(b.dataset.id)));
  tbody.querySelectorAll('[data-action="edit"]').forEach(b => b.addEventListener('click', () => openEditAssemblyModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="complete"]').forEach(b => b.addEventListener('click', () => markAssemblyCompleted(b.dataset.id)));
  tbody.querySelectorAll('[data-action="approve"]').forEach(b => b.addEventListener('click', () => openApproveAssemblyModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', () => openDeleteAssemblyModal(b.dataset.id)));
}

// =========================================================
// VIEW / COMPLETE / DELETE / EXPORT (saved assemblies)
// =========================================================

function openViewAssemblyModal(id) {
  const a = assemblies.find(x => x.id === id);
  if (!a) return;
  const box = document.querySelector('#viewAssemblyModal .modal-content');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Assembly Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div class="detail"><small>Product</small><p>${a.productName} (${a.productId || '—'})</p></div>
    <div class="detail"><small>Model Number</small><p>${a.modelNumber || '—'}</p></div>
    <div class="detail"><small>Quantity</small><p>${a.quantity}</p></div>
    ${(a.editHistory || []).length ? (() => {
      const last = a.editHistory[a.editHistory.length - 1];
      return `<div class="detail"><small>Last Edited</small><p>${last.edited_by || '—'} on ${(last.edited_at || '').slice(0, 10)} (${a.editHistory.length} edit${a.editHistory.length > 1 ? 's' : ''})</p></div>`;
    })() : ''}
    <hr style="margin:14px 0;border:none;border-top:1px solid #eef1f6;">
    <h4 style="margin-bottom:8px;">Parts Used</h4>
    <ul style="margin:0 0 14px 18px;font-size:13px;color:#475569;">
      ${(a.partsUsed || []).map(p => `<li>${p.name}${p.belongsTo ? ` <span style="color:#1665ff;">[Belongs to: ${p.belongsTo}]</span>` : ''} — qty ${p.quantity} <span style="color:#94a3b8;">(${sourceLabel(p)})</span></li>`).join('') || '<li style="color:#94a3b8;">No parts recorded</li>'}
    </ul>
    <h4 style="margin-bottom:8px;">Serial / Hologram Numbers</h4>
    <div style="max-height:220px;overflow-y:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;">
        <thead><tr><th style="text-align:left;padding:8px;">#</th><th style="text-align:left;padding:8px;">Serial No.</th><th style="text-align:left;padding:8px;">Hologram No.</th>${a.status !== 'pending' ? '<th style="text-align:left;padding:8px;">Approval</th>' : ''}</tr></thead>
        <tbody>
          ${(a.serials || []).map((s, i) => `<tr><td style="padding:6px 8px;">${i + 1}</td><td style="padding:6px 8px;">${s.serial}</td><td style="padding:6px 8px;">${s.hologram}</td>${a.status !== 'pending' ? `<td style="padding:6px 8px;">${(a.approvedSerials || []).includes(s.serial) ? '<span style="color:#16a34a;">✔ Received</span>' : '<span style="color:#d97706;">Not received</span>'}</td>` : ''}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('viewAssemblyModal'));
  openModal('viewAssemblyModal');
}

async function markAssemblyCompleted(id) {
  try {
    const res = await apiFetch(`/assembly/mark_completed/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'could not submit this assembly');
    const a = assemblies.find(x => x.id === id);
    if (a) { a.status = 'pending_approval'; a.approvedSerials = []; }
    renderCards();
    renderTable();
    showResponseModal('Sent for approval', 'Admin / Accounts will verify the serial numbers. Units are added to inventory only after approval.', true);
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Update failed', err.message || 'Could not submit this assembly.', false);
    }
  }
}

function openApproveAssemblyModal(id) {
  const a = assemblies.find(x => x.id === id);
  if (!a) return;
  const done = new Set(a.approvedSerials || []);
  const box = document.querySelector('#viewAssemblyModal .modal-content');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3>Approve — ${a.productName}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="font-size:13px;color:#64748b;margin-bottom:10px;">Tick the serial numbers that have arrived. Only ticked units are added to inventory.</p>
    <div style="max-height:320px;overflow-y:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;">
        <thead><tr>
          <th style="padding:8px;width:40px;"><input type="checkbox" id="apprAll"></th>
          <th style="text-align:left;padding:8px;">Serial No.</th>
          <th style="text-align:left;padding:8px;">Hologram No.</th>
          <th style="text-align:left;padding:8px;">Status</th>
        </tr></thead>
        <tbody>
          ${(a.serials || []).map(s => `<tr>
            <td style="padding:6px 8px;"><input type="checkbox" class="apprChk" value="${s.serial}" ${done.has(s.serial) ? 'checked disabled' : ''}></td>
            <td style="padding:6px 8px;">${s.serial}</td>
            <td style="padding:6px 8px;">${s.hologram}</td>
            <td style="padding:6px 8px;">${done.has(s.serial) ? '<span style="color:#16a34a;">✔ Approved</span>' : '<span style="color:#d97706;">Not received</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
      <span id="apprCount" style="font-size:13px;color:#64748b;"></span>
      <button id="apprSubmit" style="padding:10px 18px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Approve Selected</button>
    </div>`;
  const chks = () => [...box.querySelectorAll('.apprChk:not(:disabled)')];
  const sel = () => chks().filter(c => c.checked).map(c => c.value);
  const upd = () => {
    box.querySelector('#apprCount').textContent = `${sel().length} selected · ${done.size}/${a.serials.length} already approved`;
    box.querySelector('#apprSubmit').disabled = !sel().length;
  };
  box.querySelector('#apprAll').addEventListener('change', e => { chks().forEach(c => c.checked = e.target.checked); upd(); });
  chks().forEach(c => c.addEventListener('change', upd));
  box.querySelector('.close').addEventListener('click', () => closeModal('viewAssemblyModal'));
  box.querySelector('#apprSubmit').addEventListener('click', () => submitApproval(id, sel()));
  upd();
  openModal('viewAssemblyModal');
}

async function submitApproval(id, serials) {
  try {
    const res = await apiFetch(`/assembly/approve/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial_numbers: serials }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'approval failed');
    const a = assemblies.find(x => x.id === id);
    if (a) { a.status = data.status; a.approvedSerials = data.approved_serials || []; }
    closeModal('viewAssemblyModal');
    renderCards();
    renderTable();
    showResponseModal(
      data.status === 'completed' ? 'Fully approved' : 'Partially approved',
      `${data.added_to_inventory} unit(s) added to inventory.` + (data.status === 'completed' ? '' : ' Remaining serials are still awaiting approval.'),
      true
    );
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Approval failed', err.message || 'Could not approve.', false);
    }
  }
}

function openDeleteAssemblyModal(id) {
  deletingAssemblyId = id;
  openModal('deleteAssemblyModal');
}
document.getElementById('deleteAssemblyCancel')?.addEventListener('click', () => closeModal('deleteAssemblyModal'));
document.getElementById('deleteAssemblyConfirm')?.addEventListener('click', async () => {
  try {
    await apiFetch(`/assembly/delete/${deletingAssemblyId}`, { method: 'POST' });
    assemblies = assemblies.filter(a => a.id !== deletingAssemblyId);
    closeModal('deleteAssemblyModal');
    renderCards();
    renderTable();
    showResponseModal('Assembly deleted', 'The assembly record has been removed.', true);
  } catch (err) {
    closeModal('deleteAssemblyModal');
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Delete failed', 'Could not delete this assembly.', false);
    }
  }
});

function exportAssemblySerials(id) {
  const a = assemblies.find(x => x.id === id);
  if (!a) return;
  exportSerialsToExcel(a.serials, a.productName || 'assembly');
}

function exportSerialsToExcel(serials, productName) {
  const rows = serials.map((s, i) => ({ 'Unit #': i + 1, 'Serial Number': s.serial, 'Hologram Number': s.hologram }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Serials');
  const safeName = (productName || 'assembly').replace(/[^a-z0-9]+/gi, '_');
  XLSX.writeFile(wb, `${safeName}_serials.xlsx`);
}

// =========================================================
// MODAL HELPERS
// =========================================================
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// =========================================================
// ADD ASSEMBLY WIZARD
// =========================================================

function stepDots(active) {
  const labels = ['Product', 'Parts Used', 'Serial Numbers'];
  return `
    <div style="display:flex;gap:8px;margin-bottom:20px;">
      ${labels.map((label, i) => `
        <div style="flex:1;text-align:center;">
          <div style="height:6px;border-radius:99px;background:${i + 1 <= active ? '#1665ff' : '#e2e8f0'};margin-bottom:6px;"></div>
          <span style="font-size:11px;color:${i + 1 === active ? '#1665ff' : '#94a3b8'};font-weight:${i + 1 === active ? '600' : '400'};">${label}</span>
        </div>
      `).join('')}
    </div>`;
}

async function loadInventoryProducts() {
  try {
    const res = await apiFetch('/inventory/');
    if (!res.ok) return;
    const data = await res.json();
    const seen = new Set();
    inventoryProducts = (data.dataset || [])
      .filter(p => (p.product_type || 'product') === 'product' && p.product_name && p.product_id)
      .filter(p => {
        const k = `${p.product_id}||${p.model_no || ''}||${p.product_name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(p => ({ name: p.product_name, id: p.product_id, model: p.model_no || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn('assembly: could not load inventory products', err.message);
  }
}

async function openAddAssemblyModal() {
  assemblyDraft = {
    mode: 'existing',   // 'existing' = pick from inventory, 'new' = type details
    productName: '', productId: '', modelNumber: '', quantity: 1,
    partsUsed: [], serials: [],
  };
  assemblyStep = 1;
  await Promise.all([loadAvailableParts(), loadInventoryProducts()]);   // refresh stock right before the wizard opens
  if (!inventoryProducts.length) assemblyDraft.mode = 'new';
  renderAssemblyStep();
  openModal('assemblyModal');
}

function renderAssemblyStep() {
  if (assemblyStep === 1) return renderAStep1();
  if (assemblyStep === 2) return renderAStep2();
  return renderAStep3();
}

// ---------- STEP 1: product details ----------
function renderAStep1() {
  const box = ASSEMBLY_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>Add Assembly</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(1)}
    <form id="aStep1Form" style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:8px;">
        ${['existing', 'new'].map(m => `
          <button type="button" data-mode="${m}" class="a1ModeBtn"
            style="flex:1;padding:9px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;border:1px solid ${assemblyDraft.mode === m ? '#1665ff' : '#e2e8f0'};background:${assemblyDraft.mode === m ? '#eef3fb' : '#fff'};color:${assemblyDraft.mode === m ? '#1665ff' : '#64748b'};">
            ${m === 'existing' ? 'Existing Product' : 'New Product'}
          </button>`).join('')}
      </div>
      ${assemblyDraft.mode === 'existing' ? `
        <select id="a1Existing" required>
          <option value="">Choose product from inventory...</option>
          ${inventoryProducts.map((p, i) => `<option value="${i}" ${p.id === assemblyDraft.productId && p.model === assemblyDraft.modelNumber && p.name === assemblyDraft.productName ? 'selected' : ''}>${escAttr(p.name)} — ${escAttr(p.id)}${p.model ? ' — ' + escAttr(p.model) : ''}</option>`).join('')}
        </select>
        <input id="a1ProductName" placeholder="Product Name" value="${escAttr(assemblyDraft.productName)}" readonly style="background:#f1f5f9;">
        <input id="a1ProductId" placeholder="Product ID" value="${escAttr(assemblyDraft.productId)}" readonly style="background:#f1f5f9;">
        <input id="a1ModelNumber" placeholder="Model Number" value="${escAttr(assemblyDraft.modelNumber)}" readonly style="background:#f1f5f9;">
      ` : `
        <input id="a1ProductName" placeholder="Product Name" value="${escAttr(assemblyDraft.productName)}" required>
        <input id="a1ProductId" placeholder="Product ID" value="${escAttr(assemblyDraft.productId)}">
        <input id="a1ModelNumber" placeholder="Model Number" value="${escAttr(assemblyDraft.modelNumber)}">
      `}
      <label style="font-size:13px;color:#64748b;">Quantity to Assemble</label>
      <input type="number" id="a1Quantity" min="1" value="${assemblyDraft.quantity}" required>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" id="aCancelBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Next: Parts Used</button>
      </div>
    </form>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelector('#aCancelBtn').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelectorAll('.a1ModeBtn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.mode === assemblyDraft.mode) return;
    if (btn.dataset.mode === 'existing' && !inventoryProducts.length) {
      showResponseModal('No products', 'No finished products found in inventory yet — use New Product.', false);
      return;
    }
    assemblyDraft.mode = btn.dataset.mode;
    assemblyDraft.productName = assemblyDraft.productId = assemblyDraft.modelNumber = '';
    assemblyDraft.quantity = Math.max(1, Number(document.getElementById('a1Quantity').value) || 1);
    renderAStep1();
  }));
  const existingSel = box.querySelector('#a1Existing');
  if (existingSel) existingSel.addEventListener('change', () => {
    const p = inventoryProducts[Number(existingSel.value)];
    document.getElementById('a1ProductName').value = p ? p.name : '';
    document.getElementById('a1ProductId').value = p ? p.id : '';
    document.getElementById('a1ModelNumber').value = p ? p.model : '';
  });
  box.querySelector('#aStep1Form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (assemblyDraft.mode === 'existing' && !document.getElementById('a1Existing').value) {
      showResponseModal('Choose a product', 'Select an existing product from inventory.', false);
      return;
    }
    assemblyDraft.productName = document.getElementById('a1ProductName').value.trim();
    assemblyDraft.productId = document.getElementById('a1ProductId').value.trim();
    assemblyDraft.modelNumber = document.getElementById('a1ModelNumber').value.trim();
    assemblyDraft.quantity = Math.max(1, Number(document.getElementById('a1Quantity').value) || 1);
    assemblyStep = 2;
    renderAssemblyStep();
  });
}

// ---------- STEP 2: parts used (from inventory spare_parts + local) ----------
function renderAStep2() {
  const box = ASSEMBLY_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>Add Assembly</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(2)}
    <p style="font-size:13px;color:#64748b;margin-bottom:4px;">Add every part this batch needs. Parts pulled from inventory are deducted from its spare parts stock when you save; local parts are not.</p>
    <p style="font-size:12px;color:#005ca9;background:#eef3fb;border-radius:8px;padding:8px 10px;margin-bottom:10px;">
      <i class="fa-solid fa-circle-info"></i>
      Only hologram-tagged parts show up here. Exactly one inventory part's quantity must equal the assembly quantity
      (${assemblyDraft.quantity}) — that part's hologram numbers get assigned to the finished units.
    </p>
    <div id="partsUsedRows" style="display:flex;flex-direction:column;gap:8px;"></div>
    <div style="display:flex;gap:10px;margin-top:10px;">
      <button type="button" id="addInvPartBtn" ${availableParts.length ? '' : 'disabled'}
        style="flex:1;padding:10px 12px;border:1px dashed #1665ff;border-radius:8px;background:#f0f6ff;cursor:pointer;font-size:13px;color:#1665ff;${availableParts.length ? '' : 'opacity:.5;cursor:not-allowed;'}">
        <i class="fa-solid fa-boxes-stacked"></i> Add Part from Inventory
      </button>
      <button type="button" id="addLocalPartBtn"
        style="flex:1;padding:10px 12px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:13px;color:#334155;">
        <i class="fa-solid fa-plus"></i> Add Local Part
      </button>
    </div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;">
      <button type="button" id="aBackTo1Btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Back</button>
      <button type="button" id="aNextTo3Btn" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Next: Serial / Hologram</button>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelector('#aBackTo1Btn').addEventListener('click', () => { syncPartsUsedFromDom(); assemblyStep = 1; renderAssemblyStep(); });

  renderPartsUsedRows();

  box.querySelector('#addInvPartBtn').addEventListener('click', () => {
    if (!availableParts.length) return;
    syncPartsUsedFromDom();
    const first = availableParts[0];
    // default quantity to the assembly quantity — that's the 1:1 rule for
    // whichever part ends up supplying the hologram numbers; still editable
    assemblyDraft.partsUsed.push({ name: first.part_name, quantity: assemblyDraft.quantity, source: 'inventory', belongsTo: partBelongs(first) });
    renderPartsUsedRows();
  });
  box.querySelector('#addLocalPartBtn').addEventListener('click', () => {
    syncPartsUsedFromDom();
    assemblyDraft.partsUsed.push({ name: '', quantity: '', source: 'local', belongsTo: '' });
    renderPartsUsedRows();
  });

  box.querySelector('#aNextTo3Btn').addEventListener('click', () => {
    syncPartsUsedFromDom();
    const valid = assemblyDraft.partsUsed.filter(p => p.name && p.quantity);
    if (!valid.length) {
      showResponseModal('Add a part', 'Please add at least one part (from inventory or locally) before continuing.', false);
      return;
    }
    const inventoryParts = valid.filter(p => p.source === 'inventory');
    if (!inventoryParts.length) {
      showResponseModal('Add an inventory part', 'Add at least one part from inventory — its hologram numbers supply the hologram number for each assembled unit.', false);
      return;
    }
    // mirror the backend: merge quantities of rows that share the same part
    // name (e.g. the same part split across two rows) before checking, since
    // that's how /assembly/create sums them up server-side
    const summedByName = {};
    inventoryParts.forEach(p => {
      const k = partKey(p.name, p.belongsTo);
      summedByName[k] = (summedByName[k] || 0) + Number(p.quantity || 0);
    });
    // only block when NOT ENOUGH (kam) — no part reaches the assembly
    // quantity. If more than one part qualifies (zyada), that's fine: the
    // backend just picks one and leaves the extra untouched in inventory.
    const hologramCandidates = Object.keys(summedByName).filter(name => summedByName[name] >= Number(assemblyDraft.quantity));
    if (hologramCandidates.length === 0) {
      showResponseModal(
        'Check part quantities',
        `At least one inventory part must have a total quantity at least equal to the assembly quantity (${assemblyDraft.quantity}) — that part supplies the hologram number for each unit.`,
        false
      );
      return;
    }
    assemblyDraft.partsUsed = valid;
    assemblyStep = 3;
    renderAssemblyStep();
  });
}

function renderPartsUsedRows() {
  const wrap = document.getElementById('partsUsedRows');

  wrap.innerHTML = assemblyDraft.partsUsed.map((p, i) => {
    let nameField;
    if (p.source === 'inventory') {
      // a part this assembly already uses may have dropped out of the available
      // list (stock fully consumed) — keep it selectable so edits don't lose it
      const isSel = sp => sp.part_name === p.name && (partBelongs(sp) === (p.belongsTo || '') || !p.belongsTo);
      const missing = p.name && !availableParts.some(isSel)
        ? `<option value="${partKey(p.name, p.belongsTo)}" selected>${p.name}${p.belongsTo ? ' — ' + p.belongsTo : ''} (0 left in stock)</option>` : '';
      nameField = `
        <select class="partUsedName" style="flex:2;">
          ${missing}
          ${availableParts.map(sp => `<option value="${partKey(sp.part_name, partBelongs(sp))}" ${(isSel(sp) && !(p.belongsTo ? false : availableParts.find(isSel) !== sp)) ? 'selected' : ''}>${sp.part_name}${partBelongs(sp) ? ' — ' + partBelongs(sp) : ''} (${sp.hologram_available} hologram-tagged in stock)</option>`).join('')}
        </select>`;
    } else {
      nameField = `<input type="text" class="partUsedName" placeholder="Part Name" value="${p.name}" style="flex:2;">`;
    }

    const belongsField = p.source === 'inventory'
      ? `<span class="partBelongs" style="flex:1.2;font-size:12px;color:#475569;background:#f1f5f9;border-radius:6px;padding:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="Belongs to">${p.belongsTo || '—'}</span>`
      : `<input type="text" class="partUsedBelongs" placeholder="Belongs to" value="${p.belongsTo || ''}" style="flex:1.2;">`;

    return `
      <div style="display:flex;gap:8px;align-items:center;" data-part-row="${i}">
        <span style="font-size:11px;font-weight:600;color:${p.source === 'inventory' ? '#1665ff' : '#64748b'};width:70px;flex-shrink:0;">
          ${p.source === 'inventory' ? 'INVENTORY' : 'LOCAL'}
        </span>
        ${nameField}
        ${belongsField}
        <input type="number" min="0" class="partUsedQty" placeholder="Qty" value="${p.quantity}" style="flex:1;">
        <button type="button" class="removePartUsedBtn" data-index="${i}" style="border:none;background:#fee2e2;color:#dc2626;border-radius:8px;width:36px;height:36px;cursor:pointer;">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
  }).join('') || '<p style="color:#94a3b8;font-size:13px;">No parts added yet — use the buttons below.</p>';

  wrap.querySelectorAll('.removePartUsedBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncPartsUsedFromDom();
      assemblyDraft.partsUsed.splice(Number(btn.dataset.index), 1);
      renderPartsUsedRows();
    });
  });
}

function syncPartsUsedFromDom() {
  const wrap = document.getElementById('partsUsedRows');
  if (!wrap) return;
  wrap.querySelectorAll('[data-part-row]').forEach(row => {
    const i = Number(row.dataset.partRow);
    const nameEl = row.querySelector('.partUsedName');
    const part = assemblyDraft.partsUsed[i];
    if (nameEl.tagName === 'SELECT') {
      // inventory row: option value is "partName||belongsTo"
      const [n, b] = nameEl.value.split(PART_SEP);
      part.name = (n || '').trim();
      part.belongsTo = (b || '').trim();
    } else {
      part.name = nameEl.value.trim();
      const bi = row.querySelector('.partUsedBelongs');
      part.belongsTo = bi ? bi.value.trim() : (part.belongsTo || '');
    }
    part.quantity = row.querySelector('.partUsedQty').value;
  });
}

// ---------- STEP 3: serial + hologram numbers ----------
function generateSerialNumbers(quantity, productId) {
  const datePart = todayStr().replace(/-/g, '');
  const base = (productId || 'PRD').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const serials = [];
  for (let i = 1; i <= quantity; i++) {
    const seq = String(i).padStart(4, '0');
    serials.push(`${base}-${datePart}-${seq}`);
  }
  return serials;
}

// Bumps the trailing number in a seed string by `offset`, keeping the same
// zero-padding width — "ACER-20260820-0001" + 1 -> "ACER-20260820-0002".
// If the seed has no trailing digits, a "-0002" style suffix is appended.
function incrementSeed(seed, offset) {
  const match = seed.match(/^(.*?)(\d+)$/);
  if (!match) {
    return `${seed}-${String(offset + 1).padStart(4, '0')}`;
  }
  const [, prefix, digits] = match;
  const nextNumber = parseInt(digits, 10) + offset;
  return prefix + String(nextNumber).padStart(digits.length, '0');
}

function renderAStep3() {
  // fresh draft: only unit 1 gets a suggested value (still fully editable);
  // the rest stay blank until "Generate Remaining" is used, or the user can
  // just type every one manually. Hologram numbers are NOT entered here —
  // the server assigns one per unit from the hologram-bearing inventory
  // part's stock (see hologramPartName below) when the assembly is saved.
  if (!assemblyDraft.serials.length || assemblyDraft.serials.length !== assemblyDraft.quantity) {
    const suggestion = generateSerialNumbers(1, assemblyDraft.productId)[0];
    assemblyDraft.serials = Array.from({ length: assemblyDraft.quantity }, (_, i) => i === 0 ? suggestion : '');
  }

  const hologramPart = (assemblyDraft.partsUsed || []).find(
    p => p.source === 'inventory' && Number(p.quantity) >= Number(assemblyDraft.quantity)
  );

  const box = ASSEMBLY_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3>Add Assembly</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${stepDots(3)}
    <p style="font-size:13px;color:#64748b;margin-bottom:6px;">
      Enter (or adjust) Unit 1's serial number below, then generate the rest of the batch from it — or fill in / edit every unit by hand.
    </p>
    <p style="font-size:12px;color:#005ca9;background:#eef3fb;border-radius:8px;padding:8px 10px;margin-bottom:10px;">
      <i class="fa-solid fa-circle-info"></i>
      Hologram numbers aren't entered here — each unit will automatically get the next hologram number on file for
      <strong>${hologramPart ? hologramPart.name : 'the inventory part'}</strong> when you save.
    </p>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
      <button type="button" id="genFromUnit1Btn" style="padding:6px 12px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-size:12px;">
        <i class="fa-solid fa-arrow-down-9-1"></i> Generate Remaining From Unit 1
      </button>
      <button type="button" id="regenSerialsBtn" style="padding:6px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;">
        <i class="fa-solid fa-rotate"></i> Auto-generate All
      </button>
    </div>
    <div style="max-height:280px;overflow-y:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead style="position:sticky;top:0;background:#f8fafc;">
          <tr><th style="text-align:left;padding:8px;">#</th><th style="text-align:left;padding:8px;">Serial Number</th></tr>
        </thead>
        <tbody id="serialRows"></tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;">
      <button type="button" id="aBackTo2Btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Back</button>
      <button type="button" id="saveAssemblyBtn" style="padding:10px 16px;border:none;border-radius:8px;background:linear-gradient(135deg,#1665ff,#4c92ff);color:#fff;cursor:pointer;font-weight:600;">
        <i class="fa-solid fa-check"></i> Save Assembly
      </button>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelector('#aBackTo2Btn').addEventListener('click', () => { syncSerialsFromDom(); assemblyStep = 2; renderAssemblyStep(); });

  box.querySelector('#genFromUnit1Btn').addEventListener('click', () => {
    syncSerialsFromDom();
    const seed = assemblyDraft.serials[0];
    if (!seed) {
      showResponseModal('Fill Unit 1 first', 'Enter Unit 1\'s serial number, then generate the rest.', false);
      return;
    }
    for (let i = 1; i < assemblyDraft.serials.length; i++) {
      assemblyDraft.serials[i] = incrementSeed(seed, i);
    }
    renderSerialRows();
  });

  box.querySelector('#regenSerialsBtn').addEventListener('click', () => {
    assemblyDraft.serials = generateSerialNumbers(assemblyDraft.quantity, assemblyDraft.productId);
    renderSerialRows();
  });
  box.querySelector('#saveAssemblyBtn').addEventListener('click', finalizeAssembly);

  renderSerialRows();
}

function renderSerialRows() {
  const tbody = document.getElementById('serialRows');
  tbody.innerHTML = assemblyDraft.serials.map((s, i) => `
    <tr data-serial-row="${i}">
      <td style="padding:6px 8px;">${i + 1}${i === 0 ? ' <span style="color:#94a3b8;font-size:11px;">(seed)</span>' : ''}</td>
      <td style="padding:6px 8px;"><input type="text" class="serialInput" placeholder="Serial Number" value="${s}" style="width:100%;"></td>
    </tr>
  `).join('');
}

function syncSerialsFromDom() {
  const tbody = document.getElementById('serialRows');
  if (!tbody) return;
  tbody.querySelectorAll('[data-serial-row]').forEach(row => {
    const i = Number(row.dataset.serialRow);
    assemblyDraft.serials[i] = row.querySelector('.serialInput').value.trim();
  });
}

// ---------- FINALIZE ----------
async function finalizeAssembly() {
  syncSerialsFromDom();

  if (assemblyDraft.serials.some(s => !s)) {
    showResponseModal('Missing values', 'Every unit needs a serial number.', false);
    return;
  }
  const serialSet = new Set(assemblyDraft.serials);
  if (serialSet.size !== assemblyDraft.serials.length) {
    showResponseModal('Duplicate values', 'Serial numbers must be unique within this batch.', false);
    return;
  }

  try {
    const res = await apiFetch('/assembly/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerShapeAssembly(assemblyDraft)),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'assembly creation failed');

    closeModal('assemblyModal');
    assemblyDraft = null;
    await loadAssemblies();
    await loadAvailableParts();   // inventory spare parts stock changed — refresh
    showResponseModal('Assembly saved', 'The assembly has been created and parts stock updated.', true);
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Save failed', err.message, false);
    }
  }
}

// =========================================================
// EDIT ASSEMBLY — admin + assembly roles only, pending assemblies only
// While an assembly is being built, parts can be added, removed or changed.
// The backend (POST /assembly/edit/{id}) deducts from / restocks inventory
// spare parts by the difference. Unit quantity and serials stay as they are.
// =========================================================
const ASSEMBLY_EDIT_ROLES = ['admin', 'assembly'];
function canEditAssembly() {
  return ASSEMBLY_EDIT_ROLES.includes(getRole());
}

let editingAssemblyId = null;
let editingHologramPart = '';
let editingHologramBelongs = '';

function escAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function openEditAssemblyModal(id) {
  if (!canEditAssembly()) {
    showResponseModal('Not allowed', 'Only admin or assembly users can edit an assembly.', false);
    return;
  }
  const a = assemblies.find(x => x.id === id);
  if (!a) return;
  if (a.status !== 'pending') {
    showResponseModal('Cannot edit', 'Completed assemblies cannot be edited — their units are already in inventory.', false);
    return;
  }

  await loadAvailableParts();   // fresh stock numbers for the dropdowns
  editingAssemblyId = id;

  // which inventory part supplies the hologram numbers (same rule as the backend)
  const sums = {};
  (a.partsUsed || []).filter(p => p.source !== 'local').forEach(p => {
    const k = partKey(p.name, p.belongsTo);
    sums[k] = (sums[k] || 0) + Number(p.quantity || 0);
  });
  editingHologramPart = a.hologramPart
    || (Object.keys(sums).find(k => sums[k] >= Number(a.quantity)) || '').split(PART_SEP)[0]
    || '';
  editingHologramBelongs = a.hologramPartBelongs || '';

  assemblyDraft = {
    productName: a.productName || '', productId: a.productId || '', modelNumber: a.modelNumber || '',
    quantity: a.quantity,
    partsUsed: (a.partsUsed || []).map(p => ({ name: p.name, quantity: p.quantity, belongsTo: p.belongsTo || '', source: p.source === 'local' ? 'local' : 'inventory' })),
    serials: [],
  };
  renderEditAssemblyModal();
  openModal('assemblyModal');
}

function renderEditAssemblyModal() {
  const box = ASSEMBLY_MODAL();
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Edit Assembly</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <input id="eProductName" placeholder="Product Name" value="${escAttr(assemblyDraft.productName)}">
      <input id="eProductId" placeholder="Product ID" value="${escAttr(assemblyDraft.productId)}">
      <input id="eModelNumber" placeholder="Model Number" value="${escAttr(assemblyDraft.modelNumber)}">
      <label style="font-size:13px;color:#64748b;">Quantity to Assemble (cannot be changed)</label>
      <input type="number" value="${assemblyDraft.quantity}" disabled>
    </div>
    <h4 style="margin:18px 0 6px;">Parts Used</h4>
    <p style="font-size:12px;color:#005ca9;background:#eef3fb;border-radius:8px;padding:8px 10px;margin-bottom:10px;">
      <i class="fa-solid fa-circle-info"></i>
      Add, remove or change parts. If an inventory part's quantity goes up, the extra is deducted from inventory;
      if it goes down or the part is removed, the difference is restocked.
      ${editingHologramPart ? `<strong>${escAttr(editingHologramPart)}${editingHologramBelongs ? ' (' + escAttr(editingHologramBelongs) + ')' : ''}</strong> supplies the hologram numbers, so it must stay at ${assemblyDraft.quantity} or more.` : ''}
    </p>
    <div id="partsUsedRows" style="display:flex;flex-direction:column;gap:8px;"></div>
    <div style="display:flex;gap:10px;margin-top:10px;">
      <button type="button" id="eAddInvPartBtn" ${availableParts.length ? '' : 'disabled'}
        style="flex:1;padding:10px 12px;border:1px dashed #1665ff;border-radius:8px;background:#f0f6ff;cursor:pointer;font-size:13px;color:#1665ff;${availableParts.length ? '' : 'opacity:.5;cursor:not-allowed;'}">
        <i class="fa-solid fa-boxes-stacked"></i> Add Part from Inventory
      </button>
      <button type="button" id="eAddLocalPartBtn"
        style="flex:1;padding:10px 12px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:13px;color:#334155;">
        <i class="fa-solid fa-plus"></i> Add Local Part
      </button>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
      <button type="button" id="eCancelBtn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
      <button type="button" id="eSaveBtn" style="padding:10px 16px;border:none;border-radius:8px;background:linear-gradient(135deg,#1665ff,#4c92ff);color:#fff;cursor:pointer;font-weight:600;">
        <i class="fa-solid fa-check"></i> Save Changes
      </button>
    </div>
  `;
  box.querySelector('.close').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelector('#eCancelBtn').addEventListener('click', () => closeModal('assemblyModal'));
  box.querySelector('#eAddInvPartBtn').addEventListener('click', () => {
    if (!availableParts.length) return;
    syncPartsUsedFromDom();
    assemblyDraft.partsUsed.push({ name: availableParts[0].part_name, quantity: 1, source: 'inventory', belongsTo: partBelongs(availableParts[0]) });
    renderPartsUsedRows();
  });
  box.querySelector('#eAddLocalPartBtn').addEventListener('click', () => {
    syncPartsUsedFromDom();
    assemblyDraft.partsUsed.push({ name: '', quantity: '', source: 'local', belongsTo: '' });
    renderPartsUsedRows();
  });
  box.querySelector('#eSaveBtn').addEventListener('click', saveAssemblyEdit);

  renderPartsUsedRows();
}

async function saveAssemblyEdit() {
  syncPartsUsedFromDom();

  const productName = document.getElementById('eProductName').value.trim();
  if (!productName) {
    showResponseModal('Missing value', 'Product name cannot be empty.', false);
    return;
  }

  const parts = assemblyDraft.partsUsed.filter(p => p.name && Number(p.quantity) > 0);
  if (parts.some(p => Number(p.quantity) < 0)) {
    showResponseModal('Invalid quantity', 'Part quantity cannot be negative.', false);
    return;
  }

  // mirror the backend: the hologram part must stay >= assembly quantity
  const holoTotal = parts
    .filter(p => p.source === 'inventory' && p.name === editingHologramPart && (!editingHologramBelongs || (p.belongsTo || '') === editingHologramBelongs))
    .reduce((sum, p) => sum + Number(p.quantity), 0);
  if (editingHologramPart && holoTotal < Number(assemblyDraft.quantity)) {
    showResponseModal(
      'Check part quantities',
      `'${editingHologramPart}' supplies the hologram numbers, so its inventory quantity must stay at least ${assemblyDraft.quantity}.`,
      false
    );
    return;
  }

  try {
    const res = await apiFetch(`/assembly/edit/${editingAssemblyId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_name: productName,
        product_id: document.getElementById('eProductId').value.trim(),
        model_number: document.getElementById('eModelNumber').value.trim(),
        parts_used: parts.map(p => ({ part_name: p.name, quantity: Number(p.quantity), source: p.source })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'assembly edit failed');

    closeModal('assemblyModal');
    assemblyDraft = null;
    editingAssemblyId = null;
    await loadAssemblies();
    await loadAvailableParts();   // inventory stock may have moved — refresh

    const changes = data.inventory_changes || [];
    const summary = changes.length
      ? 'Inventory updated: ' + changes.map(c => `${c.part_name} ${c.action} ${c.quantity}`).join(', ') + '.'
      : 'No inventory change was needed.';
    showResponseModal('Assembly updated', summary, true);
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Update failed', err.message, false);
    }
  }
}

// =========================================================
// INIT
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addAssemblyBtn').addEventListener('click', openAddAssemblyModal);
  document.getElementById('applyAssemblyFilter').addEventListener('click', renderTable);
  document.getElementById('assemblySearch').addEventListener('input', renderTable);
  wireAssemblyCardClicks();
  loadAvailableParts();
  loadAssemblies();
});

// expose for the shared notification bell (common_auth.js) to refresh this page's data
window.refreshCurrentPageData = () => { loadAssemblies(); loadAvailableParts(); };