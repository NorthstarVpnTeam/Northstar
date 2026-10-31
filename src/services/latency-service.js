'use strict';

/**
 * Latency measurement service.
 *
 * Measurement kinds (kept strictly distinct — a TCP connect does not prove a
 * proxy works):
 *   tcp   - direct TCP connect time to the remote endpoint
 *   proxy - SOCKS5 CONNECT handshake through the local proxy core
 *   e2e   - full HTTP request through the local proxy core
 *   delay - v2rayN-style "real delay": a throwaway core is started for the
 *           server and a full HTTP round trip runs through it (two samples,
 *           the faster one is reported), so it works while disconnected
 *
 * All measurements have bounded timeouts, cancellation, a concurrency cap and
 * never fabricate results. Failures return ok:false with an error code, and the
 * UI renders those as "Unavailable".
 */

const net = require('net');
const http = require('http');
const { MEASUREMENT, LIMITS } = require('../shared/constants');

function now() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** Opens a TCP socket with a timeout; resolves elapsed ms. */
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = now();
    let settled = false;
    const socket = new net.Socket();
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, ms: null, code: 'timeout' }));
    socket.once('connect', () => done({ ok: true, ms: now() - start, code: null }));
    socket.once('error', (err) => done({ ok: false, ms: null, code: err.code || 'error' }));
    socket.connect({ host, port, timeout: timeoutMs });
  });
}

/** Sends a minimal SOCKS5 CONNECT and waits for the reply byte. */
function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve) => {
    const start = now();
    let settled = false;
    const socket = new net.Socket();
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => done({ ok: false, ms: null, code: 'timeout' }));
    socket.once('error', (err) => done({ ok: false, ms: null, code: err.code || 'error' }));

    let step = 'greeting';
    socket.once('connect', () => {
      // VER=5, NMETHODS=1, METHOD=0 (no authentication)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on('data', (data) => {
      if (step === 'greeting') {
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          done({ ok: false, ms: null, code: 'socks-reject' });
          return;
        }
        step = 'connect';
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        socket.write(req);
        return;
      }
      if (step === 'connect') {
        if (data.length < 2 || data[0] !== 0x05) {
          done({ ok: false, ms: null, code: 'socks-bad-reply' });
          return;
        }
        if (data[1] !== 0x00) {
          const map = {
            0x01: 'socks-general-failure',
            0x02: 'socks-not-allowed',
            0x03: 'socks-network-unreachable',
            0x04: 'socks-host-unreachable',
            0x05: 'socks-connection-refused',
            0x06: 'socks-ttl-expired',
            0x07: 'socks-unsupported-command',
            0x08: 'socks-unsupported-address-type',
          };
          done({ ok: false, ms: null, code: map[data[1]] || 'socks-error' });
          return;
        }
        done({ ok: true, ms: now() - start, code: null });
      }
    });

    socket.connect({ host: proxyHost, port: proxyPort, timeout: timeoutMs });
  });
}

/** Full HTTP GET through a local SOCKS5 proxy, measured end to end. */
function e2eThroughProxy(proxyHost, proxyPort, targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      done({ ok: false, ms: null, code: 'bad-url' });
      return;
    }

    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      timeout: timeoutMs,
      headers: { host: target.host, 'user-agent': 'NorthstarV2Ray/2.0', connection: 'close' },
    });

    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, ms: null, code: 'timeout' });
    }, timeoutMs);

    req.on('connect', (res, socket) => {
      // Through an HTTP proxy the local core would tunnel; we instead expect a
      // direct 200/204 style response when the core exposes an HTTP proxy.
      socket.destroy();
    });
    req.on('response', (res) => {
      const elapsed = now() - start;
      res.resume();
      clearTimeout(timer);
      if (res.statusCode && res.statusCode < 500) {
        done({ ok: true, ms: elapsed, code: null });
      } else {
        done({ ok: false, ms: null, code: `http-${res.statusCode}` });
      }
    });
    req.on('timeout', () => {
      clearTimeout(timer);
      req.destroy();
      done({ ok: false, ms: null, code: 'timeout' });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, ms: null, code: err.code || 'error' });
    });
    req.end();
  });
}

/** Simple promise pool with a concurrency cap. */
async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

class LatencyService {
  /**
   * @param {object} options
   * @param {()=>{socksPort:number,httpPort:number,pingTimeoutMs:number}} options.getSettings
   * @param {()=>('connected'|'disconnected')} options.getProxyState
   * @param {(entry:object)=>Promise<{ok:boolean,ms:number|null,code:string|null}>} [options.proxyProbe]
   *   injected probe used by proxy/e2e kinds (supplied by connection manager)
   * @param {(entry:object,timeoutMs:number)=>Promise<{ok:boolean,ms:number|null,code:string|null}>} [options.realDelayProbe]
   *   injected probe used by the delay kind (starts a temporary core)
   * @param {(result:object)=>void} [options.onResult]
   */
  constructor(options = {}) {
    this.getSettings = options.getSettings || (() => ({}));
    this.getProxyState = options.getProxyState || (() => 'disconnected');
    this.proxyProbe = options.proxyProbe || null;
    this.realDelayProbe = options.realDelayProbe || null;
    this.onResult = options.onResult || null;
    this._running = false;
    this._cancelled = false;
    this._activeControllers = new Set();
  }

  get running() {
    return this._running;
  }

  cancelAll() {
    this._cancelled = true;
    for (const controller of this._activeControllers) controller.abort();
  }

  /**
   * Measures a single server.
   * @param {object} entry normalized server entry
   * @param {object} [opts]
   * @param {'tcp'|'proxy'|'e2e'|'delay'} [opts.kind]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{id:string,ok:boolean,ms:number|null,kind:string,code:string|null,at:number}>}
   */
  async measure(entry, opts = {}) {
    const settings = this.getSettings();
    const kind = opts.kind || settings.measurementType || MEASUREMENT.TCP;
    const timeoutMs = clampTimeout(opts.timeoutMs || settings.pingTimeoutMs);
    const at = Date.now();

    let result;
    if (kind === MEASUREMENT.TCP) {
      result = await tcpConnect(entry.host, entry.port, timeoutMs);
    } else if (kind === MEASUREMENT.PROXY) {
      if (this.getProxyState() !== 'connected' || !this.proxyProbe) {
        result = { ok: false, ms: null, code: 'proxy-offline' };
      } else {
        result = await this.proxyProbe(entry, kind, timeoutMs);
      }
    } else if (kind === MEASUREMENT.E2E) {
      if (this.getProxyState() !== 'connected' || !this.proxyProbe) {
        result = { ok: false, ms: null, code: 'proxy-offline' };
      } else {
        result = await this.proxyProbe(entry, kind, timeoutMs);
      }
    } else if (kind === MEASUREMENT.DELAY) {
      // Needs no active connection: the probe brings up its own core.
      if (!this.realDelayProbe) {
        result = { ok: false, ms: null, code: 'real-delay-unavailable' };
      } else {
        result = await this.realDelayProbe(entry, timeoutMs);
      }
    } else {
      result = { ok: false, ms: null, code: 'unsupported-kind' };
    }

    const payload = {
      id: entry.id,
      ok: Boolean(result.ok),
      ms: result.ok && Number.isFinite(result.ms) ? Math.max(0, Math.round(result.ms)) : null,
      kind,
      code: result.ok ? null : result.code || 'failed',
      at,
    };
    if (this.onResult) this.onResult(payload);
    return payload;
  }

  /**
   * Measures many servers with a concurrency cap.
   * @param {object[]} entries
   * @param {object} [opts] kind, timeoutMs, concurrency, signal, onProgress
   */
  async measureMany(entries, opts = {}) {
    const settings = this.getSettings();
    const kind = opts.kind || settings.measurementType || MEASUREMENT.TCP;
    const timeoutMs = clampTimeout(opts.timeoutMs || settings.pingTimeoutMs);
    // Real delay spawns a temporary core per server, so it runs much narrower
    // than the socket-based kinds.
    const concurrency =
      opts.concurrency ||
      (kind === MEASUREMENT.DELAY
        ? Math.min(LIMITS.LATENCY_CONCURRENCY, LIMITS.REAL_DELAY_CONCURRENCY)
        : LIMITS.LATENCY_CONCURRENCY);
    const signal = opts.signal;

    this._running = true;
    this._cancelled = false;
    let done = 0;
    try {
      return await pool(entries, concurrency, async (entry) => {
        if (this._cancelled || (signal && signal.aborted)) {
          return { id: entry.id, ok: false, ms: null, kind, code: 'cancelled', at: Date.now() };
        }
        const r = await this.measure(entry, { kind, timeoutMs });
        done += 1;
        if (opts.onProgress) opts.onProgress({ done, total: entries.length, result: r });
        return r;
      });
    } finally {
      this._running = false;
    }
  }

  /** Convenience probe used by tests and the status bar. */
  async probeTcp(host, port, timeoutMs = 3000) {
    return tcpConnect(host, port, clampTimeout(timeoutMs));
  }
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 4000;
  return Math.min(LIMITS.PING_TIMEOUT_MAX, Math.max(LIMITS.PING_TIMEOUT_MIN, Math.round(n)));
}

module.exports = {
  LatencyService,
  tcpConnect,
  socks5Connect,
  e2eThroughProxy,
  pool,
  clampTimeout,
};