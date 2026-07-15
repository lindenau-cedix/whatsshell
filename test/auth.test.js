/**
 * Auth tests — focused on buildClient()'s puppeteer launch options.
 *
 * These assert the Chromium-HOME workaround: the browser child must get its
 * own writable HOME so crashpad can create its database, WITHOUT mutating
 * this process's environment (which the command executor inherits) and
 * WITHOUT nesting that HOME inside the session path (which would fool
 * index.js's "already paired?" heuristic). See the Decision: comment in
 * src/auth.js and the regression it guards against
 * ("chrome_crashpad_handler: --database is required").
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildClient } = require('../src/auth');

// A temp session path so the test never writes into /opt.
function makeConfig() {
  const sessionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-auth-test-'));
  return { whatsapp: { sessionPath } };
}

test('buildClient: sets a browser HOME under the system temp dir', () => {
  const cfg = makeConfig();
  const client = buildClient(cfg);
  const env = client.options.puppeteer.env;

  assert.ok(env, 'puppeteer.env must be set');
  assert.ok(env.HOME, 'puppeteer.env.HOME must be set');
  assert.strictEqual(
    path.dirname(env.HOME),
    fs.realpathSync(os.tmpdir()),
    'browser HOME must live directly under the system temp dir'
  );
});

test('buildClient: the browser HOME exists and is writable', () => {
  const cfg = makeConfig();
  const client = buildClient(cfg);
  const home = client.options.puppeteer.env.HOME;

  assert.ok(fs.existsSync(home), 'browser HOME dir must be created eagerly');
  // Prove crashpad could actually write its database there.
  const probe = path.join(home, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
});

test('buildClient: browser HOME is NOT inside the session path', () => {
  const cfg = makeConfig();
  const client = buildClient(cfg);
  const home = client.options.puppeteer.env.HOME;

  // index.js treats a non-empty sessionPath as "already paired"; a browser
  // home nested there would break first-run QR pairing.
  assert.ok(
    !home.startsWith(cfg.whatsapp.sessionPath),
    'browser HOME must not live inside sessionPath'
  );
  const sessionEntries = fs.readdirSync(cfg.whatsapp.sessionPath);
  assert.deepStrictEqual(
    sessionEntries,
    [],
    'buildClient must not populate sessionPath (would trip the paired-heuristic)'
  );
});

test('buildClient: inherits the parent environment (PATH preserved)', () => {
  const cfg = makeConfig();
  const client = buildClient(cfg);
  const env = client.options.puppeteer.env;

  assert.strictEqual(env.PATH, process.env.PATH, 'PATH must be inherited by the browser child');
});

test('buildClient: does NOT mutate this process HOME', () => {
  const cfg = makeConfig();
  const originalHome = process.env.HOME;
  const client = buildClient(cfg);

  assert.strictEqual(
    process.env.HOME,
    originalHome,
    'process.env.HOME must be untouched — executor children inherit it'
  );
  // And the override is genuinely a different dir, not a no-op.
  assert.notStrictEqual(client.options.puppeteer.env.HOME, originalHome);
});

test('buildClient: does not pin userDataDir (LocalAuth owns that later)', () => {
  const cfg = makeConfig();
  const client = buildClient(cfg);

  // LocalAuth throws if a user-supplied userDataDir differs from its own
  // computed session dir, so buildClient must leave it unset at construction.
  assert.strictEqual(client.options.puppeteer.userDataDir, undefined);
});

test('buildClient: falls back to /usr/bin/chromium when env var unset', () => {
  // puppeteer-core has no bundled browser; an undefined executablePath would
  // make it hunt ~/.cache/puppeteer and throw "Could not find Chrome".
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const client = buildClient(makeConfig());
    assert.strictEqual(client.options.puppeteer.executablePath, '/usr/bin/chromium');
  } finally {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  }
});

test('buildClient: honours PUPPETEER_EXECUTABLE_PATH when set', () => {
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/custom/chrome';
  try {
    const client = buildClient(makeConfig());
    assert.strictEqual(client.options.puppeteer.executablePath, '/opt/custom/chrome');
  } finally {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  }
});
