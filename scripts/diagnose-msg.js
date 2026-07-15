/**
 * diagnose-msg.js — one-shot diagnostic for "pairing works but commands are
 * silently ignored (nothing in the logs)".
 *
 * NOT part of the service. Run by hand on the target host as the wabot user,
 * then — while it is running — send a WhatsApp message to the linked account
 * from another phone. It reuses the real buildClient() (so the paired session
 * loads) and prints the RAW whatsapp-web.js events, bypassing the router and
 * the whitelist entirely. This isolates WHERE messages disappear:
 *
 *   - 'message_create' fires but 'message' does NOT  → the sender is the
 *        linked account itself (msg.id.fromMe === true); wwebjs never emits
 *        'message' for your own messages. Test from a DIFFERENT phone.
 *   - NEITHER fires when you send a text          → wwebjs is not hooking the
 *        WhatsApp Web message store at all (library ↔ WhatsApp Web version
 *        mismatch). Upgrade whatsapp-web.js.
 *   - 'message' DOES fire here                    → transport is fine; the
 *        drop is in the router/whitelist. Compare the printed `from`/`body`
 *        against config.json (number format, exact command string).
 *
 * Usage (on the target host):
 *   sudo -u wabot PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
 *     WABOT_CONFIG=/opt/whatsapp-shell-bot/config.json \
 *     /usr/bin/node /opt/whatsapp-shell-bot/scripts/diagnose-msg.js
 *
 * Stop with Ctrl+C when done. Runs at most DIAG_TIMEOUT_MS (default 180s).
 *
 * SAFETY: read-only. It never executes commands and never sends a reply —
 * it only observes and logs. Safe to run against the live paired session
 * (but stop the systemd service first so two clients don't fight over the
 * same session profile lock).
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { buildClient } = require('../src/auth');
const { isGroupMessage, isNumberWhitelisted, validateCommand } = require('../src/whitelist');

const CONFIG_PATH = process.env.WABOT_CONFIG || path.join(__dirname, '..', 'config.json');
const HARD_TIMEOUT_MS = Number(process.env.DIAG_TIMEOUT_MS || 180000);

function log(...a) {
  // eslint-disable-next-line no-console
  console.log(`+${process.uptime().toFixed(1)}s`, ...a);
}

function describe(tag, msg) {
  // Pull the fields the router/whitelist actually care about, defensively.
  const id = (msg && msg.id) || {};
  const info = {
    tag,
    fromMe: id.fromMe,
    from: msg && msg.from,
    to: msg && msg.to,
    author: msg && msg.author, // set in groups
    type: msg && msg.type,
    isGroup: isGroupMessage(msg),
    deviceType: msg && msg.deviceType,
    bodyPreview: typeof (msg && msg.body) === 'string' ? msg.body.slice(0, 120) : `(type ${typeof (msg && msg.body)})`,
  };
  log('EVENT', JSON.stringify(info));
  return info;
}

(async function main() {
  log('diagnose-msg start — send a WhatsApp text to the linked account now.');
  if (!fs.existsSync(CONFIG_PATH)) {
    log('FATAL: config not found at', CONFIG_PATH);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const numbers = (cfg.whitelist && cfg.whitelist.numbers) || [];
  const commands = (cfg.whitelist && cfg.whitelist.commands) || [];
  log(`whitelist: ${numbers.length} number(s), ${commands.length} command(s)`);
  log('whitelisted numbers:', JSON.stringify(numbers));
  log('whitelisted command strings:', JSON.stringify(commands.map((c) => c && c.command)));

  const client = buildClient(cfg);

  let sawMessage = false;
  let sawCreate = false;

  client.on('ready', () => log('READY — client is live and listening.'));
  client.on('change_state', (s) => log('change_state', s));
  client.on('disconnected', (r) => log('disconnected', r));

  // The event the service actually listens on.
  client.on('message', (msg) => {
    sawMessage = true;
    const info = describe('message', msg);
    // Replay the exact router gates, read-only, so we see WHY it would drop.
    const sender = (info.from || '').split('@')[0].replace(/[^\d]/g, '');
    if (info.isGroup) {
      log('  → router would DROP: group message (allowedFromGroups is WhatsApp-filtered).');
      return;
    }
    if (!isNumberWhitelisted(sender, numbers)) {
      log(`  → router would log 'unknown_number': sender "${sender}" not in whitelist.`);
      return;
    }
    const v = validateCommand(typeof msg.body === 'string' ? msg.body : '', commands);
    if (!v.ok) {
      log(`  → router would log 'rejected': reason=${v.reason} (body must EXACTLY equal a whitelisted command).`);
      return;
    }
    log(`  → router would EXECUTE command "${v.entry.name}". Transport + whitelist are FINE.`);
  });

  // Fires for ALL messages incl. your own — used to detect the fromMe case.
  client.on('message_create', (msg) => {
    sawCreate = true;
    const info = describe('message_create', msg);
    if (info.fromMe) {
      log('  → this is one of YOUR OWN messages (fromMe=true). wwebjs will NOT emit "message" for it.');
      log('    If this is the only event you see, you are testing from the linked account. Use another phone.');
    }
  });

  const hard = setTimeout(() => {
    log(`--- TIMEOUT after ${HARD_TIMEOUT_MS}ms ---`);
    log(`saw 'message' event: ${sawMessage}; saw 'message_create' event: ${sawCreate}`);
    if (!sawMessage && !sawCreate) {
      log('VERDICT: NEITHER event fired. Either you sent nothing, or (more likely) this');
      log('whatsapp-web.js build is not hooking the current WhatsApp Web message store —');
      log('a library ↔ WhatsApp Web version mismatch. Fix: upgrade whatsapp-web.js.');
    } else if (sawCreate && !sawMessage) {
      log('VERDICT: only message_create fired → every test message was fromMe. Send from ANOTHER phone.');
    } else if (sawMessage) {
      log('VERDICT: message events DO fire → the transport is fine; investigate router/whitelist per the per-event notes above.');
    }
    process.exit(0);
  }, HARD_TIMEOUT_MS);
  hard.unref();

  try {
    log('calling client.initialize() …');
    await client.initialize();
    log('initialize() returned. Now SEND A MESSAGE from another phone and watch for EVENT lines.');
  } catch (err) {
    clearTimeout(hard);
    log('client.initialize() THREW:', err && err.stack ? err.stack : String(err));
    process.exit(2);
  }
})();
