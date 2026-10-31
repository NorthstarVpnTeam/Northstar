'use strict';

/**
 * Cross-file consistency tests:
 *   - preload channel allowlists match src/shared/constants.js
 *   - preload exposes no dangerous API surface
 *   - shared constants are sane (limits, defaults)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IPC, IPC_EVENTS, DEFAULT_SETTINGS, LIMITS, PROTOCOLS } = require('../src/shared/constants');

const preloadSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
  'utf8'
);

function extractObjectLiteral(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `marker ${marker} not found in preload.js`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(braceStart, i + 1);
}

describe('preload / constants consistency', () => {
  test('every invoke channel in preload exists in constants', () => {
    const literal = extractObjectLiteral(preloadSource, 'const INVOKE');
    const keys = [...literal.matchAll(/([A-Z_]+):\s*'([^']+)'/g)];
    assert.ok(keys.length > 10, 'expected INVOKE entries');
    for (const [, key, value] of keys) {
      assert.ok(IPC[key] === undefined || IPC[key] === value, `preload ${key}=${value} vs constants ${IPC[key]}`);
      assert.ok(Object.values(IPC).includes(value), `channel ${value} missing from constants`);
    }
  });

  test('every push event channel in preload exists in constants', () => {
    const literal = extractObjectLiteral(preloadSource, 'const EVENTS');
    const keys = [...literal.matchAll(/([A-Z_]+):\s*'([^']+)'/g)];
    assert.ok(keys.length > 5, 'expected EVENTS entries');
    for (const [, key, value] of keys) {
      assert.ok(IPC_EVENTS[key] === undefined || IPC_EVENTS[key] === value, `event ${key}`);
      assert.ok(Object.values(IPC_EVENTS).includes(value), `event ${value} missing from constants`);
    }
  });

  test('preload blocks unknown channels', () => {
    assert.match(preloadSource, /ALLOWED_INVOKE\.has\(channel\)/);
    assert.match(preloadSource, /ALLOWED_EVENTS\.has\(channel\)/);
    assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('northstar'/);
  });

  test('preload never exposes ipcRenderer or require directly', () => {
    const exposeIndex = preloadSource.indexOf('contextBridge.exposeInMainWorld');
    const exposed = preloadSource.slice(exposeIndex);
    assert.ok(!exposed.includes('ipcRenderer,'), 'ipcRenderer must not be in the exposed object');
    assert.ok(!exposed.includes('require:'));
    assert.ok(!exposed.includes('process:'));
  });
});

describe('IPC reference integrity', () => {
  test('every IPC./IPC_EVENTS. reference in src resolves to a real channel', () => {
    // Regression guard: a typo like IPC.SERVERS_CHANGED (that key lives in
    // IPC_EVENTS) evaluates to undefined and makes webContents.send throw
    // "Missing required channel argument" at runtime.
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.ok(files.length > 10, 'expected to scan the source tree');

    const undefinedRefs = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b(IPC|IPC_EVENTS)\.([A-Z0-9_]+)/g)) {
        const table = match[1] === 'IPC' ? IPC : IPC_EVENTS;
        if (!(match[2] in table)) {
          undefinedRefs.push(`${path.relative(path.join(__dirname, '..'), file)}: ${match[1]}.${match[2]}`);
        }
      }
    }
    assert.deepEqual(undefinedRefs, [], `undefined IPC references:\n${undefinedRefs.join('\n')}`);
  });
});

describe('shared constants', () => {
  test('default settings are internally consistent', () => {
    assert.notEqual(DEFAULT_SETTINGS.socksPort, DEFAULT_SETTINGS.httpPort);
    assert.ok(
      DEFAULT_SETTINGS.pingTimeoutMs >= LIMITS.PING_TIMEOUT_MIN &&
        DEFAULT_SETTINGS.pingTimeoutMs <= LIMITS.PING_TIMEOUT_MAX
    );
    assert.ok(PROTOCOLS.includes('vless'));
    assert.ok(PROTOCOLS.includes('ss'));
    assert.equal(DEFAULT_SETTINGS.configSource.startsWith('https://'), true);
  });

  test('the default configuration source is the required URL', () => {
    assert.equal(
      DEFAULT_SETTINGS.configSource,
      'https://raw.githubusercontent.com/shupolol/Free-configs/refs/heads/main/output/all_configs.txt'
    );
  });

  test('limits are positive and ordered', () => {
    assert.ok(LIMITS.PING_TIMEOUT_MIN < LIMITS.PING_TIMEOUT_MAX);
    assert.ok(LIMITS.PORT_MIN < LIMITS.PORT_MAX);
    assert.ok(LIMITS.LATENCY_CONCURRENCY >= 1);
    assert.ok(LIMITS.FETCH_TIMEOUT_MS >= 1000);
  });
});
