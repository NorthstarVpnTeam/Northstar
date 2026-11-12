//! Xray-compatible core configuration generation.
//!
//! The document is written to a private temp file and passed to the core as an
//! argument, never interpolated into a shell. Unsupported combinations fail
//! with a clear code instead of launching a broken core.

use serde_json::{json, Map, Value};
use std::fmt;

use crate::parser::ServerEntry;

#[derive(Debug, Clone)]
pub struct ConfigError {
    pub message: String,
    pub code: &'static str,
}

impl ConfigError {
    fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone)]
pub struct CoreConfigOptions {
    pub socks_port: u16,
    pub http_port: u16,
    /// 0 disables the stats API.
    pub api_port: u16,
    pub log_level: String,
    pub tun: bool,
}

impl Default for CoreConfigOptions {
    fn default() -> Self {
        Self {
            socks_port: 10_808,
            http_port: 10_809,
            api_port: 0,
            log_level: "warning".into(),
            tun: false,
        }
    }
}

fn valid_port(port: u16) -> bool {
    port > 0
}

fn build_stream_settings(entry: &ServerEntry) -> Result<Value, ConfigError> {
    let requested_network = entry.network.to_lowercase();
    // Xray 26 renamed the plain TCP transport to "raw"; both names work.
    let network = if requested_network == "raw" {
        "tcp".to_string()
    } else {
        requested_network
    };
    let security = entry.security.to_lowercase();

    if !["tcp", "ws", "grpc", "http", "h2", "xhttp", "kcp", "quic"].contains(&network.as_str()) {
        return Err(ConfigError::new(
            format!("Transport \"{network}\" is not supported by this build."),
            "unsupported-transport",
        ));
    }
    if !["none", "tls", "reality"].contains(&security.as_str()) {
        return Err(ConfigError::new(
            format!("Security \"{security}\" is not supported."),
            "unsupported-security",
        ));
    }

    let mut stream = Map::new();
    stream.insert("network".into(), json!(network));

    if security == "tls" {
        let mut tls = Map::new();
        tls.insert(
            "serverName".into(),
            json!(if entry.sni.is_empty() {
                &entry.host
            } else {
                &entry.sni
            }),
        );
        tls.insert("allowInsecure".into(), json!(entry.extra.allow_insecure));
        if !entry.extra.alpn.is_empty() {
            let alpn: Vec<&str> = entry
                .extra
                .alpn
                .split(',')
                .filter(|part| !part.is_empty())
                .collect();
            tls.insert("alpn".into(), json!(alpn));
        }
        if !entry.extra.fp.is_empty() {
            tls.insert("fingerprint".into(), json!(entry.extra.fp));
        }
        stream.insert("security".into(), json!("tls"));
        stream.insert("tlsSettings".into(), Value::Object(tls));
    } else if security == "reality" {
        if entry.extra.pbk.is_empty() {
            return Err(ConfigError::new(
                "Reality security requires a public key (pbk).",
                "missing-pbk",
            ));
        }
        let mut reality = Map::new();
        reality.insert(
            "serverName".into(),
            json!(if entry.sni.is_empty() {
                &entry.host
            } else {
                &entry.sni
            }),
        );
        reality.insert(
            "fingerprint".into(),
            json!(if entry.extra.fp.is_empty() {
                "chrome"
            } else {
                &entry.extra.fp
            }),
        );
        reality.insert("publicKey".into(), json!(entry.extra.pbk));
        reality.insert("shortId".into(), json!(entry.extra.sid));
        if !entry.extra.spider_x.is_empty() {
            reality.insert("spiderX".into(), json!(entry.extra.spider_x));
        }
        stream.insert("security".into(), json!("reality"));
        stream.insert("realitySettings".into(), Value::Object(reality));
    } else {
        stream.insert("security".into(), json!("none"));
    }

    match network.as_str() {
        "ws" => {
            let mut ws = Map::new();
            ws.insert(
                "path".into(),
                json!(if entry.extra.path.is_empty() {
                    "/"
                } else {
                    &entry.extra.path
                }),
            );
            if !entry.extra.host.is_empty() {
                ws.insert("headers".into(), json!({ "Host": entry.extra.host }));
            }
            stream.insert("wsSettings".into(), Value::Object(ws));
        }
        "grpc" => {
            let service = if !entry.extra.path.is_empty() {
                entry.extra.path.clone()
            } else {
                entry.extra.service_name.clone()
            };
            stream.insert("grpcSettings".into(), json!({ "serviceName": service }));
        }
        "http" | "xhttp" | "h2" => {
            let mut http = Map::new();
            http.insert(
                "path".into(),
                json!(if entry.extra.path.is_empty() {
                    "/"
                } else {
                    &entry.extra.path
                }),
            );
            if !entry.extra.host.is_empty() {
                http.insert("host".into(), json!([entry.extra.host]));
            }
            stream.insert("httpSettings".into(), Value::Object(http));
        }
        "kcp" => {
            stream.insert(
                "kcpSettings".into(),
                json!({
                    "mtu": 1350,
                    "tti": 20,
                    "uplinkCapacity": 5,
                    "downlinkCapacity": 20,
                    "congestion": false,
                    "header": {
                        "type": if entry.extra.header_type.is_empty() || entry.extra.header_type == "none" {
                            "none"
                        } else {
                            entry.extra.header_type.as_str()
                        }
                    }
                }),
            );
        }
        _ => {}
    }

    Ok(Value::Object(stream))
}

pub fn build_outbound(entry: &ServerEntry) -> Result<Value, ConfigError> {
    if !valid_port(entry.port) {
        return Err(ConfigError::new(
            "Server port is invalid.",
            "config-invalid",
        ));
    }
    if entry.host.is_empty() {
        return Err(ConfigError::new(
            "Server address is missing.",
            "config-invalid",
        ));
    }
    let stream = build_stream_settings(entry)?;
    let extra = &entry.extra;

    let outbound = match entry.protocol.as_str() {
        "vless" => {
            if entry.credential.is_empty() {
                return Err(ConfigError::new("VLESS id is missing.", "config-invalid"));
            }
            let mut user = Map::new();
            user.insert("id".into(), json!(entry.credential));
            user.insert(
                "encryption".into(),
                json!(if extra.encryption.is_empty() {
                    "none"
                } else {
                    &extra.encryption
                }),
            );
            if !entry.flow.is_empty() {
                user.insert("flow".into(), json!(entry.flow));
            }
            json!({
                "protocol": "vless",
                "settings": { "vnext": [{
                    "address": entry.host,
                    "port": entry.port,
                    "users": [Value::Object(user)],
                }] },
                "streamSettings": stream,
            })
        }
        "vmess" => {
            if entry.credential.is_empty() {
                return Err(ConfigError::new("VMess id is missing.", "config-invalid"));
            }
            let mut user = Map::new();
            user.insert("id".into(), json!(entry.credential));
            user.insert(
                "security".into(),
                json!(if extra.scy.is_empty() || extra.scy == "auto" {
                    "auto"
                } else {
                    &extra.scy
                }),
            );
            if !extra.aid.is_empty() && extra.aid != "0" {
                if let Ok(aid) = extra.aid.parse::<u32>() {
                    user.insert("alterId".into(), json!(aid));
                }
            }
            json!({
                "protocol": "vmess",
                "settings": { "vnext": [{
                    "address": entry.host,
                    "port": entry.port,
                    "users": [Value::Object(user)],
                }] },
                "streamSettings": stream,
            })
        }
        "trojan" => {
            if entry.credential.is_empty() {
                return Err(ConfigError::new(
                    "Trojan password is missing.",
                    "config-invalid",
                ));
            }
            json!({
                "protocol": "trojan",
                "settings": { "servers": [{
                    "address": entry.host,
                    "port": entry.port,
                    "password": entry.credential,
                }] },
                "streamSettings": stream,
            })
        }
        "ss" => {
            if entry.credential.is_empty() {
                return Err(ConfigError::new(
                    "Shadowsocks password is missing.",
                    "config-invalid",
                ));
            }
            if extra.cipher.is_empty() {
                return Err(ConfigError::new(
                    "Shadowsocks cipher is missing.",
                    "config-invalid",
                ));
            }
            let mut server = Map::new();
            server.insert("address".into(), json!(entry.host));
            server.insert("port".into(), json!(entry.port));
            server.insert("method".into(), json!(extra.cipher));
            server.insert("password".into(), json!(entry.credential));
            if !extra.plugin.is_empty() {
                server.insert("plugin".into(), json!(extra.plugin));
                server.insert("pluginOpts".into(), json!(extra.plugin_opts));
            }
            json!({
                "protocol": "shadowsocks",
                "settings": { "servers": [Value::Object(server)] },
                "streamSettings": stream,
            })
        }
        "socks" | "http" => {
            let mut server = Map::new();
            server.insert("address".into(), json!(entry.host));
            server.insert("port".into(), json!(entry.port));
            if !entry.credential.is_empty() {
                let (user, pass) = entry
                    .credential
                    .split_once(':')
                    .unwrap_or((&entry.credential, ""));
                server.insert("users".into(), json!([{ "user": user, "pass": pass }]));
            }
            json!({
                "protocol": entry.protocol,
                "settings": { "servers": [Value::Object(server)] },
                "streamSettings": stream,
            })
        }
        other => {
            return Err(ConfigError::new(
                format!("Protocol \"{other}\" is not supported."),
                "unsupported-protocol",
            ))
        }
    };
    Ok(outbound)
}

/// Builds the complete core document.
pub fn build_core_config(
    entry: &ServerEntry,
    options: &CoreConfigOptions,
) -> Result<Value, ConfigError> {
    if !valid_port(options.socks_port) || !valid_port(options.http_port) {
        return Err(ConfigError::new(
            "Local proxy ports are invalid.",
            "config-invalid",
        ));
    }
    if options.socks_port == options.http_port {
        return Err(ConfigError::new(
            "Local SOCKS and HTTP ports must differ.",
            "config-invalid",
        ));
    }

    let mut outbound = build_outbound(entry)?;
    if let Value::Object(ref mut map) = outbound {
        map.insert("tag".into(), json!("proxy"));
    }

    let mut inbounds = vec![
        json!({
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": options.socks_port,
            "protocol": "socks",
            "settings": { "udp": false, "auth": "noauth" },
        }),
        json!({
            "tag": "http-in",
            "listen": "127.0.0.1",
            "port": options.http_port,
            "protocol": "http",
            "settings": {},
        }),
    ];

    if options.tun {
        inbounds.push(json!({
            "tag": "tun-in",
            "protocol": "tun",
            "settings": {
                "name": "northstar0",
                "desc": "Northstar",
                "mtu": 1500,
                "gateway": ["10.184.0.1/30"],
                "autoSystemRoutingTable": ["0.0.0.0/0", "::/0"],
                "autoOutboundsInterface": "auto",
            },
            "sniffing": {
                "enabled": true,
                "destOverride": ["http", "tls", "quic"],
                "metadataOnly": false,
                "routeOnly": false,
            },
        }));
    }

    let outbounds = vec![
        outbound,
        json!({ "protocol": "freedom", "tag": "direct", "settings": {} }),
        json!({ "protocol": "blackhole", "tag": "blocked", "settings": {} }),
    ];

    // Explicit private ranges instead of `geoip:private`: the core then never
    // needs geoip.dat to start, which removes a common installation failure.
    let mut rules = vec![
        json!({
            "type": "field",
            "ip": [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "127.0.0.0/8",
                "169.254.0.0/16",
                "100.64.0.0/10",
                "::1/128",
                "fc00::/7",
                "fe80::/10"
            ],
            "outboundTag": "direct"
        }),
        json!({ "type": "field", "protocol": ["bittorrent"], "outboundTag": "blocked" }),
    ];
    if options.tun {
        rules.insert(
            0,
            json!({ "type": "field", "inboundTag": ["tun-in"], "outboundTag": "proxy" }),
        );
    }

    let mut config = json!({
        "log": { "loglevel": options.log_level, "access": "", "error": "" },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": { "domainStrategy": "UseIP", "rules": rules },
    });

    if options.api_port > 0 {
        let object = config.as_object_mut().expect("config is an object");
        object.insert(
            "api".into(),
            json!({ "tag": "api", "services": ["StatsService"] }),
        );
        object.insert("stats".into(), json!({}));
        object.insert(
            "policy".into(),
            json!({ "levels": { "0": {
                "statsInboundUplink": true,
                "statsInboundDownlink": true,
                "statsUserUplink": true,
                "statsUserDownlink": true,
            } } }),
        );
        if let Some(inbounds) = object.get_mut("inbounds").and_then(Value::as_array_mut) {
            inbounds.push(json!({
                "tag": "api-in",
                "listen": "127.0.0.1",
                "port": options.api_port,
                "protocol": "dokodemo-door",
                "settings": { "network": "tcp,udp" },
            }));
        }
        if let Some(outbounds) = object.get_mut("outbounds").and_then(Value::as_array_mut) {
            outbounds.push(json!({ "protocol": "freedom", "tag": "api", "settings": {} }));
        }
        if let Some(rules) = object
            .get_mut("routing")
            .and_then(|r| r.get_mut("rules"))
            .and_then(Value::as_array_mut)
        {
            rules.insert(
                0,
                json!({ "type": "field", "inboundTag": ["api"], "outboundTag": "api" }),
            );
        }
    }

    Ok(config)
}

/// Secrets that must never reach logs or diagnostics.
pub fn collect_secrets(entry: Option<&ServerEntry>) -> Vec<String> {
    let Some(entry) = entry else {
        return Vec::new();
    };
    let mut secrets = Vec::new();
    if !entry.credential.is_empty() {
        secrets.push(entry.credential.clone());
    }
    for value in [&entry.extra.pbk, &entry.extra.path, &entry.extra.host] {
        if value.len() >= 6 {
            secrets.push(value.clone());
        }
    }
    if !entry.sni.is_empty() && entry.sni != entry.host {
        secrets.push(entry.sni.clone());
    }
    secrets.sort();
    secrets.dedup();
    secrets
}

/// Replaces known secrets and credential URIs in a text chunk.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.len() >= 4 {
            out = out.replace(secret.as_str(), "[redacted]");
        }
    }
    out.split_inclusive(char::is_whitespace)
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            if [
                "vless://",
                "vmess://",
                "trojan://",
                "ss://",
                "socks5://",
                "socks://",
            ]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
            {
                "[redacted-uri]".to_string()
            } else {
                token.to_string()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_config;

    fn entry(uri: &str) -> ServerEntry {
        parse_config(uri).unwrap()
    }

    #[test]
    fn builds_vless_reality_config() {
        let server = entry("vless://18805ff3-b420-45de-af18-93be14024ae8@1.2.3.4:443?security=reality&pbk=abc123&sid=99&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=yahoo.com#NL%2001");
        let config = build_core_config(
            &server,
            &CoreConfigOptions {
                socks_port: 10_808,
                http_port: 10_809,
                api_port: 0,
                log_level: "warning".into(),
                tun: false,
            },
        )
        .unwrap();
        assert_eq!(config["inbounds"][0]["port"], 10_808);
        assert_eq!(config["inbounds"][1]["port"], 10_809);
        assert_eq!(config["outbounds"][0]["protocol"], "vless");
        assert_eq!(
            config["outbounds"][0]["streamSettings"]["realitySettings"]["publicKey"],
            "abc123"
        );
        assert_eq!(config["outbounds"][0]["tag"], "proxy");
    }

    #[test]
    fn tun_and_stats_are_opt_in() {
        let server = entry("trojan://pw@1.2.3.4:443#X");
        let plain = build_core_config(&server, &CoreConfigOptions::default()).unwrap();
        assert!(plain.get("api").is_none());
        assert_eq!(plain["inbounds"].as_array().unwrap().len(), 2);

        let full = build_core_config(
            &server,
            &CoreConfigOptions {
                api_port: 10_850,
                tun: true,
                ..CoreConfigOptions::default()
            },
        )
        .unwrap();
        assert!(full.get("api").is_some());
        assert_eq!(full["inbounds"].as_array().unwrap().len(), 4);
        assert!(full["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| rule["inboundTag"][0] == "tun-in"));
    }

    #[test]
    fn plain_tcp_and_raw_are_the_same_transport() {
        let raw = entry("trojan://pw@1.2.3.4:443?type=raw#X");
        let non = entry("trojan://pw@1.2.3.4:443?type=tcp#X");
        let raw_config = build_core_config(&raw, &CoreConfigOptions::default()).unwrap();
        let non_config = build_core_config(&non, &CoreConfigOptions::default()).unwrap();
        assert_eq!(
            raw_config["outbounds"][0]["streamSettings"]["network"],
            "tcp"
        );
        assert_eq!(raw_config, non_config);
    }

    #[test]
    fn routing_needs_no_geo_data_files() {
        let server = entry("trojan://pw@1.2.3.4:443#X");
        let config = build_core_config(&server, &CoreConfigOptions::default()).unwrap();
        let text = config.to_string();
        assert!(!text.contains("geoip:"), "{text}");
        assert!(!text.contains("geosite:"), "{text}");
        assert!(text.contains("192.168.0.0/16"));
    }

    #[test]
    fn rejects_missing_keys_and_bad_ports() {
        let server = entry(
            "vless://18805ff3-b420-45de-af18-93be14024ae8@1.2.3.4:443?security=reality&type=tcp#X",
        );
        let error = build_core_config(&server, &CoreConfigOptions::default()).unwrap_err();
        assert_eq!(error.code, "missing-pbk");

        let error = build_core_config(
            &entry("trojan://pw@1.2.3.4:443#X"),
            &CoreConfigOptions {
                socks_port: 1,
                http_port: 1,
                ..CoreConfigOptions::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "config-invalid");
    }

    #[test]
    fn redacts_secrets_and_uris() {
        let secrets = vec!["super-secret".to_string()];
        let text = "boom super-secret vless://abc@host:443#NL";
        let redacted = redact(text, &secrets);
        assert!(!redacted.contains("super-secret"));
        assert!(!redacted.contains("vless://"));
    }
}
