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

  it('separates headers from a base64 body with \\r\\n\\r\\n', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: 'Body text' })
    );
    assert.ok(decoded.includes(`\r\n\r\n${b64('Body text')}`));
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

  it('declares MIME 1.0 and base64 transfer encoding for a UTF-8 body', () => {
    const body = 'Привет,\nмир 🌍';
    const decoded = decodeRaw(buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body }));
    const [headers, encodedBody] = decoded.split('\r\n\r\n');
    assert.ok(headers.includes('MIME-Version: 1.0'));
    assert.ok(headers.includes('Content-Transfer-Encoding: base64'));
    assert.equal(Buffer.from(encodedBody, 'base64').toString('utf8'), 'Привет,\r\nмир 🌍');
  });

  it('wraps base64 body lines at 76 characters', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: 'Длинная строка '.repeat(50) })
    );
    const lines = decoded.split('\r\n\r\n')[1].split('\r\n');
    assert.ok(lines.length > 1);
    assert.ok(lines.every(l => l.length <= 76));
  });

  it('encodes non-ASCII subjects as RFC 2047 encoded-words', () => {
    const subject = 'Внешний API: ошибка 8100 при создании message-кампании 🧪';
    const decoded = decodeRaw(buildRaw({ from: 'a@x.com', to: 'b@y.com', subject, body: '' }));
    const headers = decoded.split('\r\n\r\n')[0];
    assert.ok(/^[\x00-\x7F]*$/.test(headers), 'headers must be ASCII');
    const subjectHeader = headers.match(/^Subject: (.*(?:\r\n .*)*)/m)[1];
    const words = subjectHeader.split('\r\n ');
    assert.ok(words.length > 1, 'long subject should be split into several encoded-words');
    const text = words.map(w => {
      assert.ok(w.length <= 75, `encoded-word too long: ${w.length}`);
      const m = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
      assert.ok(m, `not an encoded-word: ${w}`);
      const part = Buffer.from(m[1], 'base64').toString('utf8');
      assert.ok(!part.includes('\uFFFD'), 'multi-byte character split across encoded-words');
      return part;
    }).join('');
    assert.equal(text, subject);
  });

  it('leaves ASCII-only subjects unencoded', () => {
    const decoded = decodeRaw(buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Plain subject', body: '' }));
    assert.ok(decoded.includes('Subject: Plain subject\r\n'));
  });

  it('encodes an ASCII subject that looks like an encoded-word', () => {
    const decoded = decodeRaw(buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: '=?UTF-8?B?QQ==?=', body: '' }));
    assert.ok(!decoded.includes('Subject: =?UTF-8?B?QQ==?=\r\n'));
  });

  it('strips CR/LF from header values to prevent header injection', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi\r\nBcc: evil@z.com', body: '' })
    );
    assert.ok(!decoded.includes('\r\nBcc:'));
    assert.ok(decoded.includes('Subject: Hi Bcc: evil@z.com\r\n'));
  });

  it('encodes non-ASCII display names but leaves addresses untouched', () => {
    const decoded = decodeRaw(
      buildRaw({
        from: 'a@x.com',
        to: 'Иван Петров <ivan@example.ru>, plain@example.com',
        cc: '"Петров, Иван" <p@example.ru>',
        subject: 'Hi',
        body: '',
      })
    );
    assert.ok(decoded.includes(`To: =?UTF-8?B?${b64('Иван Петров')}?= <ivan@example.ru>,\r\n plain@example.com\r\n`));
    assert.ok(decoded.includes(`Cc: =?UTF-8?B?${b64('Петров, Иван')}?= <p@example.ru>\r\n`));
  });

  it('quotes ASCII display names that contain a comma', () => {
    const decoded = decodeRaw(
      buildRaw({ from: 'a@x.com', to: 'Doe, John <jdoe@example.com>, "Smith, Ann" <ann@example.com>', subject: 'Hi', body: '' })
    );
    assert.ok(decoded.includes('To: "Doe, John" <jdoe@example.com>,\r\n "Smith, Ann" <ann@example.com>\r\n'));
  });
});
