'use strict';

/**
 * Shared constants used by the main process, preload and services.
 * This module must stay free of Electron and Node-only APIs so it can be
 * loaded anywhere (including plain unit tests).
 */

const packageJson = require('../../package.json');

const APP_NAME = 'Northstar V2Ray';
const APP_ID = 'com.northstar.v2ray';
const APP_VERSION = packageJson.version;

/** Default public configuration list. Configurable in Settings. */
const DEFAULT_CONFIG_SOURCE =
  'https://raw.githubusercontent.com/shupolol/Free-configs/refs/heads/main/output/all_configs.txt';

/** Protocols the proxy core integration accepts. */
const PROTOCOLS = Object.freeze(['vless', 'vmess', 'trojan', 'ss', 'socks', 'http']);

/** Connection state machine states. */
const CONNECTION_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
  ERROR: 'error',
});

/** Latency measurement kinds. Each label must match what is actually tested. */
const MEASUREMENT = Object.freeze({
  TCP: 'tcp', // direct TCP connect time to the remote server
  PROXY: 'proxy', // SOCKS5 handshake through the local proxy core
  E2E: 'e2e', // full HTTP request through the local proxy core
  // v2rayN-style "real delay": a throwaway core is started for the server and
  // a full HTTP round trip runs through it, so the number proves the config
  // works — independent of any active connection.
  DELAY: 'delay',
});

const MEASUREMENT_LABELS = Object.freeze({
  [MEASUREMENT.TCP]: 'TCP connect',
  [MEASUREMENT.PROXY]: 'Proxy handshake',
  [MEASUREMENT.E2E]: 'End-to-end (through proxy)',
  [MEASUREMENT.DELAY]: 'Real delay',
});

const SORT_MODES = Object.freeze(['latency', 'name', 'country', 'protocol']);

const PING_INTERVAL_OPTIONS = Object.freeze([15000, 30000, 60000, 120000, 300000]);

const LIMITS = Object.freeze({
  PING_TIMEOUT_MIN: 500,
  PING_TIMEOUT_MAX: 10000,
  PORT_MIN: 1024,
  PORT_MAX: 65535,
  FETCH_TIMEOUT_MS: 30000,
  FETCH_MAX_BYTES: 8 * 1024 * 1024,
  MAX_SERVERS: 20000,
  LATENCY_CONCURRENCY: 8,
  // Real delay spawns a temporary core per server, so it runs far narrower.
  REAL_DELAY_CONCURRENCY: 2,
  CONNECT_LISTENER_TIMEOUT_MS: 15000,
  CORE_START_TIMEOUT_MS: 20000,
  SPEED_TEST_MAX_BYTES: 40 * 1024 * 1024,
  SPEED_TEST_TIMEOUT_MS: 30000,
  LOG_RING_SIZE: 500,
  EVENT_RING_SIZE: 100,
});

const DEFAULT_SETTINGS = Object.freeze({
  // Server settings
  configSource: DEFAULT_CONFIG_SOURCE,
  autoRefresh: false,
  autoRefreshIntervalMin: 60,
  autoPing: true,
  pingTimeoutMs: 4000,
  pingIntervalMs: 60000,
  autoSort: true,
  sortBy: 'latency',
  hideFailed: false,

  // Connection settings
  socksPort: 10808,
  httpPort: 10809,
  measurementType: MEASUREMENT.TCP,
  validateOnConnect: true,
  validationType: MEASUREMENT.E2E,
  connectOnLaunch: false,
  corePath: '',

  // Traffic routing (explicit, reversible opt-ins — nothing is applied
  // automatically; both are off by default).
  systemProxy: false, // point Windows' per-user proxy at Northstar while connected
  tunMode: false, // create an Xray TUN interface and route device traffic through it

  // Appearance
  theme: 'light',
  reduceMotion: false,
  compactRows: false,

  // Diagnostics
  verboseLogging: false,
});

const VALIDATION_ENDPOINTS = Object.freeze([
  'http://www.gstatic.com/generate_204',
  'http://cp.cloudflare.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
]);

/** IPC channel names. Every channel used between renderer and main. */
const IPC = Object.freeze({
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',

  // configurations
  CONFIG_REFRESH: 'config:refresh',
  CONFIG_STATE: 'config:state',
  CONFIG_PROGRESS: 'config:progress',

  // servers
  SERVERS_LIST: 'servers:list',
  SERVERS_GROUPS: 'servers:groups',
  SERVERS_SELECT: 'servers:select',
  SERVERS_SELECTED: 'servers:selected',
  SERVERS_COPY: 'servers:copy',
  SERVERS_DETAILS: 'servers:details',

  // latency
  LATENCY_TEST: 'latency:test',
  LATENCY_CANCEL: 'latency:cancel',
  LATENCY_UPDATE: 'latency:update',
  LATENCY_STATE: 'latency:state',

  // connection
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_EVENT: 'connection:event',
  CONNECTION_EVENTS: 'connection:events',

  // core
  CORE_STATUS: 'core:status',
  CORE_LOCATE: 'core:locate',
  CORE_PICK: 'core:pick',

  // speed test
  SPEED_START: 'speed:start',
  SPEED_CANCEL: 'speed:cancel',
  SPEED_PROGRESS: 'speed:progress',
  SPEED_RESULT: 'speed:result',

  // logs / diagnostics
  LOGS_RECENT: 'logs:recent',
  LOGS_EXPORT: 'logs:export',
  CACHE_CLEAR: 'cache:clear',

  // app
  APP_INFO: 'app:info',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // window controls (frameless titlebar)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximizeToggle',
  WINDOW_CLOSE: 'window:close',
  WINDOW_MAXIMIZED: 'window:maximized',
});

/** Event names pushed from main to renderer (via webContents.send). */
const IPC_EVENTS = Object.freeze({
  CONFIG_PROGRESS: IPC.CONFIG_PROGRESS,
  LATENCY_UPDATE: IPC.LATENCY_UPDATE,
  LATENCY_STATE: IPC.LATENCY_STATE,
  CONNECTION_STATUS: IPC.CONNECTION_STATUS,
  CONNECTION_EVENT: IPC.CONNECTION_EVENT,
  SPEED_PROGRESS: IPC.SPEED_PROGRESS,
  SPEED_RESULT: IPC.SPEED_RESULT,
  SETTINGS_CHANGED: 'settings:changed',
  SERVERS_CHANGED: 'servers:changed',
  CORE_STATUS: IPC.CORE_STATUS,
  WINDOW_MAXIMIZED: IPC.WINDOW_MAXIMIZED,
  LOG_LINE: 'log:line',
});

module.exports = {
  APP_NAME,
  APP_ID,
  APP_VERSION,
  DEFAULT_CONFIG_SOURCE,
  PROTOCOLS,
  CONNECTION_STATE,
  MEASUREMENT,
  MEASUREMENT_LABELS,
  SORT_MODES,
  PING_INTERVAL_OPTIONS,
  LIMITS,
  DEFAULT_SETTINGS,
  VALIDATION_ENDPOINTS,
  IPC,
  IPC_EVENTS,
};
