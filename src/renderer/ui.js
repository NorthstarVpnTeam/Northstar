/**
 * Shared renderer helpers: DOM construction, formatters, toasts, modals.
 *
 * All dynamic text is set through textContent (never innerHTML) so untrusted
 * server labels can never execute markup.
 */

/** Creates a DOM element. Props: class, text, dataset, aria*, on* handlers. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === undefined || children === null) return;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replaceContent(node, children) {
  clear(node);
  appendChildren(node, children);
}

/* ------------------------------------------------------------ formatters */

export function fmtLatency(result) {
  if (!result || result.latencyOk === null || result.latencyOk === undefined) {
    return { text: '—', cls: 'untested' };
  }
  if (result.latencyOk === false || result.latency === null) {
    return { text: 'Unavailable', cls: 'fail' };
  }
  return { text: `${result.latency} ms`, cls: 'ok' };
}

export function fmtRate(bps) {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return null;
  if (bps >= 1e6) return { value: (bps / 1e6).toFixed(2), unit: 'Mbps' };
  if (bps >= 1e3) return { value: (bps / 1e3).toFixed(1), unit: 'kbps' };
  return { value: String(Math.round(bps)), unit: 'bps' };
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return { value: value.toFixed(value >= 100 || i === 0 ? 0 : 1), unit: units[i] };
}

export function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function fmtRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 45000) return 'just now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function protocolBadge(protocol) {
  return el('span', { class: `badge ${protocol}`, text: protocol });
}

/* --------------------------------------------------------------- toasts */

export function toast(message, kind = 'info', timeout = 3800) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = el('div', { class: `toast ${kind === 'info' ? '' : kind}`.trim(), text: message });
  root.appendChild(node);
  const remove = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

/* --------------------------------------------------------------- modals */

let openModalCount = 0;

/**
 * Opens a modal dialog.
 * @param {{title:string, body:(Node|Node[]|string), actions?:Array<{label:string, primary?:boolean, danger?:boolean, value?:any}>, onClose?:(value:any)=>void}} options
 * @returns {(value?:any)=>void} close function
 */
export function openModal({ title, body, actions = [], onClose }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement;

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = (value) => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    openModalCount = Math.max(0, openModalCount - 1);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    if (onClose) onClose(value);
  };

  const onKey = (event) => {
    if (event.key === 'Escape') close(undefined);
    if (event.key === 'Tab') {
      const focusables = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  modal.appendChild(el('h2', { text: title }));
  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.textContent = body;
  else appendChildren(bodyNode, body);
  modal.appendChild(bodyNode);

  if (actions.length) {
    const row = el('div', { class: 'modal-actions' });
    for (const action of actions) {
      row.appendChild(
        el(
          'button',
          {
            class: `btn ${action.primary ? 'primary' : ''} ${action.danger ? 'danger' : ''}`.trim(),
            text: action.label,
            onclick: () => close(action.value),
          }
        )
      );
    }
    modal.appendChild(row);
  }

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (event) => {
      if (event.target === backdrop) close(undefined);
    },
  });
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  openModalCount += 1;
  document.addEventListener('keydown', onKey);

  const focusTarget = modal.querySelector('button, input, select, textarea');
  if (focusTarget) focusTarget.focus();
  return close;
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: message,
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmLabel, primary: !danger, danger, value: true },
      ],
      onClose: resolve,
    });
  });
}

/** Renders a key/value list from a plain object. */
export function kvList(entries) {
  const dl = el('dl', { class: 'kv-list' });
  for (const [key, value] of entries) {
    dl.appendChild(el('dt', { text: key }));
    dl.appendChild(el('dd', { text: value === null || value === undefined || value === '' ? '—' : String(value) }));
  }
  return dl;
}

/** Empty/error/loading state block. */
export function stateBlock({ icon = '✦', title, message, action, error = false }) {
  return el('div', { class: `state-block ${error ? 'error' : ''}`.trim() }, [
    el('div', { class: 'state-icon', text: icon, 'aria-hidden': 'true' }),
    el('h3', { text: title }),
    message ? el('p', { text: message }) : null,
    action || null,
  ]);
}