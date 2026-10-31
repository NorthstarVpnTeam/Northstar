'use strict';

/**
 * Latency measurement tests using local loopback sockets only:
 *   - real TCP connect timing against a local server
 *   - bounded timeouts against a non-accepting endpoint
 *   - SOCKS5 handshake success/rejection against a fake local proxy
 *   - concurrency pooling and cancellation-friendly accounting
 * No external network is contacted.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  tcpConnect,
  socks5Connect,
  pool,
  clampTimeout,
  LatencyService,
} = require('../src/services/latency-service');
const { LIMITS } = require('../src/shared/constants');

function stop(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

describe('tcpConnect', () => {
  let server;
  let port;

  before(async () => {
    server = net.createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await stop(server);
  });

  test('measures a successful loopback connection', async () => {
    const result = await tcpConnect('127.0.0.1', port, 2000);
    assert.equal(result.ok, true);
    assert.equal(typeof result.ms, 'number');
    assert.ok(result.ms >= 0 && result.ms < 2000);
  });

  test('times out with a code against a non-listening port', async () => {
    const result = await tcpConnect('127.0.0.1', 1, 600); // port 1 refuses fast
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.ok(result.code);
  });

  test('reports refused connections as failures, not zeros', async () => {
    // Grab a port, close it, then connect: likely ECONNREFUSED.
    const tmp = net.createServer();
    await new Promise((resolve) => tmp.listen(0, '127.0.0.1', resolve));
    const closedPort = tmp.address().port;
    await new Promise((resolve) => tmp.close(resolve));

    const result = await tcpConnect('127.0.0.1', closedPort, 1500);
    assert.equal(result.ok, false);
    assert.notEqual(result.ms, 0);
    assert.equal(result.ms, null);
  });
});

describe('socks5Connect against a fake local proxy', () => {
  let server;
  let port;

  before(async () => {
    server = net.createServer((socket) => {
      let stage = 0;
      socket.on('data', (data) => {
        if (stage === 0) {
          stage = 1;
          // Greeting: reply "no auth required"
          socket.write(Buffer.from([0x05, 0x00]));
        } else if (stage === 1) {
          stage = 2;
          const success = socket.__mode !== 'reject';
          if (success) socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          else socket.write(Buffer.from([0x05, 0x00, 0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
      socket.once('data', () => {
        // mode can be forced via connection flag below
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await stop(server);
  });

  test('successful handshake returns elapsed time', async () => {
    const result = await socks5Connect('127.0.0.1', port, 'example.com', 443, 2000);
    assert.equal(result.ok, true);
    assert.equal(typeof result.ms, 'number');
    assert.ok(result.ms >= 0);
  });

  test('proxy that refuses the CONNECT is reported as failure', async (t) => {
    // Start a one-shot rejecting proxy.
    const rejector = net.createServer((socket) => {
      let stage = 0;
      socket.on('data', () => {
        if (stage === 0) {
          stage = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else {
          // VER=5, REP=5 (connection refused), RSV, ATYP=IPv4
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
    });
    await new Promise((resolve) => rejector.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      if (typeof rejector.closeAllConnections === 'function') rejector.closeAllConnections();
      await new Promise((resolve) => rejector.close(resolve));
    });
    const rejectPort = rejector.address().port;

    const result = await socks5Connect('127.0.0.1', rejectPort, 'example.com', 443, 2000);
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.match(String(result.code), /^socks-/);
  });

  test('unreachable proxy times out with a bounded result', async () => {
    const result = await socks5Connect('127.0.0.1', 1, 'example.com', 443, 600);
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.ok(result.code);
  });
});

describe('helpers', () => {
  test('clampTimeout enforces configured bounds', () => {
    assert.equal(clampTimeout(100), LIMITS.PING_TIMEOUT_MIN);
    assert.equal(clampTimeout(99999), LIMITS.PING_TIMEOUT_MAX);
    assert.equal(clampTimeout(3000), 3000);
    assert.equal(clampTimeout('nonsense'), 4000);
    assert.equal(clampTimeout(undefined), 4000);
  });

  test('pool respects concurrency and preserves order', async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = await pool(items, 3, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return n * 2;
    });
    assert.deepEqual(results, items.map((n) => n * 2));
    assert.ok(maxActive <= 3, `max concurrent was ${maxActive}`);
    assert.ok(maxActive > 1);
  });

  test('measure() returns ok:false (never fabricated ms) for offline proxy modes', async () => {
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'tcp', pingTimeoutMs: 500 }),
      getProxyState: () => 'disconnected',
      proxyProbe: async () => ({ ok: true, ms: 5 }),
    });
    const result = await service.measure(
      { id: 's_x', host: '127.0.0.1', port: 1 },
      { kind: 'proxy', timeoutMs: 500 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.equal(result.code, 'proxy-offline');
  });

  test('measure() runs the injected probe when connected', async () => {
    let called = 0;
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'proxy', pingTimeoutMs: 500 }),
      getProxyState: () => 'connected',
      proxyProbe: async () => {
        called += 1;
        return { ok: true, ms: 42 };
      },
    });
    const result = await service.measure({ id: 's_y', host: 'h', port: 1 }, { kind: 'proxy' });
    assert.equal(called, 1);
    assert.equal(result.ok, true);
    assert.equal(result.ms, 42);
    assert.equal(result.kind, 'proxy');
  });

  test('measureMany reports progress and counts failures honestly', async () => {
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'tcp', pingTimeoutMs: 500 }),
      getProxyState: () => 'disconnected',
    });
    const entries = [
      { id: 's_1', host: '127.0.0.1', port: 1 },
      { id: 's_2', host: '127.0.0.1', port: 1 },
    ];
    let progressCalls = 0;
    const results = await service.measureMany(entries, {
      kind: 'tcp',
      timeoutMs: 500,
      concurrency: 2,
      onProgress: () => {
        progressCalls += 1;
      },
    });
    assert.equal(results.length, 2);
    assert.equal(progressCalls, 2);
    assert.ok(results.every((r) => r.ok === false && r.ms === null));
  });
});

describe('real delay (v2rayN-style)', () => {
  const entry = { id: 's_delay', host: '127.0.0.1', port: 1 };

  test('measure() runs the injected probe and keeps its number', async () => {
    let calls = 0;
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'tcp', pingTimeoutMs: 500 }),
      getProxyState: () => 'disconnected', // deliberately offline: delay must not care
      realDelayProbe: async (target, timeoutMs) => {
        calls += 1;
        assert.equal(target.id, entry.id);
        assert.equal(typeof timeoutMs, 'number');
        return { ok: true, ms: 123, code: null };
      },
    });

    const result = await service.measure(entry, { kind: 'delay', timeoutMs: 500 });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.ms, 123);
    assert.equal(result.kind, 'delay');
  });

  test('measure() reports an honest code when no probe is wired', async () => {
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'tcp', pingTimeoutMs: 500 }),
      getProxyState: () => 'disconnected',
    });
    const result = await service.measure(entry, { kind: 'delay', timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.equal(result.code, 'real-delay-unavailable');
  });

  test('measureMany runs the delay kind far narrower than socket pings', async () => {
    let active = 0;
    let maxActive = 0;
    const service = new LatencyService({
      getSettings: () => ({ measurementType: 'delay', pingTimeoutMs: 500 }),
      realDelayProbe: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { ok: true, ms: 7, code: null };
      },
    });

    const entries = Array.from({ length: 6 }, (_, i) => ({ id: `s_d${i}`, host: 'h', port: 1 }));
    const results = await service.measureMany(entries, { kind: 'delay', timeoutMs: 500 });
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.ok === true && r.ms === 7));
    assert.ok(maxActive <= LIMITS.REAL_DELAY_CONCURRENCY, `max concurrent was ${maxActive}`);
    assert.ok(maxActive > 1, 'expected the capped pool to overlap');
  });
});
