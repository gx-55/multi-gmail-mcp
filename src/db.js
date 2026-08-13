import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.GMAIL_MCP_DB_PATH ?? join(homedir(), '.gmail-mcp-tokens.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    // The DB holds plaintext refresh tokens — keep it owner-only. SQLite creates
    // the file with the process umask (typically 0644), so narrow it explicitly.
    try {
      chmodSync(DB_PATH, 0o600);
    } catch {
      // Non-fatal: a read-only or exotic filesystem shouldn't block startup
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        email         TEXT PRIMARY KEY,
        access_token  TEXT,
        refresh_token TEXT,
        expiry        TEXT,
        scopes        TEXT,
        label         TEXT
      )
    `);
    // Migrate existing DBs that don't have the label column yet
    try {
      db.exec('ALTER TABLE accounts ADD COLUMN label TEXT');
    } catch {
      // Column already exists — safe to ignore
    }
  }
  return db;
}

export function listAccounts() {
  return getDb().prepare('SELECT email, label FROM accounts').all();
}

export function getTokens(email) {
  return getDb().prepare('SELECT * FROM accounts WHERE email = ?').get(email) ?? null;
}

export function storeTokens(email, tokens, label = null) {
  const existing = getTokens(email);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO accounts (email, access_token, refresh_token, expiry, scopes, label)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      email,
      tokens.access_token ?? null,
      tokens.refresh_token ?? null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      tokens.scope ?? null,
      label ?? existing?.label ?? null
    );
}

export function setLabel(email, label) {
  getDb().prepare('UPDATE accounts SET label = ? WHERE email = ?').run(label, email);
}

// Resolve a label or email string to a stored email address.
// Returns the email if found, null otherwise.
export function resolveEmail(labelOrEmail) {
  const db = getDb();
  // Exact email match first
  const byEmail = db.prepare('SELECT email FROM accounts WHERE email = ?').get(labelOrEmail);
  if (byEmail) return byEmail.email;
  // Case-insensitive label match
  const byLabel = db
    .prepare('SELECT email FROM accounts WHERE lower(label) = lower(?)')
    .get(labelOrEmail);
  return byLabel?.email ?? null;
}

export function removeAccount(email) {
  getDb().prepare('DELETE FROM accounts WHERE email = ?').run(email);
}
