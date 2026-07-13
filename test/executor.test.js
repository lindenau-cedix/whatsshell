/**
 * Executor tests — focused on tokenisation and output truncation.
 * Real command execution is covered indirectly by the router test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { tokenise, executeCommand, formatResult } = require('../src/executor');
const { initLogger } = require('../src/logger');

// Initialise a no-op logger so executeCommand() doesn't throw on getLogger().
initLogger(
  { logging: { directory: '/tmp/whatsshell-test-logs', retentionDays: 1 } },
  { console: false }
);

test('tokenise: simple command', () => {
  assert.deepStrictEqual(tokenise('uptime'), ['uptime']);
});

test('tokenise: command with args', () => {
  assert.deepStrictEqual(tokenise('docker ps -a'), ['docker', 'ps', '-a']);
});

test('tokenise: handles double-quoted strings', () => {
  assert.deepStrictEqual(tokenise('echo "hello world"'), ['echo', 'hello world']);
});

test('tokenise: handles single-quoted strings', () => {
  assert.deepStrictEqual(tokenise("grep -c 'foo bar' file"), ['grep', '-c', 'foo bar', 'file']);
});

test('tokenise: collapses internal whitespace', () => {
  assert.deepStrictEqual(tokenise('df   -h'), ['df', '-h']);
});

test('tokenise: rejects unterminated quote', () => {
  assert.throws(() => tokenise('echo "unfinished'), /Unterminated quote/);
});

test('tokenise: empty string throws', () => {
  assert.throws(() => tokenise('   '), /Empty command/);
});

test('executeCommand: safe printf round-trip', async () => {
  const r = await executeCommand('printf hi', { timeoutMs: 5000, maxOutputChars: 100 });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, 'hi');
  assert.strictEqual(r.timedOut, false);
});

test('executeCommand: respects timeout', async () => {
  const r = await executeCommand('sleep 5', { timeoutMs: 500, maxOutputChars: 100 });
  assert.strictEqual(r.timedOut, true);
});

test('executeCommand: captures non-zero exit code', async () => {
  const r = await executeCommand('false', { timeoutMs: 1000, maxOutputChars: 100 });
  assert.strictEqual(r.exitCode, 1);
});

test('executeCommand: truncates long output with marker', async () => {
  // `seq 1 1000` produces ~3893 chars.
  const r = await executeCommand('seq 1 1000', { timeoutMs: 5000, maxOutputChars: 200 });
  assert.ok(r.stdout.length <= 200 + '\n[…gekürzt…]'.length);
  assert.ok(r.stdout.includes('[…gekürzt…]'));
});

test('formatResult: success message', () => {
  const text = formatResult({
    stdout: 'all good',
    stderr: '',
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
  });
  assert.ok(text.includes('✅'));
  assert.ok(text.includes('all good'));
});

test('formatResult: failure message', () => {
  const text = formatResult({
    stdout: '',
    stderr: 'boom',
    exitCode: 2,
    durationMs: 5,
    timedOut: false,
  });
  assert.ok(text.includes('Exit-Code 2'));
  assert.ok(text.includes('boom'));
});

test('formatResult: timeout message', () => {
  const text = formatResult({
    stdout: '',
    stderr: '',
    exitCode: -1,
    durationMs: 30000,
    timedOut: true,
  });
  assert.ok(text.includes('Timeout'));
});