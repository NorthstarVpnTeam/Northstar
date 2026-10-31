'use strict';

/**
 * Real end-to-end connection check — no mocks.
 *
 * For each candidate configuration it:
 *   1. parses the entry with the application's parser,
 *   2. starts the bundled Xray core through ProxyCoreManager (the same code
 *      path the Connect button uses: config generation, spawn, listener wait),
 *   3. performs a real HTTP request through the local proxy to a public
 *      connectivity endpoint,
 *   4. shuts the core down again.
 *
 * Usage:
 *   node scripts/verify-connection.js                 # fetches the default source
 *   node scripts/verify-connection.js --limit 5
 *   node scripts/verify-connection.js --file list.txt
 *
 * Deliberately conservative: at most `--limit` servers, one small request per
 * server, hard timeouts. Exits non-zero when nothing connects so it can be
 * used as a gate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDocument } = require('../src/services/configuration-parser');
const { fetchConfiguration } = require('../src/services/configuration-fetcher');
const { ProxyCoreManager } = require('../src/services/proxy-core-manager');
const { e2eThroughProxy } = require('../src/services/latency-service');
const { DEFAULT_CONFIG_SOURCE } = require('../src/shared/constants');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const LIMIT = Math.max(1, Math.min(10, Number(argValue('--limit', '3'))));
const TIMEOUT_MS = Math.max(3000, Math.min(15000, Number(argValue('--timeout', '12000'))));
const SOURCE = argValue('--file', '');
const TARGET = 'http://cp.cloudflare.com/generate_204';

function freePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function loadEntries() {
  const text = SOURCE
    ? await fs.promises.readFile(SOURCE, 'utf8')
    : await fetchConfiguration({ url: DEFAULT_CONFIG_SOURCE });
  const { entries, stats } = parseDocument(text);
  process.stdout.write(
    `verify-connection: ${stats.parsed} parsed, ${stats.rejected} rejected, ` +
      `${stats.duplicates} duplicates (${stats.kept} kept)\n`
  );
  return entries;
}

async function testEntry(entry, socksPort, httpPort) {
  const core = new ProxyCoreManager({
    workDir: path.join(os.tmpdir(), 'northstar-verify'),
  });

  try {
    const started = await core.start(entry, {
      socksPort,
      httpPort,
      logLevel: 'warning',
      tun: false,
    });
    if (!started.ok) {
      return { ok: false, stage: 'start', detail: started.error, code: started.code, logs: core.recentLogs(12) };
    }

    const probe = await e2eThroughProxy('127.0.0.1', httpPort, TARGET, TIMEOUT_MS);
    if (!probe.ok) {
      return { ok: false, stage: 'request', detail: probe.code, code: probe.code, logs: core.recentLogs(12) };
    }
    return { ok: true, ms: probe.ms, stage: 'request' };
  } finally {
    await core.stop();
  }
}

async function main() {
  process.stdout.write('verify-connection: loading configurations…\n');
  const entries = await loadEntries();
  if (!entries.length) {
    process.stderr.write('verify-connection: no parseable configurations found.\n');
    process.exit(1);
  }
  process.stdout.write(`verify-connection: testing up to ${Math.min(LIMIT, entries.length)}\n\n`);

  // Prefer diversity: one entry per protocol when possible.
  const picked = [];
  const seen = new Set();
  for (const entry of entries) {
    if (picked.length >= LIMIT) break;
    if (seen.has(entry.protocol)) continue;
    seen.add(entry.protocol);
    picked.push(entry);
  }
  for (const entry of entries) {
    if (picked.length >= LIMIT) break;
    if (!picked.includes(entry)) picked.push(entry);
  }

  let connected = 0;
  for (const entry of picked) {
    const socksPort = await freePort();
    const httpPort = await freePort();
    const label = `${entry.label} [${entry.protocol}]`;
    const result = await testEntry(entry, socksPort, httpPort);
    if (result.ok) {
      connected += 1;
      process.stdout.write(`  OK    ${label} — ${result.ms} ms through the tunnel\n`);
    } else {
      process.stdout.write(`  FAIL  ${label} — ${result.stage}: ${result.detail}\n`);
      const hints = (result.logs || [])
        .filter((line) => line.level === 'error' || line.level === 'warn')
        .slice(-3)
        .map((line) => line.message);
      for (const hint of hints) process.stdout.write(`        core: ${hint}\n`);
      if (!hints.length && result.logs && result.logs.length) {
        process.stdout.write(`        core: ${result.logs[result.logs.length - 1].message}\n`);
      }
    }
  }

  process.stdout.write(
    `\nverify-connection: ${connected}/${picked.length} configurations connected end-to-end.\n`
  );
  process.exit(connected > 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify-connection: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
