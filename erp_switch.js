(function () {
  const ERP_SYSTEMS = [
    { name: 'Acer Biomedical', url: 'https://acerbiomedical.in/main_dashboard.html' },
    { name: 'Accure ', url: 'https://accureai.com/main_dashboard.html' },
    { name: 'Endolax', url: 'https://endolax.online/main_dashboard.html' }
  ];

  const css = `
    .erp-switch{display:flex;gap:6px;align-items:center;margin-right:12px}
    .erp-btn{padding:7px 12px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#334155;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
    .erp-btn:hover{background:#f1f5f9}
    .erp-btn.active{background:#1665ff;border-color:#1665ff;color:#fff;pointer-events:none}
    @media(max-width:900px){.erp-switch{flex-wrap:wrap;margin-right:6px}.erp-btn{padding:5px 8px;font-size:12px}}`;

  function init() {
    if (typeof getRole !== 'function' || getRole() !== 'admin') return;
    const right = document.querySelector('.topbar .right');
    if (!right) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.className = 'erp-switch';
    box.innerHTML = ERP_SYSTEMS.map(s => {
      const active = location.hostname === new URL(s.url).hostname;
      return `<a class="erp-btn${active ? ' active' : ''}" href="${s.url}">${s.name}</a>`; 0
    }).join('');
    right.insertBefore(box, right.firstChild);
  }

  document.addEventListener('DOMContentLoaded', init);
})();