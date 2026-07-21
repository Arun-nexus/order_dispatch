document.getElementById('loginform').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const roleSelect = document.getElementById('usertype');
  const role = roleSelect.value.trim().toLowerCase(); // backend enum is lowercase

  if (!username || !password || !role) {
    alert('Please fill username, password and user type.');
    return;
  }

  const btn = document.querySelector('.login-button');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Signing in...';

  try {
    const res = await fetch('/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || 'login failed');
    }

    // Persist session info so other pages know who's logged in.
    sessionStorage.setItem('abm_username', username);
    sessionStorage.setItem('abm_role', data.role);

    window.location.href = 'index.html';

  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// Toggle password visibility
const toggleIcon = document.querySelector('.togglePassword');
if (toggleIcon) {
  toggleIcon.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    const isHidden = pwd.type === 'password';
    pwd.type = isHidden ? 'text' : 'password';
    toggleIcon.classList.toggle('fa-eye');
    toggleIcon.classList.toggle('fa-eye-slash');
  });
}
