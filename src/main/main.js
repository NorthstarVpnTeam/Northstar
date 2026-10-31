'use strict';

/**
 * Northstar V2Ray — main process entry point.
 *
 * Wires together: settings, server store, configuration fetcher, latency
 * service, proxy core manager, connection manager, speed test service and the
 * IPC layer. Owns application lifecycle and background timers.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { app, ipcMain } = require('electron');

const {
  IPC,
  IPC_EVENTS,
  DEFAULT_CONFIG_SOURCE,
  MEASUREMENT,
  VALIDATION_ENDPOINTS,
} = require('../shared/constants');
const { SettingsService } = require('../services/settings-service');
const { ServerStore } = require('../services/server-store');
const { fetchConfiguration } = require('../services/configuration-fetcher');
const { LatencyService, e2eThroughProxy } = require('../services/latency-service');
const { ProxyCoreManager } = require('../services/proxy-core-manager');
const { ConnectionManager } = require('../services/connection-manager');
const { SpeedTestService } = require('../services/speed-test-service');
const { Logger } = require('../services/logger');
const { collectSecrets } = require('../services/core-config');
const { createMainWindow } = require('./window');
const { registerIpc } = require('./ipc');

const CACHE_FILE = 'configs-cache.txt';

// Single-instance guard: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  /** @type {import('electron').BrowserWindow|null} */
  let mainWindow = null;
  let settings = null;
  let store = null;
  let logger = null;
  let latency = null;
  let core = null;
  let connection = null;
  let speed = null;

  let autoRefreshTimer = null;
  let autoPingTimer = null;
  let refreshInFlight = false;
  let pingInFlight = false;
  let quitting = false;
  let delaySeq = 0;

  const cacheFile = () => path.join(app.getPath('userData'), CACHE_FILE);

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  function broadcast(channel, payload) {
    send(channel, payload);
  }

  /* --------------------------------------------------- configuration */

  async function refreshConfigs({ silent = false } = {}) {
    if (refreshInFlight) throw new Error('A refresh is already in progress.');
    refreshInFlight = true;
    const source = settings.get().configSource || DEFAULT_CONFIG_SOURCE;

    try {
      if (!silent) {
        broadcast(IPC.CONFIG_PROGRESS, { phase: 'start' });
        logger.info('Refreshing configurations.');
      }

      const text = await fetchConfiguration({
        url: source,
        onProgress: (progress) => {
          if (!silent) broadcast(IPC.CONFIG_PROGRESS, { phase: progress.phase, loaded: progress.loaded });
        },
      });

      const stats = store.loadDocument(text, source);

      // Persist cache for instant startup (public configuration data).
      try {
        await fs.promises.writeFile(cacheFile(), text, 'utf8');
      } catch (err) {
        logger.warn('Could not write the configuration cache.', { error: err.message });
      }

      logger.info('Configurations refreshed.', {
        received: stats.received,
        kept: stats.kept,
        rejected: stats.rejected,
        duplicates: stats.duplicates,
        unsupported: stats.unsupported,
      });

      if (!silent) {
        broadcast(IPC.CONFIG_PROGRESS, { phase: 'done', stats, fetchedAt: store.fetchedAt });
      }
      broadcast(IPC_EVENTS.SERVERS_CHANGED, { meta: store.meta() });
      return stats;
    } catch (err) {
      if (!silent) {
        broadcast(IPC.CONFIG_PROGRESS, {
          phase: 'error',
          message: err && err.message ? err.message : 'Unknown fetch error.',
          code: err && err.code ? err.code : 'error',
        });
      }
      logger.error('Configuration refresh failed.', {
        error: err && err.message ? err.message : 'unknown',
        code: err && err.code ? err.code : 'error',
      });
      throw err;
    } finally {
      refreshInFlight = false;
    }
  }

  async function loadCachedConfigs() {
    try {
      const file = cacheFile();
      if (!fs.existsSync(file)) return false;
      const text = await fs.promises.readFile(file, 'utf8');
      if (!text.trim()) return false;
      store.loadDocument(text, settings.get().configSource);
      logger.info('Loaded cached configurations.', { count: store.count });
      return true;
    } catch (err) {
      logger.warn('Could not load the configuration cache.', { error: err.message });
      return false;
    }
  }

  async function clearCache() {
    store.clear();
    try {
      await fs.promises.unlink(cacheFile());
    } catch {
      /* already gone */
    }
    broadcast(IPC_EVENTS.SERVERS_CHANGED, { meta: store.meta() });
    logger.info('Configuration cache cleared.');
  }

  function getCacheInfo() {
    try {
      const stat = fs.statSync(cacheFile());
      return { exists: true, bytes: stat.size, servers: store.count, fetchedAt: store.fetchedAt };
    } catch {
      return { exists: false, bytes: 0, servers: store.count, fetchedAt: store.fetchedAt };
    }
  }

  /* ------------------------------------------------------- real delay */

  /** Reserves an ephemeral loopback port and hands it back free. */
  function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    });
  }

  /**
   * v2rayN-style "real delay": start a throwaway core for exactly this
   * server, run two full HTTP requests through it and report the faster one.
   * It works without an active connection and never touches the running
   * tunnel — its own ports and its own process.
   *
   * @param {object} entry normalized server entry
   * @param {number} timeoutMs per-request timeout
   * @returns {Promise<{ok:boolean, ms:number|null, code:string|null}>}
   */
  async function realDelayProbe(entry, timeoutMs) {
    if (!core || !core.corePath) return { ok: false, ms: null, code: 'core-missing' };

    delaySeq += 1;
    const workDir = path.join(app.getPath('userData'), 'core-tmp', `delay-${delaySeq}`);
    const probeCore = new ProxyCoreManager({ workDir });

    try {
      // Reuse the already-verified core path instead of re-detecting it.
      await probeCore.ensureCore(core.corePath);
      const socksPort = await freeLoopbackPort();
      const httpPort = await freeLoopbackPort();

      const started = await probeCore.start(entry, {
        socksPort,
        httpPort,
        logLevel: 'warning',
        tun: false,
      });
      if (!started.ok) {
        return { ok: false, ms: null, code: started.code || 'core-start-failed' };
      }

      const endpoint = VALIDATION_ENDPOINTS[0];
      const [first, second] = await Promise.all([
        e2eThroughProxy('127.0.0.1', httpPort, endpoint, timeoutMs),
        e2eThroughProxy('127.0.0.1', httpPort, endpoint, timeoutMs),
      ]);

      const best = [first, second]
        .filter((r) => r && r.ok)
        .sort((a, b) => a.ms - b.ms)[0];
      if (best) return { ok: true, ms: best.ms, code: null };
      return {
        ok: false,
        ms: null,
        code: (first && first.code) || (second && second.code) || 'timeout',
      };
    } catch (err) {
      logger.warn('Real delay probe failed.', {
        error: err && err.message ? err.message : 'unknown',
      });
      return { ok: false, ms: null, code: 'real-delay-failed' };
    } finally {
      await probeCore.stop().catch(() => {});
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ------------------------------------------------------ background */

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    const s = settings.get();
    if (!s.autoRefresh) return;
    const ms = Math.max(15, s.autoRefreshIntervalMin) * 60 * 1000;
    autoRefreshTimer = setInterval(() => {
      refreshConfigs({ silent: true }).catch(() => {
        /* already logged */
      });
    }, ms);
    if (autoRefreshTimer.unref) autoRefreshTimer.unref();
  }

  async function runAutoPing() {
    const s = settings.get();
    if (!s.autoPing || store.count === 0) return;
    if (pingInFlight || latency.running) return;

    const kind = s.measurementType;
    if (kind === MEASUREMENT.DELAY) {
      // Real delay starts a temporary core per server; running that in the
      // background would spawn processes continuously. It stays manual-only.
      return;
    }
    if (kind !== MEASUREMENT.TCP && (!connection || connection.status().state !== 'connected')) {
      // Proxy-based measurements require a running local proxy; skip honestly.
      return;
    }

    pingInFlight = true;
    broadcast(IPC.LATENCY_STATE, { running: true, trigger: 'auto' });
    try {
      const results = await latency.measureMany(store.servers, {
        kind,
        timeoutMs: s.pingTimeoutMs,
        onProgress: ({ done, total, result }) => {
          store.setLatency(result.id, result);
          broadcast(IPC.LATENCY_UPDATE, { result, done, total, trigger: 'auto' });
        },
      });
      for (const r of results) store.setLatency(r.id, r);
      broadcast(IPC.LATENCY_STATE, { running: false, trigger: 'auto', total: results.length });
    } catch (err) {
      logger.warn('Auto ping failed.', { error: err && err.message });
      broadcast(IPC.LATENCY_STATE, { running: false, trigger: 'auto', error: true });
    } finally {
      pingInFlight = false;
    }
  }

  function scheduleAutoPing() {
    if (autoPingTimer) {
      clearInterval(autoPingTimer);
      autoPingTimer = null;
    }
    const s = settings.get();
    if (!s.autoPing) return;
    autoPingTimer = setInterval(() => {
      runAutoPing().catch(() => {});
    }, Math.max(5000, s.pingIntervalMs));
    if (autoPingTimer.unref) autoPingTimer.unref();
    // Kick one run shortly after startup so the list is not empty of data.
    const kickoff = setTimeout(() => runAutoPing().catch(() => {}), 2500);
    if (kickoff.unref) kickoff.unref();
  }

  function onSettingsChanged(updated) {
    logger.setVerbose(Boolean(updated.verboseLogging));
    scheduleAutoRefresh();
    scheduleAutoPing();
    broadcast(IPC_EVENTS.SETTINGS_CHANGED, updated);
    // The system proxy follows the toggle immediately while connected; the
    // other connection settings need a reconnect and say so explicitly.
    if (connection && connection.status().state === 'connected') {
      if (typeof updated.systemProxy === 'boolean') {
        connection.syncSystemProxy(updated.systemProxy).catch((err) => {
          logger.warn('Could not apply the system proxy setting.', {
            error: err && err.message ? err.message : 'unknown',
          });
        });
      }
      const reasons = connection.pendingReconnectReasons(updated);
      if (reasons.length > 0) {
        logger.info('Settings changed; reconnect is required.', { reasons });
        broadcast(IPC.CONNECTION_EVENT, {
          ts: Date.now(),
          kind: 'warn',
          message: `${reasons.join(', ')} changed — reconnect to apply them.`,
        });
      }
    }
  }

  /* --------------------------------------------------------- lifecycle */

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.northstar.v2ray');

    const userData = app.getPath('userData');
    settings = new SettingsService(userData, {
      onChanged: (s) => onSettingsChanged(s),
    });

    store = new ServerStore();
    logger = new Logger({
      verbose: settings.get().verboseLogging,
      onLine: (line) => send(IPC_EVENTS.LOG_LINE, line),
    });

    core = new ProxyCoreManager({
      workDir: path.join(userData, 'core-tmp'),
      onEvent: (event) => {
        if (event.type === 'exit') {
          if (connection) connection.handleCoreExit(event.data);
          send(IPC_EVENTS.CORE_STATUS, { status: core.status() });
        } else if (event.type === 'ready') {
          send(IPC_EVENTS.CORE_STATUS, { status: core.status() });
        } else if (event.type === 'log' && event.data) {
          logger.debug(`[core] ${event.data.message}`);
        }
      },
    });

    latency = new LatencyService({
      getSettings: () => settings.get(),
      getProxyState: () => (connection ? connection.status().state : 'disconnected'),
      onResult: (result) => {
        store.setLatency(result.id, result);
        send(IPC_EVENTS.LATENCY_UPDATE, { result, trigger: 'manual' });
      },
    });

    connection = new ConnectionManager({
      coreManager: core,
      store,
      settingsService: settings,
      onEvent: (event) => {
        if (event.type === 'status') {
          send(IPC_EVENTS.CONNECTION_STATUS, event.data);
          const server = event.data && event.data.serverId ? store.get(event.data.serverId) : null;
          logger.setSecrets(server ? collectSecrets(server) : []);
        } else if (event.type === 'event') {
          send(IPC_EVENTS.CONNECTION_EVENT, event.data);
        }
      },
    });

    // Proxy-based latency probes go through the live connection.
    latency.proxyProbe = (entry, kind, timeoutMs) => connection.probe(entry, kind, timeoutMs);
    // Real delay runs its own throwaway core, so it works while disconnected.
    latency.realDelayProbe = (entry, timeoutMs) => realDelayProbe(entry, timeoutMs);

    speed = new SpeedTestService();

    registerIpc({
      settings,
      store,
      latency,
      connection,
      core,
      speed,
      logger,
      send,
      refreshConfigs: () => refreshConfigs(),
      clearCache,
      getCacheInfo,
      onSettingsChanged,
    });

    mainWindow = createMainWindow({ devTools: process.argv.includes('--dev') });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Keep the renderer's traffic-light buttons in sync with the real state.
    const forwardMaximizeState = () => {
      send(IPC.WINDOW_MAXIMIZED, {
        maximized: Boolean(mainWindow && mainWindow.isMaximized()),
      });
    };
    mainWindow.on('maximize', forwardMaximizeState);
    mainWindow.on('unmaximize', forwardMaximizeState);
    mainWindow.on('restore', forwardMaximizeState);

    // Load cached servers immediately, then refresh in the background.
    const hadCache = await loadCachedConfigs();
    send(IPC_EVENTS.SERVERS_CHANGED, { meta: store.meta(), fromCache: hadCache });

    scheduleAutoRefresh();
    scheduleAutoPing();

    refreshConfigs({ silent: false }).catch((err) => {
      // Offline start with a cache is a valid state; surface the error only.
      logger.warn('Startup refresh failed.', { error: err && err.message, hasCache: hadCache });
    });

    // Locate the core in the background so Settings can show it early.
    core.ensureCore(settings.get().corePath).then((result) => {
      send(IPC_EVENTS.CORE_STATUS, { status: core.status(), core: result });
      if (!result.found) {
        logger.warn('No proxy core found yet.', { path: settings.get().corePath || '(auto)' });
      }
    });

    // Optional: connect to the last selected server on launch.
    if (settings.get().connectOnLaunch && store.selectedId) {
      const target = store.selectedId;
      setTimeout(() => {
        connection.connect(target).catch(() => {});
      }, 800);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    (async () => {
      try {
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        if (autoPingTimer) clearInterval(autoPingTimer);
        if (speed) speed.cancel();
        if (latency) latency.cancelAll();
        if (connection) await connection.shutdown();
        if (settings) settings.flush();
      } catch (err) {
        console.error('Shutdown error:', err);
      } finally {
        app.quit();
      }
    })();
  });

  // Never let a stray ipc error crash the process.
  ipcMain.on('northstar:ping', (event) => {
    event.returnValue = 'pong';
  });
}
