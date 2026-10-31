'use strict';

/**
 * Fetches a pinned Xray-core release and unpacks it into `core/`.
 *
 * The binary is NOT committed to the repository: CI and local builds call this
 * script first, and electron-builder ships whatever is in `core/` as
 * `<app>/resources/core/` (see `build.extraResources` in package.json).
 *
 * Usage:
 *   node scripts/fetch-core.js                     # platform auto-detected
 *   node scripts/fetch-core.js --platform win32    # Windows core (dist:win)
 *   node scripts/fetch-core.js --force             # re-download even if present
 *   XRAY_VERSION=26.10.29 node scripts/fetch-core.js
 *
 * Only well-known file names from the release archive are ever written, the
 * archive is unpacked into `core/` (never executed from the temp directory),
 * and the result is verified by running `<core> version`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { execFile } = require('child_process');

/** Pinned so builds are reproducible; bump deliberately. */
const XRAY_VERSION = process.env.XRAY_VERSION || '26.10.29';

const ASSETS = {
  win32: 'Xray-windows-64.zip',
  linux: 'Xray-linux-64.zip',
  darwin: 'Xray-macos-64.zip',
};

/** Only these archive members are extracted (no path traversal, no surprises). */
const ALLOWED = new Set([
  'xray',
  'xray.exe',
  'geoip.dat',
  'geosite.dat',
  'wintun.dll',
  'LICENSE',
  'LICENSE-Wintun',
]);

const CORE_DIR = path.join(__dirname, '..', 'core');
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`fetch-core: ${message}\n`);
  process.exit(1);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (target, redirectsLeft) => {
      https
        .get(target, { headers: { 'user-agent': 'northstar-v2ray-build' } }, (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            request(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} for ${target}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(dest)));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    request(url, 5);
  });
}

/**
 * Minimal ZIP reader (central directory + stored/deflated entries).
 * The Xray release archives are ordinary zips well below 4 GB.
 */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (end-of-central-directory missing)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function extractEntry(buffer, entry, name) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  }
  throw new Error(`unsupported compression method ${entry.method} for ${name}`);
}

function verifyCore(binary) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['version'], { timeout: 15000, windowsHide: true, shell: false }, (err, stdout) => {
      if (err) reject(new Error(`\`${path.basename(binary)} version\` failed: ${err.message}`));
      else resolve(String(stdout || '').trim());
    });
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const platformIndex = process.argv.indexOf('--platform');
  const targetPlatform =
    platformIndex >= 0 && process.argv[platformIndex + 1]
      ? process.argv[platformIndex + 1]
      : process.platform;

  const asset = ASSETS[targetPlatform];
  if (!asset) fail(`unsupported target platform "${targetPlatform}" — set the core path in Settings instead.`);

  const binaryName = targetPlatform === 'win32' ? 'xray.exe' : 'xray';
  const binaryPath = path.join(CORE_DIR, binaryName);

  if (!force && fs.existsSync(binaryPath)) {
    try {
      const version = await verifyCore(binaryPath);
      process.stdout.write(`fetch-core: already present — ${version.split('\n')[0]}\n`);
      return;
    } catch {
      // fall through and re-download a broken/stale copy
    }
  }

  const url = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${asset}`;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'northstar-core-'));
  const zipPath = path.join(tmpDir, asset);

  process.stdout.write(`fetch-core: downloading ${url}\n`);
  await download(url, zipPath);

  const buffer = await fs.promises.readFile(zipPath);
  const entries = readZip(buffer);

  await fs.promises.mkdir(CORE_DIR, { recursive: true });

  // Never leave the other platform's core in the folder: it would be shipped
  // by extraResources and only wastes megabytes in the installer.
  for (const name of ['xray', 'xray.exe']) {
    if (name !== binaryName) await fs.promises.rm(path.join(CORE_DIR, name), { force: true });
  }
  const written = [];
  for (const [name, entry] of entries) {
    if (!ALLOWED.has(name)) continue;
    const data = extractEntry(buffer, entry, name);
    const target = path.join(CORE_DIR, name);
    await fs.promises.writeFile(target, data);
    if (name === 'xray' || name === 'xray.exe') {
      await fs.promises.chmod(target, 0o755);
    }
    written.push(`${name} (${data.length} bytes)`);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });

  if (!fs.existsSync(binaryPath)) fail(`archive did not contain ${binaryName}.`);

  // Only verify when we unpacked a core for the machine we are running on;
  // a cross-build (e.g. win64 core prepared on Linux) cannot be executed here.
  if (targetPlatform === process.platform) {
    try {
      const version = await verifyCore(binaryPath);
      process.stdout.write(`fetch-core: installed into core/ — ${version.split('\n')[0]}\n`);
      process.stdout.write(`fetch-core: ${written.join(', ')}\n`);
    } catch (err) {
      fail(err.message);
    }
  } else {
    process.stdout.write(
      `fetch-core: unpacked the ${targetPlatform} core into core/ (not executable on this host)\n`
    );
    process.stdout.write(`fetch-core: ${written.join(', ')}\n`);
  }
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
