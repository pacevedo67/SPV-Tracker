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

// ── Idempotent migrations ──
const migrations = [
  `ALTER TABLE users ADD COLUMN firm_id TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN invitation_id TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signature_data TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signature_type TEXT`,
  `ALTER TABLE questionnaire_submissions ADD COLUMN signed_at DATETIME`,
  `ALTER TABLE matters ADD COLUMN client TEXT`,
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch {}
}

// ── Seed: give existing users without a firm their own firm ──
const { v4: uuidv4 } = require('uuid');
const orphans = db.prepare(`SELECT * FROM users WHERE firm_id IS NULL`).all();
for (const user of orphans) {
  const firmId = uuidv4();
  db.prepare(`INSERT INTO firms (id, name) VALUES (?, ?)`).run(firmId, user.full_name + "'s Firm");
  db.prepare(`UPDATE users SET firm_id=?, role='admin' WHERE id=?`).run(firmId, user.id);
}

module.exports = db;
