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
 * Format the executor result for sending back to the user.
 *
 * The default output is markdown-friendly (backticks, emoji status line) and
 * is consumed by WhatsApp and SMS. When `opts.channel === 'voice'` we switch
 * to a TTS-friendly form: no markdown fences (TTS reads them aloud), German
 * status words instead of emoji, and a hard cap well under Twilio's 4000-
 * char `<Say>` limit regardless of the per-channel maxOutputChars setting.
 *
 * Keeping the legacy single-arg call working means existing call sites
 * (router.handleMessage, executor tests) need no change.
 */
function formatResult(result, opts = {}) {
  if (opts && opts.channel === 'voice') {
    return formatResultForTTS(result, opts);
  }
  return formatResultDefault(result);
}

function formatResultDefault(result) {
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

/**
 * TTS-friendly variant. Strips markdown fences, replaces emoji with German
 * status words, and concatenates stdout/stderr as plain prose. A hard cap of
 * 3500 chars sits well under Twilio's 4000-char `<Say>` limit and keeps the
 * spoken reply short enough for a phone call.
 *
 * Decision: we collapse multi-line stdout into single spaces. TTS pauses at
 * every line break (a `<break>` in SSML terms), which sounds unnatural when
 * reading command output like `df -h`. Joining with a space reads like a
 * sentence.
 */
const VOICE_HARD_CAP = 3500;

function formatResultForTTS(result, opts) {
  const maxChars = (opts && typeof opts.maxOutputChars === 'number')
    ? Math.min(opts.maxOutputChars, VOICE_HARD_CAP)
    : VOICE_HARD_CAP;

  let statusLine;
  if (result.timedOut) {
    statusLine = 'Zeitüberschreitung.';
  } else if (result.exitCode !== 0) {
    statusLine = `Fehler, Exit-Code ${result.exitCode}.`;
  } else {
    statusLine = 'OK.';
  }

  const parts = [statusLine];
  if (result.stdout && result.stdout.trim().length > 0) {
    parts.push(result.stdout.trim().replace(/\s+/g, ' '));
  }
  if (result.stderr && result.stderr.trim().length > 0) {
    parts.push('Fehlermeldung: ' + result.stderr.trim().replace(/\s+/g, ' '));
  }

  const joined = parts.join(' ');
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + ' (Ausgabe gekürzt)';
}

module.exports = {
  executeCommand,
  formatResult,
  tokenise,
};