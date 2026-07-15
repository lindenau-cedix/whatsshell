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
 *        → respond 200 with a <Say> ack TwiML (keeps the call alive!)
 *        → run the configured command via the router (channel='voice')
 *        → when the command finishes, inject the result TwiML into the live
 *          call via client.calls(callSid).update({ twiml })
 *
 * The fire-and-forget pattern matches sms.js: the webhook returns <15s and
 * the real reply rides an async REST call. For SMS the reply is a fresh
 * outbound SMS; for voice it's a TwiML injection into the same call leg,
 * which means the call must STAY ALIVE between the webhook ack and the
 * reply. That's why the ack TwiML is a <Say> envelope, NOT an empty
 * <Response/> — empty TwiML would hang up before our reply arrives.
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
  const matched = (cfg.whitelist && Array.isArray(cfg.whitelist.commands)
    ? cfg.whitelist.commands
    : []
  ).some((c) => c && typeof c.command === 'string' && c.command === voiceCfg.command);
  if (!matched) {
    throw new Error(
      `voice.command "${voiceCfg.command}" ist nicht in whitelist.commands. ` +
        'Bitte in config.json eintragen.'
    );
  }

  const logger = getLogger();

  const webhookPath = voiceCfg.webhookPath || '/voice/inbound';
  const httpPort = voiceCfg.httpPort || 3001;
  const httpHost = voiceCfg.httpHost || '127.0.0.1';
  const validateSignature = voiceCfg.validateSignature !== false;
  const ratePerMinute = voiceCfg.rateLimitPerMinute || 30;

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

  // -- Ack TwiML — must keep the call alive -------------------------------
  // Empty <Response/> would hang up the call before our reply arrives.
  // A short <Say> gives the caller audio feedback (~1.5s) and blocks the
  // call-progress timer long enough for typical commands; longer commands
  // still queue cleanly via client.calls(callSid).update({ twiml }).
  const ACK_TWIML = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Say voice="alice" language="de-DE">Bitte warten.</Say>' +
    '</Response>';

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
      // Ack with the same <Say> envelope — gives a tiny audio cue, then hangs up.
      return res.status(200).type('text/xml').send(ACK_TWIML);
    }

    // Ack immediately so Twilio doesn't time out the webhook. The real
    // reply rides on the still-live call via client.calls(callSid).update().
    res.status(200).type('text/xml').send(ACK_TWIML);

    try {
      await router.handleMessage({
        channel: 'voice',
        from,
        body: voiceCfg.command,
        reply: buildOutboundReply(callSid),
        metadata: { callSid },
      });
    } catch (err) {
      logger.error(`Fehler im Voice-Handler: ${err.message}`, { stack: err.stack });
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
};