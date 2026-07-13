/**
 * Safe command execution.
 *
 * Decision: We deliberately use child_process.execFile, NOT exec, because
 * execFile does not spawn a shell. The first argument is the executable,
 * the second is an array of arguments. There is no string interpretation,
 * no metacharacter handling, no $IFS splitting. The whitelist itself is
 * already validated for shell metacharacters upstream, but execFile is the
 * belt-and-suspenders second line of defence.
 *
 * Even though the whitelisted commands are short, well-known strings, we
 * split them into [program, ...args] with a small purpose-built tokenizer
 * that honours quoted strings (single + double). This means the whitelist
 * can contain commands like `docker ps -a --filter "name=web"` safely.
 */

'use strict';

const { execFile } = require('child_process');
const { getLogger } = require('./logger');

/**
 * Tokenise a command string respecting single- and double-quoted spans.
 *
 * Why hand-rolled instead of shell-quote / npm package?
 * - The whitelisted commands are a tiny, well-controlled set. Pulling in
 *   another dependency for one helper is overkill.
 * - Keeps the security-critical tokenisation under our own eyes and tests.
 *
 * Examples:
 *   'df -h'                     -> ['df', '-h']
 *   'docker ps -a'              -> ['docker', 'ps', '-a']
 *   'echo "hello world"'        -> ['echo', 'hello world']
 *   "grep -c 'foo bar' file"    -> ['grep', '-c', 'foo bar', 'file']
 *
 * The function is intentionally strict: unmatched quotes throw. That's
 * better than silently dropping the trailing fragment.
 */
function tokenise(cmdString) {
  const tokens = [];
  let current = '';
  let quote = null; // '"', "'", or null
  let hasContent = false;

  for (let i = 0; i < cmdString.length; i++) {
    const ch = cmdString[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += ch;
    hasContent = true;
  }

  if (quote) {
    throw new Error(`Unterminated quote in command: ${cmdString}`);
  }
  if (hasContent) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error('Empty command after tokenisation.');
  }

  return tokens;
}

/**
 * Execute a whitelisted command and resolve with its result.
 *
 * @param {string} cmdString   The exact command string from whitelist.commands
 * @param {object} opts        { timeoutMs, maxOutputChars, cwd }
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number, timedOut: boolean}>}
 */
function executeCommand(cmdString, opts = {}) {
  const logger = getLogger();
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
  const maxChars = typeof opts.maxOutputChars === 'number' ? opts.maxOutputChars : 4000;
  const cwd = opts.cwd || process.cwd();

  let argv;
  try {
    argv = tokenise(cmdString);
  } catch (err) {
    return Promise.resolve({
      stdout: '',
      stderr: `Interner Tokenisierungs-Fehler: ${err.message}`,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
    });
  }

  const [program, ...args] = argv;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      {
        timeout: timeoutMs,
        cwd,
        // Cap the buffer — execFile's default is 1 MB which we never need.
        maxBuffer: maxChars * 4,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        let timedOut = false;
        let exitCode = 0;

        if (error) {
          if (error.killed && error.signal === 'SIGTERM') {
            timedOut = true;
          }
          exitCode = typeof error.code === 'number' ? error.code : 1;
        }

        resolve({
          stdout: truncate(String(stdout || ''), maxChars),
          stderr: truncate(String(stderr || ''), maxChars),
          exitCode,
          durationMs,
          timedOut,
        });
      }
    );

    // Best-effort: log unexpected exits of children for the audit trail.
    child.on('exit', (code, signal) => {
      if (signal) {
        logger.warn(`Kommando '${cmdString}' per Signal ${signal} beendet.`);
      }
    });
  });
}

/**
 * Truncate a string to maxChars and append a marker if shortened.
 */
function truncate(str, maxChars) {
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + '\n[…gekürzt…]';
}

/**
 * Format the executor result for sending back to the user via WhatsApp.
 * Keeps the message compact and indicates failure clearly.
 */
function formatResult(result) {
  const parts = [];
  if (result.timedOut) {
    parts.push(`⏱ Timeout nach ${Math.round(result.durationMs / 1000)}s.`);
  } else if (result.exitCode !== 0) {
    parts.push(`❌ Exit-Code ${result.exitCode} nach ${result.durationMs}ms.`);
  } else {
    parts.push(`✅ OK (${result.durationMs}ms).`);
  }
  if (result.stdout && result.stdout.trim().length > 0) {
    parts.push('```\n' + result.stdout.trim() + '\n```');
  }
  if (result.stderr && result.stderr.trim().length > 0) {
    parts.push('stderr:\n```\n' + result.stderr.trim() + '\n```');
  }
  return parts.join('\n');
}

module.exports = {
  executeCommand,
  formatResult,
  tokenise,
};