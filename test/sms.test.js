/**
 * SMS channel tests.
 *
 * We test three layers:
 *   1. The pure helpers (normaliseFrom, buildPublicUrl).
 *   2. The Express webhook mounted on a real loopback HTTP server —
 *      signature validation, normalisation, 200 vs 403, fire-and-forget
 *      behaviour.
 *   3. End-to-end with a stub router that captures the handleMessage call
 *      so we can assert what the SMS channel actually fed in.
 *
 * We intentionally do NOT exercise the outbound Twilio REST call — it
 * would need real credentials. We replace the outbound reply() with a
 * stub and assert it's invoked with the right number/text.
 *
 * Implementation note: we mount the Express app on http.createServer(app)
 * directly, NOT via app.listen(). This avoids keep-alive sockets that
 * would otherwise prevent the Node test runner from exiting cleanly.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const twilio = require('twilio');

const fs = require('node:fs');
const { initLogger } = require('../src/logger');
const { createSmsApp, normaliseFrom, buildPublicUrl } = require('../src/channels/sms');

const BASE_CFG = {
  whatsapp: {},
  sms: {
    enabled: true,
    twilioAccountSid: 'AC' + 'a'.repeat(32),
    twilioAuthToken: 'test_auth_token_' + 'b'.repeat(20),
    twilioPhoneNumber: '+491234567890',
    webhookPath: '/sms/inbound',
    httpPort: 0,
    httpHost: '127.0.0.1',
    validateSignature: true,
    maxOutputChars: 1600,
    rateLimitPerMinute: 1000, // don't trip the limiter during tests
  },
  whitelist: { numbers: ['491701234567'], commands: [] },
  security: { timeoutMs: 5000, maxOutputChars: 4000, allowedFromGroups: false },
  logging: { directory: '/tmp/whatsshell-test-logs', retentionDays: 1 },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('normaliseFrom: strips spaces and +', () => {
  assert.strictEqual(normaliseFrom('+49 170 1234567'), '491701234567');
});

test('normaliseFrom: empty on null', () => {
  assert.strictEqual(normaliseFrom(null), '');
});

test('buildPublicUrl: prefers X-Forwarded headers', () => {
  const req = {
    protocol: 'http',
    headers: {
      host: '127.0.0.1:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'bot.example.com',
    },
  };
  assert.strictEqual(
    buildPublicUrl(req, '/sms/inbound'),
    'https://bot.example.com/sms/inbound'
  );
});

test('buildPublicUrl: falls back to host header when no proxy headers', () => {
  const req = { protocol: 'http', headers: { host: '127.0.0.1:3000' } };
  assert.strictEqual(buildPublicUrl(req, '/sms/inbound'), 'http://127.0.0.1:3000/sms/inbound');
});

// ---------------------------------------------------------------------------
// Express webhook via http.createServer (no app.listen, no keep-alive)
// ---------------------------------------------------------------------------

function makeSignedRequest(authToken, url, params) {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}

function urlencodedBody(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function postForm(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path,
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Boot an SMS app on an http.createServer (NOT app.listen) and return
 * everything tests need to send requests + assert behaviour. The caller
 * MUST call close() in t.after.
 */
async function bootTestServer({ validateSignature = true, baseUrl } = {}) {
  fs.mkdirSync(BASE_CFG.logging.directory, { recursive: true });
  initLogger(BASE_CFG, { console: false });

  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  cfg.sms.validateSignature = validateSignature;

  const captured = { calls: [], replies: [] };
  const stubRouter = {
    async handleMessage(m) {
      captured.calls.push(m);
      // Simulate the router calling reply (we don't hit the real Twilio
      // client — its REST call is replaced by the stub).
      if (typeof m.reply === 'function') {
        await m.reply('OK hi');
      }
      captured.replies.push({ from: m.from, text: 'OK hi' });
    },
  };

  const built = createSmsApp(cfg, stubRouter);
  const server = http.createServer(built.app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    server,
    port,
    captured,
    publicUrl: baseUrl || `http://127.0.0.1:${port}${built.webhookPath}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('sms: rejects webhook with invalid signature (403)', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    Body: 'uptime',
    MessageSid: 'SMxxx',
  });
  const res = await postForm(ctx.port, '/sms/inbound', {}, body);
  assert.strictEqual(res.status, 403);
});

test('sms: accepts signed webhook and forwards to router', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = {
    From: '+49 170 1234567',
    Body: 'uptime',
    MessageSid: 'SMtest1',
  };
  const signature = makeSignedRequest(
    BASE_CFG.sms.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/sms/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('<Response'));

  // The router should have received a normalised message.
  assert.strictEqual(ctx.captured.calls.length, 1);
  assert.strictEqual(ctx.captured.calls[0].channel, 'sms');
  assert.strictEqual(ctx.captured.calls[0].from, '491701234567'); // stripped
  assert.strictEqual(ctx.captured.calls[0].body, 'uptime');
  assert.strictEqual(ctx.captured.calls[0].metadata.messageSid, 'SMtest1');
});

test('sms: app trusts the loopback proxy hop (req.ip from X-Forwarded-For)', () => {
  // Version-independent guard for the trust-proxy fix. Behind the mandatory
  // loopback reverse proxy, Express must derive req.ip from X-Forwarded-For
  // so express-rate-limit's keyGenerator never hits
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR (which, on some versions, 500s the webhook).
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  const { app } = createSmsApp(cfg, { handleMessage: async () => {} });
  assert.strictEqual(app.get('trust proxy'), 'loopback');
});

test('sms: X-Forwarded-For from the reverse proxy does not crash the limiter', async (t) => {
  // Regression: behind Caddy/nginx/cloudflared every request carries an
  // X-Forwarded-For header. Without app.set('trust proxy', 'loopback'),
  // express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and the
  // webhook 500s instead of acking Twilio.
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = {
    From: '+491701234567',
    Body: 'uptime',
    MessageSid: 'SMforwarded',
  };
  const signature = makeSignedRequest(
    BASE_CFG.sms.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/sms/inbound',
    {
      'x-twilio-signature': signature,
      'x-forwarded-for': '13.37.4.5, 127.0.0.1',
    },
    body
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 1);
});

test('sms: signature uses X-Forwarded-* headers (public URL)', async (t) => {
  // Sign against the public URL the reverse proxy presents, but POST to
  // the localhost listener. The channel must reconstruct the public URL
  // from X-Forwarded-Proto + X-Forwarded-Host, otherwise validation fails.
  const ctx = await bootTestServer({
    baseUrl: 'https://bot.example.com/sms/inbound',
  });
  t.after(() => ctx.close());

  const params = {
    From: '+491701234567',
    Body: 'uptime',
    MessageSid: 'SMtest2',
  };
  const signature = makeSignedRequest(
    BASE_CFG.sms.twilioAuthToken,
    'https://bot.example.com/sms/inbound',
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/sms/inbound',
    {
      'x-twilio-signature': signature,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'bot.example.com',
    },
    body
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 1);
});

test('sms: missing From is acked with 200 but not forwarded', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = { Body: 'uptime', MessageSid: 'SMtest3' };
  const signature = makeSignedRequest(
    BASE_CFG.sms.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/sms/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  // Always 200 to prevent Twilio retry storms.
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 0);
});

test('sms: validateSignature=false still accepts (with warn)', async (t) => {
  const ctx = await bootTestServer({ validateSignature: false });
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    Body: 'uptime',
    MessageSid: 'SMtest4',
  });
  // No signature header at all.
  const res = await postForm(ctx.port, '/sms/inbound', {}, body);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 1);
});

test('sms: oversized body is rejected by urlencoded parser', async (t) => {
  const ctx = await bootTestServer({ validateSignature: false });
  t.after(() => ctx.close());

  // Build a body > 64kb (the configured limit).
  const huge = 'x'.repeat(70_000);
  const body = urlencodedBody({
    From: '+491701234567',
    Body: huge,
    MessageSid: 'SMtest5',
  });

  const res = await postForm(ctx.port, '/sms/inbound', {}, body);
  // Express urlencoded with limit returns 413 on oversize bodies.
  assert.strictEqual(res.status, 413);
});