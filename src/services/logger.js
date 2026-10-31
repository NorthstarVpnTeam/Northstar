'use strict';

/**
 * Application logger with secret redaction and a bounded ring buffer.
 *
 * Rules:
 *   - full configuration URIs and credentials are never written
 *   - dynamic secrets (current server credentials) are redacted on write
 *   - the exported bundle is diagnostics-only: settings, stats, statuses, logs
 */

const { LIMITS, APP_VERSION } = require('../shared/constants');
const { redact } = require('./core-config');

class Logger {
  constructor({ onLine, verbose = false } = {}) {
    this.lines = [];
    this.onLine = onLine || null;
    this.verbose = verbose;
    this._secrets = [];
    this.startedAt = Date.now();
  }

  setSecrets(secrets) {
    this._secrets = Array.isArray(secrets) ? secrets.filter(Boolean) : [];
  }

  setVerbose(verbose) {
    this.verbose = Boolean(verbose);
  }

  _write(level, message, context) {
    if (level === 'debug' && !this.verbose) return;
    const safeMessage = redact(String(message), this._secrets);
    let safeContext = null;
    if (context && typeof context === 'object') {
      safeContext = {};
      for (const [key, value] of Object.entries(context)) {
        if (typeof value === 'string') safeContext[key] = redact(value, this._secrets);
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          safeContext[key] = value;
        } else safeContext[key] = '[complex]';
      }
    }
    const line = { ts: Date.now(), level, message: safeMessage, context: safeContext };
    this.lines.push(line);
    if (this.lines.length > LIMITS.LOG_RING_SIZE) this.lines.shift();
    if (this.onLine) this.onLine(line);
  }

  info(message, context) {
    this._write('info', message, context);
  }
  warn(message, context) {
    this._write('warn', message, context);
  }
  error(message, context) {
    this._write('error', message, context);
  }
  debug(message, context) {
    this._write('debug', message, context);
  }

  recent(limit = 100) {
    return this.lines.slice(-Math.max(1, Math.min(limit, LIMITS.LOG_RING_SIZE)));
  }

  /**
   * Builds a redacted diagnostics bundle for export.
   * @param {object} extras statuses supplied by the caller
   */
  redactedBundle(extras = {}) {
    return {
      generatedAt: new Date().toISOString(),
      app: { name: 'Northstar V2Ray', version: APP_VERSION },
      platform: { os: process.platform, arch: process.arch, node: process.versions.node },
      runtime: { electron: process.versions.electron || null },
      logs: this.recent(LIMITS.LOG_RING_SIZE),
      ...extras,
      note:
        'This file is redacted: configuration URIs, credentials and server secrets are removed.',
    };
  }
}

module.exports = { Logger };
