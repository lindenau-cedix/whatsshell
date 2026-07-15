/**
 * Channel-agnostic message router.
 *
 * The router is the *only* place that decides whether a message becomes
 * a command execution. Every rejection reason is logged with structured
 * fields so the audit trail is complete.
 *
 * Decision: We keep the router transport-free. Both WhatsApp and SMS call
 * into router.handleMessage() with a normalised shape:
 *
 *   { channel, from, body, reply, metadata }
 *
 * - `channel`: 'whatsapp' | 'sms' — used for log labels only.
 * - `from`: digits-only phone number in E.164 without the leading '+'.
 * - `body`: trimmed command string.
 * - `reply(text)`: channel-specific reply function (Promise).
 * - `metadata`: free-form object for log enrichment (pushName, MessageSid, …).
 *
 * Channel-specific concerns (group filtering, signature validation, reply
 * transport) live in their respective modules under src/channels/.
 *
 * Decision: We log the message body (truncated to 200 chars) for every
 * incoming message — accepted OR rejected — because the audit trail is
 * more valuable than the small privacy cost. The whitelist itself is the
 * access control; the log just records what happened.
 */

'use strict';

const { getLogger } = require('./logger');
const { validateCommand, isNumberWhitelisted } = require('./whitelist');
const { executeCommand, formatResult } = require('./executor');

const MAX_LOGGED_BODY = 200;

/**
 * Truncate a body for logging.
 */
function truncateBody(body) {
  if (typeof body !== 'string') return '';
  if (body.length <= MAX_LOGGED_BODY) return body;
  return body.slice(0, MAX_LOGGED_BODY) + '…';
}

/**
 * Build a router bound to the current config.
 *
 * The router is a closure over `cfg` so that fs.watch-driven reloads can
 * swap in a new config without re-creating the listener.
 *
 * @param {object} initialCfg   Parsed config.json
 * @returns {{handleMessage: Function, setConfig: Function, getConfig: Function}}
 */
function createRouter(initialCfg) {
  const logger = getLogger();
  let cfg = initialCfg;

  /**
   * Main entry point. Channel-agnostic.
   *
   * @param {object} msg
   *   @param {string} msg.channel    'whatsapp' | 'sms'
   *   @param {string} msg.from       digits-only phone number
   *   @param {string} msg.body       trimmed message body
   *   @param {Function} msg.reply    async (text) => void — channel-specific
   *   @param {object} [msg.metadata] extra fields for log enrichment
   */
  async function handleMessage(msg) {
    const channel = msg && typeof msg.channel === 'string' ? msg.channel : 'unknown';
    const senderNumber = msg && typeof msg.from === 'string' ? msg.from : '';
    const body = msg && typeof msg.body === 'string' ? msg.body : '';
    const replyFn = msg && typeof msg.reply === 'function' ? msg.reply : async () => {};
    const metadata = msg && typeof msg.metadata === 'object' && msg.metadata !== null
      ? msg.metadata
      : {};
    const truncatedBody = truncateBody(body);

    // 1. Number whitelist.
    if (!isNumberWhitelisted(senderNumber, cfg.whitelist.numbers || [])) {
      logger.info('unknown_number', {
        channel,
        sender: senderNumber,
        body: truncatedBody,
        ...metadata,
      });
      // For unknown numbers we deliberately do NOT reply — that's the whole
      // point of a whitelist. No outbound message = no signal that the
      // endpoint is alive.
      return;
    }

    // 2. Command validation (also strips metacharacters).
    const validation = validateCommand(body, cfg.whitelist.commands || []);
    if (!validation.ok) {
      logger.info('rejected', {
        channel,
        sender: senderNumber,
        body: truncatedBody,
        reason: validation.reason,
        ...metadata,
      });
      return;
    }

    // 3. Execute the whitelisted command.
    const cmdEntry = validation.entry;
    logger.info('executed', {
      channel,
      sender: senderNumber,
      command: cmdEntry.name,
      body: truncatedBody,
      ...metadata,
    });

    // Per-channel output cap. SMS (1600) and Voice (500 default) are tighter
    // than the WhatsApp default (4000) because the reply transports are
    // cost-bounded per message / per <Say>.
    let maxOutputChars = cfg.security.maxOutputChars;
    if (channel === 'sms' && cfg.sms && cfg.sms.maxOutputChars) {
      maxOutputChars = cfg.sms.maxOutputChars;
    } else if (channel === 'voice' && cfg.voice && cfg.voice.maxOutputChars) {
      maxOutputChars = cfg.voice.maxOutputChars;
    }

    const result = await executeCommand(cmdEntry.command, {
      timeoutMs: cfg.security.timeoutMs,
      maxOutputChars,
      cwd: process.cwd(),
    });

    // 4. Audit-log the result.
    logger.info('command_result', {
      channel,
      sender: senderNumber,
      command: cmdEntry.name,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      timedOut: result.timedOut,
      ...metadata,
    });

    // 5. Reply via the channel-specific transport. Pass channel so the
    //    executor can pick a TTS-friendly formatter for voice.
    const replyText = formatResult(result, { channel });
    try {
      await replyFn(replyText);
    } catch (err) {
      logger.error(`Antwort fehlgeschlagen (channel=${channel}, sender=${senderNumber}): ${err.message}`);
    }
  }

  /**
   * Hot-swap the active config (called by fs.watch on config.json).
   */
  function setConfig(newCfg) {
    cfg = newCfg;
    logger.info('Konfiguration zur Laufzeit neu geladen.');
  }

  function getConfig() {
    return cfg;
  }

  return { handleMessage, setConfig, getConfig };
}

module.exports = { createRouter };