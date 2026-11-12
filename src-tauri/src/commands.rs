//! The single Tauri command behind `window.northstar`.
//!
//! The renderer was written against a preload bridge. Each bridge method maps
//! to a `method` string here, and every response uses the same `{ ok, ... }`
//! envelope the renderer already unwraps. Events are Tauri events with the same
//! names as before.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use northstar_core::connection::{ConnectOptions, ConnectionManager};
use northstar_core::fetcher::fetch_configuration;
use northstar_core::latency::{measure, MeasureOptions, DEFAULT_VALIDATION_URL};
use northstar_core::limits::LOG_RING_SIZE;
use northstar_core::now_ms;
use northstar_core::parser::ServerEntry;
use northstar_core::speed::{self, SpeedOptions};
use northstar_core::store::{GroupsOptions, LatencyRecord};
use northstar_core::APP_VERSION;

use crate::state::AppState;

#[tauri::command]
pub async fn northstar_call(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    Ok(dispatch(app, state, &method, payload.unwrap_or(Value::Null)).await)
}

async fn dispatch(
    app: AppHandle,
    state: State<'_, AppState>,
    method: &str,
    payload: Value,
) -> Value {
    match method {
        "settings:get" => json!({ "ok": true, "settings": state.settings.get() }),

        "settings:set" => match state.settings.update(&payload) {
            Ok(settings) => {
                let _ = app.emit("settings:changed", &settings);
                if let Ok(mut logger) = state.logger.lock() {
                    logger.set_verbose(settings.verbose_logging);
                }
                if payload.get("corePath").is_some() {
                    state.refresh_core(&app);
                }
                json!({ "ok": true, "settings": settings })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },

        "settings:reset" => {
            let settings = state.settings.reset();
            let _ = app.emit("settings:changed", &settings);
            json!({ "ok": true, "settings": settings })
        }

        "config:refresh" => refresh_configs(&app, state.inner()).await,

        "servers:list" => {
            let store = state.store.lock().await;
            json!({ "ok": true, "servers": store.rows(), "meta": store.meta() })
        }

        "servers:groups" => {
            let options = GroupsOptions {
                sort: text(&payload, "sort").unwrap_or_else(|| "name".into()),
                hide_failed: flag(&payload, "hideFailed"),
                query: text(&payload, "query").unwrap_or_default(),
                protocol: text(&payload, "protocol").unwrap_or_else(|| "all".into()),
                status: text(&payload, "status").unwrap_or_else(|| "all".into()),
            };
            let store = state.store.lock().await;
            json!({
                "ok": true,
                "groups": store.groups(&options),
                "meta": store.meta(),
            })
        }

        "servers:select" => {
            let id = text(&payload, "id").unwrap_or_default();
            let selected = {
                let mut store = state.store.lock().await;
                if store.select(Some(id.clone())) {
                    Some(store.meta())
                } else {
                    None
                }
            };
            match selected {
                Some(meta) => {
                    let _ = app.emit("servers:changed", json!({ "meta": meta }));
                    json!({ "ok": true, "selectedId": id })
                }
                None => json!({ "ok": false, "error": "Unknown server id" }),
            }
        }

        "servers:selected" => {
            let store = state.store.lock().await;
            json!({ "ok": true, "selectedId": store.selected_id() })
        }

        "servers:copy" => {
            let (uri, label) = {
                let store = state.store.lock().await;
                let id = text(&payload, "id").unwrap_or_default();
                match store.raw_uri(&id) {
                    Some(uri) => {
                        let label = store
                            .get(&id)
                            .map(|entry| entry.label.clone())
                            .unwrap_or_default();
                        (uri, label)
                    }
                    None => return json!({ "ok": false, "error": "Unknown server id" }),
                }
            };
            match copy_to_clipboard(&uri) {
                Ok(()) => json!({ "ok": true, "label": label }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }

        "servers:details" => {
            let store = state.store.lock().await;
            let id = text(&payload, "id").unwrap_or_default();
            match store.details(&id) {
                Some(details) => json!({ "ok": true, "details": details }),
                None => json!({ "ok": false, "error": "Unknown server id" }),
            }
        }

        "latency:test" => run_latency(&app, state.inner(), &payload).await,

        "latency:cancel" => {
            state.cancel_latency();
            json!({ "ok": true })
        }

        "connection:status" => {
            let mut status = state.connection.status(state.core_json()).await;
            if let Some(object) = status.as_object_mut() {
                object.insert("ok".into(), json!(true));
            }
            status
        }

        "connection:connect" => {
            let id = text(&payload, "serverId").unwrap_or_default();
            let settings = state.settings.get();

            if settings.system_proxy {
                return json!({
                    "ok": false,
                    "error": "System proxy mode is not available in the Rust build yet. Turn it off in Settings, or use TUN mode.",
                });
            }

            let core = state
                .core
                .lock()
                .map(|core| core.clone())
                .unwrap_or_default();
            let Some(core_path) = core.path.clone() else {
                return json!({ "ok": false, "error": "No usable proxy core found. Set its path in Settings." });
            };
            let entry = {
                let store = state.store.lock().await;
                store.get(&id).cloned()
            };
            let Some(entry) = entry else {
                return json!({ "ok": false, "error": "Unknown server id" });
            };

            if let Ok(mut logger) = state.logger.lock() {
                logger.set_secrets(northstar_core::core_config::collect_secrets(Some(&entry)));
                logger.info(&format!("Connecting to {}", entry.label));
            }

            let options = ConnectOptions {
                socks_port: settings.socks_port,
                http_port: settings.http_port,
                validate: settings.validate_on_connect,
                validation_type: settings.validation_type.clone(),
                timeout_ms: settings.ping_timeout_ms as u64,
                tun: settings.tun_mode,
                log_level: if settings.verbose_logging {
                    "info"
                } else {
                    "warning"
                }
                .into(),
            };

            let core_json = state.core_json();
            let status_app = app.clone();
            let result = state
                .connection
                .connect(
                    &entry,
                    &options,
                    std::path::Path::new(&core_path),
                    core_json,
                    |status| {
                        let _ = status_app.emit("connection:status", status);
                    },
                )
                .await;

            emit_latest_event(&app, &state.connection).await;
            match result {
                Ok(()) => {
                    state.log(&app, "info", &format!("Connected to {}", entry.label));
                    json!({ "ok": true })
                }
                Err(error) => {
                    state.log(
                        &app,
                        "error",
                        &format!("Connection failed: {}", error.message),
                    );
                    json!({ "ok": false, "error": error.message, "code": error.code })
                }
            }
        }

        "connection:disconnect" => {
            let core_json = state.core_json();
            let status_app = app.clone();
            state
                .connection
                .disconnect(core_json, |status| {
                    let _ = status_app.emit("connection:status", status);
                })
                .await;
            emit_latest_event(&app, &state.connection).await;
            state.log(&app, "info", "Disconnected");
            if let Ok(mut logger) = state.logger.lock() {
                logger.set_secrets(Vec::new());
            }
            json!({ "ok": true })
        }

        "connection:events" => json!({ "ok": true, "events": state.connection.events().await }),

        "core:status" => state.core_status(),

        "core:locate" => {
            let info = state.refresh_core(&app);
            json!({
                "ok": true,
                "core": { "found": info.found, "path": info.path },
                "status": state.core_status(),
            })
        }

        "core:pick" => match app
            .dialog()
            .file()
            .add_filter("Proxy core", &["exe"])
            .blocking_pick_file()
        {
            Some(file) => match file.as_path() {
                Some(path) => {
                    let value = path.to_string_lossy().to_string();
                    match state.settings.update(&json!({ "corePath": value })) {
                        Ok(settings) => {
                            let _ = app.emit("settings:changed", &settings);
                            state.refresh_core(&app);
                            json!({ "ok": true, "path": value })
                        }
                        Err(error) => json!({ "ok": false, "error": error }),
                    }
                }
                None => json!({ "ok": false, "code": "cancelled" }),
            },
            None => json!({ "ok": false, "code": "cancelled" }),
        },

        "speed:start" => {
            if state.speed_running.swap(true, Ordering::SeqCst) {
                return json!({ "ok": false, "error": "A speed test is already running." });
            }
            state.speed_cancelled.store(false, Ordering::SeqCst);
            let direction = text(&payload, "direction").unwrap_or_else(|| "download".into());
            let via_proxy = flag(&payload, "viaProxy");
            let settings = state.settings.get();

            let task_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = task_app.state::<AppState>();
                let progress_app = task_app.clone();
                let result_app = task_app.clone();
                let options = SpeedOptions {
                    direction,
                    via_proxy,
                    proxy_port: settings.http_port,
                };
                let result = speed::run(&options, state.speed_cancelled.clone(), move |progress| {
                    let _ = progress_app.emit("speed:progress", progress);
                })
                .await;
                let _ = result_app.emit("speed:result", result);
                state.speed_running.store(false, Ordering::SeqCst);
            });
            json!({ "ok": true })
        }

        "speed:cancel" => {
            state.speed_cancelled.store(true, Ordering::SeqCst);
            json!({ "ok": true })
        }

        "logs:recent" => {
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                .min(LOG_RING_SIZE as u64) as usize;
            let logs = state
                .logger
                .lock()
                .map(|logger| logger.recent(limit))
                .unwrap_or_default();
            json!({ "ok": true, "logs": logs })
        }

        "logs:export" => {
            let status = state.connection.status(state.core_json()).await;
            let settings = redacted_settings(&state.settings.get());
            let core = state.core_status();
            let bundle = match state.logger.lock() {
                Ok(logger) => logger.bundle(json!({
                    "settings": settings,
                    "connection": status,
                    "core": core,
                })),
                Err(_) => json!({ "ok": false }),
            };
            let file = app
                .dialog()
                .file()
                .set_file_name("northstar-diagnostics.json")
                .add_filter("JSON", &["json"])
                .blocking_save_file();
            match file.and_then(|file| file.as_path().map(PathBuf::from)) {
                Some(path) => {
                    let text = serde_json::to_string_pretty(&bundle).unwrap_or_default();
                    match std::fs::write(&path, text) {
                        Ok(()) => json!({ "ok": true, "filePath": path.to_string_lossy() }),
                        Err(error) => {
                            json!({ "ok": false, "error": format!("Could not write diagnostics: {error}") })
                        }
                    }
                }
                None => json!({ "ok": false, "code": "cancelled" }),
            }
        }

        "cache:clear" => {
            let _ = tokio::fs::remove_file(&state.cache_file).await;
            state.store.lock().await.clear();
            let _ = app.emit(
                "servers:changed",
                json!({ "meta": state.store.lock().await.meta() }),
            );
            json!({ "ok": true, "cache": { "exists": false, "servers": 0, "bytes": 0 } })
        }

        "app:info" => json!({
            "ok": true,
            "version": APP_VERSION,
            "electron": Value::Null,
            "chrome": Value::Null,
            "node": Value::Null,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "locale": "en-US",
        }),

        "app:openExternal" => {
            let url = text(&payload, "url").unwrap_or_default();
            match open_external(&url) {
                Ok(()) => json!({ "ok": true }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }

        other => json!({ "ok": false, "error": format!("Unknown method: {other}") }),
    }
}

/// Fetches the configuration list and replaces the store's contents.
/// Used by the `config:refresh` method and by the launch-time background
/// refresh in `main.rs`, so both behave identically.
pub async fn refresh_configs(app: &AppHandle, state: &AppState) -> Value {
    let settings = state.settings.get();
    let _ = app.emit("config:progress", json!({ "phase": "start" }));

    let progress_app = app.clone();
    let result = fetch_configuration(&settings.config_source, move |phase, loaded| {
        let _ = progress_app.emit(
            "config:progress",
            json!({ "phase": phase, "loaded": loaded }),
        );
    })
    .await;

    match result {
        Ok(text) => {
            let stats = {
                let mut store = state.store.lock().await;
                store.load_document(&text, &settings.config_source)
            };
            let _ = tokio::fs::write(&state.cache_file, &text).await;
            let meta = state.store.lock().await.meta();
            let _ = app.emit(
                "config:progress",
                json!({ "phase": "done", "stats": stats, "fetchedAt": now_ms() }),
            );
            let _ = app.emit("servers:changed", json!({ "meta": meta }));
            state.log(app, "info", &format!("Loaded {} servers", stats.kept));
            json!({ "ok": true, "stats": stats })
        }
        Err(error) => {
            let _ = app.emit(
                "config:progress",
                json!({ "phase": "error", "message": error.message }),
            );
            state.log(app, "error", &format!("Refresh failed: {}", error.message));
            json!({ "ok": false, "error": error.message, "code": error.code })
        }
    }
}

async fn run_latency(app: &AppHandle, state: &AppState, payload: &Value) -> Value {
    let settings = state.settings.get();
    let kind = text(payload, "type").unwrap_or_else(|| settings.measurement_type.clone());
    let all = flag(payload, "all");
    let ids: Vec<String> = payload
        .get("ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let entries: Vec<ServerEntry> = {
        let store = state.store.lock().await;
        store
            .entries()
            .iter()
            .filter(|entry| all || ids.contains(&entry.id))
            .cloned()
            .collect()
    };
    if entries.is_empty() {
        return json!({ "ok": false, "error": "No servers to measure." });
    }

    state.reset_latency_cancel();
    let total = entries.len();
    let _ = app.emit(
        "latency:state",
        json!({ "running": true, "done": 0, "total": total }),
    );

    let proxy_connected = state.connection.status(state.core_json()).await["state"] == "connected";
    let options = MeasureOptions {
        kind: kind.clone(),
        timeout_ms: settings.ping_timeout_ms as u64,
        socks_port: settings.socks_port,
        http_port: settings.http_port,
        proxy_connected,
        validation_url: DEFAULT_VALIDATION_URL.into(),
    };

    let results: Vec<Value> = futures_util::stream::iter(entries.into_iter().map(|entry| {
        let app = app.clone();
        let options = &options;
        let kind = kind.clone();
        let state = state;
        async move {
            if state.latency_cancelled.load(Ordering::SeqCst) {
                return json!({
                    "id": entry.id, "ok": false, "ms": Value::Null, "kind": kind,
                    "code": "cancelled", "at": now_ms(),
                });
            }
            let probe = measure(&entry, options).await;
            let result = json!({
                "id": entry.id,
                "ok": probe.ok,
                "ms": probe.ms,
                "kind": kind,
                "code": probe.code,
                "at": now_ms(),
            });
            {
                let mut store = state.store.lock().await;
                store.set_latency(
                    &entry.id,
                    LatencyRecord {
                        ms: probe.ms,
                        ok: probe.ok,
                        kind: kind.clone(),
                        at: now_ms(),
                    },
                );
            }
            let _ = app.emit("latency:update", json!({ "result": result }));
            result
        }
    }))
    .buffer_unordered(8)
    .collect()
    .await;

    let _ = app.emit("latency:state", json!({ "running": false }));
    json!({ "ok": true, "total": total, "results": results })
}

async fn emit_latest_event(app: &AppHandle, connection: &ConnectionManager) {
    if let Some(event) = connection.events().await.first() {
        let _ = app.emit("connection:event", event.clone());
    }
}

fn text(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

fn flag(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Settings safe for diagnostics: the core path is kept, nothing secret is.
fn redacted_settings(settings: &northstar_core::settings::Settings) -> Value {
    serde_json::to_value(settings).unwrap_or(Value::Null)
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[cfg(windows)]
    let candidates: [(&str, &[&str]); 1] = [("cmd", &["/C", "clip"])];
    #[cfg(target_os = "macos")]
    let candidates: [(&str, &[&str]); 1] = [("pbcopy", &[])];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates: [(&str, &[&str]); 3] = [
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xclip", &["-selection", "c"]),
    ];

    for (program, args) in candidates {
        let Ok(mut child) = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(text.as_bytes()).is_err() {
                continue;
            }
        }
        if child.wait().map(|status| status.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err("Clipboard unavailable — copy manually instead.".into())
}

fn open_external(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let valid = (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && trimmed.len() < 2048
        && !trimmed.chars().any(|c| c.is_control() || c == '"');
    if !valid {
        return Err("Only http(s) links can be opened.".into());
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", trimmed]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(trimmed);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link: {error}"))
}
