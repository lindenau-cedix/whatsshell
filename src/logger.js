/**
 * winston logger configuration with daily rotating log files.
 *
 * Decision: We use winston-daily-rotate-file because it gives us
 * automatic rotation + retention without needing logrotate on the host.
 * The systemd unit file directs stdout/stderr to the journal separately,
 * so this file logger is the authoritative audit trail.
 */

'use strict';

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

let config = null;
let logger = null;

/**
 * Build the daily-rotating file transport.
 */
function buildFileTransport(dir, retentionDays) {
  return new winston.transports.DailyRotateFile({
    dirname: dir,
    filename: 'whatsapp-shell-bot-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '20m',
    maxFiles: `${retentionDays}d`,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
  });
}

/**
 * Console transport for foreground (TTY) runs — e.g. the one-time QR scan.
 */
function buildConsoleTransport() {
  return new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} ${level} ${message}${metaStr}`;
      })
    ),
  });
}

/**
 * Initialise the logger. Must be called before any other module logs.
 *
 * @param {object} cfg   Parsed config.json
 * @param {object} opts  { console: boolean }  – enable console transport (foreground mode)
 */
function initLogger(cfg, opts = {}) {
  config = cfg;
  const transports = [];

  if (cfg.logging && cfg.logging.directory) {
    try {
      transports.push(
        buildFileTransport(cfg.logging.directory, cfg.logging.retentionDays || 14)
      );
    } catch (err) {
      // Last-resort: if the log dir can't be opened we still want stderr output.
      // eslint-disable-next-line no-console
      console.error(`Failed to create file transport: ${err.message}`);
    }
  }

  if (opts.console) {
    transports.push(buildConsoleTransport());
  }

  logger = winston.createLogger({
    level: 'info',
    transports,
    exitOnError: false,
  });

  return logger;
}

/**
 * Returns the singleton logger. Throws if not initialised.
 */
function getLogger() {
  if (!logger) {
    throw new Error('Logger not initialised — call initLogger() first.');
  }
  return logger;
}

module.exports = { initLogger, getLogger };