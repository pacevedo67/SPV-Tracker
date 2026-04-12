const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3030;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';
const LB_URL  = (process.env.LB_URL || 'https://leaderboard.phillipacevedo.com').replace(/\/$/, '');
const DT_URL  = (process.env.DT_URL || 'https://dealtracker.phillipacevedo.com').replace(/\/$/, '');

// ── JWT config ──
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (IS_PROD) {
    console.error('FATAL: JWT_SECRET must be at least 32 random characters in production.');
    process.exit(1);
  } else {
    console.warn('[Auth] JWT_SECRET not set or too short — using insecure dev default. Set JWT_SECRET before deploying.');
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-insecure-jwt-secret-do-not-use-in-production-at-all';

// Trust Render's reverse proxy so secure cookies work over HTTPS
if (IS_PROD) app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));

// Session is kept only for the guest/investor token flow (temporary anonymous access)
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-guest-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    maxAge: 4 * 60 * 60 * 1000, // 4 hours for guest sessions
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── JWT helpers (ported from DealTracker) ──
function makeToken(user) {
  return jwt.sign({
    jti:       crypto.randomBytes(16).toString('hex'),
    userId:    user.id,
    email:     user.email,
    full_name: user.full_name,
    role:      user.role,
    firmId:    user.firm_id,
  }, EFFECTIVE_JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie',
    `auth_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${IS_PROD ? '; Secure' : ''}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function getTokenFromRequest(req) {
  // Prefer HttpOnly cookie; fall back to Authorization header for API clients
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (match) return match[1];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

// ── Email via SMTP (nodemailer) ──
const FROM_ADDRESS = process.env.SMTP_FROM || 'SPV Tracker <noreply@example.com>';

const smtpTransport = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendEmail({ to, subject, html }) {
  if (smtpTransport) {
    await smtpTransport.sendMail({ from: FROM_ADDRESS, to, subject, html });
  } else {
    console.log('\n── EMAIL (SMTP not configured — preview only) ──');
    console.log(`To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, '').trim()}`);
    console.log('────────────────────────────────────────────────\n');
  }
}

// ── Invite token: {name-slug}-{6-char-code} e.g. john-smith-Ak3Xm9 ──
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function makeInviteToken(contactName) {
  const slug = contactName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30)
    || 'investor';
  const bytes = crypto.randomBytes(6);
  const code = Array.from(bytes).map(b => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
  return `${slug}-${code}`;
}

// ── Health check (used by Render) ──
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (payload.jti) {
      const denied = db.prepare('SELECT 1 FROM token_denylist WHERE jti = ?').get(payload.jti);
      if (denied) return res.status(401).json({ error: 'Session revoked. Please sign in again.' });
    }
    req.user = payload;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Tries to populate req.user from JWT without failing the request — used for guest-or-auth routes
function optionalAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
      if (payload.jti) {
        const denied = db.prepare('SELECT 1 FROM token_denylist WHERE jti = ?').get(payload.jti);
        if (!denied) req.user = payload;
      } else {
        req.user = payload;
      }
    } catch(e) { /* treat as unauthenticated */ }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    // Populate req.user if not already set (e.g. when used without requireAuth)
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
      if (payload.jti) {
        const denied = db.prepare('SELECT 1 FROM token_denylist WHERE jti = ?').get(payload.jti);
        if (denied) return res.status(401).json({ error: 'Session revoked. Please sign in again.' });
      }
      req.user = payload;
    } catch(e) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  }
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  req.currentUser = user;
  next();
}

// ── Auth ──
app.post('/api/register', async (req, res) => {
  const { email, password, full_name, firm_name } = req.body;
  if (!email || !password || !full_name) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const firmId = uuidv4();
    const fName = (firm_name || full_name + "'s Firm").trim();
    db.prepare('INSERT INTO firms (id, name) VALUES (?, ?)').run(firmId, fName);
    db.prepare('INSERT INTO users (id, email, password_hash, full_name, firm_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(userId, email.toLowerCase(), hash, full_name, firmId, 'admin');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const token = makeToken(user);
    setAuthCookie(res, token);
    res.json({ ok: true, token });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = makeToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
});

// Logout — revoke JWT in denylist and clear cookie
app.post('/api/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.decode(token);
      if (payload?.jti && payload?.exp) {
        const expiresAt = new Date(payload.exp * 1000).toISOString();
        db.prepare('INSERT OR IGNORE INTO token_denylist (jti, expires_at) VALUES (?, ?)').run(payload.jti, expiresAt);
        // Clean up expired denylist entries
        db.prepare("DELETE FROM token_denylist WHERE expires_at < datetime('now')").run();
      }
    } catch(e) { /* ignore decode errors */ }
  }
  clearAuthCookie(res);
  req.session.destroy(() => {});
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, role, firm_id, created_at FROM users WHERE id=?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// /api/auth/me — used by other apps to verify an SPV token cross-app
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, full_name: req.user.full_name });
});

// SSO exchange — accept a token from LB or DT, verify it, issue an SPV session
app.post('/api/auth/exchange', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  let email, full_name;
  for (const url of [LB_URL, DT_URL]) {
    try {
      const r = await fetch(`${url}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const d = await r.json();
        email     = (d.email || d.user?.email)?.toLowerCase().trim();
        full_name = d.full_name || d.name || d.user?.name || email;
        break;
      }
    } catch {}
  }
  if (!email) return res.status(401).json({ error: 'Token could not be verified' });
  let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    const userId = uuidv4(); const firmId = uuidv4();
    db.prepare('INSERT INTO firms (id, name) VALUES (?, ?)').run(firmId, (full_name || email) + "'s Firm");
    db.prepare('INSERT INTO users (id, email, password_hash, full_name, firm_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(userId, email, '', full_name || email, firmId, 'admin');
    user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  }
  const spvToken = makeToken(user);
  setAuthCookie(res, spvToken);
  res.json({ ok: true });
});

// Refresh — issue a fresh JWT without requiring the password
app.post('/api/refresh', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = makeToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, token });
});

// Change password (requires current password)
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  const match = user && await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
  const newHash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, req.user.userId);
  res.json({ ok: true });
});

// Forgot password — sends a reset link via email
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const emailLower = email.toLowerCase().trim();
  const user = db.prepare('SELECT email FROM users WHERE email=?').get(emailLower);

  // Always respond with success to prevent email enumeration
  if (!user) return res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });

  // Delete any previous tokens for this user
  db.prepare('DELETE FROM password_resets WHERE email=?').run(emailLower);

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_resets (token, email, expires_at) VALUES (?, ?, ?)').run(resetToken, emailLower, expiresAt);

  const resetUrl = `${BASE_URL}/reset-password.html?token=${resetToken}`;

  try {
    await sendEmail({
      to: emailLower,
      subject: 'SPV Tracker — Reset your password',
      html: buildPasswordResetEmail(resetUrl),
    });
  } catch(e) {
    console.error('Reset email error:', e);
  }

  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
});

// Reset password using the emailed token
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const reset = db.prepare('SELECT * FROM password_resets WHERE token=? AND used=0').get(token);
  if (!reset) return res.status(400).json({ error: 'Invalid or already-used reset link' });
  if (new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(newHash, reset.email);
  db.prepare('UPDATE password_resets SET used=1 WHERE token=?').run(token);

  // Log the user in with a fresh JWT
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(reset.email);
  const authToken = makeToken(user);
  setAuthCookie(res, authToken);
  res.json({ ok: true, token: authToken, message: 'Password has been reset successfully.' });
});

// ── Firm ──
app.get('/api/firm', requireAuth, (req, res) => {
  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.user.firmId);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  res.json(firm);
});

app.put('/api/firm', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE firms SET name=? WHERE id=?').run(name, req.currentUser.firm_id);
  res.json({ ok: true });
});

// ── Firm users ──
app.get('/api/firm/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, email, full_name, role, created_at FROM users WHERE firm_id=? ORDER BY created_at ASC').all(req.user.firmId);
  res.json(users);
});

app.post('/api/firm/users', requireAdmin, async (req, res) => {
  const { email, full_name, password, role } = req.body;
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.currentUser.firm_id);
    db.prepare('INSERT INTO users (id, email, password_hash, full_name, firm_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, email.toLowerCase(), hash, full_name, req.currentUser.firm_id, role === 'admin' ? 'admin' : 'user');

    // Send welcome email (non-blocking — failure doesn't fail the request)
    sendEmail({
      to: `${full_name} <${email.toLowerCase()}>`,
      subject: `You've been added to ${firm.name} on SPV Tracker`,
      html: buildWelcomeEmail({
        name: full_name,
        email: email.toLowerCase(),
        password,
        firmName: firm.name,
        addedByName: req.currentUser.full_name,
        loginUrl: BASE_URL,
      }),
    }).catch(e => console.error('Welcome email error:', e));

    res.json({ id, email, full_name });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/firm/users/:id', requireAdmin, (req, res) => {
  const { role, full_name } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id=? AND firm_id=?').get(req.params.id, req.currentUser.firm_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (role !== undefined) {
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  }
  if (full_name !== undefined) {
    if (!full_name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    db.prepare('UPDATE users SET full_name=? WHERE id=?').run(full_name.trim(), req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/firm/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id=? AND firm_id=?').get(req.params.id, req.currentUser.firm_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Matters ──
app.get('/api/matters', requireAuth, (req, res) => {
  const matters = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM invitations i WHERE i.matter_id=m.id) as total_invited,
      (SELECT COUNT(*) FROM invitations i WHERE i.matter_id=m.id AND i.status='signed') as total_completed
    FROM matters m WHERE m.firm_id=? ORDER BY m.created_at DESC
  `).all(req.user.firmId);
  res.json(matters);
});

app.post('/api/matters', requireAuth, (req, res) => {
  const { name, description, client } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO matters (id, firm_id, name, description, client, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.firmId, name, description || null, client || null, req.user.userId);
  res.json(db.prepare('SELECT * FROM matters WHERE id=?').get(id));
});

app.get('/api/matters/:id', requireAuth, (req, res) => {
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, req.user.firmId);
  if (!matter) return res.status(404).json({ error: 'Not found' });
  const invitations = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, ic.entity_name,
           u.full_name as sent_by_name,
           qs.id as submission_id, qs.status as submission_status
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id = ic.id
    JOIN users u ON i.sent_by = u.id
    LEFT JOIN questionnaire_submissions qs ON qs.invitation_id = i.id
    WHERE i.matter_id=?
    ORDER BY i.sent_at DESC
  `).all(req.params.id);
  res.json({ ...matter, invitations });
});

app.put('/api/matters/:id', requireAuth, (req, res) => {
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, req.user.firmId);
  if (!matter) return res.status(404).json({ error: 'Not found' });
  const { name, description } = req.body;
  db.prepare('UPDATE matters SET name=?, description=? WHERE id=?').run(name || matter.name, description !== undefined ? description : matter.description, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/matters/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM matters WHERE id=? AND firm_id=?').run(req.params.id, req.user.firmId);
  res.json({ ok: true });
});

// ── Investor contacts ──
app.get('/api/contacts', requireAuth, (req, res) => {
  const contacts = db.prepare('SELECT * FROM investor_contacts WHERE firm_id=? ORDER BY name ASC').all(req.user.firmId);
  res.json(contacts);
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const { name, email, entity_name, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO investor_contacts (id, firm_id, name, email, entity_name, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.firmId, name, email.toLowerCase(), entity_name || null, notes || null, req.user.userId);
    res.json(db.prepare('SELECT * FROM investor_contacts WHERE id=?').get(id));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/contacts/:id', requireAuth, (req, res) => {
  const contact = db.prepare('SELECT * FROM investor_contacts WHERE id=? AND firm_id=?').get(req.params.id, req.user.firmId);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const { name, email, entity_name, notes } = req.body;
  db.prepare('UPDATE investor_contacts SET name=?, email=?, entity_name=?, notes=? WHERE id=?').run(
    name || contact.name, email || contact.email,
    entity_name !== undefined ? entity_name : contact.entity_name,
    notes !== undefined ? notes : contact.notes,
    req.params.id
  );
  res.json({ ok: true });
});

// ── Invitations ──
app.post('/api/matters/:id/invite', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, req.user.firmId);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });

  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  const contact = db.prepare('SELECT * FROM investor_contacts WHERE id=? AND firm_id=?').get(contact_id, req.user.firmId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.user.firmId);
  const token = makeInviteToken(contact.name);
  const invId = uuidv4();

  const existing = db.prepare('SELECT * FROM invitations WHERE matter_id=? AND investor_contact_id=?').get(req.params.id, contact_id);
  if (existing) {
    db.prepare('UPDATE invitations SET token=?, status=?, sent_at=CURRENT_TIMESTAMP, sent_by=? WHERE id=?').run(token, 'sent', req.user.userId, existing.id);
  } else {
    db.prepare('INSERT INTO invitations (id, matter_id, investor_contact_id, sent_by, token) VALUES (?, ?, ?, ?, ?)').run(invId, req.params.id, contact_id, req.user.userId, token);
  }

  const invitationId = existing ? existing.id : invId;
  const link = `${BASE_URL}/q/${token}`;

  const html = buildInviteEmail({
    contactName: contact.name,
    senderName: user.full_name,
    firmName: firm.name,
    matterName: matter.name,
    link,
    invitationId,
    isResend: false,
  });

  try {
    await sendEmail({ to: `${contact.name} <${contact.email}>`, subject: `Investor Questionnaire — ${matter.name}`, html });
    res.json({ ok: true, link });
  } catch (e) {
    console.error('Email error:', e);
    // Return the link even on email failure so it can be shared manually
    res.status(500).json({ error: 'Failed to send email', link });
  }
});

app.post('/api/invitations/:id/resend', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  const inv = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, m.name as matter_name, m.firm_id
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id=ic.id
    JOIN matters m ON i.matter_id=m.id
    WHERE i.id=?
  `).get(req.params.id);
  if (!inv || inv.firm_id !== req.user.firmId) return res.status(404).json({ error: 'Not found' });

  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.user.firmId);
  const newToken = makeInviteToken(inv.contact_name);
  db.prepare('UPDATE invitations SET token=?, status=?, sent_at=CURRENT_TIMESTAMP, sent_by=? WHERE id=?').run(newToken, 'sent', req.user.userId, req.params.id);

  const link = `${BASE_URL}/q/${newToken}`;
  const html = buildInviteEmail({
    contactName: inv.contact_name,
    senderName: user.full_name,
    firmName: firm.name,
    matterName: inv.matter_name,
    link,
    invitationId: req.params.id,
    isResend: true,
  });

  try {
    await sendEmail({ to: `${inv.contact_name} <${inv.contact_email}>`, subject: `Reminder: Investor Questionnaire — ${inv.matter_name}`, html });
    res.json({ ok: true, link });
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ error: 'Failed to send email', link });
  }
});

// ── Email open tracking pixel ──
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/track/open/:invId', (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.invId);
  if (inv && inv.status === 'sent') {
    db.prepare(`UPDATE invitations SET status='opened', opened_at=CURRENT_TIMESTAMP WHERE id=?`).run(inv.id);
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache' });
  res.send(PIXEL);
});

// ── Public: investor opens questionnaire via token ──
app.get('/q/:token', (req, res) => {
  const inv = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, m.name as matter_name
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id=ic.id
    JOIN matters m ON i.matter_id=m.id
    WHERE i.token=?
  `).get(req.params.token);
  if (!inv) return res.status(404).send('<h2 style="font-family:sans-serif;padding:40px;">Link not found or expired.</h2>');

  if (inv.status === 'sent') {
    db.prepare(`UPDATE invitations SET status='opened', opened_at=CURRENT_TIMESTAMP WHERE id=?`).run(inv.id);
  }

  let sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE invitation_id=?').get(inv.id);
  if (!sub) {
    const subId = uuidv4();
    db.prepare('INSERT INTO questionnaire_submissions (id, invitation_id, status) VALUES (?, ?, ?)').run(subId, inv.id, 'draft');
    sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE id=?').get(subId);
  }

  req.session.guestToken = req.params.token;
  req.session.guestSubId = sub.id;
  req.session.guestContactName = inv.contact_name;

  res.redirect(`/questionnaire.html?id=${sub.id}&guest=1`);
});

// ── Guest auth helper ──
function requireGuestOrAuth(req, res, next) {
  if (req.user) return next(); // JWT user (set by optionalAuth upstream)
  if (req.session.guestSubId && req.session.guestSubId === req.params.id) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/api/guest/me', (req, res) => {
  if (!req.session.guestToken) return res.status(401).json({ error: 'No guest session' });
  res.json({ name: req.session.guestContactName, isGuest: true });
});

// ── Investors (self-fill flow) ──
app.get('/api/investors', requireAuth, (req, res) => {
  const investors = db.prepare('SELECT * FROM investors WHERE user_id=? ORDER BY created_at DESC').all(req.user.userId);
  res.json(investors);
});

app.post('/api/investors', requireAuth, (req, res) => {
  const { legal_name, is_self, relationship } = req.body;
  if (!legal_name) return res.status(400).json({ error: 'Legal name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO investors (id, user_id, legal_name, is_self, relationship) VALUES (?, ?, ?, ?, ?)').run(id, req.user.userId, legal_name, is_self ? 1 : 0, relationship || null);
  res.json(db.prepare('SELECT * FROM investors WHERE id=?').get(id));
});

// ── Submissions ──
app.get('/api/submissions', requireAuth, (req, res) => {
  const submissions = db.prepare(`
    SELECT s.*, COALESCE(i.legal_name, ic.name) as investor_name
    FROM questionnaire_submissions s
    LEFT JOIN investors i ON s.investor_id=i.id
    LEFT JOIN invitations inv ON s.invitation_id=inv.id
    LEFT JOIN investor_contacts ic ON inv.investor_contact_id=ic.id
    WHERE s.submitted_by_user_id=?
    ORDER BY s.updated_at DESC
  `).all(req.user.userId);
  res.json(submissions);
});

app.get('/api/submissions/:id', optionalAuth, (req, res) => {
  const byUser = req.user?.userId
    ? db.prepare(`
        SELECT s.*, COALESCE(i.legal_name, ic.name) as investor_name,
               COALESCE(i.is_self, 1) as is_self, i.relationship
        FROM questionnaire_submissions s
        LEFT JOIN investors i ON s.investor_id=i.id
        LEFT JOIN invitations inv ON s.invitation_id=inv.id
        LEFT JOIN investor_contacts ic ON inv.investor_contact_id=ic.id
        WHERE s.id=? AND (
          s.submitted_by_user_id=? OR
          s.invitation_id IN (
            SELECT inv2.id FROM invitations inv2
            JOIN matters m ON inv2.matter_id=m.id
            JOIN users u ON u.firm_id=m.firm_id
            WHERE u.id=?
          )
        )
      `).get(req.params.id, req.user.userId, req.user.userId)
    : null;

  const byGuest = req.session.guestSubId === req.params.id
    ? db.prepare(`
        SELECT s.*, ic.name as investor_name, 1 as is_self, NULL as relationship
        FROM questionnaire_submissions s
        LEFT JOIN invitations inv ON s.invitation_id=inv.id
        LEFT JOIN investor_contacts ic ON inv.investor_contact_id=ic.id
        WHERE s.id=?
      `).get(req.params.id)
    : null;

  const sub = byUser || byGuest;
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

app.post('/api/submissions', requireAuth, (req, res) => {
  const { investor_id } = req.body;
  if (!investor_id) return res.status(400).json({ error: 'investor_id required' });
  const investor = db.prepare('SELECT * FROM investors WHERE id=? AND user_id=?').get(investor_id, req.user.userId);
  if (!investor) return res.status(403).json({ error: 'Investor not found' });
  const id = uuidv4();
  db.prepare('INSERT INTO questionnaire_submissions (id, investor_id, submitted_by_user_id) VALUES (?, ?, ?)').run(id, investor_id, req.user.userId);
  res.json({ id });
});

app.put('/api/submissions/:id', optionalAuth, (req, res) => {
  const isAuth = !!req.user?.userId;
  const isGuest = req.session.guestSubId === req.params.id;
  if (!isAuth && !isGuest) return res.status(401).json({ error: 'Not authenticated' });

  const sub = isAuth
    ? db.prepare(`
        SELECT * FROM questionnaire_submissions WHERE id=? AND (
          submitted_by_user_id=? OR
          invitation_id IN (
            SELECT inv.id FROM invitations inv
            JOIN matters m ON inv.matter_id=m.id
            JOIN users u ON u.firm_id=m.firm_id
            WHERE u.id=?
          )
        )
      `).get(req.params.id, req.user.userId, req.user.userId)
    : db.prepare('SELECT * FROM questionnaire_submissions WHERE id=?').get(req.params.id);

  if (!sub) return res.status(404).json({ error: 'Not found' });

  const isFirmUser = isAuth && !isGuest;
  if (sub.status === 'submitted' && !isFirmUser) {
    return res.status(400).json({ error: 'Cannot edit a submitted questionnaire' });
  }

  const { general_info, investment_info, category_ii, category_iii, category_iv, category_v, status, signature_name } = req.body;
  const fields = [], vals = [];
  if (general_info   !== undefined) { fields.push('general_info=?');   vals.push(JSON.stringify(general_info)); }
  if (investment_info !== undefined) { fields.push('investment_info=?'); vals.push(JSON.stringify(investment_info)); }
  if (category_ii    !== undefined) { fields.push('category_ii=?');    vals.push(JSON.stringify(category_ii)); }
  if (category_iii   !== undefined) { fields.push('category_iii=?');   vals.push(JSON.stringify(category_iii)); }
  if (category_iv    !== undefined) { fields.push('category_iv=?');    vals.push(JSON.stringify(category_iv)); }
  if (category_v     !== undefined) { fields.push('category_v=?');     vals.push(JSON.stringify(category_v)); }
  if (status         !== undefined) { fields.push('status=?');         vals.push(status); }
  if (signature_name !== undefined) { fields.push('signature_name=?'); vals.push(signature_name); }

  if (sub.status === 'submitted' && isFirmUser && !fields.find(f => f.startsWith('status'))) {
    fields.push('status=?'); vals.push('draft');
  }

  if (!fields.length) return res.json({ ok: true });

  fields.push('updated_at=CURRENT_TIMESTAMP');
  vals.push(req.params.id);
  db.prepare(`UPDATE questionnaire_submissions SET ${fields.join(',')} WHERE id=?`).run(...vals);

  if (sub.invitation_id) {
    const inv = db.prepare('SELECT status FROM invitations WHERE id=?').get(sub.invitation_id);
    if (inv) {
      if (sub.status === 'submitted' && isFirmUser) {
        db.prepare(`UPDATE invitations SET status='revised' WHERE id=?`).run(sub.invitation_id);
      } else if (inv.status === 'sent' || inv.status === 'opened') {
        db.prepare(`UPDATE invitations SET status='in_progress' WHERE id=?`).run(sub.invitation_id);
      }
    }
  }

  res.json({ ok: true });
});

app.post('/api/submissions/:id/request-resign', requireAuth, async (req, res) => {
  const firmUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  const sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE id=?').get(req.params.id);
  if (!sub || !sub.invitation_id) return res.status(404).json({ error: 'Not found' });

  const inv = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, m.name as matter_name, m.firm_id
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id=ic.id
    JOIN matters m ON i.matter_id=m.id
    WHERE i.id=?
  `).get(sub.invitation_id);
  if (!inv || inv.firm_id !== req.user.firmId) return res.status(403).json({ error: 'Forbidden' });

  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(firmUser.firm_id);

  db.prepare(`UPDATE invitations SET status='revised' WHERE id=?`).run(inv.id);
  db.prepare(`UPDATE questionnaire_submissions SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);

  const link = `${BASE_URL}/q/${inv.token}`;
  const html = buildResignEmail({
    contactName: inv.contact_name,
    senderName: firmUser.full_name,
    firmName: firm.name,
    matterName: inv.matter_name,
    link,
    invitationId: inv.id,
  });

  try {
    await sendEmail({ to: `${inv.contact_name} <${inv.contact_email}>`, subject: `Action Required: Please Re-sign — ${inv.matter_name}`, html });
    res.json({ ok: true, link });
  } catch (e) {
    console.error('Email error:', e);
    res.json({ ok: true, link, warning: 'Could not send email — share the link manually.' });
  }
});

app.post('/api/submissions/:id/sign', optionalAuth, (req, res) => {
  const isAuth = !!req.user?.userId;
  const isGuest = req.session.guestSubId === req.params.id;
  if (!isAuth && !isGuest) return res.status(401).json({ error: 'Not authenticated' });

  const sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const { signature_name, signature_data, signature_type } = req.body;
  if (!signature_name) return res.status(400).json({ error: 'signature_name required' });

  db.prepare(`
    UPDATE questionnaire_submissions
    SET signature_name=?, signature_data=?, signature_type=?,
        status='submitted', signed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(signature_name, signature_data || null, signature_type || 'type', req.params.id);

  if (sub.invitation_id) {
    db.prepare(`UPDATE invitations SET status='signed', completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(sub.invitation_id);
  }

  res.json({ ok: true });
});

// ── Email templates ──
function emailWrapper(body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">
        <!-- Header -->
        <tr>
          <td style="padding-bottom:24px;">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#2563eb;border-radius:6px;width:28px;height:28px;text-align:center;vertical-align:middle;">
                  <span style="color:#fff;font-size:14px;font-weight:700;line-height:28px;">S</span>
                </td>
                <td style="padding-left:10px;font-size:14px;font-weight:600;color:#0f172a;">SPV Tracker</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Card -->
        <tr>
          <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:36px 40px;">
            ${body}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding-top:20px;text-align:center;font-size:12px;color:#94a3b8;">
            This message was sent via SPV Tracker. Do not share your questionnaire link.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildInviteEmail({ contactName, senderName, firmName, matterName, link, invitationId, isResend }) {
  const intro = isResend
    ? `<strong>${senderName}</strong> at <strong>${firmName}</strong> sent you a reminder to complete your Accredited Investor Questionnaire for <strong>${matterName}</strong>.`
    : `<strong>${senderName}</strong> at <strong>${firmName}</strong> has invited you to complete an Accredited Investor Questionnaire for <strong>${matterName}</strong>.`;

  return emailWrapper(`
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Hi ${contactName},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">${intro}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:5px;text-decoration:none;">
            Open Questionnaire →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;">Or copy this link:</p>
    <p style="margin:0;font-size:12px;color:#2563eb;word-break:break-all;">${link}</p>
    <img src="${BASE_URL}/track/open/${invitationId}" width="1" height="1" style="display:none;" alt="">
  `);
}

function buildResignEmail({ contactName, senderName, firmName, matterName, link, invitationId }) {
  return emailWrapper(`
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Hi ${contactName},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
      <strong>${senderName}</strong> at <strong>${firmName}</strong> has made updates to your Accredited Investor Questionnaire for <strong>${matterName}</strong> and requires your review and re-signature.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:5px;text-decoration:none;">
            Review &amp; Sign →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;">Or copy this link:</p>
    <p style="margin:0;font-size:12px;color:#2563eb;word-break:break-all;">${link}</p>
    <img src="${BASE_URL}/track/open/${invitationId}" width="1" height="1" style="display:none;" alt="">
  `);
}

function buildWelcomeEmail({ name, email, password, firmName, addedByName, loginUrl }) {
  return emailWrapper(`
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Hi ${name},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
      <strong>${addedByName}</strong> has added you to <strong>${firmName}</strong> on SPV Tracker.
      Here are your login credentials:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;">
      <tr><td style="font-size:13px;color:#64748b;padding:4px 0;width:80px;">Email</td><td style="font-size:13px;color:#0f172a;font-weight:500;">${email}</td></tr>
      <tr><td style="font-size:13px;color:#64748b;padding:4px 0;">Password</td><td style="font-size:13px;color:#0f172a;font-weight:500;">${password}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${loginUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:5px;text-decoration:none;">
            Sign In to SPV Tracker →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:12px;color:#94a3b8;">We recommend changing your password after your first login.</p>
  `);
}

function buildPasswordResetEmail(resetUrl) {
  return emailWrapper(`
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Reset your password</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
      Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:5px;text-decoration:none;">
            Reset Password
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;">Or copy this link:</p>
    <p style="margin:0;font-size:12px;color:#2563eb;word-break:break-all;">${resetUrl}</p>
    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">If you didn't request this, you can safely ignore this email.</p>
  `);
}

app.listen(PORT, () => {
  console.log(`SPV Tracker running on http://localhost:${PORT}`);
  if (!smtpTransport) console.warn('⚠  SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS not set) — emails will be logged to console only.');
  if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET not set — using insecure dev default. Set it before deploying.');
  if (!IS_PROD) console.log('   Running in development mode.');
});
