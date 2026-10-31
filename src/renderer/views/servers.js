/**
 * Server browser: search, filters, sorting, country groups, per-server
 * ping/select/details/copy actions and honest loading/error/empty states.
 *
 * Reordering is deferred while the user is interacting with the list
 * (hover/focus) so rows never move under the pointer.
 */

import {
  el,
  fmtLatency,
  fmtRelative,
  protocolBadge,
  stateBlock,
  toast,
  openModal,
  kvList,
} from '../ui.js';

// View-local UI state that must survive re-renders.
const ui = {
  query: '',
  protocol: 'all',
  status: 'all',
  sort: 'name',
  expanded: new Set(),
  expandedInitialized: false,
  pinging: new Set(),
};

/** Returns the current toolbar filters (used by the action layer). */
export function getFilters() {
  return { query: ui.query, protocol: ui.protocol, status: ui.status, sort: ui.sort };
}

export function resetServersUi() {
  ui.query = '';
  ui.protocol = 'all';
  ui.status = 'all';
  ui.sort = 'name';
  ui.expanded = new Set();
  ui.expandedInitialized = false;
  ui.pinging = new Set();
}

export function renderServers(container, ctx) {
  const { state, api, actions } = ctx;
  const settings = state.settings || {};
  const servers = state.servers || {};
  const fetching = Boolean(state.fetching);
  const pinging = Boolean(state.latency && state.latency.running);
  const meta = servers.meta;

  // Keep the sort control in sync with the persisted auto-sort preference.
  if (settings.autoSort && !ui.userChoseSort) ui.sort = settings.sortBy || 'latency';

  const groups = servers.groups || [];
  const totalVisible = groups.reduce((sum, g) => sum + g.count, 0);
  const hasAny = (meta && meta.stats && meta.stats.kept > 0) || totalVisible > 0;

  container.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Servers' }),
        el('p', {
          text: 'Configurations are grouped by country. Latency is measured, never simulated.',
        }),
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'btn',
          disabled: fetching || !hasAny,
          text: 'Ping all',
          onclick: () => actions.pingAll(),
        }),
        pinging
          ? el('button', { class: 'btn danger', text: 'Stop pings', onclick: () => actions.cancelPing() })
          : null,
        el('button', {
          class: 'btn primary',
          disabled: fetching,
          onclick: () => actions.refreshConfigs(),
        }, fetching ? [el('span', { class: 'spinner' }), 'Fetching…'] : ['Refresh']),
      ].filter(Boolean)),
    ]),

    /* ------------------------------------------------------- toolbar */
    el('div', { class: 'toolbar' }, [
      el('div', { class: 'search' }, [
        el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
          el('path', {
            d: 'M10 4a6 6 0 104.9 9.5l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z',
            fill: 'currentColor',
          }),
        ]),
        el('input', {
          class: 'input',
          id: 'server-search',
          type: 'search',
          placeholder: 'Search country, label or protocol…',
          'aria-label': 'Search servers',
          value: ui.query,
          oninput: (event) => {
            ui.query = event.target.value;
            actions.reloadServers();
          },
        }),
      ]),
      el('select', {
        class: 'select',
        'aria-label': 'Filter by protocol',
        onchange: (event) => {
          ui.protocol = event.target.value;
          actions.reloadServers();
        },
      }, [
        option('all', 'All protocols', ui.protocol),
        option('vless', 'VLESS', ui.protocol),
        option('vmess', 'VMess', ui.protocol),
        option('trojan', 'Trojan', ui.protocol),
        option('ss', 'Shadowsocks', ui.protocol),
        option('socks', 'SOCKS', ui.protocol),
        option('http', 'HTTP', ui.protocol),
      ]),
      el('select', {
        class: 'select',
        'aria-label': 'Filter by status',
        onchange: (event) => {
          ui.status = event.target.value;
          actions.reloadServers();
        },
      }, [
        option('all', 'Any status', ui.status),
        option('ok', 'Reachable', ui.status),
        option('failed', 'Unreachable', ui.status),
        option('untested', 'Untested', ui.status),
        option('selected', 'Selected only', ui.status),
      ]),
      el('select', {
        class: 'select',
        'aria-label': 'Sort servers',
        onchange: (event) => {
          ui.sort = event.target.value;
          ui.userChoseSort = true;
          actions.reloadServers();
        },
      }, [
        option('latency', 'Sort: latency', ui.sort),
        option('name', 'Sort: name', ui.sort),
        option('country', 'Sort: label', ui.sort),
        option('protocol', 'Sort: protocol', ui.sort),
      ]),
      el('label', { class: 'switch', title: 'Automatically sort by measured latency' }, [
        el('input', {
          type: 'checkbox',
          checked: Boolean(settings.autoSort),
          onchange: (event) => actions.updateSettings({ autoSort: event.target.checked }),
        }),
        el('span', { class: 'track' }),
        el('span', { class: 'switch-text', text: 'Auto-sort' }),
      ]),
    ]),

    /* ---------------------------------------------------- meta strip */
    meta && meta.stats && meta.stats.received > 0
      ? el('div', { class: 'meta-strip' }, [
          el('span', {}, [el('strong', { text: String(meta.stats.kept) }), ' servers kept']),
          el('span', {}, [el('strong', { text: String(meta.stats.duplicates) }), ' duplicates removed']),
          el('span', {}, [el('strong', { text: String(meta.stats.rejected) }), ' rejected']),
          meta.stats.unsupported
            ? el('span', {}, [el('strong', { text: String(meta.stats.unsupported) }), ' unsupported scheme'])
            : null,
          el('span', { text: `fetched ${fmtRelative(meta.fetchedAt)}` }),
        ].filter(Boolean))
      : null,

    /* ------------------------------------------------------ progress */
    fetching && state.fetch && state.fetch.phase !== 'done' && state.fetch.phase !== 'error'
      ? el('div', { class: 'card tight' }, [
          el('div', { class: 'btn-row' }, [
            el('span', { class: 'spinner' }),
            el('span', {
              text:
                state.fetch.phase === 'start'
                  ? 'Contacting the configuration source…'
                  : state.fetch.phase === 'connecting'
                    ? 'Connecting…'
                    : `Downloading… ${state.fetch.loaded ? `${Math.round(state.fetch.loaded / 1024)} KB` : ''}`,
            }),
          ]),
        ])
      : null,
    state.fetch && state.fetch.phase === 'error'
      ? el('div', { class: 'note warn' }, [
          el('strong', { text: 'Refresh failed. ' }),
          el('span', { text: state.fetch.message || 'Unknown error.' }),
        ])
      : null,

    /* ------------------------------------------------------- list */
    fetching && !hasAny
      ? el('div', { class: 'card' }, [
          stateBlock({
            icon: '⌛',
            title: 'Fetching servers',
            message: 'Downloading and parsing the configuration list. This takes a few seconds.',
          }),
        ])
      : hasAny && totalVisible === 0
        ? el('div', { class: 'card' }, [
            stateBlock({
              icon: '🔍',
              title: 'No servers match',
              message: 'Try different search terms or clear the active filters.',
              action: el('button', {
                class: 'btn',
                text: 'Clear filters',
                onclick: () => {
                  ui.query = '';
                  ui.protocol = 'all';
                  ui.status = 'all';
                  actions.reloadServers();
                },
              }),
            }),
          ])
        : !hasAny
          ? el('div', { class: 'card' }, [
              stateBlock({
                icon: '✦',
                title: state.fetch && state.fetch.phase === 'error' ? 'Could not fetch servers' : 'No servers yet',
                message:
                  state.fetch && state.fetch.phase === 'error'
                    ? state.fetch.message
                    : 'Northstar downloads its public configuration list automatically — nothing to set up.',
                error: Boolean(state.fetch && state.fetch.phase === 'error'),
                action: el('button', {
                  class: 'btn primary',
                  text: 'Fetch configurations',
                  onclick: () => actions.reloadServers() || actions.refreshConfigs(),
                }),
              }),
            ])
          : groupList(groups, ctx)
  );
}

function option(value, label, current) {
  return el('option', { value, selected: value === current, text: label });
}

function groupList(groups, ctx) {
  const { state, actions } = ctx;
  const wrapper = el('div', {
    id: 'server-list',
    onpointerenter: () => actions.setInteracting(true),
    onpointerleave: () => actions.setInteracting(false),
    onfocusin: () => actions.setInteracting(true),
    onfocusout: () => actions.setInteracting(false),
  });

  // Expand the selected server's country the first time the list renders.
  if (!ui.expandedInitialized) {
    ui.expandedInitialized = true;
    const selected = allRows(groups).find((r) => r.selected);
    if (selected) ui.expanded.add(selected.country);
  }

  if (!groups.length) {
    wrapper.appendChild(
      el('div', { class: 'card' }, [
        stateBlock({
          icon: '🗺',
          title: 'No countries to show',
          message: 'No servers are visible with the current filters.',
        }),
      ])
    );
    return wrapper;
  }

  for (const group of groups) {
    const open = ui.expanded.has(group.name);
    const bodyId = `country-${group.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

    const header = el(
      'button',
      {
        class: 'country-header',
        'aria-expanded': String(open),
        'aria-controls': bodyId,
        onclick: () => {
          if (ui.expanded.has(group.name)) ui.expanded.delete(group.name);
          else ui.expanded.add(group.name);
          actions.rerenderServers();
        },
      },
      [
        el('svg', { class: 'chevron', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
          el('path', { d: 'M9 6l6 6-6 6', stroke: 'currentColor', 'stroke-width': '2.2', fill: 'none', 'stroke-linecap': 'round' }),
        ]),
        el('span', { class: 'country-flag', text: group.flag || '🌐', 'aria-hidden': 'true' }),
        el('span', { class: 'country-name', text: group.name }),
        el('span', { class: 'country-count', text: `${group.count} server${group.count === 1 ? '' : 's'}` }),
        el('span', {
          class: 'country-measured',
          text: group.measured > 0 ? `${group.measured} measured` : 'untested',
        }),
      ]
    );

    const inner = el('div', { class: 'country-inner' });
    for (const row of group.servers) inner.appendChild(serverRow(row, ctx));

    wrapper.appendChild(
      el('section', { class: 'country-group' }, [
        header,
        el(
          'div',
          {
            class: `country-body ${open ? 'is-open' : ''}`.trim(),
            id: bodyId,
            role: 'region',
            'aria-label': `${group.name} servers`,
          },
          [inner]
        ),
      ])
    );
  }
  return wrapper;
}

function allRows(groups) {
  return groups.flatMap((g) => g.servers);
}

function serverRow(row, ctx) {
  const { state, api, actions } = ctx;
  const latency = fmtLatency(row);
  const isSelected = Boolean(row.selected);
  const pinging = ui.pinging.has(row.id);
  const connectedHere =
    state.connection && state.connection.serverId === row.id && state.connection.state === 'connected';

  const statusPill = connectedHere
    ? el('span', { class: 'pill ok', text: 'in use' })
    : isSelected
      ? el('span', { class: 'pill accent', text: 'selected' })
      : null;

  return el('div', {
    class: `server-row ${isSelected ? 'is-selected' : ''}`.trim(),
    dataset: { id: row.id },
  }, [
    el('span', { class: 'server-name', title: `${row.label} — ${row.country}` }, [
      row.flag ? el('span', { class: 'row-flag', text: row.flag, 'aria-hidden': 'true' }) : null,
      document.createTextNode(row.label),
    ]),
    protocolBadge(row.protocol),
    el('span', { class: 'server-sec', text: `${row.security !== 'none' ? row.security : row.network}` }),
    statusPill,
    el('span', {
      class: `server-latency ${latency.cls}`,
      text: pinging ? '…' : latency.text,
      title: row.latencyKind ? `Measured via ${row.latencyKind}` : 'Not measured',
    }),
    el('div', { class: 'row-actions' }, [
      el('button', {
        class: `icon-btn ${pinging ? 'busy' : ''}`.trim(),
        title: 'Measure latency',
        'aria-label': `Measure latency for ${row.label}`,
        onclick: () => {
          ui.pinging.add(row.id);
          actions.rerenderServers();
          actions.pingOne(row.id).finally(() => {
            ui.pinging.delete(row.id);
            actions.rerenderServers();
          });
        },
      }, [el('span', { class: pinging ? 'spinner' : '', text: pinging ? '' : '⚡' })]),
      el('button', {
        class: 'icon-btn',
        title: isSelected ? 'Already selected' : 'Select this server',
        'aria-label': `Select ${row.label}`,
        onclick: () => actions.selectServer(row.id),
      }, [el('span', { text: isSelected ? '✓' : '◎' })]),
      el('button', {
        class: 'icon-btn',
        title: 'Technical details',
        'aria-label': `Details for ${row.label}`,
        onclick: () => showDetails(row, api),
      }, [el('span', { text: 'ⓘ' })]),
      el('button', {
        class: 'icon-btn',
        title: 'Copy configuration URI',
        'aria-label': `Copy configuration for ${row.label}`,
        onclick: () => actions.copyServer(row.id),
      }, [el('span', { text: '⧉' })]),
    ]),
  ]);
}

async function showDetails(row, api) {
  const result = await api.servers.details(row.id);
  if (!result.ok) {
    toast(result.error || 'Could not load details.', 'error');
    return;
  }
  const d = result.details;
  openModal({
    title: `${row.label}`,
    body: [
      el('p', {
        text: 'Credentials are masked. The full configuration URI is available via Copy configuration.',
        style: { marginTop: 0 },
      }),
      kvList([
        ['Protocol', d.protocol.toUpperCase()],
        ['Country', `${row.flag ? `${row.flag} ` : ''}${d.country || 'Unknown'}`],
        ['Endpoint', `${d.host}:${d.port}`],
        ['Security', d.security || 'none'],
        ['Transport', d.transport || 'tcp'],
        ['SNI', d.sni || '—'],
        ['Flow', d.flow || '—'],
        ['Credential', d.credentialMasked || '—'],
        ['Cipher', d.cipher || '—'],
        ['Plugin', d.plugin || '—'],
        ['Latency', row.latencyOk === true ? `${row.latency} ms (${row.latencyKind})` : row.latencyOk === false ? 'Unavailable' : 'Not measured'],
      ]),
    ],
    actions: [
      { label: 'Close', value: 'close' },
      {
        label: 'Copy configuration',
        primary: true,
        value: 'copy',
      },
    ],
    onClose: async (value) => {
      if (value === 'copy') {
        const copy = await api.servers.copy(row.id);
        if (copy.ok) toast(`Copied ${row.label} configuration.`, 'ok');
        else toast(copy.error || 'Copy failed.', 'error');
      }
    },
  });
}