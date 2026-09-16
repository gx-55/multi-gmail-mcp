import { google } from 'googleapis';
import { getAuthenticatedClient, wrapTokenError } from './auth.js';

async function getGmail(email) {
  const auth = await getAuthenticatedClient(email);
  return { gmail: google.gmail({ version: 'v1', auth }), email };
}

// Runs a Gmail API call and converts token errors into friendly TokenRefreshErrors
async function run(email, fn) {
  try {
    return await fn();
  } catch (err) {
    wrapTokenError(email, err);
  }
}

export function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function extractBody(payload) {
  if (!payload) return '';

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  return '';
}

// 39 bytes -> 52 base64 chars + 12 for "=?UTF-8?B??=" = 64, so "Subject: " + word stays under 76
const ENCODED_WORD_MAX_BYTES = 39;

// CR/LF inside a value would start a new header line (header injection)
function headerText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

function needsEncoding(text) {
  return !/^[\x20-\x7E\t]*$/.test(text) || text.includes('=?');
}

// RFC 2047 encoded-words, each at most 75 chars; iterating by code point never splits a character
function encodeWords(text) {
  const chunks = [];
  let chunk = '';
  for (const char of text) {
    if (chunk && Buffer.byteLength(chunk + char) > ENCODED_WORD_MAX_BYTES) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(c => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function encodeText(value) {
  const text = headerText(value);
  return needsEncoding(text) ? encodeWords(text) : text;
}

// Splits on commas outside quotes and <...>; a piece without "@" is the start of a name like "Doe, John <j@x>"
function splitAddresses(list) {
  const pieces = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if (quoted && char === '\\') {
      current += char + (list[++i] ?? '');
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') angle = true;
    else if (!quoted && char === '>') angle = false;
    if (char === ',' && !quoted && !angle) {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);

  const addresses = [];
  let pending = '';
  for (const piece of pieces) {
    const merged = pending ? `${pending},${piece}` : piece;
    if (merged.includes('@')) {
      addresses.push(merged.trim());
      pending = '';
    } else {
      pending = merged;
    }
  }
  if (pending.trim()) addresses.push(pending.trim());
  return addresses.filter(Boolean);
}

// Encodes only the display name; the address inside <...> is left untouched
function encodeAddress(address) {
  const match = address.match(/^(.*?)\s*<([^<>]*)>$/s);
  if (!match || !match[1]) return address;
  let name = match[1];
  const isQuoted = name.length >= 2 && name.startsWith('"') && name.endsWith('"');
  if (isQuoted) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  if (needsEncoding(name)) return `${encodeWords(name)} <${match[2]}>`;
  if (isQuoted || !/[(),.:;<>@[\\\]"]/.test(name)) return address;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${match[2]}>`;
}

function encodeAddressList(value) {
  return splitAddresses(headerText(value)).map(encodeAddress).join(',\r\n ');
}

export function buildRaw({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${encodeAddressList(from)}`,
    `To: ${encodeAddressList(to)}`,
    cc ? `Cc: ${encodeAddressList(cc)}` : null,
    bcc ? `Bcc: ${encodeAddressList(bcc)}` : null,
    `Subject: ${encodeText(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    inReplyTo ? `In-Reply-To: ${headerText(inReplyTo)}` : null,
    references ? `References: ${headerText(references)}` : null,
  ].filter(Boolean);

  const encodedBody = Buffer.from(String(body ?? '').replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}(?=.)/g, '$&\r\n');

  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + encodedBody).toString('base64url');
}

export async function searchEmails(email, query, maxResults = 10) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    if (!listRes.data.messages?.length) return [];

    const messages = await Promise.all(
      listRes.data.messages.map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        })
      )
    );

    return messages.map(({ data: msg }) => ({
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(msg.payload?.headers, 'From'),
      to: getHeader(msg.payload?.headers, 'To'),
      subject: getHeader(msg.payload?.headers, 'Subject'),
      date: getHeader(msg.payload?.headers, 'Date'),
      snippet: msg.snippet,
      labels: msg.labelIds ?? [],
    }));
  });
}

export async function getEmail(email, messageId) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(msg.payload?.headers, 'From'),
      to: getHeader(msg.payload?.headers, 'To'),
      cc: getHeader(msg.payload?.headers, 'Cc'),
      subject: getHeader(msg.payload?.headers, 'Subject'),
      date: getHeader(msg.payload?.headers, 'Date'),
      messageId: getHeader(msg.payload?.headers, 'Message-ID'),
      references: getHeader(msg.payload?.headers, 'References'),
      body: extractBody(msg.payload),
      labels: msg.labelIds ?? [],
    };
  });
}

export async function sendEmail(email, { to, subject, body, cc, bcc }) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const raw = buildRaw({ from: email, to, cc, bcc, subject, body });
    const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return data;
  });
}

export async function replyToEmail(email, messageId, body) {
  const original = await getEmail(email, messageId);
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const subject = original.subject.startsWith('Re: ')
      ? original.subject
      : `Re: ${original.subject}`;
    const references = original.references
      ? `${original.references} ${original.messageId}`
      : original.messageId;
    const raw = buildRaw({
      from: email,
      to: original.from,
      subject,
      body,
      inReplyTo: original.messageId,
      references,
    });
    const { data } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: original.threadId },
    });
    return data;
  });
}

export async function createDraft(email, { to, subject, body, cc, bcc }) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const raw = buildRaw({ from: email, to, cc, bcc, subject, body });
    const { data } = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });
    return data;
  });
}

export async function listLabels(email) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    return data.labels ?? [];
  });
}

export async function modifyLabels(email, messageId, addLabelIds = [], removeLabelIds = []) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    return data;
  });
}
