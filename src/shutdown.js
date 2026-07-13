/**
 * Clean shutdown handler.
 *
 * Decision: NEVER call process.exit() directly from a request handler or
 * the executor. Always go through requestShutdown() so we can:
 *   1. Stop accepting new messages (unhook the listener).
 *   2. Close network listeners (HTTP server).
 *   3. Wait for any in-flight child processes to finish (or kill them).
 *   4. Close the WhatsApp client cleanly (which logs out gracefully).
 *   5. THEN exit.
 *
 * systemd will SIGTERM us on `systemctl stop`, so we install a single
 * SIGTERM/SIGINT handler that runs the same teardown.
 *
 * The teardown is composed from two hook points:
 *   - onBeforeExit (singular): detach listeners, etc.
 *   - cleanupFns (array, registered via registerCleanup): close HTTP
 *     servers, etc. Each one is awaited in order.
 */

'use strict';

const { getLogger } = require('./logger');

let shuttingDown = false;
let activeChildren = new Set();
let onBeforeExit = null;
const cleanupFns = [];

/**
 * Register a child process so the shutdown handler can wait for / kill it.
 */
function trackChild(child) {
  if (!child || typeof child.pid !== 'number') return;
  activeChildren.add(child);
  child.once('exit', () => {
    activeChildren.delete(child);
  });
}

/**
 * Unregister a child process manually (e.g. after it has been reaped).
 */
function untrackChild(child) {
  activeChildren.delete(child);
}

/**
 * Register a cleanup function that runs during shutdown, in registration
 * order. Used for closing HTTP servers, etc.
 *
 * The function may return a Promise. Errors are logged but don't block
 * the rest of the cleanup chain.
 */
function registerCleanup(fn) {
  if (typeof fn === 'function') {
    cleanupFns.push(fn);
  }
}

/**
 * Schedule a clean shutdown. Safe to call multiple times — the second
 * call short-circuits.
 *
 * @param {object} ctx  { exitCode, client, reason }
 */
async function requestShutdown(ctx = {}) {
  if (shuttingDown) return;
  shuttingDown = true;

  const logger = getLogger();
  const exitCode = typeof ctx.exitCode === 'number' ? ctx.exitCode : 0;
  const reason = ctx.reason || 'unspecified';

  logger.info(`Shutdown angefordert (reason=${reason}, exitCode=${exitCode}).`);

  // 1. Optional callback (e.g. to detach the whatsapp-web.js listener).
  if (typeof onBeforeExit === 'function') {
    try {
      await onBeforeExit();
    } catch (err) {
      logger.warn(`onBeforeExit-Hook fehlgeschlagen: ${err.message}`);
    }
  }

  // 2. Registered cleanups — e.g. SMS HTTP server.
  for (const fn of cleanupFns) {
    try {
      await fn(ctx);
    } catch (err) {
      logger.warn(`Cleanup fehlgeschlagen: ${err.message}`);
    }
  }

  // 3. Destroy the WhatsApp client — this closes the underlying page.
  if (ctx.client && typeof ctx.client.destroy === 'function') {
    try {
      await ctx.client.destroy();
      logger.info('WhatsApp-Client sauber beendet.');
    } catch (err) {
      logger.warn(`Client-Destroy fehlgeschlagen: ${err.message}`);
    }
  }

  // 4. Wait briefly for in-flight children, then SIGTERM them.
  const waitMs = 2000;
  if (activeChildren.size > 0) {
    logger.info(`Warte auf ${activeChildren.size} laufende Kinder …`);
    const deadline = Date.now() + waitMs;
    while (activeChildren.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const child of activeChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }

  logger.info('Shutdown abgeschlossen.');
  // Give winston a tick to flush.
  setTimeout(() => process.exit(exitCode), 100);
}

/**
 * Install SIGTERM/SIGINT handlers. Returns a teardown function (for tests).
 */
function installSignalHandlers(ctxFactory) {
  const handler = (signal) => {
    requestShutdown({ ...ctxFactory(), reason: signal });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));

  return () => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  };
}

/**
 * Set a callback to run before process.exit (e.g. to detach the message
 * listener). Called once per shutdown sequence.
 */
function setBeforeExitHook(fn) {
  onBeforeExit = fn;
}

module.exports = {
  trackChild,
  untrackChild,
  registerCleanup,
  requestShutdown,
  installSignalHandlers,
  setBeforeExitHook,
};