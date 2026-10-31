/**
 * Overview dashboard: connection status, real metrics, activity chart,
 * quick actions and the recent event feed.
 */

import {
  el,
  fmtLatency,
  fmtRate,
  fmtBytes,
  fmtClock,
  fmtDuration,
  protocolBadge,
  stateBlock,
} from '../ui.js';
import { createChart } from '../components/chart.js';

const STATE_LABELS = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  error: 'Connection failed',
};

let chart = null;
let lastSpeedCheckbox = null;

export function renderOverview(container, ctx) {
  const { state, api, actions } = ctx;
  const conn = state.connection;
  const status = conn ? conn.state : 'disconnected';
  const selected = selectedServer(state);
  const settings = state.settings || {};

  container.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Overview' }),
        el('p', {
          text: 'Local proxy status, measured latency and real throughput.',
        }),
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'btn',
          text: 'Choose server',
          onclick: () => actions.navigate('servers'),
        }),
        el('button', {
          class: 'btn primary',
          disabled: state.fetching,
          onclick: () => actions.refreshConfigs(),
        }, state.fetching ? [el('span', { class: 'spinner' }), 'Refreshing…'] : ['Refresh configurations']),
      ]),
    ]),

    /* ---------------------------------------------------------- hero */
    el('section', { class: 'card' }, [
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-left' }, [
          el('div', { class: 'hero-status' }, [
            el('span', {
              class: 'status-dot',
              dataset: { state: status },
              'aria-hidden': 'true',
            }),
            el('h2', { text: STATE_LABELS[status] || status }),
            status === 'error' && conn && conn.error
              ? el('span', { class: 'pill err', text: 'see diagnostics' })
              : null,
          ]),
          el('p', { class: 'hero-server' }, selected
            ? [
                'Selected: ',
                el('strong', { text: `${selected.flag ? `${selected.flag} ` : ''}${selected.label}` }),
                ` · ${selected.protocol.toUpperCase()} · ${selected.country}`,
              ]
            : [el('strong', { text: 'No server selected' }), ' — pick one from the Servers page.']),
          el('div', { class: 'hero-meta' }, [
            selected ? protocolBadge(selected.protocol) : null,
            selected && selected.security && selected.security !== 'none'
              ? el('span', { class: 'pill', text: selected.security.toUpperCase() })
              : null,
            selected && selected.network && selected.network !== 'tcp'
              ? el('span', { class: 'pill', text: selected.network.toUpperCase() })
              : null,
            conn && conn.validation && conn.validation.ok
              ? el('span', {
                  class: 'pill ok',
                  text: `validated · ${conn.validation.ms} ms`,
                })
              : null,
            status === 'connected'
              ? el('span', {
                  class: 'pill accent',
                  text: `up ${fmtDuration(Date.now() - (conn.since || Date.now()))}`,
                })
              : null,
          ].filter(Boolean)),
        ]),
        el('div', { class: 'hero-action' }, [
          el(
            'button',
            {
              class: `connect-btn ${status === 'connected' ? 'is-connected' : ''}`.trim(),
              disabled: status === 'connecting' || status === 'disconnecting',
              onclick: () => actions.toggleConnect(),
            },
            status === 'connected'
              ? 'Disconnect'
              : status === 'connecting'
                ? 'Connecting…'
                : status === 'disconnecting'
                  ? 'Disconnecting…'
                  : 'Connect'
          ),
          el('span', {
            class: 'connect-hint',
            text:
              status === 'connected'
                ? [`Local proxy on 127.0.0.1:${conn.socksPort} (SOCKS) / ${conn.httpPort} (HTTP)`]
                    .concat(modeLabel(conn) || [])
                    .join(' · ')
                : 'Local proxy mode — no system-wide routing is changed',
          }),
        ]),
      ]),
      status === 'error' && conn && conn.error
        ? el('div', { class: 'note warn', style: { marginTop: '14px' }, text: conn.error })
        : null,
    ]),

    /* -------------------------------------------------------- metrics */
    el('div', { class: 'grid grid-4', style: { marginBottom: '16px' } }, [
      latencyMetric(state),
      rateMetric('Download', conn && conn.throughput ? conn.throughput.down : null, conn),
      rateMetric('Upload', conn && conn.throughput ? conn.throughput.up : null, conn),
      sessionMetric(conn),
    ]),

    /* ---------------------------------------------------------- chart */
    el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Network activity' }),
        el('span', {
          class: 'pill',
          text: conn && conn.throughput && conn.throughput.available
            ? 'measured by core stats API'
            : 'unavailable',
        }),
      ]),
      el('p', { class: 'card-sub', text: 'Throughput sampled from the running proxy core every 2 seconds.' }),
      chartRoot(conn),
    ]),

    /* --------------------------------------------------- speed + feed */
    el('div', { class: 'grid grid-2' }, [
      speedCard(ctx),
      el('section', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Recent activity' }),
          el('button', {
            class: 'btn ghost small',
            text: 'All diagnostics',
            onclick: () => actions.navigate('connection'),
          }),
        ]),
        feedList(state),
      ]),
    ])
  );

  if (chart) chart.draw(conn && conn.session ? conn.session.samples : []);
}

function selectedServer(state) {
  if (!state.servers.rows) return null;
  return state.servers.rows.find((r) => r.selected) || null;
}

function chartRoot(conn) {
  if (!chart) chart = createChart();
  return chart.root;
}

function latencyMetric(state) {
  const selected = selectedServer(state);
  let text = '—';
  let sub = selected ? 'not measured yet' : 'no server selected';
  let cls = 'unavailable';

  if (selected) {
    if (selected.latencyOk === true && Number.isFinite(selected.latency)) {
      text = String(selected.latency);
      sub = `${latencyKindLabel(selected.latencyKind)} · ${selected.latencyKind || 'tcp'}`;
      cls = '';
    } else if (selected.latencyOk === false) {
      text = 'Unavailable';
      sub = 'last check failed';
      cls = 'unavailable';
    }
  }

  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: 'Latency' }),
    el('div', { class: `metric-value ${cls}`.trim() }, [
      el('span', { text }),
      cls === '' ? el('small', { text: 'ms' }) : null,
    ].filter(Boolean)),
    el('div', { class: 'metric-sub', text: sub }),
  ]);
}

function latencyKindLabel(kind) {
  const map = {
    tcp: 'TCP connect time',
    proxy: 'SOCKS handshake via local proxy',
    e2e: 'end-to-end via local proxy',
  };
  return map[kind] || 'TCP connect time';
}

function rateMetric(label, bps, conn) {
  const available = conn && conn.throughput && conn.throughput.available;
  const rate = fmtRate(bps);
  const showUnavailable = !available || !rate;
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: label }),
    el('div', { class: `metric-value ${showUnavailable ? 'unavailable' : ''}`.trim() }, [
      el('span', { text: showUnavailable ? '—' : rate.value }),
      showUnavailable ? null : el('small', { text: rate.unit }),
    ].filter(Boolean)),
    el('div', {
      class: 'metric-sub',
      text: showUnavailable
        ? available
          ? 'no samples'
          : conn && conn.state === 'connected'
            ? 'stats API unavailable'
            : 'connect to measure'
        : 'bits per second, sampled live',
    }),
  ]);
}

function sessionMetric(conn) {
  const down = fmtBytes(conn && conn.session ? conn.session.down : 0);
  const up = fmtBytes(conn && conn.session ? conn.session.up : 0);
  const has = conn && conn.session && (conn.session.down > 0 || conn.session.up > 0);
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: 'Session data' }),
    el('div', { class: `metric-value ${has ? '' : 'unavailable'}`.trim() }, [
      el('span', { text: has && down ? `↓${down.value} ` : '—' }),
      has && down ? el('small', { text: down.unit }) : null,
      has && up ? el('span', { text: ` ↑${up.value} ` }) : null,
      has && up ? el('small', { text: up.unit }) : null,
    ].filter(Boolean)),
    el('div', { class: 'metric-sub', text: has ? 'transferred since connect' : 'no transfer measured yet' }),
  ]);
}

function speedCard(ctx) {
  const { state, actions } = ctx;
  const speed = state.speed || {};
  const connected = state.connection && state.connection.state === 'connected';
  const running = Boolean(speed.running);
  const progress = speed.progress;
  const result = speed.result;

  const progressPct =
    running && progress && progress.bytes
      ? Math.min(100, Math.round((progress.bytes / (15 * 1024 * 1024)) * 100))
      : 0;

  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: 'Speed test' }),
      el('span', { class: 'pill', text: running ? 'running…' : 'idle' }),
    ]),
    el('p', {
      class: 'card-sub',
      text: 'Measures real transferred bytes against speed.cloudflare.com. Nothing runs in the background.',
    }),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn primary small',
        disabled: running,
        text: 'Download test',
        onclick: () => actions.startSpeed('download'),
      }),
      el('button', {
        class: 'btn small',
        disabled: running,
        text: 'Upload test',
        onclick: () => actions.startSpeed('upload'),
      }),
      running
        ? el('button', {
            class: 'btn danger small',
            text: 'Cancel',
            onclick: () => actions.cancelSpeed(),
          })
        : null,
      el('label', { class: 'switch', style: { marginLeft: 'auto' } }, [
        el('input', {
          type: 'checkbox',
          checked: connected && state.speedViaProxy !== false,
          disabled: !connected,
          onchange: (e) => actions.setSpeedViaProxy(e.target.checked),
        }),
        el('span', { class: 'track' }),
        el('span', { class: 'switch-text', text: 'Use proxy' }),
      ]),
    ].filter(Boolean)),
    running
      ? el('div', { class: 'progress-line' }, [
          el('div', { style: { width: `${progressPct}%` } }),
        ])
      : null,
    running && progress
      ? el('p', {
          class: 'card-sub',
          style: { marginTop: '10px', marginBottom: 0 },
          text: `${fmtBytes(progress.bytes) ? `${fmtBytes(progress.bytes).value} ${fmtBytes(progress.bytes).unit}` : '0 B'} in ${fmtDuration(
            progress.elapsedMs
          )}${progress.mbps ? ` · ${progress.mbps} Mbps` : ''}`,
        })
      : null,
    result
      ? el('div', {
          class: `note ${result.ok ? '' : 'warn'}`.trim(),
          style: { marginTop: '12px' },
          text: result.ok
            ? `${result.direction === 'download' ? 'Download' : 'Upload'}: ${result.mbps} Mbps from ${fmtBytes(result.bytes)?.value} ${fmtBytes(result.bytes)?.unit} in ${fmtDuration(
                result.elapsedMs
              )} · ${result.viaProxy ? 'through local proxy' : 'direct connection'} · ${result.endpoint} — ${result.note}`
            : `${result.error || 'Test failed.'}${result.code ? ` (${result.code})` : ''}`,
        })
      : null,
    !connected && !running
      ? el('p', {
          class: 'card-sub',
          style: { marginTop: '10px', marginBottom: 0 },
          text: 'Not connected — the test will run directly, without the proxy.',
        })
      : null,
  ]);
}

/** Optional routing modes active on a connected session, for the hero hint. */
function modeLabel(conn) {
  const tun = conn.tun && conn.tun.active;
  const sys = conn.systemProxy && conn.systemProxy.active;
  if (tun && sys) return ['TUN (system-wide)', 'system proxy active'];
  if (tun) return ['TUN (system-wide routing)'];
  if (sys) return ['system proxy active'];
  return null;
}

function feedList(state) {
  const events = state.events || [];
  if (!events.length) {
    return stateBlock({
      icon: '◎',
      title: 'No activity yet',
      message: 'Connection attempts, validations and errors will appear here.',
    });
  }
  const list = el('ul', { class: 'feed', role: 'list' });
  for (const event of events.slice(0, 10)) {
    list.appendChild(
      el('li', { class: event.kind === 'ok' ? 'ok' : event.kind === 'error' ? 'error' : event.kind === 'warn' ? 'warn' : '' }, [
        el('time', { datetime: new Date(event.ts).toISOString(), text: fmtClock(event.ts) }),
        el('span', { class: 'feed-msg', text: event.message }),
      ])
    );
  }
  return list;
}

export function resetOverviewCache() {
  chart = null;
  lastSpeedCheckbox = null;
}