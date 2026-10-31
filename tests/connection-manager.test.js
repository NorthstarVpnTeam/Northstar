'use strict';

/**
 * ConnectionManager lifecycle tests with a fake core manager — no real
 * processes are spawned. Verifies honest state transitions, validation
 * gating of "connected", error paths and cleanup on unexpected exit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionManager, parseStatsOutput } = require('../src/services/connection-manager');
const { CONNECTION_STATE, DEFAULT_SETTINGS } = require('../src/shared/constants');
const { ServerStore } = require('../src/services/server-store');

function makeStore() {
  const store = new ServerStore();
  store.loadDocument(
    'trojan://secret@127.0.0.1:1#%F0%9F%87%A8%F0%9F%87%A6%20Canada%2001',
    'test'
  );
  return store;
}

function makeSettings(overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  return { get: () => ({ ...settings }) };
}

function makeFakeCore({ startOk = true, startError = null } = {}) {
  return {
    state: 'stopped',
    corePath: '/fake/xray',
    coreSource: 'test',
    coreVersion: 'fake 1.0',
    lastError: null,
    lastPorts: null,
    starts: 0,
    async start(entry, ports) {
      if (!startOk) return { ok: false, error: startError || 'core failed', code: 'start-failed' };
      this.state = 'running';
      this.lastPorts = ports || null;
      this.starts = (this.starts || 0) + 1;
      return { ok: true };
    },
    async stop() {
      this.state = 'stopped';
    },
    status() {
      return { state: this.state, corePath: this.corePath, coreSource: this.coreSource, coreVersion: this.coreVersion, lastError: this.lastError, pid: null };
    },
  };
}

function build({ coreOptions, overrides, systemProxy, tunCheck } = {}) {
  const store = makeStore();
  const events = [];
  const statusLog = [];
  const fakeCore = makeFakeCore(coreOptions);
  const manager = new ConnectionManager({
    coreManager: fakeCore,
    store,
    settingsService: makeSettings(overrides),
    systemProxy,
    tunCheck,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'status') statusLog.push(event.data.state);
    },
  });
  // Replace validation with a controllable fake.
  return { manager, store, events, statusLog, fakeCore };
}

describe('connect lifecycle', () => {
  test('reaches connected only after core start and validation pass', async () => {
    const { manager, store, statusLog } = build({
      overrides: { validateOnConnect: true, validationType: 'tcp' },
    });
    manager._validate = async () => ({ ok: true, kind: 'tcp', ms: 3, code: null });

    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, true);
    assert.equal(manager.state, CONNECTION_STATE.CONNECTED);
    assert.ok(statusLog.includes(CONNECTION_STATE.CONNECTING));
    assert.equal(statusLog[statusLog.length - 1], CONNECTION_STATE.CONNECTED);
    assert.equal(manager.validation.ok, true);
    assert.ok(manager.since > 0);
  });

  test('stays in error when validation fails and core is torn down', async () => {
    const { manager, store, fakeCore } = build({
      overrides: { validateOnConnect: true },
    });
    manager._validate = async () => ({ ok: false, kind: 'e2e', ms: null, code: 'timeout' });

    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation-failed');
    assert.equal(manager.state, CONNECTION_STATE.ERROR);
    assert.match(manager.error, /validation failed/i);
    assert.equal(fakeCore.state, 'stopped'); // core was cleaned up
  });

  test('validation disabled reports connected once the listener is up', async () => {
    const { manager, store } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);
    assert.equal(result.ok, true);
    assert.equal(manager.state, CONNECTION_STATE.CONNECTED);
    assert.equal(manager.validation, null);
  });

  test('core startup failure maps to error state', async () => {
    const { manager, store } = build({
      coreOptions: { startOk: false, startError: 'port conflict' },
    });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, false);
    assert.equal(manager.state, CONNECTION_STATE.ERROR);
    assert.match(manager.error, /port conflict/);
  });

  test('unknown server id is rejected without touching the core', async () => {
    const { manager, fakeCore } = build();
    const result = await manager.connect('s_doesnotexist00000000000000000');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown-server');
    assert.equal(fakeCore.state, 'stopped');
    assert.equal(manager.state, CONNECTION_STATE.ERROR);
  });

  test('connect is idempotent when already connected to the same server', async () => {
    const { manager, store } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    const second = await manager.connect(serverId);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyConnected, true);
    assert.equal(manager.state, CONNECTION_STATE.CONNECTED);
  });

  test('switching servers tears down the previous core first', async () => {
    const store = makeStore();
    store.loadDocument(
      [
        'trojan://a@127.0.0.1:1#Canada%2001',
        'trojan://b@127.0.0.1:2#Germany%2002',
      ].join('\n'),
      'test'
    );
    const fakeCore = makeFakeCore();
    let starts = 0;
    const originalStart = fakeCore.start.bind(fakeCore);
    fakeCore.start = async (...args) => {
      starts += 1;
      return originalStart(...args);
    };
    const manager = new ConnectionManager({
      coreManager: fakeCore,
      store,
      settingsService: makeSettings({ validateOnConnect: false }),
      onEvent: () => {},
    });

    const rows = store.listRows();
    await manager.connect(rows[0].id);
    assert.equal(manager.serverId, rows[0].id);
    await manager.connect(rows[1].id);
    assert.equal(manager.serverId, rows[1].id);
    assert.equal(starts, 2);
    assert.equal(fakeCore.state, 'running');
  });
});

describe('disconnect and cleanup', () => {
  test('disconnect stops the core and reports disconnected', async () => {
    const { manager, store, fakeCore } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    assert.equal(fakeCore.state, 'running');

    const result = await manager.disconnect();
    assert.equal(result.ok, true);
    assert.equal(manager.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(fakeCore.state, 'stopped');
    assert.equal(manager.throughput.available, false);
  });

  test('disconnect when already disconnected is a no-op success', async () => {
    const { manager } = build();
    const result = await manager.disconnect();
    assert.equal(result.ok, true);
    assert.equal(manager.state, CONNECTION_STATE.DISCONNECTED);
  });

  test('unexpected core exit while connected flips to error', async () => {
    const { manager, store } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);

    manager.handleCoreExit({ code: 1, signal: null });
    assert.equal(manager.state, CONNECTION_STATE.ERROR);
    assert.match(manager.error, /exited unexpectedly/i);
  });

  test('shutdown from any state settles cleanly', async () => {
    const { manager, store, fakeCore } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    await manager.shutdown();
    assert.equal(manager.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(fakeCore.state, 'stopped');
  });

  test('events are recorded and capped', async () => {
    const { manager, store } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    await manager.disconnect();
    const events = manager.recentEvents();
    assert.ok(events.length >= 2);
    assert.ok(events.every((e) => e.ts && e.message && e.kind));
    assert.ok(events.length <= 100);
  });

  test('status payload contains no raw credentials', async () => {
    const { manager, store } = build({ overrides: { validateOnConnect: false } });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    const status = manager.status();
    const flat = JSON.stringify(status);
    assert.ok(!flat.includes('secret')); // trojan password in fixture
    assert.ok(!flat.includes('trojan://'));
    assert.equal(status.mode, 'local-proxy');
    assert.equal(status.systemProxy.active, false);
    assert.equal(status.tun.active, false);
  });
});

/** Controllable stand-in for the Windows system proxy helper. */
function makeFakeSystemProxy({ applyOk = true, restoreOk = true } = {}) {
  const fake = {
    active: false,
    calls: [],
    async apply(port) {
      fake.calls.push(['apply', port]);
      if (!applyOk) return { ok: false, code: 'helper-failed', error: 'powershell failed' };
      fake.active = true;
      return { ok: true, proxyServer: `127.0.0.1:${port}` };
    },
    async restore() {
      fake.calls.push(['restore']);
      if (!restoreOk) return { ok: false, code: 'helper-failed', error: 'restore failed' };
      fake.active = false;
      return { ok: true, restored: true };
    },
  };
  return fake;
}

describe('system proxy mode', () => {
  test('applies after connect and restores on disconnect', async () => {
    const systemProxy = makeFakeSystemProxy();
    const { manager, store } = build({
      overrides: { validateOnConnect: false, systemProxy: true, httpPort: 10809 },
      systemProxy,
    });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, true);
    assert.deepEqual(systemProxy.calls[0], ['apply', 10809]);
    assert.equal(manager.status().systemProxy.active, true);
    assert.equal(manager.status().mode, 'system-proxy');

    await manager.disconnect();
    assert.ok(systemProxy.calls.some(([name]) => name === 'restore'));
    assert.equal(systemProxy.active, false);
    assert.equal(manager.status().mode, 'local-proxy');
  });

  test('apply failure keeps the connection and reports the reason', async () => {
    const systemProxy = makeFakeSystemProxy({ applyOk: false });
    const { manager, store, events } = build({
      overrides: { validateOnConnect: false, systemProxy: true },
      systemProxy,
    });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, true);
    assert.equal(manager.state, CONNECTION_STATE.CONNECTED);
    assert.equal(manager.status().systemProxy.active, false);
    assert.equal(manager.status().systemProxy.error, 'powershell failed');
    assert.ok(events.some((e) => e.type === 'event' && e.data.kind === 'warn'));
  });

  test('system proxy is not touched when the setting is off', async () => {
    const systemProxy = makeFakeSystemProxy();
    const { manager, store } = build({ overrides: { validateOnConnect: false }, systemProxy });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    assert.deepEqual(systemProxy.calls, []);
    await manager.disconnect();
    assert.deepEqual(systemProxy.calls, []);
  });

  test('toggle while connected applies or reverts immediately', async () => {
    const systemProxy = makeFakeSystemProxy();
    const { manager, store } = build({
      overrides: { validateOnConnect: false, systemProxy: false },
      systemProxy,
    });
    const serverId = store.listRows()[0].id;

    // Disconnected: syncing is a no-op.
    let result = await manager.syncSystemProxy(true);
    assert.equal(result.applied, false);
    assert.deepEqual(systemProxy.calls, []);

    await manager.connect(serverId);
    await manager.syncSystemProxy(true);
    assert.equal(manager.status().systemProxy.active, true);
    await manager.syncSystemProxy(false);
    assert.equal(manager.status().systemProxy.active, false);
    assert.equal(systemProxy.active, false);
  });

  test('restore failure surfaces an error event instead of pretending', async () => {
    const systemProxy = makeFakeSystemProxy({ restoreOk: false });
    const { manager, store, events } = build({
      overrides: { validateOnConnect: false, systemProxy: true },
      systemProxy,
    });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    await manager.disconnect();

    assert.equal(systemProxy.active, true); // the fake could not restore
    const kinds = events.filter((e) => e.type === 'event').map((e) => e.data.kind);
    assert.ok(kinds.includes('error'));
  });
});

describe('TUN mode', () => {
  test('preflight failure blocks the connection before the core starts', async () => {
    const { manager, store, fakeCore } = build({
      overrides: { validateOnConnect: false, tunMode: true },
      tunCheck: async () => ({
        ok: false,
        code: 'elevation-required',
        message: 'TUN mode needs administrator rights.',
      }),
    });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'elevation-required');
    assert.equal(manager.state, CONNECTION_STATE.ERROR);
    assert.match(manager.error, /administrator rights/);
    assert.equal(fakeCore.state, 'stopped');
    assert.equal(fakeCore.starts, 0);
    assert.equal(fakeCore.lastPorts, null);
  });

  test('passes the TUN flag to the core and reports the mode', async () => {
    const { manager, store, fakeCore } = build({
      overrides: { validateOnConnect: false, tunMode: true, systemProxy: false },
      tunCheck: async () => ({ ok: true, elevated: true, platform: 'win32' }),
    });
    const serverId = store.listRows()[0].id;
    const result = await manager.connect(serverId);

    assert.equal(result.ok, true);
    assert.equal(fakeCore.lastPorts.tun, true);
    assert.equal(manager.status().tun.active, true);
    assert.equal(manager.status().mode, 'tun');

    await manager.disconnect();
    assert.equal(manager.status().tun.active, false);
    assert.equal(fakeCore.lastPorts.tun, true); // last config built, now stopped
  });

  test('tun and system proxy combine into a combined mode label', async () => {
    const systemProxy = makeFakeSystemProxy();
    const { manager, store } = build({
      overrides: { validateOnConnect: false, tunMode: true, systemProxy: true },
      systemProxy,
      tunCheck: async () => ({ ok: true, elevated: true, platform: 'win32' }),
    });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);
    assert.equal(manager.status().mode, 'tun+system-proxy');
  });

  test('reconnect reasons are derived from the applied settings', async () => {
    const { manager, store } = build({
      overrides: { validateOnConnect: false, tunMode: false, socksPort: 10808, httpPort: 10809 },
      tunCheck: async () => ({ ok: true, elevated: true, platform: 'linux' }),
    });
    const serverId = store.listRows()[0].id;
    await manager.connect(serverId);

    const current = {
      ...DEFAULT_SETTINGS,
      socksPort: 10808,
      httpPort: 10809,
      validateOnConnect: false,
    };
    assert.deepEqual(manager.pendingReconnectReasons(current), []);
    assert.deepEqual(manager.pendingReconnectReasons({ ...current, socksPort: 20001 }), [
      'local ports',
    ]);
    assert.deepEqual(manager.pendingReconnectReasons({ ...current, tunMode: true }), ['TUN mode']);
    assert.deepEqual(
      manager.pendingReconnectReasons({ ...current, validateOnConnect: true }),
      ['validation settings']
    );
    // Disconnected: nothing pending.
    await manager.disconnect();
    assert.deepEqual(manager.pendingReconnectReasons({ ...current, tunMode: true }), []);
  });
});

describe('throughput stats parsing', () => {
  test('sums socks and tun inbound traffic but ignores the api inbound', () => {
    const text = [
      'name: "inbound>>>socks-in>>>traffic>>>downlink" value: 100',
      'name: "inbound>>>socks-in>>>traffic>>>uplink" value: 40',
      'name: "inbound>>>tun-in>>>traffic>>>downlink" value: 600',
      'name: "inbound>>>tun-in>>>traffic>>>uplink" value: 20',
      'name: "inbound>>>api-in>>>traffic>>>downlink" value: 999',
    ].join('\n');
    const totals = parseStatsOutput(text);
    assert.equal(totals.down, 700);
    assert.equal(totals.up, 60);
    assert.equal(totals.found, true);
  });

  test('reports missing stats honestly', () => {
    const totals = parseStatsOutput('no stats here');
    assert.equal(totals.found, false);
    assert.equal(totals.down, 0);
  });
});