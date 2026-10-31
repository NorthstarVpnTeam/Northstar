/**
 * About: application identity, third-party components, links, security
 * notes and the honest limitations disclaimer.
 */

import { el, kvList } from '../ui.js';

export function renderAbout(container, ctx) {
  const { state, actions } = ctx;
  const info = state.appInfo || {};
  const core = state.core;

  container.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'About' }),
        el('p', { text: 'Application details, components and limitations.' }),
      ]),
    ]),

    el('section', { class: 'card' }, [
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-left' }, [
          el('div', { class: 'hero-status' }, [
            el('svg', {
              viewBox: '0 0 24 24',
              style: { width: '28px', height: '28px', color: 'var(--accent)' },
              'aria-hidden': 'true',
            }, [
              el('path', {
                d: 'M12 2.5l2.35 6.03 6.45.36-4.92 4.05 1.6 6.26L12 16.14 6.52 19.2l1.6-6.26L3.2 8.89l6.45-.36L12 2.5z',
                fill: 'currentColor',
              }),
            ]),
            el('h2', { text: 'Northstar V2Ray' }),
          ]),
          el('p', {
            class: 'hero-server',
            text: 'A V2Ray-compatible configuration manager and local proxy client for Windows.',
          }),
        ]),
      ]),
      kvList([
        ['Version', info.version || '—'],
        ['Electron', info.electron || '—'],
        ['Chromium', info.chrome || '—'],
        ['Node.js', info.node || '—'],
        ['Platform', info.platform ? `${info.platform} (${info.arch})` : '—'],
        ['Locale', info.locale || '—'],
        ['Proxy core', core && core.coreVersion ? core.coreVersion : 'not installed'],
      ]),
    ]),

    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card' }, [
        el('h2', { text: 'Links' }),
        el('p', { class: 'card-sub', text: 'Opens in your default browser.' }),
        el('div', { class: 'btn-row' }, [
          linkButton(actions, 'https://github.com/shupolol/Northstar', 'GitHub repository'),
          linkButton(actions, 'https://github.com/XTLS/Xray-core', 'Xray-core project'),
        ]),
      ]),
      el('section', { class: 'card' }, [
        el('h2', { text: 'Third-party components' }),
        kvList([
          ['Xray-core', 'MPL-2.0 — bundled with the app (fetched from the official Xray-core releases at build time)'],
          ['Electron', 'MIT license'],
          ['electron-builder', 'MIT license'],
          ['Configuration list', 'public third-party data — see its repository for terms'],
        ]),
      ]),
    ]),

    el('section', { class: 'card' }, [
      el('h2', { text: 'Security & privacy' }),
      el('div', { class: 'note plain' }, [
        el('ul', { style: { margin: '4px 0 4px 18px', padding: 0 } }, [
          li('No telemetry: Northstar makes no analytics or tracking requests.'),
          li('Logs and exported diagnostics are redacted — configuration URIs and credentials never appear.'),
          li('The renderer runs sandboxed with context isolation; it has no filesystem, shell or process access.'),
          li('Proxy configuration files are written to a private temp file and deleted on disconnect.'),
          li('System proxy settings, routes and network adapters are only ever touched by the two explicit, off-by-default modes in Settings — and are reverted when you disconnect.'),
        ]),
      ]),
    ]),

    el('section', { class: 'card' }, [
      el('h2', { text: 'Honest limitations' }),
      el('div', { class: 'note warn' }, [
        el('ul', { style: { margin: '4px 0 4px 18px', padding: 0 } }, [
          li('Public configurations are third-party endpoints. Northstar cannot verify that they are safe, private, trustworthy or even online — test before relying on them.'),
          li('“Connected” means the local proxy listener is up and the chosen validation check passed. It does not mean every application on your machine is protected.'),
          li('System-wide routing is an explicit opt-in: TUN mode needs administrator rights and installs real routes; the system proxy mode only affects apps that honour it.'),
          li('Latency via TCP connect does not prove a proxy works; proxy and end-to-end measurements require an active connection.'),
          li('The bundled proxy core is Xray-core (MPL-2.0), fetched from the official releases at build time — Settings can point at your own binary instead.'),
        ]),
      ]),
    ])
  );
}

function li(text) {
  return el('li', { text, style: { marginBottom: '6px', fontSize: '13px' } });
}

function linkButton(actions, url, label) {
  return el('button', { class: 'btn small', text: label, onclick: () => actions.openExternal(url) });
}
