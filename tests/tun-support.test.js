'use strict';

/**
 * TUN preflight tests: platform and privilege detection. These decide whether
 * Northstar even attempts a TUN connection, so failures must be explicit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { tunRequirements, isWindowsElevated } = require('../src/services/tun-support');

const winExec = (output) => async () => ({ error: null, output });

describe('tunRequirements', () => {
  test('Windows elevated passes', async () => {
    const result = await tunRequirements({ platform: 'win32', execImpl: winExec('True') });
    assert.deepEqual(result, { ok: true, elevated: true, platform: 'win32' });
  });

  test('Windows without elevation is refused with an actionable message', async () => {
    const result = await tunRequirements({ platform: 'win32', execImpl: winExec('False') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'elevation-required');
    assert.match(result.message, /Run as administrator/i);
  });

  test('a failed elevation probe is treated as not elevated', async () => {
    const result = await tunRequirements({
      platform: 'win32',
      execImpl: async () => ({ error: new Error('powershell missing'), output: '' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'elevation-required');
  });

  test('Linux requires root', async () => {
    const ok = await tunRequirements({ platform: 'linux', getuid: () => 0 });
    assert.equal(ok.ok, true);
    assert.equal(ok.elevated, true);

    const denied = await tunRequirements({ platform: 'linux', getuid: () => 1000 });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'elevation-required');
    assert.match(denied.message, /root/i);
  });

  test('unsupported platforms are refused explicitly', async () => {
    const result = await tunRequirements({ platform: 'sunos', getuid: () => 0 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported-platform');
    assert.match(result.message, /not supported/i);
  });
});

describe('isWindowsElevated', () => {
  test('parses the PowerShell answer case-insensitively', async () => {
    assert.equal(await isWindowsElevated(winExec('true')), true);
    assert.equal(await isWindowsElevated(winExec('TRUE\n')), true);
    assert.equal(await isWindowsElevated(winExec('False')), false);
    assert.equal(await isWindowsElevated(winExec('')), false);
    assert.equal(
      await isWindowsElevated(async () => ({ error: new Error('x'), output: 'True' })),
      false
    );
  });
});