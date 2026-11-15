#!/usr/bin/env node
/**
 * CLI helper for managing Gmail accounts outside of Claude Desktop.
 *
 * Usage:
 *   node src/cli.js list
 *   node src/cli.js add   <email> [--label <name>]
 *   node src/cli.js label <email> <label>
 *   node src/cli.js remove <email>
 *   node src/cli.js version
 *   node src/cli.js update
 */
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { listAccounts, removeAccount, setLabel, resolveEmail } from './db.js';
import { initiateAuth, storeVerifiedTokens } from './auth.js';

const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../package.json');

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(arr) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].startsWith('--') && i + 1 < arr.length) {
      flags[arr[i].slice(2)] = arr[++i];
    } else {
      positional.push(arr[i]);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(args.slice(1));

switch (command) {
  case 'list': {
    const accounts = listAccounts();
    if (!accounts.length) {
      console.log('No authenticated accounts.');
    } else {
      console.log('Authenticated Gmail accounts:');
      accounts.forEach(({ email, label }) => {
        const tag = label ? ` [${label}]` : '';
        console.log(`  • ${email}${tag}`);
      });
    }
    break;
  }

  case 'add': {
    const email = positional[0];
    const label = flags.label ?? null;
    if (!email) {
      console.error('Usage: gmail-mcp-cli add <email> [--label <name>]');
      process.exit(1);
    }
    console.log(`Starting authentication for ${email}...`);
    const session = await initiateAuth();
    console.log('\nOpen this URL in your browser to authenticate:\n');
    console.log(session.authUrl);
    console.log('\nWaiting for you to complete sign-in...');
    try {
      const { default: open } = await import('open');
      await open(session.authUrl);
    } catch {
      // open is optional
    }
    const tokens = await session.tokenPromise;
    try {
      await storeVerifiedTokens(email, tokens, label);
    } catch (err) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    const labelMsg = label ? ` with label "${label}"` : '';
    console.log(`\nSuccessfully authenticated ${email}${labelMsg}!`);
    break;
  }

  case 'label': {
    const email = positional[0];
    const label = positional[1];
    if (!email || !label) {
      console.error('Usage: gmail-mcp-cli label <email> <label>');
      process.exit(1);
    }
    const resolved = resolveEmail(email);
    if (!resolved) {
      console.error(`Account not found: ${email}`);
      process.exit(1);
    }
    setLabel(resolved, label);
    console.log(`Label "${label}" set for ${resolved}`);
    break;
  }

  case 'remove': {
    const email = positional[0];
    if (!email) {
      console.error('Usage: gmail-mcp-cli remove <email>');
      process.exit(1);
    }
    const resolved = resolveEmail(email);
    if (!resolved) {
      console.error(`Account not found: ${email}`);
      process.exit(1);
    }
    removeAccount(resolved);
    console.log(`Removed account: ${resolved}`);
    break;
  }

  case 'version': {
    const latestVersion = execSync('npm view multi-gmail-mcp version 2>/dev/null').toString().trim();
    console.log(`multi-gmail-mcp v${currentVersion}`);
    if (latestVersion && latestVersion !== currentVersion) {
      console.log(`Latest: v${latestVersion} — run "gmail-mcp-cli update" to upgrade`);
    } else {
      console.log('You are on the latest version.');
    }
    break;
  }

  case 'update': {
    const latestVersion = execSync('npm view multi-gmail-mcp version 2>/dev/null').toString().trim();
    if (latestVersion === currentVersion) {
      console.log(`Already on the latest version (v${currentVersion}).`);
      break;
    }
    console.log(`Updating multi-gmail-mcp from v${currentVersion} → v${latestVersion}...`);
    execSync('npm install -g multi-gmail-mcp@latest', { stdio: 'inherit' });
    console.log(`\nUpdated to v${latestVersion}. Restart Claude Desktop to apply changes.`);
    break;
  }

  default: {
    console.log(`Usage:
  gmail-mcp-cli list                        List authenticated accounts
  gmail-mcp-cli add <email> [--label name]  Authenticate a Gmail account
  gmail-mcp-cli label <email> <label>       Set or update a label for an account
  gmail-mcp-cli remove <email|label>        Remove a Gmail account
  gmail-mcp-cli version                     Show current and latest version
  gmail-mcp-cli update                      Update to the latest version`);
    if (command) process.exit(1);
  }
}
