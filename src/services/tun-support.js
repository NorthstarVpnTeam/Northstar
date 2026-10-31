'use strict';

/**
 * TUN mode preflight checks.
 *
 * Xray's TUN inbound creates a network interface and installs system routes.
 * Both are privileged operations, so Northstar refuses to start a TUN connection
 * when the process is not elevated instead of letting the core fail with an
 * opaque error. Northstar never elevates itself: the user relaunches the app
 * with "Run as administrator" if they want TUN mode.
 *
 * Pure Node (no Electron) so it can be unit tested.
 */

const { execFile } = require('child_process');

const ELEVATION_COMMAND =
  '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

const MESSAGES = {
  elevationRequired:
    'TUN mode needs administrator rights to create the network interface and install routes. Close Northstar and relaunch it with "Run as administrator", then connect again.',
  unsupported: (platform) => `TUN mode is not supported on ${platform}.`,
};

function defaultExec(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ...args],
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve({ error, output: String(stdout || '').trim() })
    );
  });
}

/** Returns true when the current Windows process runs elevated. */
async function isWindowsElevated(execImpl = defaultExec, timeoutMs = 8000) {
  const result = await execImpl([ELEVATION_COMMAND], timeoutMs);
  if (result.error) return false;
  // PowerShell ends the answer with a newline.
  return /^true$/i.test(String(result.output || '').trim());
}

/**
 * Checks whether TUN mode can run here.
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {()=>number|null} [options.getuid]
 * @param {Function} [options.execImpl]
 * @returns {Promise<{ok:boolean, code?:string, message?:string, elevated:boolean, platform:string}>}
 */
async function tunRequirements(options = {}) {
  const platform = options.platform || process.platform;
  const getuid =
    options.getuid !== undefined
      ? options.getuid
      : typeof process.getuid === 'function'
        ? process.getuid.bind(process)
        : null;

  if (platform === 'win32') {
    const elevated = await isWindowsElevated(options.execImpl);
    return elevated
      ? { ok: true, elevated: true, platform }
      : { ok: false, code: 'elevation-required', message: MESSAGES.elevationRequired, elevated: false, platform };
  }

  if (platform === 'linux' || platform === 'darwin') {
    const uid = getuid ? getuid() : null;
    if (uid === 0) return { ok: true, elevated: true, platform };
    return {
      ok: false,
      code: 'elevation-required',
      message: 'TUN mode needs root privileges to create the network interface and install routes.',
      elevated: false,
      platform,
    };
  }

  return {
    ok: false,
    code: 'unsupported-platform',
    message: MESSAGES.unsupported(platform),
    elevated: false,
    platform,
  };
}

module.exports = { tunRequirements, isWindowsElevated };