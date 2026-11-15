import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before db.js is loaded so the module picks up the temp path
const DB_PATH = join(tmpdir(), `gmail-auth-test-${randomBytes(4).toString('hex')}.db`);
process.env.GMAIL_MCP_DB_PATH = DB_PATH;

const { assertSameAccount, storeVerifiedTokens, AccountMismatchError } = await import(
  '../src/auth.js'
);
const { getTokens, storeTokens } = await import('../src/db.js');

after(async () => {
  await rm(DB_PATH, { force: true });
});

const TOKENS = {
  access_token: 'access_abc',
  refresh_token: 'refresh_xyz',
  expiry_date: Date.now() + 3_600_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

const noRevoke = async () => {
  throw new Error('revoke must not be called');
};

// ---------------------------------------------------------------------------
// assertSameAccount
// ---------------------------------------------------------------------------

describe('assertSameAccount', () => {
  it('accepts the same address', () => {
    assert.doesNotThrow(() => assertSameAccount('pro@gmail.com', 'pro@gmail.com'));
  });

  it('ignores case and surrounding spaces', () => {
    assert.doesNotThrow(() => assertSameAccount(' Pro@Gmail.com ', 'pro@gmail.com'));
  });

  it('rejects a different account and names both addresses', () => {
    assert.throws(
      () => assertSameAccount('pro@gmail.com', 'personal@gmail.com'),
      err =>
        err instanceof AccountMismatchError &&
        err.expected === 'pro@gmail.com' &&
        err.actual === 'personal@gmail.com' &&
        err.message.includes('No tokens were saved')
    );
  });

  it('rejects an empty or missing profile address', () => {
    assert.throws(() => assertSameAccount('pro@gmail.com', ''), AccountMismatchError);
    assert.throws(() => assertSameAccount('pro@gmail.com', undefined), AccountMismatchError);
  });

  it('treats a dotted variant as a different address, so From stays the real address', () => {
    assert.throws(
      () => assertSameAccount('first.last@gmail.com', 'firstlast@gmail.com'),
      AccountMismatchError
    );
  });
});

// ---------------------------------------------------------------------------
// storeVerifiedTokens
// ---------------------------------------------------------------------------

describe('storeVerifiedTokens', () => {
  it('stores tokens and label when the signed-in account matches', async () => {
    const owner = await storeVerifiedTokens('match@example.com', TOKENS, 'work', {
      fetchOwner: async () => 'Match@Example.com',
      revoke: noRevoke,
    });
    assert.equal(owner, 'Match@Example.com');
    const row = getTokens('match@example.com');
    assert.equal(row.refresh_token, 'refresh_xyz');
    assert.equal(row.label, 'work');
  });

  it('stores nothing and revokes the grant on a mismatch', async () => {
    const revoked = [];
    await assert.rejects(
      storeVerifiedTokens('pro@example.com', TOKENS, 'pro', {
        fetchOwner: async () => 'personal@example.com',
        revoke: async tokens => revoked.push(tokens),
      }),
      AccountMismatchError
    );
    assert.equal(getTokens('pro@example.com'), null);
    assert.deepEqual(revoked, [TOKENS]);
  });

  it('still reports the mismatch, and stores nothing, when revoking fails', async () => {
    await assert.rejects(
      storeVerifiedTokens('a@example.com', TOKENS, null, {
        fetchOwner: async () => 'b@example.com',
        revoke: async () => {
          throw new Error('network down');
        },
      }),
      AccountMismatchError
    );
    assert.equal(getTokens('a@example.com'), null);
  });

  it('stores nothing when the profile lookup fails', async () => {
    await assert.rejects(
      storeVerifiedTokens('c@example.com', TOKENS, null, {
        fetchOwner: async () => {
          throw new Error('Request failed with status code 403');
        },
        revoke: noRevoke,
      }),
      /403/
    );
    assert.equal(getTokens('c@example.com'), null);
  });

  it('leaves an existing account untouched when a re-auth signs in the wrong account', async () => {
    storeTokens('existing@example.com', TOKENS, 'pro');
    await assert.rejects(
      storeVerifiedTokens(
        'existing@example.com',
        { ...TOKENS, refresh_token: 'refresh_of_wrong_account' },
        'pro',
        { fetchOwner: async () => 'other@example.com', revoke: async () => {} }
      ),
      AccountMismatchError
    );
    assert.equal(getTokens('existing@example.com').refresh_token, 'refresh_xyz');
  });
});
