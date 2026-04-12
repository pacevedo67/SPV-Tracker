const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Resend } = require('resend');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3030;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

// Trust Render's reverse proxy so secure cookies work over HTTPS
if (IS_PROD) app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,   // HTTPS-only in production
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Email via Resend ──
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_ADDRESS = `${process.env.FROM_NAME || 'SPV Tracker'} <${process.env.FROM_EMAIL || 'noreply@example.com'}>`;

async function sendEmail({ to, subject, html }) {
  if (resendClient) {
    const { error } = await resendClient.emails.send({ from: FROM_ADDRESS, to, subject, html });
    if (error) throw new Error(error.message);
  } else {
    console.log('\n── EMAIL (RESEND_API_KEY not set — preview only) ──');
    console.log(`To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, '').trim()}`);
    console.log('────────────────────────────────────────────────\n');
  }
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.currentUser = user;
  next();
}

// ── Auth ──
app.post('/api/register', async (req, res) => {
  const { email, password, full_name, firm_name } = req.body;
  if (!email || !password || !full_name) return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const firmId = uuidv4();
    const fName = (firm_name || full_name + "'s Firm").trim();
    db.prepare('INSERT INTO firms (id, name) VALUES (?, ?)').run(firmId, fName);
    db.prepare('INSERT INTO users (id, email, password_hash, full_name, firm_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(userId, email.toLowerCase(), hash, full_name, firmId, 'admin');
    req.session.userId = userId;
    req.session.firmId = firmId;
    res.json({ ok: true });
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
  req.session.userId = user.id;
  req.session.firmId = user.firm_id;
  res.json({ ok: true, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, role, firm_id, created_at FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ── Firm ──
app.get('/api/firm', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(user.firm_id);
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
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const users = db.prepare('SELECT id, email, full_name, role, created_at FROM users WHERE firm_id=? ORDER BY created_at ASC').all(user.firm_id);
  res.json(users);
});

app.post('/api/firm/users', requireAdmin, async (req, res) => {
  const { email, full_name, password, role } = req.body;
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, email, password_hash, full_name, firm_id, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, email.toLowerCase(), hash, full_name, req.currentUser.firm_id, role === 'admin' ? 'admin' : 'user');
    res.json({ id, email, full_name });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/firm/users/:id', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const target = db.prepare('SELECT * FROM users WHERE id=? AND firm_id=?').get(req.params.id, req.currentUser.firm_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/firm/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id=? AND firm_id=?').get(req.params.id, req.currentUser.firm_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Matters ──
app.get('/api/matters', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const matters = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM invitations i WHERE i.matter_id=m.id) as total_invited,
      (SELECT COUNT(*) FROM invitations i WHERE i.matter_id=m.id AND i.status='signed') as total_completed
    FROM matters m WHERE m.firm_id=? ORDER BY m.created_at DESC
  `).all(user.firm_id);
  res.json(matters);
});

app.post('/api/matters', requireAuth, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const id = uuidv4();
  db.prepare('INSERT INTO matters (id, firm_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)').run(id, user.firm_id, name, description || null, req.session.userId);
  res.json(db.prepare('SELECT * FROM matters WHERE id=?').get(id));
});

app.get('/api/matters/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, user.firm_id);
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
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, user.firm_id);
  if (!matter) return res.status(404).json({ error: 'Not found' });
  const { name, description } = req.body;
  db.prepare('UPDATE matters SET name=?, description=? WHERE id=?').run(name || matter.name, description !== undefined ? description : matter.description, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/matters/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  db.prepare('DELETE FROM matters WHERE id=? AND firm_id=?').run(req.params.id, user.firm_id);
  res.json({ ok: true });
});

// ── Investor contacts ──
app.get('/api/contacts', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const contacts = db.prepare('SELECT * FROM investor_contacts WHERE firm_id=? ORDER BY name ASC').all(user.firm_id);
  res.json(contacts);
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const { name, email, entity_name, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO investor_contacts (id, firm_id, name, email, entity_name, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, user.firm_id, name, email.toLowerCase(), entity_name || null, notes || null, req.session.userId);
    res.json(db.prepare('SELECT * FROM investor_contacts WHERE id=?').get(id));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/contacts/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const contact = db.prepare('SELECT * FROM investor_contacts WHERE id=? AND firm_id=?').get(req.params.id, user.firm_id);
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
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const matter = db.prepare('SELECT * FROM matters WHERE id=? AND firm_id=?').get(req.params.id, user.firm_id);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });

  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  const contact = db.prepare('SELECT * FROM investor_contacts WHERE id=? AND firm_id=?').get(contact_id, user.firm_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(user.firm_id);
  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const invId = uuidv4();

  const existing = db.prepare('SELECT * FROM invitations WHERE matter_id=? AND investor_contact_id=?').get(req.params.id, contact_id);
  if (existing) {
    db.prepare('UPDATE invitations SET token=?, status=?, sent_at=CURRENT_TIMESTAMP, sent_by=? WHERE id=?').run(token, 'sent', req.session.userId, existing.id);
  } else {
    db.prepare('INSERT INTO invitations (id, matter_id, investor_contact_id, sent_by, token) VALUES (?, ?, ?, ?, ?)').run(invId, req.params.id, contact_id, req.session.userId, token);
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
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const inv = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, m.name as matter_name, m.firm_id
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id=ic.id
    JOIN matters m ON i.matter_id=m.id
    WHERE i.id=?
  `).get(req.params.id);
  if (!inv || inv.firm_id !== user.firm_id) return res.status(404).json({ error: 'Not found' });

  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(user.firm_id);
  const newToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  db.prepare('UPDATE invitations SET token=?, status=?, sent_at=CURRENT_TIMESTAMP, sent_by=? WHERE id=?').run(newToken, 'sent', req.session.userId, req.params.id);

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
  if (req.session.userId) return next();
  if (req.session.guestSubId && req.session.guestSubId === req.params.id) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/api/guest/me', (req, res) => {
  if (!req.session.guestToken) return res.status(401).json({ error: 'No guest session' });
  res.json({ name: req.session.guestContactName, isGuest: true });
});

// ── Investors (self-fill flow) ──
app.get('/api/investors', requireAuth, (req, res) => {
  const investors = db.prepare('SELECT * FROM investors WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  res.json(investors);
});

app.post('/api/investors', requireAuth, (req, res) => {
  const { legal_name, is_self, relationship } = req.body;
  if (!legal_name) return res.status(400).json({ error: 'Legal name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO investors (id, user_id, legal_name, is_self, relationship) VALUES (?, ?, ?, ?, ?)').run(id, req.session.userId, legal_name, is_self ? 1 : 0, relationship || null);
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
  `).all(req.session.userId);
  res.json(submissions);
});

app.get('/api/submissions/:id', (req, res) => {
  const byUser = req.session.userId
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
      `).get(req.params.id, req.session.userId, req.session.userId)
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
  const investor = db.prepare('SELECT * FROM investors WHERE id=? AND user_id=?').get(investor_id, req.session.userId);
  if (!investor) return res.status(403).json({ error: 'Investor not found' });
  const id = uuidv4();
  db.prepare('INSERT INTO questionnaire_submissions (id, investor_id, submitted_by_user_id) VALUES (?, ?, ?)').run(id, investor_id, req.session.userId);
  res.json({ id });
});

app.put('/api/submissions/:id', (req, res) => {
  const isAuth = !!req.session.userId;
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
      `).get(req.params.id, req.session.userId, req.session.userId)
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
  const firmUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const sub = db.prepare('SELECT * FROM questionnaire_submissions WHERE id=?').get(req.params.id);
  if (!sub || !sub.invitation_id) return res.status(404).json({ error: 'Not found' });

  const inv = db.prepare(`
    SELECT i.*, ic.name as contact_name, ic.email as contact_email, m.name as matter_name, m.firm_id
    FROM invitations i
    JOIN investor_contacts ic ON i.investor_contact_id=ic.id
    JOIN matters m ON i.matter_id=m.id
    WHERE i.id=?
  `).get(sub.invitation_id);
  if (!inv || inv.firm_id !== firmUser.firm_id) return res.status(403).json({ error: 'Forbidden' });

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

app.post('/api/submissions/:id/sign', (req, res) => {
  const isAuth = !!req.session.userId;
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

app.listen(PORT, () => {
  console.log(`SPV Tracker running on http://localhost:${PORT}`);
  if (!process.env.RESEND_API_KEY) console.warn('⚠  RESEND_API_KEY not set — emails will be logged to console only.');
  if (!IS_PROD) console.log('   Running in development mode.');
});
