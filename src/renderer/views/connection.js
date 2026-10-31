/**
 * Connection view: lifecycle status, local proxy usage instructions,
 * core information, throughput and the redacted diagnostics console.
 */

import {
  el,
  fmtClock,
  fmtDuration,
  fmtBytes,
  fmtRate,
  kvList,
  stateBlock,
  toast,
} from '../ui.js';

const STATE_LABELS = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  error: 'Connection failed',
};

const TROUBLESHOOTING = [
  ['Core not found', 'Install Xray/V2Ray and set its path in Settings → Connection, or place xray(.exe) in the app’s core folder.'],
  ['Port already in use', 'Another program holds your local port. Change the SOCKS/HTTP ports in Settings → Connection.'],
  ['Validation failed', 'The server may be offline, blocked, or the configuration invalid. Try another server or a different validation type.'],
  ['DNS failures', 'Check your internet connection; the proxy resolves DNS through the core when connected.'],
  ['Core exits immediately', 'Open Diagnostics below — the core’s redacted error output explains most startup failures.'],
];

export function renderConnection(container, ctx) {
  const { state, actions } = ctx;
  const conn = state.connection;
  const status = conn ? conn.state : 'disconnected';
  const core = state.core;
  const settings = state.settings || {};

  container.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Connection' }),
        el('p', { text: 'Lifecycle, local proxy endpoints, core status and diagnostics.' }),
      ]),
      el('div', { class: 'page-actions' }, [
        status === 'connected'
          ? el('button', { class: 'btn danger', text: 'Disconnect', onclick: () => actions.disconnect() })
          : el('button', {
              class: 'btn primary',
              disabled: status === 'connecting' || status === 'disconnecting',
              text: status === 'connecting' ? 'Connecting…' : 'Connect',
              onclick: () => actions.toggleConnect(),
            }),
      ]),
    ]),

    /* ------------------------------------------------------ status */
    el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Status' }),
        el('span', { class: `pill ${status === 'connected' ? 'ok' : status === 'error' ? 'err' : ''}`.trim(), text: STATE_LABELS[status] || status }),
      ]),
      conn && conn.server
        ? el('div', { class: 'hero-server', style: { marginBottom: '12px' } }, [
            el('strong', { text: `${conn.server.flag ? `${conn.server.flag} ` : ''}${conn.server.label}` }),
            ` · ${conn.server.protocol.toUpperCase()} · ${conn.server.country} · ${conn.server.security}`,
          ])
        : el('p', { class: 'card-sub', text: 'No server selected.' }),
      kvList([
        ['Mode', modeSummary(conn)],
        ['SOCKS5', `127.0.0.1:${conn ? conn.socksPort : settings.socksPort}`],
        ['HTTP', `127.0.0.1:${conn ? conn.httpPort : settings.httpPort}`],
        ['Connected since', conn && conn.since ? `${fmtClock(conn.since)} (${fmtDuration(Date.now() - conn.since)} ago)` : '—'],
        ['Validation', conn && conn.validation
          ? conn.validation.ok
            ? `passed · ${conn.validation.kind} · ${conn.validation.ms} ms`
            : `failed · ${conn.validation.kind} · ${conn.validation.code || 'unknown'}`
          : settings.validateOnConnect
            ? `enabled (${settings.validationType})`
            : 'disabled in settings'],
        ['Core', core && core.corePath ? `${core.corePath} (${core.coreSource || 'unknown source'})` : 'not found'],
        ['Core version', core && core.coreVersion ? core.coreVersion : '—'],
      ]),
      status === 'error' && conn && conn.error
        ? el('div', { class: 'note warn', style: { marginTop: '12px' }, text: conn.error })
        : null,
      status === 'connected'
        ? el('div', { class: 'note', style: { marginTop: '12px' } }, [
            el('strong', { text: 'What is protected: ' }),
            protectionText(conn),
          ])
        : null,
    ]),

    /* ------------------------------------------------ local proxy */
    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card' }, [
        el('h2', { text: 'Use the local proxy' }),
        el('p', { class: 'card-sub', text: 'Point your applications at these endpoints while connected.' }),
        codeLine(`127.0.0.1:${conn ? conn.socksPort : settings.socksPort}`, 'SOCKS5', actions),
        codeLine(`127.0.0.1:${conn ? conn.httpPort : settings.httpPort}`, 'HTTP', actions),
        el('div', { class: 'note plain', style: { marginTop: '10px' } }, [
          el('strong', { text: 'System-wide routing: ' }),
          routingText(conn),
        ]),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Proxy core' }),
          core && core.state === 'running'
            ? el('span', { class: 'pill ok', text: 'running' })
            : el('span', { class: 'pill', text: core ? core.state : 'unknown' }),
        ]),
        kvList([
          ['Path', core && core.corePath ? core.corePath : 'not found'],
          ['Source', core && core.coreSource ? core.coreSource : '—'],
          ['Version', core && core.coreVersion ? core.coreVersion : '—'],
          ['Last error', core && core.lastError ? core.lastError : '—'],
        ]),
        el('div', { class: 'btn-row', style: { marginTop: '12px' } }, [
          el('button', { class: 'btn small', text: 'Locate core', onclick: () => actions.locateCore() }),
          el('button', {
            class: 'btn small',
            text: 'Set path…',
            onclick: () => actions.navigate('settings'),
          }),
        ]),
        !core || !core.corePath
          ? el('div', { class: 'note warn', style: { marginTop: '12px' } }, [
              el('strong', { text: 'No core installed. ' }),
              'Download an Xray-core release for Windows, then set its path in Settings → Connection. Northstar does not bundle a binary it has not verified.',
            ])
          : null,
      ]),
    ]),

    /* ------------------------------------------------ throughput */
    el('div', { class: 'grid grid-3', style: { marginBottom: '16px' } }, [
      metric('Download', conn && conn.throughput ? fmtRate(conn.throughput.down) : null, conn),
      metric('Upload', conn && conn.throughput ? fmtRate(conn.throughput.up) : null, conn),
      sessionMetric(conn),
    ]),

    /* ---------------------------------------------- diagnostics */
    el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Diagnostics' }),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn small', text: 'Refresh', onclick: () => actions.reloadLogs() }),
          el('button', { class: 'btn small', text: 'Export redacted…', onclick: () => actions.exportLogs() }),
        ]),
      ]),
      el('p', { class: 'card-sub', text: 'Redacted application log — credentials and configuration URIs are removed.' }),
      logConsole(state),
    ]),

    /* ------------------------------------------ troubleshooting */
    el('section', { class: 'card' }, [
      el('h2', { text: 'Troubleshooting' }),
      el('p', { class: 'card-sub', text: 'Common failures and what to do about them.' }),
      el('div', {}, TROUBLESHOOTING.map(([title, body]) =>
        el('div', { class: 'setting-row' }, [
          el('div', { class: 'setting-info' }, [
            el('strong', { text: title }),
            el('span', { text: body }),
          ]),
        ])
      )),
    ])
  );
}

function metric(label, rate, conn) {
  const available = conn && conn.throughput && conn.throughput.available;
  const show = available && rate;
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: label }),
    el('div', { class: `metric-value ${show ? '' : 'unavailable'}`.trim() }, [
      el('span', { text: show ? rate.value : '—' }),
      show ? el('small', { text: rate.unit }) : null,
    ].filter(Boolean)),
    el('div', { class: 'metric-sub', text: show ? 'live sample' : 'unavailable' }),
  ]);
}

function sessionMetric(conn) {
  const down = fmtBytes(conn && conn.session ? conn.session.down : 0);
  const up = fmtBytes(conn && conn.session ? conn.session.up : 0);
  const has = conn && conn.session && (conn.session.down > 0 || conn.session.up > 0);
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: 'Session total' }),
    el('div', { class: `metric-value ${has ? '' : 'unavailable'}`.trim() }, [
      el('span', { text: has && down ? `↓${down.value} ` : '—' }),
      has && down ? el('small', { text: down.unit }) : null,
      has && up ? el('span', { text: ` ↑${up.value} ` }) : null,
      has && up ? el('small', { text: up.unit }) : null,
    ].filter(Boolean)),
    el('div', { class: 'metric-sub', text: has ? 'measured by core stats' : 'no data' }),
  ]);
}

/** One-line description of the routing mode shown in the status table. */
function modeSummary(conn) {
  const tun = conn && conn.tun && conn.tun.active;
  const sys = conn && conn.systemProxy && conn.systemProxy.active;
  if (tun && sys) return 'TUN (system-wide) + system proxy active';
  if (tun) return 'TUN — device traffic routed system-wide';
  if (sys) return 'System proxy active — applications following the system proxy';
  return 'Local proxy (application-level) — no system-wide routing';
}

/** What the current mode actually protects, stated honestly. */
function protectionText(conn) {
  const sys = conn && conn.systemProxy && conn.systemProxy.active;
  const tun = conn && conn.tun && conn.tun.active;
  if (tun) {
    return 'device traffic is routed into the TUN interface and out through the selected server; the previous routing is restored when you disconnect.';
  }
  if (sys) {
    return 'traffic from applications that follow the Windows proxy settings, plus anything sent to 127.0.0.1 proxies, reaches the internet through the selected server. Your previous proxy settings are restored on disconnect.';
  }
  return 'traffic explicitly configured to use 127.0.0.1 proxies reaches the internet through the selected server. Enable the system proxy or TUN mode in Settings to route more traffic.';
}

/** Explains system-wide routing status for the local proxy card. */
function routingText(conn) {
  const tun = conn && conn.tun && conn.tun.active;
  const sys = conn && conn.systemProxy && conn.systemProxy.active;
  if (tun) {
    return 'active through the TUN interface and system routes created by the proxy core while connected.';
  }
  if (sys) {
    return 'partial — the Windows per-user proxy points at Northstar while connected; applications must honour the system proxy.';
  }
  return 'not configured. Enable “System proxy” or “TUN mode” in Settings; TUN needs Northstar running as administrator, and nothing is enabled silently.';
}

function codeLine(value, label, actions) {
  return el('div', { class: 'code-block' }, [
    el('span', { text: `${label}  ${value}` }),
    el('button', {
      class: 'btn ghost small',
      text: 'Copy',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast(`Copied ${label} address.`, 'ok');
        } catch {
          toast('Clipboard unavailable — copy manually.', 'warn');
        }
      },
    }),
  ]);
}

function logConsole(state) {
  const logs = state.logs || [];
  if (!logs.length) {
    return stateBlock({
      icon: '☰',
      title: 'No log entries',
      message: 'Application events will appear here once you interact with the app.',
    });
  }
  const box = el('div', { class: 'log-console', role: 'log', 'aria-live': 'off' });
  for (const line of logs.slice(-120)) {
    box.appendChild(
      el('div', { class: `log-line ${line.level}`.trim() }, [
        el('span', { class: 'log-ts', text: fmtClock(line.ts) }),
        el('span', { text: line.message }),
      ])
    );
  }
  // Keep the newest lines visible.
  requestAnimationFrame(() => {
    box.scrollTop = box.scrollHeight;
  });
  return box;
}