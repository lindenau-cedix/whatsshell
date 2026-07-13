/**
 * Authentication: QR-code rendering and session persistence.
 *
 * The first time the bot starts it must display a scannable QR code in the
 * terminal. Subsequent starts reuse the persisted LocalAuth credentials, so
 * the user only has to scan once per server.
 *
 * Headless detection: when started under systemd the bot has no TTY. In
 * that mode the admin must first start the bot in the foreground ONCE to
 * complete the QR pairing, then Ctrl+C and start the service normally.
 * We detect the missing TTY up front and abort with a clear message.
 *
 * Decision: we do NOT try to generate a QR image, send it to a chat, or
 * e-mail it. That would only create extra attack surface. The terminal
 * approach is the only one that keeps the QR local.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const { getLogger } = require('./logger');

/**
 * ANSI helpers — keep the screen-flicker contained.
 */
const ANSI_CLEAR = '\x1b[2J\x1b[H';
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD_GREEN = '\x1b[1;32m';
const ANSI_BOLD_YELLOW = '\x1b[1;33m';
const ANSI_BOLD_CYAN = '\x1b[1;36m';

/**
 * Pre-flight check: do we have a terminal to draw the QR into?
 * If not, abort with a precise instruction for the operator.
 */
function assertTTY() {
  if (!process.stdout.isTTY) {
    const msg =
      'Kein TTY erkannt. Bitte starte den Service zum QR-Scan manuell im ' +
      'Vordergrund: `sudo systemctl stop whatsapp-shell-bot && ' +
      'sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js`. ' +
      'Nach erfolgreichem Scan mit Ctrl+C abbrechen und ' +
      '`sudo systemctl start whatsapp-shell-bot`.';
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

/**
 * Render a fresh QR code in the terminal, clearing the previous one.
 *
 * Decision: We use small=false and force a width of at least 80 columns so
 * the QR is genuinely scannable. The default qrcode-terminal output has a
 * configurable `small` mode but even that can be hard to scan from far
 * away — we keep the cells full-size and let the terminal wrap.
 */
function renderQR(qrPayload, opts = {}) {
  const small = opts.small === true;
  // Clear screen so the previous QR doesn't ghost behind the new one.
  process.stdout.write(ANSI_CLEAR);
  process.stdout.write(`${ANSI_BOLD_CYAN}=== WhatsApp QR-Code ===${ANSI_RESET}\n`);
  process.stdout.write(
    `${ANSI_BOLD_YELLOW}Scanne diesen Code mit WhatsApp > Verknüpfte Geräte.${ANSI_RESET}\n\n`
  );

  // qrcode-terminal writes directly to process.stdout — we can't redirect.
  // The clear above ensures the previous frame is gone.
  qrcodeTerminal.generate(qrPayload, { small });
  process.stdout.write('\n');
}

/**
 * Build a configured whatsapp-web.js Client.
 *
 * @param {object} cfg  Parsed config.json
 * @returns {Client}
 */
function buildClient(cfg) {
  const sessionPath = cfg.whatsapp.sessionPath;

  // Make sure the directory exists — LocalAuth writes a chromium-style
  // session into it on successful login.
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true, mode: 0o750 });
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionPath,
    }),
    puppeteer: {
      headless: true,
      // We pass the path to the system Chromium that the install script
      // installs via apt. If you want to use a different one, set
      // PUPPETEER_EXECUTABLE_PATH in the environment.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  return client;
}

/**
 * Wire up the QR event handlers. The two callbacks split the responsibility:
 *
 * - onQR(qr): called every time whatsapp-web.js emits a new QR payload
 *   (~20s cadence). We render it live.
 * - onAuthenticated(): called the moment the device is paired. We wipe the
 *   QR frame and announce the success state.
 *
 * @param {Client} client
 * @param {object} cfg
 */
function wireAuthEvents(client, cfg) {
  const logger = getLogger();
  let qrRendered = false;
  let lastQrTimestamp = 0;
  const refreshMs = (cfg.whatsapp.qrRefreshSeconds || 20) * 1000;
  const qrTimeoutMs = (cfg.whatsapp.qrTimeoutMinutes || 30) * 60 * 1000;
  let qrFirstSeen = null;
  let qrTimer = null;

  client.on('qr', (qr) => {
    if (qrFirstSeen === null) {
      qrFirstSeen = Date.now();
      logger.info('QR-Code empfangen — warte auf Scan.');
    }

    // Throttle: only re-render if the QR payload is new.
    const now = Date.now();
    if (now - lastQrTimestamp < 500) return;
    lastQrTimestamp = now;

    renderQR(qr, { small: !!cfg.whatsapp.qrSmall });
    qrRendered = true;

    // Hard timeout — after 30 minutes give up.
    if (qrTimer) clearTimeout(qrTimer);
    qrTimer = setTimeout(() => {
      logger.error(`QR-Code-Timeout nach ${cfg.whatsapp.qrTimeoutMinutes} Minuten.`);
      // eslint-disable-next-line no-console
      console.error(`\n${ANSI_BOLD_YELLOW}QR-Code-Timeout. Bitte Service neu starten.${ANSI_RESET}\n`);
      process.exit(2);
    }, qrTimeoutMs);
  });

  client.on('authenticated', () => {
    if (qrTimer) clearTimeout(qrTimer);
    logger.info('WhatsApp-Authentifizierung erfolgreich.');
    process.stdout.write(ANSI_CLEAR);
    process.stdout.write(
      `${ANSI_BOLD_GREEN}✅ WhatsApp authentifiziert. Warte auf Ready-Event …${ANSI_RESET}\n\n`
    );
  });

  client.on('auth_failure', (msg) => {
    logger.error(`WhatsApp-Authentifizierung fehlgeschlagen: ${msg}`);
    process.stdout.write(ANSI_CLEAR);
    process.stdout.write(
      `${ANSI_BOLD_YELLOW}❌ WhatsApp-Authentifizierung fehlgeschlagen: ${msg}${ANSI_RESET}\n\n`
    );
    // We don't exit here — the ready event may still arrive if whatsapp-web.js
    // recovers. The user can manually restart the service.
  });

  client.on('ready', () => {
    const info = client.info || {};
    const pushname = info.pushname || 'unbekannt';
    const wid = (info.wid && info.wid._serialized) || info.me || '';
    const number = wid.replace('@c.us', '');
    process.stdout.write(ANSI_CLEAR);
    process.stdout.write(
      `${ANSI_BOLD_GREEN}✅ WhatsApp verbunden als ${pushname} (${number})${ANSI_RESET}\n\n`
    );
    logger.info(`WhatsApp verbunden als ${pushname} (${number}).`);
  });

  client.on('disconnected', (reason) => {
    logger.warn(`WhatsApp getrennt: ${reason}`);
  });

  // Suppress an unused-variable warning for qrRendered — kept for future
  // debugging hooks.
  void qrRendered;
}

module.exports = {
  assertTTY,
  buildClient,
  wireAuthEvents,
};