const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'questionnaire.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS questionnaire_submissions (
    id TEXT PRIMARY KEY,
    investor_id TEXT NOT NULL REFERENCES investors(id),
    submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft',
    general_info TEXT,
    investment_info TEXT,
    category_ii TEXT,
    category_iii TEXT,
    category_iv TEXT,
    category_v TEXT,
    signature_name TEXT,
    signed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
