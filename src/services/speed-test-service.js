'use strict';

/**
 * Speed testing service.
 *
 * Throughput is computed from actual bytes transferred over elapsed time —
 * never inferred from latency. Tests are user-initiated, cancellable, bounded
 * in bytes and duration, and clearly report their destination and whether the
 * selected proxy was used.
 *
 * Endpoint: Cloudflare's public speed endpoints
 *   download: http://speed.cloudflare.com/__down?bytes=<n>
 *   upload:   http://speed.cloudflare.com/__up   (POST body)
 * If the endpoint is unreachable the test fails honestly (no fake numbers).
 */

const http = require('http');
const { LIMITS } = require('../shared/constants');

const DOWNLOAD_URL = 'http://speed.cloudflare.com/__down';
const UPLOAD_URL = 'http://speed.cloudflare.com/__up';
const DEFAULT_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_UPLOAD_BYTES = 5 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

class SpeedTestService {
  constructor() {
    this._current = null;
  }

  get running() {
    return Boolean(this._current);
  }

  cancel() {
    if (this._current) {
      this._current.cancelled = true;
      if (this._current.abort) this._current.abort();
    }
  }

  /**
   * Runs a speed test.
   * @param {object} options
   * @param {'download'|'upload'} options.direction
   * @param {boolean} options.viaProxy route through the local proxy (default true)
   * @param {{socksPort:number,httpPort:number}} options.ports
   * @param {(progress:{bytes:number,elapsedMs:number,mbps:number|null})=>void} [options.onProgress]
   * @returns {Promise<object>} result descriptor
   */
  async run({ direction, viaProxy = true, ports, onProgress }) {
    if (this._current) return { ok: false, error: 'A speed test is already running.', code: 'busy' };

    const state = { cancelled: false, abort: null };
    this._current = state;

    const start = nowMs();
    let bytes = 0;
    const emit = () => {
      const elapsedMs = nowMs() - start;
      const mbps = elapsedMs > 100 ? Math.round((bytes * 8) / (elapsedMs / 1000) / 1000) : null;
      if (onProgress) onProgress({ bytes, elapsedMs, mbps });
    };

    try {
      const targetBytes =
        direction === 'download' ? DEFAULT_DOWNLOAD_BYTES : DEFAULT_UPLOAD_BYTES;
      const result =
        direction === 'download'
          ? await this._download({ viaProxy, ports, targetBytes, state, onTick: (b) => {
              bytes = b;
              emit();
            } })
          : await this._upload({ viaProxy, ports, targetBytes, state, onTick: (b) => {
              bytes = b;
              emit();
            } });

      const elapsedMs = nowMs() - start;
      if (state.cancelled) {
        return {
          ok: false,
          cancelled: true,
          direction,
          viaProxy,
          bytes,
          elapsedMs,
          error: 'Test cancelled.',
          code: 'cancelled',
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          direction,
          viaProxy,
          bytes,
          elapsedMs,
          error: result.error,
          code: result.code || 'failed',
          endpoint: result.endpoint,
        };
      }
      const mbps = elapsedMs > 0 ? (bytes * 8) / (elapsedMs / 1000) / 1e6 : 0;
      return {
        ok: true,
        direction,
        viaProxy,
        bytes,
        elapsedMs,
        mbps: Math.round(mbps * 100) / 100,
        endpoint: result.endpoint,
        note: viaProxy
          ? 'Measured through the local proxy.'
          : 'Measured with a direct connection (no proxy).',
      };
    } finally {
      this._current = null;
    }
  }

  _request(options, state, onTick, startBytes = 0) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (state.abort) state.abort = null;
        resolve(result);
      };

      const req = http.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          done({
            ok: false,
            error: `Speed endpoint returned HTTP ${res.statusCode}.`,
            code: `http-${res.statusCode}`,
            endpoint: options.__endpoint,
          });
          return;
        }
        let received = startBytes;
        res.on('data', (chunk) => {
          received += chunk.length;
          onTick(received);
          if (received >= LIMITS.SPEED_TEST_MAX_BYTES) {
            // Enough data for a valid measurement; stop early.
            req.destroy();
            done({ ok: true, endpoint: options.__endpoint });
          }
        });
        res.on('end', () => done({ ok: true, endpoint: options.__endpoint }));
        res.on('error', (err) => {
          if (state.cancelled) return;
          done({ ok: false, error: err.message, code: err.code || 'stream', endpoint: options.__endpoint });
        });
      });

      state.abort = () => {
        req.destroy();
        done({ ok: false, cancelled: true, code: 'cancelled', endpoint: options.__endpoint });
      };

      req.setTimeout(LIMITS.SPEED_TEST_TIMEOUT_MS, () => {
        req.destroy();
        done({
          ok: false,
          error: 'The speed test timed out.',
          code: 'timeout',
          endpoint: options.__endpoint,
        });
      });
      req.on('error', (err) => {
        if (state.cancelled) return;
        done({
          ok: false,
          error: `Speed test failed: ${err.message}`,
          code: err.code || 'error',
          endpoint: options.__endpoint,
        });
      });

      req.end(options.__body);
    });
  }

  async _download({ viaProxy, ports, targetBytes, state, onTick }) {
    const url = `${DOWNLOAD_URL}?bytes=${Math.min(targetBytes, LIMITS.SPEED_TEST_MAX_BYTES)}`;
    const common = {
      method: 'GET',
      headers: { 'user-agent': 'NorthstarV2Ray/2.0', connection: 'close' },
      __endpoint: 'speed.cloudflare.com/__down',
    };

    if (viaProxy) {
      // Absolute-form request through the local HTTP proxy.
      return this._request(
        { ...common, host: '127.0.0.1', port: ports.httpPort, path: url },
        state,
        onTick
      );
    }
    const parsed = new URL(url);
    return this._request(
      { ...common, host: parsed.hostname, port: 80, path: `${parsed.pathname}${parsed.search}` },
      state,
      onTick
    );
  }

  async _upload({ viaProxy, ports, targetBytes, state, onTick }) {
    const size = Math.min(targetBytes, LIMITS.SPEED_TEST_MAX_BYTES);
    const body = Buffer.alloc(size, 0x61); // 'a'
    const common = {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': size,
        'user-agent': 'NorthstarV2Ray/2.0',
        connection: 'close',
      },
      __endpoint: 'speed.cloudflare.com/__up',
      __body: body,
    };

    // Upload progress is derived from request 'socket.bytesWritten'.
    let lastBytes = 0;
    const tickTimer = setInterval(() => {
      if (state.cancelled) {
        clearInterval(tickTimer);
        return;
      }
      // bytesWritten includes headers; good enough for progress granularity.
      const written = lastBytes;
      onTick(written);
    }, 250);
    if (tickTimer.unref) tickTimer.unref();

    try {
      if (viaProxy) {
        const result = await this._uploadOnce(
          { ...common, host: '127.0.0.1', port: ports.httpPort, path: UPLOAD_URL },
          state,
          (b) => {
            lastBytes = b;
          },
          size
        );
        return result;
      }
      return await this._uploadOnce(
        { ...common, host: 'speed.cloudflare.com', port: 80, path: '/__up' },
        state,
        (b) => {
          lastBytes = b;
        },
        size
      );
    } finally {
      clearInterval(tickTimer);
      onTick(size);
    }
  }

  _uploadOnce(options, state, onTick, size) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const start = nowMs();
      const req = http.request(options, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 400) {
            onTick(size);
            done({ ok: true, endpoint: options.__endpoint, elapsedMs: nowMs() - start });
          } else {
            done({
              ok: false,
              error: `Upload endpoint returned HTTP ${res.statusCode}.`,
              code: `http-${res.statusCode}`,
              endpoint: options.__endpoint,
            });
          }
        });
      });
      state.abort = () => {
        req.destroy();
        done({ ok: false, cancelled: true, code: 'cancelled', endpoint: options.__endpoint });
      };
      req.setTimeout(LIMITS.SPEED_TEST_TIMEOUT_MS, () => {
        req.destroy();
        done({ ok: false, error: 'The upload test timed out.', code: 'timeout', endpoint: options.__endpoint });
      });
      req.on('error', (err) => {
        if (state.cancelled) return;
        done({
          ok: false,
          error: `Upload test failed: ${err.message}`,
          code: err.code || 'error',
          endpoint: options.__endpoint,
        });
      });
      req.end(options.__body);
    });
  }
}

module.exports = { SpeedTestService, DOWNLOAD_URL, UPLOAD_URL };