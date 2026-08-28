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

// Encodes a header value as an RFC 2047 encoded-word when it contains
// non-ASCII characters (raw UTF-8 is not valid in message headers and
// renders as mojibake in receiving clients).
function encodeHeader(value) {
  if (!value || /^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildRaw({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'Content-Type: text/plain; charset=UTF-8',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean);

  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body).toString('base64url');
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
