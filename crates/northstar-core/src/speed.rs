//! Speed measurement against speed.cloudflare.com, optionally through the local
//! HTTP proxy. Only real transferred bytes are reported.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::limits::{SPEED_TEST_MAX_BYTES, SPEED_TEST_TIMEOUT_MS};

const DOWNLOAD_URL: &str = "https://speed.cloudflare.com/__down?bytes=15000000";
const UPLOAD_URL: &str = "https://speed.cloudflare.com/__up";
const UPLOAD_BYTES: usize = 5 * 1024 * 1024;

pub struct SpeedOptions {
    pub direction: String,
    pub via_proxy: bool,
    pub proxy_port: u16,
}

fn client(options: &SpeedOptions, timeout_ms: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("NorthstarV2Ray/2.0")
        .timeout(Duration::from_millis(timeout_ms));
    if options.via_proxy {
        let proxy = reqwest::Proxy::http(format!("http://127.0.0.1:{}", options.proxy_port))
            .map_err(|_| "The local proxy address is invalid.".to_string())?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("Could not start the speed test: {error}"))
}

fn mbps(bytes: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (bytes as f64 * 8.0) / (elapsed_ms as f64 / 1000.0) / 1_000_000.0
}

fn rounded(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Runs one measurement. `on_progress` receives `{ bytes, elapsedMs, mbps }`
/// roughly every 200 ms; the returned value is the renderer's result payload.
pub async fn run<F>(options: &SpeedOptions, cancelled: Arc<AtomicBool>, mut on_progress: F) -> Value
where
    F: FnMut(Value) + Send,
{
    let direction = if options.direction == "upload" {
        "upload"
    } else {
        "download"
    };
    let endpoint = if direction == "upload" {
        UPLOAD_URL
    } else {
        DOWNLOAD_URL
    };
    let timeout = Duration::from_millis(SPEED_TEST_TIMEOUT_MS);
    let start = Instant::now();

    let client = match client(options, SPEED_TEST_TIMEOUT_MS) {
        Ok(client) => client,
        Err(message) => {
            return json!({
                "ok": false, "cancelled": false, "error": message, "code": "client-build",
                "direction": direction, "viaProxy": options.via_proxy, "endpoint": endpoint,
            })
        }
    };

    let work = async {
        if direction == "download" {
            let response = client
                .get(DOWNLOAD_URL)
                .send()
                .await
                .map_err(|error| format!("The download could not start: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!(
                    "The speed endpoint returned HTTP {}",
                    status.as_u16()
                ));
            }
            let mut stream = response.bytes_stream();
            let mut total: u64 = 0;
            let mut last_emit = Instant::now();
            while let Some(chunk) = stream.next().await {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("__cancelled".to_string());
                }
                let chunk =
                    chunk.map_err(|error| format!("The download was interrupted: {error}"))?;
                total += chunk.len() as u64;
                if total > SPEED_TEST_MAX_BYTES {
                    break;
                }
                if last_emit.elapsed() >= Duration::from_millis(200) {
                    last_emit = Instant::now();
                    on_progress(json!({
                        "bytes": total,
                        "elapsedMs": start.elapsed().as_millis() as u64,
                        "mbps": rounded(mbps(total, start.elapsed().as_millis())),
                    }));
                }
            }
            Ok(total)
        } else {
            if cancelled.load(Ordering::SeqCst) {
                return Err("__cancelled".to_string());
            }
            let body = vec![0u8; UPLOAD_BYTES];
            let response = client
                .post(UPLOAD_URL)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(body.clone())
                .send()
                .await
                .map_err(|error| format!("The upload could not start: {error}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "The speed endpoint returned HTTP {}",
                    response.status().as_u16()
                ));
            }
            on_progress(json!({
                "bytes": body.len(),
                "elapsedMs": start.elapsed().as_millis() as u64,
                "mbps": rounded(mbps(body.len() as u64, start.elapsed().as_millis())),
            }));
            Ok(body.len() as u64)
        }
    };

    match tokio::time::timeout(timeout, work).await {
        Ok(Ok(bytes)) => {
            let elapsed = start.elapsed().as_millis();
            json!({
                "ok": true,
                "direction": direction,
                "mbps": rounded(mbps(bytes, elapsed)),
                "bytes": bytes,
                "elapsedMs": elapsed as u64,
                "viaProxy": options.via_proxy,
                "endpoint": endpoint,
                "note": if options.via_proxy { "through local proxy" } else { "direct connection" },
            })
        }
        Ok(Err(message)) if message == "__cancelled" => json!({
            "ok": false, "cancelled": true, "error": "The speed test was cancelled.",
            "code": "cancelled", "direction": direction,
            "viaProxy": options.via_proxy, "endpoint": endpoint,
        }),
        Ok(Err(message)) => json!({
            "ok": false, "cancelled": false, "error": message, "code": "network",
            "direction": direction, "viaProxy": options.via_proxy, "endpoint": endpoint,
        }),
        Err(_) => json!({
            "ok": false, "cancelled": false, "error": "The speed test timed out.",
            "code": "timeout", "direction": direction,
            "viaProxy": options.via_proxy, "endpoint": endpoint,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_are_real_and_rounded() {
        assert_eq!(rounded(mbps(1_000_000, 1_000)), 8.0);
        assert_eq!(mbps(0, 0), 0.0);
    }
}
