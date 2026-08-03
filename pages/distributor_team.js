const teamState = { team: [], allocations: [], orders: [] };

document.addEventListener('DOMContentLoaded', () => {
  loadTeamPage();
});

function isThisMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function orderAmount(o) {
  const subtotal = (o.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  return Math.max(0, subtotal - (Number(o.discount) || 0));
}

async function loadTeamPage() {
  try {
    const [teamRes, allocRes, orderRes] = await Promise.all([
      apiFetch('/account/my_team'),
      apiFetch('/allocation/team'),
      apiFetch('/order/')
    ]);
    if (!teamRes.ok) throw new Error('failed to fetch team');
    const teamData = await teamRes.json();
    const allocData = allocRes.ok ? await allocRes.json() : { dataset: [] };
    const orderData = orderRes.ok ? await orderRes.json() : { dataset: [] };

    teamState.team = teamData.dataset || [];
    teamState.allocations = allocData.dataset || [];

    const teamUsernames = new Set(teamState.team.map(m => m.username));
    teamState.orders = (orderData.dataset || []).filter(o => teamUsernames.has(o.creator?.raised_by));

    renderTeamCards();
    renderTeamTable();
  } catch (err) {
    console.error(err);
    if (err.message !== 'unauthorized' && err.message !== 'forbidden') alert('Could not load your team.');
  }
}

function memberAllocations(username) {
  return teamState.allocations.filter(a => a.allocated_by === username);
}

function memberLabel(username) {
  const m = teamState.team.find(x => x.username === username);
  return m ? (m.name ?? m.username) : username;
}

function renderTeamCards() {
  document.getElementById('cardTeamCount').textContent = teamState.team.length;
  document.getElementById('cardTeamAllotted').textContent = teamState.allocations.length;
  document.getElementById('cardTeamHeld').textContent = teamState.allocations.filter(a => a.return_status !== 'returned').length;
  renderOrderExtremesCards();
}

function renderOrderExtremesCards() {
  const monthOrders = teamState.orders.filter(o => isThisMonth(o.created_at));

  const totalsByPerson = {};
  monthOrders.forEach(o => {
    const username = o.creator?.raised_by;
    if (!username) return;
    totalsByPerson[username] = (totalsByPerson[username] || 0) + orderAmount(o);
  });

  const entries = Object.entries(totalsByPerson);
  const highAmountEl = document.getElementById('cardHighestOrderAmount');
  const highNameEl = document.getElementById('cardHighestOrderName');
  const lowAmountEl = document.getElementById('cardLowestOrderAmount');
  const lowNameEl = document.getElementById('cardLowestOrderName');

  if (!entries.length) {
    highAmountEl.textContent = '₹0';
    highNameEl.textContent = 'No orders this month';
    lowAmountEl.textContent = '₹0';
    lowNameEl.textContent = 'No orders this month';
    return;
  }

  entries.sort((a, b) => b[1] - a[1]);
  const [highUsername, highTotal] = entries[0];
  const [lowUsername, lowTotal] = entries[entries.length - 1];

  highAmountEl.textContent = `₹${highTotal.toFixed(2)}`;
  highNameEl.textContent = memberLabel(highUsername);
  lowAmountEl.textContent = `₹${lowTotal.toFixed(2)}`;
  lowNameEl.textContent = memberLabel(lowUsername);
}

function renderTeamTable() {
  const tbody = document.getElementById('teamTbody');
  if (!tbody) return;

  if (!teamState.team.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;">No team members reporting to you yet.</td></tr>';
    return;
  }

  tbody.innerHTML = teamState.team.map(member => {
    const allocs = memberAllocations(member.username);
    const held = allocs.filter(a => a.return_status !== 'returned').length;
    return `
      <tr>
        <td>${member.name ?? member.username}</td>
        <td>${member.username ?? ''}</td>
        <td>${member.company_name ?? '-'}</td>
        <td>${member.mobile_no ?? member.phone ?? '-'}</td>
        <td>${member.email ?? '-'}</td>
        <td>${allocs.length}</td>
        <td>${held}</td>
      </tr>`;
  }).join('');
}