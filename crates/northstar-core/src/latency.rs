//! Latency probes. Each measurement kind stays strictly distinct: a TCP connect
//! does not prove a proxy works, and failures are reported instead of invented.

use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::limits::{PING_TIMEOUT_MAX, PING_TIMEOUT_MIN};
use crate::parser::ServerEntry;

pub const DEFAULT_VALIDATION_URL: &str = "http://cp.cloudflare.com/generate_204";

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub ms: Option<u64>,
    pub code: Option<String>,
}

impl ProbeResult {
    fn ok(ms: u128) -> Self {
        Self {
            ok: true,
            ms: Some(ms as u64),
            code: None,
        }
    }

    fn fail(code: impl Into<String>) -> Self {
        Self {
            ok: false,
            ms: None,
            code: Some(code.into()),
        }
    }
}

pub fn clamp_timeout(ms: u64) -> u64 {
    ms.clamp(PING_TIMEOUT_MIN, PING_TIMEOUT_MAX)
}

fn io_code(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::TimedOut {
        return "timeout".into();
    }
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED".into(),
        std::io::ErrorKind::ConnectionReset => "ECONNRESET".into(),
        std::io::ErrorKind::HostUnreachable => "EHOSTUNREACH".into(),
        std::io::ErrorKind::NetworkUnreachable => "ENETUNREACH".into(),
        _ => error.to_string(),
    }
}

/// Direct TCP connect time to the remote endpoint.
pub async fn tcp_connect(host: &str, port: u16, timeout_ms: u64) -> ProbeResult {
    let start = Instant::now();
    let target = format!("{host}:{port}");
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(stream)) => {
            drop(stream);
            ProbeResult::ok(start.elapsed().as_millis())
        }
        Ok(Err(error)) => ProbeResult::fail(io_code(&error)),
        Err(_) => ProbeResult::fail("timeout"),
    }
}

/// Minimal SOCKS5 CONNECT handshake through the local proxy.
pub async fn socks5_connect(
    proxy_host: &str,
    proxy_port: u16,
    target_host: &str,
    target_port: u16,
    timeout_ms: u64,
) -> ProbeResult {
    let start = Instant::now();
    let deadline = Duration::from_millis(timeout_ms);
    let attempt = tokio::time::timeout(deadline, async move {
        let mut socket = TcpStream::connect((proxy_host, proxy_port))
            .await
            .map_err(|e| io_code(&e))?;

        // Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
        socket
            .write_all(&[0x05, 0x01, 0x00])
            .await
            .map_err(|e| io_code(&e))?;
        let mut greeting = [0u8; 2];
        socket
            .read_exact(&mut greeting)
            .await
            .map_err(|e| io_code(&e))?;
        if greeting[0] != 0x05 {
            return Err("socks-bad-version".to_string());
        }
        if greeting[1] != 0x00 {
            return Err("socks-reject".to_string());
        }

        let mut request = vec![0x05, 0x01, 0x00];
        match target_host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => {
                request.push(0x01);
                request.extend_from_slice(&ip.octets());
            }
            Ok(IpAddr::V6(ip)) => {
                request.push(0x04);
                request.extend_from_slice(&ip.octets());
            }
            Err(_) => {
                let bytes = target_host.as_bytes();
                if bytes.len() > 255 {
                    return Err("socks-host-too-long".to_string());
                }
                request.push(0x03);
                request.push(bytes.len() as u8);
                request.extend_from_slice(bytes);
            }
        }
        request.extend_from_slice(&target_port.to_be_bytes());
        socket.write_all(&request).await.map_err(|e| io_code(&e))?;

        let mut header = [0u8; 4];
        socket
            .read_exact(&mut header)
            .await
            .map_err(|e| io_code(&e))?;
        if header[0] != 0x05 {
            return Err("socks-bad-reply".to_string());
        }
        if header[1] != 0x00 {
            return Err(match header[1] {
                0x01 => "socks-general-failure",
                0x02 => "socks-not-allowed",
                0x03 => "socks-network-unreachable",
                0x04 => "socks-host-unreachable",
                0x05 => "socks-connection-refused",
                0x06 => "socks-ttl-expired",
                0x07 => "socks-unsupported-command",
                0x08 => "socks-unsupported-address-type",
                _ => "socks-error",
            }
            .to_string());
        }
        let remaining = match header[3] {
            0x01 => 4 + 2,
            0x04 => 16 + 2,
            0x03 => {
                let mut length = [0u8; 1];
                socket
                    .read_exact(&mut length)
                    .await
                    .map_err(|e| io_code(&e))?;
                length[0] as usize + 2
            }
            _ => return Err("socks-bad-atyp".to_string()),
        };
        let mut discard = vec![0u8; remaining];
        socket
            .read_exact(&mut discard)
            .await
            .map_err(|e| io_code(&e))?;
        Ok::<(), String>(())
    })
    .await;

    match attempt {
        Ok(Ok(())) => ProbeResult::ok(start.elapsed().as_millis()),
        Ok(Err(code)) => ProbeResult::fail(code),
        Err(_) => ProbeResult::fail("timeout"),
    }
}

/// Full HTTP request through the local HTTP proxy, measured end to end.
pub async fn e2e_through_proxy(
    proxy_host: &str,
    proxy_port: u16,
    url: &str,
    timeout_ms: u64,
) -> ProbeResult {
    let start = Instant::now();
    let proxy = match reqwest::Proxy::http(format!("http://{proxy_host}:{proxy_port}")) {
        Ok(proxy) => proxy,
        Err(_) => return ProbeResult::fail("bad-proxy"),
    };
    let client = match reqwest::Client::builder()
        .proxy(proxy)
        .user_agent("NorthstarV2Ray/2.1")
        .timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(_) => return ProbeResult::fail("client-build"),
    };
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            if status < 500 {
                ProbeResult::ok(start.elapsed().as_millis())
            } else {
                ProbeResult::fail(format!("http-{status}"))
            }
        }
        Err(error) => {
            if error.is_timeout() {
                ProbeResult::fail("timeout")
            } else {
                ProbeResult::fail("error")
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct MeasureOptions {
    pub kind: String,
    pub timeout_ms: u64,
    pub socks_port: u16,
    pub http_port: u16,
    pub proxy_connected: bool,
    pub validation_url: String,
}

impl Default for MeasureOptions {
    fn default() -> Self {
        Self {
            kind: "tcp".into(),
            timeout_ms: 4_000,
            socks_port: 10_808,
            http_port: 10_809,
            proxy_connected: false,
            validation_url: DEFAULT_VALIDATION_URL.into(),
        }
    }
}

/// Measures one server. `delay` (a temporary core per server) is supplied by the
/// caller because it needs process management; without it the probe is honest
/// about being unavailable.
pub async fn measure(entry: &ServerEntry, options: &MeasureOptions) -> ProbeResult {
    let timeout = clamp_timeout(options.timeout_ms);
    match options.kind.as_str() {
        "tcp" => tcp_connect(&entry.host, entry.port, timeout).await,
        "proxy" => {
            if !options.proxy_connected {
                return ProbeResult::fail("proxy-offline");
            }
            socks5_connect(
                "127.0.0.1",
                options.socks_port,
                &entry.host,
                entry.port,
                timeout,
            )
            .await
        }
        "e2e" => {
            if !options.proxy_connected {
                return ProbeResult::fail("proxy-offline");
            }
            e2e_through_proxy(
                "127.0.0.1",
                options.http_port,
                &options.validation_url,
                timeout,
            )
            .await
        }
        "delay" => ProbeResult::fail("real-delay-unavailable"),
        _ => ProbeResult::fail("unsupported-kind"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn offline_proxy_kinds_fail_honestly() {
        let entry = crate::parser::parse_config("trojan://pw@127.0.0.1:1#X").unwrap();
        let result = measure(
            &entry,
            &MeasureOptions {
                kind: "proxy".into(),
                ..Default::default()
            },
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.code.as_deref(), Some("proxy-offline"));

        let result = measure(
            &entry,
            &MeasureOptions {
                kind: "delay".into(),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(result.code.as_deref(), Some("real-delay-unavailable"));
    }

    #[tokio::test]
    async fn closed_port_reports_failure_not_a_number() {
        let result = tcp_connect("127.0.0.1", 1, 1_000).await;
        assert!(!result.ok);
        assert!(result.ms.is_none());
        assert!(result.code.is_some());
    }

    #[test]
    fn timeout_is_clamped() {
        assert_eq!(clamp_timeout(1), PING_TIMEOUT_MIN);
        assert_eq!(clamp_timeout(99_999), PING_TIMEOUT_MAX);
    }
}
