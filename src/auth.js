import { google } from 'googleapis';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { URL } from 'url';
import { getTokens, storeTokens } from './db.js';

const OAUTH_FILE = join(homedir(), '.gmail-mcp-oauth.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

// Thrown when a token refresh fails due to revocation or expiry
export class TokenRefreshError extends Error {
  constructor(email) {
    super(
      `Token for "${email}" is invalid or has been revoked. ` +
        `Re-authenticate by running: gmail-mcp-cli add ${email}`
    );
    this.name = 'TokenRefreshError';
    this.email = email;
  }
}

// Call this in catch blocks inside gmail-client.js to surface token errors cleanly
export function wrapTokenError(email, err) {
  const msg = (err.message ?? '').toLowerCase();
  const isTokenError =
    err.status === 401 ||
    err.code === 401 ||
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired') ||
    msg.includes('token has been revoked') ||
    msg.includes('invalid credentials');

  if (isTokenError) throw new TokenRefreshError(email);
  throw err;
}

function getClientCredentials() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  try {
    const data = JSON.parse(readFileSync(OAUTH_FILE, 'utf8'));
    const creds = data.installed || data.web;
    return { clientId: creds.client_id, clientSecret: creds.client_secret };
  } catch {
    throw new Error(
      'No OAuth credentials found. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars ' +
        'or place your credentials JSON at ~/.gmail-mcp-oauth.json'
    );
  }
}

export async function getAuthenticatedClient(email) {
  const { clientId, clientSecret } = getClientCredentials();
  const stored = getTokens(email);
  if (!stored) {
    throw new Error(`Account "${email}" not found. Authenticate it first with initiate_auth.`);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry ? new Date(stored.expiry).getTime() : undefined,
  });

  // Persist refreshed tokens automatically
  oauth2Client.on('tokens', (tokens) => {
    storeTokens(email, {
      access_token: tokens.access_token ?? stored.access_token,
      refresh_token: tokens.refresh_token ?? stored.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope ?? stored.scopes,
    });
  });

  return oauth2Client;
}

// Lightweight token health check — calls users.getProfile which is minimal overhead
export async function checkAuthStatus(email) {
  try {
    const auth = await getAuthenticatedClient(email);
    const gmail = google.gmail({ version: 'v1', auth });
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    return {
      email,
      valid: true,
      messagesTotal: data.messagesTotal,
    };
  } catch (err) {
    const msg = (err.message ?? '').toLowerCase();
    const isTokenError =
      err.status === 401 ||
      err.code === 401 ||
      msg.includes('invalid_grant') ||
      msg.includes('token has been expired') ||
      msg.includes('token has been revoked') ||
      msg.includes('invalid credentials');

    return {
      email,
      valid: false,
      needsReauth: isTokenError,
      error: isTokenError
        ? `Token expired or revoked. Run: gmail-mcp-cli add ${email}`
        : err.message,
    };
  }
}

export function initiateAuth() {
  const { clientId, clientSecret } = getClientCredentials();

  return new Promise((resolveSetup, rejectSetup) => {
    const server = createServer();

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}`;
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });

      const tokenPromise = new Promise((resolveToken, rejectToken) => {
        const timeout = setTimeout(() => {
          server.close();
          rejectToken(new Error('Authentication timed out after 5 minutes'));
        }, 5 * 60 * 1000);

        server.on('request', async (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost');
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Authentication failed</h1><p>You can close this tab.</p>');
              clearTimeout(timeout);
              server.close();
              rejectToken(new Error(`OAuth error: ${error}`));
              return;
            }

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(
                '<h1>Authentication successful!</h1>' +
                  '<p>You can close this tab and return to Claude.</p>'
              );
              const { tokens } = await oauth2Client.getToken(code);
              clearTimeout(timeout);
              server.close();
              resolveToken(tokens);
            }
          } catch (err) {
            clearTimeout(timeout);
            server.close();
            rejectToken(err);
          }
        });
      });

      resolveSetup({ authUrl, tokenPromise });
    });

    server.on('error', rejectSetup);
  });
}

// Thrown when the Google account that signed in is not the address being added
export class AccountMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `Signed in as "${actual}", but the account being added is "${expected}". ` +
        "No tokens were saved. Sign in again and pick that account in Google's account chooser, " +
        `or add ${actual} under its own address.`
    );
    this.name = 'AccountMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// The stored address becomes the From header of every message sent, so it must be the
// address of the account that granted the tokens. Case and surrounding spaces are
// ignored; Gmail's dot-insensitivity is not, on purpose, so that From always carries the
// account's real address.
export function assertSameAccount(expected, actual) {
  const norm = value => String(value ?? '').trim().toLowerCase();
  if (!norm(actual) || norm(expected) !== norm(actual)) {
    throw new AccountMismatchError(expected, actual);
  }
}

function oauthClientFor(tokens) {
  const { clientId, clientSecret } = getClientCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials(tokens);
  return client;
}

// Asks Gmail which account freshly granted tokens belong to (getProfile needs no extra scope)
async function fetchTokenOwner(tokens) {
  const gmail = google.gmail({ version: 'v1', auth: oauthClientFor(tokens) });
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  return data.emailAddress;
}

// Withdraws a grant that will not be stored, so the wrong account is not left with an
// orphaned "access granted" entry in its Google security settings
async function revokeTokens(tokens) {
  const token = tokens.refresh_token ?? tokens.access_token;
  if (token) await oauthClientFor(tokens).revokeToken(token);
}

// Stores tokens only once Gmail confirms they belong to `email`. On a mismatch nothing is
// stored (an existing account keeps its previous tokens), the grant is revoked on a best-
// effort basis, and an AccountMismatchError is thrown.
export async function storeVerifiedTokens(
  email,
  tokens,
  label = null,
  { fetchOwner = fetchTokenOwner, revoke = revokeTokens, store = storeTokens } = {}
) {
  const owner = await fetchOwner(tokens);
  try {
    assertSameAccount(email, owner);
  } catch (err) {
    try {
      await revoke(tokens);
    } catch (revokeErr) {
      console.error(`[gmail-mcp] could not revoke the grant for ${owner}: ${revokeErr.message}`);
    }
    throw err;
  }
  store(email, tokens, label);
  return owner;
}
