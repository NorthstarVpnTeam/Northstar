'use strict';

/**
 * IPC handler registration.
 *
 * Every handler:
 *   - validates its payload with src/shared/validation.js
 *   - never trusts the renderer for identifiers, ports or URLs
 *   - returns { ok, ... } and converts thrown errors into { ok:false, error }
 *   - keeps secrets (raw URIs, credentials) out of logs
 */

const { dialog, clipboard, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { IPC } = require('../shared/constants');
const {
  validateSettingsUpdate,
  validateServerId,
  validateLatencyRequest,
  validateConnectRequest,
  validateSpeedRequest,
} = require('../shared/validation');
const { describe } = require('../services/configuration-parser');

function wrap(handler) {
  return async (_event, payload) => {
    try {
      const result = await handler(payload);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        if ('ok' in result) return result;
        return { ok: true, ...result };
      }
      return { ok: true, value: result };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? String(err.message).slice(0, 500) : 'Unknown error',
      };
    }
  };
}

/**
 * @param {object} ctx
 * @param {object} ctx.settings settings service
 * @param {object} ctx.store server store
 * @param {object} ctx.latency latency service
 * @param {object} ctx.connection connection manager
 * @param {object} ctx.core core manager
 * @param {object} ctx.speed speed test service
 * @param {object} ctx.logger app logger with .recent(), .redactedBundle()
 * @param {object} ctx.refreshConfigs function returning refresh stats
 * @param {object} ctx.clearCache function
 * @param {object} ctx.getCacheInfo function
 */
function registerIpc(ctx) {
  const { ipcMain } = require('electron');

  /* ------------------------------------------------------- settings */

  ipcMain.handle(IPC.SETTINGS_GET, wrap(() => ctx.settings.get()));

  ipcMain.handle(
    IPC.SETTINGS_SET,
    wrap(async (patch) => {
      const result = ctx.settings.update(patch || {});
      if (!result.ok) return { ok: false, error: result.error };
      ctx.onSettingsChanged(result.settings);
      return { ok: true, settings: result.settings };
    })
  );

  ipcMain.handle(
    IPC.SETTINGS_RESET,
    wrap(async () => {
      const settings = ctx.settings.reset();
      ctx.onSettingsChanged(settings);
      return { ok: true, settings };
    })
  );

  /* ----------------------------------------------------- configurations */

  ipcMain.handle(
    IPC.CONFIG_REFRESH,
    wrap(async () => {
      const stats = await ctx.refreshConfigs();
      return { ok: true, stats };
    })
  );

  /* ----------------------------------------------------------- servers */

  ipcMain.handle(IPC.SERVERS_LIST, wrap(() => ({ rows: ctx.store.listRows() })));

  ipcMain.handle(
    IPC.SERVERS_GROUPS,
    wrap((options = {}) => {
      const settings = ctx.settings.get();
      const sort = options.sort || (settings.autoSort ? settings.sortBy : 'name');
      const hideFailed = options.hideFailed !== undefined ? Boolean(options.hideFailed) : settings.hideFailed;
      return { groups: ctx.store.groups({ sort, hideFailed }), meta: ctx.store.meta() };
    })
  );

  ipcMain.handle(
    IPC.SERVERS_SELECT,
    wrap((payload = {}) => {
      const id = validateServerId(payload.id);
      if (!id.ok) return { ok: false, error: id.error };
      if (!ctx.store.select(id.value)) return { ok: false, error: 'Unknown server.' };
      return { ok: true, selectedId: ctx.store.selectedId };
    })
  );

  ipcMain.handle(IPC.SERVERS_SELECTED, wrap(() => ({ selectedId: ctx.store.selectedId })));

  ipcMain.handle(
    IPC.SERVERS_COPY,
    wrap((payload = {}) => {
      const id = validateServerId(payload.id);
      if (!id.ok) return { ok: false, error: id.error };
      const server = ctx.store.get(id.value);
      if (!server) return { ok: false, error: 'Unknown server.' };
      clipboard.writeText(server.raw);
      ctx.logger.info('Copied a configuration to the clipboard.', { serverId: server.id });
      return { ok: true, label: server.label };
    })
  );

  ipcMain.handle(
    IPC.SERVERS_DETAILS,
    wrap((payload = {}) => {
      const id = validateServerId(payload.id);
      if (!id.ok) return { ok: false, error: id.error };
      const server = ctx.store.get(id.value);
      if (!server) return { ok: false, error: 'Unknown server.' };

      // Technical view with credentials masked.
      const basic = describe(server);
      const cred = server.credential ? String(server.credential) : '';
      const masked = cred
        ? cred.length <= 8
          ? '••••'
          : `${cred.slice(0, 4)}${'•'.repeat(Math.min(12, cred.length - 4))}`
        : '';
      const extra = server.extra || {};
      return {
        ok: true,
        details: {
          ...basic,
          credentialMasked: masked,
          sni: server.sni || '',
          flow: server.flow || '',
          transport: server.transport || server.network,
          cipher: extra.cipher || '',
          plugin: extra.plugin || '',
          allowInsecure: Boolean(extra.allowInsecure),
          label: server.label,
          rawLength: server.raw ? server.raw.length : 0,
        },
      };
    })
  );

  /* ----------------------------------------------------------- latency */

  ipcMain.handle(
    IPC.LATENCY_TEST,
    wrap(async (payload) => {
      const request = validateLatencyRequest(payload);
      if (!request.ok) return { ok: false, error: request.error };

      const settings = ctx.settings.get();
      const kind = request.value.type || settings.measurementType;
      let targets;
      if (request.value.all) {
        targets = ctx.store.servers.slice();
      } else {
        targets = request.value.ids
          .map((sid) => ctx.store.get(sid))
          .filter(Boolean);
      }
      if (targets.length === 0) return { ok: true, results: [], total: 0 };

      const results = await ctx.latency.measureMany(targets, {
        kind,
        timeoutMs: settings.pingTimeoutMs,
        onProgress: ({ done, total, result }) => {
          ctx.send(IPC.LATENCY_UPDATE, { result, done, total });
        },
      });
      for (const result of results) ctx.store.setLatency(result.id, result);
      return { ok: true, results, total: results.length, kind };
    })
  );

  ipcMain.handle(
    IPC.LATENCY_CANCEL,
    wrap(() => {
      ctx.latency.cancelAll();
      return { ok: true };
    })
  );

  /* ------------------------------------------------------- connection */

  ipcMain.handle(IPC.CONNECTION_STATUS, wrap(() => ctx.connection.status()));
  ipcMain.handle(IPC.CONNECTION_EVENTS, wrap(() => ({ events: ctx.connection.recentEvents() })));

  ipcMain.handle(
    IPC.CONNECTION_CONNECT,
    wrap(async (payload) => {
      const request = validateConnectRequest(payload);
      if (!request.ok) return { ok: false, error: request.error };
      return ctx.connection.connect(request.value.serverId);
    })
  );

  ipcMain.handle(
    IPC.CONNECTION_DISCONNECT,
    wrap(async () => ctx.connection.disconnect())
  );

  /* ------------------------------------------------------------- core */

  ipcMain.handle(IPC.CORE_STATUS, wrap(() => ctx.core.status()));

  ipcMain.handle(
    IPC.CORE_LOCATE,
    wrap(async () => {
      const settings = ctx.settings.get();
      const result = await ctx.core.ensureCore(settings.corePath);
      return { ok: true, core: result, status: ctx.core.status() };
    })
  );

  // File picker for the proxy core binary (main process owns dialogs).
  ipcMain.handle(
    IPC.CORE_PICK,
    wrap(async () => {
      const isWin = process.platform === 'win32';
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select the proxy core executable',
        properties: ['openFile'],
        filters: isWin
          ? [
              { name: 'Executables', extensions: ['exe'] },
              { name: 'All files', extensions: ['*'] },
            ]
          : [{ name: 'All files', extensions: ['*'] }],
      });
      if (canceled || !filePaths || !filePaths.length) {
        return { ok: false, error: 'Cancelled.', code: 'cancelled' };
      }
      return { ok: true, path: filePaths[0] };
    })
  );

  /* ------------------------------------------------------- speed test */

  ipcMain.handle(
    IPC.SPEED_START,
    wrap(async (payload) => {
      const request = validateSpeedRequest(payload);
      if (!request.ok) return { ok: false, error: request.error };
      if (ctx.connection.status().state !== 'connected' && request.value.viaProxy) {
        return {
          ok: false,
          error: 'Connect to a server first, or run the test without the proxy.',
          code: 'not-connected',
        };
      }
      if (ctx.speed.running) return { ok: false, error: 'A speed test is already running.', code: 'busy' };

      const settings = ctx.settings.get();
      // Fire and report through events; also resolve when finished.
      const promise = ctx.speed.run({
        direction: request.value.direction,
        viaProxy: request.value.viaProxy,
        ports: { socksPort: settings.socksPort, httpPort: settings.httpPort },
        onProgress: (progress) => ctx.send(IPC.SPEED_PROGRESS, progress),
      });
      promise.then((result) => ctx.send(IPC.SPEED_RESULT, result));
      return { ok: true, started: true };
    })
  );

  ipcMain.handle(
    IPC.SPEED_CANCEL,
    wrap(() => {
      ctx.speed.cancel();
      return { ok: true };
    })
  );

  /* ----------------------------------------------------- diagnostics */

  ipcMain.handle(IPC.LOGS_RECENT, wrap((payload = {}) => ({ logs: ctx.logger.recent(payload.limit) })));

  ipcMain.handle(
    IPC.LOGS_EXPORT,
    wrap(async () => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export redacted diagnostics',
        defaultPath: path.join(app.getPath('documents'), 'northstar-diagnostics.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return { ok: false, error: 'Export cancelled.', code: 'cancelled' };
      const bundle = ctx.logger.redactedBundle();
      await fs.promises.writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8');
      ctx.logger.info('Diagnostics exported.', { filePath });
      return { ok: true, filePath };
    })
  );

  ipcMain.handle(
    IPC.CACHE_CLEAR,
    wrap(async () => {
      await ctx.clearCache();
      return { ok: true, cache: ctx.getCacheInfo() };
    })
  );

  /* -------------------------------------------------------------- app */

  ipcMain.handle(
    IPC.APP_INFO,
    wrap(() => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath('userData'),
      locale: app.getLocale(),
    }))
  );

  ipcMain.handle(
    IPC.APP_OPEN_EXTERNAL,
    wrap(async (payload = {}) => {
      let url;
      try {
        url = new URL(String(payload.url || ''));
      } catch {
        return { ok: false, error: 'Invalid URL.' };
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, error: 'Only http(s) links can be opened.' };
      }
      await shell.openExternal(url.toString());
      return { ok: true };
    })
  );

  /* ---------------------------------------------------- window controls */

  /**
   * The window is frameless (macOS-style traffic lights in the renderer), so
   * minimize / maximize / close arrive over IPC. Only the app's own top-level
   * document may request them — a subframe or any other sender is refused.
   */
  function windowFor(event) {
    try {
      if (event.senderFrame !== event.sender.mainFrame) return null;
      if (!String((event.senderFrame && event.senderFrame.url) || '').startsWith('file://')) {
        return null;
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      return win && !win.isDestroyed() ? win : null;
    } catch {
      return null;
    }
  }

  function windowHandler(action) {
    return async (event) => {
      const win = windowFor(event);
      if (!win) return { ok: false, error: 'Window control refused.' };
      try {
        action(win);
        return { ok: true, maximized: Boolean(win.isMaximized()) };
      } catch (err) {
        return {
          ok: false,
          error: err && err.message ? String(err.message).slice(0, 200) : 'Window control failed.',
        };
      }
    };
  }

  ipcMain.handle(
    IPC.WINDOW_MINIMIZE,
    windowHandler((win) => {
      if (!win.isMinimized()) win.minimize();
    })
  );

  ipcMain.handle(
    IPC.WINDOW_MAXIMIZE_TOGGLE,
    windowHandler((win) => {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    })
  );

  ipcMain.handle(
    IPC.WINDOW_CLOSE,
    windowHandler((win) => {
      win.close();
    })
  );
}

module.exports = { registerIpc };
