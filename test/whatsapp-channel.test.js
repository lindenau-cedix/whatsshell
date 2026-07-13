/**
 * WhatsApp channel adapter tests — focused on the extraction helpers,
 * which are the only stateful pieces that aren't trivially the router's
 * responsibility.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractSender } = require('../src/channels/whatsapp');

test('extractSender: strips @c.us and non-digits', () => {
  assert.strictEqual(extractSender({ from: '491701234567@c.us' }), '491701234567');
});

test('extractSender: handles spaces in number', () => {
  assert.strictEqual(extractSender({ from: '+49 170 1234567@c.us' }), '491701234567');
});

test('extractSender: returns empty on missing from', () => {
  assert.strictEqual(extractSender({}), '');
});

test('extractSender: returns empty on null', () => {
  assert.strictEqual(extractSender(null), '');
});