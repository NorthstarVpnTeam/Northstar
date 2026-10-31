'use strict';

/**
 * Proxy core process management.
 *
 * Responsibilities:
 *   - locate an Xray-compatible core binary (explicit path > bundled > PATH)
 *   - verify it runs (`version`) with a timeout and no shell
 *   - preflight local port availability (conflict detection)
 *   - write the generated config to a private temp file
 *   - spawn the core without a shell, capture redacted diagnostics
 *   - wait for the local listener before reporting ready
 *   - detect unexpected exits and clean up children/temp files on stop
 *
 * No configuration text is ever passed through a shell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { buildCoreConfig, collectSecrets, redact, ConfigError } = require('./core-config');
const { LIMITS } = require('../shared/constants');

const CORE_NAMES = process.platform === 'win32' ? ['xray.exe', 'v2ray.exe'] : ['xray', 'v2ray'];

class CoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

/** Returns true when nothing is listening and the port can be bound. */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/** Polls until the port accepts a TCP connection. */
async function waitForPort(port, timeoutMs, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(400);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect({ host, port });
    });
    if (free) return true;
    if (Date.now() > deadline) return false;
    await delay(50);
  }
}

function execFileAsync(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) resolve({ ok: false, output: '' });
      else resolve({ ok: true, output: String(stdout || '').trim() });
    });
  });
}

class ProxyCoreManager {
  /**
   * @param {object} options
   * @param {string} options.workDir directory for temp config files
   * @param {(event:{type:string,data:object})=>void} [options.onEvent]
   */
  constructor(options = {}) {
    this.workDir =
      options.workDir || path.join(os.tmpdir(), 'northstar-v2ray');
    this.onEvent = options.onEvent || (() => {});
    this.child = null;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.corePath = null;
    this.coreSource = null;
    this.coreVersion = null;
    this.lastError = null;
    this.logLines = [];
    this._secrets = [];
    this._configFile = null;
    this._exited = false;
  }

  /** Emits a redacted diagnostic line to listeners and the ring buffer. */
  _log(level, message) {
    const line = { ts: Date.now(), level, message: redact(String(message), this._secrets) };
    this.logLines.push(line);
    if (this.logLines.length > LIMITS.LOG_RING_SIZE) this.logLines.shift();
    this.onEvent({ type: 'log', data: line });
    return line;
  }

  recentLogs(limit = 100) {
    return this.logLines.slice(-limit);
  }

  status() {
    return {
      state: this.state,
      corePath: this.corePath,
      coreSource: this.coreSource,
      coreVersion: this.coreVersion,
      lastError: this.lastError,
      pid: this.child && !this._exited ? this.child.pid : null,
    };
  }

  /** Searches for a usable core binary. Returns { found, path, source }. */
  async locate(explicitPath = '') {
    const candidates = [];

    if (explicitPath && typeof explicitPath === 'string') {
      candidates.push({ file: explicitPath, source: 'configured' });
    }

    // Bundled with the app: <resources>/core/xray(.exe)
    const resourcesRoot =
      process.resourcesPath || path.join(__dirname, '..', '..', 'resources');
    for (const name of CORE_NAMES) {
      candidates.push({ file: path.join(resourcesRoot, 'core', name), source: 'bundled' });
      candidates.push({ file: path.join(__dirname, '..', '..', 'core', name), source: 'bundled' });
    }

    // PATH and well-known install locations.
    const pathDirs = String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean);
    const extraDirs =
      process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'xray'),
            path.join(process.env.USERPROFILE || '', 'scoop', 'shims'),
            'C:\\Program Files\\Xray',
            'C:\\Xray',
          ]
        : ['/usr/local/bin', '/usr/bin', '/opt/xray', `${os.homedir()}/.local/bin`];
    for (const dir of [...pathDirs, ...extraDirs]) {
      if (!dir) continue;
      for (const name of CORE_NAMES) {
        candidates.push({ file: path.join(dir, name), source: 'path' });
      }
    }

    const seen = new Set();
    for (const candidate of candidates) {
      if (!candidate.file || seen.has(candidate.file)) continue;
      seen.add(candidate.file);
      try {
        const stat = await fs.promises.stat(candidate.file);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const version = await execFileAsync(candidate.file, ['version'], 4000);
      if (version.ok) {
        const firstLine = version.output.split('\n')[0] || '';
        return {
          found: true,
          path: candidate.file,
          source: candidate.source,
          version: firstLine.slice(0, 120),
        };
      }
    }
    return { found: false, path: null, source: null, version: null };
  }

  /** Caches a core location; pass explicitPath to override. */
  async ensureCore(explicitPath = '') {
    if (!explicitPath && this.corePath) {
      return { found: true, path: this.corePath, source: this.coreSource, version: this.coreVersion };
    }
    const result = await this.locate(explicitPath);
    if (result.found) {
      this.corePath = result.path;
      this.coreSource = result.source;
      this.coreVersion = result.version;
    } else if (explicitPath) {
      this.lastError = `Configured core not usable: ${explicitPath}`;
    } else {
      this.lastError =
        'No Xray/V2Ray core found. Set the core path in Settings or place xray(.exe) next to the app.';
    }
    return result;
  }

  /**
   * Starts the core for a normalized server entry.
   * @param {object} entry
   * @param {{socksPort:number, httpPort:number, logLevel?:string, tun?:boolean}} ports
   * @returns {Promise<{ok:boolean, error?:string, code?:string}>}
   */
  async start(entry, ports) {
    if (this.state === 'running' || this.state === 'starting') {
      await this.stop();
    }

    this._exited = false;
    this.lastError = null;
    this.state = 'starting';
    this._secrets = collectSecrets(entry);

    try {
      const core = await this.ensureCore();
      if (!core.found) {
        this.state = 'stopped';
        this.lastError = 'No proxy core found.';
        return { ok: false, error: this.lastError, code: 'core-missing' };
      }

      // Port conflict preflight.
      for (const [name, port] of [
        ['SOCKS', ports.socksPort],
        ['HTTP', ports.httpPort],
      ]) {
        const free = await isPortFree(port);
        if (!free) {
          this.state = 'stopped';
          const msg = `Local ${name} port ${port} is already in use. Change it in Settings.`;
          this.lastError = msg;
          this._log('error', msg);
          return { ok: false, error: msg, code: 'port-conflict' };
        }
      }

      const config = buildCoreConfig(entry, {
        socksPort: ports.socksPort,
        httpPort: ports.httpPort,
        logLevel: ports.logLevel || 'warning',
        tun: Boolean(ports.tun),
      });

      await fs.promises.mkdir(this.workDir, { recursive: true, mode: 0o700 });
      this._configFile = path.join(this.workDir, `core-${Date.now()}-${process.pid}.json`);
      await fs.promises.writeFile(this._configFile, JSON.stringify(config, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });

      const args = ['run', '-c', this._configFile];
      this._log('info', `Starting core: ${path.basename(this.corePath)} (config at private temp file)`);

      const child = spawn(this.corePath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.child = child;

      let stderrBuffer = '';
      child.stdout.on('data', (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (line.trim()) this._log('info', line);
        }
      });
      child.stderr.on('data', (buf) => {
        stderrBuffer += String(buf);
        if (stderrBuffer.length > 16000) stderrBuffer = stderrBuffer.slice(-16000);
        for (const line of String(buf).split(/\r?\n/)) {
          if (line.trim()) this._log('warn', line);
        }
      });

      child.once('error', (err) => {
        this._exited = true;
        this.lastError = `Core failed to start: ${err.message}`;
        this.state = 'stopped';
        this._log('error', this.lastError);
        this.onEvent({ type: 'exit', data: { code: null, signal: null, error: err.message } });
      });

      child.once('exit', (code, signal) => {
        this._exited = true;
        const wasRunning = this.state === 'running';
        if (this.state === 'starting') {
          // Exited before the listener came up: startup failure.
          this.state = 'stopped';
          const detail = stderrBuffer.split(/\r?\n/).filter(Boolean).slice(-5).join(' | ');
          this.lastError = detail
            ? `Core exited during startup: ${detail}`
            : `Core exited during startup (code ${code}${signal ? `, ${signal}` : ''}).`;
          this._log('error', this.lastError);
        } else if (this.state === 'stopping') {
          this.state = 'stopped';
          this.lastError = null;
        } else {
          this.state = 'stopped';
          this.lastError = `The proxy core exited unexpectedly (code ${code}${
            signal ? `, ${signal}` : ''
          }).`;
          this._log('error', this.lastError);
        }
        this.onEvent({
          type: 'exit',
          data: { code, signal, expected: !wasRunning && this.state === 'stopped' },
        });
      });

      // Wait for the local listener — starting a process is not "connected".
      const ready = await waitForPort(ports.socksPort, LIMITS.CONNECT_LISTENER_TIMEOUT_MS);
      if (!ready) {
        const msg =
          'The proxy core started but its local SOCKS listener never became ready.';
        this.lastError = msg;
        this._log('error', msg);
        await this.stop();
        return { ok: false, error: msg, code: 'listener-timeout' };
      }
      if (this._exited) {
        const msg = this.lastError || 'The proxy core exited unexpectedly during startup.';
        this.state = 'stopped';
        return { ok: false, error: msg, code: 'core-exited' };
      }

      this.state = 'running';
      this._log('info', 'Local proxy listener is ready.');
      this.onEvent({ type: 'ready', data: { socksPort: ports.socksPort, httpPort: ports.httpPort } });
      return { ok: true };
    } catch (err) {
      this.state = 'stopped';
      const message =
        err instanceof ConfigError
          ? err.message
          : `Could not start the proxy core: ${err && err.message ? err.message : 'unknown error'}`;
      this.lastError = message;
      this._log('error', message);
      await this.stop().catch(() => {});
      return { ok: false, error: message, code: err instanceof ConfigError ? err.code : 'start-failed' };
    }
  }

  /** Stops the core and removes its temp config. */
  async stop() {
    if (this.state === 'stopping') return;
    const child = this.child;
    this.state = 'stopping';

    if (child && !this._exited) {
      await new Promise((resolve) => {
        const forceTimer = setTimeout(() => {
          try {
            if (process.platform === 'win32' && child.pid) {
              spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
            } else {
              child.kill('SIGKILL');
            }
          } catch {
            /* ignore */
          }
        }, 4000);
        if (forceTimer.unref) forceTimer.unref();

        child.once('exit', () => {
          clearTimeout(forceTimer);
          resolve();
        });
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/PID', String(child.pid), '/T'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          clearTimeout(forceTimer);
          resolve();
        }
      });
    }

    this.child = null;
    this.state = 'stopped';
    this._secrets = [];
    await this._cleanupConfig();
    this._log('info', 'Core stopped.');
  }

  async _cleanupConfig() {
    if (!this._configFile) return;
    try {
      await fs.promises.unlink(this._configFile);
    } catch {
      /* already gone */
    }
    this._configFile = null;
  }
}

module.exports = { ProxyCoreManager, isPortFree, waitForPort, CoreError };