'use strict';

/**
 * Server store tests: grouping, sorting, filtering, search, selection,
 * latency bookkeeping and row serialization (no credentials leaked).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ServerStore, UNKNOWN_GROUP } = require('../src/services/server-store');

function makeStore() {
  const store = new ServerStore();
  const doc = [
    'vless://a715374a-a745-4800-889b-0c864fad5ca0@1.1.1.1:443?security=tls&type=tcp#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20001',
    'vless://b715374a-a745-4800-889b-0c864fad5ca0@2.2.2.2:443?security=tls&type=tcp#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20002',
    'trojan://pw@3.3.3.3:443#%F0%9F%87%A8%F0%9F%87%A6%20Canada%20003',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@4.4.4.4:8388#%F0%9F%87%AF%F0%9F%87%B5%20Japan%20010',
    'socks://5.5.5.5:1080#Mystery%20Node',
  ];
  const stats = store.loadDocument(doc.join('\n'), 'https://example.test/all.txt');
  return { store, stats };
}

describe('ServerStore ingest', () => {
  test('loads and counts entries', () => {
    const { store, stats } = makeStore();
    assert.equal(stats.kept, 5);
    assert.equal(store.count, 5);
    assert.equal(store.meta().source, 'https://example.test/all.txt');
    assert.ok(store.meta().fetchedAt > 0);
  });
});

describe('grouping', () => {
  test('groups by country with flags and an Unknown bucket', () => {
    const { store } = makeStore();
    const groups = store.groups({ sort: 'name' });
    const names = groups.map((g) => g.name);
    assert.ok(names.includes('United States'));
    assert.ok(names.includes('Canada'));
    assert.ok(names.includes('Japan'));
    assert.ok(names.includes(UNKNOWN_GROUP));
    // Unknown is always last.
    assert.equal(names[names.length - 1], UNKNOWN_GROUP);

    const us = groups.find((g) => g.name === 'United States');
    assert.equal(us.count, 2);
    assert.equal(us.flag, '🇺🇸');
    assert.deepEqual(
      us.servers.map((s) => s.label),
      ['United States 01', 'United States 02']
    );
  });

  test('latency sort puts measured servers first, untested last', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    const usRows = rows.filter((r) => r.country === 'United States');
    store.setLatency(usRows[0].id, { ms: 250, ok: true, kind: 'tcp', at: Date.now() });
    store.setLatency(usRows[1].id, { ms: 90, ok: true, kind: 'tcp', at: Date.now() });

    const us = store.groups({ sort: 'latency' }).find((g) => g.name === 'United States');
    assert.equal(us.servers[0].latency, 90);
    assert.equal(us.servers[1].latency, 250);
  });

  test('failed measurements sort after successful ones', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.setLatency(rows[0].id, { ms: null, ok: false, kind: 'tcp', at: Date.now() });
    store.setLatency(rows[1].id, { ms: 50, ok: true, kind: 'tcp', at: Date.now() });
    const groups = store.groups({ sort: 'latency' }).filter((g) => g.name === 'United States');
    assert.equal(groups[0].servers[0].latency, 50);
    assert.equal(groups[0].servers[0].latencyOk, true);
    assert.equal(groups[0].servers[1].latencyOk, false);
  });

  test('hideFailed removes only failed servers', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.setLatency(rows[0].id, { ms: null, ok: false, kind: 'tcp', at: Date.now() });
    store.setLatency(rows[1].id, { ms: 40, ok: true, kind: 'tcp', at: Date.now() });
    const groups = store.groups({ sort: 'name', hideFailed: true });
    const total = groups.reduce((n, g) => n + g.count, 0);
    assert.equal(total, store.count - 1);
  });
});

describe('search and filtering', () => {
  test('matches on label, country and protocol', () => {
    const { store } = makeStore();
    assert.equal(store.search({ query: 'canada' }).length, 1);
    assert.equal(store.search({ query: 'japan' }).length, 1);
    assert.equal(store.search({ query: 'vless' }).length, 2);
    assert.equal(store.search({ query: 'zzz-no-match' }).length, 0);
  });

  test('protocol and status filters compose', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.setLatency(rows[0].id, { ms: 10, ok: true, kind: 'tcp', at: Date.now() });
    store.setLatency(rows[2].id, { ms: null, ok: false, kind: 'tcp', at: Date.now() });

    assert.equal(store.search({ status: 'ok' }).length, 1);
    assert.equal(store.search({ status: 'failed' }).length, 1);
    assert.equal(store.search({ status: 'untested' }).length, 3);
    assert.equal(store.search({ protocol: 'trojan' }).length, 1);
    assert.equal(store.search({ protocol: 'trojan', status: 'ok' }).length, 0);
  });

  test('selected filter returns the selection only', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.select(rows[1].id);
    const found = store.search({ status: 'selected' });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, rows[1].id);
    assert.equal(found[0].selected, true);
  });
});

describe('selection and latency state', () => {
  test('rejects unknown server ids', () => {
    const { store } = makeStore();
    assert.equal(store.select('s_doesnotexist'), false);
    assert.equal(store.select(null), true);
    assert.equal(store.selectedId, null);
  });

  test('clears selection when the server disappears after refresh', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.select(rows[0].id);
    store.loadDocument('trojan://pw@9.9.9.9:443#Fresh', 'https://example.test/new.txt');
    assert.equal(store.selectedId, null);
  });

  test('stale latency entries are dropped on reload', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    store.setLatency(rows[0].id, { ms: 42, ok: true, kind: 'tcp', at: Date.now() });
    assert.equal(store.getLatency(rows[0].id).ms, 42);
    store.loadDocument('trojan://pw@9.9.9.9:443#Fresh', 'x');
    assert.equal(store.getLatency(rows[0].id), null);
  });

  test('rows never contain raw URIs or credentials', () => {
    const { store } = makeStore();
    const rows = store.listRows();
    for (const row of rows) {
      const keys = Object.keys(row);
      assert.ok(!keys.includes('raw'));
      assert.ok(!keys.includes('credential'));
      const flat = JSON.stringify(row);
      assert.ok(!flat.includes('trojan://'));
      assert.ok(!flat.includes('vless://'));
      assert.ok(!flat.includes('password'));
    }
  });
});

describe('ingest failure handling', () => {
  test('clear() resets everything', () => {
    const { store } = makeStore();
    store.select(store.listRows()[0].id);
    store.clear();
    assert.equal(store.count, 0);
    assert.equal(store.selectedId, null);
    assert.equal(store.meta().stats.kept, 0);
  });
});