'use strict';

/**
 * SettingsService persistence tests: writes, debounced flush, corruption
 * recovery, cross-field validation and change notifications.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsService } = require('../src/services/settings-service');
const { DEFAULT_SETTINGS } = require('../src/shared/constants');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-settings-'));
}

describe('SettingsService', () => {
  let dir;

  before(() => {
    dir = tempDir();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('starts with defaults when no file exists', () => {
    const svc = new SettingsService(path.join(dir, 'fresh'));
    assert.deepEqual(svc.get(), DEFAULT_SETTINGS);
  });

  test('valid updates are applied and broadcast', () => {
    const seen = [];
    const svc = new SettingsService(path.join(dir, 'update'), {
      onChanged: (s) => seen.push(s.pingTimeoutMs),
    });
    const result = svc.update({ pingTimeoutMs: 7500 });
    assert.equal(result.ok, true);
    assert.equal(svc.get().pingTimeoutMs, 7500);
    assert.deepEqual(seen, [7500]);
  });

  test('invalid updates are rejected without side effects', () => {
    const svc = new SettingsService(path.join(dir, 'reject'));
    const result = svc.update({ pingTimeoutMs: 10 });
    assert.equal(result.ok, false);
    assert.equal(svc.get().pingTimeoutMs, DEFAULT_SETTINGS.pingTimeoutMs);
  });

  test('cross-field conflict: same socks and http port', () => {
    const svc = new SettingsService(path.join(dir, 'ports'));
    const result = svc.update({ socksPort: 20001, httpPort: 20001 });
    assert.equal(result.ok, false);
    assert.match(result.error, /differ/);
    assert.equal(svc.get().socksPort, DEFAULT_SETTINGS.socksPort);
  });

  test('persists across instances (flush writes file)', () => {
    const fileDir = path.join(dir, 'persist');
    const a = new SettingsService(fileDir);
    a.update({ autoPing: false, theme: 'dark' });
    a.flush();

    const b = new SettingsService(fileDir);
    assert.equal(b.get().autoPing, false);
    assert.equal(b.get().theme, 'dark');
    assert.equal(b.get().pingTimeoutMs, DEFAULT_SETTINGS.pingTimeoutMs);
  });

  test('recovers from a corrupted settings file', () => {
    const corruptDir = path.join(dir, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'settings.json'), '{ this is not json', 'utf8');

    const svc = new SettingsService(corruptDir);
    assert.deepEqual(svc.get(), DEFAULT_SETTINGS);
    // The bad file is preserved as a .corrupt-* backup, not deleted.
    const files = fs.readdirSync(corruptDir);
    assert.ok(files.some((f) => f.startsWith('settings.json.corrupt-')));
  });

  test('restores factory defaults', () => {
    const svc = new SettingsService(path.join(dir, 'reset'));
    svc.update({ pingTimeoutMs: 9999, theme: 'dark' });
    const reset = svc.reset();
    assert.equal(reset.pingTimeoutMs, DEFAULT_SETTINGS.pingTimeoutMs);
    assert.equal(reset.theme, DEFAULT_SETTINGS.theme);
  });
});
