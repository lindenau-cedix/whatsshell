/**
 * diagnose-qr.js — one-shot diagnostic for "no QR code appears".
 *
 * This is NOT part of the service. Run it by hand on the target host, as the
 * same user the service uses, to find out WHERE client.initialize() is
 * hanging. It reuses the real buildClient() (so the Chromium executablePath
 * and HOME workarounds apply) but:
 *
 *   - flips puppeteer `dumpio` on, so Chromium's OWN stdout/stderr is printed
 *     (the packaged build prints the crashpad / sandbox / missing-.so errors
 *     there, and the normal service swallows them);
 *   - subscribes to every init-relevant event (qr, loading_screen,
 *     change_state, authenticated, auth_failure, disconnected);
 *   - prints a heartbeat every 2s and the resolved Chromium version, so a
 *     hang in browser-launch vs page.goto vs inject is distinguishable;
 *   - hard-exits after a bounded time instead of hanging forever.
 *
 * Usage (on the target host):
 *   sudo -u wabot PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
 *     WABOT_CONFIG=/opt/whatsapp-shell-bot/config.json \
 *     /usr/bin/node /opt/whatsapp-shell-bot/scripts/diagnose-qr.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { buildClient } = require('../src/auth');

const CONFIG_PATH = process.env.WABOT_CONFIG || path.join(__dirname, '..', 'config.json');
const HARD_TIMEOUT_MS = Number(process.env.DIAG_TIMEOUT_MS || 90000);

function stamp() {
  // No Date import gymnastics — process.uptime() is monotonic and enough here.
  return `+${process.uptime().toFixed(1)}s`;
}
function log(...a) {
  // eslint-disable-next-line no-console
  console.log(stamp(), ...a);
}

(async function main() {
  log('diagnose-qr start');
  log('node', process.version, 'platform', process.platform, 'uid', process.getuid());
  log('CONFIG_PATH', CONFIG_PATH);
  log('PUPPETEER_EXECUTABLE_PATH', process.env.PUPPETEER_EXECUTABLE_PATH || '(unset → buildClient default)');

  if (!fs.existsSync(CONFIG_PATH)) {
    log('FATAL: config not found at', CONFIG_PATH);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const sessionPath = cfg.whatsapp && cfg.whatsapp.sessionPath;
  log('sessionPath', sessionPath);
  try {
    const entries = fs.existsSync(sessionPath) ? fs.readdirSync(sessionPath) : null;
    log('session dir:', entries === null ? 'MISSING' : `${entries.length} entries ${JSON.stringify(entries)}`);
  } catch (e) {
    log('session dir stat error:', e.message);
  }

  const client = buildClient(cfg);
  log('resolved executablePath:', client.options.puppeteer.executablePath);
  log('chromium HOME override:', client.options.puppeteer.env && client.options.puppeteer.env.HOME);

  // Surface Chromium's own console output — the crucial bit the service hides.
  client.options.puppeteer.dumpio = true;

  // Heartbeat so a hang is visibly a hang (and we see which step we're stuck in).
  let lastMilestone = 'constructed';
  const beat = setInterval(() => log('… still alive, last milestone:', lastMilestone), 2000);
  beat.unref();

  client.on('qr', () => {
    lastMilestone = 'qr';
    log('✅ QR EVENT FIRED — the bot CAN reach this point. Rendering is the only remaining question.');
    log('   → QR received. Exiting diagnostic (success).');
    clearInterval(beat);
    setTimeout(() => process.exit(0), 100);
  });
  client.on('loading_screen', (percent, message) =>
    log('loading_screen', `${percent}%`, message)
  );
  client.on('change_state', (state) => {
    lastMilestone = `state:${state}`;
    log('change_state', state);
  });
  client.on('authenticated', () => log('authenticated (existing session was valid — no QR needed)'));
  client.on('auth_failure', (m) => log('auth_failure', m));
  client.on('disconnected', (r) => log('disconnected', r));

  const hard = setTimeout(() => {
    log(`HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms. Stuck at milestone: ${lastMilestone}.`);
    log('Interpretation:');
    log('  - stuck at "constructed"  → Chromium never launched. Look ABOVE for chromium stderr');
    log('     (missing .so, "No usable sandbox", crashpad --database, bad executablePath).');
    log('  - stuck after launch, no loading_screen/qr → page.goto to web.whatsapp.com is');
    log('     blocked (no egress / DNS / proxy). timeout:0 means it waits forever.');
    process.exit(3);
  }, HARD_TIMEOUT_MS);
  hard.unref();

  try {
    lastMilestone = 'initialize:calling';
    log('calling client.initialize() …');
    await client.initialize();
    lastMilestone = 'initialize:returned';
    log('client.initialize() returned without throwing.');
  } catch (err) {
    clearTimeout(hard);
    log('❌ client.initialize() THREW:');
    log(err && err.stack ? err.stack : String(err));
    process.exit(2);
  }
})();
