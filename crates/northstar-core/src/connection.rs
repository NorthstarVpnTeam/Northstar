//! Connection lifecycle: generate a core config, start the core, wait for the
//! local listeners, validate the tunnel and tear it down again.
//!
//! The manager owns the child process and the temporary config file. Status is
//! serialised exactly as the renderer expects. Throughput and session totals are
//! reported as unavailable: this build samples no core statistics, and inventing
//! them would break the app's honesty rules.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncRead;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::core_config::{build_core_config, CoreConfigOptions};
use crate::latency::{e2e_through_proxy, socks5_connect, tcp_connect, DEFAULT_VALIDATION_URL};
use crate::now_ms;
use crate::parser::ServerEntry;

const LISTENER_TIMEOUT_MS: u64 = 15_000;
const EVENT_RING: usize = 100;

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub socks_port: u16,
    pub http_port: u16,
    pub validate: bool,
    pub validation_type: String,
    pub timeout_ms: u64,
    pub tun: bool,
    pub log_level: String,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            socks_port: 10_808,
            http_port: 10_809,
            validate: true,
            validation_type: "e2e".into(),
            timeout_ms: 8_000,
            tun: false,
            log_level: "warning".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConnectError {
    pub message: String,
    pub code: &'static str,
}

impl ConnectError {
    fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ConnectError {}

/// True when nothing is listening on the local port and the core can bind it.
fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Keeps the last lines the core printed so a startup failure can name its
/// actual reason instead of only reporting a listener timeout.
fn drain_diagnostics<R>(reader: R, buffer: Arc<Mutex<VecDeque<String>>>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut buffer = buffer.lock().await;
            if buffer.len() >= 40 {
                buffer.pop_front();
            }
            buffer.push_back(line.to_string());
        }
    });
}

async fn diagnostic_tail(buffer: &Mutex<VecDeque<String>>, secrets: &[String]) -> String {
    let buffer = buffer.lock().await;
    let text = buffer
        .iter()
        .rev()
        .take(4)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    let redacted = crate::core_config::redact(&text, secrets);
    if redacted.chars().count() > 700 {
        format!("{}…", redacted.chars().take(700).collect::<String>())
    } else {
        redacted
    }
}

struct Inner {
    state: String,
    server: Option<Value>,
    since: Option<u64>,
    error: Option<String>,
    validation: Option<Value>,
    events: Vec<Value>,
    socks_port: u16,
    http_port: u16,
    mode: String,
    tun: bool,
    system_proxy_active: bool,
    system_proxy_error: Option<String>,
}

pub struct ConnectionManager {
    inner: Mutex<Inner>,
    child: Mutex<Option<Child>>,
    config_path: Mutex<Option<PathBuf>>,
    busy: AtomicBool,
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

fn snapshot(entry: &ServerEntry) -> Value {
    json!({
        "id": entry.id,
        "label": entry.label,
        "protocol": entry.protocol,
        "country": entry.country.clone().unwrap_or_else(|| "Unknown".into()),
        "countryCode": entry.country_code,
        "flag": entry.flag,
        "security": entry.security,
        "network": entry.network,
    })
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                state: "disconnected".into(),
                server: None,
                since: None,
                error: None,
                validation: None,
                events: Vec::new(),
                socks_port: 10_808,
                http_port: 10_809,
                mode: "local-proxy".into(),
                tun: false,
                system_proxy_active: false,
                system_proxy_error: None,
            }),
            child: Mutex::new(None),
            config_path: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }

    /// Current status payload. `core` is the serialised core info.
    pub async fn status(&self, core: Value) -> Value {
        let inner = self.inner.lock().await;
        json!({
            "state": inner.state,
            "serverId": inner.server.as_ref().and_then(|s| s["id"].as_str().map(str::to_string)),
            "server": inner.server,
            "since": inner.since,
            "error": inner.error,
            "validation": inner.validation,
            "socksPort": inner.socks_port,
            "httpPort": inner.http_port,
            "throughput": { "down": null, "up": null, "available": false },
            "session": { "down": 0, "up": 0, "samples": [] },
            "mode": inner.mode,
            "systemProxy": { "active": inner.system_proxy_active, "error": inner.system_proxy_error },
            "tun": { "active": inner.tun },
            "core": core,
        })
    }

    pub async fn events(&self) -> Vec<Value> {
        self.inner.lock().await.events.clone()
    }

    /// Reports the exit status once the running core has died.
    pub async fn core_exited(&self) -> Option<std::process::ExitStatus> {
        let mut child = self.child.lock().await;
        child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
    }

    async fn push_event(&self, kind: &str, message: impl Into<String>) {
        let event = json!({ "ts": now_ms(), "kind": kind, "message": message.into() });
        let mut inner = self.inner.lock().await;
        inner.events.insert(0, event);
        inner.events.truncate(EVENT_RING);
    }

    /// Records whether Northstar currently owns the Windows system proxy.
    /// Applying/restoring it is the command layer's job, not the engine's.
    pub async fn mark_system_proxy(&self, active: bool, error: Option<String>) {
        let mut inner = self.inner.lock().await;
        inner.system_proxy_active = active;
        inner.system_proxy_error = error;
    }

    async fn set_error(&self, message: String) {
        let mut inner = self.inner.lock().await;
        inner.state = "error".into();
        inner.error = Some(message);
        inner.since = None;
    }

    /// Starts the core for `entry`. `emit` receives every intermediate status so
    /// the UI can show Connecting / Connected / failed immediately.
    pub async fn connect<F>(
        &self,
        entry: &ServerEntry,
        options: &ConnectOptions,
        core_path: &Path,
        core: Value,
        mut emit: F,
    ) -> Result<(), ConnectError>
    where
        F: FnMut(Value) + Send,
    {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(ConnectError::new(
                "A connection change is already in progress.",
                "busy",
            ));
        }

        let result = self
            .connect_inner(entry, options, core_path, core, &mut emit)
            .await;
        self.busy.store(false, Ordering::SeqCst);
        result
    }

    async fn connect_inner<F>(
        &self,
        entry: &ServerEntry,
        options: &ConnectOptions,
        core_path: &Path,
        core: Value,
        emit: &mut F,
    ) -> Result<(), ConnectError>
    where
        F: FnMut(Value) + Send,
    {
        if !core_path.is_file() {
            let message = "No usable proxy core found. Set its path in Settings.".to_string();
            self.set_error(message.clone()).await;
            emit(self.status(core).await);
            return Err(ConnectError::new(message, "core-missing"));
        }

        {
            let mut inner = self.inner.lock().await;
            if inner.state == "connected" || inner.state == "connecting" {
                return Err(ConnectError::new(
                    "Disconnect before connecting to another server.",
                    "already-connected",
                ));
            }
            inner.state = "connecting".into();
            inner.error = None;
            inner.validation = None;
            inner.server = Some(snapshot(entry));
            inner.socks_port = options.socks_port;
            inner.http_port = options.http_port;
            inner.mode = if options.tun { "tun" } else { "local-proxy" }.into();
            inner.tun = options.tun;
            inner.system_proxy_active = false;
            inner.system_proxy_error = None;
        }
        self.push_event("info", format!("Connecting to {}", entry.label))
            .await;
        emit(self.status(core.clone()).await);

        // Fail with a clear message before spawning anything if another
        // program (or a stale Northstar) already owns a local port.
        for (name, port) in [("SOCKS", options.socks_port), ("HTTP", options.http_port)] {
            if !port_available(port) {
                let message =
                    format!("Local {name} port {port} is already in use. Change it in Settings.");
                self.set_error(message.clone()).await;
                emit(self.status(core).await);
                return Err(ConnectError::new(message, "port-conflict"));
            }
        }

        let config = match build_core_config(
            entry,
            &CoreConfigOptions {
                socks_port: options.socks_port,
                http_port: options.http_port,
                api_port: 0,
                log_level: options.log_level.clone(),
                tun: options.tun,
            },
        ) {
            Ok(config) => config,
            Err(error) => {
                let message = error.message;
                self.set_error(message.clone()).await;
                emit(self.status(core).await);
                return Err(ConnectError::new(message, error.code));
            }
        };

        let path = std::env::temp_dir().join(format!(
            "northstar-{}-{}.json",
            std::process::id(),
            now_ms()
        ));
        let serialised = match serde_json::to_string_pretty(&config) {
            Ok(text) => text,
            Err(_) => {
                let message = "Could not serialise the core config.".to_string();
                self.set_error(message.clone()).await;
                emit(self.status(core).await);
                return Err(ConnectError::new(message, "config"));
            }
        };
        if let Err(error) = tokio::fs::write(&path, serialised).await {
            let message = format!("Could not write the core config: {error}");
            self.set_error(message.clone()).await;
            emit(self.status(core).await);
            return Err(ConnectError::new(message, "config-write"));
        }

        let diagnostics = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let mut command = Command::new(core_path);
        command
            .arg("run")
            .arg("-c")
            .arg(&path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // The core loads geoip.dat/geosite.dat from its own directory and from
        // this variable; set both so an installed build never depends on the
        // directory the app happened to start in.
        if let Some(dir) = core_path.parent() {
            command.current_dir(dir);
            command.env("XRAY_LOCATION_ASSET", dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = tokio::fs::remove_file(&path).await;
                let message = format!("Could not start the proxy core: {error}");
                self.set_error(message.clone()).await;
                emit(self.status(core).await);
                return Err(ConnectError::new(message, "core-start"));
            }
        };
        // Keep the core's own output so a startup failure can say why it died,
        // and keep draining both pipes so a chatty core can never deadlock.
        if let Some(stdout) = child.stdout.take() {
            drain_diagnostics(stdout, Arc::clone(&diagnostics));
        }
        if let Some(stderr) = child.stderr.take() {
            drain_diagnostics(stderr, Arc::clone(&diagnostics));
        }
        *self.child.lock().await = Some(child);
        *self.config_path.lock().await = Some(path);

        let secrets = crate::core_config::collect_secrets(Some(entry));
        if let Err(error) = self
            .wait_for_listener(
                options.socks_port,
                LISTENER_TIMEOUT_MS,
                &diagnostics,
                &secrets,
            )
            .await
        {
            self.kill_core().await;
            let message = format!(
                "The proxy core did not open its local listener: {}",
                error.message
            );
            self.set_error(message.clone()).await;
            emit(self.status(core).await);
            return Err(ConnectError::new(message, error.code));
        }

        let validation = if options.validate {
            let kind = options.validation_type.clone();
            let timeout = options.timeout_ms.max(1_000);
            let probe = match kind.as_str() {
                "tcp" => tcp_connect("127.0.0.1", options.socks_port, timeout).await,
                "proxy" => {
                    socks5_connect(
                        "127.0.0.1",
                        options.socks_port,
                        "cp.cloudflare.com",
                        80,
                        timeout,
                    )
                    .await
                }
                _ => {
                    e2e_through_proxy(
                        "127.0.0.1",
                        options.http_port,
                        DEFAULT_VALIDATION_URL,
                        timeout,
                    )
                    .await
                }
            };
            json!({
                "ok": probe.ok,
                "kind": kind,
                "ms": probe.ms,
                "code": probe.code,
            })
        } else {
            json!({ "ok": true, "kind": "skipped", "ms": null, "code": null })
        };

        if options.validate && validation["ok"] != true {
            self.kill_core().await;
            let code = validation["code"].as_str().unwrap_or("failed");
            let message = format!("The tunnel validation failed ({code}). Try another server.");
            self.set_error(message.clone()).await;
            self.push_event("error", message.clone()).await;
            emit(self.status(core).await);
            return Err(ConnectError::new(message, "validation"));
        }

        {
            let mut inner = self.inner.lock().await;
            inner.state = "connected".into();
            inner.since = Some(now_ms());
            inner.validation = Some(validation);
            inner.error = None;
        }
        self.push_event(
            "ok",
            format!(
                "Connected to {} · local proxy 127.0.0.1:{}",
                entry.label, options.socks_port
            ),
        )
        .await;
        emit(self.status(core).await);
        Ok(())
    }

    /// Waits for the SOCKS listener, failing fast when the core exits first.
    async fn wait_for_listener(
        &self,
        port: u16,
        timeout_ms: u64,
        diagnostics: &Mutex<VecDeque<String>>,
        secrets: &[String],
    ) -> Result<(), ConnectError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return Ok(());
            }

            let exited = {
                let mut child = self.child.lock().await;
                child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok())
                    .flatten()
            };
            if let Some(status) = exited {
                // Give the pipe readers a moment to deliver the final lines.
                tokio::time::sleep(Duration::from_millis(50)).await;
                let detail = diagnostic_tail(diagnostics, secrets).await;
                let code = status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".into());
                let base =
                    format!("The proxy core exited before opening 127.0.0.1:{port} (exit {code}).");
                let message = if detail.is_empty() {
                    base
                } else {
                    format!("{base} {detail}")
                };
                return Err(ConnectError::new(message, "core-exited"));
            }

            if tokio::time::Instant::now() >= deadline {
                let detail = diagnostic_tail(diagnostics, secrets).await;
                let base = format!("timed out waiting for 127.0.0.1:{port}");
                let message = if detail.is_empty() {
                    base
                } else {
                    format!("{base} ({detail})")
                };
                return Err(ConnectError::new(message, "listener-timeout"));
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    async fn kill_core(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        if let Some(path) = self.config_path.lock().await.take() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    /// Stops the core and resets the status to disconnected.
    pub async fn disconnect<F>(&self, core: Value, mut emit: F) -> Value
    where
        F: FnMut(Value) + Send,
    {
        let already_down = {
            let inner = self.inner.lock().await;
            inner.state == "disconnected" && inner.server.is_none()
        };
        if already_down {
            return self.status(core).await;
        }
        self.inner.lock().await.state = "disconnecting".into();
        emit(self.status(core.clone()).await);
        self.kill_core().await;
        {
            let mut inner = self.inner.lock().await;
            inner.state = "disconnected".into();
            inner.server = None;
            inner.since = None;
            inner.error = None;
            inner.validation = None;
            inner.tun = false;
            inner.system_proxy_active = false;
            inner.system_proxy_error = None;
        }
        self.push_event("info", "Disconnected").await;
        emit(self.status(core).await);
        self.inner.lock().await.state.clone().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn starts_disconnected_with_unavailable_throughput() {
        let manager = ConnectionManager::new();
        let status = manager.status(json!({ "found": false })).await;
        assert_eq!(status["state"], "disconnected");
        assert_eq!(status["throughput"]["available"], false);
        assert_eq!(status["socksPort"], 10_808);
        assert_eq!(status["server"], Value::Null);
    }

    #[tokio::test]
    async fn missing_core_fails_without_spawning_anything() {
        let manager = ConnectionManager::new();
        let entry = crate::parser::parse_config("trojan://pw@1.2.3.4:443#Test").unwrap();
        let error = manager
            .connect(
                &entry,
                &ConnectOptions::default(),
                Path::new("/nonexistent/xray"),
                json!({ "found": false }),
                |_| {},
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "core-missing");
        assert_eq!(manager.status(json!({})).await["state"], "error");
    }

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn busy_local_port_fails_before_spawning() {
        let dir = tempfile::tempdir().unwrap();
        let core = dir.path().join("xray");
        std::fs::write(&core, b"not a core").unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = listener.local_addr().unwrap().port();
        let entry = crate::parser::parse_config("trojan://pw@1.2.3.4:443#Test").unwrap();
        let error = ConnectionManager::new()
            .connect(
                &entry,
                &ConnectOptions {
                    socks_port: taken,
                    http_port: free_port(),
                    validate: false,
                    ..ConnectOptions::default()
                },
                &core,
                json!({}),
                |_| {},
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "port-conflict");
        assert!(error.message.contains("already in use"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn core_exit_reports_its_own_error() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let core = dir.path().join("fake-core");
        std::fs::write(
            &core,
            "#!/bin/sh\necho 'boom: invalid config' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&core, std::fs::Permissions::from_mode(0o755)).unwrap();
        let entry = crate::parser::parse_config("trojan://pw@1.2.3.4:443#Test").unwrap();
        let error = ConnectionManager::new()
            .connect(
                &entry,
                &ConnectOptions {
                    socks_port: free_port(),
                    http_port: free_port(),
                    validate: false,
                    ..ConnectOptions::default()
                },
                &core,
                json!({}),
                |_| {},
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "core-exited");
        assert!(
            error.message.contains("boom: invalid config"),
            "{} was hidden",
            error.message
        );
    }

    #[tokio::test]
    async fn disconnect_is_idempotent() {
        let manager = ConnectionManager::new();
        let status = manager.disconnect(json!({}), |_| {}).await;
        assert_eq!(status["state"], "disconnected");
    }
}
