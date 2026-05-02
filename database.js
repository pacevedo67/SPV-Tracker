const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_PATH
  || (process.env.RENDER ? '/data/questionnaire.db' : path.join(__dirname, 'questionnaire.db'));
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    firm_id TEXT REFERENCES firms(id),
    role TEXT NOT NULL DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS investors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    legal_name TEXT NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 1,
    relationship TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS matters (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS investor_contacts (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    entity_name TEXT,
    notes TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    matter_id TEXT NOT NULL REFERENCES matters(id),
    investor_contact_id TEXT NOT NULL REFERENCES investor_contacts(id),
    sent_by TEXT NOT NULL REFERENCES users(id),
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    opened_at DATETIME,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS questionnaire_submissions (
    id TEXT PRIMARY KEY,
    investor_id TEXT REFERENCES investors(id),
    invitation_id TEXT REFERENCES invitations(id),
    submitted_by_user_id TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft',
    general_info TEXT,
    investment_info TEXT,
    category_ii TEXT,
    category_iii TEXT,
    category_iv TEXT,
    category_v TEXT,
    signature_name TEXT,
    signature_data TEXT,
    signature_type TEXT,
    signed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Auth support tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS token_denylist (
    jti        TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Investor accounts (Step 1: identity layer) ──
// investor_accounts is the entity being certified (e.g. "Smith Family Trust").
// investor_users are the individual logins tied to that account, with one admin
// (the registrant) and zero or more designees who can act on its behalf.
db.exec(`
  CREATE TABLE IF NOT EXISTS investor_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS investor_users (
    id TEXT PRIMARY KEY,
    investor_account_id TEXT NOT NULL REFERENCES investor_accounts(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'designee')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 1:1 with investor_accounts. Owns the entity-level info that pre-fills
  -- questionnaires across firms (Step 2A of ROADMAP.md).
  CREATE TABLE IF NOT EXISTS investor_profiles (
    investor_account_id TEXT PRIMARY KEY REFERENCES investor_accounts(id) ON DELETE CASCADE,
    entity_type TEXT,
    state TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    postal_code TEXT,
    phone TEXT,
    tax_id_last4 TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT REFERENCES investor_users(id)
  );
`);

// ── Certifications & cross-firm access grants (Step 3) ──
// A certification is the canonical record that a given investor account is
// accredited as of a given signed submission. Grants connect it to the firms
// the investor has chosen to share that status with. When an investor signs a
// new submission, the prior cert (if any) is marked 'superseded' and a new
// active row is inserted; existing grants do not carry over automatically —
// firms must already be on the new cert's grant list (the sign handler
// re-grants the inviting firm and rolls forward firms with active grants on
// the prior cert).
db.exec(`
  CREATE TABLE IF NOT EXISTS certifications (
    id TEXT PRIMARY KEY,
    investor_account_id TEXT NOT NULL REFERENCES investor_accounts(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL UNIQUE REFERENCES questionnaire_submissions(id) ON DELETE CASCADE,
    certified_at DATETIME NOT NULL,
    expires_at DATETIME,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked','expired')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS certification_access_grants (
    id TEXT PRIMARY KEY,
    certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE CASCADE,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME,
    UNIQUE(certification_id, firm_id)
  );
`);

// ── Idempotent migrations ──
const migrations = [
  `ALTER TABLE users ADD COLUMN firm_id TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN invitation_id TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signature_data TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signature_type TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signed_at DATETIME`,
  `ALTER TABLE matters ADD COLUMN client TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN investor_account_id TEXT REFERENCES investor_accounts(id)`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN investor_user_id TEXT REFERENCES investor_users(id)`,
  // Step 3: invitations can be either a questionnaire (default) or an
  // access_request asking an investor to grant the firm access to their
  // existing portable certification.
  `ALTER TABLE invitations ADD COLUMN type TEXT NOT NULL DEFAULT 'questionnaire'`,
  `ALTER TABLE invitations ADD COLUMN certification_id TEXT REFERENCES certifications(id)`,
  // Step 4: track when we last emailed the investor about an upcoming expiry
  // so the daily sweeper doesn't spam them. Cleared (left NULL) on new certs
  // since superseding mints a fresh row.
  `ALTER TABLE certifications ADD COLUMN expiry_reminder_sent_at DATETIME`,
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch {}
}

// Step 4 backfill: existing active certs may have been minted before
// expires_at was being set. Default them to certified_at + 1 year so the
// expiry sweeper has something to compare against. Idempotent — only fills
// rows where expires_at IS NULL.
db.prepare(`
  UPDATE certifications
  SET expires_at = datetime(certified_at, '+1 year')
  WHERE expires_at IS NULL
`).run();

// ── Seed: give existing users without a firm their own firm ──
const { v4: uuidv4 } = require('uuid');
const orphans = db.prepare(`SELECT * FROM users WHERE firm_id IS NULL`).all();
for (const user of orphans) {
  const firmId = uuidv4();
  db.prepare(`INSERT INTO firms (id, name) VALUES (?, ?)`).run(firmId, user.full_name + "'s Firm");
  db.prepare(`UPDATE users SET firm_id=?, role='admin' WHERE id=?`).run(firmId, user.id);
}

module.exports = db;
