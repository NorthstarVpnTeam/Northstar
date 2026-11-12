//! Windows per-user system proxy (WinINet) management.
//!
//! While a connection is active the user can ask Northstar to point Windows'
//! proxy settings at the local HTTP proxy, so applications that follow the
//! system proxy route through the tunnel. The previous settings are captured
//! first and restored on disconnect. If another program changed the proxy in
//! the meantime, the restore is skipped rather than clobbering it.
//!
//! The WinINet work happens in `scripts/system-proxy.ps1`, embedded at compile
//! time and materialised into the app's data directory before it is executed.
//! Only the well-known capture/apply/restore actions are ever invoked, with
//! JSON over stdin, and nothing runs on non-Windows platforms.
//!
//! An applied snapshot is persisted to disk so a crash or a forced exit cannot
//! leave Windows pointing at a dead local port forever: the next launch
//! restores it before doing anything else.

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SCRIPT_SOURCE: &str = include_str!("../../../scripts/system-proxy.ps1");
const HELPER_TIMEOUT_MS: u64 = 15_000;
const STATE_FILE: &str = "system-proxy-state.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub supported: bool,
    pub active: bool,
    pub proxy_server: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProxyError {
    pub code: &'static str,
    pub message: String,
}

impl ProxyError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProxyError {}

#[derive(Debug, Clone)]
pub struct RestoreResult {
    pub restored: bool,
    pub reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Persisted {
    snapshot: Value,
    applied_proxy_server: String,
    applied_proxy_bypass: String,
}

#[derive(Debug, Clone)]
struct Applied {
    proxy_server: String,
    proxy_bypass: String,
}

/// Owns the previous proxy snapshot and the values Northstar applied.
pub struct SystemProxy {
    supported: bool,
    dir: PathBuf,
    script_path: Option<PathBuf>,
    snapshot: Option<Value>,
    applied: Option<Applied>,
    persisted: Option<Persisted>,
    last_error: Option<String>,
}

impl SystemProxy {
    pub fn new(dir: PathBuf) -> Self {
        let persisted = std::fs::read_to_string(dir.join(STATE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<Persisted>(&text).ok());
        let applied = persisted.as_ref().map(|state| Applied {
            proxy_server: state.applied_proxy_server.clone(),
            proxy_bypass: state.applied_proxy_bypass.clone(),
        });
        let snapshot = persisted.as_ref().map(|state| state.snapshot.clone());
        Self {
            supported: cfg!(windows),
            dir,
            script_path: None,
            snapshot,
            applied,
            persisted,
            last_error: None,
        }
    }

    pub fn status(&self) -> ProxyStatus {
        ProxyStatus {
            supported: self.supported,
            active: self.applied.is_some(),
            proxy_server: self.applied.as_ref().map(|a| a.proxy_server.clone()),
            error: self.last_error.clone(),
        }
    }

    fn unsupported() -> ProxyError {
        ProxyError::new(
            "unsupported-platform",
            "System proxy mode is only available on Windows.",
        )
    }

    /// Writes the embedded helper to the app's data directory so PowerShell can
    /// execute it. Rewrites only when the contents changed (e.g. after upgrade).
    async fn ensure_script(&mut self) -> Result<PathBuf, ProxyError> {
        if let Some(path) = &self.script_path {
            return Ok(path.clone());
        }
        let target = self.dir.join("system-proxy.ps1");
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| {
                ProxyError::new(
                    "script-missing",
                    format!("Could not create the system proxy helper directory: {error}"),
                )
            })?;
        let current = tokio::fs::read_to_string(&target).await.ok();
        if current.as_deref() != Some(SCRIPT_SOURCE) {
            tokio::fs::write(&target, SCRIPT_SOURCE)
                .await
                .map_err(|error| {
                    ProxyError::new(
                        "script-missing",
                        format!("Could not write the system proxy helper: {error}"),
                    )
                })?;
        }
        self.script_path = Some(target.clone());
        Ok(target)
    }

    async fn save_state(&self) {
        let Some(state) = &self.persisted else {
            return;
        };
        let Ok(text) = serde_json::to_string(state) else {
            return;
        };
        let _ = tokio::fs::create_dir_all(&self.dir).await;
        let _ = tokio::fs::write(self.dir.join(STATE_FILE), text).await;
    }

    async fn clear_state(&self) {
        let _ = tokio::fs::remove_file(self.dir.join(STATE_FILE)).await;
    }

    /// Captures the current settings and points WinINet at the local HTTP port.
    /// Returns the proxy address that was applied.
    pub async fn apply(&mut self, port: u16) -> Result<String, ProxyError> {
        if !self.supported {
            return Err(Self::unsupported());
        }
        if port == 0 {
            return Err(ProxyError::new(
                "invalid-port",
                "The local HTTP port is invalid.",
            ));
        }
        if let Some(applied) = &self.applied {
            return Ok(applied.proxy_server.clone());
        }

        let script = self.ensure_script().await?;
        let captured = run_helper(&script, "capture", "").await?;
        let snapshot = captured.get("snapshot").cloned().ok_or_else(|| {
            ProxyError::new(
                "helper-failed",
                "Windows did not return the current proxy settings.",
            )
        })?;

        let response = run_helper(&script, "apply", &json!({ "port": port }).to_string()).await?;
        let proxy_server = response
            .get("proxyServer")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if proxy_server.is_empty() {
            return Err(ProxyError::new(
                "helper-failed",
                "The system proxy helper did not report the applied proxy.",
            ));
        }
        let proxy_bypass = response
            .get("proxyBypass")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        self.snapshot = Some(snapshot.clone());
        self.applied = Some(Applied {
            proxy_server: proxy_server.clone(),
            proxy_bypass: proxy_bypass.clone(),
        });
        self.persisted = Some(Persisted {
            snapshot,
            applied_proxy_server: proxy_server.clone(),
            applied_proxy_bypass: proxy_bypass,
        });
        self.last_error = None;
        self.save_state().await;
        Ok(proxy_server)
    }

    /// Restores the previous settings. Also runs on the next launch when a
    /// snapshot was persisted by a previous session.
    pub async fn restore(&mut self) -> Result<RestoreResult, ProxyError> {
        if !self.supported {
            return Err(Self::unsupported());
        }
        let Some(applied) = self.applied.clone() else {
            return Ok(RestoreResult {
                restored: false,
                reason: Some("not-applied".into()),
                error: None,
            });
        };
        let Some(snapshot) = self.snapshot.clone() else {
            self.applied = None;
            self.persisted = None;
            self.clear_state().await;
            return Err(ProxyError::new(
                "no-snapshot",
                "No saved proxy settings to restore.",
            ));
        };

        let script = self.ensure_script().await?;
        let input = json!({
            "snapshot": snapshot,
            "appliedProxyServer": applied.proxy_server,
            "appliedProxyBypass": applied.proxy_bypass,
        })
        .to_string();

        match run_helper(&script, "restore", &input).await {
            Ok(response) => {
                self.applied = None;
                self.snapshot = None;
                self.persisted = None;
                self.last_error = None;
                self.clear_state().await;
                Ok(RestoreResult {
                    restored: response
                        .get("restored")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    reason: response
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    error: None,
                })
            }
            Err(error) => {
                self.last_error = Some(error.message.clone());
                Err(error)
            }
        }
    }

    /// Restores a snapshot left behind by an earlier session (crash recovery).
    /// Returns `None` when there is nothing to clean up.
    pub async fn restore_stale(&mut self) -> Option<Result<RestoreResult, ProxyError>> {
        if self.applied.is_none() {
            return None;
        }
        Some(self.restore().await)
    }
}

async fn run_helper(script: &Path, action: &str, input: &str) -> Result<Value, ProxyError> {
    #[cfg(windows)]
    {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;

        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .args(["-Action", action])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = command.spawn().map_err(|error| {
            ProxyError::new(
                "helper-failed",
                format!("Could not run the system proxy helper: {error}"),
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes()).await;
        }
        let output = tokio::time::timeout(
            Duration::from_millis(HELPER_TIMEOUT_MS),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| ProxyError::new("timeout", "The system proxy helper timed out."))?
        .map_err(|error| {
            ProxyError::new(
                "helper-failed",
                format!("The system proxy helper failed: {error}"),
            )
        })?;

        parse_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
            output.status.success(),
        )
    }

    #[cfg(not(windows))]
    {
        let _ = (script, action, input);
        Err(SystemProxy::unsupported())
    }
}

/// Parses the single JSON object the PowerShell helper prints. A UTF-8 BOM and
/// surrounding noise (PowerShell startup messages) are tolerated.
fn parse_output(stdout: &str, stderr: &str, success: bool) -> Result<Value, ProxyError> {
    let text = stdout.trim_start_matches('\u{feff}').trim();
    let parsed = serde_json::from_str::<Value>(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        if end <= start {
            return None;
        }
        serde_json::from_str::<Value>(&text[start..=end]).ok()
    });

    if let Some(value) = parsed {
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(value);
        }
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The system proxy helper returned an unexpected response.");
        return Err(ProxyError::new("helper-failed", message.to_string()));
    }

    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(if success {
            "The system proxy helper returned an unexpected response."
        } else {
            "The system proxy helper failed."
        });
    Err(ProxyError::new("helper-failed", detail.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_capture_output_with_bom_and_noise() {
        let raw = "\u{feff}{\"ok\":true,\"snapshot\":{\"flags\":3,\"proxyServer\":\"\"}}\r\n";
        let value = parse_output(raw, "", true).unwrap();
        assert_eq!(value["snapshot"]["flags"], 3);
    }

    #[test]
    fn reports_helper_error_messages() {
        let error = parse_output("", "Access is denied.", false).unwrap_err();
        assert_eq!(error.code, "helper-failed");
        assert!(error.message.contains("Access is denied"));
    }

    #[test]
    fn reports_json_error_payload() {
        let error = parse_output("{\"ok\":false,\"error\":\"nope\"}", "", false).unwrap_err();
        assert_eq!(error.message, "nope");
    }

    #[test]
    fn persisted_snapshot_makes_status_active() {
        let dir = tempfile::tempdir().unwrap();
        let state = Persisted {
            snapshot: json!({ "flags": 1, "proxyServer": "corp:8080" }),
            applied_proxy_server: "127.0.0.1:10809".into(),
            applied_proxy_bypass: "<local>".into(),
        };
        std::fs::write(
            dir.path().join(STATE_FILE),
            serde_json::to_string(&state).unwrap(),
        )
        .unwrap();
        let proxy = SystemProxy::new(dir.path().to_path_buf());
        let status = proxy.status();
        assert!(status.active);
        assert_eq!(status.proxy_server.as_deref(), Some("127.0.0.1:10809"));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn non_windows_reports_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let mut proxy = SystemProxy::new(dir.path().to_path_buf());
        let error = proxy.apply(10_809).await.unwrap_err();
        assert_eq!(error.code, "unsupported-platform");
    }
}
