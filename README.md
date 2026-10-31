# Northstar V2Ray

A polished V2Ray-compatible **configuration manager and local proxy client** for
Windows, built with Electron. Clean Apple-inspired interface, honest metrics,
real proxy-core integration — no fake servers, no simulated connections.

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
>   Unavailable measurements show as `—` / `Unavailable`.

---

## Features

| Area | What works today |
| --- | --- |
| Configuration source | Downloads `all_configs.txt` (configurable) with timeouts, size caps, progress, per-line error reporting and deduplication |
| Protocols | VLESS, VMess, Trojan, Shadowsocks, SOCKS, HTTP — defensive parsing, malformed lines never crash the app |
| Grouping | Expandable/country groups with flags, conservative detection (`Unknown` bucket instead of guessing), `Netherlands 001 → Netherlands 01` label normalization |
| Server browser | Search (label/country/protocol), protocol + status filters, latency/name/country/protocol sorting, auto-sort, manual & bulk ping, details view with masked credentials, copy configuration |
| Latency | Three honest measurement kinds — **TCP connect** (direct), **SOCKS handshake** (through core), **end-to-end HTTP** (through core). Configurable timeout (500–10,000 ms), concurrency cap, cancellation, auto-ping with interval control |
| Connection | Real Xray/V2Ray core integration: config generation, private temp config file, `spawn` without shell, listener readiness check, port-conflict preflight, validation gating, unexpected-exit detection, clean shutdown |
| Routing modes | Two toggles in Settings, both **off by default**: **System proxy** (WinINet per-user proxy → local HTTP port while connected, previous settings captured and restored on disconnect; never overwrites changes made by other programs) and **TUN mode** (Xray `tun` inbound with system routes + loop-avoiding outbound binding, privilege preflight before the core starts) |
| Throughput | Sampled from the core's **stats API** every 2 s (real byte counters). If the API can't be queried, throughput shows as unavailable |
| Speed test | User-initiated download/upload against `speed.cloudflare.com`, byte+time based, cancellable, destination stated, never runs in background |
| Settings | Persistent, validated: source URL (masked by default, revealable), auto-refresh, auto-ping, timeout, interval, auto-sort, ports, validation type, connect-on-launch, core path, theme, reduced motion, compact rows. Re-renders are deferred while a field has focus, so background events can't swallow in-progress edits |
| Window shell | Frameless window with a macOS-style traffic-light titlebar (close / minimize / maximize), draggable, double-click to maximize, state mirrored back over allowlisted IPC |
| Diagnostics | Redacted logs (no credentials/URIs), redacted JSON export, cache management, troubleshooting guide |
| Security | Context isolation, sandboxed renderer, restricted preload bridge, allowlisted+validated IPC, no shell string interpolation, secrets redacted from logs |

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

### Option B — manual

```bash
npm ci
npm run verify
npm run dist:win      # or: npx electron-builder --win
```

### Option C — GitHub Actions

- `.github/workflows/ci.yml` runs the syntax gate and the full unit-test
  suite on `ubuntu-latest` for every push and pull request to `main`.
- `.github/workflows/build.yml` runs the same checks, then builds the Windows
  distribution (NSIS installer + portable exe) on `windows-latest` and uploads
  the `.exe`/`.yml`/`.blockmap` outputs as a workflow artifact on every push,
  tag and manual run. Code signing is skipped explicitly
  (`CSC_IDENTITY_AUTO_DISCOVERY=false`) since no certificate is configured.

---

## Proxy core

Northstar drives an **Xray-compatible core** (Xray-core recommended; V2Ray v5+
also works) through a generated JSON config:

- **Locate:** the packaged app finds the bundled core first
  (`<app>/resources/core/`). In development, use `npm run fetch:core`, or set
  `Settings → Connection → Core path` → Browse…; with an empty path the search
  continues through the app `core/` folder → system `PATH` → common install
  dirs. The binary is verified with `<core> version` (4 s timeout) before use.
- **Start:** config is written to a private temp file (`0600`) and passed via
  `spawn(core, ['run', '-c', file])` — never through a shell. The local SOCKS
  listener must accept a connection before `connected` is reported; with
  *Validate on connect* enabled, an end-to-end check must pass too.
- **Stop:** SIGTERM (taskkill on Windows) with a 4 s force-kill fallback, and
  the temp config is deleted. Child processes are killed on disconnect and on
  app exit.
- **Failures** are surfaced honestly: missing core, port conflicts, invalid
  configs (unsupported transport, missing Reality `pbk`, …), startup exits and
  unexpected terminations all produce specific messages.

Licensing: Xray-core is **MPL-2.0** and V2Ray is **MIT**. If you redistribute
a core binary with the app, include its license — see `core/README.md`.

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

## Architecture

```
package.json            dependencies, scripts, electron-builder config
build-windows.bat       Windows build entry point
build/                  generated icon (icon.ico / icon.png)
core/                   Xray core + geo files, fetched at build time
                        (gitignored; see core/README.md)
src/
  main/
    main.js             lifecycle, services wiring, background timers
    ipc.js              every IPC handler (validated, wrapped)
    window.js           hardened BrowserWindow creation
  preload/
    preload.js          allowlisted contextBridge API (the only bridge)
  renderer/
    index.html          shell + CSP
    styles.css          design system (light/dark, responsive, reduced motion)
    app.js              state, navigation, event wiring, actions
    ui.js               DOM helpers, formatters, toasts, modals
    components/chart.js canvas activity chart (real samples)
    views/              overview, servers, connection, settings, about
  services/
    configuration-fetcher.js   timeout/size-limited downloads + progress
    configuration-parser.js    defensive VLESS/VMess/Trojan/SS/SOCKS/HTTP
    country-detector.js        flag + conservative name detection
    server-store.js            grouping, sorting, filtering, selection
    latency-service.js         tcp / socks5 / e2e measurements, pooling
    core-config.js             Xray config generation + secret redaction
    proxy-core-manager.js      core discovery, spawn, monitoring, cleanup
    connection-manager.js      state machine, validation, stats polling
    system-proxy-service.js    reversible Windows per-user proxy mode
    tun-support.js             TUN platform/privilege preflight
    speed-test-service.js      cancellable byte/time speed tests
    settings-service.js        validated, atomic, corruption-tolerant
    logger.js                  redacted ring-buffer logger
  shared/
    constants.js               IPC channels, defaults, limits
    validation.js              payload/settings validation
tests/                        node:test suites (see below)
scripts/
  check-syntax.js              syntax gate for every JS file
  generate-icon.js             dependency-free icon generator
  system-proxy.ps1             WinINet capture/apply/restore helper (no shell)
```

**Security model:** renderer runs sandboxed with context isolation and no Node
access; the preload exposes only allowlisted invoke/event channels; every IPC
payload is validated in the main process; identifiers are pattern-checked;
config text never reaches a shell; logs and diagnostics are redacted.

---

## Testing status

Run with `npm run verify` (Node's built-in test runner, no external network —
loopback sockets and local HTTP fixtures only):

| Suite | Coverage |
| --- | --- |
| `parser.test.js` | valid/malformed entries per scheme, URL-encoded fragments, IPv6, base64/base64url VMess, SIP002, unsupported schemes, document stats + dedup |
| `normalization.test.js` | label normalization rules, flag/name country detection, conservative unknowns |
| `store.test.js` | grouping, sorting, filters, selection lifecycle, no-credential leakage |
| `validation.test.js` | settings bounds/enums/types, IPC payload shapes, corrupt-settings coercion |
| `settings.test.js` | persistence, corruption recovery, cross-field port conflict, reset |
| `core-config.test.js` | per-protocol outbounds, stream settings, rejections, secret redaction |
| `latency.test.js` | real loopback TCP timing, SOCKS5 handshake success/reject fixtures, pooling, offline honesty |
| `connection-manager.test.js` | full lifecycle with fake core: validation gating, error paths, switching, cleanup, exit handling; system-proxy apply/restore/toggle/restore-failure, TUN preflight + config flag, mode labels, reconnect-reason detection, SOCKS+TUN stats aggregation |
| `fetcher.test.js` | local HTTP server: success, 404, content-type, size cap, cancellation, refused connections |
| `consistency.test.js` | preload channel allowlists vs constants, constant sanity |
| `system-proxy.test.js` | helper output parsing (BOM/noise/garbage), capture→apply→restore ordering, idempotence, failed helper calls, missing script, invalid ports, non-Windows refusal (PowerShell executor is faked) |
| `tun-support.test.js` | Windows elevation probe parsing (incl. trailing newline), failed probes treated as unprivileged, Linux root/uid checks, unsupported platforms |

**Latest run:** 187/187 tests pass, 43/43 files pass syntax check.

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

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| “No proxy core found” | Install Xray-core, set its path in Settings → Connection, or drop `xray.exe` in `core/` |
| “Local SOCKS port … already in use” | Change the port in Settings → Connection; something else holds it |
| “Connection validation failed” | Server likely unreachable/blocked/invalid — try another server or switch validation type (Settings) |
| Refresh fails / offline | Cached servers still load; check the source URL in Settings and your network |
| DNS errors while connected | The core resolves through the tunnel; a dead upstream server shows up as validation failure |
| App feels stuck | Connection attempts and fetches have hard timeouts; check **Connection → Diagnostics** (redacted) |
| “TUN mode needs administrator rights” | Close Northstar and relaunch it with *Run as administrator*, then connect again. Northstar never elevates itself |
| System proxy not restored on quit | Settings → Connection notes the mode is active; Windows proxy settings are restored on disconnect/quit — if a crash prevented it, reset them in Windows *Settings → Proxy* |

---

## Dependencies & licenses

| Package | License | Purpose |
| --- | --- | --- |
| `electron` 45 | MIT | desktop shell |
| `electron-builder` 26 | MIT | Windows packaging |
| Xray-core | MPL-2.0 | proxy core — fetched from the official releases into `core/` at build time and shipped in the installer |
| `system-proxy.ps1` helper | MIT (part of this project) | per-user WinINet proxy capture/apply/restore; uses only Windows' own `wininet.dll` |

Runtime code has **zero** production npm dependencies (Node stdlib only).

---

## Limitations

1. **Routing modes are opt-in and platform-specific.** *System proxy* works
   only on Windows, only for apps that honour the per-user proxy, and only
   while a connection is up. *TUN mode* needs administrator rights (Windows) /
   root (Linux), creates a real network interface and system routes, and can
   only be verified on a real machine — it is preflighted but marked **not
   tested** here. Neither mode is a system-wide VPN in the firewall-split-tunnel
   sense; use them deliberately.
2. **Core fetched at build time** — a pinned Xray-core release (MPL-2.0) is
   downloaded from the official Xray-core releases by `scripts/fetch-core.js`
   during `npm run dist:win`, verified with `<core> version`, and shipped as
   `resources/core/`. Nothing is committed to this repository and nothing is
   downloaded at runtime; building therefore needs network access once per
   machine (`npm run fetch:core` runs it standalone).
3. **Windows packaging not executed here** — the workflow and scripts are
   complete and CI-built; run `build-windows.bat` locally or use the Actions
   artifact.
4. **GUI not visually verified** in this environment (headless).
5. **Public config quality** is out of our control: expect dead, malicious or
   slow servers. The app measures and labels them honestly instead of
   pretending.
6. Throughput requires the core **stats API**; if the CLI query fails,
   throughput is shown as unavailable rather than estimated.
7. Speed tests hit `speed.cloudflare.com` — third-party availability applies;
   failures are reported, not faked.

## License

MIT — see [LICENSE](LICENSE).