/* Allocate a spare part / service part / accessory to a service, from any page (no page switch).
 *
 *   openAllocatePartModal({ service, requestId, parts, onDone })
 *     service    - service object (needs service_id). Omit it to pick one from the full service list first.
 *     requestId  - technician spare_part request being fulfilled (closed by the server when done)
 *     parts      - names the technician asked for; the first one is pre-selected in the list
 *     onDone     - called after a successful allocation of everything
 *     pick       - true: no service yet (service form). Nothing is posted; onPick(selection) gets the chosen item
 *                  {part_name, quantity, product_id, model_no, product_type, lot_id, hologram_numbers, holograms, manual_holograms}
 *     reserved   - {lot_id: qty} and exclude - [hologram numbers] already chosen in the form (so they are not offered twice)
 *
 * Needs apiFetch() from common_auth.js. Posts to /allocation/create (same payload as the Allocated page).
 */
(function () {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const LABELS = { spare_parts: 'Spare Part', service_parts: 'Service Part', accessories: 'Accessory' };
  const holoCountOf = p => (typeof p.hologram_count === 'number' ? p.hologram_count
    : (Array.isArray(p.hologram_numbers) ? p.hologram_numbers.length : (p.hologram_no ? 1 : 0)));

  async function fetchDetail(p) {
    try {
      const q = new URLSearchParams({ product_id: p.product_id || '', model_no: p.model_no || '', product_type: p.product_type || '', lot_id: p._id || '' });
      const res = await apiFetch(`/inventory/detail?${q}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (p._id && data.product && data.product._id && data.product._id !== p._id) return null;
      return { ...p, ...data.product };
    } catch (e) { return null; }
  }

  window.openAllocatePartModal = function (opts) {
    opts = opts || {};
    const st = { service: opts.service || null, requestId: opts.requestId || '', queue: (opts.parts || []).slice() };

    const old = document.getElementById('apmModal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'apmModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:1500;';
    modal.innerHTML = `<div style="background:#fff;border-radius:16px;padding:24px;width:620px;max-width:96vw;max-height:92vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 id="apmTitle" style="margin:0;">Allocate Spare Part</h3>
        <button type="button" id="apmClose" style="border:none;background:none;font-size:22px;cursor:pointer;">&times;</button>
      </div><div id="apmBody"></div></div>`;
    document.body.appendChild(modal);
    const body = modal.querySelector('#apmBody');
    const title = t => { modal.querySelector('#apmTitle').textContent = t; };
    const close = () => modal.remove();
    modal.querySelector('#apmClose').addEventListener('click', close);
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });

    const INP = 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;box-sizing:border-box;';

    // ---------- step 1: pick a service (only when none was given) ----------
    async function serviceStep() {
      title('Select Service');
      body.innerHTML = '<p style="color:#94a3b8;">Loading services...</p>';
      try {
        const res = await apiFetch('/service/');
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        const list = (data.dataset || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        const stOf = s => String(s.status || s.service_status || '').replace(/_/g, ' ');
        body.innerHTML = `<input id="apmSvcQ" placeholder="Search by product, serial, issue, status or service ID..." style="${INP}margin-bottom:10px;">
          <div id="apmSvcList" style="max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>`;
        const box = body.querySelector('#apmSvcList'), q = body.querySelector('#apmSvcQ');
        const draw = () => {
          const t = q.value.trim().toLowerCase();
          const rows = list.filter(s => !t || [s.service_id, s.product_id, s.product_name, s.model_no, s.serial_no, s.issue, stOf(s), s.company_name].join(' ').toLowerCase().includes(t));
          box.innerHTML = rows.length ? rows.map(s => `<div class="apm-svc" data-id="${esc(s.service_id)}" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;cursor:pointer;">
              <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${esc(s.product_name || s.product_id || '')}</strong>
              <span style="font-size:11px;font-weight:600;color:#1665ff;background:#eef3fb;border-radius:999px;padding:2px 10px;text-transform:capitalize;">${esc(stOf(s) || '-')}</span></div>
              <small style="color:#64748b;">Serial: ${esc(s.serial_no || '-')} • #${esc(String(s.service_id || '').slice(0, 8))}${s.technician_alloted ? ' • ' + esc(s.technician_alloted) : ''}</small><br>
              <small style="color:#64748b;">${esc(s.issue || '')}</small></div>`).join('')
            : '<small style="color:#94a3b8;">No service matches.</small>';
          box.querySelectorAll('.apm-svc').forEach(r => r.addEventListener('click', () => { st.service = list.find(x => x.service_id === r.dataset.id); partStep(); }));
        };
        q.addEventListener('input', draw); draw();
      } catch (e) { body.innerHTML = '<small style="color:#d62828;">Could not load services.</small>'; }
    }

    // ---------- step 2: pick the item, hologram(s) / quantity ----------
    async function partStep() {
      const svc = st.service || {};
      title(opts.pick ? 'Add Spare Part' : `Allocate to Service #${String(svc.service_id || '').slice(0, 8)}`);
      body.innerHTML = '<p style="color:#94a3b8;">Loading inventory...</p>';
      let inv = [];
      try { const r = await apiFetch('/inventory/'); const d = await r.json(); inv = r.ok ? (d.dataset || []) : []; } catch (e) { }

      const lotMap = new Map();
      inv.filter(p => LABELS[p.product_type] && (Number(p.quantity) || 0) - ((opts.reserved || {})[p._id] || 0) > 0).forEach(p => {
        const k = String(p._id || `${p.product_id}||${p.product_name}||${p.model_no}`);
        lotMap.set(k, { key: k, product_id: p.product_id, type: p.product_type, name: p.product_name || '', model: p.model_no || '', parent: p.parent_product_name || '', stock: (Number(p.quantity) || 0) - ((opts.reserved || {})[p._id] || 0), tagged: Math.max(0, holoCountOf(p) - ((opts.exclude || []).length ? 0 : 0)), doc: p });
      });
      const lots = [...lotMap.values()].sort((a, b) => a.name.localeCompare(b.name));
      const names = [svc.product_name, svc.product_id].filter(Boolean).map(x => String(x).trim().toLowerCase());
      const forSvc = l => !!l.parent && names.includes(l.parent.trim().toLowerCase());
      const hasMatches = lots.some(forSvc);
      const requested = st.requestId && st.queue.length;

      body.innerHTML = `
        ${opts.pick ? '' : `<div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;">
          Product: ${esc(svc.product_name || svc.product_id || '')} • Serial: ${esc(svc.serial_no || '')}<br>Issue: ${esc(svc.issue || '')}</div>`}
        ${requested ? `<div style="background:#eef5ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;margin-bottom:12px;font-size:13px;color:#1e3a8a;">Technician requested: <b>${st.queue.map(esc).join(', ')}</b>. The item is pre-selected — just choose the hologram number(s).</div>` : ''}
        <form id="apmForm">
          <div style="font-size:12px;font-weight:600;color:#334155;margin-bottom:4px;">1. Select item <small style="font-weight:400;color:#94a3b8;">(spare parts, service parts, accessories)</small></div>
          <input id="apmQ" placeholder="Search item..." style="${INP}">
          ${hasMatches ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#475569;margin:8px 0;"><input type="checkbox" id="apmOnly" style="width:auto;margin:0;"> Only items that belong to this product</label>' : '<div style="height:8px;"></div>'}
          <div id="apmList" style="max-height:170px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;"></div>
          <div id="apmHoloBox" style="display:none;margin-top:14px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:12px;font-weight:600;color:#334155;">2. Choose hologram number(s)</span><span id="apmHoloInfo" style="font-size:12px;color:#64748b;"></span></div>
            <input id="apmHoloQ" placeholder="Search hologram number..." style="${INP}">
            <div style="display:flex;gap:8px;margin:8px 0;"><button type="button" id="apmAll" style="padding:5px 10px;border:none;border-radius:6px;background:#e2e8f0;cursor:pointer;font-size:12px;">Select shown</button><button type="button" id="apmNone" style="padding:5px 10px;border:none;border-radius:6px;background:#e2e8f0;cursor:pointer;font-size:12px;">Clear</button></div>
            <div id="apmHolos" style="max-height:170px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:8px;display:flex;flex-wrap:wrap;gap:6px;"></div>
          </div>
          <div id="apmQtyBox" style="display:none;margin-top:14px;">
            <span style="font-size:12px;font-weight:600;color:#334155;">2. Quantity to give</span><small id="apmQtyInfo" style="margin-left:8px;color:#64748b;"></small>
            <input id="apmQty" type="number" min="1" value="1" style="${INP}margin-top:4px;">
            <div style="display:flex;justify-content:space-between;margin-top:12px;"><span style="font-size:12px;font-weight:600;color:#334155;">3. Hologram numbers <small style="font-weight:400;color:#94a3b8;">(optional — type or edit, one per line or comma separated)</small></span><span id="apmManualInfo" style="font-size:12px;color:#64748b;"></span></div>
            <textarea id="apmManual" rows="3" placeholder="e.g. HG-1001, HG-1002" style="${INP}margin-top:4px;font-family:inherit;"></textarea>
          </div>
          <div id="apmPicked" style="font-size:13px;color:#64748b;margin:10px 0 0;">Select an item to allocate.</div>
          <div style="display:flex;justify-content:space-between;margin-top:14px;">
            <button type="button" id="apmBack" style="padding:10px 16px;border-radius:8px;border:none;background:#e5e7eb;cursor:pointer;">${opts.service || requested || opts.pick ? 'Cancel' : 'Back'}</button>
            <button type="submit" id="apmSubmit" disabled style="padding:10px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;opacity:.5;">Allocate</button>
          </div>
        </form>`;
      const $ = id => body.querySelector('#' + id);
      $('apmBack').addEventListener('click', () => (opts.service || requested || opts.pick) ? close() : serviceStep());
      const listEl = $('apmList'), pickedEl = $('apmPicked'), submitEl = $('apmSubmit'), filterEl = $('apmQ'), onlyEl = $('apmOnly');
      const holoBox = $('apmHoloBox'), holoEl = $('apmHolos'), holoQ = $('apmHoloQ'), holoInfo = $('apmHoloInfo');
      const qtyBox = $('apmQtyBox'), qtyEl = $('apmQty'), qtyInfo = $('apmQtyInfo'), manualEl = $('apmManual'), manualInfo = $('apmManualInfo');
      let sel = null, holos = [], chosen = new Set();
      const cache = new Map();
      const byHolo = () => !!sel && sel.tagged > 0;
      const qtyVal = () => Math.max(0, Math.min(Math.floor(Number(qtyEl.value) || 0), sel ? sel.stock : 0));
      const manual = () => [...new Set(manualEl.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))];

      function summary() {
        const n = sel ? (byHolo() ? chosen.size : qtyVal()) : 0;
        holoInfo.textContent = `${chosen.size} selected / ${holos.length} available`;
        const m = manual().length;
        manualInfo.textContent = m ? `${m} number${m === 1 ? '' : 's'}${sel && m > qtyVal() ? ' — more than quantity' : ''}` : '';
        if (!sel) pickedEl.textContent = 'Select an item to allocate.';
        else pickedEl.innerHTML = `Giving <b>${n}</b> × <b>${esc(sel.name)}</b>${sel.model ? ' · ' + esc(sel.model) : ''}${byHolo() && n ? ' — ' + [...chosen].slice(0, 6).map(esc).join(', ') + (n > 6 ? ` +${n - 6} more` : '') : ''}`;
        submitEl.disabled = !n; submitEl.style.opacity = n ? '1' : '.5';
      }
      function drawHolos() {
        const t = holoQ.value.trim().toLowerCase();
        const rows = holos.filter(h => !t || h.no.toLowerCase().includes(t));
        holoEl.innerHTML = rows.length ? rows.map(h => `<label data-h="${esc(h.no)}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid ${chosen.has(h.no) ? '#2563eb' : '#e2e8f0'};background:${chosen.has(h.no) ? '#eff6ff' : '#fff'};"><input type="checkbox" ${chosen.has(h.no) ? 'checked' : ''} style="margin:0;width:auto;"> ${esc(h.no)}</label>`).join('')
          : `<span style="font-size:12px;color:#94a3b8;">${holos.length ? 'No hologram number matches.' : 'No hologram numbers on file for this item.'}</span>`;
        holoEl.querySelectorAll('label[data-h]').forEach(l => l.querySelector('input').addEventListener('change', e => {
          if (e.target.checked) chosen.add(l.dataset.h); else chosen.delete(l.dataset.h);
          drawHolos(); summary();
        }));
        holoEl._shown = rows;
      }
      async function pick(key) {
        sel = lotMap.get(key) || null; chosen = new Set(); holos = []; holoQ.value = ''; manualEl.value = '';
        drawLots(); holoBox.style.display = 'none'; qtyBox.style.display = 'none';
        if (!sel) return summary();
        if (!byHolo()) { qtyBox.style.display = 'block'; qtyEl.max = sel.stock; qtyEl.value = 1; qtyInfo.textContent = `${sel.stock} in stock`; return summary(); }
        holoBox.style.display = 'block';
        holoEl.innerHTML = '<span style="font-size:12px;color:#94a3b8;">Loading hologram numbers...</span>'; summary();
        if (!cache.has(key)) {
          const d = await fetchDetail(sel.doc);
          const arr = d ? (Array.isArray(d.hologram_numbers) ? d.hologram_numbers : (d.hologram_no ? [d.hologram_no] : [])) : [];
          cache.set(key, [...new Set(arr.map(h => String(h).trim()).filter(Boolean))].map(no => ({ no, lot_id: sel.doc._id || '' })));
        }
        if (!sel || sel.key !== key) return;
        const ex = new Set(opts.exclude || []);
        holos = cache.get(key).filter(h => !ex.has(h.no)); drawHolos(); summary();
      }
      function drawLots() {
        const t = filterEl.value.trim().toLowerCase(), only = onlyEl && onlyEl.checked;
        const rows = lots.filter(l => (!only || forSvc(l)) && (!t || [l.name, l.model, l.parent, l.product_id, LABELS[l.type]].join(' ').toLowerCase().includes(t)));
        listEl.innerHTML = rows.length ? rows.map(l => `<div class="apm-row" data-key="${esc(l.key)}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;${sel && sel.key === l.key ? 'background:#eff6ff;' : ''}">
            <div><strong style="font-size:13px;">${esc(l.name)}</strong>${l.model ? ` <small style="color:#64748b;">· ${esc(l.model)}</small>` : ''}<small style="color:#1665ff;"> · ${esc(LABELS[l.type])}</small>${l.parent ? `<br><small style="color:#94a3b8;">Belongs to: ${esc(l.parent)}</small>` : ''}</div>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;color:${l.tagged ? '#16a34a' : '#64748b'};">${l.tagged ? `${l.tagged} hologram${l.tagged === 1 ? '' : 's'}` : `Qty ${l.stock}`}</span></div>`).join('')
          : `<p style="padding:14px;color:#94a3b8;font-size:13px;">${lots.length ? 'No item matches.' : 'No spare parts, service parts or accessories in inventory.'}</p>`;
        listEl.querySelectorAll('.apm-row').forEach(r => r.addEventListener('click', () => pick(r.dataset.key)));
      }
      filterEl.addEventListener('input', drawLots);
      if (onlyEl) onlyEl.addEventListener('change', drawLots);
      holoQ.addEventListener('input', drawHolos);
      qtyEl.addEventListener('input', summary);
      manualEl.addEventListener('input', () => { const n = manual().length; if (n && sel) qtyEl.value = Math.min(n, sel.stock); summary(); });
      $('apmAll').addEventListener('click', () => { (holoEl._shown || []).forEach(h => chosen.add(h.no)); drawHolos(); summary(); });
      $('apmNone').addEventListener('click', () => { chosen.clear(); drawHolos(); summary(); });
      drawLots(); summary();

      if (requested) {   // pre-add the part the technician asked for
        const want = String(st.queue[0]).trim().toLowerCase();
        const hit = lots.find(l => l.name.trim().toLowerCase() === want) || lots.find(l => l.name.toLowerCase().includes(want) || want.includes(l.name.toLowerCase()));
        if (hit) { filterEl.value = hit.name; drawLots(); pick(hit.key); }
        else { filterEl.value = st.queue[0]; drawLots(); pickedEl.innerHTML = `<span style="color:#d62828;">"${esc(st.queue[0])}" was not found in stock — search and pick the closest item.</span>`; }
      }

      $('apmForm').addEventListener('submit', async e => {
        e.preventDefault();
        if (!sel) return alert('Select an item to allocate.');
        const withHolo = byHolo();
        const picked = withHolo ? holos.filter(h => chosen.has(h.no)) : [];
        const quantity = withHolo ? picked.length : qtyVal();
        if (!quantity) return alert(withHolo ? 'Select the hologram number(s) to give.' : 'Enter a valid quantity.');
        if (!withHolo && manual().length > quantity) return alert('You typed more hologram numbers than the quantity. Increase the quantity or remove some numbers.');
        if (opts.pick) {   // service form: just hand the choice back, it is allocated when the service is created
          close();
          return opts.onPick && opts.onPick({ part_name: sel.name, quantity, product_id: sel.product_id, model_no: sel.model, product_type: sel.type,
            lot_id: sel.doc._id || '', hologram_numbers: picked.map(h => h.no), holograms: picked.map(h => ({ hologram_number: h.no, lot_id: h.lot_id })),
            manual_holograms: withHolo ? [] : manual() });
        }
        submitEl.disabled = true; submitEl.textContent = 'Allocating...';
        const payload = { spare_part: {
          service_id: svc.service_id, part_name: sel.name, quantity, product_id: sel.product_id, model_no: sel.model, product_type: sel.type,
          lot_id: sel.doc._id || '', hologram_numbers: picked.map(h => h.no), holograms: picked.map(h => ({ hologram_number: h.no, lot_id: h.lot_id })),
          request_id: st.requestId || '', manual_holograms: withHolo ? [] : manual() } };
        try {
          const res = await apiFetch('/allocation/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'allocation failed');
          if (st.requestId && st.queue.length > 1) { st.queue.shift(); return partStep(); }   // next requested part
          close();
          if (typeof opts.onDone === 'function') opts.onDone(data);
        } catch (err) {
          submitEl.disabled = false; submitEl.textContent = 'Allocate';
          if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
        }
      });
    }

    if ((st.service && st.service.service_id) || opts.pick) partStep(); else serviceStep();
  };
})();