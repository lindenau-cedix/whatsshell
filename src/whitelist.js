/**
 * Whitelist logic.
 *
 * Decision: We store phone numbers in E.164 format without the leading "+"
 * (e.g. "491701234567") because that is what whatsapp-web.js exposes on
 * incoming messages (msg.from). The format is canonical and unambiguous.
 *
 * Commands are matched by *exact string equality* against the
 * `whitelist.commands[*].command` field. We reject anything that contains
 * shell metacharacters, redirection, subshells, or newlines BEFORE the
 * lookup. That way, even if a malicious user somehow injected a matching
 * string, the upstream parser would never pass it here.
 */

'use strict';

/**
 * Characters that have shell meaning. We refuse any command containing any
 * of these even if it happens to be a whitelisted command — the whitelist
 * itself must be clean.
 *
 * - `;` `&` `|` — command chaining / pipes
 * - `` ` `` `$` — command substitution
 * - `>` `<` — redirection
 * - newlines — multi-line command injection
 * - `*` `?` `[` `]` — globbing (we disallow; whitelisted commands must be
 *   fully explicit). Some legitimate commands (e.g. `ls *`) would need to
 *   be written as `ls /specific/path` instead.
 * - `( )` `{ }` — subshell / grouping
 * - `\\` — escape sequences
 */
const FORBIDDEN_PATTERN = /[;&|`$<>*?(){}\\\r\n\t]/;

/**
 * Validate a command string against the whitelist.
 *
 * @param {string} input            The raw text from the WhatsApp message.
 * @param {Array}  whitelistedCmds  Array of {name, command, description}.
 * @returns {{ok: true, entry: object} | {ok: false, reason: string}}
 */
function validateCommand(input, whitelistedCmds) {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not_a_string' };
  }

  // Trim trailing whitespace but preserve exact tokenisation of the rest.
  const text = input.trim();

  if (text.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  if (text.includes('\n') || text.includes('\r')) {
    return { ok: false, reason: 'multiline' };
  }

  if (FORBIDDEN_PATTERN.test(text)) {
    return { ok: false, reason: 'forbidden_chars' };
  }

  // Exact match against whitelisted commands.
  for (const entry of whitelistedCmds) {
    if (entry && typeof entry.command === 'string' && entry.command === text) {
      return { ok: true, entry };
    }
  }

  return { ok: false, reason: 'unknown_command' };
}

/**
 * Check whether a phone number (in E.164 without `+`) is whitelisted.
 *
 * @param {string} senderNumber
 * @param {Array<string>} whitelistedNumbers
 * @returns {boolean}
 */
function isNumberWhitelisted(senderNumber, whitelistedNumbers) {
  if (typeof senderNumber !== 'string') return false;
  // Defensive: strip anything that isn't a digit, then compare.
  const normalised = senderNumber.replace(/[^\d]/g, '');
  return whitelistedNumbers.includes(normalised);
}

/**
 * Determine whether a message came from a group chat. whatsapp-web.js sets
 * msg.from for 1:1 chats and msg.id.remote ends with `@g.us` for groups.
 *
 * @param {object} msg  The whatsapp-web.js Message object.
 * @returns {boolean}
 */
function isGroupMessage(msg) {
  if (!msg) return false;
  if (typeof msg.from === 'string' && msg.from.endsWith('@g.us')) return true;
  if (msg.id && typeof msg.id.remote === 'string' && msg.id.remote.endsWith('@g.us')) {
    return true;
  }
  return false;
}

module.exports = {
  validateCommand,
  isNumberWhitelisted,
  isGroupMessage,
  FORBIDDEN_PATTERN,
};