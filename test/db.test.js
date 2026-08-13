import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before db.js is loaded so the module picks up the temp path
const DB_PATH = join(tmpdir(), `gmail-db-test-${randomBytes(4).toString('hex')}.db`);
process.env.GMAIL_MCP_DB_PATH = DB_PATH;

const { listAccounts, getTokens, storeTokens, setLabel, resolveEmail, removeAccount } =
  await import('../src/db.js');

after(async () => {
  await rm(DB_PATH, { force: true });
});

const BASE_TOKENS = {
  access_token: 'access_abc',
  refresh_token: 'refresh_xyz',
  expiry_date: Date.now() + 3_600_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

// ---------------------------------------------------------------------------
// storeTokens / getTokens
// ---------------------------------------------------------------------------

describe('storeTokens / getTokens', () => {
  it('stores and retrieves token fields', () => {
    storeTokens('alice@example.com', BASE_TOKENS);
    const row = getTokens('alice@example.com');
    assert.equal(row.email, 'alice@example.com');
    assert.equal(row.access_token, 'access_abc');
    assert.equal(row.refresh_token, 'refresh_xyz');
  });

  it('returns null for an unknown email', () => {
    assert.equal(getTokens('nobody@example.com'), null);
  });

  it('overwrites access_token on re-store', () => {
    storeTokens('update@example.com', BASE_TOKENS);
    storeTokens('update@example.com', { ...BASE_TOKENS, access_token: 'new_token' });
    assert.equal(getTokens('update@example.com').access_token, 'new_token');
  });

  it('preserves existing label when no label arg is passed', () => {
    storeTokens('keep-label@example.com', BASE_TOKENS, 'side');
    storeTokens('keep-label@example.com', { ...BASE_TOKENS, access_token: 'refreshed' });
    const row = getTokens('keep-label@example.com');
    assert.equal(row.label, 'side');
    assert.equal(row.access_token, 'refreshed');
  });

  it('sets label when provided on store', () => {
    storeTokens('labelled@example.com', BASE_TOKENS, 'work');
    assert.equal(getTokens('labelled@example.com').label, 'work');
  });
});

// ---------------------------------------------------------------------------
// listAccounts
// ---------------------------------------------------------------------------

describe('listAccounts', () => {
  it('returns email and label for stored accounts', () => {
    storeTokens('list-a@example.com', BASE_TOKENS, 'personal');
    const accounts = listAccounts();
    const found = accounts.find(a => a.email === 'list-a@example.com');
    assert.ok(found, 'account not in list');
    assert.equal(found.label, 'personal');
  });

  it('does not return extra fields (only email and label)', () => {
    storeTokens('list-b@example.com', BASE_TOKENS);
    const accounts = listAccounts();
    const found = accounts.find(a => a.email === 'list-b@example.com');
    assert.ok(found);
    assert.deepEqual(Object.keys(found).sort(), ['email', 'label']);
  });
});

// ---------------------------------------------------------------------------
// setLabel
// ---------------------------------------------------------------------------

describe('setLabel', () => {
  it('assigns a label to an existing account', () => {
    storeTokens('assign-label@example.com', BASE_TOKENS);
    setLabel('assign-label@example.com', 'finance');
    assert.equal(getTokens('assign-label@example.com').label, 'finance');
  });

  it('overwrites an existing label', () => {
    storeTokens('relabel@example.com', BASE_TOKENS, 'old');
    setLabel('relabel@example.com', 'new');
    assert.equal(getTokens('relabel@example.com').label, 'new');
  });
});

// ---------------------------------------------------------------------------
// resolveEmail
// ---------------------------------------------------------------------------

describe('resolveEmail', () => {
  it('resolves by exact email', () => {
    storeTokens('exact@example.com', BASE_TOKENS);
    assert.equal(resolveEmail('exact@example.com'), 'exact@example.com');
  });

  it('resolves by label (exact case)', () => {
    storeTokens('by-label@example.com', BASE_TOKENS, 'mywork');
    assert.equal(resolveEmail('mywork'), 'by-label@example.com');
  });

  it('resolves by label case-insensitively', () => {
    storeTokens('ci-label@example.com', BASE_TOKENS, 'CiTest');
    assert.equal(resolveEmail('citest'), 'ci-label@example.com');
    assert.equal(resolveEmail('CITEST'), 'ci-label@example.com');
    assert.equal(resolveEmail('CiTest'), 'ci-label@example.com');
  });

  it('returns null for unknown email', () => {
    assert.equal(resolveEmail('ghost@example.com'), null);
  });

  it('returns null for unknown label', () => {
    assert.equal(resolveEmail('nonexistentlabel'), null);
  });

  it('prefers exact email match over label match', () => {
    // Store an account whose email happens to equal another account's label
    storeTokens('ambiguous@example.com', BASE_TOKENS);
    storeTokens('other@example.com', BASE_TOKENS, 'ambiguous@example.com');
    // Email lookup wins
    assert.equal(resolveEmail('ambiguous@example.com'), 'ambiguous@example.com');
  });
});

// ---------------------------------------------------------------------------
// removeAccount
// ---------------------------------------------------------------------------

describe('removeAccount', () => {
  it('deletes the account', () => {
    storeTokens('remove-me@example.com', BASE_TOKENS);
    removeAccount('remove-me@example.com');
    assert.equal(getTokens('remove-me@example.com'), null);
  });

  it('also removes account from listAccounts', () => {
    storeTokens('remove-list@example.com', BASE_TOKENS);
    removeAccount('remove-list@example.com');
    const found = listAccounts().find(a => a.email === 'remove-list@example.com');
    assert.equal(found, undefined);
  });

  it('is a no-op for unknown email', () => {
    assert.doesNotThrow(() => removeAccount('nobody@example.com'));
  });
});

// ---------------------------------------------------------------------------
// file permissions
// ---------------------------------------------------------------------------

describe('database file permissions', () => {
  it('is not readable or writable by group or other', () => {
    // The DB stores refresh tokens in plaintext, so it must stay owner-only.
    // SQLite creates the file using the process umask (commonly 0644), which
    // would otherwise leave tokens world-readable.
    storeTokens('perms@example.com', BASE_TOKENS);
    const mode = statSync(DB_PATH).mode & 0o777;
    assert.equal(mode & 0o077, 0, `expected no group/other bits, got ${mode.toString(8)}`);
  });
});
