const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'iq-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Auth
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

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// Investors
app.get('/api/investors', requireAuth, (req, res) => {
  const investors = db.prepare('SELECT * FROM investors WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json(investors);
});

app.post('/api/investors', requireAuth, (req, res) => {
  const { legal_name, is_self, relationship } = req.body;
  if (!legal_name) return res.status(400).json({ error: 'Legal name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO investors (id, user_id, legal_name, is_self, relationship) VALUES (?, ?, ?, ?, ?)').run(id, req.session.userId, legal_name, is_self ? 1 : 0, relationship || null);
  const investor = db.prepare('SELECT * FROM investors WHERE id = ?').get(id);
  res.json(investor);
});

// Submissions
app.get('/api/submissions', requireAuth, (req, res) => {
  const submissions = db.prepare(`
    SELECT s.*, i.legal_name as investor_name
    FROM questionnaire_submissions s
    JOIN investors i ON s.investor_id = i.id
    WHERE s.submitted_by_user_id = ?
    ORDER BY s.updated_at DESC
  `).all(req.session.userId);
  res.json(submissions);
});

app.get('/api/submissions/:id', requireAuth, (req, res) => {
  const sub = db.prepare(`
    SELECT s.*, i.legal_name as investor_name, i.is_self, i.relationship
    FROM questionnaire_submissions s
    JOIN investors i ON s.investor_id = i.id
    WHERE s.id = ? AND s.submitted_by_user_id = ?
  `).get(req.params.id, req.session.userId);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

app.post('/api/submissions', requireAuth, (req, res) => {
  const { investor_id } = req.body;
  if (!investor_id) return res.status(400).json({ error: 'investor_id required' });
  const investor = db.prepare('SELECT * FROM investors WHERE id = ? AND user_id = ?').get(investor_id, req.session.userId);
  if (!investor) return res.status(403).json({ error: 'Investor not found' });
  const id = uuidv4();
  db.prepare('INSERT INTO questionnaire_submissions (id, investor_id, submitted_by_user_id) VALUES (?, ?, ?)').run(id, investor_id, req.session.userId);
  res.json({ id });
});

app.put('/api/submissions/:id', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE id = ? AND submitted_by_user_id = ?').get(req.params.id, req.session.userId);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  if (sub.status === 'submitted') return res.status(400).json({ error: 'Cannot edit a submitted questionnaire' });

  const { general_info, investment_info, category_ii, category_iii, category_iv, category_v, status, signature_name } = req.body;
  const fields = [];
  const vals = [];

  if (general_info !== undefined) { fields.push('general_info = ?'); vals.push(JSON.stringify(general_info)); }
  if (investment_info !== undefined) { fields.push('investment_info = ?'); vals.push(JSON.stringify(investment_info)); }
  if (category_ii !== undefined) { fields.push('category_ii = ?'); vals.push(JSON.stringify(category_ii)); }
  if (category_iii !== undefined) { fields.push('category_iii = ?'); vals.push(JSON.stringify(category_iii)); }
  if (category_iv !== undefined) { fields.push('category_iv = ?'); vals.push(JSON.stringify(category_iv)); }
  if (category_v !== undefined) { fields.push('category_v = ?'); vals.push(JSON.stringify(category_v)); }
  if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
  if (signature_name !== undefined) { fields.push('signature_name = ?'); vals.push(signature_name); }
  if (status === 'submitted') { fields.push('signed_at = CURRENT_TIMESTAMP'); }
  fields.push('updated_at = CURRENT_TIMESTAMP');

  if (fields.length === 0) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE questionnaire_submissions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Investor Questionnaire running on http://localhost:${PORT}`));
