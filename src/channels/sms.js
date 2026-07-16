/**
 * SMS channel adapter (Twilio Programmable Messaging).
 *
 * Bootstraps a local Express HTTP server that exposes ONE webhook endpoint
 * for incoming SMS. The flow is:
 *
 *   Twilio → HTTPS reverse proxy (Caddy/nginx/Cloudflare Tunnel)
 *        → POST /sms/inbound (this server, bound to 127.0.0.1)
 *        → validateRequest() — reject 403 on bad signature
 *        → extract From/Body, normalise, hand off to router
 *        → reply 200 <Response/> immediately (fire-and-forget)
 *
 * The actual outbound reply SMS is sent ASYNCHRONOUSLY via Twilio's REST
 * API (client.messages.create) AFTER the command finishes. This keeps the
 * webhook response well under Twilio's 15s timeout even for slow commands.
 *
 * Decision: We never call back via TwiML <Message>. That ties the reply
 * transport to the request lifetime and breaks idempotency. REST is the
 * right primitive: the webhook says "received, working on it" and the
 * result SMS arrives when it arrives.
 *
 * Decision: We listen on 127.0.0.1 only. The bot must NEVER be directly
 * reachable from the public internet — a reverse proxy with HTTPS is
 * mandatory (see README).
 */

'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');

const { getLogger } = require('../logger');

/**
 * Strip a phone number down to digits-only E.164. Accepts "+49 170 …"
 * (Twilio's typical format with spaces and a leading "+") and returns
 * "49170…". Empty / non-strings return ''.
 */
function normaliseFrom(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\d]/g, '');
}

/**
 * Construct the public-facing absolute URL for signature validation.
 *
 * Twilio's signature is computed against the URL Twilio actually called,
 * NOT the localhost URL Express sees. If we sit behind a reverse proxy
 * that sets X-Forwarded-Proto and X-Forwarded-Host (which is mandatory
 * per the README), we must reconstruct the public URL from those headers.
 *
 * Without this, every webhook would fail validation.
 */
function buildPublicUrl(req, webhookPath) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  // webhookPath starts with '/', so a naive concat is fine.
  return `${proto}://${host}${webhookPath}`;
}

/**
 * Build the Express app for the SMS webhook. Separated from the listening
 * wrapper so tests can mount it on a plain http.createServer without
 * pulling in real listeners (which can keep the event loop alive).
 *
 * @returns {{ app: object, webhookPath: string, httpPort: number, httpHost: string }}
 */
function createSmsApp(cfg, router) {
  const logger = getLogger();
  const smsCfg = cfg.sms || {};

  if (!smsCfg.twilioAccountSid || !smsCfg.twilioAuthToken || !smsCfg.twilioPhoneNumber) {
    throw new Error(
      'SMS-Kanal aktiviert, aber twilioAccountSid/twilioAuthToken/twilioPhoneNumber fehlen.'
    );
  }

  const webhookPath = smsCfg.webhookPath || '/sms/inbound';
  const httpPort = smsCfg.httpPort || 3000;
  const httpHost = smsCfg.httpHost || '127.0.0.1';
  const validateSignature = smsCfg.validateSignature !== false; // default: on
  const ratePerMinute = smsCfg.rateLimitPerMinute || 30;

  // Twilio client used for the *outbound* reply. It needs the auth token,
  // which only this module touches — never log it.
  const twilioClient = twilio(smsCfg.twilioAccountSid, smsCfg.twilioAuthToken);

  const app = express();

  // Decision: trust the loopback proxy hop. The server binds to 127.0.0.1 and
  // the mandatory reverse proxy (Caddy/nginx/Cloudflare Tunnel) always connects
  // from loopback on the same host, adding X-Forwarded-For. Without this,
  // express-rate-limit sees that header while Express distrusts all proxies and
  // throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
  app.set('trust proxy', 'loopback');

  // Webhook bodies are urlencoded. We do NOT use express.json() — Twilio
  // never sends JSON to webhooks, and a permissive JSON parser just
  // widens the attack surface for no reason.
  app.use(
    webhookPath,
    express.urlencoded({ extended: false, limit: '64kb' })
  );

  // Standard HTTP hardening for anything outside the webhook itself.
  app.use(helmet());

  // Rate-limit the webhook. Twilio's IPs vary, so we key by the connecting
  // IP (which is the reverse proxy's IP in production — usually a single
  // address). 30/min is well above Twilio's normal cadence and well below
  // anything a brute-force attacker could sustain.
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
        'Twilio-Signatur-Validierung ist DEAKTIVIERT (sms.validateSignature=false). ' +
          'Dies ist nur für Debug-Zwecke gedacht — in Produktion aktivieren!'
      );
      lastSigWarn = now;
    }
  }

  // -- Outbound SMS closure -----------------------------------------------
  function buildOutboundReply(toNumber) {
    return async function sendReply(text) {
      try {
        await twilioClient.messages.create({
          from: smsCfg.twilioPhoneNumber,
          to: `+${toNumber}`,
          body: text,
        });
        logger.info('sms_reply_sent', {
          to: toNumber,
          length: text.length,
        });
      } catch (err) {
        logger.error(`SMS-Antwort fehlgeschlagen an ${toNumber}: ${err.message}`);
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
          smsCfg.twilioAuthToken,
          signature,
          publicUrl,
          params
        );
      } catch (err) {
        logger.error(`Twilio-Signatur-Validierung fehlgeschlagen: ${err.message}`);
        ok = false;
      }
      if (!ok) {
        logger.warn('sms_signature_invalid', {
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
    const body = typeof (req.body && req.body.Body) === 'string'
      ? req.body.Body.trim()
      : '';
    const messageSid = (req.body && req.body.MessageSid) || '';

    if (!from || !body) {
      logger.warn('sms_malformed', { hasFrom: !!from, hasBody: !!body });
      return res.status(200).type('text/xml').send('<Response/>');
    }

    // Fire-and-forget TwiML reply — the real reply goes out via REST.
    res.status(200).type('text/xml').send('<Response/>');

    try {
      await router.handleMessage({
        channel: 'sms',
        from,
        body,
        reply: buildOutboundReply(from),
        metadata: { messageSid },
      });
    } catch (err) {
      logger.error(`Fehler im SMS-Handler: ${err.message}`, { stack: err.stack });
    }
  });

  return { app, webhookPath, httpPort, httpHost };
}

/**
 * Wrap the SMS app in a real listening HTTP server. Returns lifecycle
 * methods used by index.js for boot/shutdown.
 */
function createSmsChannel(cfg, router) {
  const logger = getLogger();
  const built = createSmsApp(cfg, router);
  let server = null;

  async function start() {
    return new Promise((resolve, reject) => {
      server = built.app.listen(built.httpPort, built.httpHost, (err) => {
        if (err) return reject(err);
        logger.info(`SMS-HTTP-Server lauscht auf ${built.httpHost}:${built.httpPort}${built.webhookPath}`);
        resolve({ port: built.httpPort, host: built.httpHost });
      });
      server.on('error', (err) => {
        logger.error(`SMS-HTTP-Server-Fehler: ${err.message}`);
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
        logger.info('SMS-HTTP-Server geschlossen.');
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
  createSmsChannel,
  createSmsApp,
  normaliseFrom,
  buildPublicUrl,
};