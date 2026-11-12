// Northstar V2Ray — lightweight Rust/Tauri shell around the existing renderer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use tauri::{Emitter, Manager};

use state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle);
            app.manage(state);

            let setup_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = setup_app.state::<AppState>();
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
                let _ = commands::refresh_configs(&setup_app, state.inner()).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::northstar_call])
        .run(tauri::generate_context!())
        .expect("error while running Northstar V2Ray");
}
