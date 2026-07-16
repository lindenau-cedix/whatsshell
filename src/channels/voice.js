/**
 * Voice channel adapter (Twilio Programmable Voice).
 *
 * Bootstraps a local Express HTTP server that exposes ONE webhook endpoint
 * for incoming calls. The flow is:
 *
 *   Caller → Twilio → HTTPS reverse proxy (Caddy/nginx/Cloudflare Tunnel)
 *        → POST /voice/inbound (this server, bound to 127.0.0.1)
 *        → validateRequest() — reject 403 on bad signature
 *        → normalise From, look up the configured `voice.command`
 *        → respond 200 with a <Say> + <Pause> ack TwiML
 *        → run the configured command via the router (channel='voice')
 *        → when the command finishes, inject the result TwiML into the live
 *          call via client.calls(callSid).update({ twiml })
 *
 * The fire-and-forget pattern matches sms.js: the webhook returns <15s and
 * the real reply rides an async REST call. For SMS the reply is a fresh
 * outbound SMS; for voice it's a TwiML injection into the same call leg,
 * which means the call must STAY ALIVE between the webhook ack and the
 * reply. The <Say> gives immediate feedback; the following <Pause> holds
 * the call open until calls.update() replaces it with the result TwiML.
 *
 * Decision: we always reply with one fixed command (cfg.voice.command).
 * The user's wording was "a specific command should run" — no speech-to-
 * text, no per-caller command map. Boot-time validation fails closed if
 * voice.command isn't present in whitelist.commands.
 *
 * Decision: separate Twilio phone number from SMS (cfg.voice.twilioPhoneNumber).
 * Operators can keep one Twilio account but assign different numbers to
 * different channels. Account SID + Auth Token can match SMS.* — they're
 * account-level, not number-level.
 */

'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');

const { getLogger } = require('../logger');
const { normaliseFrom, buildPublicUrl } = require('./sms');

const DEFAULT_ACK_PAUSE_SECONDS = 35;
const MAX_ACK_PAUSE_SECONDS = 600;

/**
 * Keep the initial TwiML pause bounded and valid. Invalid values fall back to
 * the default rather than producing malformed TwiML at request time.
 */
function normaliseAckPauseSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ACK_PAUSE_SECONDS;
  }
  const seconds = Math.trunc(value);
  if (seconds < 1) return DEFAULT_ACK_PAUSE_SECONDS;
  return Math.min(seconds, MAX_ACK_PAUSE_SECONDS);
}

/**
 * Build the immediate response TwiML. Accepted calls include a Pause because
 * Twilio ends the call after the document has finished; malformed calls do
 * not wait because no result will be injected later.
 */
function buildAckTwiml(pauseSeconds) {
  const pause = pauseSeconds
    ? `<Pause length="${pauseSeconds}"/>`
    : '';
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Say voice="alice" language="de-DE">Bitte warten.</Say>' +
    pause +
    '</Response>';
}

/**
 * Escape characters that would otherwise break the surrounding TwiML XML.
 * A command like `echo '<script>'` would otherwise close the <Response>.
 */
function escapeXml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the Express app for the voice webhook. Separated from the listening
 * wrapper so tests can mount it on a plain http.createServer without
 * pulling in real listeners.
 *
 * @param {object} cfg
 * @param {object} router
 * @param {object} [twilioClient]  Injected for tests. Defaults to a real
 *                                 Twilio REST client built from cfg.voice.*.
 * @returns {{ app: object, webhookPath: string, httpPort: number, httpHost: string }}
 */
function createVoiceApp(cfg, router, twilioClient) {
  const voiceCfg = (cfg && cfg.voice) || {};

  // Validation first — these errors should be raised even if the logger
  // hasn't been initialised yet (matches the SMS channel's pattern, and
  // lets boot-time tests assert against clean error messages).
  if (!voiceCfg.twilioAccountSid || !voiceCfg.twilioAuthToken || !voiceCfg.twilioPhoneNumber) {
    throw new Error(
      'Voice-Kanal aktiviert, aber twilioAccountSid/twilioAuthToken/twilioPhoneNumber fehlen.'
    );
  }
  if (!voiceCfg.command || typeof voiceCfg.command !== 'string') {
    throw new Error('Voice-Kanal aktiviert, aber voice.command fehlt in config.json.');
  }
  const voiceCommand = voiceCfg.command.trim();
  if (!voiceCommand) {
    throw new Error('Voice-Kanal aktiviert, aber voice.command ist leer.');
  }
  const matched = (cfg.whitelist && Array.isArray(cfg.whitelist.commands)
    ? cfg.whitelist.commands
    : []
  ).some((c) => c && typeof c.command === 'string' && c.command === voiceCommand);
  if (!matched) {
    throw new Error(
      `voice.command "${voiceCommand}" ist nicht in whitelist.commands. ` +
        'Bitte in config.json eintragen.'
    );
  }

  const logger = getLogger();

  const webhookPath = voiceCfg.webhookPath || '/voice/inbound';
  const httpPort = voiceCfg.httpPort || 3001;
  const httpHost = voiceCfg.httpHost || '127.0.0.1';
  const validateSignature = voiceCfg.validateSignature !== false;
  const ratePerMinute = voiceCfg.rateLimitPerMinute || 30;
  const ackPauseSeconds = normaliseAckPauseSeconds(voiceCfg.ackPauseSeconds);

  const client = twilioClient || twilio(voiceCfg.twilioAccountSid, voiceCfg.twilioAuthToken);

  const app = express();

  app.use(
    webhookPath,
    express.urlencoded({ extended: false, limit: '64kb' })
  );
  app.use(helmet());

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: ratePerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
  });

  // -- Signature-disabled nag (one per minute, not per request) -----------
  let lastSigWarn = 0;
  function maybeWarnSignatureDisabled() {
    const now = Date.now();
    if (now - lastSigWarn > 60_000) {
      logger.warn(
        'Twilio-Signatur-Validierung (voice) ist DEAKTIVIERT ' +
          '(voice.validateSignature=false). Nur für Debug-Zwecke.'
      );
      lastSigWarn = now;
    }
  }

  // -- Ack TwiML — keep accepted calls alive -------------------------------
  // <Say> alone is not enough: Twilio proceeds to the end of the TwiML and
  // ends the call. The Pause gives calls.update() a live call leg to replace.
  const ACK_TWIML = buildAckTwiml(ackPauseSeconds);
  const SHORT_ACK_TWIML = buildAckTwiml();

  // -- Outbound voice reply closure ---------------------------------------
  function buildOutboundReply(callSid) {
    return async function sendReply(text) {
      const safe = escapeXml(text);
      const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        `<Say voice="alice" language="de-DE">${safe}</Say>` +
        '</Response>';
      try {
        await client.calls(callSid).update({ twiml });
        logger.info('voice_reply_sent', { callSid, length: text.length });
      } catch (err) {
        // 13231 = call not in-progress, 20404 = CallSid gone. Both happen
        // when the caller hangs up before the command finishes. Anything
        // >= 20000 is a Twilio-side issue (network, auth, rate limit).
        const code = err && err.code;
        const benign = !code || code === 13231 || code === 20404 || code >= 20000;
        if (benign) {
          logger.warn(`Voice-Antwort fehlgeschlagen (callSid=${callSid}): ${err.message}`);
        } else {
          logger.error(`Voice-Antwort fehlgeschlagen (callSid=${callSid}): ${err.message}`);
        }
      }
    };
  }

  // -- The single webhook --------------------------------------------------
  app.post(webhookPath, limiter, async (req, res) => {
    if (validateSignature) {
      const signature = req.headers['x-twilio-signature'] || '';
      const publicUrl = buildPublicUrl(req, webhookPath);
      const params = req.body || {};
      let ok = false;
      try {
        ok = twilio.validateRequest(
          voiceCfg.twilioAuthToken,
          signature,
          publicUrl,
          params
        );
      } catch (err) {
        logger.error(`Twilio-Signatur-Validierung (voice) fehlgeschlagen: ${err.message}`);
        ok = false;
      }
      if (!ok) {
        logger.warn('voice_signature_invalid', {
          remoteIp: req.ip,
          publicUrl,
          hasBody: Object.keys(params).length,
        });
        return res.status(403).type('text/xml').send('<Response/>');
      }
    } else {
      maybeWarnSignatureDisabled();
    }

    const from = normaliseFrom(req.body && req.body.From);
    const callSid = (req.body && req.body.CallSid) || '';

    if (!from || !callSid) {
      logger.warn('voice_malformed', { hasFrom: !!from, hasCallSid: !!callSid });
      // Give a short audio cue, then hang up; no result will follow.
      return res.status(200).type('text/xml').send(SHORT_ACK_TWIML);
    }

    // Let the router validate the number and command before sending the held
    // ack. Rejected calls receive a short response after handleMessage returns.
    let accepted = false;

    try {
      await router.handleMessage({
        channel: 'voice',
        from,
        body: voiceCommand,
        reply: buildOutboundReply(callSid),
        metadata: { callSid },
        async onAccepted() {
          res.status(200).type('text/xml').send(ACK_TWIML);
          accepted = true;
          logger.info('voice_ack_sent', { callSid, from, pauseSeconds: ackPauseSeconds });
        },
      });
      if (!accepted && !res.headersSent) {
        res.status(200).type('text/xml').send(SHORT_ACK_TWIML);
      }
    } catch (err) {
      logger.error(`Fehler im Voice-Handler: ${err.message}`, { stack: err.stack });
      if (!res.headersSent) {
        // A non-2xx response makes Twilio play its generic application-error
        // prompt. Return valid short TwiML while keeping the failure logged.
        res.status(200).type('text/xml').send(SHORT_ACK_TWIML);
      }
    }
  });

  return { app, webhookPath, httpPort, httpHost };
}

/**
 * Wrap the voice app in a real listening HTTP server. Returns lifecycle
 * methods used by index.js for boot/shutdown.
 */
function createVoiceChannel(cfg, router, twilioClient) {
  const logger = getLogger();
  const built = createVoiceApp(cfg, router, twilioClient);
  let server = null;

  async function start() {
    return new Promise((resolve, reject) => {
      server = built.app.listen(built.httpPort, built.httpHost, (err) => {
        if (err) return reject(err);
        logger.info(`Voice-HTTP-Server lauscht auf ${built.httpHost}:${built.httpPort}${built.webhookPath}`);
        resolve({ port: built.httpPort, host: built.httpHost });
      });
      server.on('error', (err) => {
        logger.error(`Voice-HTTP-Server-Fehler: ${err.message}`);
      });
    });
  }

  function isListening() {
    return !!(server && server.listening);
  }

  async function stop() {
    if (!server) return;
    return new Promise((resolve) => {
      server.close(() => {
        logger.info('Voice-HTTP-Server geschlossen.');
        resolve();
      });
      setTimeout(() => {
        if (server && typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }, 500).unref();
    });
  }

  return { app: built.app, start, stop, isListening };
}

module.exports = {
  createVoiceApp,
  createVoiceChannel,
  escapeXml,
  buildAckTwiml,
  normaliseAckPauseSeconds,
};
