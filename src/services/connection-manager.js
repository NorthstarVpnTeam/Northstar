'use strict';

/**
 * Connection lifecycle manager.
 *
 * States: disconnected -> connecting -> connected -> disconnecting -> disconnected
 *                                   \-> error
 *
 * Honesty rules enforced here:
 *   - "connected" is only reported after the core's local listener is up AND
 *     the configured validation check has passed.
 *   - Throughput numbers come from the core's stats API; if the API cannot be
 *     queried, throughput is reported as unavailable, never invented.
 *   - By default this is a *local proxy* connection and no system-wide routing
 *     is touched. System proxy and TUN modes are explicit opt-ins that are
 *     applied only while a connection is active and reverted on teardown.
 */

const http = require('http');
const { execFile } = require('child_process');
const { CONNECTION_STATE, MEASUREMENT, VALIDATION_ENDPOINTS, LIMITS } = require('../shared/constants');
const { socks5Connect, e2eThroughProxy, tcpConnect } = require('./latency-service');
const { redact, collectSecrets } = require('./core-config');
const { SystemProxyService } = require('./system-proxy-service');
const { tunRequirements } = require('./tun-support');

const THROUGHPUT_SAMPLE_MS = 2000;
const STATS_FAILURE_LIMIT = 3;

function parseStatsOutput(text) {
  const totals = { down: 0, up: 0, found: false };    const re = /name:\s*"([^"]+)"\s*value:\s*(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const value = Number(m[2]);
      if (!Number.isFinite(value)) continue;
      // Sum the tunnel inbounds (SOCKS always, TUN when enabled). The API and
      // direct traffic are excluded so "throughput" only shows proxied data.
      const inbound = name.match(/inbound>>>(socks-in|tun-in)>>>traffic>>>(downlink|uplink)$/);
      if (!inbound) continue;
      if (inbound[2] === 'downlink') {
        totals.down += value;
        totals.found = true;
      } else {
        totals.up += value;
        totals.found = true;
      }
    }
    return totals;
}

function queryStats(corePath, apiPort, timeoutMs = 2000) {
  return new Promise((resolve) => {
    execFile(
      corePath,
      ['api', 'stats', 'query', '--server', `127.0.0.1:${apiPort}`],
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (error, stdout) => {
        if (error) resolve({ ok: false });
        else resolve({ ok: true, totals: parseStatsOutput(String(stdout || '')) });
      }
    );
  });
}

class ConnectionManager {
  /**
   * @param {object} options
   * @param {import('./proxy-core-manager').ProxyCoreManager} options.coreManager
   * @param {import('./server-store').ServerStore} options.store
   * @param {object} options.settingsService instance with .get()
   * @param {(event:{type:string,data:object})=>void} options.onEvent
   * @param {object} [options.systemProxy] injected system proxy service (tests)
   * @param {Function} [options.tunCheck] injected TUN preflight (tests)
   */
  constructor({ coreManager, store, settingsService, onEvent, systemProxy, tunCheck }) {
    this.core = coreManager;
    this.store = store;
    this.settings = settingsService;
    this.onEvent = onEvent || (() => {});
    this.systemProxy = systemProxy || new SystemProxyService();
    this.tunCheck = tunCheck || tunRequirements;

    // Live state of the two optional routing modes.
    this.systemProxyState = { enabled: false, active: false, error: null };
    this.tunState = { enabled: false, active: false, error: null };
    // Settings the running connection was built with (for change detection).
    this.appliedSettings = null;

    this.state = CONNECTION_STATE.DISCONNECTED;
    this.serverId = null;
    this.since = 0;
    this.error = null;
    this.validation = null;
    this.apiPort = 0;

    this._sampler = null;
    this._statsFailures = 0;
    this._lastTotals = null;
    this.throughput = { down: null, up: null, available: false };
    this.session = { down: 0, up: 0, samples: [] };
    this.events = [];
    this._busy = null;
  }

  /* ------------------------------------------------------------ helpers */

  _emitStatus() {
    this.onEvent({ type: 'status', data: this.status() });
  }

  _pushEvent(kind, message) {
    const event = { ts: Date.now(), kind, message };
    this.events.unshift(event);
    if (this.events.length > LIMITS.EVENT_RING_SIZE) this.events.pop();
    this.onEvent({ type: 'event', data: event });
  }

  _setState(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this._emitStatus();
  }

  status() {
    const server = this.serverId ? this.store.get(this.serverId) : null;
    return {
      state: this.state,
      serverId: this.serverId,
      server: server
        ? {
            id: server.id,
            label: server.label,
            protocol: server.protocol,
            country: server.country || 'Unknown',
            flag: server.flag || '',
            security: server.security,
            network: server.network,
          }
        : null,
      since: this.since,
      error: this.error,
      validation: this.validation,
      socksPort: this.settings.get().socksPort,
      httpPort: this.settings.get().httpPort,
      throughput: { ...this.throughput },
      session: {
        down: this.session.down,
        up: this.session.up,
        samples: this.session.samples.slice(-60),
      },
      mode: this._modeLabel(),
      systemProxy: { ...this.systemProxyState },
      tun: { ...this.tunState },
      core: this.core.status(),
    };
  }

  /** Human-readable description of the active routing modes. */
  _modeLabel() {
    const tun = this.tunState.active;
    const sys = this.systemProxyState.active;
    if (tun && sys) return 'tun+system-proxy';
    if (tun) return 'tun';
    if (sys) return 'system-proxy';
    return 'local-proxy';
  }

  recentEvents(limit = 30) {
    return this.events.slice(0, limit);
  }

  /* -------------------------------------------------------- validation */

  /** Chooses a free port for the core stats API. */
  async _pickApiPort() {
    const { socksPort, httpPort } = this.settings.get();
    const taken = new Set([socksPort, httpPort]);
    const { isPortFree } = require('./proxy-core-manager');

    const ports = [];
    for (let port = 10085; port < 10185; port += 1) {
      if (!taken.has(port)) ports.push(port);
    }
    if (ports.length === 0) return 0;

    // Probe all candidate ports in parallel so the first free one wins
    // immediately instead of waiting for each sequential check.
    const results = await Promise.all(ports.map((port) => isPortFree(port)));
    for (let i = 0; i < ports.length; i += 1) {
      if (results[i]) return ports[i];
    }
    return 0;
  }

  /**
   * Runs the configured validation check against the running local proxy.
   * @returns {Promise<{ok:boolean, kind:string, ms:number|null, code:string|null}>}
   */
  async _validate() {
    const settings = this.settings.get();
    const kind = settings.validationType || MEASUREMENT.E2E;
    const timeout = settings.pingTimeoutMs;

    if (kind === MEASUREMENT.TCP) {
      // Listener availability was already proven by the core manager.
      const start = Date.now();
      const up = await tcpConnect('127.0.0.1', settings.socksPort, Math.min(timeout, 3000));
      return up.ok
        ? { ok: true, kind, ms: Date.now() - start, code: null }
        : { ok: false, kind, ms: null, code: up.code || 'listener-down' };
    }

    if (kind === MEASUREMENT.PROXY) {
      const result = await socks5Connect(
        '127.0.0.1',
        settings.socksPort,
        '1.1.1.1',
        443,
        timeout
      );
      return { ok: result.ok, kind, ms: result.ms, code: result.code };
    }

    const endpoint = VALIDATION_ENDPOINTS[0];
    const result = await e2eThroughProxy('127.0.0.1', settings.httpPort, endpoint, timeout);
    if (result.ok) return { ok: true, kind, ms: result.ms, code: null };
    return { ok: false, kind, ms: null, code: result.code || 'validation-failed' };
  }

  /**
   * Probe used by the latency service for proxy/e2e measurements.
   * @param {object} entry unused for e2e (fixed endpoint), used for proxy hops
   */
  async probe(entry, kind, timeoutMs) {
    const settings = this.settings.get();
    if (this.state !== CONNECTION_STATE.CONNECTED) {
      return { ok: false, ms: null, code: 'proxy-offline' };
    }
    if (kind === MEASUREMENT.PROXY) {
      return socks5Connect(
        '127.0.0.1',
        settings.socksPort,
        entry && entry.host ? entry.host : '1.1.1.1',
        entry && entry.port ? entry.port : 443,
        timeoutMs
      );
    }
    const endpoint = VALIDATION_ENDPOINTS[0];
    const result = await e2eThroughProxy('127.0.0.1', settings.httpPort, endpoint, timeoutMs);
    return { ok: result.ok, ms: result.ms, code: result.code };
  }

  /* --------------------------------------------------- throughput sampler */

  _startSampler() {
    this._stopSampler();
    this._statsFailures = 0;
    this._lastTotals = null;
    this.throughput = { down: null, up: null, available: false };
    this.session = { down: 0, up: 0, samples: [] };

    this._sampler = setInterval(async () => {
      if (this.state !== CONNECTION_STATE.CONNECTED || !this.core.corePath || !this.apiPort) {
        this._stopSampler();
        return;
      }
      const result = await queryStats(this.core.corePath, this.apiPort);
      if (!result.ok) {
        this._statsFailures += 1;
        if (this._statsFailures >= STATS_FAILURE_LIMIT) {
          this.throughput = { down: null, up: null, available: false };
          this._emitStatus();
          this._stopSampler();
        }
        return;
      }
      this._statsFailures = 0;
      const totals = result.totals;
      if (!totals.found) {
        this.throughput = { down: null, up: null, available: false };
        this._emitStatus();
        this._stopSampler();
        return;
      }

      let downRate = null;
      let upRate = null;
      if (this._lastTotals) {
        const deltaDown = Math.max(0, totals.down - this._lastTotals.down);
        const deltaUp = Math.max(0, totals.up - this._lastTotals.up);
        const seconds = THROUGHPUT_SAMPLE_MS / 1000;
        downRate = Math.round((deltaDown * 8) / seconds); // bits per second
        upRate = Math.round((deltaUp * 8) / seconds);
        this.session.down += deltaDown;
        this.session.up += deltaUp;
      }
      this._lastTotals = totals;
      this.throughput = { down: downRate, up: upRate, available: true };
      this.session.samples.push({
        ts: Date.now(),
        down: downRate,
        up: upRate,
        totalDown: totals.down,
        totalUp: totals.up,
      });
      if (this.session.samples.length > 300) this.session.samples.shift();
      this._emitStatus();
    }, THROUGHPUT_SAMPLE_MS);
    if (this._sampler.unref) this._sampler.unref();
  }

  _stopSampler() {
    if (this._sampler) {
      clearInterval(this._sampler);
      this._sampler = null;
    }
  }

  /* ------------------------------------------------------- lifecycle */

  /**
   * Connects to a server (or switches to it).
   * Serialized so rapid clicks cannot start two cores.
   */
  connect(serverId) {
    if (this._busy) return this._busy;
    this._busy = this._doConnect(serverId).finally(() => {
      this._busy = null;
    });
    return this._busy;
  }

  async _doConnect(serverId) {
    const server = this.store.get(serverId);
    if (!server) {
      const message = 'The selected server no longer exists. Refresh your configurations.';
      this._setState(CONNECTION_STATE.ERROR, { error: message });
      this._pushEvent('error', message);
      return { ok: false, error: message, code: 'unknown-server' };
    }

    if (this.state === CONNECTION_STATE.CONNECTED && this.serverId === serverId) {
      return { ok: true, alreadyConnected: true };
    }

    // Switching or retrying: tear down first.
    if (this.state === CONNECTION_STATE.CONNECTED || this.core.state === 'running') {
      await this._teardown();
    }

    const settings = this.settings.get();
    this.error = null;
    this.validation = null;
    this.serverId = serverId;
    this.systemProxyState = { enabled: false, active: false, error: null };
    this.tunState = { enabled: false, active: false, error: null };
    this._setState(CONNECTION_STATE.CONNECTING, { since: 0 });
    this._pushEvent('info', `Connecting to ${server.label} (${server.protocol.toUpperCase()})…`);

    // TUN preflight: fail fast, before the core is started, if the privileges
    // needed for the interface and routes are missing. Northstar never
    // elevates itself — the user relaunches as administrator if they want it.
    const wantTun = Boolean(settings.tunMode);
    if (wantTun) {
      const requirement = await this.tunCheck();
      if (!requirement.ok) {
        const message = requirement.message || 'TUN mode is not available on this system.';
        this._setState(CONNECTION_STATE.ERROR, { error: message });
        this._pushEvent('error', message);
        return { ok: false, error: message, code: requirement.code || 'tun-unavailable' };
      }
      this.tunState = { enabled: true, active: false, error: null };
      this._pushEvent('info', 'TUN mode enabled — device traffic will be routed through the tunnel.');
    }

    const secrets = collectSecrets(server);
    const redactMsg = (m) => redact(String(m), secrets);

    this.apiPort = await this._pickApiPort();
    const startResult = await this.core.start(server, {
      socksPort: settings.socksPort,
      httpPort: settings.httpPort,
      apiPort: this.apiPort,
      logLevel: settings.verboseLogging ? 'debug' : 'warning',
      tun: wantTun,
    });

    if (!startResult.ok) {
      const message = redactMsg(startResult.error || 'The proxy core failed to start.');
      this._setState(CONNECTION_STATE.ERROR, { error: message });
      this._pushEvent('error', message);
      return { ok: false, error: message, code: startResult.code || 'start-failed' };
    }

    this._pushEvent('info', 'Local proxy listener is up.');
    if (wantTun) {
      // The core reported ready with the TUN inbound configured; the interface
      // and system routes are created by the core during startup.
      this.tunState = { enabled: true, active: true, error: null };
    }

    if (settings.validateOnConnect) {
      this._pushEvent('info', 'Running connection validation…');
      const validation = await this._validate();
      this.validation = validation;
      if (!validation.ok) {
        const message = redactMsg(
          `Connection validation failed (${validation.kind}: ${validation.code || 'no response'}). ` +
            'The server may be unreachable, blocked, or the configuration may be invalid.'
        );
        await this._teardown();
        this._setState(CONNECTION_STATE.ERROR, { error: message });
        this._pushEvent('error', message);
        return { ok: false, error: message, code: 'validation-failed' };
      }
      this._pushEvent('ok', `Validation passed in ${validation.ms} ms (${validation.kind}).`);
    }

    // Optional system proxy mode, applied only after validation succeeded so
    // Windows never points at a proxy that has not proven it works.
    if (settings.systemProxy) await this._applySystemProxy();

    this.appliedSettings = {
      socksPort: settings.socksPort,
      httpPort: settings.httpPort,
      tunMode: Boolean(settings.tunMode),
      systemProxy: Boolean(settings.systemProxy),
      validateOnConnect: Boolean(settings.validateOnConnect),
      validationType: settings.validationType,
    };

    this.since = Date.now();
    this._setState(CONNECTION_STATE.CONNECTED, { error: null });
    this._startSampler();
    this._pushEvent(
      'ok',
      `Connected to ${server.label}. Local proxy on 127.0.0.1:${settings.socksPort} (SOCKS) / ${settings.httpPort} (HTTP).`
    );
    return { ok: true };
  }

  async disconnect() {
    if (this._busy) return this._busy;
    this._busy = this._doDisconnect().finally(() => {
      this._busy = null;
    });
    return this._busy;
  }

  async _doDisconnect() {
    if (
      this.state === CONNECTION_STATE.DISCONNECTED ||
      this.state === CONNECTION_STATE.DISCONNECTING
    ) {
      return { ok: true };
    }
    this._setState(CONNECTION_STATE.DISCONNECTING);
    this._pushEvent('info', 'Disconnecting…');
    await this._teardown();
    this._setState(CONNECTION_STATE.DISCONNECTED, { since: 0, error: null });
    this._pushEvent('info', 'Disconnected.');
    return { ok: true };
  }

  /**
   * Settings that changed since the active connection was established and
   * therefore need a reconnect. The system proxy is synced live and does not
   * appear here.
   * @param {object} current current settings
   * @returns {string[]}
   */
  pendingReconnectReasons(current) {
    const applied = this.appliedSettings;
    if (!applied || !current || this.state !== CONNECTION_STATE.CONNECTED) return [];
    const reasons = [];
    if (current.socksPort !== applied.socksPort || current.httpPort !== applied.httpPort) {
      reasons.push('local ports');
    }
    if (Boolean(current.tunMode) !== applied.tunMode) reasons.push('TUN mode');
    if (
      Boolean(current.validateOnConnect) !== applied.validateOnConnect ||
      current.validationType !== applied.validationType
    ) {
      reasons.push('validation settings');
    }
    return reasons;
  }

  /**
   * Points the Windows per-user proxy at the local HTTP port.
   * Failure is reported but does not tear the connection down: the local
   * proxy still works, and lying about it would be worse than a warning.
   */
  async _applySystemProxy() {
    const { httpPort } = this.settings.get();
    const applied = await this.systemProxy.apply(httpPort);
    if (applied.ok) {
      this.systemProxyState = { enabled: true, active: true, error: null };
      this._pushEvent('ok', `System proxy set to 127.0.0.1:${httpPort} — restored on disconnect.`);
    } else {
      const reason = applied.error || 'unknown error';
      this.systemProxyState = { enabled: true, active: false, error: reason };
      this._pushEvent('warn', `The system proxy could not be applied: ${reason}`);
    }
    this._emitStatus();
    return applied;
  }

  /** Restores the previous per-user proxy settings, if we changed them. */
  async _restoreSystemProxy() {
    if (!this.systemProxy.active) {
      this.systemProxyState = { enabled: false, active: false, error: null };
      return { ok: true, restored: false, reason: 'not-applied' };
    }
    const result = await this.systemProxy.restore();
    if (result.ok && result.restored) {
      this._pushEvent('info', 'System proxy restored to its previous settings.');
    } else if (result.ok && result.reason && result.reason !== 'not-applied') {
      this._pushEvent('warn', result.reason);
    } else if (!result.ok) {
      this._pushEvent(
        'error',
        `The system proxy could not be restored automatically: ${result.error || 'unknown error'}. Check Windows proxy settings.`
      );
    }
    this.systemProxyState = {
      enabled: false,
      active: false,
      error: result.ok ? null : result.error || null,
    };
    this._emitStatus();
    return result;
  }

  /**
   * Applies or reverts the system proxy immediately when the user toggles the
   * setting while connected. TUN changes still need a reconnect.
   */
  async syncSystemProxy(enabled) {
    if (this.state !== CONNECTION_STATE.CONNECTED) return { ok: true, applied: false };
    if (enabled && !this.systemProxy.active) return this._applySystemProxy();
    if (!enabled && this.systemProxy.active) return this._restoreSystemProxy();
    return { ok: true, applied: false };
  }

  async _teardown() {
    this._stopSampler();
    this.throughput = { down: null, up: null, available: false };
    await this._revertRoutingModes();
    await this.core.stop();
  }

  /**
   * Reverts the optional routing modes. The system proxy is restored before
   * the core stops so applications are never left pointing at a dead port.
   */
  async _revertRoutingModes() {
    await this._restoreSystemProxy();
    this.tunState = { enabled: false, active: false, error: null };
    this.appliedSettings = null;
  }

  /** Full cleanup on application exit. */
  async shutdown() {
    this._stopSampler();
    await this._teardown().catch(() => {});
    this.state = CONNECTION_STATE.DISCONNECTED;
  }

  /**
   * Reports an unexpected core exit (called by the core event bridge).
   */
  handleCoreExit(data) {
    if (this.state === CONNECTION_STATE.CONNECTED || this.state === CONNECTION_STATE.CONNECTING) {
      this._stopSampler();
      // The core is gone, so revert the system proxy; otherwise Windows would
      // keep pointing at a dead local port.
      this._revertRoutingModes().catch(() => {});
      const message =
        data && data.error
          ? String(data.error)
          : 'The proxy core exited unexpectedly. Check the diagnostics log.';
      this._setState(CONNECTION_STATE.ERROR, { error: message, since: 0 });
      this._pushEvent('error', message);
    }
  }
}

module.exports = { ConnectionManager, parseStatsOutput, queryStats };