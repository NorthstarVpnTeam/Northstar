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

- **Windows 10/11 x64** — the UI runs in the WebView2 runtime that ships with
  Windows, so no browser engine is bundled
- **Rust 1.77+** via [rustup](https://rustup.rs/), with the MSVC toolchain on
  Windows for release builds
- **Node.js 18+** and **npm** — only for the Tauri CLI and the core downloader
- An **Xray-core binary** — bundled automatically at build time by
  `scripts/fetch-core.js`; see [Proxy core](#proxy-core)

---

## Quick start (development)

```bash
npm install          # installs the Tauri CLI
npm run dev          # compiles the Rust backend and launches the app
```

Useful scripts:

```bash
npm run check        # syntax-checks the interface and legacy .js files
npm run test:rust    # Rust engine tests (cargo test, no network)
npm test             # legacy Electron service tests (kept for reference)
npm run verify       # check + both test suites
npm run fetch:core   # download the pinned Xray core into core/
npm run build        # fetches the core, then builds NSIS + MSI installers
npm run pack:win     # release executable without installers
node scripts/generate-icon.js   # regenerates build/icon.ico + icon.png
```

---

## Architecture (Rust)

- **`src-tauri/`** — the desktop app: a Tauri window, one `northstar_call`
  command and the event bridge. This replaces Electron's main and preload
  processes; there is no bundled Chromium.
- **`crates/northstar-core/`** — the engine, unit tested without a GUI:
  settings, configuration fetching and parsing, country detection, the server
  store, latency probes, Xray config generation, the connection lifecycle, the
  speed test and redacted logging.
- **`src/renderer/`** — the interface (HTML/CSS/ES modules).
  `tauri-bridge.js` installs the same `window.northstar` API the renderer has
  always used, backed by Rust commands instead of IPC to Electron.
- **Legacy Electron sources** (`src/main`, `src/preload`, `src/services`,
  `src/shared`, `tests/`) are kept for reference and are **not** built or
  started. Their tests still run as documentation of the original behaviour.

Typical footprint: the app itself is a single-digit-MB Rust binary; with the
bundled Xray core and geo data an install is roughly 50–60 MB, versus
150–250 MB with a bundled Chromium runtime.

---

## Building for Windows

### Option A — the batch script (recommended)

Double-click or run in `cmd.exe`:

```bat
build-windows.bat
```

The script:

1. Checks `node`, `npm`, `cargo` and `rustc` are on `PATH`
2. Installs the Tauri CLI (`npm ci` when a lockfile exists, else `npm install`)
3. Runs the automated checks (`npm run verify` — JS syntax/tests + Rust tests)
4. Downloads the pinned Xray core into `core/`
5. Builds the release app and installers with Tauri
6. Prints the output folders on success, or **pauses on failure** so the error
   stays readable

Output lands in `src-tauri/target/release/bundle/`:

- `nsis/Northstar V2Ray_<version>_x64-setup.exe` — standard NSIS installer
  (per-user install, Start Menu shortcut, uninstaller)
- `msi/Northstar V2Ray_<version>_x64_en-US.msi` — MSI package

The executable itself is a small Rust binary; the interface uses the Windows
WebView2 runtime, so no browser engine is shipped.

> The engine crate is built and tested in this repository. The Tauri shell is
> compiled by `build-windows.bat` on Windows (or CI); see “Testing status”.
>
> CI equivalent: `.github/workflows/build.yml` runs `npm run verify`, fetches
> the pinned Xray core and runs `npx tauri build` on `windows-latest`, then
> uploads the NSIS installer and MSI as workflow artifacts.
>
> Pushing a tag such as `v2.0.0` also publishes those two installers to a
> GitHub Release with generated notes; ordinary pushes only produce artifacts.

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

- GUI launch/rendering — no display in the build environment; run `npm run dev`
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
- **Real-delay measurement and Xray stats** — the Rust build does not implement
  the per-server real-delay probe and does not read Xray's stats API, so
  throughput/session totals are shown as unavailable instead of made up.
  System proxy mode *is* implemented on Windows: it is applied after validation,
  follows its toggle while connected, and is restored on disconnect, on exit,
  and on the next launch after a crash. TCP/HTTP latency, local proxy (SOCKS +
  HTTP) and TUN pass-through are wired.
- **The Tauri shell itself** — this environment lacks the WebKitGTK development
  libraries, so the app crate could not be compiled here. The Rust engine crate
  (`crates/northstar-core`) is built and tested here; the shell needs
  `build-windows.bat` on Windows (or a Linux machine with Tauri's system deps)

---
# Northstar. internet for everybody or nobody.
