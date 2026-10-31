'use strict';

/**
 * Preload: the only bridge between the renderer and the application.
 *
 * Security properties:
 *   - exposes a single frozen `northstar` object (no ipcRenderer, no Node)
 *   - every channel is allowlisted; unknown channels throw
 *   - all payloads are passed through untouched (validation lives in main)
 *
 * NOTE: channel names are duplicated here on purpose. A sandboxed preload
 * cannot require project files, so keep this list in sync with
 * src/shared/constants.js (tests/check-syntax.js asserts it).
 */

const { contextBridge, ipcRenderer } = require('electron');

// --- invoke channels (renderer -> main, request/response) ---
const INVOKE = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',
  CONFIG_REFRESH: 'config:refresh',
  SERVERS_LIST: 'servers:list',
  SERVERS_GROUPS: 'servers:groups',
  SERVERS_SELECT: 'servers:select',
  SERVERS_SELECTED: 'servers:selected',
  SERVERS_COPY: 'servers:copy',
  SERVERS_DETAILS: 'servers:details',
  LATENCY_TEST: 'latency:test',
  LATENCY_CANCEL: 'latency:cancel',
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_EVENTS: 'connection:events',
  CORE_STATUS: 'core:status',
  CORE_LOCATE: 'core:locate',
  CORE_PICK: 'core:pick',
  SPEED_START: 'speed:start',
  SPEED_CANCEL: 'speed:cancel',
  LOGS_RECENT: 'logs:recent',
  LOGS_EXPORT: 'logs:export',
  CACHE_CLEAR: 'cache:clear',
  APP_INFO: 'app:info',
  APP_OPEN_EXTERNAL: 'app:openExternal',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximizeToggle',
  WINDOW_CLOSE: 'window:close',
};

// --- push channels (main -> renderer) ---
const EVENTS = {
  CONFIG_PROGRESS: 'config:progress',
  LATENCY_UPDATE: 'latency:update',
  LATENCY_STATE: 'latency:state',
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_EVENT: 'connection:event',
  SPEED_PROGRESS: 'speed:progress',
  SPEED_RESULT: 'speed:result',
  SETTINGS_CHANGED: 'settings:changed',
  SERVERS_CHANGED: 'servers:changed',
  CORE_STATUS: 'core:status',
  WINDOW_MAXIMIZED: 'window:maximized',
  LOG_LINE: 'log:line',
};

const ALLOWED_INVOKE = new Set(Object.values(INVOKE));
const ALLOWED_EVENTS = new Set(Object.values(EVENTS));

function invoke(channel, payload) {
  if (!ALLOWED_INVOKE.has(channel)) {
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  if (!ALLOWED_EVENTS.has(channel)) {
    throw new Error(`Blocked IPC event channel: ${channel}`);
  }
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      // A renderer listener must never break the bridge.
      console.error('northstar listener error', err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = Object.freeze({
  settings: Object.freeze({
    get: () => invoke(INVOKE.SETTINGS_GET),
    set: (patch) => invoke(INVOKE.SETTINGS_SET, patch),
    reset: () => invoke(INVOKE.SETTINGS_RESET),
    onChanged: (cb) => subscribe(EVENTS.SETTINGS_CHANGED, cb),
  }),
  config: Object.freeze({
    refresh: () => invoke(INVOKE.CONFIG_REFRESH),
    onProgress: (cb) => subscribe(EVENTS.CONFIG_PROGRESS, cb),
  }),
  servers: Object.freeze({
    list: () => invoke(INVOKE.SERVERS_LIST),
    groups: (options) => invoke(INVOKE.SERVERS_GROUPS, options),
    select: (id) => invoke(INVOKE.SERVERS_SELECT, { id }),
    getSelected: () => invoke(INVOKE.SERVERS_SELECTED),
    copy: (id) => invoke(INVOKE.SERVERS_COPY, { id }),
    details: (id) => invoke(INVOKE.SERVERS_DETAILS, { id }),
    onChanged: (cb) => subscribe(EVENTS.SERVERS_CHANGED, cb),
  }),
  latency: Object.freeze({
    test: (request) => invoke(INVOKE.LATENCY_TEST, request),
    cancel: () => invoke(INVOKE.LATENCY_CANCEL),
    onUpdate: (cb) => subscribe(EVENTS.LATENCY_UPDATE, cb),
    onState: (cb) => subscribe(EVENTS.LATENCY_STATE, cb),
  }),
  connection: Object.freeze({
    status: () => invoke(INVOKE.CONNECTION_STATUS),
    connect: (serverId) => invoke(INVOKE.CONNECTION_CONNECT, { serverId }),
    disconnect: () => invoke(INVOKE.CONNECTION_DISCONNECT),
    events: () => invoke(INVOKE.CONNECTION_EVENTS),
    onStatus: (cb) => subscribe(EVENTS.CONNECTION_STATUS, cb),
    onEvent: (cb) => subscribe(EVENTS.CONNECTION_EVENT, cb),
  }),
  core: Object.freeze({
    status: () => invoke(INVOKE.CORE_STATUS),
    locate: () => invoke(INVOKE.CORE_LOCATE),
    pick: () => invoke(INVOKE.CORE_PICK),
    onStatus: (cb) => subscribe(EVENTS.CORE_STATUS, cb),
  }),
  speed: Object.freeze({
    start: (request) => invoke(INVOKE.SPEED_START, request),
    cancel: () => invoke(INVOKE.SPEED_CANCEL),
    onProgress: (cb) => subscribe(EVENTS.SPEED_PROGRESS, cb),
    onResult: (cb) => subscribe(EVENTS.SPEED_RESULT, cb),
  }),
  logs: Object.freeze({
    recent: (limit) => invoke(INVOKE.LOGS_RECENT, { limit }),
    export: () => invoke(INVOKE.LOGS_EXPORT),
    onLine: (cb) => subscribe(EVENTS.LOG_LINE, cb),
  }),
  cache: Object.freeze({
    clear: () => invoke(INVOKE.CACHE_CLEAR),
  }),
  app: Object.freeze({
    info: () => invoke(INVOKE.APP_INFO),
    openExternal: (url) => invoke(INVOKE.APP_OPEN_EXTERNAL, { url }),
  }),
  // Frameless window controls (macOS-style traffic lights).
  win: Object.freeze({
    minimize: () => invoke(INVOKE.WINDOW_MINIMIZE),
    maximizeToggle: () => invoke(INVOKE.WINDOW_MAXIMIZE_TOGGLE),
    close: () => invoke(INVOKE.WINDOW_CLOSE),
    onMaximized: (cb) => subscribe(EVENTS.WINDOW_MAXIMIZED, cb),
  }),
});

contextBridge.exposeInMainWorld('northstar', api);
