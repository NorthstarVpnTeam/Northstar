# Proxy core (fetched at build time)

Northstar V2Ray ships **Xray-core** with the application. The binaries are not
committed to this repository: `npm run fetch:core` (also run automatically by
`npm run dist:win`) downloads a pinned release from
<https://github.com/XTLS/Xray-core/releases> and unpacks it into this folder:

| File           | Purpose                                    |
| -------------- | ------------------------------------------ |
| `xray.exe`     | the proxy core itself                      |
| `geoip.dat`    | GeoIP routing rules                        |
| `geosite.dat`  | domain routing rules                       |
| `wintun.dll`   | helper used by TUN mode                    |
| `LICENSE`      | Xray-core license (MPL-2.0) — keep with the binary |
| `LICENSE-Wintun` | Wintun license (public domain / MIT-style) |

`electron-builder` ships this folder as `<install>/resources/core/`, and the
application searches there first (`ProxyCoreManager.locate`, source
`bundled`) before checking a configured path, `PATH` and known install
locations.

Before anything is started, the app verifies the binary by running
`<core> version` with a timeout and without a shell, and configuration text is
never passed through a command line.

To use your own build instead, set its full path under
**Settings → Connection → Proxy core path**.

Never place untrusted binaries here: the core runs with your user privileges
and handles all proxy traffic.

## Verifying a real connection

`npm run verify:connect` parses the public configuration source, starts this
core through the application's own connection code, and performs one small
request through each tunnel (a handful of servers, hard timeouts, no
long-running traffic).
