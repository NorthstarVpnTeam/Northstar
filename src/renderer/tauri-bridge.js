/**
 * Tauri bridge.
 *
 * The renderer was written against a preload bridge (`window.northstar`). This
 * module installs the same interface on top of Tauri: every call is handled by
 * the single `northstar_call` Rust command and every subscription listens to
 * the matching Tauri event. Nothing here touches the network or the proxy.
 *
 * Loaded first by app.js so the application code sees the API synchronously.
 */

const tauri = window.__TAURI__;

if (tauri && !window.northstar) {
  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  const call = (method, payload = null) => invoke('northstar_call', { method, payload });

  /** Subscribes to a Rust-emitted event; returns an unsubscribe function. */
  const subscribe = (event, callback) => {
    let unlisten = null;
    listen(event, (message) => {
      try {
        callback(message.payload);
      } catch (error) {
        console.error('northstar listener error', error);
      }
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  };

  const currentWindow = () => tauri.window.getCurrentWindow();

  const api = Object.freeze({
    settings: Object.freeze({
      get: () => call('settings:get'),
      set: (patch) => call('settings:set', patch),
      reset: () => call('settings:reset'),
      onChanged: (cb) => subscribe('settings:changed', cb),
    }),
    config: Object.freeze({
      refresh: () => call('config:refresh'),
      onProgress: (cb) => subscribe('config:progress', cb),
    }),
    servers: Object.freeze({
      list: () => call('servers:list'),
      groups: (options) => call('servers:groups', options),
      select: (id) => call('servers:select', { id }),
      getSelected: () => call('servers:selected'),
      copy: (id) => call('servers:copy', { id }),
      details: (id) => call('servers:details', { id }),
      onChanged: (cb) => subscribe('servers:changed', cb),
    }),
    latency: Object.freeze({
      test: (request) => call('latency:test', request),
      cancel: () => call('latency:cancel'),
      onUpdate: (cb) => subscribe('latency:update', cb),
      onState: (cb) => subscribe('latency:state', cb),
    }),
    connection: Object.freeze({
      status: () => call('connection:status'),
      connect: (serverId) => call('connection:connect', { serverId }),
      disconnect: () => call('connection:disconnect'),
      events: () => call('connection:events'),
      onStatus: (cb) => subscribe('connection:status', cb),
      onEvent: (cb) => subscribe('connection:event', cb),
    }),
    core: Object.freeze({
      status: () => call('core:status'),
      locate: () => call('core:locate'),
      pick: () => call('core:pick'),
      onStatus: (cb) => subscribe('core:status', cb),
    }),
    speed: Object.freeze({
      start: (request) => call('speed:start', request),
      cancel: () => call('speed:cancel'),
      onProgress: (cb) => subscribe('speed:progress', cb),
      onResult: (cb) => subscribe('speed:result', cb),
    }),
    logs: Object.freeze({
      recent: (limit) => call('logs:recent', { limit }),
      export: () => call('logs:export'),
      onLine: (cb) => subscribe('log:line', cb),
    }),
    cache: Object.freeze({
      clear: () => call('cache:clear'),
    }),
    app: Object.freeze({
      info: () => call('app:info'),
      openExternal: (url) => call('app:openExternal', { url }),
    }),
    // Tauri handles window controls natively; no round trip through Rust.
    win: Object.freeze({
      minimize: () => currentWindow().minimize(),
      maximizeToggle: () => currentWindow().toggleMaximize(),
      close: () => currentWindow().close(),
      onMaximized: (cb) => {
        const win = currentWindow();
        win.onResized(async () => {
          try {
            cb({ maximized: await win.isMaximized() });
          } catch {
            cb({ maximized: false });
          }
        });
        return () => {};
      },
    }),
  });

  Object.defineProperty(window, 'northstar', {
    value: api,
    configurable: true,
    writable: false,
  });
}
