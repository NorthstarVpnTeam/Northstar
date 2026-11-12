//! Defensive configuration parser.
//!
//! Malformed input is rejected with a reason and never panics. The original URI
//! is kept for Copy configuration but is never logged or sent to the UI.

use base64::Engine;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::country::{detect_country, strip_flag};
use crate::limits::MAX_SERVERS;

const SUPPORTED: &[&str] = &[
    "vless", "vmess", "trojan", "ss", "socks", "socks4", "socks5", "http", "https",
];

#[derive(Debug, Clone)]
pub struct ParseError {
    pub message: String,
    pub code: &'static str,
}

impl ParseError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "invalid",
        }
    }

    fn code(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Clone, Default)]
pub struct ServerExtra {
    pub encryption: String,
    pub pbk: String,
    pub sid: String,
    pub fp: String,
    pub path: String,
    pub host: String,
    pub alpn: String,
    pub allow_insecure: bool,
    pub aid: String,
    pub scy: String,
    pub header_type: String,
    pub cipher: String,
    pub plugin: String,
    pub plugin_opts: String,
    pub service_name: String,
    pub spider_x: String,
}

#[derive(Debug, Clone)]
pub struct ServerEntry {
    pub id: String,
    pub protocol: String,
    pub label: String,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub flag: String,
    pub host: String,
    pub port: u16,
    pub security: String,
    pub network: String,
    pub transport: String,
    pub sni: String,
    pub flow: String,
    pub credential: String,
    pub extra: ServerExtra,
    /// Original URI; never serialised to the renderer or written to logs.
    pub raw: String,
}

#[derive(Debug, Clone)]
pub struct ParseIssue {
    pub line: usize,
    pub reason: String,
    pub code: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseStats {
    pub received: usize,
    pub parsed: usize,
    pub rejected: usize,
    pub unsupported: usize,
    pub duplicates: usize,
    pub kept: usize,
}

#[derive(Debug, Default)]
pub struct ParsedDocument {
    pub entries: Vec<ServerEntry>,
    pub stats: ParseStats,
    pub errors: Vec<ParseIssue>,
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn make_id(protocol: &str, host: &str, port: u16, discriminator: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{protocol}|{host}|{port}|{discriminator}").as_bytes());
    format!("s_{}", &hex(&hasher.finalize())[..32])
}

fn credential_hash(credential: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(credential.as_bytes());
    hex(&hasher.finalize())[..16].to_string()
}

fn safe_decode(value: &str) -> String {
    percent_decode_str(value)
        .decode_utf8()
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn decode_base64(input: &str) -> String {
    let normalised = input.trim().replace('-', "+").replace('_', "/");
    let mut padded = normalised;
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(padded.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn parse_port(value: &str) -> Option<u16> {
    value.trim().parse::<u32>().ok().and_then(|n| {
        if (1..=65_535).contains(&n) {
            Some(n as u16)
        } else {
            None
        }
    })
}

fn normalize_host(host: &str) -> Option<String> {
    let trimmed = host.trim();
    let without_brackets = trimmed
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(trimmed);
    if without_brackets.is_empty() || without_brackets.len() > 253 {
        return None;
    }
    let valid = without_brackets
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._~:[]-".contains(c));
    valid.then(|| without_brackets.to_string())
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

fn query_map(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

/// Normalises the trailing numeric suffix: "Node 001" -> "Node 01".
pub fn normalize_server_name(label: &str) -> String {
    let cleaned = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut digit_start = cleaned.len();
    for (index, ch) in cleaned.char_indices().rev() {
        if ch.is_ascii_digit() {
            digit_start = index;
        } else {
            break;
        }
    }
    if digit_start == cleaned.len() {
        return cleaned;
    }
    let head =
        cleaned[..digit_start].trim_end_matches(|c: char| c.is_whitespace() || "._|-".contains(c));
    let number = cleaned[digit_start..].parse::<u64>().unwrap_or(0);
    let padded = format!("{number:02}");
    if head.is_empty() {
        padded
    } else {
        format!("{head} {padded}")
    }
}

fn finalize(mut entry: ServerEntry, fragment: &str) -> ServerEntry {
    let stripped = strip_flag(fragment);
    let label = if stripped.is_empty() {
        format!(
            "{} {}:{}",
            entry.protocol.to_uppercase(),
            entry.host,
            entry.port
        )
    } else {
        normalize_server_name(&stripped)
    };

    let country = detect_country(fragment).or_else(|| detect_country(&label));
    entry.label = label.clone();
    if let Some(country) = country {
        entry.country = Some(country.name);
        entry.flag = country.flag;
        entry.country_code = Some(country.code);
    }
    let discriminator = if fragment.trim().is_empty() {
        format!("{}|{}", entry.label, entry.network)
    } else {
        fragment.to_string()
    };
    entry.id = make_id(&entry.protocol, &entry.host, entry.port, &discriminator);
    entry.raw = String::new();
    entry
}

fn base_entry(protocol: &str, host: String, port: u16) -> ServerEntry {
    ServerEntry {
        id: String::new(),
        protocol: protocol.to_string(),
        label: String::new(),
        country: None,
        country_code: None,
        flag: String::new(),
        host,
        port,
        security: "none".into(),
        network: "tcp".into(),
        transport: "tcp".into(),
        sni: String::new(),
        flow: String::new(),
        credential: String::new(),
        extra: ServerExtra::default(),
        raw: String::new(),
    }
}

fn split_host_port(host_port: &str, protocol: &str) -> Result<(String, u16), ParseError> {
    let colon = host_port
        .rfind(':')
        .filter(|index| *index > 0)
        .ok_or_else(|| ParseError::new(format!("{protocol}: missing host or port")))?;
    let host = normalize_host(&host_port[..colon])
        .ok_or_else(|| ParseError::new(format!("{protocol}: invalid host")))?;
    let port = parse_port(&host_port[colon + 1..])
        .ok_or_else(|| ParseError::new(format!("{protocol}: invalid port")))?;
    Ok((host, port))
}

fn split_url_parts(body: &str) -> (&str, &str) {
    match body.find('?') {
        Some(index) => (&body[..index], &body[index + 1..]),
        None => (body, ""),
    }
}

fn parse_vless(uri: &str, fragment: &str) -> Result<ServerEntry, ParseError> {
    let body = uri
        .strip_prefix("vless://")
        .ok_or_else(|| ParseError::new("vless: invalid scheme"))?;
    let at = body
        .find('@')
        .filter(|index| *index > 0)
        .ok_or_else(|| ParseError::new("vless: missing credentials"))?;
    let user_info = &body[..at];
    let (host_port, query) = split_url_parts(&body[at + 1..]);
    let (host, port) = split_host_port(host_port, "vless")?;

    let uuid = safe_decode(user_info);
    let uuid = uuid.trim();
    if !is_uuid(uuid) {
        return Err(ParseError::new("vless: id is not a valid UUID"));
    }

    let params = query_map(query);
    let security = params
        .get("security")
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "none".into());
    if !["none", "tls", "reality"].contains(&security.as_str()) {
        return Err(ParseError::new("vless: unsupported security"));
    }
    let network = params
        .get("type")
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "tcp".into());

    let get = |key: &str| params.get(key).cloned().unwrap_or_default();
    let mut entry = base_entry("vless", host, port);
    entry.security = security;
    entry.network = network.clone();
    entry.transport = network;
    entry.sni = params
        .get("sni")
        .or_else(|| params.get("host"))
        .cloned()
        .unwrap_or_default();
    entry.flow = get("flow");
    entry.credential = uuid.to_string();
    entry.extra = ServerExtra {
        encryption: params
            .get("encryption")
            .cloned()
            .unwrap_or_else(|| "none".into()),
        pbk: get("pbk"),
        sid: get("sid"),
        fp: get("fp"),
        path: get("path"),
        host: get("host"),
        alpn: get("alpn"),
        allow_insecure: get("allowInsecure") == "1" || get("insecure") == "1",
        ..Default::default()
    };
    Ok(finalize(entry, fragment))
}

fn parse_vmess(uri: &str, fragment: &str) -> Result<ServerEntry, ParseError> {
    let payload = uri
        .strip_prefix("vmess://")
        .ok_or_else(|| ParseError::new("vmess: invalid scheme"))?
        .trim();
    let json_text = decode_base64(payload);
    if json_text.is_empty() {
        return Err(ParseError::new("vmess: payload is not valid base64"));
    }
    let data: Value = serde_json::from_str(&json_text)
        .map_err(|_| ParseError::new("vmess: payload is not valid JSON"))?;
    let object = data
        .as_object()
        .ok_or_else(|| ParseError::new("vmess: empty payload"))?;

    let string = |key: &str| {
        object
            .get(key)
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            })
            .unwrap_or_default()
    };

    let address = if string("add").is_empty() {
        string("host")
    } else {
        string("add")
    };
    let host = normalize_host(&address).ok_or_else(|| ParseError::new("vmess: invalid address"))?;
    let port = parse_port(&string("port")).ok_or_else(|| ParseError::new("vmess: invalid port"))?;
    let uuid = string("id").trim().to_string();
    if uuid.is_empty() {
        return Err(ParseError::new("vmess: missing id"));
    }

    let network = if string("net").is_empty() {
        "tcp".to_string()
    } else {
        string("net").to_lowercase()
    };
    let security = if string("tls").to_lowercase() == "tls" {
        "tls"
    } else {
        "none"
    };

    let mut entry = base_entry("vmess", host, port);
    entry.security = security.to_string();
    entry.network = network.clone();
    entry.transport = network;
    entry.sni = if string("sni").is_empty() {
        string("host")
    } else {
        string("sni")
    };
    entry.credential = uuid;
    entry.extra = ServerExtra {
        aid: if string("aid").is_empty() {
            "0".into()
        } else {
            string("aid")
        },
        path: string("path"),
        host: string("host"),
        alpn: string("alpn"),
        scy: if string("scy").is_empty() {
            "auto".into()
        } else {
            string("scy")
        },
        header_type: string("type"),
        allow_insecure: string("allowInsecure") == "1",
        ..Default::default()
    };
    let label_source = if fragment.is_empty() {
        string("ps")
    } else {
        fragment.to_string()
    };
    Ok(finalize(entry, &label_source))
}

fn parse_trojan(uri: &str, fragment: &str) -> Result<ServerEntry, ParseError> {
    let body = uri
        .strip_prefix("trojan://")
        .ok_or_else(|| ParseError::new("trojan: invalid scheme"))?;
    let at = body
        .rfind('@')
        .filter(|index| *index > 0)
        .ok_or_else(|| ParseError::new("trojan: missing credentials"))?;
    let user_info = &body[..at];
    let (host_port, query) = split_url_parts(&body[at + 1..]);
    let (host, port) = split_host_port(host_port, "trojan")?;

    let password = safe_decode(user_info);
    if password.is_empty() || password.len() > 512 {
        return Err(ParseError::new("trojan: missing password"));
    }

    let params = query_map(query);
    let get = |key: &str| params.get(key).cloned().unwrap_or_default();
    let security = params
        .get("security")
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "tls".into());
    if security != "tls" && security != "none" {
        return Err(ParseError::new("trojan: unsupported security"));
    }
    let network = params
        .get("type")
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "tcp".into());

    let mut entry = base_entry("trojan", host.clone(), port);
    entry.security = security;
    entry.network = network.clone();
    entry.transport = network;
    entry.sni = params
        .get("sni")
        .or_else(|| params.get("host"))
        .cloned()
        .unwrap_or(host);
    entry.credential = password;
    entry.extra = ServerExtra {
        path: get("path"),
        host: get("host"),
        alpn: get("alpn"),
        fp: get("fp"),
        allow_insecure: get("allowInsecure") == "1" || get("insecure") == "1",
        ..Default::default()
    };
    Ok(finalize(entry, fragment))
}

fn parse_shadowsocks(uri: &str, fragment: &str) -> Result<ServerEntry, ParseError> {
    let body = uri
        .strip_prefix("ss://")
        .ok_or_else(|| ParseError::new("ss: invalid scheme"))?;
    let at = body
        .rfind('@')
        .ok_or_else(|| ParseError::new("ss: missing server address"))?;
    let mut user_info = body[..at].to_string();
    let (host_port, query) = split_url_parts(&body[at + 1..]);
    let (host, port) = split_host_port(host_port, "ss")?;

    if !user_info.contains(':') {
        user_info = decode_base64(&user_info);
        if !user_info.contains(':') {
            return Err(ParseError::new(
                "ss: credentials are not in method:password form",
            ));
        }
    } else {
        user_info = safe_decode(&user_info);
    }
    let (method, password) = user_info
        .split_once(':')
        .ok_or_else(|| ParseError::new("ss: credentials are not in method:password form"))?;
    let method = method.trim().to_lowercase();
    if method.is_empty() {
        return Err(ParseError::new("ss: missing cipher method"));
    }
    if password.is_empty() || password.len() > 512 {
        return Err(ParseError::new("ss: missing password"));
    }

    let params = query_map(query);
    let plugin_raw = params.get("plugin").cloned().unwrap_or_default();
    let (plugin, plugin_opts) = if plugin_raw.is_empty() {
        (String::new(), String::new())
    } else {
        match plugin_raw.split_once(';') {
            Some((name, rest)) => (name.to_string(), rest.to_string()),
            None => (plugin_raw, String::new()),
        }
    };

    let mut entry = base_entry("ss", host, port);
    entry.credential = password.to_string();
    entry.extra = ServerExtra {
        cipher: method,
        plugin,
        plugin_opts,
        ..Default::default()
    };
    Ok(finalize(entry, fragment))
}

fn parse_proxy_link(uri: &str, protocol: &str, fragment: &str) -> Result<ServerEntry, ParseError> {
    let parsed =
        url::Url::parse(uri).map_err(|_| ParseError::new(format!("{protocol}: invalid URL")))?;
    let host = normalize_host(parsed.host_str().unwrap_or_default())
        .ok_or_else(|| ParseError::new(format!("{protocol}: invalid host")))?;
    let default_port = if protocol == "http" { 80 } else { 1080 };
    let port = parsed
        .port()
        .or_else(|| parse_port(&default_port.to_string()))
        .ok_or_else(|| ParseError::new(format!("{protocol}: invalid port")))?;

    let user = safe_decode(parsed.username());
    let credential = if user.is_empty() {
        String::new()
    } else if parsed.password().is_some() {
        format!(
            "{user}:{}",
            safe_decode(parsed.password().unwrap_or_default())
        )
    } else {
        user
    };

    let mut entry = base_entry(protocol, host, port);
    entry.credential = credential;
    Ok(finalize(entry, fragment))
}

/// Parses one configuration URI.
pub fn parse_config(uri: &str) -> Result<ServerEntry, ParseError> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Err(ParseError::new("entry is empty"));
    }
    if trimmed.len() > 64 * 1024 {
        return Err(ParseError::new("entry is too long"));
    }
    if trimmed.contains(['\r', '\n', '\t']) {
        return Err(ParseError::new("entry contains control characters"));
    }

    let scheme_end = trimmed
        .find("://")
        .ok_or_else(|| ParseError::new("entry has no URI scheme"))?;
    let scheme = trimmed[..scheme_end].to_lowercase();
    let valid_scheme = scheme.chars().enumerate().all(|(i, c)| {
        c.is_ascii_alphabetic() || (i > 0 && (c.is_ascii_digit() || "+.-".contains(c)))
    });
    if !valid_scheme {
        return Err(ParseError::new("entry has no URI scheme"));
    }
    if !SUPPORTED.contains(&scheme.as_str()) {
        return Err(ParseError::code(
            format!("unsupported scheme: {scheme}"),
            "unsupported",
        ));
    }

    let (without_fragment, fragment) = match trimmed.find('#') {
        Some(index) => (&trimmed[..index], safe_decode(&trimmed[index + 1..])),
        None => (trimmed, String::new()),
    };

    let mut entry = match scheme.as_str() {
        "vless" => parse_vless(without_fragment, &fragment)?,
        "vmess" => parse_vmess(without_fragment, &fragment)?,
        "trojan" => parse_trojan(without_fragment, &fragment)?,
        "ss" => parse_shadowsocks(without_fragment, &fragment)?,
        "socks" | "socks4" | "socks5" => parse_proxy_link(without_fragment, "socks", &fragment)?,
        "http" | "https" => parse_proxy_link(without_fragment, "http", &fragment)?,
        _ => return Err(ParseError::new("unsupported scheme")),
    };
    entry.raw = trimmed.to_string();
    Ok(entry)
}

/// Parses a whole newline-separated document, deduplicating endpoints.
pub fn parse_document(text: &str) -> ParsedDocument {
    let mut doc = ParsedDocument::default();
    if text.trim().is_empty() {
        doc.errors.push(ParseIssue {
            line: 0,
            reason: "empty document".into(),
            code: "empty".into(),
        });
        return doc;
    }

    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    doc.stats.received = lines.iter().filter(|l| !l.trim().is_empty()).count();
    let mut seen: HashSet<String> = HashSet::new();

    for (index, raw_line) in lines.iter().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if doc.entries.len() >= MAX_SERVERS {
            doc.errors.push(ParseIssue {
                line: index + 1,
                reason: "server limit reached".into(),
                code: "limit".into(),
            });
            doc.stats.rejected += 1;
            continue;
        }

        match parse_config(line) {
            Ok(entry) => {
                let credential_id = if entry.credential.is_empty() {
                    String::new()
                } else {
                    credential_hash(&entry.credential)
                };
                let key = format!(
                    "{}|{}|{}|{}",
                    entry.protocol, entry.host, entry.port, credential_id
                );
                if !seen.insert(key) {
                    doc.stats.duplicates += 1;
                    continue;
                }
                doc.stats.parsed += 1;
                doc.entries.push(entry);
            }
            Err(error) => {
                if error.code == "unsupported" {
                    doc.stats.unsupported += 1;
                }
                doc.stats.rejected += 1;
                doc.errors.push(ParseIssue {
                    line: index + 1,
                    reason: error.message,
                    code: error.code.to_string(),
                });
            }
        }
    }
    doc.stats.kept = doc.entries.len();
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    const VLESS: &str = "vless://18805ff3-b420-45de-af18-93be14024ae8@47.251.25.74:443?security=reality&encryption=none&pbk=H56cOJhw0xw76lDEpt7IuJJmVGemK6_CK34KtHwDMX8&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=yahoo.com&sid=c39cc7#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20272";

    #[test]
    fn parses_vless_reality_with_flag_label() {
        let entry = parse_config(VLESS).unwrap();
        assert_eq!(entry.protocol, "vless");
        assert_eq!(entry.host, "47.251.25.74");
        assert_eq!(entry.port, 443);
        assert_eq!(entry.security, "reality");
        assert_eq!(entry.network, "tcp");
        assert_eq!(entry.flow, "xtls-rprx-vision");
        assert_eq!(entry.sni, "yahoo.com");
        assert_eq!(entry.country.as_deref(), Some("The Netherlands"));
        assert_eq!(entry.country_code.as_deref(), Some("NL"));
        assert_eq!(entry.flag, "🇳🇱");
        assert!(entry.label.starts_with("The Netherlands"));
    }

    #[test]
    fn parses_vmess_base64_payload() {
        let payload = base64::engine::general_purpose::STANDARD.encode(
            r#"{"v":"2","ps":"Tokyo 01","add":"1.2.3.4","port":"8443","id":"abc-123","net":"ws","tls":"tls","host":"cdn.example.com","path":"/ray"}"#,
        );
        let entry = parse_config(&format!("vmess://{payload}")).unwrap();
        assert_eq!(entry.protocol, "vmess");
        assert_eq!(entry.host, "1.2.3.4");
        assert_eq!(entry.port, 8443);
        assert_eq!(entry.security, "tls");
        assert_eq!(entry.network, "ws");
        assert_eq!(entry.extra.path, "/ray");
        assert_eq!(entry.label, "Tokyo 01");
    }

    #[test]
    fn parses_trojan_ss_and_socks() {
        let trojan = parse_config(
            "trojan://secret@example.com:443?security=tls&type=ws&path=%2Fws#Canada%20003",
        )
        .unwrap();
        assert_eq!(trojan.protocol, "trojan");
        assert_eq!(trojan.credential, "secret");
        assert_eq!(trojan.extra.path, "/ws");

        let ss = parse_config("ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@4.4.4.4:8388#Japan%20010").unwrap();
        assert_eq!(ss.protocol, "ss");
        assert_eq!(ss.extra.cipher, "aes-256-gcm");
        assert_eq!(ss.credential, "password");

        let socks = parse_config("socks://user:pass@5.5.5.5:1080#Mystery%20Node").unwrap();
        assert_eq!(socks.protocol, "socks");
        assert_eq!(socks.credential, "user:pass");
        assert_eq!(socks.country, None);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_config("not-a-uri").is_err());
        assert_eq!(
            parse_config("ftp://example.com:21").unwrap_err().code,
            "unsupported"
        );
        assert_eq!(
            parse_config("vless://not-a-uuid@1.1.1.1:443")
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            parse_config("vless://18805ff3-b420-45de-af18-93be14024ae8@1.1.1.1:0")
                .unwrap_err()
                .code,
            "invalid"
        );
    }

    #[test]
    fn normalises_server_names() {
        assert_eq!(normalize_server_name("Netherlands 001"), "Netherlands 01");
        assert_eq!(normalize_server_name("Netherlands 010"), "Netherlands 10");
        assert_eq!(
            normalize_server_name("United States 781"),
            "United States 781"
        );
        assert_eq!(normalize_server_name("Server-0042"), "Server 42");
        assert_eq!(normalize_server_name("PlainName"), "PlainName");
        assert_eq!(normalize_server_name("123"), "123");
    }

    #[test]
    fn document_stats_and_dedupe() {
        let doc = parse_document(&format!("{VLESS}\n{VLESS}\nftp://a.b:21\n\nnot-a-uri\n"));
        assert_eq!(doc.stats.received, 4);
        assert_eq!(doc.stats.parsed, 1);
        assert_eq!(doc.stats.duplicates, 1);
        assert_eq!(doc.stats.unsupported, 1);
        assert_eq!(doc.stats.rejected, 2);
        assert_eq!(doc.stats.kept, 1);
        assert_eq!(doc.entries[0].raw, VLESS);
    }

    #[test]
    fn empty_document_is_reported() {
        let doc = parse_document("   \n");
        assert!(doc.entries.is_empty());
        assert_eq!(doc.errors[0].code, "empty");
    }
}
