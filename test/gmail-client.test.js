import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Prevent db.js (pulled in transitively via auth.js) from touching the real DB
process.env.GMAIL_MCP_DB_PATH = '/tmp/gmail-test-unused.db';

const { extractBody, getHeader, buildRaw } = await import('../src/gmail-client.js');

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function decodeRaw(raw) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

// ---------------------------------------------------------------------------
// getHeader
// ---------------------------------------------------------------------------

describe('getHeader', () => {
  it('returns header value matched case-insensitively', () => {
    const headers = [{ name: 'From', value: 'alice@example.com' }];
    assert.equal(getHeader(headers, 'from'), 'alice@example.com');
    assert.equal(getHeader(headers, 'FROM'), 'alice@example.com');
    assert.equal(getHeader(headers, 'From'), 'alice@example.com');
  });

  it('returns empty string when header is absent', () => {
    const headers = [{ name: 'From', value: 'a@b.com' }];
    assert.equal(getHeader(headers, 'Subject'), '');
  });

  it('returns empty string for null headers', () => {
    assert.equal(getHeader(null, 'From'), '');
  });

  it('returns empty string for undefined headers', () => {
    assert.equal(getHeader(undefined, 'From'), '');
  });
});

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

describe('extractBody', () => {
  it('returns empty string for null payload', () => {
    assert.equal(extractBody(null), '');
  });

  it('returns empty string for payload with no body and no parts', () => {
    assert.equal(extractBody({}), '');
  });

  it('decodes body from root-level payload', () => {
    const payload = { body: { data: b64('Hello world') } };
    assert.equal(extractBody(payload), 'Hello world');
  });

  it('prefers text/plain over text/html in multipart', () => {
    const payload = {
      parts: [
        { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
        { mimeType: 'text/plain', body: { data: b64('plain text') } },
      ],
    };
    assert.equal(extractBody(payload), 'plain text');
  });

  it('falls back to text/html when no text/plain part exists', () => {
    const payload = {
      parts: [{ mimeType: 'text/html', body: { data: b64('<b>html only</b>') } }],
    };
    assert.equal(extractBody(payload), '<b>html only</b>');
  });

  it('recurses into nested multipart parts', () => {
    const innerPlain = { mimeType: 'text/plain', body: { data: b64('nested plain') } };
    const payload = {
      parts: [
        { mimeType: 'multipart/alternative', parts: [innerPlain], body: {} },
      ],
    };
    assert.equal(extractBody(payload), 'nested plain');
  });

  it('handles multi-byte UTF-8 content', () => {
    const text = 'こんにちは 🌍';
    const payload = { body: { data: Buffer.from(text, 'utf8').toString('base64') } };
    assert.equal(extractBody(payload), text);
  });

  it('returns empty string when parts array is empty', () => {
    assert.equal(extractBody({ parts: [] }), '');
  });
});

// ---------------------------------------------------------------------------
// buildRaw
// ---------------------------------------------------------------------------

describe('buildRaw', () => {
  it('includes required headers', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: 'Hello' })
    );
    assert.ok(decoded.includes('From: a@x.com'), 'missing From');
    assert.ok(decoded.includes('To: b@y.com'), 'missing To');
    assert.ok(decoded.includes('Subject: Hi'), 'missing Subject');
    assert.ok(decoded.includes('Content-Type: text/plain; charset=UTF-8'), 'missing Content-Type');
  });

  it('encodes non-ASCII subjects as RFC 2047 encoded-words', () => {
    const subject = 'Test \u2014 la bo\u00eete est op\u00e9rationnelle';
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject, body: '' })
    );
    const match = decoded.match(/Subject: =\?UTF-8\?B\?(.+)\?=/);
    assert.ok(match, 'subject is not an RFC 2047 encoded-word');
    assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), subject);
  });

  it('leaves ASCII-only subjects unencoded', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Plain subject', body: '' })
    );
    assert.ok(decoded.includes('Subject: Plain subject'));
  });

  it('separates headers from body with \\r\\n\\r\\n', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: 'Body text' })
    );
    assert.ok(decoded.includes('\r\n\r\nBody text'));
  });

  it('uses \\r\\n between header lines', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Test', body: '' })
    );
    const headerSection = decoded.split('\r\n\r\n')[0];
    assert.ok(headerSection.split('\r\n').length >= 4);
  });

  it('omits optional headers when not provided', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: '' })
    );
    assert.ok(!decoded.includes('Cc:'));
    assert.ok(!decoded.includes('Bcc:'));
    assert.ok(!decoded.includes('In-Reply-To:'));
    assert.ok(!decoded.includes('References:'));
  });

  it('includes Cc and Bcc when provided', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: '', cc: 'c@z.com', bcc: 'd@w.com' })
    );
    assert.ok(decoded.includes('Cc: c@z.com'));
    assert.ok(decoded.includes('Bcc: d@w.com'));
  });

  it('includes In-Reply-To and References for replies', () => {
    const decoded = decodeRaw(
      buildRaw({
        from: 'a@x.com', to: 'b@y.com', subject: 'Re: Hi', body: '',
        inReplyTo: '<msg1@mail.com>', references: '<msg1@mail.com>',
      })
    );
    assert.ok(decoded.includes('In-Reply-To: <msg1@mail.com>'));
    assert.ok(decoded.includes('References: <msg1@mail.com>'));
  });

  it('returns base64url encoding (no + or / characters)', () => {
    const raw = buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Test', body: 'test body' });
    assert.ok(raw.length > 0);
    assert.ok(!/[+/]/.test(raw), 'output contains standard base64 chars, not base64url');
  });
});
