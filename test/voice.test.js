/**
 * Voice channel tests.
 *
 * Mirrors sms.test.js:
 *   1. Pure helpers (escapeXml).
 *   2. Express webhook mounted on http.createServer — signature validation,
 *      X-Forwarded-* URL reconstruction, the Say ack envelope, outbound
 *      calls.update stubbed so we never hit Twilio.
 *   3. End-to-end with a stub router that captures handleMessage calls so
 *      we can assert what the voice channel actually fed in.
 *
 * Implementation note: we mount on http.createServer(app) directly, NOT
 * app.listen(). Keep-alive sockets would otherwise prevent the Node test
 * runner from exiting cleanly.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const twilio = require('twilio');

const fs = require('node:fs');
const { initLogger } = require('../src/logger');
const {
  createVoiceApp,
  escapeXml,
  buildAckTwiml,
  normaliseAckPauseSeconds,
} = require('../src/channels/voice');
const { formatResult } = require('../src/executor');

const BASE_CFG = {
  whatsapp: {},
  sms: {
    enabled: false,
    twilioAccountSid: 'AC' + 'a'.repeat(32),
    twilioAuthToken: 'test_auth_token_' + 'b'.repeat(20),
    twilioPhoneNumber: '+491234567890',
    webhookPath: '/sms/inbound',
    httpPort: 0,
    httpHost: '127.0.0.1',
    validateSignature: true,
  },
  voice: {
    enabled: true,
    twilioAccountSid: 'AC' + 'a'.repeat(32),
    twilioAuthToken: 'test_auth_token_' + 'b'.repeat(20),
    twilioPhoneNumber: '+499876543210',
    webhookPath: '/voice/inbound',
    httpPort: 0,
    httpHost: '127.0.0.1',
    validateSignature: true,
    maxOutputChars: 500,
    rateLimitPerMinute: 1000, // don't trip the limiter during tests
    ackPauseSeconds: 35,
    command: 'uptime',
  },
  whitelist: {
    numbers: ['491701234567'],
    commands: [
      { name: 'uptime', command: 'uptime', description: 'Server-Uptime' },
      { name: 'printf-hi', command: 'printf hi', description: 'say hi' },
    ],
  },
  security: { timeoutMs: 5000, maxOutputChars: 4000, allowedFromGroups: false },
  logging: { directory: '/tmp/whatsshell-test-logs', retentionDays: 1 },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('escapeXml: escapes &, <, >', () => {
  assert.strictEqual(escapeXml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('escapeXml: empty on non-string', () => {
  assert.strictEqual(escapeXml(null), '');
  assert.strictEqual(escapeXml(undefined), '');
  assert.strictEqual(escapeXml(123), '');
});

test('escapeXml: passes plain text through', () => {
  assert.strictEqual(escapeXml('Hello world'), 'Hello world');
});

test('buildAckTwiml: accepted calls include a bounded pause', () => {
  const twiml = buildAckTwiml(35);
  assert.ok(twiml.includes('Bitte warten'));
  assert.ok(twiml.includes('<Pause length="35"/>'));
});

test('buildAckTwiml: short ack has no pause', () => {
  const twiml = buildAckTwiml();
  assert.ok(twiml.includes('Bitte warten'));
  assert.ok(!twiml.includes('<Pause'));
});

test('normaliseAckPauseSeconds: defaults, truncates and caps values', () => {
  assert.strictEqual(normaliseAckPauseSeconds(undefined), 35);
  assert.strictEqual(normaliseAckPauseSeconds('10'), 35);
  assert.strictEqual(normaliseAckPauseSeconds(0), 35);
  assert.strictEqual(normaliseAckPauseSeconds(-1), 35);
  assert.strictEqual(normaliseAckPauseSeconds(5.9), 5);
  assert.strictEqual(normaliseAckPauseSeconds(601), 600);
});

// ---------------------------------------------------------------------------
// Boot-time validation
// ---------------------------------------------------------------------------

test('voice: createVoiceApp throws when voice.command is missing from whitelist', () => {
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  cfg.voice.command = 'not-a-real-command';
  assert.throws(
    () => createVoiceApp(cfg, { handleMessage: async () => {} }),
    /ist nicht in whitelist\.commands/
  );
});

test('voice: createVoiceApp throws when voice.command is absent', () => {
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  delete cfg.voice.command;
  assert.throws(
    () => createVoiceApp(cfg, { handleMessage: async () => {} }),
    /voice\.command fehlt/
  );
});

test('voice: createVoiceApp throws when voice.command is whitespace-only', () => {
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  cfg.voice.command = '   ';
  assert.throws(
    () => createVoiceApp(cfg, { handleMessage: async () => {} }),
    /voice\.command ist leer/
  );
});

test('voice: createVoiceApp throws when Twilio credentials are missing', () => {
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  delete cfg.voice.twilioAuthToken;
  assert.throws(
    () => createVoiceApp(cfg, { handleMessage: async () => {} }),
    /twilioAuthToken.*fehlen/
  );
});

// ---------------------------------------------------------------------------
// TTS formatter
// ---------------------------------------------------------------------------

test('formatResult voice: strips markdown fences and replaces emoji with German words', () => {
  const text = formatResult(
    {
      stdout: '14:32  up 5 days,  3 users\nload average: 0.05',
      stderr: '',
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
    },
    { channel: 'voice' }
  );
  assert.ok(!text.includes('```'), 'no backticks in TTS output');
  assert.ok(!text.includes('✅'), 'no emoji in TTS output');
  assert.ok(text.startsWith('OK.'), `voice output starts with OK.: ${text}`);
  assert.ok(text.includes('load average'));
});

test('formatResult voice: failure case', () => {
  const text = formatResult(
    { stdout: '', stderr: 'boom', exitCode: 2, durationMs: 5, timedOut: false },
    { channel: 'voice' }
  );
  assert.ok(text.startsWith('Fehler, Exit-Code 2.'), text);
  assert.ok(text.includes('Fehlermeldung: boom'));
});

test('formatResult voice: timeout case', () => {
  const text = formatResult(
    { stdout: '', stderr: '', exitCode: -1, durationMs: 30000, timedOut: true },
    { channel: 'voice' }
  );
  assert.ok(text.startsWith('Zeitüberschreitung.'), text);
});

test('formatResult voice: collapses multi-line output into one sentence', () => {
  const text = formatResult(
    {
      stdout: 'line one\nline two\nline three',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    },
    { channel: 'voice' }
  );
  // Newlines gone, content present.
  assert.ok(!/\n/.test(text));
  assert.ok(text.includes('line one line two line three'));
});

test('formatResult voice: hard caps at 3500 chars even when caller asks for more', () => {
  const huge = 'x '.repeat(2000); // 4000 chars
  const text = formatResult(
    {
      stdout: huge,
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    },
    { channel: 'voice', maxOutputChars: 10000 }
  );
  assert.ok(text.length <= 3500 + ' (Ausgabe gekürzt)'.length, `text too long: ${text.length}`);
  assert.ok(text.endsWith('(Ausgabe gekürzt)'));
});

test('formatResult: default (non-voice) keeps markdown + emoji', () => {
  const text = formatResult({
    stdout: 'hi',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
  });
  assert.ok(text.includes('✅'));
  assert.ok(text.includes('```'));
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
        res.on('end', () => resolve({
          status: res.statusCode,
          body: chunks,
          headers: res.headers,
        }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Boot a voice app on an http.createServer (NOT app.listen) and return
 * everything tests need. The caller MUST call close() in t.after.
 *
 * `twilioClient` is stubbed so calls.update doesn't hit Twilio. We capture
 * every calls.update payload for assertions.
 */
async function bootTestServer({ validateSignature = true, baseUrl, routerStub, voiceOverrides } = {}) {
  fs.mkdirSync(BASE_CFG.logging.directory, { recursive: true });
  initLogger(BASE_CFG, { console: false });

  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  cfg.voice.validateSignature = validateSignature;
  Object.assign(cfg.voice, voiceOverrides || {});

  const captured = { calls: [], replies: [], callsUpdates: [] };

  // Stub that mirrors the real router's whitelist filter: unknown callers
  // are recorded as `unknown_calls` but never reach the reply path. This is
  // what the real router does in src/router.js — the channel doesn't
  // duplicate the check, but the test asserts end-to-end behaviour.
  const whitelistedNumbers = (cfg.whitelist && cfg.whitelist.numbers) || [];
  const stubRouter = routerStub || {
    async handleMessage(m) {
      const normalised = String(m.from || '').replace(/[^\d]/g, '');
      if (!whitelistedNumbers.includes(normalised)) {
        captured.unknown_calls = (captured.unknown_calls || 0) + 1;
        return;
      }
      if (typeof m.onAccepted === 'function') {
        await m.onAccepted();
      }
      captured.calls.push(m);
      if (typeof m.reply === 'function') {
        await m.reply('OK hi');
      }
      captured.replies.push({ from: m.from, text: 'OK hi' });
    },
  };

  const stubTwilio = {
    calls(sid) {
      return {
        async update({ twiml }) {
          captured.callsUpdates.push({ sid, twiml });
        },
      };
    },
  };

  const built = createVoiceApp(cfg, stubRouter, stubTwilio);
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

test('voice: rejects webhook with invalid signature (403)', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CAxxx',
    CallStatus: 'ringing',
  });
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);
  assert.strictEqual(res.status, 403);
  assert.ok(String(res.headers['content-type']).startsWith('text/xml'));
  assert.strictEqual(ctx.captured.calls.length, 0);
  assert.strictEqual(ctx.captured.callsUpdates.length, 0);
});

test('voice: signed webhook acks with Say envelope and runs the command', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = {
    From: '+49 170 1234567',
    CallSid: 'CAsigned1',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/voice/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  assert.strictEqual(res.status, 200);
  // Ack TwiML includes both immediate feedback and a silent hold window.
  assert.ok(res.body.includes('<Response>'));
  assert.ok(res.body.includes('<Say'));
  assert.ok(res.body.includes('Bitte warten'));
  assert.ok(res.body.includes('<Pause length="35"/>'));

  // Router received a normalised message.
  assert.strictEqual(ctx.captured.calls.length, 1);
  assert.strictEqual(ctx.captured.calls[0].channel, 'voice');
  assert.strictEqual(ctx.captured.calls[0].from, '491701234567');
  // The router body is the configured voice.command.
  assert.strictEqual(ctx.captured.calls[0].body, 'uptime');
  assert.strictEqual(ctx.captured.calls[0].metadata.callSid, 'CAsigned1');

  // Outbound reply was sent via the stubbed calls.update.
  assert.strictEqual(ctx.captured.callsUpdates.length, 1);
  assert.strictEqual(ctx.captured.callsUpdates[0].sid, 'CAsigned1');
  assert.ok(ctx.captured.callsUpdates[0].twiml.includes('<Say'));
  assert.ok(ctx.captured.callsUpdates[0].twiml.includes('OK'));
});

test('voice: ack uses configured pause length and caps oversized values', async (t) => {
  const configured = await bootTestServer({
    validateSignature: false,
    voiceOverrides: { ackPauseSeconds: 7.8 },
  });
  t.after(() => configured.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CApause7',
    CallStatus: 'in-progress',
  });
  const configuredRes = await postForm(configured.port, '/voice/inbound', {}, body);
  assert.ok(configuredRes.body.includes('<Pause length="7"/>'));

  const capped = await bootTestServer({
    validateSignature: false,
    voiceOverrides: { ackPauseSeconds: 601 },
  });
  t.after(() => capped.close());
  const cappedRes = await postForm(capped.port, '/voice/inbound', {}, body);
  assert.ok(cappedRes.body.includes('<Pause length="600"/>'));
});

test('voice: invalid ack pause falls back to the default', async (t) => {
  const ctx = await bootTestServer({
    validateSignature: false,
    voiceOverrides: { ackPauseSeconds: 0 },
  });
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CApauseDefault',
    CallStatus: 'in-progress',
  });
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);
  assert.ok(res.body.includes('<Pause length="35"/>'));
});

test('voice: malformed webhook gets a short ack without a pause', async (t) => {
  const ctx = await bootTestServer({ validateSignature: false });
  t.after(() => ctx.close());

  const body = urlencodedBody({ From: '+491701234567' });
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Bitte warten'));
  assert.ok(!res.body.includes('<Pause'));
  assert.strictEqual(ctx.captured.calls.length, 0);
  assert.strictEqual(ctx.captured.callsUpdates.length, 0);
});

test('voice: trims voice.command before forwarding it to the router', async (t) => {
  const ctx = await bootTestServer({
    validateSignature: false,
    voiceOverrides: { command: '  uptime  ' },
  });
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CAtrimmed',
    CallStatus: 'in-progress',
  });
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 1);
  assert.strictEqual(ctx.captured.calls[0].body, 'uptime');
});

test('voice: handler failure before ack returns safe TwiML without executing', async (t) => {
  const ctx = await bootTestServer({
    validateSignature: false,
    routerStub: {
      async handleMessage() {
        throw new Error('router failed');
      },
    },
  });
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CAhandlerFailure',
    CallStatus: 'in-progress',
  });
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Bitte warten'));
  assert.ok(!res.body.includes('<Pause'));
  assert.strictEqual(ctx.captured.callsUpdates.length, 0);
});

test('voice: signature uses X-Forwarded-* headers (public URL)', async (t) => {
  const ctx = await bootTestServer({
    baseUrl: 'https://bot.example.com/voice/inbound',
  });
  t.after(() => ctx.close());

  const params = {
    From: '+491701234567',
    CallSid: 'CAsigned2',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    'https://bot.example.com/voice/inbound',
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/voice/inbound',
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

test('voice: unknown caller gets a short ack and is never held on the line', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = {
    From: '+49 999 9999999',
    CallSid: 'CAunknown',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/voice/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  // Unknown callers get a short ack; the router deliberately sends no result.
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Bitte warten'));
  assert.ok(!res.body.includes('<Pause'));
  // Router never sees unknown callers.
  assert.strictEqual(ctx.captured.calls.length, 0);
  assert.strictEqual(ctx.captured.callsUpdates.length, 0);
});

test('voice: missing CallSid is acked with 200 but not forwarded', async (t) => {
  const ctx = await bootTestServer();
  t.after(() => ctx.close());

  const params = {
    From: '+491701234567',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  const res = await postForm(
    ctx.port,
    '/voice/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 0);
});

test('voice: validateSignature=false still accepts (with warn)', async (t) => {
  const ctx = await bootTestServer({ validateSignature: false });
  t.after(() => ctx.close());

  const body = urlencodedBody({
    From: '+491701234567',
    CallSid: 'CAnosig',
    CallStatus: 'in-progress',
  });
  // No signature header at all.
  const res = await postForm(ctx.port, '/voice/inbound', {}, body);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ctx.captured.calls.length, 1);
});

test('voice: outbound reply TwiML escapes XML metacharacters in command output', async (t) => {
  // Replace the router stub to simulate a command whose output contains
  // XML-unsafe characters. The reply TwiML must escape them.
  const ctx = await bootTestServer({
    routerStub: {
      async handleMessage(m) {
        if (typeof m.onAccepted === 'function') {
          await m.onAccepted();
        }
        await m.reply('<script>alert(1)</script> & friends');
      },
    },
  });
  t.after(() => ctx.close());

  const params = {
    From: '+491701234567',
    CallSid: 'CAescape',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    ctx.publicUrl,
    params
  );

  const body = urlencodedBody(params);
  await postForm(
    ctx.port,
    '/voice/inbound',
    { 'x-twilio-signature': signature },
    body
  );

  assert.strictEqual(ctx.captured.callsUpdates.length, 1);
  const twiml = ctx.captured.callsUpdates[0].twiml;
  assert.ok(!twiml.includes('<script>'), 'raw <script> would break XML');
  assert.ok(twiml.includes('&lt;script&gt;'));
  assert.ok(twiml.includes('&amp;'));
});

test('voice: outbound reply failure (caller hung up) does not crash the webhook', async (t) => {
  // Simulate a calls.update that throws the kind of error Twilio returns
  // when the caller has hung up. The webhook promise must still resolve.
  const stubTwilio = {
    calls(sid) {
      return {
        async update() {
          const err = new Error('Call is not in-progress');
          err.code = 13231;
          throw err;
        },
      };
    },
  };

  fs.mkdirSync(BASE_CFG.logging.directory, { recursive: true });
  initLogger(BASE_CFG, { console: false });
  const cfg = JSON.parse(JSON.stringify(BASE_CFG));
  const stubRouter = {
    async handleMessage(m) {
      if (typeof m.onAccepted === 'function') {
        await m.onAccepted();
      }
      await m.reply('hi');
    },
  };
  const built = createVoiceApp(cfg, stubRouter, stubTwilio);
  const server = http.createServer(built.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const params = {
    From: '+491701234567',
    CallSid: 'CAhungup',
    CallStatus: 'in-progress',
  };
  const signature = makeSignedRequest(
    BASE_CFG.voice.twilioAuthToken,
    `http://127.0.0.1:${port}${built.webhookPath}`,
    params
  );
  const body = urlencodedBody(params);

  const res = await postForm(
    port,
    '/voice/inbound',
    { 'x-twilio-signature': signature },
    body
  );
  assert.strictEqual(res.status, 200);
});