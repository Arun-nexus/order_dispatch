const attState = { mode: 'daily', date: todayStr(), month: monthStr(), rows: [], lateThreshold: '10:00' };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('dateInput').value = attState.date;
  document.getElementById('monthInput').value = attState.month;
  document.getElementById('cardDateLabel').textContent = attState.date;

  wireViewModeToggle();
  wireUploadModal();
  wireLateTimeModal();
  wireContactsModal();

  document.getElementById('applyFilterBtn').addEventListener('click', () => {
    attState.date = document.getElementById('dateInput').value || todayStr();
    attState.month = document.getElementById('monthInput').value || monthStr();
    loadAttendance();
  });

  loadLateThreshold();
  loadAttendance();
});

function wireViewModeToggle() {
  const select = document.getElementById('viewModeSelect');
  select.addEventListener('change', () => {
    attState.mode = select.value;
    document.getElementById('dateFilterBox').style.display = attState.mode === 'daily' ? 'flex' : 'none';
    document.getElementById('monthFilterBox').style.display = attState.mode === 'monthly' ? 'flex' : 'none';
    loadAttendance();
  });
}

async function loadLateThreshold() {
  try {
    const res = await apiFetch('/attendance/late_threshold');
    const data = await res.json();
    attState.lateThreshold = data.late_time || '10:00';
    document.getElementById('cardLateThreshold').textContent = attState.lateThreshold;
    document.getElementById('lateTimeInput').value = attState.lateThreshold;
  } catch (err) { console.error(err); }
}

async function loadAttendance() {
  try {
    const url = attState.mode === 'daily'
      ? `/attendance/?date=${encodeURIComponent(attState.date)}`
      : `/attendance/?month=${encodeURIComponent(attState.month)}`;
    const res = await apiFetch(url);
    const data = await res.json();
    attState.rows = data.dataset || [];
    if (attState.mode === 'daily') renderDailyView(); else renderMonthlyView();
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') console.error(err);
  }
}

function renderDailyView() {
  document.getElementById('cardDateLabel').textContent = attState.date;
  document.getElementById('cardMonthLabel').textContent = 'This month\'s report';

  const present = attState.rows.length;
  const late = attState.rows.filter(r => r.is_late).length;
  const reminders = attState.rows.filter(r => r.is_late && r.reminder_sent).length;
  document.getElementById('cardPresentToday').textContent = present;
  document.getElementById('cardLateToday').textContent = late;
  document.getElementById('cardRemindersToday').textContent = reminders;

  document.getElementById('attendanceThead').innerHTML = `
    <tr>
      <th>Employee Name</th><th>Emp Code</th><th>Department</th><th>Branch</th>
      <th>In-Time</th><th>Out-Time</th><th>Status</th><th>Late?</th><th>Reminder</th>
    </tr>`;

  const sorted = [...attState.rows].sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));
  document.getElementById('attendanceTbody').innerHTML = sorted.length ? sorted.map(r => `
    <tr>
      <td>${r.employee_name ?? ''}</td>
      <td>${r.emp_code ?? ''}</td>
      <td>${r.department ?? '-'}</td>
      <td>${r.branch ?? '-'}</td>
      <td>${r.in_time || '-'}</td>
      <td>${r.out_time || '-'}</td>
      <td>${r.status ?? ''}</td>
      <td>${r.is_late ? '<span class="status cancelled">Late</span>' : '<span class="status delivered">On time</span>'}</td>
      <td>${r.is_late ? (r.reminder_sent ? '<span class="status delivered">Sent</span>' : '<span class="status pending">Not sent</span>') : '-'}</td>
    </tr>`).join('') : '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px;">No attendance uploaded for this date yet.</td></tr>';
}

function renderMonthlyView() {
  document.getElementById('cardDateLabel').textContent = attState.month;
  document.getElementById('cardMonthLabel').textContent = `Report for ${attState.month}`;

  const byEmp = {};
  attState.rows.forEach(r => {
    const key = r.emp_code || r.employee_name;
    if (!byEmp[key]) byEmp[key] = { employee_name: r.employee_name, emp_code: r.emp_code, department: r.department, present: 0, late: 0 };
    byEmp[key].present += 1;
    if (r.is_late) byEmp[key].late += 1;
  });
  const summary = Object.values(byEmp).sort((a, b) => b.late - a.late);

  const today = attState.rows.filter(r => r.date === todayStr());
  document.getElementById('cardPresentToday').textContent = today.length;
  document.getElementById('cardLateToday').textContent = today.filter(r => r.is_late).length;
  document.getElementById('cardRemindersToday').textContent = today.filter(r => r.is_late && r.reminder_sent).length;

  document.getElementById('attendanceThead').innerHTML = `
    <tr>
      <th>Employee Name</th><th>Emp Code</th><th>Department</th>
      <th>Present Days</th><th>Late Count (this month)</th>
    </tr>`;

  document.getElementById('attendanceTbody').innerHTML = summary.length ? summary.map(s => `
    <tr>
      <td>${s.employee_name ?? ''}</td>
      <td>${s.emp_code ?? ''}</td>
      <td>${s.department ?? '-'}</td>
      <td>${s.present}</td>
      <td>${s.late > 0 ? `<span class="status cancelled">${s.late}</span>` : '0'}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px;">No attendance uploaded for this month yet.</td></tr>';
}

// ---------- Upload ----------
function wireUploadModal() {
  const modal = document.getElementById('uploadAttendanceModal');
  document.getElementById('uploadAttendanceBtn').addEventListener('click', () => {
    document.getElementById('attendanceUploadResult').textContent = '';
    document.getElementById('attendanceFileInput').value = '';
    modal.style.display = 'flex';
  });
  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');

  document.getElementById('attendanceUploadSubmitBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('attendanceFileInput');
    const resultBox = document.getElementById('attendanceUploadResult');
    if (!fileInput.files.length) { resultBox.textContent = 'Choose a file first.'; return; }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    resultBox.textContent = 'Uploading...';
    try {
      const res = await apiFetch('/attendance/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'upload failed');
      let msg = `Saved ${data.records_saved} record(s) for ${data.date}.`;
      if (data.late_reminders_sent?.length) msg += ` WhatsApp reminder sent to: ${data.late_reminders_sent.join(', ')}.`;
      if (data.late_without_contact?.length) msg += ` Late but no WhatsApp number saved: ${data.late_without_contact.join(', ')}.`;
      resultBox.textContent = msg;
      attState.date = data.date;
      document.getElementById('dateInput').value = data.date;
      attState.mode = 'daily';
      document.getElementById('viewModeSelect').value = 'daily';
      document.getElementById('dateFilterBox').style.display = 'flex';
      document.getElementById('monthFilterBox').style.display = 'none';
      await loadAttendance();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') resultBox.textContent = err.message;
    }
  });
}

// ---------- Late time ----------
function wireLateTimeModal() {
  const modal = document.getElementById('lateTimeModal');
  document.getElementById('setLateTimeBtn').addEventListener('click', () => modal.style.display = 'flex');
  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');

  document.getElementById('lateTimeSaveBtn').addEventListener('click', async () => {
    const value = document.getElementById('lateTimeInput').value;
    if (!value) return;
    try {
      const res = await apiFetch('/attendance/late_threshold', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ late_time: value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'could not save');
      attState.lateThreshold = data.late_time;
      document.getElementById('cardLateThreshold').textContent = data.late_time;
      modal.style.display = 'none';
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

// ---------- WhatsApp contacts ----------
function wireContactsModal() {
  const modal = document.getElementById('contactsModal');
  document.getElementById('manageContactsBtn').addEventListener('click', () => { modal.style.display = 'flex'; loadContacts(); });
  modal.querySelector('.close').addEventListener('click', () => modal.style.display = 'none');

  document.getElementById('contactSaveBtn').addEventListener('click', async () => {
    const emp_code = document.getElementById('contactEmpCode').value.trim();
    const employee_name = document.getElementById('contactEmpName').value.trim();
    const phone_number = document.getElementById('contactPhone').value.trim();
    if (!emp_code || !phone_number) { alert('Emp Code and phone number are required.'); return; }
    try {
      const res = await apiFetch('/attendance/contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emp_code, employee_name, phone_number })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'could not save contact');
      document.getElementById('contactEmpCode').value = '';
      document.getElementById('contactEmpName').value = '';
      document.getElementById('contactPhone').value = '';
      await loadContacts();
    } catch (err) {
      if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert(err.message);
    }
  });
}

async function loadContacts() {
  const list = document.getElementById('contactsList');
  list.innerHTML = '<p style="color:#94a3b8;font-size:13px;">Loading...</p>';
  try {
    const res = await apiFetch('/attendance/contacts');
    const data = await res.json();
    const contacts = (data.dataset || []).sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));
    list.innerHTML = contacts.length ? contacts.map(c => `
      <div style="display:flex;justify-content:space-between;border-bottom:1px solid #eef1f6;padding:8px 4px;font-size:13px;">
        <span>${c.employee_name || '-'} <small style="color:#94a3b8;">(${c.emp_code})</small></span>
        <strong>${c.phone_number}</strong>
      </div>`).join('') : '<p style="color:#94a3b8;font-size:13px;">No contacts saved yet.</p>';
  } catch (err) {
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') list.innerHTML = `<p style="color:#d62828;font-size:13px;">${err.message}</p>`;
  }
}