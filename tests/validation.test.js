'use strict';

/**
 * Validation tests: settings updates, IPC payload validation and
 * corruption-tolerant settings coercion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSettingsUpdate,
  validateLatencyRequest,
  validateConnectRequest,
  validateSpeedRequest,
  validateUrl,
  validatePort,
  validateServerId,
  coerceSettings,
} = require('../src/shared/validation');
const { DEFAULT_SETTINGS, LIMITS } = require('../src/shared/constants');

describe('validateSettingsUpdate', () => {
  test('accepts a valid partial patch', () => {
    const result = validateSettingsUpdate({ pingTimeoutMs: 2500, autoPing: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { pingTimeoutMs: 2500, autoPing: false });
  });

  test('rejects unknown keys', () => {
    const result = validateSettingsUpdate({ evil: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown setting/);
  });

  test('rejects non-objects and empty patches', () => {
    assert.equal(validateSettingsUpdate(null).ok, false);
    assert.equal(validateSettingsUpdate('string').ok, false);
    assert.equal(validateSettingsUpdate({}).ok, false);
  });

  test('ping timeout bounds (500–10000)', () => {
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: 499 }).ok, false);
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: 500 }).ok, true);
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: 10000 }).ok, true);
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: 10001 }).ok, false);
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: 2500.5 }).ok, false);
    assert.equal(validateSettingsUpdate({ pingTimeoutMs: '4000' }).ok, false);
  });

  test('ping interval must be an allowed option', () => {
    assert.equal(validateSettingsUpdate({ pingIntervalMs: 60000 }).ok, true);
    assert.equal(validateSettingsUpdate({ pingIntervalMs: 7000 }).ok, false);
  });

  test('config source must be http(s) without credentials', () => {
    assert.equal(validateSettingsUpdate({ configSource: 'https://example.com/x.txt' }).ok, true);
    assert.equal(validateSettingsUpdate({ configSource: 'ftp://example.com/x' }).ok, false);
    assert.equal(validateSettingsUpdate({ configSource: 'not a url' }).ok, false);
    assert.equal(
      validateSettingsUpdate({ configSource: 'https://user:pass@example.com/x' }).ok,
      false
    );
    assert.equal(validateSettingsUpdate({ configSource: '' }).ok, false);
  });

  test('ports: range, type and cross-field conflict', () => {
    assert.equal(validateSettingsUpdate({ socksPort: 10808 }).ok, true);
    assert.equal(validateSettingsUpdate({ socksPort: 80 }).ok, false);
    assert.equal(validateSettingsUpdate({ socksPort: 70000 }).ok, false);
    assert.equal(validateSettingsUpdate({ socksPort: 1.5 }).ok, false);
    const same = validateSettingsUpdate({ socksPort: 10808, httpPort: 10808 });
    assert.equal(same.ok, false);
    assert.match(same.error, /differ/);
  });

  test('enums are enforced', () => {
    assert.equal(validateSettingsUpdate({ sortBy: 'latency' }).ok, true);
    assert.equal(validateSettingsUpdate({ sortBy: 'haircolor' }).ok, false);
    assert.equal(validateSettingsUpdate({ theme: 'dark' }).ok, true);
    assert.equal(validateSettingsUpdate({ theme: 'neon' }).ok, false);
    assert.equal(validateSettingsUpdate({ measurementType: 'tcp' }).ok, true);
    assert.equal(validateSettingsUpdate({ measurementType: 'magic' }).ok, false);
  });

  test('booleans must be real booleans', () => {
    assert.equal(validateSettingsUpdate({ autoSort: 'yes' }).ok, false);
    assert.equal(validateSettingsUpdate({ autoSort: 1 }).ok, false);
    assert.equal(validateSettingsUpdate({ autoSort: true }).ok, true);
  });

  test('system proxy and TUN toggles are real booleans', () => {
    assert.equal(validateSettingsUpdate({ systemProxy: true }).ok, true);
    assert.equal(validateSettingsUpdate({ systemProxy: false }).ok, true);
    assert.equal(validateSettingsUpdate({ tunMode: true }).ok, true);
    assert.equal(validateSettingsUpdate({ tunMode: 'on' }).ok, false);
    assert.equal(validateSettingsUpdate({ systemProxy: 1 }).ok, false);
    assert.equal(validateSettingsUpdate({ tunMode: null }).ok, false);
  });

  test('routing modes default to off so nothing changes silently', () => {
    assert.equal(DEFAULT_SETTINGS.systemProxy, false);
    assert.equal(DEFAULT_SETTINGS.tunMode, false);
    assert.equal(coerceSettings({ systemProxy: 'yes', tunMode: 2 }).systemProxy, false);
    assert.equal(coerceSettings({ systemProxy: 'yes', tunMode: 2 }).tunMode, false);
    assert.equal(coerceSettings({ systemProxy: true, tunMode: true }).tunMode, true);
  });
});

describe('coerceSettings', () => {
  test('returns defaults for garbage input', () => {
    assert.deepEqual(coerceSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(coerceSettings('junk'), DEFAULT_SETTINGS);
    assert.deepEqual(coerceSettings(42), DEFAULT_SETTINGS);
  });

  test('keeps valid fields and drops corrupt ones', () => {
    const result = coerceSettings({
      pingTimeoutMs: 8000,
      theme: 'banana',
      autoPing: false,
      socksPort: -5,
      sortBy: 'latency',
    });
    assert.equal(result.pingTimeoutMs, 8000);
    assert.equal(result.autoPing, false);
    assert.equal(result.sortBy, 'latency');
    assert.equal(result.theme, DEFAULT_SETTINGS.theme); // corrupt -> default
    assert.equal(result.socksPort, DEFAULT_SETTINGS.socksPort);
  });

  test('unknown keys in storage are ignored', () => {
    const result = coerceSettings({ ...DEFAULT_SETTINGS, bogus: 'x' });
    assert.equal(result.bogus, undefined);
    assert.equal(result.pingTimeoutMs, DEFAULT_SETTINGS.pingTimeoutMs);
  });
});

describe('IPC payload validation', () => {
  test('server ids must match the id pattern', () => {
    assert.equal(validateServerId('s_0123456789abcdef0123456789abcdef').ok, true);
    assert.equal(validateServerId('short').ok, false);
    assert.equal(validateServerId('has spaces here xxxx').ok, false);
    assert.equal(validateServerId(null).ok, false);
    assert.equal(validateServerId('../../etc/passwd').ok, false);
  });

  test('latency requests need ids or all', () => {
    assert.equal(validateLatencyRequest({ all: true }).ok, true);
    assert.equal(validateLatencyRequest({ ids: [] }).ok, true);
    assert.equal(validateLatencyRequest({ ids: ['s_0123456789abcdef0123456789abcdef'] }).ok, true);
    assert.equal(validateLatencyRequest({}).ok, false);
    assert.equal(validateLatencyRequest({ ids: 'not-array' }).ok, false);
    assert.equal(validateLatencyRequest({ ids: ['bad id'] }).ok, false);
    assert.equal(validateLatencyRequest({ type: 'quantum' }).ok, false);
  });

  test('connect requests require a valid id', () => {
    assert.equal(validateConnectRequest({ serverId: 's_0123456789abcdef0123456789abcdef' }).ok, true);
    assert.equal(validateConnectRequest({}).ok, false);
    assert.equal(validateConnectRequest(null).ok, false);
  });

  test('speed requests constrain direction and coerce viaProxy', () => {
    assert.deepEqual(validateSpeedRequest({ direction: 'download' }).value, {
      direction: 'download',
      viaProxy: true,
    });
    assert.equal(validateSpeedRequest({ direction: 'sideways' }).ok, false);
    assert.equal(validateSpeedRequest({ direction: 'upload', viaProxy: false }).value.viaProxy, false);
  });
});

describe('primitive validators', () => {
  test('validateUrl', () => {
    assert.equal(validateUrl('https://a.example/x').ok, true);
    assert.equal(validateUrl('http://a.example/x').ok, true);
    assert.equal(validateUrl('javascript:alert(1)').ok, false);
    assert.equal(validateUrl('').ok, false);
  });

  test('validatePort', () => {
    assert.equal(validatePort(LIMITS.PORT_MIN).ok, true);
    assert.equal(validatePort(LIMITS.PORT_MAX).ok, true);
    assert.equal(validatePort(LIMITS.PORT_MIN - 1).ok, false);
    assert.equal(validatePort('10808').ok, false); // strings rejected
  });
});
