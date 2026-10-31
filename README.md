# Northstar V2Ray

> **Honesty notes (please read)**
>
> - Public configurations are third-party endpoints. This project **cannot**
>   verify that they are safe, private, trustworthy or even online. Test before
>   relying on any server.
> - **Connected** means: the local proxy listener is up **and** the configured
>   validation check passed. It does **not** mean every application on your
>   machine is protected.
> - Northstar runs in **local proxy mode** by default. Two **explicit,
>   off-by-default opt-ins** exist in Settings: *System proxy* (points the
>   current user's Windows proxy settings at Northstar while connected, then
>   restores them) and *TUN mode* (routes device traffic through a TUN
>   interface — needs administrator rights; Northstar never elevates itself or
>   changes anything silently).
> - Latency, throughput and session numbers are **measured**, never invented.
>   Unavailable measurements show as `—` / `Unavailable`
>   
---

## Requirements

- **Windows 10/11 x64** to run the packaged app (builds also run on Linux/macOS
  via electron-builder, but only Windows targets are configured here)
- **Node.js 18+** and **npm** for development/builds
- An **Xray-core binary** — bundled automatically at build time by
  `scripts/fetch-core.js`; see [Proxy core](#proxy-core)

---

## Quick start (development)

```bash
npm install          # installs Electron + electron-builder
npm start            # launches the app (Electron)
```

Useful scripts:

```bash
npm run check        # syntax-checks every .js file
npm test             # unit tests (node:test, no external network)
npm run verify       # check + test
npm run fetch:core   # download the pinned Xray core into core/
npm run verify:connect  # real end-to-end check through live servers (network)
npm run pack:win     # Windows unpacked build  -> dist/win-unpacked/
npm run dist:win     # fetches the core, then builds installer + portable exe
node scripts/generate-icon.js   # regenerates build/icon.ico + icon.png
```

---

## Building for Windows

### Option A — the batch script (recommended)

Double-click or run in `cmd.exe`:

```bat
build-windows.bat
```

The script:

1. Checks that `node` and `npm` exist on `PATH` (fails with instructions if not)
2. Installs dependencies (`npm ci` when a lockfile exists, else `npm install`)
3. Runs the automated checks (`npm run verify` — syntax + all unit tests)
4. Builds the distribution with electron-builder
5. Prints the output location on success, or **pauses on failure** so the error
   stays readable

Output lands in `dist/`:

- `Northstar V2Ray-<version>-x64-setup.exe` — **NSIS installer** (per-user
  install, Start Menu + Desktop shortcuts, uninstaller)
- `Northstar V2Ray-<version>-x64-portable.exe` — **portable** executable (both
  targets are produced in the same `dist/` folder)

> The build has been **executed and verified on Linux CI-like environments**
> where possible; the Windows targets themselves are produced by
> electron-builder. See “Testing status” below for exactly what was run.

---

## Usage

1. **First launch** fetches configurations from the source in Settings and
   groups them by country (cached locally for instant startup afterwards).
2. Pick a server on **Servers** (row actions: ping, select, details, copy).
3. Press **Connect** on **Overview**. States: `Disconnected → Connecting →
   Connected`, or `Connection failed` with a specific reason.
4. Point applications at `127.0.0.1:10808` (SOCKS5) / `127.0.0.1:10809` (HTTP)
   — shown live on **Connection** with copy buttons.
5. **Settings** controls fetching, pinging, sorting, ports, validation,
   routing modes (system proxy / TUN), appearance and diagnostics.
6. **Routing modes** (Settings → Connection): *System proxy* applies the
   moment you connect (and follows the toggle live while connected); *TUN
   mode* is checked at connect time and refuses with a clear message if
   Northstar is not running as administrator. Both revert on disconnect.

Keyboard: all controls are focusable with visible focus rings; the server list
defers re-sorting while you hover or focus it, so rows never jump under the
pointer.

---

**Real tunnel check (not a unit test):** `npm run verify:connect` drives the
application's own `ProxyCoreManager` — generated config, spawned core, listener
wait — and then performs one real HTTP request through the tunnel. On
2026-10-30 with Xray-core 26.10.29: 547 configurations parsed, and 3 of 6
tested servers answered `204` through the tunnel (55 ms, 236 ms, 3636 ms); the
other three timed out because those public endpoints are dead or blocked. The
check is deliberately small (a handful of servers, hard timeouts, one request
each) and is **not** part of CI — run it when you want a current answer.

**Not tested in this environment (honest list):**

- GUI launch/rendering — no display in the build environment; run `npm start`
  on a desktop to verify visually
- The packaged Windows installer actually executing on Windows (no Windows
  machine available here) — build via `build-windows.bat` or the CI workflow
- Real public-proxy connectivity **is** covered by `npm run verify:connect`,
  but only for a handful of servers at one point in time; speed-test endpoints
  reached *through* a live tunnel and Windows process-kill behaviour
  (`taskkill`) are still exercised only via fakes/fixtures
- **System proxy mode against real WinINet** — the PowerShell helper's
  capture/apply/restore behaviour is only verified on a real Windows machine;
  here it is exercised through an injected fake executor
- **TUN mode end-to-end** — interface creation, system routes and the
  privilege preflight against a real elevated Windows/Linux process were not run
  here; the preflight logic is unit-tested with injected platform/exec answers

---
# Northstar. internet for everybody or nobody.
