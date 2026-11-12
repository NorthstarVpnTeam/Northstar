//! Settings persistence: defaults, validation, corruption tolerance and
//! atomic writes. Field names stay camelCase because the renderer consumes
//! them unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::limits::{PING_TIMEOUT_MAX, PING_TIMEOUT_MIN, PORT_MAX, PORT_MIN};
use crate::DEFAULT_CONFIG_SOURCE;

pub const SETTINGS_FILE: &str = "settings.json";

fn default_source() -> String {
    DEFAULT_CONFIG_SOURCE.to_string()
}
fn default_true() -> bool {
    true
}
fn default_light() -> String {
    "light".to_string()
}
fn default_sort() -> String {
    "latency".to_string()
}
fn default_measurement() -> String {
    "tcp".to_string()
}
fn default_validation() -> String {
    "e2e".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_source")]
    pub config_source: String,
    #[serde(default)]
    pub auto_refresh: bool,
    #[serde(default = "default_60")]
    pub auto_refresh_interval_min: u32,
    #[serde(default = "default_true")]
    pub auto_ping: bool,
    #[serde(default = "default_4000")]
    pub ping_timeout_ms: u32,
    #[serde(default = "default_60000")]
    pub ping_interval_ms: u32,
    #[serde(default = "default_true")]
    pub auto_sort: bool,
    #[serde(default = "default_sort")]
    pub sort_by: String,
    #[serde(default)]
    pub hide_failed: bool,

    #[serde(default = "default_socks")]
    pub socks_port: u16,
    #[serde(default = "default_http")]
    pub http_port: u16,
    #[serde(default = "default_measurement")]
    pub measurement_type: String,
    #[serde(default = "default_true")]
    pub validate_on_connect: bool,
    #[serde(default = "default_validation")]
    pub validation_type: String,
    #[serde(default)]
    pub connect_on_launch: bool,
    #[serde(default)]
    pub core_path: String,

    #[serde(default)]
    pub system_proxy: bool,
    #[serde(default)]
    pub tun_mode: bool,

    #[serde(default = "default_light")]
    pub theme: String,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default)]
    pub compact_rows: bool,
    #[serde(default)]
    pub verbose_logging: bool,
}

fn default_60() -> u32 {
    60
}
fn default_4000() -> u32 {
    4_000
}
fn default_60000() -> u32 {
    60_000
}
fn default_socks() -> u16 {
    10_808
}
fn default_http() -> u16 {
    10_809
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            config_source: default_source(),
            auto_refresh: false,
            auto_refresh_interval_min: 60,
            auto_ping: true,
            ping_timeout_ms: 4_000,
            ping_interval_ms: 60_000,
            auto_sort: true,
            sort_by: default_sort(),
            hide_failed: false,
            socks_port: default_socks(),
            http_port: default_http(),
            measurement_type: default_measurement(),
            validate_on_connect: true,
            validation_type: default_validation(),
            connect_on_launch: false,
            core_path: String::new(),
            system_proxy: false,
            tun_mode: false,
            theme: default_light(),
            reduce_motion: false,
            compact_rows: false,
            verbose_logging: false,
        }
    }
}

impl Settings {
    /// Coerces a decoded JSON document into valid settings. Invalid or missing
    /// fields fall back to their defaults instead of failing the whole load.
    pub fn coerce(value: &Value) -> Self {
        let mut out = Settings::default();
        let Some(obj) = value.as_object() else {
            return out;
        };
        out.apply_object(obj);
        out.normalise();
        out
    }

    fn apply_object(&mut self, obj: &Map<String, Value>) {
        let s = |key: &str| obj.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let b = |key: &str| obj.get(key).and_then(|v| v.as_bool());
        let n = |key: &str| obj.get(key).and_then(|v| v.as_u64());

        if let Some(v) = s("configSource") {
            self.config_source = v;
        }
        if let Some(v) = b("autoRefresh") {
            self.auto_refresh = v;
        }
        if let Some(v) = n("autoRefreshIntervalMin") {
            self.auto_refresh_interval_min = v as u32;
        }
        if let Some(v) = b("autoPing") {
            self.auto_ping = v;
        }
        if let Some(v) = n("pingTimeoutMs") {
            self.ping_timeout_ms = v as u32;
        }
        if let Some(v) = n("pingIntervalMs") {
            self.ping_interval_ms = v as u32;
        }
        if let Some(v) = b("autoSort") {
            self.auto_sort = v;
        }
        if let Some(v) = s("sortBy") {
            self.sort_by = v;
        }
        if let Some(v) = b("hideFailed") {
            self.hide_failed = v;
        }
        if let Some(v) = n("socksPort") {
            self.socks_port = v as u16;
        }
        if let Some(v) = n("httpPort") {
            self.http_port = v as u16;
        }
        if let Some(v) = s("measurementType") {
            self.measurement_type = v;
        }
        if let Some(v) = b("validateOnConnect") {
            self.validate_on_connect = v;
        }
        if let Some(v) = s("validationType") {
            self.validation_type = v;
        }
        if let Some(v) = b("connectOnLaunch") {
            self.connect_on_launch = v;
        }
        if let Some(v) = s("corePath") {
            self.core_path = v;
        }
        if let Some(v) = b("systemProxy") {
            self.system_proxy = v;
        }
        if let Some(v) = b("tunMode") {
            self.tun_mode = v;
        }
        if let Some(v) = s("theme") {
            self.theme = v;
        }
        if let Some(v) = b("reduceMotion") {
            self.reduce_motion = v;
        }
        if let Some(v) = b("compactRows") {
            self.compact_rows = v;
        }
        if let Some(v) = b("verboseLogging") {
            self.verbose_logging = v;
        }
    }

    /// Clamps values into their supported ranges and normalises enumerations.
    pub fn normalise(&mut self) {
        self.config_source = self.config_source.trim().to_string();
        if url::Url::parse(&self.config_source).is_err() {
            self.config_source = DEFAULT_CONFIG_SOURCE.to_string();
        }
        self.ping_timeout_ms = self
            .ping_timeout_ms
            .clamp(PING_TIMEOUT_MIN as u32, PING_TIMEOUT_MAX as u32);
        self.auto_refresh_interval_min = self.auto_refresh_interval_min.clamp(5, 24 * 60);
        self.ping_interval_ms = self.ping_interval_ms.clamp(15_000, 300_000);
        if !self.socks_port_is_valid() {
            self.socks_port = default_socks();
        }
        if !self.http_port_is_valid() {
            self.http_port = default_http();
        }
        if self.socks_port == self.http_port {
            self.http_port = default_http();
            if self.socks_port == self.http_port {
                self.socks_port = default_socks();
            }
        }
        if !["latency", "name", "country", "protocol"].contains(&self.sort_by.as_str()) {
            self.sort_by = default_sort();
        }
        if !["tcp", "proxy", "e2e", "delay"].contains(&self.measurement_type.as_str()) {
            self.measurement_type = default_measurement();
        }
        if !["e2e", "proxy", "tcp"].contains(&self.validation_type.as_str()) {
            self.validation_type = default_validation();
        }
        if !["light", "dark"].contains(&self.theme.as_str()) {
            self.theme = default_light();
        }
        self.core_path = self.core_path.trim().to_string();
    }

    fn socks_port_is_valid(&self) -> bool {
        (PORT_MIN..=PORT_MAX).contains(&self.socks_port)
    }

    fn http_port_is_valid(&self) -> bool {
        (PORT_MIN..=PORT_MAX).contains(&self.http_port)
    }

    /// Applies a patch coming from the UI. Returns the new settings or a
    /// user-facing error; the stored value is only replaced when valid.
    pub fn apply_patch(&mut self, patch: &Value) -> Result<Settings, String> {
        let Some(obj) = patch.as_object() else {
            return Err("Settings update must be an object".into());
        };

        if let Some(Value::String(url)) = obj.get("configSource") {
            let trimmed = url.trim();
            match url::Url::parse(trimmed) {
                Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => {}
                _ => return Err("The configuration source must be a valid http(s) URL".into()),
            }
        }
        for key in ["socksPort", "httpPort"] {
            if let Some(Value::Number(n)) = obj.get(key) {
                let port = n.as_u64().unwrap_or(0);
                if !(PORT_MIN as u64..=PORT_MAX as u64).contains(&port) {
                    return Err("Ports must be between 1024 and 65535".into());
                }
            }
        }
        if let Some(Value::Number(n)) = obj.get("pingTimeoutMs") {
            let ms = n.as_u64().unwrap_or(0);
            if !(PING_TIMEOUT_MIN..=PING_TIMEOUT_MAX).contains(&ms) {
                return Err(format!(
                    "Ping timeout must be between {PING_TIMEOUT_MIN} and {PING_TIMEOUT_MAX} ms"
                ));
            }
        }
        if let Some(Value::String(v)) = obj.get("measurementType") {
            if !["tcp", "proxy", "e2e", "delay"].contains(&v.as_str()) {
                return Err("Unknown latency measurement type".into());
            }
        }
        if let Some(Value::String(v)) = obj.get("validationType") {
            if !["e2e", "proxy", "tcp"].contains(&v.as_str()) {
                return Err("Unknown validation type".into());
            }
        }
        if let Some(Value::String(v)) = obj.get("sortBy") {
            if !["latency", "name", "country", "protocol"].contains(&v.as_str()) {
                return Err("Unknown sort mode".into());
            }
        }
        if let Some(Value::String(v)) = obj.get("theme") {
            if !["light", "dark"].contains(&v.as_str()) {
                return Err("Unknown theme".into());
            }
        }

        let mut next = self.clone();
        next.apply_object(obj);
        if (next.socks_port == next.http_port)
            && (obj.contains_key("socksPort") || obj.contains_key("httpPort"))
        {
            return Err("SOCKS and HTTP ports must differ".into());
        }
        next.normalise();
        *self = next.clone();
        Ok(next)
    }
}

pub struct SettingsStore {
    path: PathBuf,
    inner: RwLock<Settings>,
}

impl SettingsStore {
    /// Loads `settings.json` from `dir`, backing up (never deleting) a corrupt
    /// file and continuing with defaults.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(SETTINGS_FILE);
        let mut settings = Settings::default();
        if let Ok(raw) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<Value>(&raw) {
                Ok(value) => settings = Settings::coerce(&value),
                Err(_) => {
                    let backup = path.with_extension(format!("corrupt-{}", crate::now_ms()));
                    let _ = std::fs::rename(&path, backup);
                }
            }
        }
        Self {
            path,
            inner: RwLock::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        self.inner.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn update(&self, patch: &Value) -> Result<Settings, String> {
        let mut guard = self.inner.write().map_err(|_| "Settings lock poisoned")?;
        let next = guard.apply_patch(patch)?;
        let persisted = next.clone();
        drop(guard);
        self.persist(&persisted);
        Ok(persisted)
    }

    pub fn reset(&self) -> Settings {
        let next = Settings::default();
        if let Ok(mut guard) = self.inner.write() {
            *guard = next.clone();
        }
        self.persist(&next);
        next
    }

    fn persist(&self, settings: &Settings) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(text) = serde_json::to_string_pretty(settings) else {
            return;
        };
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        let s = Settings::default();
        assert_eq!(s.socks_port, 10_808);
        assert_eq!(s.http_port, 10_809);
        assert_eq!(s.theme, "light");
        assert!(!s.system_proxy && !s.tun_mode);
    }

    #[test]
    fn rejects_equal_ports_and_bad_timeouts() {
        let mut s = Settings::default();
        assert!(s
            .apply_patch(&serde_json::json!({ "socksPort": 1234, "httpPort": 1234 }))
            .is_err());
        assert!(s
            .apply_patch(&serde_json::json!({ "pingTimeoutMs": 10 }))
            .is_err());
        assert!(s
            .apply_patch(&serde_json::json!({ "configSource": "file:///etc/passwd" }))
            .is_err());
    }

    #[test]
    fn coerces_corrupt_values() {
        let s = Settings::coerce(&serde_json::json!({
            "theme": "neon",
            "socksPort": 1,
            "pingTimeoutMs": 99_999,
            "sortBy": "nope"
        }));
        assert_eq!(s.theme, "light");
        assert_eq!(s.socks_port, 10_808);
        assert_eq!(s.ping_timeout_ms, PING_TIMEOUT_MAX as u32);
        assert_eq!(s.sort_by, "latency");
    }

    #[test]
    fn persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path());
        let updated = store
            .update(&serde_json::json!({ "theme": "dark", "socksPort": 10801 }))
            .unwrap();
        assert_eq!(updated.theme, "dark");
        let reloaded = SettingsStore::load(dir.path());
        assert_eq!(reloaded.get().theme, "dark");
        assert_eq!(reloaded.get().socks_port, 10801);
    }
}
