/**
 * Entry point.
 *
 * Boot sequence:
 *   1. Load + parse config.json
 *   2. Initialise winston logger (file + optional console)
 *   3. TTY pre-flight check — fail fast if no terminal for QR scan
 *   4. Build whatsapp-web.js client with LocalAuth
 *   5. Wire QR/auth events
 *   6. Build router
 *   7. Initialise WhatsApp client and install message listener
 *   8. If sms.enabled → boot SMS HTTP server, register cleanup
 *   9. fs.watch on config.json for hot reload (router only)
 *  10. Install SIGTERM/SIGINT handlers
 *
 * Run modes:
 *   - Foreground (TTY): console transport on, QR visible.
 *   - systemd background (no TTY): assertTTY() exits with a clear message.
 *
 * Hot reload: the config.json file is watched. On change we re-read,
 * validate and swap into the router. The WhatsApp client is NOT restarted.
 * The SMS HTTP server keeps running with its current port — only the
 * whitelist / signature-validation / output-cap settings take effect
 * immediately. (Restart SMS for port changes.)
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { initLogger, getLogger } = require('./logger');
const { assertTTY, buildClient, wireAuthEvents } = require('./auth');
const { createRouter } = require('./router');
const { createWhatsAppChannel } = require('./channels/whatsapp');
const { createSmsChannel } = require('./channels/sms');
const {
  installSignalHandlers,
  requestShutdown,
  setBeforeExitHook,
  registerCleanup,
} = require('./shutdown');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.WABOT_CONFIG || path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // eslint-disable-next-line no-console
    console.error(`Konfiguration nicht gefunden: ${CONFIG_PATH}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Konnte ${CONFIG_PATH} nicht lesen: ${err.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Konnte ${CONFIG_PATH} nicht parsen: ${err.message}`);
    process.exit(1);
  }

  // Minimal schema validation — fail loud, fail early.
  const required = ['whatsapp', 'whitelist', 'security', 'logging'];
  for (const key of required) {
    if (!parsed[key]) {
      // eslint-disable-next-line no-console
      console.error(`Pflichtfeld fehlt in config.json: ${key}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(parsed.whitelist.numbers) || parsed.whitelist.numbers.length === 0) {
    // eslint-disable-next-line no-console
    console.error('whitelist.numbers muss ein nicht-leeres Array sein.');
    process.exit(1);
  }
  if (!Array.isArray(parsed.whitelist.commands) || parsed.whitelist.commands.length === 0) {
    // eslint-disable-next-line no-console
    console.error('whitelist.commands muss ein nicht-leeres Array sein.');
    process.exit(1);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
  // 1. Load config first so the logger knows where to write.
  const cfg = loadConfig();

  // 2. Initialise logger. Console is only on when we actually have a TTY.
  const isForeground = !!process.stdout.isTTY;
  initLogger(cfg, { console: isForeground });

  const logger = getLogger();
  logger.info('=== whatsapp-shell-bot startet ===');
  logger.info(`Config geladen aus ${CONFIG_PATH}.`);
  logger.info(`Modus: ${isForeground ? 'foreground (TTY)' : 'background (systemd)'}`);

  // 3. TTY pre-flight. If we're in background mode, exit with instructions.
  if (isForeground) {
    assertTTY();
  } else {
    // Background: log to file only. No QR needed if a session already exists.
    // But the user might be starting for the first time without realising —
    // we still exit with a clear message if there's no session yet.
    const sessionPath = cfg.whatsapp.sessionPath;
    const hasSession = fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
    if (!hasSession) {
      logger.error(
        'Kein TTY und keine bestehende Session. Bitte einmalig im Vordergrund starten, ' +
          'um den QR-Code zu scannen.'
      );
      // eslint-disable-next-line no-console
      console.error(
        'Kein TTY erkannt. Bitte starte den Service zum QR-Scan manuell im Vordergrund: ' +
          '`sudo systemctl stop whatsapp-shell-bot && ' +
          'sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js`. ' +
          'Nach erfolgreichem Scan mit Ctrl+C abbrechen und ' +
          '`sudo systemctl start whatsapp-shell-bot`.'
      );
      process.exit(1);
    }
  }

  // 4. Build WhatsApp client.
  const client = buildClient(cfg);
  wireAuthEvents(client, cfg);

  // 5. Router.
  const router = createRouter(cfg);

  // 6. WhatsApp message listener via channel adapter.
  const onWhatsAppMessage = createWhatsAppChannel(router);
  client.on('message', (msg) => onWhatsAppMessage(client, msg));

  // 7. SMS channel — opt-in via sms.enabled.
  let smsChannel = null;
  if (cfg.sms && cfg.sms.enabled === true) {
    try {
      smsChannel = createSmsChannel(cfg, router);
      await smsChannel.start();
      // Register shutdown cleanup BEFORE any other failure point so the
      // server is always closed, even if client.initialize() throws later.
      registerCleanup(async () => {
        if (smsChannel && smsChannel.isListening()) {
          await smsChannel.stop();
        }
      });
    } catch (err) {
      logger.error(`SMS-Kanal konnte nicht starten: ${err.message}`);
      // Fail closed: if SMS was explicitly requested but failed to boot,
      // we tear the whole service down. Otherwise an admin who thinks SMS
      // is working would silently keep using WhatsApp.
      process.exit(1);
    }
  } else {
    logger.info('SMS-Kanal deaktiviert (sms.enabled=false).');
  }

  // 8. fs.watch on config.json — hot reload whitelist only.
  let watchDebounce = null;
  try {
    fs.watch(CONFIG_PATH, { persistent: false }, () => {
      // Debounce — editors often emit multiple events per save.
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        try {
          const newCfg = loadConfig();
          router.setConfig(newCfg);
        } catch (err) {
          logger.error(`Konnte config.json nicht neu laden: ${err.message}`);
        }
      }, 250);
    });
    logger.info(`watch auf ${CONFIG_PATH} aktiv (Hot-Reload der Whitelist).`);
  } catch (err) {
    logger.warn(`fs.watch auf config.json fehlgeschlagen: ${err.message}`);
  }

  // 9. Detach the message listener before shutdown finishes.
  setBeforeExitHook(() => {
    client.removeAllListeners('message');
  });

  // 10. Signal handlers — pass whatever the shutdown path needs.
  installSignalHandlers(() => ({ client }));

  // 11. Start the WhatsApp client.
  try {
    await client.initialize();
  } catch (err) {
    logger.error(`client.initialize() fehlgeschlagen: ${err.message}`);
    await requestShutdown({ client, reason: 'init_failure', exitCode: 1 });
  }
})();

// Safety net for unhandled rejections — log them rather than crash silently.
process.on('unhandledRejection', (reason) => {
  try {
    getLogger().error(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
  } catch {
    // Logger not ready yet.
    // eslint-disable-next-line no-console
    console.error('unhandledRejection:', reason);
  }
});

process.on('uncaughtException', (err) => {
  try {
    getLogger().error(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  } catch {
    // eslint-disable-next-line no-console
    console.error('uncaughtException:', err);
  }
  // Exit cleanly — never let the bot limp along in an unknown state.
  requestShutdown({ reason: 'uncaughtException', exitCode: 1 });
});