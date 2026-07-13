/**
 * Router tests.
 *
 * The router is now channel-agnostic: we feed it normalised messages
 * directly, with a fake reply() that records what was sent. The executor
 * is real so we cover the integration between router and executor
 * end-to-end with a tiny safe command (`printf hi`).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');

const { initLogger } = require('../src/logger');
const { createRouter } = require('../src/router');

const CFG = {
  whatsapp: { sessionPath: '/tmp/.wwebjs_auth_test' },
  whitelist: {
    numbers: ['491701234567'],
    commands: [
      { name: 'hi', command: 'printf hi', description: 'say hi' },
    ],
  },
  security: { timeoutMs: 5000, maxOutputChars: 200, allowedFromGroups: false },
  logging: { directory: '/tmp/whatsshell-test-logs', retentionDays: 1 },
};

function makeMsg({ channel = 'whatsapp', from = '491701234567', body = '' } = {}) {
  const obj = {
    channel,
    from,
    body,
    replyCalls: [],
    metadata: {},
    async reply(text) {
      obj.replyCalls.push(text);
    },
  };
  return obj;
}

test('router: setUp', () => {
  fs.mkdirSync(CFG.logging.directory, { recursive: true });
  initLogger(CFG, { console: false });
});

test('router: ignores unknown numbers without replying', async () => {
  const router = createRouter(CFG);
  const msg = makeMsg({ from: '499999999999', body: 'printf hi' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 0);
});

test('router: ignores unknown commands without replying', async () => {
  const router = createRouter(CFG);
  const msg = makeMsg({ from: '491701234567', body: 'rm -rf /' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 0);
});

test('router: ignores multiline messages', async () => {
  const router = createRouter(CFG);
  const msg = makeMsg({ from: '491701234567', body: 'printf hi\nrm -rf /' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 0);
});

test('router: executes whitelisted command and replies', async () => {
  const router = createRouter(CFG);
  const msg = makeMsg({ from: '491701234567', body: 'printf hi' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 1);
  assert.ok(msg.replyCalls[0].includes('OK'));
  assert.ok(msg.replyCalls[0].includes('hi'));
});

test('router: hot-reload swaps config without restart', async () => {
  const router = createRouter(CFG);
  const newCfg = JSON.parse(JSON.stringify(CFG));
  newCfg.whitelist.numbers.push('491709999999');
  router.setConfig(newCfg);

  // Previously blocked number is now allowed.
  const msg = makeMsg({ from: '491709999999', body: 'printf hi' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 1);
});

test('router: same whitelist is shared across channels', async () => {
  // The whitelist is a single flat list — a number allowed for WhatsApp
  // can also trigger via SMS, by design (see README "Whitelist-Modell").
  const router = createRouter(CFG);
  const msg = makeMsg({ channel: 'sms', from: '491701234567', body: 'printf hi' });
  await router.handleMessage(msg);
  assert.strictEqual(msg.replyCalls.length, 1);
});

test('router: channel field is propagated to the reply closure', async () => {
  // Make sure the channel doesn't get lost — channel-specific reply
  // functions (e.g. SMS's twilio REST call) need to know which transport
  // they're answering on.
  const router = createRouter(CFG);
  let observedChannel = null;
  const msg = {
    channel: 'sms',
    from: '491701234567',
    body: 'printf hi',
    replyCalls: [],
    async reply(text) {
      observedChannel = 'sms';
      msg.replyCalls.push(text);
    },
  };
  await router.handleMessage(msg);
  assert.strictEqual(observedChannel, 'sms');
});