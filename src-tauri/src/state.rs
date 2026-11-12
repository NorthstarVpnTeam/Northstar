use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, Notify};

use northstar_core::connection::ConnectionManager;
use northstar_core::core_runtime::{locate, CoreInfo};
use northstar_core::logger::Logger;
use northstar_core::settings::{Settings, SettingsStore};
use northstar_core::store::ServerStore;
use northstar_core::system_proxy::SystemProxy;

/// Everything the command layer needs, owned for the lifetime of the app.
pub struct AppState {
    pub settings: SettingsStore,
    pub store: Mutex<ServerStore>,
    pub logger: StdMutex<Logger>,
    pub connection: ConnectionManager,
    pub core: StdMutex<CoreInfo>,
    pub latency_cancelled: AtomicBool,
    pub speed_running: AtomicBool,
    pub speed_cancelled: Arc<AtomicBool>,
    pub cache_file: PathBuf,
    /// Windows per-user proxy ownership (snapshot, apply, restore).
    pub system_proxy: Mutex<SystemProxy>,
    /// Resolved by the renderer's `app:ready` call once every event listener
    /// is registered. The launch-time refresh waits on this, never a timer.
    pub ui_ready: Notify,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

impl AppState {
    /// Loads settings and the cached configuration list synchronously so the
    /// first server query already has data, then locates the core.
    pub fn new(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("northstar-v2ray"));
        let _ = std::fs::create_dir_all(&data_dir);
        let settings = SettingsStore::load(&data_dir);
        let cache_file = data_dir.join("configs-cache.txt");
        let system_proxy = SystemProxy::new(data_dir.join("network"));

        let mut store = ServerStore::new();
        if let Ok(text) = std::fs::read_to_string(&cache_file) {
            store.load_document(&text, &settings.get().config_source);
        }

        let mut logger = Logger::new();
        logger.set_verbose(settings.get().verbose_logging);
        logger.info("Northstar engine started (Rust/Tauri)");

        let core = locate("", resource_dir(app).as_deref(), &exe_dir());
        let core_for_log = core.clone();
        let state = Self {
            settings,
            store: Mutex::new(store),
            logger: StdMutex::new(logger),
            connection: ConnectionManager::new(),
            core: StdMutex::new(core),
            latency_cancelled: AtomicBool::new(false),
            speed_running: AtomicBool::new(false),
            speed_cancelled: Arc::new(AtomicBool::new(false)),
            cache_file,
            system_proxy: Mutex::new(system_proxy),
            ui_ready: Notify::new(),
        };
        if let Some(path) = core_for_log.path {
            state.log(app, "info", &format!("Proxy core: {path}"));
        } else {
            state.log(app, "warn", "No proxy core found yet");
        }
        state
    }

    pub fn settings_snapshot(&self) -> Settings {
        self.settings.get()
    }

    pub fn log(&self, app: &AppHandle, level: &str, message: &str) {
        let line = self
            .logger
            .lock()
            .ok()
            .and_then(|mut logger| logger.write(level, message));
        if let Some(line) = line {
            let _ = app.emit("log:line", line);
        }
    }

    pub fn core_json(&self) -> Value {
        self.core
            .lock()
            .map(|core| serde_json::to_value(core.clone()).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    }

    /// Flat status payload for the renderer's `core.status()` call.
    pub fn core_status(&self) -> Value {
        let core = self
            .core
            .lock()
            .map(|core| core.clone())
            .unwrap_or_default();
        json!({
            "ok": true,
            "found": core.found,
            "corePath": core.path,
            "coreVersion": core.version,
            "coreSource": core.source,
            "lastError": core.last_error,
            "state": if core.found { "ready" } else { "missing" },
        })
    }

    /// Re-runs discovery after the core path changes.
    pub fn refresh_core(&self, app: &AppHandle) -> CoreInfo {
        let settings = self.settings.get();
        let info = locate(
            &settings.core_path,
            resource_dir(app).as_deref(),
            &exe_dir(),
        );
        if let Ok(mut slot) = self.core.lock() {
            *slot = info.clone();
        }
        let _ = app.emit("core:status", json!({ "status": self.core_status() }));
        info
    }

    /// Waits until the renderer reports that its event listeners are live.
    /// `Notify` keeps a permit if the signal arrives before this is awaited.
    pub async fn wait_ui_ready(&self) {
        self.ui_ready.notified().await;
    }

    pub fn mark_ui_ready(&self) {
        self.ui_ready.notify_one();
    }

    pub fn cancel_latency(&self) {
        self.latency_cancelled.store(true, Ordering::SeqCst);
    }

    pub fn reset_latency_cancel(&self) {
        self.latency_cancelled.store(false, Ordering::SeqCst);
    }
}
