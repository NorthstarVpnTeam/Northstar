/**
 * Renderer entry point: application state, navigation, event wiring and the
 * action layer shared by all views.
 *
 * Rendering rules:
 *   - only the active view re-renders
 *   - focus and scroll position survive re-renders
 *   - list reordering is deferred while the user interacts with it
 */

import { toast, openModal } from './ui.js';
import { renderOverview } from './views/overview.js';
import { renderServers, resetServersUi, getFilters } from './views/servers.js';
import { renderConnection } from './views/connection.js';
import { renderSettings } from './views/settings.js';
import { renderAbout } from './views/about.js';

const api = window.northstar;
if (!api) {
  document.body.textContent =
    'Northstar could not start: the preload bridge is unavailable. Reinstall the application.';
  throw new Error('preload bridge missing');
}

const state = {
  view: 'overview',
  settings: null,
  connection: null,
  events: [],
  logs: [],
  core: null,
  appInfo: null,
  fetching: false,
  fetch: null,
  servers: { rows: [], groups: [], meta: null },
  latency: { running: false },
  speed: { running: false, progress: null, result: null },
  speedViaProxy: true,
  cacheInfo: null,
};

const VIEW_RENDERERS = {
  overview: renderOverview,
  servers: renderServers,
  connection: renderConnection,
  settings: renderSettings,
  about: renderAbout,
};

let interacting = false; // user is hovering/focusing the server list
let pendingRender = false;
let renderQueued = false;

/* ------------------------------------------------------------ rendering */

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    doRender();
  });
}

function doRender() {
  if (state.view === 'servers' && interacting) {
    pendingRender = true;
    return;
  }

  // Never rebuild the DOM under a field the user is still typing in: the new
  // element would be recreated from committed state and swallow the text.
  // The render is deferred until focus leaves the field.
  if (isTyping(document.activeElement)) {
    pendingRender = true;
    return;
  }
  const container = document.getElementById(`view-${state.view}`);
  if (!container) return;

  const main = document.querySelector('.main');
  const scrollTop = main ? main.scrollTop : 0;

  // Preserve focus across re-renders (search box, selects, switches).
  const active = document.activeElement;
  const focusId = active && active.id ? active.id : null;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;

  VIEW_RENDERERS[state.view](container, ctx);

  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored && restored !== document.activeElement) {
      restored.focus({ preventScroll: true });
      if (selStart !== null && typeof restored.setSelectionRange === 'function') {
        try {
          restored.setSelectionRange(selStart, selEnd);
        } catch {
          /* input type does not support selection */
        }
      }
    }
  }
  if (main) main.scrollTop = scrollTop;
}

function setInteracting(value) {
  interacting = value;
  if (!value && pendingRender) {
    pendingRender = false;
    render();
  }
}

/** True for text-entry elements whose contents must survive a re-render. */
function isTyping(node) {
  if (!node || node === document.body || typeof node.tagName !== 'string') return false;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(node.type || 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(
    type
  );
}

function navigate(view) {
  if (!VIEW_RENDERERS[view]) return;
  state.view = view;
  for (const node of document.querySelectorAll('.view')) {
    node.classList.toggle('is-active', node.dataset.view === view);
  }
  for (const node of document.querySelectorAll('.nav-item, .bottom-item')) {
    const active = node.dataset.view === view;
    node.classList.toggle('is-active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
  render();
}

/* -------------------------------------------------------------- actions */

const actions = {
  navigate,

  setInteracting,

  rerenderServers() {
    render();
  },

  /** Re-renders the active view (used by controls that flip local UI state). */
  rerender() {
    render();
  },

  async reloadServers() {
    const settings = state.settings || {};
    const filters = getFilters();
    const sort = settings.autoSort ? settings.sortBy : filters.sort;
    const result = await api.servers.groups({
      sort,
      hideFailed: settings.hideFailed,
      query: filters.query,
      protocol: filters.protocol,
      status: filters.status,
    });
    if (result.ok) {
      state.servers.groups = result.groups;
      state.servers.meta = result.meta;
      state.servers.rows = result.groups.flatMap((g) => g.servers);
      render();
    } else {
      toast(result.error || 'Could not load servers.', 'error');
    }
  },

  async refreshConfigs() {
    if (state.fetching) return;
    state.fetching = true;
    state.fetch = { phase: 'start' };
    render();
    try {
      const result = await api.config.refresh();
      state.fetching = false;
      state.fetch = { phase: 'done', stats: result.stats };
      if (result.ok) {
        const stats = result.stats;
        toast(
          `Loaded ${stats.kept} servers (${stats.duplicates} duplicates, ${stats.rejected} rejected).`,
          'ok'
        );
      }
      await actions.reloadServers();
    } catch (err) {
      state.fetching = false;
      state.fetch = {
        phase: 'error',
        message: err && err.message ? err.message : 'Refresh failed.',
      };
      toast(state.fetch.message, 'error');
      render();
    }
  },

  async selectServer(id) {
    const result = await api.servers.select(id);
    if (!result.ok) {
      toast(result.error || 'Selection failed.', 'error');
      return;
    }
    const row = state.servers.rows.find((r) => r.id === id);
    toast(`Selected ${row ? row.label : 'server'}.`, 'ok');
    await actions.reloadServers();
  },

  async copyServer(id) {
    const result = await api.servers.copy(id);
    if (result.ok) toast(`Copied ${result.label} configuration.`, 'ok');
    else toast(result.error || 'Copy failed.', 'error');
  },

  async pingOne(id) {
    const settings = state.settings || {};
    const result = await api.latency.test({ ids: [id], type: settings.measurementType });
    if (!result.ok) {
      toast(result.error || 'Ping failed.', 'error');
      return;
    }
    await actions.reloadServers();
  },

  async pingAll() {
    const settings = state.settings || {};
    const result = await api.latency.test({ all: true, type: settings.measurementType });
    if (!result.ok) {
      toast(result.error || 'Ping run failed.', 'error');
      state.latency = { running: false };
      render();
      return;
    }
    state.latency = { running: false };
    await actions.reloadServers();
    const okCount = result.results.filter((r) => r.ok).length;
    toast(`Measured ${result.total} servers · ${okCount} reachable.`, okCount > 0 ? 'ok' : 'warn');
  },

  cancelPing() {
    api.latency.cancel();
    state.latency = { running: false };
    render();
  },

  async toggleConnect() {
    const status = state.connection;
    if (status && status.state === 'connected') {
      await actions.disconnect();
      return;
    }
    const selected = state.servers.rows.find((r) => r.selected);
    if (!selected) {
      toast('Select a server first.', 'warn');
      navigate('servers');
      return;
    }
    const result = await api.connection.connect(selected.id);
    if (!result.ok) {
      toast(result.error || 'Connection failed.', 'error');
      render();
    }
  },

  async disconnect() {
    const result = await api.connection.disconnect();
    if (!result.ok) toast(result.error || 'Disconnect failed.', 'error');
  },

  async updateSettings(patch) {
    const result = await api.settings.set(patch);
    if (!result.ok) {
      toast(result.error || 'Invalid setting.', 'error');
      // Re-render to revert the control to the stored value.
      const fresh = await api.settings.get();
      if (fresh.ok) {
        state.settings = fresh.settings || fresh.value;
        applyTheme();
      }
      render();
      return null;
    }
    return result.settings;
  },

  async resetSettings() {
    const result = await api.settings.reset();
    if (result.ok) {
      toast('Settings restored to defaults.', 'ok');
      await actions.reloadServers();
    } else toast(result.error || 'Reset failed.', 'error');
  },

  async clearCache() {
    const result = await api.cache.clear();
    if (result.ok) {
      state.cacheInfo = result.cache;
      state.servers = { rows: [], groups: [], meta: null };
      toast('Cached configurations cleared.', 'ok');
      render();
    } else toast(result.error || 'Could not clear the cache.', 'error');
  },

  async locateCore() {
    const result = await api.core.locate();
    if (result.ok && result.core && result.core.found) {
      state.core = result.status;
      toast(`Found core: ${result.core.path}`, 'ok');
    } else {
      state.core = result.status || state.core;
      toast('No usable proxy core found. Set its path in Settings.', 'warn');
    }
    render();
  },

  async pickCore() {
    // File picking happens in the main process (dialog); see core:pick.
    const result = await api.core.pick();
    if (result.ok && result.path) {
      await actions.updateSettings({ corePath: result.path });
      await actions.locateCore();
    } else if (result.code !== 'cancelled') {
      toast(result.error || 'Could not open the file picker.', 'error');
    }
  },

  async startSpeed(direction) {
    const connected = state.connection && state.connection.state === 'connected';
    const viaProxy = Boolean(state.speedViaProxy) && connected;
    state.speed = { running: true, progress: null, result: null, viaProxy };
    render();
    const result = await api.speed.start({ direction, viaProxy });
    if (!result.ok) {
      state.speed = { running: false, progress: null, result: null };
      toast(result.error || 'Could not start the speed test.', 'error');
      render();
    }
  },

  cancelSpeed() {
    api.speed.cancel();
  },

  setSpeedViaProxy(value) {
    state.speedViaProxy = Boolean(value);
  },

  async reloadLogs() {
    const result = await api.logs.recent(120);
    if (result.ok) {
      state.logs = result.logs || (result.value && result.value.logs) || [];
      render();
    }
  },

  async exportLogs() {
    const result = await api.logs.export();
    if (result.ok) toast(`Diagnostics saved to ${result.filePath}`, 'ok');
    else if (result.code !== 'cancelled') toast(result.error || 'Export failed.', 'error');
  },

  async showLogs() {
    const result = await api.logs.recent(200);
    const logs = unwrap(result, 'logs') || [];
    const box = document.createElement('div');
    box.className = 'log-console';
    if (!logs.length) {
      box.textContent = 'No log entries yet.';
    } else {
      for (const line of logs) {
        const row = document.createElement('div');
        row.className = `log-line ${line.level}`;
        const ts = document.createElement('span');
        ts.className = 'log-ts';
        ts.textContent = new Date(line.ts).toLocaleTimeString();
        const msg = document.createElement('span');
        msg.textContent = line.message;
        row.append(ts, msg);
        box.appendChild(row);
      }
    }
    openModal({
      title: 'Application logs (redacted)',
      body: box,
      actions: [{ label: 'Close', value: 'close' }],
    });
  },

  openExternal(url) {
    api.app.openExternal(url);
  },
};

/* Filters live in the servers view module (see getFilters). */

const ctx = { state, api, actions };

/**
 * Normalizes the different handler response shapes into a plain value:
 * {ok, settings}, {ok, value}, {ok, logs} or {ok, ...fields}.
 */
function unwrap(result, key) {
  if (!result || result.ok === false) return null;
  if (result.settings) return result.settings;
  if (result.value !== undefined) return result.value;
  if (key && result[key] !== undefined) return result[key];
  const { ok, ...rest } = result;
  void ok;
  return rest;
}

/* ---------------------------------------------------------- subscriptions */

function applyTheme() {
  const settings = state.settings || {};
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('reduce-motion', Boolean(settings.reduceMotion));
  document.body.classList.toggle('compact-rows', Boolean(settings.compactRows));
}

function updateSidebarStatus() {
  const conn = state.connection;
  const dot = document.querySelector('#sidebar-status .status-dot');
  const text = document.querySelector('#sidebar-status .mini-status-text');
  if (!dot || !text) return;
  const status = conn ? conn.state : 'disconnected';
  dot.dataset.state = status;
  text.textContent = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnecting: 'Disconnecting…',
    error: 'Connection failed',
  }[status] || status;
}

function patchRowLatency(result) {
  for (const group of state.servers.groups || []) {
    const row = group.servers.find((r) => r.id === result.id);
    if (row) {
      row.latency = result.ms;
      row.latencyOk = result.ok;
      row.latencyKind = result.kind;
      row.latencyAt = result.at;
      return true;
    }
  }
  return false;
}

function wireEvents() {
  api.connection.onStatus((status) => {
    state.connection = status;
    updateSidebarStatus();
    render();
  });

  api.connection.onEvent((event) => {
    state.events.unshift(event);
    if (state.events.length > 60) state.events.pop();
    render();
  });

  api.config.onProgress((progress) => {
    state.fetch = progress;
    state.fetching = progress.phase !== 'done' && progress.phase !== 'error';
    render();
  });

  api.servers.onChanged((payload) => {
    if (payload && payload.meta) state.servers.meta = payload.meta;
    actions.reloadServers();
  });

  api.latency.onUpdate(({ result }) => {
    if (result) patchRowLatency(result);
    // Deferred while the user interacts with the list.
    render();
  });

  api.latency.onState((latencyState) => {
    state.latency = latencyState || { running: false };
    render();
  });

  api.settings.onChanged((settings) => {
    state.settings = settings;
    applyTheme();
    actions.reloadServers();
  });

  api.speed.onProgress((progress) => {
    state.speed = { ...state.speed, running: true, progress };
    render();
  });

  api.speed.onResult((result) => {
    state.speed = { running: false, progress: null, result };
    if (result && result.ok) toast(`Speed test finished: ${result.mbps} Mbps.`, 'ok');
    else if (result && !result.cancelled) toast(result.error || 'Speed test failed.', 'error');
    render();
  });

  api.core.onStatus((payload) => {
    if (payload && payload.status) state.core = payload.status;
    render();
  });

  api.logs.onLine((line) => {
    state.logs.push(line);
    if (state.logs.length > 300) state.logs.shift();
    if (state.view === 'connection') render();
  });
}

/* ---------------------------------------------------------- titlebar */

/** Wires the frameless window's traffic-light controls. */
function wireTitlebar() {
  const titlebar = document.getElementById('titlebar');
  if (!titlebar || !api.win) return;

  titlebar.addEventListener('click', (event) => {
    const button = event.target.closest ? event.target.closest('[data-win]') : null;
    if (!button) return;
    const action = button.dataset.win;
    if (action === 'close') api.win.close();
    else if (action === 'minimize') api.win.minimize();
    else if (action === 'maximize') api.win.maximizeToggle();
  });

  // Double-clicking the empty part of the titlebar maximizes, as on macOS.
  titlebar.addEventListener('dblclick', (event) => {
    if (event.target.closest && event.target.closest('[data-win]')) return;
    api.win.maximizeToggle();
  });

  api.win.onMaximized((payload) => {
    const button = titlebar.querySelector('[data-win="maximize"]');
    if (!button) return;
    const maximized = Boolean(payload && payload.maximized);
    button.setAttribute('aria-pressed', String(maximized));
    button.title = maximized ? 'Restore' : 'Maximize';
    button.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
  });
}

/* ------------------------------------------------------------- bootstrap */

async function init() {
  wireTitlebar();

  // Flush a render that was deferred while a field had focus (see doRender).
  document.addEventListener('focusout', () => {
    if (!pendingRender) return;
    pendingRender = false;
    setTimeout(render, 0);
  });
  for (const node of document.querySelectorAll('.nav-item, .bottom-item')) {
    node.addEventListener('click', () => navigate(node.dataset.view));
  }

  const [settings, connection, appInfo, events, core, logs] = await Promise.all([
    api.settings.get(),
    api.connection.status(),
    api.app.info(),
    api.connection.events(),
    api.core.status(),
    api.logs.recent(120),
  ]);

  if (settings.ok) state.settings = unwrap(settings, 'settings');
  if (connection.ok) state.connection = unwrap(connection);
  if (appInfo.ok) state.appInfo = unwrap(appInfo);
  if (events.ok) state.events = unwrap(events, 'events') || [];
  if (core.ok) state.core = unwrap(core);
  if (logs.ok) state.logs = unwrap(logs, 'logs') || [];

  applyTheme();
  updateSidebarStatus();
  wireEvents();

  await actions.reloadServers();

  const cache = await api.servers.getSelected();
  if (cache.ok) state.selectedId = cache.selectedId;

  navigate('overview');

  // Auto-refresh on startup is handled by the main process; surface progress.
  if (state.servers.meta && state.servers.meta.stats && state.servers.meta.stats.kept > 0) {
    // Cached list already visible; background refresh will update it.
  } else if (!state.fetching) {
    actions.refreshConfigs();
  }

  // Periodic uptime pill refresh while connected.
  setInterval(() => {
    if (state.connection && state.connection.state === 'connected' && state.view === 'overview') {
      render();
    }
  }, 1000);
}

init().catch((err) => {
  console.error('init failed', err);
  toast('Northstar failed to initialise. Check the diagnostics view.', 'error');
});
