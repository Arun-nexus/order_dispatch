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
    partsUsed: (a.parts_used || []).map(p => ({ name: p.part_name, quantity: p.quantity, source: p.source })),
    serials: (a.serials || []).map(s => ({ serial: s.serial_number, hologram: s.hologram_number })),
    status: a.status,
    createdAt: a.created_at,
  };
}

function toServerShapeAssembly(a) {
  return {
    product_name: a.productName,
    product_id: a.productId || '',
    model_number: a.modelNumber || '',
    quantity: Number(a.quantity) || 0,
    parts_used: (a.partsUsed || []).map(p => ({
      part_name: p.name, quantity: Number(p.quantity) || 0, source: p.source,
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

function renderCards() {
  const now = new Date();
  const thisMonth = assemblies.filter(a => {
    const d = new Date(a.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const today = assemblies.filter(a => (a.createdAt || '').slice(0, 10) === todayStr()).length;
  const pending = assemblies.filter(a => a.status === 'pending').length;

  document.getElementById('cardThisMonth').textContent = thisMonth;
  document.getElementById('cardToday').textContent = today;
  document.getElementById('cardPending').textContent = pending;
  document.getElementById('cardAvailableShipment').textContent = availableParts.length;
}

function sourceLabel(p) {
  return p.source === 'local' ? 'Local parts' : 'Inventory (spare parts)';
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
    const pill = a.status === 'completed'
      ? '<span class="status delivered">Completed</span>'
      : '<span class="status pending">Pending</span>';
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
          ${a.status === 'pending' ? `<button class="icon-btn" data-action="complete" data-id="${a.id}" title="Mark Completed"><i class="fa-solid fa-check"></i></button>` : ''}
          <button class="icon-btn" data-action="delete" data-id="${a.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action="view"]').forEach(b => b.addEventListener('click', () => openViewAssemblyModal(b.dataset.id)));
  tbody.querySelectorAll('[data-action="export"]').forEach(b => b.addEventListener('click', () => exportAssemblySerials(b.dataset.id)));
  tbody.querySelectorAll('[data-action="complete"]').forEach(b => b.addEventListener('click', () => markAssemblyCompleted(b.dataset.id)));
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
    <hr style="margin:14px 0;border:none;border-top:1px solid #eef1f6;">
    <h4 style="margin-bottom:8px;">Parts Used</h4>
    <ul style="margin:0 0 14px 18px;font-size:13px;color:#475569;">
      ${(a.partsUsed || []).map(p => `<li>${p.name} — qty ${p.quantity} <span style="color:#94a3b8;">(${sourceLabel(p)})</span></li>`).join('') || '<li style="color:#94a3b8;">No parts recorded</li>'}
    </ul>
    <h4 style="margin-bottom:8px;">Serial / Hologram Numbers</h4>
    <div style="max-height:220px;overflow-y:auto;border:1px solid #eef1f6;border-radius:10px;">
      <table style="width:100%;font-size:13px;">
        <thead><tr><th style="text-align:left;padding:8px;">#</th><th style="text-align:left;padding:8px;">Serial No.</th><th style="text-align:left;padding:8px;">Hologram No.</th></tr></thead>
        <tbody>
          ${(a.serials || []).map((s, i) => `<tr><td style="padding:6px 8px;">${i + 1}</td><td style="padding:6px 8px;">${s.serial}</td><td style="padding:6px 8px;">${s.hologram}</td></tr>`).join('')}
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
    if (!res.ok) throw new Error(data.detail || 'could not mark this assembly as completed');

    const a = assemblies.find(x => x.id === id);
    if (a) a.status = 'completed';
    renderCards();
    renderTable();

    const inventoryNote = data.inventory_sync === 'merged'
      ? 'Assembled units were merged into the existing inventory entry.'
      : data.inventory_sync === 'created'
        ? 'A new inventory entry was created for these units.'
        : 'Assembly completed, but inventory sync needs a manual check.';
    showResponseModal('Assembly completed', inventoryNote, data.inventory_sync !== undefined && !String(data.inventory_sync).startsWith('failed'));
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') {
      showResponseModal('Update failed', 'Could not mark this assembly as completed.', false);
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

async function openAddAssemblyModal() {
  assemblyDraft = {
    productName: '', productId: '', modelNumber: '', quantity: 1,
    partsUsed: [], serials: [],
  };
  assemblyStep = 1;
  await loadAvailableParts();   // refresh stock right before the wizard opens
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
      <input id="a1ProductName" placeholder="Product Name" value="${assemblyDraft.productName}" required>
      <input id="a1ProductId" placeholder="Product ID" value="${assemblyDraft.productId}">
      <input id="a1ModelNumber" placeholder="Model Number" value="${assemblyDraft.modelNumber}">
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
  box.querySelector('#aStep1Form').addEventListener('submit', (e) => {
    e.preventDefault();
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
    const first = availableParts[0];
    // default quantity to the assembly quantity — that's the 1:1 rule for
    // whichever part ends up supplying the hologram numbers; still editable
    assemblyDraft.partsUsed.push({ name: first.part_name, quantity: assemblyDraft.quantity, source: 'inventory' });
    renderPartsUsedRows();
  });
  box.querySelector('#addLocalPartBtn').addEventListener('click', () => {
    assemblyDraft.partsUsed.push({ name: '', quantity: '', source: 'local' });
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
    const matching = inventoryParts.filter(p => Number(p.quantity) === Number(assemblyDraft.quantity));
    if (matching.length !== 1) {
      showResponseModal(
        'Check part quantities',
        `Exactly one inventory part must have quantity equal to the assembly quantity (${assemblyDraft.quantity}) — that part supplies the hologram number for each unit.`,
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
      nameField = `
        <select class="partUsedName" style="flex:2;">
          ${availableParts.map(sp => `<option value="${sp.part_name}" ${sp.part_name === p.name ? 'selected' : ''}>${sp.part_name} (${sp.hologram_available} hologram-tagged in stock)</option>`).join('')}
        </select>`;
    } else {
      nameField = `<input type="text" class="partUsedName" placeholder="Part Name" value="${p.name}" style="flex:2;">`;
    }

    return `
      <div style="display:flex;gap:8px;align-items:center;" data-part-row="${i}">
        <span style="font-size:11px;font-weight:600;color:${p.source === 'inventory' ? '#1665ff' : '#64748b'};width:70px;flex-shrink:0;">
          ${p.source === 'inventory' ? 'INVENTORY' : 'LOCAL'}
        </span>
        ${nameField}
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
    assemblyDraft.partsUsed[i].name = row.querySelector('.partUsedName').value.trim();
    assemblyDraft.partsUsed[i].quantity = row.querySelector('.partUsedQty').value;
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
    p => p.source === 'inventory' && Number(p.quantity) === Number(assemblyDraft.quantity)
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
// INIT
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addAssemblyBtn').addEventListener('click', openAddAssemblyModal);
  document.getElementById('applyAssemblyFilter').addEventListener('click', renderTable);
  document.getElementById('assemblySearch').addEventListener('input', renderTable);
  loadAvailableParts();
  loadAssemblies();
});

// expose for the shared notification bell (common_auth.js) to refresh this page's data
window.refreshCurrentPageData = () => { loadAssemblies(); loadAvailableParts(); };