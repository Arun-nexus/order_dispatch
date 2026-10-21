const techState = { services: [], demoUnits: [], parts: [], installs: [], technicians: [], requests: [] };
let techView = 'services';
let techStatus = 'all';
let techSearch = '';
let techPage = 1;
let techDeepLinkDone = false;
const TECH_PAGE_SIZE = 20;

function techEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  if (['services', 'installs', 'demo', 'parts', 'requests'].includes(tab)) techView = tab;
  if (tab === 'installations' || params.get('installation')) techView = 'installs';
  if (params.get('service')) techView = 'services';
  document.querySelectorAll('#catCards .cat-card').forEach(c => c.addEventListener('click', () => setTechView(c.dataset.view)));
  const si = document.querySelector('.search input');
  if (si) si.addEventListener('input', () => { techSearch = si.value.trim().toLowerCase(); techPage = 1; renderMain(); });
  loadMyServices();
  loadMyRequests();
  wireStaticModals();
  loadAllocations();
  loadInstallations();
  renderAll();
});

window.refreshCurrentPageData = () => { loadMyServices(); loadMyRequests(); loadAllocations(); loadInstallations(); };

async function loadMyRequests() {
  try {
    const res = await apiFetch('/request/mine');
    if (!res.ok) throw new Error('failed to fetch requests');
    const data = await res.json();
    techState.requests = (data.dataset || []).filter(r => ['spare_part', 'status_update', 'service', 'reschedule'].includes(r.request_type))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    renderAll();
  } catch (err) {
    console.error(err);
  }
}

function requestStatusClass(status) {
  if (status === 'approved') return 'delivered';
  if (status === 'rejected') return 'cancelled';
  return 'pending';
}


// ======================================================================
// Services list
// ======================================================================
async function loadMyServices() {
  try {
    const svcRes = await apiFetch('/service/my');
    const svcData = await svcRes.json();
    if (!svcRes.ok) throw new Error('failed to fetch services');

    techState.services = (svcData.dataset || []).slice().reverse();
    techPage = 1;
    renderAll();

    if (!techDeepLinkDone) {
      techDeepLinkDone = true;
      const id = new URLSearchParams(location.search).get('service');
      if (id) {
        history.replaceState(null, '', location.pathname);   // a refresh should not re-open it
        const s = techState.services.find(x => x.service_id === id);
        if (s) openViewModal(s);
      }
    }
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your services.');
  }
}


// ---- approval rules -------------------------------------------------------
// A technician never edits dates / assignment directly. Everything goes through the
// service manager (Service page): either the technician raises a request and it is
// approved there (the installation is then assigned to whoever raised it), or the
// manager assigns it to a technician directly.
const ME = () => (typeof getUsername === 'function' ? (getUsername() || '') : '');
const instAwaiting = i => !i.technician_id;                                  // my request, not approved yet
const instStatusKey = i => (instAwaiting(i) ? 'pending' : i.status);
function instLabel(i) {
  if (instAwaiting(i)) return 'Awaiting approval';
  if (i.status === 'requested') return 'Assigned · not scheduled';
  return INSTALL_LABEL[i.status] || i.status;
}
// my installation requests, shown next to the other requests
function installRequestRows() {
  return techState.installs.filter(i => i.requested_by && i.requested_by === ME()).map(i => ({
    request_id: 'inst:' + i.installation_id, request_type: 'installation',
    status: i.technician_id ? 'approved' : 'pending', created_at: i.created_at || i.requested_on || null,
    details: { label: `${i.product_name || ''} · ${i.company_name || ''}` }
  }));
}
function allMyRequests() {
  return techState.requests.concat(installRequestRows())
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function productLabel(s) {
  return s.product_name || s.product_id || '-';
}

function modelLabel(s) {
  return s.model_no || '-';
}

function fmtWhen(v) {
  if (!v) return '-';
  const d = new Date(v);
  return isNaN(d) ? techEsc(v) : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function toLocalInput(v) {
  const d = v ? new Date(v) : new Date(Date.now() + 86400000);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// the wizard step the technician has to do next
function nextStepOf(s) {
  return { assigned: 1, spare_decision: 2, report: 3 }[s.workflow_step || 'assigned'] || 1;
}

function statusLabel(s) {
  if (s.status === 'active') return 'New';
  if (s.status === 'in_progress') return s.report_rejected_reason ? 'Sent back' : `In progress · step ${nextStepOf(s)}/3`;
  if (s.status === 'pending_approval') return 'Awaiting approval';
  return (s.status || '').replace('_', ' ');
}


function statusBadgeClass(status) {
  if (status === 'completed') return 'high';
  if (status === 'in_progress' || status === 'pending_approval') return 'medium';
  if (status === 'rejected') return 'low';
  return 'medium';
}

const BTN_GREEN = 'border:none;border-radius:8px;background:#16a34a;color:#fff;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:600;';
const BTN_BLUE = 'border:none;border-radius:8px;background:#1665ff;color:#fff;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:600;';
const BTN_GREY = 'border:none;border-radius:8px;background:#e2e8f0;color:#0f172a;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:600;';


function primaryActionHtml(s) {
  if (s.status === 'active') return `<button type="button" data-act="wiz" style="${BTN_GREEN}"><i class="fa-solid fa-play"></i> Start</button>`;
  if (s.status === 'in_progress') {
    const label = s.report_rejected_reason ? 'Fix & resubmit' : `Continue · step ${nextStepOf(s)}`;
    return `<button type="button" data-act="wiz" style="${BTN_BLUE}"><i class="fa-solid fa-forward"></i> ${label}</button>`;
  }
  if (s.status === 'pending_approval') return '<span style="font-size:12px;color:#64748b;">Waiting for manager</span>';
  return '';
}




// ======================================================================
// Shared helpers
// ======================================================================
async function postJson(url, body) {
  const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Please fill in all the required fields.');
  return data;
}

async function fetchMedia(serviceId) {
  const res = await apiFetch(`/service/media/${encodeURIComponent(serviceId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'could not load the images');
  return data;
}

async function pickImage(file) {
  if (!file) return '';
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  if (file.size > 2 * 1024 * 1024) throw new Error(`Image is ${(file.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`);
  return readFileAsBase64(file);
}

// ======================================================================
// View modal
// ======================================================================
function openViewModal(s) {
  if (!s) return;
  const modal = document.getElementById('viewModal');
  const content = modal.querySelector('.modal-content');
  const parts = s.faulty_parts || [];
  const row = (label, value) => `<div class="detail"><small>${label}</small><p>${value}</p></div>`;
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Service Details</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    ${s.report_rejected_reason ? `<div style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:10px;"><b>Sent back by service manager:</b> ${techEsc(s.report_rejected_reason)}</div>` : ''}
    ${row('Status', techEsc(statusLabel(s)))}
    ${row('Service ID', techEsc(s.service_id))}
    ${row('Company', techEsc(s.company_name || '-'))}
    ${row('Product', techEsc(productLabel(s)))}
    ${row('Model No.', techEsc(modelLabel(s)))}
    ${row('Scheduled For', fmtWhen(s.scheduled_date))}
    ${(s.schedule_history || []).length ? row('Reschedule History', '<ul style="padding-left:18px;font-size:13px;">' + s.schedule_history.slice().reverse().map(h => `<li>${fmtWhen(h.from)} &rarr; <b>${fmtWhen(h.to)}</b> by ${techEsc(h.by)}${h.reason ? ' - ' + techEsc(h.reason) : ''}</li>`).join('') + '</ul>') : ''}
    ${row('Serial No. (on ticket)', techEsc(s.serial_no || '-'))}
    ${s.tech_serial_no ? row('Serial No. (entered by you)', techEsc(s.tech_serial_no) + (s.serial_mismatch ? ' <span style="color:#d97706;">— differs from the ticket</span>' : '')) : ''}
    ${row('Purchase Date', techEsc(s.purchase_date || '-'))}
    ${row('Issue', techEsc(s.issue || '-'))}
    ${row('Location', techEsc((s.location || 'indoor') === 'outdoor' ? 'Field' : 'Inhouse'))}
    ${s.address ? row('Address', techEsc(s.address)) : ''}
    ${s.spare_needed === true ? row('Faulty spare part(s)', parts.map(p => `${techEsc(p.part_name)} — hologram ${techEsc(p.old_hologram_number)}${p.new_hologram_number ? ' → ' + techEsc(p.new_hologram_number) : ''}`).join('<br>')) : ''}
    ${s.spare_needed === false ? row('Spare part', 'Not needed') : ''}
    ${s.work_done ? row('Service report', techEsc(s.work_done)) : ''}
    ${row('Service Charges', s.service_charges != null ? '₹' + s.service_charges : 'Set by the service manager on approval')}
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
      ${s.has_damage_image || s.image ? '<button type="button" id="viewDamageBtn" style="' + BTN_GREY + '">Damaged product photo</button>' : ''}
      ${s.has_final_image ? '<button type="button" id="viewFinalBtn" style="' + BTN_GREY + '">Photo after repair</button>' : ''}
      ${parts.some(p => p.has_image) ? '<button type="button" id="viewPartBtn" style="' + BTN_GREY + '">Faulty part photo(s)</button>' : ''}
      ${canReschedule(s) ? '<button type="button" id="viewReschedBtn" style="' + BTN_GREY + '"><i class="fa-solid fa-calendar-days"></i> Reschedule</button>' : ''}
      ${s.status === 'active' ? '<button type="button" id="viewStartBtn" style="' + BTN_GREEN + '"><i class="fa-solid fa-play"></i> Start Service</button>' : ''}
      ${s.status === 'in_progress' ? '<button type="button" id="viewStartBtn" style="' + BTN_BLUE + '"><i class="fa-solid fa-forward"></i> Continue</button>' : ''}
    </div>`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');

  const showFromMedia = async pick => {
    try {
      const media = await fetchMedia(s.service_id);
      const src = pick(media);
      if (src) showMedia('image', src);
      else alert('No photo available.');
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  };
  const damage = content.querySelector('#viewDamageBtn');
  if (damage) damage.addEventListener('click', () => s.has_damage_image ? showFromMedia(m => m.damage_image) : showMedia('image', s.image));
  const fin = content.querySelector('#viewFinalBtn');
  if (fin) fin.addEventListener('click', () => showFromMedia(m => m.final_image));
  const part = content.querySelector('#viewPartBtn');
  if (part) part.addEventListener('click', () => showFromMedia(m => (m.faulty_parts.find(p => p.image) || {}).image));
  const resched = content.querySelector('#viewReschedBtn');
  if (resched) resched.addEventListener('click', () => { modal.style.display = 'none'; openRescheduleModal(s); });
  const start = content.querySelector('#viewStartBtn');
  if (start) start.addEventListener('click', () => { modal.style.display = 'none'; openWizard(s.service_id); });
  modal.style.display = 'flex';
}

function showMedia(type, src) {
  const modal = document.getElementById('mediaModal');
  const img = modal.querySelector('img');
  const vid = modal.querySelector('video');
  if (type === 'image') {
    img.src = src; img.style.display = 'block';
    vid.style.display = 'none'; vid.pause();
  } else {
    vid.src = src; vid.style.display = 'block';
    img.style.display = 'none';
  }
  modal.style.display = 'flex';
}

function wireStaticModals() {
  document.querySelectorAll('.modal .close, .modal .cancel-btn').forEach(btn =>
    btn.addEventListener('click', e => e.target.closest('.modal').style.display = 'none'));
}

// ======================================================================
// Service wizard
//   step 1  damaged product image + serial number     -> POST /service/start
//   step 2  spare part needed?  (faulty part photo +   -> POST /service/spare_decision
//           hologram number for each part)
//   step 3  service report                             -> POST /service/submit_report
//   then the service manager approves the faulty part return and the service becomes completed
// ======================================================================
const wiz = {
  id: null, step: 1, serial: '', damageImage: '', hasSavedImage: false, spareNeeded: null,
  parts: [], newHolo: {}, workDone: '', finalImage: '', notice: '', busy: false
};

const blankPart = () => ({ part_name: '', old_hologram_number: '', image: '', hasImage: false });
const wizService = () => techState.services.find(s => s.service_id === wiz.id);
const wizEl = () => document.querySelector('#wizardModal .modal-content');
const LBL = 'display:block;font-size:13px;font-weight:600;color:#334155;margin:12px 0 4px;';
const INP = 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;';

function openWizard(serviceId) {
  const s = techState.services.find(x => x.service_id === serviceId);
  if (!s) return;
  if (s.status !== 'active' && s.status !== 'in_progress') {
    showResponseModal('Not available', 'This service is already sent for approval or closed.', false);
    return;
  }
  wiz.id = serviceId;
  wiz.step = nextStepOf(s);
  wiz.serial = s.tech_serial_no || '';
  wiz.damageImage = '';
  wiz.hasSavedImage = !!s.has_damage_image;
  wiz.spareNeeded = s.spare_needed === true ? true : s.spare_needed === false ? false : null;
  wiz.parts = (s.faulty_parts || []).map(p => ({ part_name: p.part_name, old_hologram_number: p.old_hologram_number, image: '', hasImage: !!p.has_image }));
  if (wiz.spareNeeded && !wiz.parts.length) wiz.parts = [blankPart()];
  wiz.newHolo = {};
  (s.faulty_parts || []).forEach(p => { wiz.newHolo[p.old_hologram_number] = p.new_hologram_number || ''; });
  wiz.workDone = s.work_done || '';
  wiz.finalImage = '';
  wiz.notice = '';
  wiz.busy = false;
  drawWizard();
  document.getElementById('wizardModal').style.display = 'flex';
}

function closeWizard() {
  document.getElementById('wizardModal').style.display = 'none';
}

function setWizErr(msg) {
  const el = document.getElementById('wizErr');
  if (el) el.textContent = msg || '';
}

// copy what is typed into the form back into wiz, so redrawing never loses anything
function captureWizardInputs() {
  const root = wizEl();
  if (wiz.step === 1) {
    const serial = root.querySelector('#wizSerial');
    if (serial) wiz.serial = serial.value;
  } else if (wiz.step === 2) {
    root.querySelectorAll('.wiz-part').forEach((block, i) => {
      if (!wiz.parts[i]) return;
      wiz.parts[i].part_name = block.querySelector('.wiz-part-name').value;
      wiz.parts[i].old_hologram_number = block.querySelector('.wiz-part-holo').value;
    });
  } else {
    const work = root.querySelector('#wizWork');
    if (work) wiz.workDone = work.value;
    root.querySelectorAll('.wiz-newholo').forEach(inp => { wiz.newHolo[inp.dataset.old] = inp.value; });
  }
}

function previewHtml(src, savedText) {
  if (src) return `<img src="${src}" style="max-width:100%;max-height:180px;border-radius:10px;margin-top:8px;display:block;">`;
  return savedText ? `<p style="color:#16a34a;font-size:13px;margin-top:6px;"><i class="fa-solid fa-circle-check"></i> ${savedText}</p>` : '';
}

function stepOneHtml(s) {
  return `
    <p style="color:#64748b;font-size:13px;">Take a clear photo of the <b>damaged product</b> and enter its serial number.</p>
    <div style="background:#f8fafc;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:8px;">
      <b>${techEsc(productLabel(s))}</b>${s.model_no ? ` · ${techEsc(s.model_no)}` : ''}<br>
      <span style="color:#64748b;">Issue: ${techEsc(s.issue)}</span>
    </div>
    <label style="${LBL}">Image of the damaged product *</label>
    <input type="file" id="wizDamageFile" accept="image/*" capture="environment">
    ${previewHtml(wiz.damageImage, wiz.hasSavedImage ? 'Photo already saved — choose a new file only to replace it.' : '')}
    <label style="${LBL}">Serial number *</label>
    <input id="wizSerial" value="${techEsc(wiz.serial)}" placeholder="Serial number printed on the product" style="${INP}">
    ${s.serial_no ? `<small style="color:#94a3b8;">On the service ticket: ${techEsc(s.serial_no)}</small>` : ''}`;
}

function partBlockHtml(p, i) {
  return `
    <div class="wiz-part" data-i="${i}" style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-top:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b style="font-size:13px;">Faulty part ${i + 1}</b>
        ${wiz.parts.length > 1 ? '<button type="button" class="wiz-rm-part" style="border:none;background:none;color:#d62828;cursor:pointer;font-size:12px;">Remove</button>' : ''}
      </div>
      <label style="${LBL}">Part name *</label>
      <input class="wiz-part-name" value="${techEsc(p.part_name)}" placeholder="e.g. Main PCB, Pump" style="${INP}">
      <label style="${LBL}">Hologram number of the faulty part *</label>
      <input class="wiz-part-holo" value="${techEsc(p.old_hologram_number)}" placeholder="Hologram number" style="${INP}">
      <label style="${LBL}">Image of the damaged part *</label>
      <input type="file" class="wiz-part-file" accept="image/*" capture="environment">
      ${previewHtml(p.image, p.hasImage ? 'Photo already saved — choose a new file only to replace it.' : '')}
    </div>`;
}

function stepTwoHtml() {
  const choice = (val, title, sub) => `
    <label style="flex:1;border:2px solid ${wiz.spareNeeded === val ? '#1665ff' : '#e2e8f0'};background:${wiz.spareNeeded === val ? '#eef5ff' : '#fff'};border-radius:12px;padding:14px;cursor:pointer;">
      <input type="radio" name="spare" value="${val ? 'yes' : 'no'}" ${wiz.spareNeeded === val ? 'checked' : ''}>
      <b style="margin-left:6px;">${title}</b><br><small style="color:#64748b;">${sub}</small>
    </label>`;
  return `
    <p style="color:#64748b;font-size:13px;">Does this service need a spare part?</p>
    <div style="display:flex;gap:10px;margin-top:8px;">
      ${choice(false, 'Not needed', 'Repair without replacing a part')}
      ${choice(true, 'Needed', 'A part has to be replaced')}
    </div>
    ${wiz.spareNeeded ? `
      <p style="color:#64748b;font-size:12px;margin-top:12px;">The service manager gets a spare part request automatically. Add the photo and hologram number of every faulty part.</p>
      ${wiz.parts.map(partBlockHtml).join('')}
      <button type="button" id="wizAddPart" style="${BTN_GREY}margin-top:10px;"><i class="fa-solid fa-plus"></i> Add another faulty part</button>` : ''}`;
}

function stepThreeHtml(s) {
  const parts = s.faulty_parts || [];
  return `
    ${s.report_rejected_reason ? `<div style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:10px;"><b>Sent back by service manager:</b> ${techEsc(s.report_rejected_reason)}</div>` : ''}
    <div style="background:#f8fafc;border-radius:10px;padding:10px 12px;font-size:13px;">
      <b>${techEsc(productLabel(s))}</b> · serial ${techEsc(s.tech_serial_no || s.serial_no || '-')}<br>
      Spare part: ${s.spare_needed ? parts.map(p => `${techEsc(p.part_name)} (old hologram ${techEsc(p.old_hologram_number)})`).join(', ') : '<b>not needed</b>'}
    </div>
    <label style="${LBL}">Service report — what was done *</label>
    <textarea id="wizWork" rows="4" placeholder="Describe the fault found and the work carried out" style="${INP}resize:vertical;">${techEsc(wiz.workDone)}</textarea>
    ${s.spare_needed ? parts.map(p => `
      <label style="${LBL}">New hologram number of the replacement for ${techEsc(p.part_name)} *</label>
      <input class="wiz-newholo" data-old="${techEsc(p.old_hologram_number)}" value="${techEsc(wiz.newHolo[p.old_hologram_number] || '')}" placeholder="Hologram on the new part" style="${INP}">`).join('') : ''}
    <label style="${LBL}">Photo after repair (optional)</label>
    <input type="file" id="wizFinalFile" accept="image/*" capture="environment">
    ${previewHtml(wiz.finalImage, s.has_final_image ? 'A photo is already saved.' : '')}
    <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:10px 12px;font-size:12px;margin-top:14px;">
      After you submit, the service manager has to approve${s.spare_needed ? ' the return of the faulty part' : ' the report'}.
      The service is marked <b>completed</b> only after that approval.
    </div>`;
}

function drawWizard() {
  const s = wizService();
  const box = wizEl();
  if (!s || !box) return;
  const names = ['Damaged product', 'Spare part', 'Service report'];
  const stepper = names.map((n, i) => {
    const k = i + 1;
    const done = k < wiz.step, now = k === wiz.step;
    return `<div style="flex:1;text-align:center;">
      <div style="width:28px;height:28px;border-radius:50%;margin:0 auto 4px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:${done ? '#16a34a' : now ? '#1665ff' : '#e2e8f0'};color:${done || now ? '#fff' : '#64748b'};">${done ? '<i class="fa-solid fa-check"></i>' : k}</div>
      <small style="color:${now ? '#0f172a' : '#94a3b8'};font-weight:${now ? 700 : 500};">${n}</small></div>`;
  }).join('<div style="flex:0 0 24px;border-top:2px solid #e2e8f0;margin-top:14px;"></div>');
  const body = wiz.step === 1 ? stepOneHtml(s) : wiz.step === 2 ? stepTwoHtml() : stepThreeHtml(s);

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Service #${techEsc(s.service_id.slice(0, 8))}</h3>
      <button type="button" id="wizClose" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div style="display:flex;align-items:flex-start;margin-bottom:16px;">${stepper}</div>
    ${wiz.notice ? `<div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;">${techEsc(wiz.notice)}</div>` : ''}
    ${body}
    <p id="wizErr" style="color:#d62828;font-size:13px;min-height:18px;margin-top:12px;"></p>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:6px;">
      <button type="button" id="wizBack" style="${BTN_GREY}${wiz.step === 1 ? 'visibility:hidden;' : ''}">Back</button>
      <button type="button" id="wizNext" style="${BTN_BLUE}">${wiz.step === 3 ? '<i class="fa-solid fa-paper-plane"></i> Submit for approval' : 'Save &amp; next'}</button>
    </div>`;
  bindWizard();
}

function bindWizard() {
  const root = wizEl();
  root.querySelector('#wizClose').addEventListener('click', closeWizard);
  root.querySelector('#wizBack').addEventListener('click', () => { captureWizardInputs(); wiz.step -= 1; wiz.notice = ''; drawWizard(); });
  root.querySelector('#wizNext').addEventListener('click', wizardNext);

  const pick = async (input, apply) => {
    try {
      captureWizardInputs();
      apply(await pickImage(input.files[0]));
      drawWizard();
    } catch (err) {
      input.value = '';
      setWizErr(err.message);
    }
  };
  const dmg = root.querySelector('#wizDamageFile');
  if (dmg) dmg.addEventListener('change', () => pick(dmg, img => { wiz.damageImage = img; }));
  const fin = root.querySelector('#wizFinalFile');
  if (fin) fin.addEventListener('change', () => pick(fin, img => { wiz.finalImage = img; }));

  root.querySelectorAll('input[name=spare]').forEach(r => r.addEventListener('change', () => {
    captureWizardInputs();
    wiz.spareNeeded = r.value === 'yes';
    if (wiz.spareNeeded && !wiz.parts.length) wiz.parts = [blankPart()];
    drawWizard();
  }));
  const add = root.querySelector('#wizAddPart');
  if (add) add.addEventListener('click', () => { captureWizardInputs(); wiz.parts.push(blankPart()); drawWizard(); });
  root.querySelectorAll('.wiz-rm-part').forEach(b => b.addEventListener('click', e => {
    captureWizardInputs();
    wiz.parts.splice(Number(e.target.closest('.wiz-part').dataset.i), 1);
    drawWizard();
  }));
  root.querySelectorAll('.wiz-part-file').forEach(inp => inp.addEventListener('change', e => {
    const i = Number(e.target.closest('.wiz-part').dataset.i);
    pick(inp, img => { wiz.parts[i].image = img; });
  }));
}

async function wizardNext() {
  captureWizardInputs();
  setWizErr('');
  const btn = document.getElementById('wizNext');
  if (wiz.busy) return;
  wiz.busy = true;
  btn.disabled = true;
  try {
    if (wiz.step === 1) await saveStepOne();
    else if (wiz.step === 2) await saveStepTwo();
    else await submitReport();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') setWizErr(err.message);
  } finally {
    wiz.busy = false;
    const again = document.getElementById('wizNext');
    if (again) again.disabled = false;
  }
}

async function saveStepOne() {
  const s = wizService();
  const serial = wiz.serial.trim();
  if (!wiz.damageImage && !wiz.hasSavedImage) throw new Error('Upload an image of the damaged product.');
  if (!serial) throw new Error('Enter the serial number of the product.');

  const unchanged = wiz.hasSavedImage && !wiz.damageImage && serial === (s.tech_serial_no || '');
  wiz.notice = '';
  if (!unchanged) {
    const image = wiz.damageImage || (await fetchMedia(wiz.id)).damage_image;   // serial changed, photo kept
    const data = await postJson(`/service/start/${wiz.id}`, { damage_image: image, serial_no: serial });
    wiz.hasSavedImage = true;
    wiz.damageImage = '';
    if (data.serial_mismatch) wiz.notice = `The serial number differs from the service ticket (${s.serial_no}). The service manager will see this.`;
  }
  await loadMyServices();
  wiz.step = 2;
  drawWizard();
}

async function saveStepTwo() {
  if (wiz.spareNeeded === null) throw new Error('Choose whether a spare part is needed.');
  const parts = [];
  if (wiz.spareNeeded) {
    if (!wiz.parts.length) throw new Error('Add at least one faulty part.');
    const media = wiz.parts.some(p => !p.image && p.hasImage) ? await fetchMedia(wiz.id) : null;
    for (let i = 0; i < wiz.parts.length; i++) {
      const p = wiz.parts[i];
      const name = p.part_name.trim(), holo = p.old_hologram_number.trim();
      if (!name) throw new Error(`Enter the name of faulty part ${i + 1}.`);
      if (!holo) throw new Error(`Enter the hologram number of faulty part ${i + 1}.`);
      const image = p.image || (media && media.faulty_parts[i] && media.faulty_parts[i].image) || '';
      if (!image) throw new Error(`Upload the photo of faulty part ${i + 1}.`);
      parts.push({ part_name: name, old_hologram_number: holo, image });
    }
  }
  await postJson(`/service/spare_decision/${wiz.id}`, { spare_needed: wiz.spareNeeded, parts });
  await loadMyServices();
  loadMyRequests();
  const s = wizService();
  (s.faulty_parts || []).forEach(p => { if (!(p.old_hologram_number in wiz.newHolo)) wiz.newHolo[p.old_hologram_number] = ''; });
  wiz.notice = '';
  wiz.step = 3;
  drawWizard();
}

async function submitReport() {
  const s = wizService();
  const work = wiz.workDone.trim();
  if (!work) throw new Error('Write the service report — what was done.');
  const parts = [];
  if (s.spare_needed) {
    for (const p of (s.faulty_parts || [])) {
      const nh = (wiz.newHolo[p.old_hologram_number] || '').trim();
      if (!nh) throw new Error(`Enter the new hologram number for ${p.part_name}.`);
      parts.push({ old_hologram_number: p.old_hologram_number, new_hologram_number: nh });
    }
  }
  const sentWithPart = !!s.spare_needed;
  await postJson(`/service/submit_report/${wiz.id}`, { work_done: work, parts, final_image: wiz.finalImage || null });
  closeWizard();
  showResponseModal('Report sent for approval',
    sentWithPart
      ? 'The service manager has been notified. This service will be completed only after they approve the return of the faulty part.'
      : 'The service manager has been notified. This service will be completed after they approve your report.', true);
  await loadMyServices();
}

// ---------- Request New Service modal (creates an approval request, not a live service) ----------
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}


function openRequestServiceModal() {
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3>Request New Service</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="color:#64748b;font-size:13px;margin-bottom:10px;">This will be sent to admin/employee for approval. It will not appear in your active services until approved.</p>
    <form id="requestServiceForm" style="display:flex;flex-direction:column;gap:10px;">
      <input name="company_name" placeholder="Company name *" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>
      <input name="product_id" placeholder="Product name" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>
      <input name="model_no" placeholder="Model No." style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
      <select name="location" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>
        <option value="indoor">Inhouse</option>
        <option value="outdoor">Field</option>
      </select>
      <textarea name="address" id="reqAddress" placeholder="Field service address *" style="display:none;min-height:56px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;"></textarea>
      <input name="serial_no" placeholder="Serial No" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>
      <input name="purchase_date" type="date" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required>
      <textarea name="issue" placeholder="Issue description" style="min-height:70px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;" required></textarea>
      <textarea name="spare_parts" placeholder="Spare parts needed (optional)" style="min-height:50px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;"></textarea>
      <label style="font-size:12px;color:#64748b;">Image proof (optional, max 2MB)</label>
      <input type="file" name="image_file" accept="image/*">
      <label style="font-size:12px;color:#64748b;">Video proof (optional, max 20MB)</label>
      <input type="file" name="video_file" accept="video/*">
      <p id="requestServiceMediaError" style="color:#d62828;font-size:12px;display:none;"></p>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">
        <button type="button" class="cancel-btn" style="padding:10px 16px;border:none;border-radius:8px;background:#eee;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:10px 16px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;">Send Request</button>
      </div>
    </form>`;

  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  content.querySelector('.cancel-btn').addEventListener('click', () => modal.style.display = 'none');

  const locSel = content.querySelector('select[name="location"]');
  const addrBox = content.querySelector('#reqAddress');
  locSel.addEventListener('change', () => { addrBox.style.display = locSel.value === 'outdoor' ? 'block' : 'none'; });

  content.querySelector('#requestServiceForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const errorBox = document.getElementById('requestServiceMediaError');
    errorBox.style.display = 'none';

    const imageFile = form.querySelector('[name="image_file"]').files[0];
    const videoFile = form.querySelector('[name="video_file"]').files[0];

    if (fd.get('location') === 'outdoor' && !(fd.get('address') || '').trim()) {
      errorBox.textContent = 'Enter the address for a field service.';
      errorBox.style.display = 'block';
      return;
    }

    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

    if (imageFile && imageFile.size > MAX_IMAGE_BYTES) {
      errorBox.textContent = `Image is ${(imageFile.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`;
      errorBox.style.display = 'block';
      return;
    }
    if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
      errorBox.textContent = `Video is ${(videoFile.size / 1024 / 1024).toFixed(1)}MB — must be 20MB or under.`;
      errorBox.style.display = 'block';
      return;
    }

    const payload = {
      product_id: fd.get('product_id'),
      company_name: (fd.get('company_name') || '').trim(),
      product_name: (fd.get('product_id') || '').trim(),
      model_no: (fd.get('model_no') || '').trim(),
      location: fd.get('location'),
      serial_no: (fd.get('serial_no') || '').trim().toLowerCase(),
      purchase_date: fd.get('purchase_date'),
      issue: fd.get('issue'),
      spare_parts: fd.get('spare_parts') || '',
      address: fd.get('location') === 'outdoor' ? (fd.get('address') || '').trim() : ''
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
      payload.image = imageFile ? await readFileAsBase64(imageFile) : '';
      payload.video = videoFile ? await readFileAsBase64(videoFile) : '';

      const res = await apiFetch('/request/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'request failed');
      modal.style.display = 'none';
      form.reset();
      showResponseModal('Request sent', 'Your service request has been sent to admin/employee for approval.', true);
      await loadMyRequests();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Request';
    }
  });

  modal.style.display = 'flex';
}

// ======================================================================
// Reschedule a service
// ======================================================================
function canReschedule(s) {
  return s && s.status !== 'completed' && s.status !== 'rejected';
}

function openRescheduleModal(s) {
  if (!s) return;
  openRescheduleRequest({
    subtitle: `${productLabel(s)} · currently ${fmtWhen(s.scheduled_date)}`, when: s.scheduled_date,
    url: `/service/reschedule/${encodeURIComponent(s.service_id)}`, field: 'reason', after: loadMyServices
  });
}

function openRescheduleRequest(o) {
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Request Reschedule</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="font-size:13px;color:#64748b;margin-bottom:6px;">${o.subtitle}</p>
    <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:12px;">The date changes only after the service manager approves this request.</div>
    <label style="${LBL}">Preferred new date &amp; time</label>
    <input type="datetime-local" id="reschedWhen" value="${toLocalInput(o.when)}" style="${INP}">
    <label style="${LBL}">Reason *</label>
    <textarea id="reschedReason" rows="3" style="${INP}"></textarea>
    <p id="reschedErr" style="color:#dc2626;font-size:13px;min-height:16px;margin-top:6px;"></p>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">
      <button type="button" class="cancel-btn" style="${BTN_GREY}">Cancel</button>
      <button type="button" id="reschedSave" style="${BTN_BLUE}">Send Request</button>
    </div>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  content.querySelector('.cancel-btn').addEventListener('click', close);
  content.querySelector('#reschedSave').addEventListener('click', async () => {
    const when = content.querySelector('#reschedWhen').value;
    const reason = content.querySelector('#reschedReason').value.trim();
    const err = content.querySelector('#reschedErr');
    if (!when) { err.textContent = 'Pick a date and time.'; return; }
    if (!reason) { err.textContent = 'Write the reason for rescheduling.'; return; }
    try {
      await postJson(o.url, { scheduled_date: new Date(when).toISOString(), [o.field]: reason });
      close();
      showResponseModal('Request sent', 'Your reschedule request was sent to the service manager for approval.', true);
      await o.after();
      await loadMyRequests();
    } catch (e) { err.textContent = e.message; }
  });
  modal.style.display = 'flex';
}

// ======================================================================
// Generic detail modal (used by the cards, demo units, parts and installations)
// ======================================================================
function openDetailModal(title, bodyHtml) {
  const modal = document.getElementById('detailModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>${title}</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>${bodyHtml}`;
  content.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');
  modal.style.display = 'flex';
  return content;
}

const dRow = (label, value) => `<div class="detail"><small>${label}</small><p>${value || '-'}</p></div>`;
const TH = 'style="text-align:left;padding:8px;"';
const TD = 'style="padding:8px;border-top:1px solid #e2e8f0;"';



// ======================================================================
// Demo units and allocated parts
// ======================================================================
async function loadAllocations() {
  try {
    const res = await apiFetch('/allocation/technician');
    const data = await res.json();
    if (!res.ok) throw new Error('failed');
    techState.demoUnits = data.demo_units || [];
    techState.parts = data.spare_parts || [];
  } catch (e) {
    techState.demoUnits = []; techState.parts = [];
  }
  renderAll();
}

function demoItems(a) {
  return (a.items || []).map(it => ({
    name: it.product_name || it.product_id || '-', model: it.model_no || it.model_number || '-',
    serials: (it.serial_numbers || []).join(', ') || '-', qty: it.quantity || (it.serial_numbers || []).length || 1
  }));
}

function allocWhen(a) {
  return a.created_at || a.allocated_at || a.allocation_date || (a.dispatch && a.dispatch.dispatched_at) || '';
}

const demoCanReturn = a => !a.return_status;
function openDemoReturn(a) {
  if (!a) return;
  const it = demoItems(a);
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Return Demo Unit</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="font-size:13px;color:#64748b;">${it.map(x => techEsc(x.name) + (x.serials ? ' (' + techEsc(x.serials) + ')' : '')).join(', ')}</p>
    <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:12px;margin-top:8px;">The unit is marked returned and goes back to inventory only after the service manager approves.</div>
    <label style="${LBL}">Returned through *</label>
    <select id="retVia" style="${INP}">
      <option value="">Select</option><option>Courier</option><option>Hand delivery</option><option>Dropped at office</option><option>Other</option>
    </select>
    <label style="${LBL}">Proof photo (optional, max 2MB)</label>
    <input type="file" id="retImg" accept="image/*" style="${INP}">
    <label style="${LBL}">Note (optional)</label>
    <textarea id="retNote" rows="2" style="${INP}"></textarea>
    <p id="retErr" style="color:#dc2626;font-size:13px;min-height:16px;margin-top:6px;"></p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button type="button" class="cancel-btn" style="${BTN_GREY}">Cancel</button>
      <button type="button" id="retSave" style="${BTN_BLUE}">Send return request</button>
    </div>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  content.querySelector('.cancel-btn').addEventListener('click', close);
  const save = content.querySelector('#retSave');
  save.addEventListener('click', async () => {
    const err = content.querySelector('#retErr');
    const via = content.querySelector('#retVia').value;
    const f = content.querySelector('#retImg').files[0];
    if (!via) { err.textContent = 'Select how the unit was returned.'; return; }
    if (f && f.size > 2 * 1024 * 1024) { err.textContent = 'Image must be 2MB or under.'; return; }
    save.disabled = true;
    try {
      const proof = { note: content.querySelector('#retNote').value.trim() };
      if (f) proof.image = await readFileAsBase64(f);
      await postJson(`/allocation/return_request/${encodeURIComponent(a.allocation_id)}`, { returned_through: via, proof });
      close(); await loadAllocations(); renderAll();
      showResponseModal('Return request sent', 'The service manager will approve it. The unit is marked returned after that.', true);
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  });
  modal.style.display = 'flex';
}

function demoStatus(a) {
  if (a.return_status) return String(a.return_status).replace(/_/g, ' ');
  return 'with you';
}


function openDemoDetail(a) {
  if (!a) return;
  const it = demoItems(a);
  const cust = a.customer || {};
  openDetailModal('Demo Unit Details', `
    ${dRow('Allocation ID', techEsc(a.allocation_id))}
    ${dRow('Status', techEsc(demoStatus(a)))}
    ${dRow('Allocated On', allocWhen(a) ? fmtWhen(allocWhen(a)) : '-')}
    <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:10px;margin:10px 0;"><table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead style="background:#f8fafc;"><tr>${['Product', 'Model No.', 'Serial No(s).', 'Qty'].map(h => `<th ${TH}>${h}</th>`).join('')}</tr></thead>
      <tbody>${it.map(x => `<tr><td ${TD}>${techEsc(x.name)}</td><td ${TD}>${techEsc(x.model)}</td><td ${TD}>${techEsc(x.serials)}</td><td ${TD}>${techEsc(x.qty)}</td></tr>`).join('')}</tbody></table></div>
    ${cust.company_name ? dRow('Customer', techEsc(cust.company_name) + (cust.company_address ? ' - ' + techEsc(cust.company_address) : '')) : ''}
    ${a.remarks ? dRow('Remarks', techEsc(a.remarks)) : ''}
    ${demoCanReturn(a) ? `<div style="margin-top:12px;"><button type="button" id="demoRetBtn" style="${BTN_GREY}"><i class="fa-solid fa-rotate-left"></i> Return this unit</button></div>` : '<div style="background:#eff6ff;color:#1e3a8a;border-radius:8px;padding:8px 12px;font-size:12px;margin-top:12px;">Return request: ' + techEsc(demoStatus(a)) + '</div>'}
    ${a.dispatch ? dRow('Dispatch', techEsc([a.dispatch.courier_name, a.dispatch.tracking_number || a.dispatch.docket_no].filter(Boolean).join(' · ') || 'Dispatched')) : ''}`);
  const rb = document.getElementById('demoRetBtn');
  if (rb) rb.addEventListener('click', () => { document.getElementById('detailModal').style.display = 'none'; openDemoReturn(a); });
}


function partInfo(a) {
  const p = a.spare_part || {};
  const svc = techState.services.find(s => s.service_id === p.service_id);
  return {
    name: p.part_name || '-', qty: p.quantity || 1, svc, serviceId: p.service_id || '',
    status: a.dispatch ? 'dispatched' : 'awaiting dispatch'
  };
}


function openPartDetail(a) {
  if (!a) return;
  const p = partInfo(a);
  const c = openDetailModal('Allocated Part Details', `
    ${dRow('Part', techEsc(p.name))}
    ${dRow('Quantity', techEsc(p.qty))}
    ${dRow('Status', techEsc(p.status))}
    ${dRow('Allocation ID', techEsc(a.allocation_id))}
    ${dRow('For service', p.svc ? techEsc(productLabel(p.svc)) + ' · model ' + techEsc(modelLabel(p.svc)) + ' · serial ' + techEsc(p.svc.serial_no || '-') : techEsc(p.serviceId))}
    ${a.dispatch ? dRow('Dispatch', techEsc([a.dispatch.courier_name, a.dispatch.tracking_number || a.dispatch.docket_no].filter(Boolean).join(' · ') || 'Dispatched')) : ''}
    ${p.svc ? `<button type="button" id="partOpenSvc" style="${BTN_BLUE}margin-top:12px;">Open service</button>` : ''}`);
  const b = c.querySelector('#partOpenSvc');
  if (b) b.addEventListener('click', () => { document.getElementById('detailModal').style.display = 'none'; openViewModal(p.svc); });
}


// ======================================================================
// Installations
// ======================================================================
const INSTALL_LABEL = { requested: 'Requested', scheduled: 'Scheduled', in_progress: 'In progress', pending_approval: 'Completion in review', completed: 'Completed' };

async function loadInstallations() {
  try {
    const res = await apiFetch('/installation/mine');
    const data = await res.json();
    if (!res.ok) throw new Error('failed');
    techState.installs = (data.dataset || []).filter(i => i.technician_id || (i.requested_by && i.requested_by === ME()));
  } catch (e) { techState.installs = []; }
  renderAll();
  const id = new URLSearchParams(location.search).get('installation');
  if (id && !techState._installDeepLink) {
    techState._installDeepLink = true;
    const i = techState.installs.find(x => x.installation_id === id);
    if (i) openInstallDetail(i);
  }
}


function openInstallDetail(i) {
  if (!i) return;
  const hist = (i.schedule_history || []).slice().reverse().map(h =>
    `<li>${fmtWhen(h.from)} &rarr; <b>${fmtWhen(h.to)}</b> by ${techEsc(h.by)}${h.note ? ' - ' + techEsc(h.note) : ''}</li>`).join('');
  const done = i.status === 'completed';
  const c = openDetailModal('Installation Details', `
    ${dRow('Status', techEsc(instLabel(i)))}
    ${dRow('Product', techEsc(i.product_name))}
    ${dRow('Model No.', techEsc(i.model_no))}
    ${dRow('Serial No.', techEsc(i.serial_no))}
    ${dRow('Customer', techEsc(i.company_name))}
    ${dRow('Address', techEsc(i.address))}
    ${dRow('Contact', techEsc([i.contact_person, i.contact_number].filter(Boolean).join(' · ')))}
    ${dRow('Preferred Date', i.preferred_date ? fmtWhen(i.preferred_date) : '-')}
    ${dRow('Scheduled For', fmtWhen(i.scheduled_date))}
    ${dRow('Technician', techEsc(i.technician_id || 'Not assigned yet — waiting for service manager approval'))}
    ${dRow('Requested By', techEsc(i.requested_by))}
    ${i.notes ? dRow('Notes', techEsc(i.notes)) : ''}
    ${hist ? dRow('Schedule History', `<ul style="padding-left:18px;font-size:13px;">${hist}</ul>`) : ''}
    ${done ? '' : instAwaiting(i)
      ? `<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:12px;margin-top:12px;">Your request is with the service manager. It is assigned to you once approved.</div>`
      : `<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;align-items:center;">
      ${i.scheduled_date ? `<button type="button" id="instSched" style="${BTN_BLUE}"><i class="fa-solid fa-calendar-days"></i> Request Reschedule</button>` : '<span style="font-size:12px;color:#64748b;">The service manager sets the date.</span>'}
      ${i.status === 'scheduled' ? `<button type="button" class="inst-st" data-st="in_progress" style="${BTN_GREEN}">Start Installation</button>` : ''}
      ${i.status === 'in_progress' ? `<button type="button" class="inst-st" data-st="completed" style="${BTN_GREEN}">Complete with photo</button>` : ''}
      ${i.status === 'pending_approval' ? '<span style="font-size:12px;color:#64748b;">Completion proof sent — waiting for the service manager.</span>' : ''}
    </div>`}`);
  const sb = c.querySelector('#instSched');
  if (sb) sb.addEventListener('click', () => { document.getElementById('detailModal').style.display = 'none'; openInstallSchedule(i); });
  c.querySelectorAll('.inst-st').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.st === 'completed') { document.getElementById('detailModal').style.display = 'none'; openInstallComplete(i); return; }
    try {
      await postJson(`/installation/status/${encodeURIComponent(i.installation_id)}`, { status: b.dataset.st });
      document.getElementById('detailModal').style.display = 'none';
      await loadInstallations();
    } catch (e) { alert(e.message); }
  }));
}

function openInstallSchedule(i) {
  if (!i) return;
  if (instAwaiting(i) || !i.scheduled_date) {
    showResponseModal('Date is set by the service manager',
      instAwaiting(i) ? 'This installation is not approved yet.' : 'The service manager will schedule this installation. You can request a change after that.', false);
    return;
  }
  openRescheduleRequest({
    subtitle: `${techEsc(i.product_name)} · ${techEsc(i.company_name)} · currently ${fmtWhen(i.scheduled_date)}`, when: i.scheduled_date,
    url: `/installation/schedule/${encodeURIComponent(i.installation_id)}`, field: 'note', after: loadInstallations
  });
}

function openNewInstallModal() {
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  const f = (name, ph, req) => `<input name="${name}" placeholder="${ph}" ${req ? 'required' : ''} style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">`;
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Request Installation</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;">This goes to the service manager. Once approved, the installation is assigned to you.</div>
    <form id="instForm" style="display:flex;flex-direction:column;gap:10px;">
      ${f('product_name', 'Product name', true)}${f('model_no', 'Model No.')}${f('serial_no', 'Serial No.')}
      ${f('company_name', 'Customer / company', true)}${f('address', 'Installation address *', true)}
      ${f('contact_person', 'Contact person')}${f('contact_number', 'Contact number')}
      <label style="font-size:12px;color:#64748b;">Preferred date (optional)</label>
      <input name="preferred_date" type="datetime-local" style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;">
      <textarea name="notes" placeholder="Notes" style="min-height:50px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;"></textarea>
      <p id="instFormErr" style="color:#dc2626;font-size:13px;min-height:16px;"></p>
      <div style="display:flex;justify-content:flex-end;gap:10px;"><button type="button" class="cancel-btn" style="${BTN_GREY}">Cancel</button>
      <button type="submit" style="${BTN_BLUE}">Send Request</button></div>
    </form>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  content.querySelector('.cancel-btn').addEventListener('click', close);
  content.querySelector('#instForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v).trim()]));
    if (body.preferred_date) body.preferred_date = new Date(body.preferred_date).toISOString();
    try {
      await postJson('/installation/create', body);
      close(); await loadInstallations(); renderAll();
      showResponseModal('Request sent', 'Your installation request was sent to the service manager for approval.', true);
    } catch (err) { content.querySelector('#instFormErr').textContent = err.message; }
  });
  modal.style.display = 'flex';
}



const FIELD_LABEL = s => ((s.location || 'indoor') === 'outdoor' ? 'Field' : 'Inhouse');

function requestTypeName(r) {
  return { reschedule: 'Reschedule', installation: 'Installation', service: 'New service', status_update: 'Status change', spare_part: 'Spare part' }[r.request_type] || r.request_type;
}

function requestLabel(r) {
  const d = r.details || {};
  if (r.request_type === 'reschedule') return `${d.label || ''} → ${fmtWhen(d.requested_date)}${d.reason ? ' (' + d.reason + ')' : ''}`;
  if (r.request_type === 'installation') return d.label || '';
  if (r.request_type === 'service') return `${d.product_name || d.product_id || ''} — ${d.issue || ''}`;
  if (r.request_type === 'status_update') return `Change status to "${(d.service_status || '').replace('_', ' ')}"`;
  return d.note || '';
}

function openRequestDetail(r) {
  const d = r.details || {};
  openDetailModal('Request Details', `
    ${dRow('Type', techEsc(requestTypeName(r)))}
    ${dRow('Status', techEsc(r.status))}
    ${dRow('Details', techEsc(requestLabel(r)))}
    ${d.kind === 'reschedule' || r.request_type === 'reschedule' ? dRow('Current date', fmtWhen(d.current_date)) + dRow('Requested date', fmtWhen(d.requested_date)) : ''}
    ${r.status === 'rejected' && r.reason ? dRow('Rejection reason', techEsc(r.reason)) : ''}
    ${dRow('Raised on', r.created_at ? fmtWhen(r.created_at) : '-')}`);
}

const BTN_ICON = 'border:none;background:#f1f5f9;border-radius:8px;padding:8px 10px;cursor:pointer;color:#334155;';
const viewBtn = '<button type="button" data-act="view" title="View" style="' + BTN_ICON + '"><i class="fa-solid fa-eye"></i></button>';

const TECH_VIEWS = {
  services: {
    title: 'Services', info: 'Start a service, upload proof, and send your report for approval',
    cols: ['Service ID', 'Company', 'Product', 'Model No.', 'Serial No.', 'Issue', 'Type / Address', 'Status', 'Scheduled', 'Charges', 'Warranty', 'Actions'],
    list: () => techState.services.slice().sort((a, b) => new Date(b.created_at || b.purchase_date || 0) - new Date(a.created_at || a.purchase_date || 0)),
    statuses: [['all', 'All'], ['active', 'New'], ['in_progress', 'In Progress'], ['pending_approval', 'Awaiting Approval'], ['completed', 'Completed'], ['rejected', 'Rejected']],
    statusOf: s => s.status,
    text: s => [s.company_name, productLabel(s), s.model_no, s.serial_no, s.service_id, s.issue, s.address].join(' '),
    cells: s => [techEsc((s.service_id || '').slice(0, 8)), techEsc(s.company_name || '-'), techEsc(productLabel(s)), techEsc(modelLabel(s)), techEsc(s.serial_no || ''), techEsc(s.issue || ''),
    `${FIELD_LABEL(s)}${s.address ? '<br><small style="color:#64748b;">' + techEsc(s.address) + '</small>' : ''}`,
    `<span class="stock ${statusBadgeClass(s.status)}">${techEsc(statusLabel(s))}</span>`, s.scheduled_date ? fmtWhen(s.scheduled_date) : '-',
    s.service_charges != null ? '₹' + s.service_charges : 'Not set', techEsc(s.warranty_until ?? '-')],
    actions: s => viewBtn + (canReschedule(s) ? '<button type="button" data-act="resched" title="Request reschedule" style="' + BTN_ICON + '"><i class="fa-solid fa-calendar-days"></i></button>' : '') + primaryActionHtml(s),
    act: { view: openViewModal, resched: openRescheduleModal, wiz: s => openWizard(s.service_id) },
    open: openViewModal,
    button: { label: '<i class="fa-solid fa-plus"></i> Request New Service', fn: () => openRequestServiceModal() },
    empty: 'No services found.'
  },
  installs: {
    title: 'Installations', info: 'Request an installation or work on the ones assigned to you — dates are set by the service manager',
    cols: ['Product', 'Model No.', 'Customer', 'Address', 'Status', 'Scheduled', 'Technician', 'Actions'],
    list: () => techState.installs,
    statuses: [['all', 'All'], ['pending', 'Awaiting approval'], ['requested', 'Assigned'], ['scheduled', 'Scheduled'], ['in_progress', 'In Progress'], ['pending_approval', 'Completion in review'], ['completed', 'Completed']],
    statusOf: i => instStatusKey(i),
    text: i => [i.product_name, i.model_no, i.company_name, i.address, i.serial_no].join(' '),
    cells: i => [techEsc(i.product_name), techEsc(i.model_no || '-'), techEsc(i.company_name), techEsc(i.address || '-'),
    `<span class="stock medium">${techEsc(instLabel(i))}</span>`, i.scheduled_date ? fmtWhen(i.scheduled_date) : '-', techEsc(i.technician_id || 'Pending approval')],
    actions: i => viewBtn
      + (instAwaiting(i) ? '<span style="font-size:12px;color:#64748b;">Waiting for approval</span>' : '')
      + (!instAwaiting(i) && i.status === 'requested' ? '<span style="font-size:12px;color:#64748b;">Waiting for schedule</span>' : '')
      + (!instAwaiting(i) && i.status === 'scheduled' ? `<button type="button" data-act="sched" style="${BTN_GREY}">Request Reschedule</button><button type="button" data-act="start" style="${BTN_GREEN}">Start</button>` : '')
      + (!instAwaiting(i) && i.status === 'in_progress' ? `<button type="button" data-act="done" style="${BTN_GREEN}">Complete</button>` : '')
      + (!instAwaiting(i) && i.status === 'pending_approval' ? '<span style="font-size:12px;color:#64748b;">Waiting for review</span>' : ''),
    act: {
      view: openInstallDetail, sched: openInstallSchedule,
      start: i => setInstallStatus(i, 'in_progress'), done: i => openInstallComplete(i)
    },
    open: openInstallDetail,
    button: { label: '<i class="fa-solid fa-plus"></i> Request Installation', fn: () => openNewInstallModal() },
    empty: 'No installations yet. Use Request Installation to ask the service manager.'
  },
  demo: {
    title: 'Demo Units', info: 'Demo units allocated to you',
    cols: ['Product', 'Model No.', 'Serial No.', 'Status', 'Allocated On', 'Actions'],
    list: () => techState.demoUnits,
    statuses: [['all', 'All'], ['with you', 'With you'], ['other', 'Returned / return pending']],
    statusOf: a => (demoStatus(a) === 'with you' ? 'with you' : 'other'),
    text: a => demoItems(a).map(x => x.name + ' ' + x.model + ' ' + x.serials).join(' '),
    cells: a => {
      const it = demoItems(a); const f = it[0] || { name: '-', model: '-', serials: '-' };
      return [techEsc(f.name) + (it.length > 1 ? ` <small style="color:#64748b;">+${it.length - 1} more</small>` : ''), techEsc(f.model), techEsc(f.serials),
      `<span class="stock medium">${techEsc(demoStatus(a))}</span>`, allocWhen(a) ? fmtWhen(allocWhen(a)) : '-'];
    },
    actions: a => viewBtn + (demoCanReturn(a) ? `<button type="button" data-act="ret" style="${BTN_GREY}"><i class="fa-solid fa-rotate-left"></i> Return</button>` : ''),
    act: { view: openDemoDetail, ret: openDemoReturn },
    open: openDemoDetail,
    empty: 'No demo units allocated to you.'
  },
  parts: {
    title: 'Allocated Parts', info: 'Spare parts issued against your services',
    cols: ['Part', 'Qty', 'For service', 'Status', 'Actions'],
    list: () => techState.parts,
    statuses: [['all', 'All'], ['awaiting dispatch', 'Awaiting dispatch'], ['dispatched', 'Dispatched']],
    statusOf: a => partInfo(a).status,
    text: a => { const p = partInfo(a); return p.name + ' ' + (p.svc ? productLabel(p.svc) : p.serviceId); },
    cells: a => {
      const p = partInfo(a);
      return [techEsc(p.name), techEsc(p.qty), p.svc ? techEsc(productLabel(p.svc)) + (p.svc.model_no ? ' (' + techEsc(p.svc.model_no) + ')' : '') : techEsc(p.serviceId.slice(0, 8)),
      `<span class="stock medium">${techEsc(p.status)}</span>`];
    },
    actions: () => viewBtn,
    act: { view: openPartDetail },
    open: openPartDetail,
    empty: 'No spare parts allocated for your services.'
  },
  requests: {
    title: 'My Requests', info: 'Requests you sent to the service manager — reschedules, new services, installations and spare parts',
    cols: ['Type', 'Details', 'Status', 'Raised On', 'Actions'],
    list: () => allMyRequests(),
    statuses: [['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']],
    statusOf: r => r.status,
    text: r => requestTypeName(r) + ' ' + requestLabel(r),
    cells: r => [techEsc(requestTypeName(r)), techEsc(requestLabel(r)) + (r.status === 'rejected' && r.reason ? ' <small style="color:#b91c1c;">— ' + techEsc(r.reason) + '</small>' : ''),
    `<span class="status ${requestStatusClass(r.status)}">${techEsc(r.status)}</span>`, r.created_at ? fmtWhen(r.created_at) : '-'],
    actions: () => viewBtn,
    act: { view: openRequestDetail },
    open: openRequestDetail,
    empty: 'No requests yet.'
  }
};

function openInstallComplete(i) {
  if (!i) return;
  const modal = document.getElementById('actionModal');
  const content = modal.querySelector('.modal-content');
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h3>Complete Installation</h3>
      <button class="close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <p style="font-size:13px;color:#64748b;">${techEsc(i.product_name)} · ${techEsc(i.company_name)}</p>
    <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:12px;margin-top:8px;">Upload a photo of the installed product. The installation is marked completed only after the service manager approves it.</div>
    <label style="${LBL}">Installation photo * (max 2MB)</label>
    <input type="file" id="instDoneImg" accept="image/*" style="${INP}">
    <img id="instDonePrev" style="display:none;max-width:100%;max-height:200px;border-radius:10px;margin-top:8px;">
    <label style="${LBL}">Note (optional)</label>
    <textarea id="instDoneNote" rows="3" style="${INP}"></textarea>
    <p id="instDoneErr" style="color:#dc2626;font-size:13px;min-height:16px;margin-top:6px;"></p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button type="button" class="cancel-btn" style="${BTN_GREY}">Cancel</button>
      <button type="button" id="instDoneSave" style="${BTN_GREEN}">Send for approval</button>
    </div>`;
  const close = () => modal.style.display = 'none';
  content.querySelector('.close').addEventListener('click', close);
  content.querySelector('.cancel-btn').addEventListener('click', close);
  const fileEl = content.querySelector('#instDoneImg'), prev = content.querySelector('#instDonePrev');
  fileEl.addEventListener('change', () => {
    const f = fileEl.files[0];
    if (f) { prev.src = URL.createObjectURL(f); prev.style.display = 'block'; } else prev.style.display = 'none';
  });
  const save = content.querySelector('#instDoneSave');
  save.addEventListener('click', async () => {
    const err = content.querySelector('#instDoneErr');
    const f = fileEl.files[0];
    if (!f) { err.textContent = 'Upload the installation photo first.'; return; }
    if (f.size > 2 * 1024 * 1024) { err.textContent = `Image is ${(f.size / 1024 / 1024).toFixed(1)}MB — must be 2MB or under.`; return; }
    save.disabled = true; save.textContent = 'Sending...';
    try {
      const image = await readFileAsBase64(f);
      await postJson(`/installation/status/${encodeURIComponent(i.installation_id)}`,
        { status: 'pending_approval', image, note: content.querySelector('#instDoneNote').value.trim() });
      close(); await loadInstallations();
      showResponseModal('Sent for approval', 'The service manager will review your photo and mark the installation completed.', true);
    } catch (e) { err.textContent = e.message; save.disabled = false; save.textContent = 'Send for approval'; }
  });
  modal.style.display = 'flex';
}

async function setInstallStatus(i, status) {
  if (status === 'completed') return openInstallComplete(i);
  try {
    await postJson(`/installation/status/${encodeURIComponent(i.installation_id)}`, { status });
    await loadInstallations();
  } catch (e) { alert(e.message); }
}

function setTechView(v) {
  techView = v;
  techStatus = 'all';
  techPage = 1;
  renderAll();
}

function techVisibleRows() {
  const v = TECH_VIEWS[techView];
  return v.list().filter(x => (techStatus === 'all' || v.statusOf(x) === techStatus) && (!techSearch || v.text(x).toLowerCase().includes(techSearch)));
}

function renderAll() {
  renderCategoryCards();
  renderChips();
  renderMain();
}

function renderCategoryCards() {
  const sv = techState.services, set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('catServices', sv.length);
  set('catServicesSub', `${sv.filter(s => s.status === 'active').length} new · ${sv.filter(s => s.status === 'in_progress').length} in progress`);
  const open = techState.installs.filter(i => i.status !== 'completed');
  set('catInstalls', open.length);
  set('catInstallsSub', `${techState.installs.filter(i => i.status === 'requested').length} not scheduled`);
  set('catDemo', techState.demoUnits.length);
  set('catDemoSub', 'allocated to you');
  set('catParts', techState.parts.length);
  set('catPartsSub', `${techState.parts.filter(a => !a.dispatch).length} awaiting dispatch`);
  const pend = allMyRequests().filter(r => r.status === 'pending').length;
  set('catRequests', pend);
  set('catRequestsSub', 'waiting for approval');
  document.querySelectorAll('#catCards .cat-card').forEach(c => c.classList.toggle('active', c.dataset.view === techView));
}

function renderChips() {
  const v = TECH_VIEWS[techView];
  const all = v.list();
  document.getElementById('viewTitle').textContent = v.title;
  let info = v.info;
  if (techView === 'services') {
    const faulty = techState.services.filter(s => s.status === 'pending_approval').reduce((n, s) => n + (Number(s.faulty_part_count) || 0), 0);
    const cost = techState.services.filter(s => s.status === 'completed').reduce((n, s) => n + (Number(s.service_charges) || 0), 0);
    info += ` · Faulty parts to return: ${faulty} · Earned: ₹${cost.toFixed(2)}`;
  }
  document.getElementById('viewInfo').textContent = info;
  const box = document.getElementById('statusChips');
  box.innerHTML = v.statuses.map(([k, label]) => {
    const n = k === 'all' ? all.length : all.filter(x => v.statusOf(x) === k).length;
    return `<button type="button" class="chip${techStatus === k ? ' active' : ''}" data-k="${techEsc(k)}">${label} (${n})</button>`;
  }).join('');
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { techStatus = c.dataset.k; techPage = 1; renderChips(); renderMain(); }));
  const btn = document.getElementById('viewAction');
  if (v.button) { btn.style.display = ''; btn.innerHTML = v.button.label; btn.onclick = v.button.fn; } else { btn.style.display = 'none'; btn.onclick = null; }
}

function renderMain() {
  const v = TECH_VIEWS[techView];
  const rows = techVisibleRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / TECH_PAGE_SIZE));
  techPage = Math.min(Math.max(1, techPage), totalPages);
  const pageRows = rows.slice((techPage - 1) * TECH_PAGE_SIZE, techPage * TECH_PAGE_SIZE);
  document.getElementById('mainHead').innerHTML = `<tr>${v.cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const tbody = document.getElementById('mainBody');
  tbody.innerHTML = pageRows.length ? pageRows.map((x, n) => `<tr data-n="${n}" style="cursor:pointer;">${v.cells(x).map(c => `<td>${c}</td>`).join('')}<td style="white-space:nowrap;display:flex;gap:6px;align-items:center;">${v.actions(x)}</td></tr>`).join('')
    : `<tr><td colspan="${v.cols.length}" style="text-align:center;color:#94a3b8;padding:28px;">${v.empty}</td></tr>`;
  tbody.querySelectorAll('tr[data-n]').forEach(tr => {
    const item = pageRows[Number(tr.dataset.n)];
    tr.addEventListener('click', e => { if (!e.target.closest('button')) v.open(item); });
    tr.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => v.act[b.dataset.act](item)));
  });
  renderTablePagination(document.querySelector('.pagination'), techPage, totalPages, p => { techPage = p; renderMain(); });
}