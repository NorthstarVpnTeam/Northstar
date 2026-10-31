'use strict';

/**
 * System proxy mode (Windows).
 *
 * While a connection is active, Northstar can point the current user's WinINet
 * proxy settings at its local HTTP proxy so applications that follow the
 * system proxy route through the tunnel. The previous settings are captured
 * first and restored on disconnect; if another program changed the proxy in
 * the meantime, the restore is skipped so Northstar never clobbers somebody
 * else's configuration.
 *
 * Everything is opt-in: nothing here runs unless the user enabled the
 * "System proxy" setting, and it runs only on Windows.
 *
 * The WinINet work happens in scripts/system-proxy.ps1, executed with
 * execFile (no shell) and JSON passed over stdin. Pure Node so it is testable
 * with an injected executor.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_SOURCE = path.join(__dirname, '..', '..', 'scripts', 'system-proxy.ps1');
const SCRIPT_TIMEOUT_MS = 15000;

function defaultExec(scriptPath, action, input) {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Action',
        action,
      ],
      { timeout: SCRIPT_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error,
          code: error && typeof error.code === 'number' ? error.code : null,
          timedOut: Boolean(error && error.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
    child.stdin.on('error', () => {
      /* the child may exit before reading stdin */
    });
    child.stdin.end(input || '');
  });
}

/** Parses the single JSON object the PowerShell helper prints. */
function parseOutput(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

class SystemProxyService {
  /**
   * @param {object} [options]
   * @param {string} [options.platform]
   * @param {string} [options.userDataDir] where the materialized script lives
   * @param {Function} [options.execImpl] injected for tests
   * @param {string} [options.scriptSourcePath]
   */
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.userDataDir = options.userDataDir || os.tmpdir();
    this.execImpl = options.execImpl || defaultExec;
    this.scriptSourcePath = options.scriptSourcePath || SCRIPT_SOURCE;
    this.scriptPath = null;
    this.snapshot = null; // previous per-user proxy settings
    this.applied = null; // { proxyServer, proxyBypass } while active
    this.lastError = null;
  }

  get supported() {
    return this.platform === 'win32';
  }

  /** True only while Northstar itself owns the system proxy setting. */
  get active() {
    return Boolean(this.applied);
  }

  status() {
    return {
      supported: this.supported,
      active: this.active,
      proxyServer: this.applied ? this.applied.proxyServer : null,
      error: this.lastError,
    };
  }

  _unsupported() {
    return {
      ok: false,
      code: 'unsupported-platform',
      error: 'System proxy mode is only available on Windows.',
    };
  }

  /** Writes the bundled helper to a real path PowerShell can execute. */
  async _ensureScript() {
    if (this.scriptPath) return { ok: true, path: this.scriptPath };
    let source;
    try {
      source = await fs.promises.readFile(this.scriptSourcePath, 'utf8');
    } catch {
      const error = 'The system proxy helper script is missing from this installation.';
      this.lastError = error;
      return { ok: false, code: 'script-missing', error };
    }
    const dir = path.join(this.userDataDir, 'network');
    const target = path.join(dir, 'system-proxy.ps1');
    try {
      const existing = await fs.promises.readFile(target, 'utf8');
      if (existing !== source) await fs.promises.writeFile(target, source, 'utf8');
    } catch {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(target, source, 'utf8');
    }
    this.scriptPath = target;
    return { ok: true, path: target };
  }

  async _run(action, payload) {
    if (!this.supported) return this._unsupported();
    const script = await this._ensureScript();
    if (!script.ok) return script;

    let result;
    try {
      result = await this.execImpl(
        script.path,
        action,
        payload === undefined ? '' : JSON.stringify(payload)
      );
    } catch (err) {
      const error = `Could not run the system proxy helper: ${err && err.message ? err.message : 'unknown error'}`;
      this.lastError = error;
      return { ok: false, code: 'helper-failed', error };
    }

    if (result.timedOut) {
      const error = 'The system proxy helper timed out.';
      this.lastError = error;
      return { ok: false, code: 'timeout', error };
    }

    const parsed = parseOutput(result.stdout);
    if (result.error && !parsed) {
      const detail =
        String(result.stderr || '').trim().split(/[\r\n]+/)[0] ||
        (result.error.message ? String(result.error.message) : '');
      const error = detail || `The system proxy helper failed${result.code ? ` (exit ${result.code})` : ''}.`;
      this.lastError = error;
      return { ok: false, code: 'helper-failed', error };
    }
    if (!parsed || parsed.ok !== true) {
      const error = (parsed && parsed.error) || 'The system proxy helper returned an unexpected response.';
      this.lastError = error;
      return { ok: false, code: 'helper-failed', error };
    }
    this.lastError = null;
    return { ok: true, data: parsed };
  }

  /** Reads the current per-user proxy settings. */
  async capture() {
    const result = await this._run('capture');
    if (!result.ok) return result;
    this.snapshot = result.data.snapshot || null;
    return { ok: true, snapshot: this.snapshot };
  }

  /**
   * Points the system proxy at the local HTTP port, after saving the current
   * settings. Safe to call only once per connection.
   * @param {number} port
   */
  async apply(port) {
    if (!this.supported) return this._unsupported();
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, code: 'invalid-port', error: 'The local HTTP port is invalid.' };
    }
    if (this.active) return { ok: true, alreadyApplied: true };

    const captured = await this.capture();
    if (!captured.ok) return captured;

    const result = await this._run('apply', { port: n });
    if (!result.ok) {
      this.snapshot = null;
      return result;
    }
    this.applied = {
      proxyServer: result.data.proxyServer,
      proxyBypass: result.data.proxyBypass,
      port: n,
    };
    return { ok: true, proxyServer: this.applied.proxyServer };
  }

  /**
   * Restores the saved settings. If the current proxy no longer matches what
   * Northstar set, it is left alone and reported as skipped.
   */
  async restore() {
    if (!this.supported) return this._unsupported();
    if (!this.applied) return { ok: true, restored: false, reason: 'not-applied' };
    if (!this.snapshot) {
      this.applied = null;
      return { ok: false, code: 'no-snapshot', error: 'No saved proxy settings to restore.' };
    }

    const result = await this._run('restore', {
      snapshot: this.snapshot,
      appliedProxyServer: this.applied.proxyServer,
      appliedProxyBypass: this.applied.proxyBypass,
    });
    if (!result.ok) return result;

    const restored = result.data.restored !== false;
    this.applied = null;
    this.snapshot = null;
    return {
      ok: true,
      restored,
      reason: result.data.reason || null,
    };
  }
}

module.exports = { SystemProxyService, parseOutput, SCRIPT_SOURCE };