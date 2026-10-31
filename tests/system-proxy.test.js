'use strict';

/**
 * System proxy service tests. The PowerShell helper is never executed: a fake
 * executor stands in, so these tests cover the control flow, output parsing
 * and the "never clobber somebody else's proxy" bookkeeping only. Actual
 * WinINet behaviour is Windows-only and is marked untested in the README.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SystemProxyService, parseOutput } = require('../src/services/system-proxy-service');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-sysproxy-'));
}

const SNAPSHOT = {
  flags: 1,
  proxyServer: 'old.proxy:8080',
  proxyBypass: '<local>',
  autoConfigUrl: '',
  autoDiscoveryFlags: 0,
};

/** Fake executor that records calls and answers like the PS1 helper. */
function makeExec({ failAction = null, error = null, extraOutput = '' } = {}) {
  const calls = [];
  const exec = async (scriptPath, action, input) => {
    calls.push({ scriptPath, action, input: JSON.parse(input || '{}') });
    if (failAction === action) {
      return { error: new Error('exit 1'), code: 1, stdout: '', stderr: 'boom' };
    }
    if (error) return { error: new Error(error), code: null, stdout: '', stderr: '' };
    let stdout;
    if (action === 'capture') stdout = JSON.stringify({ ok: true, snapshot: SNAPSHOT });
    else if (action === 'apply')
      stdout = JSON.stringify({
        ok: true,
        proxyServer: `127.0.0.1:${calls[calls.length - 1].input.port}`,
        proxyBypass: '<local>;localhost',
      });
    else stdout = JSON.stringify({ ok: true, restored: true });
    return { error: null, code: 0, stdout: extraOutput + stdout, stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

describe('parseOutput', () => {
  test('parses a bare JSON object', () => {
    assert.deepEqual(parseOutput('{"ok":true}'), { ok: true });
  });

  test('tolerates a BOM, whitespace and surrounding noise', () => {
    assert.deepEqual(parseOutput('\uFEFF\n  {"ok":true}\n'), { ok: true });
    assert.deepEqual(parseOutput('WARNING: stuff\n{"ok":true,"restored":false}'), {
      ok: true,
      restored: false,
    });
  });

  test('returns null for empty or unusable output', () => {
    assert.equal(parseOutput(''), null);
    assert.equal(parseOutput(null), null);
    assert.equal(parseOutput('not json at all'), null);
    assert.equal(parseOutput('{"broken":'), null);
  });
});

describe('SystemProxyService', () => {
  let dir;

  before(() => {
    dir = tempDir();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses to run on unsupported platforms without spawning anything', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'linux', userDataDir: dir, execImpl: exec });
    assert.equal(svc.supported, false);
    const result = await svc.apply(10809);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported-platform');
    assert.equal(exec.calls.length, 0);
  });

  test('apply captures the previous settings, then sets the local port', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });

    const result = await svc.apply(10809);
    assert.equal(result.ok, true);
    assert.equal(svc.active, true);
    assert.deepEqual(svc.snapshot, SNAPSHOT);
    assert.deepEqual(
      exec.calls.map((c) => c.action),
      ['capture', 'apply']
    );
    assert.equal(exec.calls[1].input.port, 10809);

    // The helper script was materialized to a real path for PowerShell.
    assert.ok(fs.existsSync(exec.calls[0].scriptPath));
    assert.match(exec.calls[0].scriptPath, /system-proxy\.ps1$/);
  });

  test('apply is idempotent while active', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    await svc.apply(10809);
    const again = await svc.apply(10809);
    assert.equal(again.ok, true);
    assert.equal(again.alreadyApplied, true);
    assert.equal(exec.calls.filter((c) => c.action === 'apply').length, 1);
  });

  test('restore sends the saved snapshot and deactivates', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    await svc.apply(10809);

    const result = await svc.restore();
    assert.equal(result.ok, true);
    assert.equal(result.restored, true);
    assert.equal(svc.active, false);
    assert.equal(svc.snapshot, null);

    const restoreCall = exec.calls.find((c) => c.action === 'restore');
    assert.deepEqual(restoreCall.input.snapshot, SNAPSHOT);
    assert.equal(restoreCall.input.appliedProxyServer, '127.0.0.1:10809');
  });

  test('restore without an active proxy is a no-op', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    const result = await svc.restore();
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'not-applied');
    assert.equal(exec.calls.length, 0);
  });

  test('a failed helper call reports an error instead of claiming success', async () => {
    const exec = makeExec({ failAction: 'apply' });
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    const result = await svc.apply(10809);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'helper-failed');
    assert.equal(svc.active, false);
    assert.equal(svc.snapshot, null);
  });

  test('process-level failures surface with a readable message', async () => {
    const exec = makeExec({ error: 'ENOENT' });
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    const result = await svc.apply(10809);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'helper-failed');
    assert.match(result.error, /ENOENT/);
  });

  test('a missing helper script is reported, not silently skipped', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({
      platform: 'win32',
      userDataDir: tempDir(),
      execImpl: exec,
      scriptSourcePath: path.join(dir, 'does-not-exist.ps1'),
    });
    const result = await svc.apply(10809);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'script-missing');
    assert.equal(exec.calls.length, 0);
  });

  test('invalid ports are rejected before anything runs', async () => {
    const exec = makeExec();
    const svc = new SystemProxyService({ platform: 'win32', userDataDir: dir, execImpl: exec });
    for (const port of [0, 70000, 1.5, 'abc', null]) {
      const result = await svc.apply(port);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'invalid-port');
    }
    assert.equal(exec.calls.length, 0);
  });
});