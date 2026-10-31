'use strict';

/**
 * Configuration fetcher tests against local HTTP servers only — no external
 * network access. Covers success, HTTP errors, content-type validation,
 * size limits and cancellation.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchConfiguration, FetchError } = require('../src/services/configuration-fetcher');
const { LIMITS } = require('../src/shared/constants');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path = '/all.txt') {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

function stopServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

describe('fetchConfiguration', () => {
  test('downloads a plain text document and reports progress', async () => {
    const body = 'trojan://a@1.2.3.4:443#One\ntrojan://b@2.3.4.5:443#Two\n';
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    try {
      const phases = [];
      const text = await fetchConfiguration({
        url: urlFor(server),
        onProgress: (p) => phases.push(p.phase),
      });
      assert.equal(text, body);
      assert.ok(phases.includes('connecting'));
      assert.ok(phases.includes('done'));
    } finally {
      await stopServer(server);
    }
  });

  test('rejects HTTP error statuses with the status code', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    try {
      await assert.rejects(
        fetchConfiguration({ url: urlFor(server) }),
        (err) => err instanceof FetchError && err.code === 'http-error' && err.status === 404
      );
    } finally {
      await stopServer(server);
    }
  });

  test('rejects unexpected content types', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end('binary');
    });
    try {
      await assert.rejects(
        fetchConfiguration({ url: urlFor(server) }),
        (err) => err instanceof FetchError && err.code === 'bad-content-type'
      );
    } finally {
      await stopServer(server);
    }
  });

  test('rejects oversized Content-Length responses without downloading them', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(LIMITS.FETCH_MAX_BYTES + 1),
      });
      res.end();
    });
    try {
      await assert.rejects(
        fetchConfiguration({ url: urlFor(server) }),
        (err) => err instanceof FetchError && err.code === 'too-large'
      );
    } finally {
      await stopServer(server);
    }
  });

  test('supports cancellation through an AbortSignal', async () => {
    const server = await startServer(() => {
      // Never responds; the client aborts.
    });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      await assert.rejects(
        fetchConfiguration({ url: urlFor(server), signal: controller.signal }),
        (err) => err instanceof FetchError && err.code === 'cancelled'
      );
    } finally {
      await stopServer(server);
    }
  });

  test('invalid URLs are rejected before any network activity', async () => {
    await assert.rejects(
      fetchConfiguration({ url: 'not a url' }),
      (err) => err.code === 'invalid-url'
    );
    await assert.rejects(
      fetchConfiguration({ url: 'ftp://example.com/x' }),
      (err) => err.code === 'invalid-url'
    );
    await assert.rejects(fetchConfiguration({ url: '' }), (err) => err.code === 'invalid-url');
  });

  test('connection refused is reported as a friendly network error', async () => {
    const server = await startServer(() => {});
    const port = server.address().port;
    await stopServer(server);
    await assert.rejects(
      fetchConfiguration({ url: `http://127.0.0.1:${port}/x` }),
      (err) => err instanceof FetchError && (err.code === 'refused' || err.code === 'network')
    );
  });
});
