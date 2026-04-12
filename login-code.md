# Login Code

## public/index.html (full sign-in page)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Investor Questionnaire</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<div class="auth-wrap">
  <div class="auth-box">
    <div style="margin-bottom:32px;">
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:8px;">Accredited Investor Portal</p>
      <h1 id="form-title">Sign in</h1>
    </div>

    <div class="card">
      <div id="alert-box" style="display:none;"></div>

      <!-- Login form -->
      <form id="login-form">
        <div class="field">
          <label class="label" for="l-email">Email</label>
          <input type="email" id="l-email" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div class="field">
          <label class="label" for="l-password">Password</label>
          <input type="password" id="l-password" placeholder="••••••••" autocomplete="current-password" required>
        </div>
        <div class="btn-row" style="margin-top:20px;">
          <button type="submit" class="btn btn-primary" style="width:100%;">Sign in</button>
        </div>
        <p style="margin-top:16px;text-align:center;">
          <a href="#" id="go-register" style="font-size:13px;color:var(--text-muted);text-decoration:none;">Create an account →</a>
        </p>
      </form>

      <!-- Register form -->
      <form id="register-form" style="display:none;">
        <div class="field">
          <label class="label" for="r-name">Full Name</label>
          <input type="text" id="r-name" placeholder="Jane Smith" required>
        </div>
        <div class="field">
          <label class="label" for="r-email">Email</label>
          <input type="email" id="r-email" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div class="field">
          <label class="label" for="r-password">Password</label>
          <input type="password" id="r-password" placeholder="••••••••" autocomplete="new-password" required>
        </div>
        <div class="btn-row" style="margin-top:20px;">
          <button type="submit" class="btn btn-primary" style="width:100%;">Create account</button>
        </div>
        <p style="margin-top:16px;text-align:center;">
          <a href="#" id="go-login" style="font-size:13px;color:var(--text-muted);text-decoration:none;">← Back to sign in</a>
        </p>
      </form>
    </div>
  </div>
</div>

<script>
  const alertBox = document.getElementById('alert-box');
  function showAlert(msg, type='error') {
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = msg;
    alertBox.style.display = 'block';
  }

  document.getElementById('go-register').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    document.getElementById('form-title').textContent = 'Create account';
    alertBox.style.display = 'none';
  });
  document.getElementById('go-login').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('form-title').textContent = 'Sign in';
    alertBox.style.display = 'none';
  });

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    alertBox.style.display = 'none';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ email: document.getElementById('l-email').value, password: document.getElementById('l-password').value })
      });
      const data = await res.json();
      if (!res.ok) { showAlert(data.error); btn.disabled=false; btn.textContent='Sign in'; return; }
      window.location.href = '/dashboard.html';
    } catch { showAlert('Network error'); btn.disabled=false; btn.textContent='Sign in'; }
  });

  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    alertBox.style.display = 'none';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/register', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ full_name: document.getElementById('r-name').value, email: document.getElementById('r-email').value, password: document.getElementById('r-password').value })
      });
      const data = await res.json();
      if (!res.ok) { showAlert(data.error); btn.disabled=false; btn.textContent='Create account'; return; }
      window.location.href = '/dashboard.html';
    } catch { showAlert('Network error'); btn.disabled=false; btn.textContent='Create account'; }
  });
</script>
</body>
</html>
```

## server.js — Auth routes & middleware

```js
const session = require('express-session');
const bcrypt = require('bcryptjs');

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'iq-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 }
}));

// Auth guard
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password || !full_name) return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)').run(id, email.toLowerCase(), hash, full_name);
    req.session.userId = id;
    req.session.userEmail = email;
    req.session.userName = full_name;
    res.json({ ok: true, user: { id, email, full_name } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.userName = user.full_name;
  res.json({ ok: true, user: { id: user.id, email: user.email, full_name: user.full_name } });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// GET /api/me
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});
```
