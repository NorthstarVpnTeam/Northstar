//! Northstar V2Ray engine.
//!
//! Everything that is not the user interface lives here: settings, fetching,
//! defensive configuration parsing, country detection, the server store,
//! latency measurement, proxy-core configuration and logging. The Tauri shell
//! is a thin command layer over this crate, so the engine stays testable
//! without a display server.

pub mod connection;
pub mod core_config;
pub mod core_runtime;
pub mod country;
pub mod fetcher;
pub mod latency;
pub mod logger;
pub mod parser;
pub mod settings;
pub mod speed;
pub mod store;
pub mod system_proxy;

pub const APP_NAME: &str = "Northstar V2Ray";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const DEFAULT_CONFIG_SOURCE: &str =
    "https://raw.githubusercontent.com/shupolol/Free-configs/refs/heads/main/output/all_configs.txt";

/// Hard limits shared with the UI copy.
pub mod limits {
    pub const PING_TIMEOUT_MIN: u64 = 500;
    pub const PING_TIMEOUT_MAX: u64 = 10_000;
    pub const PORT_MIN: u16 = 1024;
    pub const PORT_MAX: u16 = 65_535;
    pub const FETCH_TIMEOUT_MS: u64 = 30_000;
    pub const FETCH_MAX_BYTES: usize = 8 * 1024 * 1024;
    pub const MAX_SERVERS: usize = 20_000;
    pub const LATENCY_CONCURRENCY: usize = 8;
    pub const REAL_DELAY_CONCURRENCY: usize = 2;
    pub const LOG_RING_SIZE: usize = 500;
    pub const EVENT_RING_SIZE: usize = 100;
    pub const SPEED_TEST_MAX_BYTES: u64 = 40 * 1024 * 1024;
    pub const SPEED_TEST_TIMEOUT_MS: u64 = 30_000;
}

/// Milliseconds since the Unix epoch, the unit used across the IPC boundary.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
