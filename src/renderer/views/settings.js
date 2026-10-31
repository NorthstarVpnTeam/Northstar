/**
 * Settings: server, connection, appearance and data/diagnostics sections.
 * Every control validates in the main process and applies immediately;
 * failures surface as toasts and leave the previous value in place.
 */

import {
  el,
  confirmDialog,
  openModal,
  stateBlock,
  toast,
} from '../ui.js';

export function renderSettings(container, ctx) {
  const { state, actions } = ctx;
  const s = state.settings || {};
  const core = state.core;

  container.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Settings' }),
        el('p', { text: 'Changes apply immediately and persist between launches.' }),
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'btn',
          text: 'Restore defaults',
          onclick: async () => {
            const yes = await confirmDialog({
              title: 'Restore default settings?',
              message: 'All preferences return to their factory values. Cached servers are kept.',
              confirmLabel: 'Restore defaults',
              danger: true,
            });
            if (yes) actions.resetSettings();
          },
        }),
      ]),
    ]),

    /* ============================================== server settings */
    el('section', { class: 'card' }, [
      el('h2', { text: 'Servers' }),
      el('p', { class: 'card-sub', text: 'Background measurements, refresh behaviour and sorting.' }),

      el('div', { class: 'setting-row' }, [
        info('Auto-refresh configurations', 'Re-download the list in the background at the chosen interval.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.autoRefresh),
              onchange: (e) => actions.updateSettings({ autoRefresh: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Refresh interval', 'How often the background refresh runs (15 minutes – 24 hours).'),
        control([
          el('select', {
            class: 'select',
            'aria-label': 'Refresh interval',
            onchange: (e) => actions.updateSettings({ autoRefreshIntervalMin: Number(e.target.value) }),
          }, [
            [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'],
            [360, '6 hours'], [720, '12 hours'], [1440, '24 hours'],
          ].map(([v, label]) => el('option', { value: String(v), selected: Number(s.autoRefreshIntervalMin) === v, text: label }))),
          ]),
        ]),

      el('div', { class: 'setting-row' }, [
        info('Auto-ping', 'Measure latency for all servers in the background. Switches off proxy-based measurements automatically when disconnected. Real delay runs on demand only, because every sample starts a temporary core.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.autoPing),
              onchange: (e) => actions.updateSettings({ autoPing: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),

      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Ping timeout' }),
        el('div', { class: 'range-row' }, [
          el('input', {
            type: 'range',
            min: '500',
            max: '10000',
            step: '250',
            value: String(s.pingTimeoutMs || 4000),
            'aria-label': 'Ping timeout in milliseconds',
            oninput: (e) => {
              const node = document.getElementById('ping-timeout-value');
              if (node) node.textContent = `${e.target.value} ms`;
            },
            onchange: (e) => actions.updateSettings({ pingTimeoutMs: Number(e.target.value) }),
          }),
          el('span', { class: 'range-value', id: 'ping-timeout-value', text: `${s.pingTimeoutMs || 4000} ms` }),
        ]),
        el('span', { class: 'field-hint', text: '500 – 10,000 ms. Longer timeouts reduce false “unreachable” results.' }),
      ]),

      el('div', { class: 'setting-row' }, [
        info('Ping interval', 'Delay between background ping rounds. Avoids excessive traffic.'),
        control([
          el('select', {
            class: 'select',
            'aria-label': 'Ping interval',
            onchange: (e) => actions.updateSettings({ pingIntervalMs: Number(e.target.value) }),
          }, [
            [15000, '15 seconds'], [30000, '30 seconds'], [60000, '1 minute'],
            [120000, '2 minutes'], [300000, '5 minutes'],
          ].map(([v, label]) => el('option', { value: String(v), selected: Number(s.pingIntervalMs) === v, text: label }))),
          ]),
        ]),

      el('div', { class: 'setting-row' }, [
        info('Sort by', 'Ordering applied to the server list when auto-sort is on.'),
        control([
          el('select', {
            class: 'select',
            'aria-label': 'Sort by',
            onchange: (e) => actions.updateSettings({ sortBy: e.target.value }),
          }, [
            ['latency', 'Measured latency'],
            ['name', 'Server name'],
            ['country', 'Country'],
            ['protocol', 'Protocol'],
          ].map(([v, label]) => el('option', { value: v, selected: s.sortBy === v, text: label }))),
          ]),
        ]),

      el('div', { class: 'setting-row' }, [
        info('Hide failed servers', 'Remove servers whose last check failed from the list.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.hideFailed),
              onchange: (e) => actions.updateSettings({ hideFailed: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),
    ]),

    /* ========================================== connection settings */
    el('section', { class: 'card' }, [
      el('h2', { text: 'Connection' }),
      el('p', { class: 'card-sub', text: 'Local proxy ports, validation behaviour and the proxy core.' }),

      el('div', { class: 'grid grid-2' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'setting-socks', text: 'Local SOCKS5 port' }),
          el('input', {
            class: 'input',
            id: 'setting-socks',
            type: 'number',
            min: '1024',
            max: '65535',
            value: String(s.socksPort || 10808),
            onchange: (e) => actions.updateSettings({ socksPort: Number(e.target.value) }),
          }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'setting-http', text: 'Local HTTP port' }),
          el('input', {
            class: 'input',
            id: 'setting-http',
            type: 'number',
            min: '1024',
            max: '65535',
            value: String(s.httpPort || 10809),
            onchange: (e) => actions.updateSettings({ httpPort: Number(e.target.value) }),
          }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-hint', text: 'Both ports must be free and different. Reconnect to apply changes while connected.' }),
      ]),

      el('div', { class: 'setting-row' }, [
        info('Latency measurement', 'What a ping actually tests. TCP connect only proves the port accepts connections; Real delay starts a throwaway core per server and runs a full request through it, so it is slower but proves the config works — even while disconnected.'),
        control([
          el('select', {
            class: 'select',
            'aria-label': 'Latency measurement type',
            onchange: (e) => actions.updateSettings({ measurementType: e.target.value }),
          }, [
            ['tcp', 'TCP connect (direct)'],
            ['proxy', 'SOCKS handshake via local proxy'],
            ['e2e', 'End-to-end HTTP via local proxy'],
            ['delay', 'Real delay (full request per server)'],
          ].map(([v, label]) => el('option', { value: v, selected: s.measurementType === v, text: label }))),
          ]),
        ]),

      el('div', { class: 'setting-row' }, [
        info('Validate on connect', 'Only report Connected after a check through the local proxy succeeds.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.validateOnConnect),
              onchange: (e) => actions.updateSettings({ validateOnConnect: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),

      el('div', { class: 'setting-row' }, [
        info('Validation check', 'The request used to confirm the tunnel works after connecting.'),
        control([
          el('select', {
            class: 'select',
            'aria-label': 'Validation type',
            disabled: !s.validateOnConnect,
            onchange: (e) => actions.updateSettings({ validationType: e.target.value }),
          }, [
            ['e2e', 'HTTP request via proxy (recommended)'],
            ['proxy', 'SOCKS handshake'],
            ['tcp', 'Local listener only'],
          ].map(([v, label]) => el('option', { value: v, selected: s.validationType === v, text: label }))),
          ]),
        ]),

      el('div', { class: 'setting-row' }, [
        info('Connect on launch', 'Reconnect to the last selected server when Northstar starts.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.connectOnLaunch),
              onchange: (e) => actions.updateSettings({ connectOnLaunch: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),

      el('div', { class: 'setting-row' }, [
        info('System proxy', 'Windows only. While connected, point the current user\'s proxy settings at Northstar so apps that follow the system proxy route through the tunnel. Your previous settings are saved first and restored on disconnect — nothing changes while disconnected.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.systemProxy),
              'aria-label': 'System proxy mode',
              onchange: (e) => actions.updateSettings({ systemProxy: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),

      el('div', { class: 'setting-row' }, [
        info('TUN mode', 'Route all device traffic through the tunnel using a TUN interface. Creates a network interface and system routes, so Northstar must run as administrator (Windows) — it never elevates itself. Applied on connect, removed on disconnect.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.tunMode),
              'aria-label': 'TUN mode',
              onchange: (e) => actions.updateSettings({ tunMode: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),

      el('div', { class: 'field' }, [
        el('label', { for: 'setting-core', text: 'Proxy core path (Xray / V2Ray)' }),
        el('div', { class: 'btn-row' }, [
          el('input', {
            class: 'input mono',
            id: 'setting-core',
            style: { flex: '1', minWidth: '200px' },
            placeholder: 'Auto-detect',
            value: s.corePath || '',
            onchange: (e) => actions.updateSettings({ corePath: e.target.value.trim() }),
          }),
          el('button', { class: 'btn small', text: 'Browse…', onclick: () => actions.pickCore() }),
          el('button', {
            class: 'btn small',
            text: 'Auto-detect',
            onclick: () => actions.updateSettings({ corePath: '' }).then(() => actions.locateCore()),
          }),
        ]),
        el('span', {
          class: 'field-hint',
          text: core && core.corePath
            ? `Detected: ${core.corePath}${core.coreVersion ? ` — ${core.coreVersion}` : ''}`
            : 'No core detected yet. The packaged build ships Xray-core; set a path here only to use a different build.',
        }),
      ]),
    ]),

    /* =============================================== appearance */
    el('section', { class: 'card' }, [
      el('h2', { text: 'Appearance' }),
      el('p', { class: 'card-sub', text: 'Theme and interface preferences.' }),
      el('div', { class: 'setting-row' }, [
        info('Theme', 'Light is the default. Dark follows the same restrained palette.'),
        control([
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: `btn small ${s.theme === 'light' ? 'primary' : ''}`.trim(),
              text: 'Light',
              onclick: () => actions.updateSettings({ theme: 'light' }),
            }),
            el('button', {
              class: `btn small ${s.theme === 'dark' ? 'primary' : ''}`.trim(),
              text: 'Dark',
              onclick: () => actions.updateSettings({ theme: 'dark' }),
            }),
          ]),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Reduce motion', 'Disables non-essential animations (overrides the system preference).'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.reduceMotion),
              onchange: (e) => actions.updateSettings({ reduceMotion: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Compact server rows', 'Fit more servers on screen at once.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.compactRows),
              onchange: (e) => actions.updateSettings({ compactRows: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),
    ]),

    /* ======================================== data & diagnostics */
    el('section', { class: 'card' }, [
      el('h2', { text: 'Data & diagnostics' }),
      el('p', { class: 'card-sub', text: 'Cached data, logs and diagnostics export.' }),
      el('div', { class: 'setting-row' }, [
        info('Cached configurations', state.cacheInfo
          ? `${state.cacheInfo.servers} servers cached${state.cacheInfo.exists ? ` · ${(state.cacheInfo.bytes / 1024).toFixed(1)} KB` : ''}`
          : 'No cache information.'),
        control([
          el('button', {
            class: 'btn small',
            text: 'Clear cache',
            onclick: async () => {
              const yes = await confirmDialog({
                title: 'Clear cached configurations?',
                message: 'The downloaded list and selection are removed. Settings are kept; the next refresh re-downloads everything.',
                confirmLabel: 'Clear',
                danger: true,
              });
              if (yes) actions.clearCache();
            },
          }),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Application logs', 'View the redacted event log kept in memory.'),
        control([
          el('button', { class: 'btn small', text: 'View logs', onclick: () => actions.showLogs() }),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Export diagnostics', 'Saves a redacted JSON bundle: statuses, settings and logs — no credentials.'),
        control([
          el('button', { class: 'btn small', text: 'Export…', onclick: () => actions.exportLogs() }),
        ]),
      ]),
      el('div', { class: 'setting-row' }, [
        info('Verbose logging', 'Include debug-level lines (still redacted) in the diagnostics console.'),
        control([
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: Boolean(s.verboseLogging),
              onchange: (e) => actions.updateSettings({ verboseLogging: e.target.checked }),
            }),
            el('span', { class: 'track' }),
          ]),
        ]),
      ]),
    ])
  );
}

function info(title, description) {
  return el('div', { class: 'setting-info' }, [
    el('strong', { text: title }),
    el('span', { text: description }),
  ]);
}

function control(children) {
  return el('div', { class: 'setting-control' }, children);
}
