// Northstar V2Ray — lightweight Rust/Tauri shell around the existing renderer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod elevation;
mod state;

use tauri::{Emitter, Manager};

use state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle);
            let settings = state.settings.get();
            app.manage(state);
            commands::spawn_core_watch(handle.clone());

            // TUN mode creates an adapter and system routes, which needs
            // administrator rights. Ask for them before the UI is usable.
            if settings.tun_mode && !elevation::is_elevated() {
                match elevation::relaunch_elevated() {
                    Ok(()) => {
                        handle.exit(0);
                        return Ok(());
                    }
                    Err(error) => {
                        let state = handle.state::<AppState>();
                        state.log(
                            &handle,
                            "warn",
                            &format!("TUN mode needs administrator rights: {error}"),
                        );
                    }
                }
            }

            let setup_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = setup_app.state::<AppState>();

                // A crash or forced exit may have left Windows pointing at a
                // local port that no longer exists. Restore the snapshot from
                // the previous session before doing anything else.
                if let Some(result) = state.system_proxy.lock().await.restore_stale().await {
                    match result {
                        Ok(restored) if restored.restored => {
                            state.log(
                                &setup_app,
                                "info",
                                "Restored the system proxy from a previous session.",
                            );
                        }
                        Ok(restored) => {
                            if let Some(reason) = restored.reason {
                                state.log(
                                    &setup_app,
                                    "warn",
                                    &format!("System proxy left unchanged: {reason}"),
                                );
                            }
                        }
                        Err(error) => {
                            state
                                .connection
                                .mark_system_proxy(false, Some(error.message.clone()))
                                .await;
                            state.log(
                                &setup_app,
                                "warn",
                                &format!(
                                    "Could not restore the previous system proxy: {}",
                                    error.message
                                ),
                            );
                        }
                    }
                }

                let _ = setup_app.emit(
                    "core:status",
                    serde_json::json!({
                        "status": state.core_status(),
                    }),
                );
                let meta = state.store.lock().await.meta();
                let _ = setup_app.emit("servers:changed", serde_json::json!({ "meta": meta }));

                // Mirror the Electron shell: load the cached list immediately,
                // then refresh the server list in the background at launch.
                // Wait for the renderer's readiness signal, so progress and
                // `servers:changed` events can never be emitted before the UI
                // has subscribed to them.
                state.wait_ui_ready().await;
                // Now that the renderer is listening, surface any startup
                // system-proxy failure instead of leaving it only in the log.
                let status = state.connection.status(state.core_json()).await;
                let _ = setup_app.emit("connection:status", status);
                let _ = commands::refresh_configs(&setup_app, state.inner()).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::northstar_call])
        .build(tauri::generate_context!())
        .expect("error while building Northstar V2Ray")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = handle.state::<AppState>();
                tauri::async_runtime::block_on(async {
                    match state.system_proxy.lock().await.restore().await {
                        Ok(result) if result.restored => {
                            state.log(handle, "info", "System proxy restored on exit.");
                        }
                        Ok(_) => {}
                        Err(error) => {
                            state.log(
                                handle,
                                "warn",
                                &format!(
                                    "Could not restore the system proxy on exit: {}",
                                    error.message
                                ),
                            );
                        }
                    }
                    state.connection.mark_system_proxy(false, None).await;
                });
            }
        });
}
