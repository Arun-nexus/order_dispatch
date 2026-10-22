/* =====================================================================
   pms_report.js  -  PMS Report (ISO 13485:2016) for the QC page
   Button "PMS Report" -> pick products + period -> editable, printable
   A4 report in the ACER_PMS_FORMAT layout.

   Not auto-filled (kept as blank editable columns): Device Class,
   Installation Failures, CAPA, Adverse Events, Recalls, Notifications.
   Needs globals from qc.js (QC) and qc_forms.js (qcPrintWindow).
   ===================================================================== */
(function () {
    const LOGO = 'data:image/png;base64,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';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pad = n => String(n).padStart(2, '0');
    const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
    const MIN_ROWS = 9;                       // the blank format has 9 data rows
    const PLAIN = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();

    // ---------------------------------------------------------------- data
    const NOT_PRODUCT = ['spare_parts', 'service_parts', 'damaged'];
    const keyOf = (pid, model) => `${pid}|${model || ''}`;
    const sameProduct = (p, pid, model) => String(pid || '') === p.pid && (!p.model || !model || String(model) === p.model);

    function listProducts() {
        const map = new Map();
        (QC.rows || []).filter(r => r.type === 'inventory').forEach(r => {
            const d = r.data || {};
            if (!d.product_id || NOT_PRODUCT.includes(d.product_type)) return;
            const k = keyOf(d.product_id, d.model_no);
            const p = map.get(k) || { key: k, pid: String(d.product_id), model: d.model_no || '', name: d.product_name || String(d.product_id), stock: 0 };
            p.stock += Number(d.quantity) || 0;
            map.set(k, p);
        });
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    function yearLabel(from, to) {
        const a = from.getFullYear(), b = to.getFullYear();
        return a === b ? String(a) : `${a}-${String(b).slice(2)}`;
    }

    // standard warranty = 1 year from purchase unless the service carries its own warranty_until
    function inWarranty(s, when) {
        if (s.warranty_until) { const e = toDate(s.warranty_until); if (e) { e.setHours(23, 59, 59, 999); return when <= e; } }
        const pd = toDate(s.purchase_date);
        if (!pd) return false;
        pd.setFullYear(pd.getFullYear() + 1);
        return when <= pd;
    }

    function buildRows(products, from, to) {
        const t0 = new Date(`${from}T00:00:00`), t1 = new Date(`${to}T23:59:59`);
        const inRange = d => d && d >= t0 && d <= t1;
        const orders = (QC.rows || []).filter(r => r.type === 'order').map(r => r.data)
            .filter(o => !/cancel|reject/i.test(o.status || '') && inRange(toDate(o.order_date)));
        const services = (QC.rows || []).filter(r => r.type === 'service').map(r => r.data)
            .map(s => ({ s, at: toDate(s.created_at || s.purchase_date) })).filter(x => inRange(x.at));
        const year = yearLabel(t0, t1);
        return products.map(p => {
            let units = 0;
            orders.forEach(o => (o.items || []).forEach(i => { if (sameProduct(p, i.product_id, i.model_no)) units += Number(i.quantity) || 0; }));
            const svc = services.filter(x => sameProduct(p, x.s.product_id, x.s.model_no)).sort((a, b) => a.at - b.at);
            return {
                year,
                name: p.name + (p.model ? ` (${p.model})` : ''),
                units: String(units),
                calls: String(svc.length),
                dates: svc.map(x => fmtDate(x.at)).join(', '),
                warr: String(svc.filter(x => inWarranty(x.s, x.at)).length),
                cls: '', inst: '', capa: '', adv: 'NA', rec: 'NA', notif: 'NA'   // Adverse Events / Recalls / Notifications default to NA; others stay blank
            };
        });
    }

    function blankRow() { return { year: '', name: '', cls: '', units: '', calls: '', dates: '', inst: '', warr: '', capa: '', adv: '', rec: '', notif: '' }; }
    function padRows(rows) { while (rows.length < MIN_ROWS) rows.push(blankRow()); return rows; }
    function defaultHdr() {
        return { country: 'India', date: fmtDate(new Date()), formno: 'ABM', issue: '', rev: '00', d1: '', d2: '', page: '1 of 1', rev_by: 'HOD', app_by: 'Director' };
    }

    // ---------------------------------------------------------------- sheet html
    const SHEET_CSS = `
    .pms{width:277mm;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:9.5pt;box-sizing:border-box}
    .pms *{box-sizing:border-box}
    .pms table{width:100%;border-collapse:collapse;table-layout:fixed;border:2px solid #000}
    .pms td,.pms th{border:1.2px solid #000;padding:1.2mm 1.2mm;vertical-align:middle;word-break:break-word;overflow-wrap:anywhere;line-height:1.2}
    .pms th{font-weight:700;text-align:center;background:#f1f5f9;font-size:8.5pt}
    .pms td.ctr{text-align:center}
    .pms .b{font-weight:700}
    .pms .ttl{font-size:13pt;font-weight:700;text-align:center}
    .pms tr.dr td{height:11mm}
    .pms .sp td{height:5mm;padding:0}
    .pms img.lg{height:15mm;display:block}
    .pms .v{outline:none;white-space:pre-wrap;min-height:1.2em;display:block}
    .pms .v[data-h]{display:inline-block;min-width:14mm}
    .pms .del{display:none}`;
    const EDIT_CSS = `
    .pmsx-ovl{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:3000;overflow:auto;padding:0 0 30px}
    .pmsx-bar{position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .pmsx-bar b{font-size:15px}
    .pmsx-bar .hint{font-size:12px;color:#64748b;flex:1;min-width:220px}
    .pmsx-bar button{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
    .pmsx-bar .pr{background:#1665ff;color:#fff}.pmsx-bar .ad{background:#e0f2fe;color:#075985}.pmsx-bar .rs{background:#eef1f6;color:#334155}.pmsx-bar .cl{background:#fee2e2;color:#b91c1c}
    .pmsx-wrap{display:flex;justify-content:flex-start;padding:18px 10px;overflow-x:auto}
    .pmsx-wrap .pms{box-shadow:0 4px 24px rgba(0,0,0,.35);margin:0 auto;flex:none}
    .pmsx-wrap .pms .v{background:rgba(255,236,150,.28)}
    .pmsx-wrap .pms .v:hover,.pmsx-wrap .pms .v:focus{background:rgba(255,236,150,.75)}
    .pmsx-wrap .pms td{position:relative}
    .pmsx-wrap .pms .del{display:block;position:absolute;left:-1px;top:-1px;width:16px;height:16px;line-height:14px;text-align:center;font-size:13px;background:#fee2e2;color:#b91c1c;border-radius:0 0 6px 0;cursor:pointer;opacity:0}
    .pmsx-wrap .pms tr:hover .del{opacity:1}
    .pmsx-pick{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:center;z-index:2900;padding:8px}
    .pmsx-pick .box{background:#fff;border-radius:16px;padding:22px 24px;width:min(620px,100%);max-height:90vh;display:flex;flex-direction:column;font-family:Arial,sans-serif}
    .pmsx-pick .list{flex:1;overflow-y:auto;border:1px solid #e2e8f0;border-radius:10px;margin:10px 0;min-height:120px}
    .pmsx-pick label.it{display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:13.5px}
    .pmsx-pick label.it:hover{background:#f8fafc}
    .pmsx-pick label.it small{color:#94a3b8;margin-left:auto;white-space:nowrap}
    .pmsx-pick input[type=text],.pmsx-pick input[type=date]{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px}`;

    function sheetHtml(st, editable) {
        const ce = editable ? ` contenteditable="${PLAIN}"` : '';
        const hv = k => `<span class="v"${ce} data-h="${k}">${esc(st.hdr[k])}</span>`;
        const cell = (r, c, cls) => `<td${cls ? ` class="${cls}"` : ''}>${editable && c === 'year' ? `<span class="del" data-del="${r}" title="Remove this row">&times;</span>` : ''}<span class="v"${ce} data-r="${r}" data-c="${c}">${esc(st.rows[r][c])}</span></td>`;
        const body = st.rows.map((row, r) => `<tr class="dr">${cell(r, 'year', 'ctr')}${cell(r, 'name')}${cell(r, 'cls', 'ctr')}${cell(r, 'units', 'ctr')}${cell(r, 'calls', 'ctr')}${cell(r, 'dates')}${cell(r, 'inst', 'ctr')}${cell(r, 'warr', 'ctr')}${cell(r, 'capa')}${cell(r, 'adv')}${cell(r, 'rec')}${cell(r, 'notif')}</tr>`).join('');
        return `<div class="pms"><table>
      <colgroup>${[7, 14, 7, 8, 8, 13, 8, 8, 8, 6, 6, 7].map(w => `<col style="width:${w}%">`).join('')}</colgroup>
      <tr><td colspan="4"><img class="lg" src="${LOGO}" alt="Acer Biomedical"></td><td colspan="4" class="ttl">Form Format<br>ISO 13485:2016</td><td colspan="4" class="ttl">Title: PMS Report</td></tr>
      <tr><td colspan="2" class="b">Country</td><td colspan="5">${hv('country')}</td><td colspan="3" class="b">Date of Report</td><td colspan="2">${hv('date')}</td></tr>
      <tr class="sp"><td colspan="12"></td></tr>
      <tr><th>Year of sale</th><th>DEVICE NAME</th><th>DEVICE CLASS</th><th>Number of Units sold</th><th>Total service calls</th><th>Service call date</th><th>Installation Failures</th><th>In Warranty Service calls</th><th>CAPA undertaken</th><th>Adverse Events</th><th>Recalls</th><th>Notifications</th></tr>
      ${body}
      <tr class="sp"><td colspan="12"></td></tr>
      <tr><td colspan="3" rowspan="2"><span class="b">Form Format No</span>: ${hv('formno')}</td><td colspan="3"><span class="b">Issue No.</span> : ${hv('issue')}</td><td colspan="4"><span class="b">Rev. No.</span>: ${hv('rev')}</td><td colspan="2" rowspan="2" class="ctr">Page ${hv('page')}</td></tr>
      <tr><td colspan="3"><span class="b">Date</span>: ${hv('d1')}</td><td colspan="4"><span class="b">Date</span>: ${hv('d2')}</td></tr>
      <tr><td colspan="4"><span class="b">Reviewed by: </span>${hv('rev_by')}</td><td colspan="8"><span class="b">Approved by: </span>${hv('app_by')}</td></tr>
    </table></div>`;
    }

    // ---------------------------------------------------------------- report window
    function openReport(products, from, to) {
        document.getElementById('pmsxReport')?.remove();
        if (!document.getElementById('pmsxStyles')) {
            const s = document.createElement('style');
            s.id = 'pmsxStyles';
            s.textContent = SHEET_CSS + EDIT_CSS;
            document.head.appendChild(s);
        }
        const storeKey = 'pms1:' + products.map(p => p.key).sort().join('~') + '#' + from + '#' + to;
        const fresh = () => ({ hdr: defaultHdr(), rows: padRows(buildRows(products, from, to)) });
        let st = fresh();
        try {
            const sv = JSON.parse(localStorage.getItem(storeKey) || 'null');
            if (sv && sv.hdr && Array.isArray(sv.rows)) st = { hdr: { ...st.hdr, ...sv.hdr }, rows: sv.rows.map(r => ({ ...blankRow(), ...r })) };
        } catch (e) { /* ignore broken saved copy */ }

        const ovl = document.createElement('div');
        ovl.id = 'pmsxReport';
        ovl.className = 'pmsx-ovl';
        ovl.innerHTML = `
      <div class="pmsx-bar">
        <b><i class="fa-solid fa-file-medical"></i> PMS Report</b>
        <span class="hint">Yellow fields are editable. Period: ${esc(fmtDate(new Date(from)))} to ${esc(fmtDate(new Date(to)))}. Changes stay saved on this computer.</span>
        <button class="ad"><i class="fa-solid fa-plus"></i> Add row</button>
        <button class="pr"><i class="fa-solid fa-print"></i> Print (A4)</button>
        <button class="rs"><i class="fa-solid fa-rotate-left"></i> Reset to system data</button>
        <button class="cl">Close</button>
      </div>
      <div class="pmsx-wrap"></div>`;
        document.body.appendChild(ovl);
        const wrap = ovl.querySelector('.pmsx-wrap');
        const render = () => { wrap.innerHTML = sheetHtml(st, true); };
        const persist = () => { try { localStorage.setItem(storeKey, JSON.stringify(st)); } catch (e) { /* storage blocked */ } };
        render();

        wrap.addEventListener('input', e => {
            const el = e.target.closest('[data-h],[data-c]');
            if (!el) return;
            const text = el.innerText.replace(/\n$/, '');
            if (el.dataset.h) st.hdr[el.dataset.h] = text;
            else st.rows[Number(el.dataset.r)][el.dataset.c] = text;
            persist();
        });
        wrap.addEventListener('paste', e => {
            if (!e.target.closest('[data-h],[data-c]')) return;
            e.preventDefault();
            document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text'));
        });
        wrap.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey && e.target.closest('[data-h]')) e.preventDefault();
        });
        wrap.addEventListener('click', e => {
            const d = e.target.closest('[data-del]');
            if (!d) return;
            st.rows.splice(Number(d.dataset.del), 1);
            if (st.rows.length < 1) st.rows.push(blankRow());
            persist(); render();
        });

        const close = () => { ovl.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        ovl.querySelector('.cl').addEventListener('click', close);
        ovl.querySelector('.ad').addEventListener('click', () => { st.rows.push(blankRow()); persist(); render(); });
        ovl.querySelector('.rs').addEventListener('click', () => {
            if (!confirm('Are You sure you wanna to restore all the entries to Default')) return;
            try { localStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
            st = fresh(); render();
        });
        ovl.querySelector('.pr').addEventListener('click', () => {
            if (typeof qcPrintWindow !== 'function') { alert('Print is not available.'); return; }
            qcPrintWindow(`<style>${SHEET_CSS}.pms{width:100%}</style>${sheetHtml(st, false)}`, 'PMS Report', true);
        });
    }

    // ---------------------------------------------------------------- product picker
    function openPicker() {
        if (typeof QC === 'undefined' || !QC.rows || !QC.rows.length) { alert('QC data is still loading. Please try again in a moment.'); return; }
        const products = listProducts();
        if (!products.length) { alert('No products found in inventory.'); return; }
        if (!document.getElementById('pmsxStyles')) {
            const s = document.createElement('style');
            s.id = 'pmsxStyles';
            s.textContent = SHEET_CSS + EDIT_CSS;
            document.head.appendChild(s);
        }
        document.getElementById('pmsxPick')?.remove();
        const today = new Date(), start = new Date(); start.setFullYear(start.getFullYear() - 1);
        const m = document.createElement('div');
        m.id = 'pmsxPick';
        m.className = 'pmsx-pick';
        m.innerHTML = `<div class="box">
      <div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="margin:0;">PMS Report &ndash; select products</h3><button type="button" class="x" style="border:none;background:none;font-size:24px;cursor:pointer;">&times;</button></div>
      <div style="font-size:12px;color:#94a3b8;margin:4px 0 10px;">Products from inventory. Orders and services of the period below are counted for each selected product.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input type="text" class="q" placeholder="Search product..." style="flex:1;min-width:160px;">
        <label style="font-size:12px;color:#64748b;">From <input type="date" class="from" value="${isoDay(start)}"></label>
        <label style="font-size:12px;color:#64748b;">To <input type="date" class="to" value="${isoDay(today)}"></label>
      </div>
      <div class="list">${products.map((p, i) => `<label class="it" data-n="${esc((p.name + ' ' + p.model).toLowerCase())}"><input type="checkbox" value="${i}"><span>${esc(p.name)}${p.model ? ' <span style="color:#64748b;">(' + esc(p.model) + ')</span>' : ''}</span><small>Stock: ${p.stock}</small></label>`).join('')}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="display:flex;gap:8px;align-items:center;"><button type="button" class="all" style="padding:8px 12px;border:none;border-radius:8px;background:#eef1f6;cursor:pointer;">Select all</button><span class="cnt" style="font-size:12px;color:#64748b;">0 selected</span></div>
        <button type="button" class="go" style="padding:9px 18px;border:none;border-radius:8px;background:#1665ff;color:#fff;cursor:pointer;font-weight:600;"><i class="fa-solid fa-file-medical"></i> Generate report</button>
      </div></div>`;
        document.body.appendChild(m);
        const boxes = () => [...m.querySelectorAll('input[type=checkbox]')];
        const visible = () => boxes().filter(b => b.closest('label').style.display !== 'none');
        const count = () => { m.querySelector('.cnt').textContent = `${boxes().filter(b => b.checked).length} selected`; };
        m.addEventListener('change', e => { if (e.target.type === 'checkbox') count(); });
        m.querySelector('.q').addEventListener('input', e => {
            const q = e.target.value.trim().toLowerCase();
            m.querySelectorAll('label.it').forEach(l => { l.style.display = !q || l.dataset.n.includes(q) ? '' : 'none'; });
        });
        m.querySelector('.all').addEventListener('click', () => {
            const v = visible(), on = v.some(b => !b.checked);
            v.forEach(b => { b.checked = on; });
            count();
        });
        const close = () => m.remove();
        m.querySelector('.x').addEventListener('click', close);
        m.addEventListener('mousedown', e => { if (e.target === m) close(); });
        m.querySelector('.go').addEventListener('click', () => {
            const picked = boxes().filter(b => b.checked).map(b => products[Number(b.value)]);
            const from = m.querySelector('.from').value, to = m.querySelector('.to').value;
            if (!picked.length) { alert('Select at least one product.'); return; }
            if (!from || !to || from > to) { alert('Choose a valid period (From must be before To).'); return; }
            close();
            openReport(picked, from, to);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        const b = document.getElementById('qcPms');
        if (b) b.addEventListener('click', openPicker);
    });
})();