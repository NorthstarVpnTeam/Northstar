/**
 * Server browser: search, filters, sorting, country groups, per-server
 * ping/select/details/copy actions and honest loading/error/empty states.
 *
 * Reordering is deferred while the user is interacting with the list
 * (hover/focus) so rows never move under the pointer.
 */

import {
  el,
  mount,
  fmtLatency,
  fmtRelative,
  protocolBadge,
  stateBlock,
  toast,
  openModal,
  kvList,
  flagIcon,
  icon,
} from '../ui.js';

const ICONS = {
  search: 'M10 4a6 6 0 104.9 9.5l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z',
  bolt: 'M13.2 2 4 13.6h5.6L10.4 22 20 10.4h-5.6L13.2 2z',
  check: 'M9.6 17.2 4.4 12l-1.5 1.5 6.7 6.7 12-12-1.5-1.5-10.5 10.5z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
  chevron: 'M9 6l6 6-6 6',
  target: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1a7 7 0 0 0-5.9-5.9V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2z',
};

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
  const totalMeasured = groups.reduce((sum, g) => sum + (g.measured || 0), 0);
  const totalServers = meta && meta.stats ? meta.stats.kept : totalVisible;
  const hasAny = totalServers > 0 || totalVisible > 0;
  const allOpen = groups.length > 0 && groups.every((g) => ui.expanded.has(g.name));

  mount(container, 
    el('div', { class: 'page-head' }, [
      el('div', { class: 'page-head-text' }, [
        el('h1', { text: 'Servers' }),
        el('p', {
          text: hasAny
            ? `${totalServers} configurations from ${groups.length} countr${groups.length === 1 ? 'y' : 'ies'} · grouped by country, latency measured — never simulated.`
            : 'Configurations are grouped by country. Latency is measured, never simulated.',
        }),
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'btn',
          disabled: fetching || !hasAny || pinging,
          onclick: () => actions.pingAll(),
        }, [icon(ICONS.bolt, { size: 15 }), 'Ping all']),
        pinging
          ? el('button', { class: 'btn danger', text: 'Stop pings', onclick: () => actions.cancelPing() })
          : null,
        el('button', {
          class: 'btn primary',
          disabled: fetching,
          onclick: () => actions.refreshConfigs(),
        }, fetching
          ? [el('span', { class: 'spinner' }), 'Fetching…']
          : [icon('M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z', { size: 15 }), 'Refresh']),
      ].filter(Boolean)),
    ]),

    /* ------------------------------------------------------ overview bar */
    hasAny
      ? el('div', { class: 'summary-bar' }, [
          summaryStat('Countries', String(groups.length), 'grouped by flag'),
          summaryStat('Servers', String(totalVisible), totalVisible === totalServers ? 'in the list' : `of ${totalServers} shown`),
          summaryStat('Measured', `${totalMeasured}`, totalMeasured ? 'reachable checks' : 'not measured yet'),
          meta && meta.fetchedAt
            ? el('span', { class: 'summary-updated', text: `Updated ${fmtRelative(meta.fetchedAt)}` })
            : null,
        ].filter(Boolean))
      : null,

    /* --------------------------------------------------------- toolbar */
    el('div', { class: 'toolbar-card' }, [
      el('div', { class: 'toolbar' }, [
        el('div', { class: 'search' }, [
          icon(ICONS.search, { size: 15 }),
          el('input', {
            class: 'input',
            id: 'server-search',
            type: 'search',
            placeholder: 'Search a server, country or protocol…',
            'aria-label': 'Search servers',
            value: ui.query,
            oninput: (event) => {
              ui.query = event.target.value;
              actions.reloadServers();
            },
          }),
        ]),
        el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by status' }, [
          chip('all', 'All', ui.status, (value) => {
            ui.status = value;
            actions.reloadServers();
          }),
          chip('ok', 'Reachable', ui.status, (value) => {
            ui.status = value;
            actions.reloadServers();
          }),
          chip('untested', 'Untested', ui.status, (value) => {
            ui.status = value;
            actions.reloadServers();
          }),
          chip('failed', 'Unreachable', ui.status, (value) => {
            ui.status = value;
            actions.reloadServers();
          }),
          chip('selected', 'Selected', ui.status, (value) => {
            ui.status = value;
            actions.reloadServers();
          }),
        ]),
      ]),
      el('div', { class: 'toolbar toolbar-secondary' }, [
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
          'aria-label': 'Sort servers',
          onchange: (event) => {
            ui.sort = event.target.value;
            ui.userChoseSort = true;
            actions.reloadServers();
          },
        }, [
          option('latency', 'Sort: fastest first', ui.sort),
          option('name', 'Sort: name', ui.sort),
          option('country', 'Sort: label', ui.sort),
          option('protocol', 'Sort: protocol', ui.sort),
        ]),
        el('label', { class: 'switch switch-compact', title: 'Automatically sort by measured latency' }, [
          el('input', {
            type: 'checkbox',
            checked: Boolean(settings.autoSort),
            onchange: (event) => actions.updateSettings({ autoSort: event.target.checked }),
          }),
          el('span', { class: 'track' }),
          el('span', { class: 'switch-text', text: 'Auto-sort' }),
        ]),
        groups.length
          ? el('button', {
              class: 'btn ghost small toolbar-end',
              text: allOpen ? 'Collapse all' : 'Expand all',
              onclick: () => {
                if (allOpen) ui.expanded.clear();
                else for (const group of groups) ui.expanded.add(group.name);
                actions.rerenderServers();
              },
            })
          : null,
      ].filter(Boolean)),
    ]),

    /* --------------------------------------------------- country rail */
    groups.length > 1 ? countryRail(groups) : null,

    /* ----------------------------------------------------- meta strip */
    meta && meta.stats && meta.stats.received > 0
      ? el('div', { class: 'meta-strip' }, [
          el('span', {}, [el('strong', { text: String(meta.stats.kept) }), ' kept']),
          el('span', {}, [el('strong', { text: String(meta.stats.duplicates) }), ' duplicates removed']),
          el('span', {}, [el('strong', { text: String(meta.stats.rejected) }), ' rejected']),
          meta.stats.unsupported
            ? el('span', {}, [el('strong', { text: String(meta.stats.unsupported) }), ' unsupported scheme'])
            : null,
          el('span', { class: 'meta-right', text: `fetched ${fmtRelative(meta.fetchedAt)}` }),
        ].filter(Boolean))
      : null,

    /* ------------------------------------------------------- progress */
    fetching && state.fetch && state.fetch.phase !== 'done' && state.fetch.phase !== 'error'
      ? el('div', { class: 'card tight progress-card' }, [
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
                  onclick: () => actions.refreshConfigs(),
                }),
              }),
            ])
          : groupList(groups, ctx)
  );
}

function summaryStat(label, value, sub) {
  return el('div', { class: 'summary-stat' }, [
    el('span', { class: 'summary-value', text: value }),
    el('span', { class: 'summary-label', text: label }),
    el('span', { class: 'summary-sub', text: sub }),
  ]);
}

function chip(value, label, current, onSelect) {
  const active = value === current;
  return el('button', {
    class: `chip ${active ? 'is-active' : ''}`.trim(),
    type: 'button',
    'aria-pressed': String(active),
    text: label,
    onclick: () => onSelect(value),
  });
}

function option(value, label, current) {
  return el('option', { value, selected: value === current, text: label });
}

function countrySlug(name) {
  return name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** Instant country jump bar: click a flag to open and scroll to that country. */
function countryRail(groups) {
  const rail = el('div', {
    class: 'country-rail',
    role: 'list',
    'aria-label': 'Jump to a country',
  });
  for (const group of groups) {
    rail.appendChild(
      el(
        'button',
        {
          class: 'rail-chip',
          type: 'button',
          role: 'listitem',
          title: `Open ${group.name}`,
          onclick: () => openCountry(group.name),
        },
        [
          flagIcon(group.code, group.flag, 'rail-flag'),
          el('span', { class: 'rail-name', text: group.name }),
          el('span', { class: 'rail-count', text: String(group.count) }),
        ]
      )
    );
  }
  return rail;
}

/** Opens a country in place — directly in the DOM, with no IPC or re-render. */
function openCountry(name) {
  const section = document.getElementById(`country-${countrySlug(name)}`);
  if (!section) return;
  const header = section.querySelector('.country-header');
  if (header && !section.classList.contains('is-open')) header.click();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function groupList(groups, ctx) {
  const { actions } = ctx;
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
    const initialOpen = ui.expanded.has(group.name);
    const slug = countrySlug(group.name);
    const sectionId = `country-${slug}`;
    const bodyId = `country-body-${slug}`;
    const fastest = fastestLatency(group.servers);

    const body = el('div', {
      class: `country-body ${initialOpen ? 'is-open' : ''}`.trim(),
      id: bodyId,
      role: 'region',
      'aria-label': `${group.name} servers`,
    });
    const inner = el('div', { class: 'country-inner' });
    body.appendChild(inner);

    // Rows are built lazily on first expand, so a closed country costs one
    // header and opening it is a local DOM change — never a page re-render.
    let rendered = false;
    const ensureRows = () => {
      if (rendered) return;
      rendered = true;
      const fragment = document.createDocumentFragment();
      for (const row of group.servers) fragment.appendChild(serverRow(row, ctx));
      inner.appendChild(fragment);
    };
    if (initialOpen) ensureRows();

    const header = el(
      'button',
      {
        class: 'country-header',
        'aria-expanded': String(initialOpen),
        'aria-controls': bodyId,
        onclick: () => {
          const open = !section.classList.contains('is-open');
          if (open) ensureRows();
          section.classList.toggle('is-open', open);
          body.classList.toggle('is-open', open);
          header.setAttribute('aria-expanded', String(open));
          if (open) ui.expanded.add(group.name);
          else ui.expanded.delete(group.name);
        },
      },
      [
        icon(ICONS.chevron, { size: 15, stroke: true, strokeWidth: 2.2 }),
        flagIcon(group.code, group.flag, 'country-flag'),
        el('span', { class: 'country-name', text: group.name }),
        el('span', {
          class: 'country-count',
          text: `${group.count} server${group.count === 1 ? '' : 's'}`,
        }),
        el('span', { class: 'country-spacer' }),
        fastest !== null
          ? el('span', { class: 'country-fastest' }, [
              el('span', { class: 'latency-dot ok', 'aria-hidden': 'true' }),
              `fastest ${fastest} ms`,
            ])
          : el('span', { class: 'country-fastest muted', text: 'not measured' }),
      ]
    );

    const section = el(
      'section',
      { id: sectionId, class: `country-group ${initialOpen ? 'is-open' : ''}`.trim() },
      [header, body]
    );
    wrapper.appendChild(section);
  }
  return wrapper;
}

function allRows(groups) {
  return groups.flatMap((g) => g.servers);
}

function fastestLatency(rows) {
  let best = null;
  for (const row of rows) {
    if (row.latencyOk === true && Number.isFinite(row.latency) && (best === null || row.latency < best)) {
      best = row.latency;
    }
  }
  return best;
}

function serverRow(row, ctx) {
  const { state, actions } = ctx;
  const latency = fmtLatency(row);
  const isSelected = Boolean(row.selected);
  const pinging = ui.pinging.has(row.id);
  const connectedHere =
    state.connection && state.connection.serverId === row.id && state.connection.state === 'connected';

  const statusPill = connectedHere
    ? el('span', { class: 'pill ok row-pill', text: 'in use' })
    : isSelected
      ? el('span', { class: 'pill accent row-pill', text: 'selected' })
      : el('span', { class: 'row-pill', text: '' });

  const select = () => actions.selectServer(row.id);

  return el('div', {
    class: `server-row ${isSelected ? 'is-selected' : ''} ${connectedHere ? 'is-connected' : ''}`.trim(),
    dataset: { id: row.id },
    onclick: (event) => {
      // Row surfaces are clickable; buttons inside keep their own behaviour.
      if (event.target.closest && event.target.closest('button')) return;
      select();
    },
  }, [
    el('button', {
      class: 'server-main',
      type: 'button',
      title: `${row.label} — ${row.host}:${row.port}`,
      'aria-label': `${isSelected ? 'Selected server' : 'Select'} ${row.label}`,
      onclick: select,
    }, [
      flagIcon(row.countryCode, row.flag, 'row-flag'),
      el('span', { class: 'server-lines' }, [
        el('span', { class: 'server-label', text: row.label }),
        el('span', { class: 'server-host', text: `${row.host}:${row.port}` }),
      ]),
    ]),
    protocolBadge(row.protocol),
    el('span', { class: 'server-sec', text: row.security !== 'none' ? row.security : row.network }),
    statusPill,
    el('span', {
      class: `server-latency ${latency.cls}`,
      title: row.latencyKind ? `Measured via ${row.latencyKind}` : 'Not measured',
    }, [
      pinging
        ? el('span', { class: 'spinner small' })
        : el('span', { class: `latency-dot ${latency.cls}`, 'aria-hidden': 'true' }),
      el('span', { text: pinging ? 'testing' : latency.text }),
    ]),
    el('div', { class: 'row-actions' }, [
      actionButton(ICONS.bolt, `Measure latency for ${row.label}`, 'Measure latency', () => {
        ui.pinging.add(row.id);
        actions.rerenderServers();
        actions.pingOne(row.id).finally(() => {
          ui.pinging.delete(row.id);
          actions.rerenderServers();
        });
      }, pinging),
      actionButton(ICONS.target, isSelected ? 'Already selected' : 'Select this server', isSelected ? 'Selected' : 'Select', select),
      actionButton(ICONS.info, `Details for ${row.label}`, 'Details', () => showDetails(row, ctx.api)),
      actionButton(ICONS.copy, `Copy configuration for ${row.label}`, 'Copy configuration', () => actions.copyServer(row.id)),
    ]),
  ]);
}

function actionButton(pathData, ariaLabel, title, onclick, busy = false) {
  return el('button', {
    class: `icon-btn ${busy ? 'busy' : ''}`.trim(),
    type: 'button',
    title,
    'aria-label': ariaLabel,
    onclick,
  }, busy ? [el('span', { class: 'spinner small' })] : [icon(pathData, { size: 15 })]);
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
        class: 'modal-note',
        text: 'Credentials are masked. The full configuration URI is available via Copy configuration.',
      }),
      kvList([
        ['Protocol', d.protocol.toUpperCase()],
        ['Country', `${row.country || 'Unknown'}`],
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
