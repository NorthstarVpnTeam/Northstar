//! Server store: the current configuration list, selection, per-server latency
//! and grouping. Serialises only the fields the renderer needs — never raw
//! configuration URIs or credentials.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::country::flag_for;
use crate::now_ms;
use crate::parser::{parse_document, ParseIssue, ParseStats, ServerEntry};

pub const UNKNOWN_GROUP: &str = "Unknown";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyRecord {
    pub ms: Option<u64>,
    pub ok: bool,
    pub kind: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRow {
    pub id: String,
    pub protocol: String,
    pub label: String,
    pub country: String,
    pub country_code: Option<String>,
    pub flag: String,
    pub host: String,
    pub port: u16,
    pub security: String,
    pub network: String,
    pub selected: bool,
    pub latency: Option<u64>,
    pub latency_kind: Option<String>,
    pub latency_ok: Option<bool>,
    pub latency_at: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct GroupsOptions {
    pub sort: String,
    pub hide_failed: bool,
    pub query: String,
    pub protocol: String,
    pub status: String,
}

#[derive(Debug, Default)]
pub struct ServerStore {
    servers: Vec<ServerEntry>,
    selected_id: Option<String>,
    latency: HashMap<String, LatencyRecord>,
    stats: ParseStats,
    errors: Vec<ParseIssue>,
    source: String,
    fetched_at: u64,
}

impl ServerStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the list from a document. Returns ingest stats.
    pub fn load_document(&mut self, text: &str, source: &str) -> ParseStats {
        let parsed = parse_document(text);
        self.servers = parsed.entries;
        self.stats = parsed.stats.clone();
        self.errors = parsed.errors.into_iter().take(200).collect();
        self.source = source.to_string();
        self.fetched_at = now_ms();

        let ids: HashSet<&str> = self.servers.iter().map(|s| s.id.as_str()).collect();
        self.latency.retain(|id, _| ids.contains(id.as_str()));
        if let Some(selected) = &self.selected_id {
            if !ids.contains(selected.as_str()) {
                self.selected_id = None;
            }
        }
        parsed.stats
    }

    pub fn clear(&mut self) {
        self.servers.clear();
        self.selected_id = None;
        self.latency.clear();
        self.stats = ParseStats::default();
        self.errors.clear();
        self.source.clear();
        self.fetched_at = 0;
    }

    pub fn count(&self) -> usize {
        self.servers.len()
    }

    pub fn get(&self, id: &str) -> Option<&ServerEntry> {
        self.servers.iter().find(|s| s.id == id)
    }

    pub fn selected_id(&self) -> Option<String> {
        self.selected_id.clone()
    }

    pub fn select(&mut self, id: Option<String>) -> bool {
        match &id {
            Some(value) if self.get(value).is_none() => false,
            _ => {
                self.selected_id = id;
                true
            }
        }
    }

    pub fn set_latency(&mut self, id: &str, record: LatencyRecord) -> bool {
        if self.get(id).is_none() {
            return false;
        }
        self.latency.insert(id.to_string(), record);
        true
    }

    pub fn clear_latency(&mut self) {
        self.latency.clear();
    }

    fn record_for(&self, id: &str) -> Option<&LatencyRecord> {
        self.latency.get(id)
    }

    pub fn rows(&self) -> Vec<ServerRow> {
        self.servers
            .iter()
            .map(|server| {
                let record = self.record_for(&server.id);
                ServerRow {
                    id: server.id.clone(),
                    protocol: server.protocol.clone(),
                    label: server.label.clone(),
                    country: server
                        .country
                        .clone()
                        .unwrap_or_else(|| UNKNOWN_GROUP.into()),
                    country_code: server.country_code.clone(),
                    flag: server.flag.clone(),
                    host: server.host.clone(),
                    port: server.port,
                    security: server.security.clone(),
                    network: server.network.clone(),
                    selected: self.selected_id.as_deref() == Some(server.id.as_str()),
                    latency: record.and_then(|r| r.ms),
                    latency_kind: record.map(|r| r.kind.clone()),
                    latency_ok: record.map(|r| r.ok),
                    latency_at: record.map(|r| r.at),
                }
            })
            .collect()
    }

    fn matches(&self, row: &ServerRow, options: &GroupsOptions) -> bool {
        if options.hide_failed && row.latency_ok == Some(false) {
            return false;
        }
        if options.protocol != "" && options.protocol != "all" && row.protocol != options.protocol {
            return false;
        }
        match options.status.as_str() {
            "ok" if row.latency_ok != Some(true) => return false,
            "failed" if row.latency_ok != Some(false) => return false,
            "untested" if row.latency_ok.is_some() => return false,
            "selected" if !row.selected => return false,
            _ => {}
        }
        let query = options.query.trim().to_lowercase();
        if query.is_empty() {
            return true;
        }
        row.label.to_lowercase().contains(&query)
            || row.country.to_lowercase().contains(&query)
            || row.protocol.to_lowercase().contains(&query)
    }

    /// Groups filtered rows by country. Unknown is always last.
    pub fn groups(&self, options: &GroupsOptions) -> Vec<Value> {
        let rows: Vec<ServerRow> = self
            .rows()
            .into_iter()
            .filter(|row| self.matches(row, options))
            .collect();

        let mut order: Vec<String> = Vec::new();
        let mut buckets: HashMap<String, Vec<ServerRow>> = HashMap::new();
        for row in rows {
            let key = row.country.clone();
            if !buckets.contains_key(&key) {
                order.push(key.clone());
            }
            buckets.entry(key).or_default().push(row);
        }

        let latency_of = |row: &ServerRow| row.latency.unwrap_or(u64::MAX);
        let compare = |a: &ServerRow, b: &ServerRow| match options.sort.as_str() {
            "latency" => latency_of(a)
                .cmp(&latency_of(b))
                .then_with(|| natural_compare(&a.label, &b.label)),
            "protocol" => natural_compare(&a.protocol, &b.protocol)
                .then_with(|| natural_compare(&a.label, &b.label)),
            _ => natural_compare(&a.label, &b.label),
        };

        let mut groups: Vec<Value> = order
            .into_iter()
            .map(|name| {
                let mut servers = buckets.remove(&name).unwrap_or_default();
                servers.sort_by(compare);
                let code = servers.first().and_then(|s| s.country_code.clone());
                let flag = if name == UNKNOWN_GROUP {
                    "🌐".to_string()
                } else {
                    servers
                        .first()
                        .map(|s| s.flag.clone())
                        .filter(|f| !f.is_empty())
                        .or_else(|| code.as_deref().map(flag_for))
                        .unwrap_or_default()
                };
                let measured = servers
                    .iter()
                    .filter(|s| s.latency_ok == Some(true))
                    .count();
                let count = servers.len();
                json!({
                    "name": name,
                    "flag": flag,
                    "code": code,
                    "count": count,
                    "measured": measured,
                    "servers": servers,
                })
            })
            .collect();

        groups.sort_by(|a, b| {
            let name_a = a["name"].as_str().unwrap_or_default();
            let name_b = b["name"].as_str().unwrap_or_default();
            if name_a == UNKNOWN_GROUP {
                return std::cmp::Ordering::Greater;
            }
            if name_b == UNKNOWN_GROUP {
                return std::cmp::Ordering::Less;
            }
            natural_compare(name_a, name_b)
        });
        groups
    }

    /// Top-level ingest metadata for the UI (no credentials).
    pub fn meta(&self) -> Value {
        let errors: Vec<Value> = self
            .errors
            .iter()
            .take(50)
            .map(|error| {
                json!({
                    "line": error.line,
                    "reason": error.reason,
                    "code": error.code,
                })
            })
            .collect();
        json!({
            "source": self.source,
            "fetchedAt": self.fetched_at,
            "stats": self.stats,
            "errorCount": self.errors.len(),
            "errors": errors,
            "selectedId": self.selected_id(),
        })
    }

    /// Masked technical details for one server.
    pub fn details(&self, id: &str) -> Option<Value> {
        let server = self.get(id)?;
        let credential_masked = mask_credential(&server.credential);
        Some(json!({
            "protocol": server.protocol,
            "country": server.country,
            "host": server.host,
            "port": server.port,
            "security": server.security,
            "transport": server.transport,
            "sni": server.sni,
            "flow": server.flow,
            "credentialMasked": credential_masked,
            "cipher": server.extra.cipher,
            "plugin": server.extra.plugin,
        }))
    }

    pub fn raw_uri(&self, id: &str) -> Option<String> {
        self.get(id).map(|s| s.raw.clone())
    }

    pub fn entries(&self) -> &[ServerEntry] {
        &self.servers
    }
}

fn mask_credential(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    let suffix: String = credential
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if credential.chars().count() <= 4 {
        "••••".into()
    } else {
        format!("••••{suffix}")
    }
}

fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ServerStore {
        let mut store = ServerStore::new();
        let doc = [
            "vless://a715374a-a745-4800-889b-0c864fad5ca0@1.1.1.1:443?security=tls&type=tcp#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20001",
            "vless://b715374a-a745-4800-889b-0c864fad5ca0@2.2.2.2:443?security=tls&type=tcp#United%20States%20002",
            "trojan://pw@3.3.3.3:443#%F0%9F%87%A8%F0%9F%87%A6%20Canada%20003",
            "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@4.4.4.4:8388#Japan%20010",
            "socks://5.5.5.5:1080#Mystery%20Node",
        ]
        .join("\n");
        store.load_document(&doc, "https://example.test/all.txt");
        store
    }

    #[test]
    fn groups_by_country_with_unknown_last() {
        let store = store();
        let groups = store.groups(&GroupsOptions {
            sort: "name".into(),
            ..Default::default()
        });
        let names: Vec<&str> = groups.iter().filter_map(|g| g["name"].as_str()).collect();
        assert!(names.contains(&"United States"));
        assert!(names.contains(&"Canada"));
        assert!(names.contains(&"Japan"));
        assert_eq!(names.last().copied(), Some(UNKNOWN_GROUP));
        let us = groups
            .iter()
            .find(|g| g["name"] == "United States")
            .unwrap();
        assert_eq!(us["count"], 2);
        assert_eq!(us["flag"], "🇺🇸");
    }

    #[test]
    fn latency_sort_and_failed_filter() {
        let mut store = store();
        let ids: Vec<String> = store.rows().iter().map(|r| r.id.clone()).collect();
        store.set_latency(
            &ids[0],
            LatencyRecord {
                ms: Some(250),
                ok: true,
                kind: "tcp".into(),
                at: now_ms(),
            },
        );
        store.set_latency(
            &ids[1],
            LatencyRecord {
                ms: Some(90),
                ok: true,
                kind: "tcp".into(),
                at: now_ms(),
            },
        );
        let groups = store.groups(&GroupsOptions {
            sort: "latency".into(),
            ..Default::default()
        });
        let us = groups
            .iter()
            .find(|g| g["name"] == "United States")
            .unwrap();
        assert_eq!(us["servers"][0]["latency"], 90);
        assert_eq!(us["servers"][1]["latency"], 250);

        store.set_latency(
            &ids[0],
            LatencyRecord {
                ms: None,
                ok: false,
                kind: "tcp".into(),
                at: now_ms(),
            },
        );
        let visible = store.groups(&GroupsOptions {
            sort: "name".into(),
            hide_failed: true,
            ..Default::default()
        });
        let total: usize = visible
            .iter()
            .map(|g| g["count"].as_u64().unwrap_or(0) as usize)
            .sum();
        assert_eq!(total, store.count() - 1);
    }

    #[test]
    fn search_and_status_filters_compose() {
        let store = store();
        let by_query = store.groups(&GroupsOptions {
            query: "canada".into(),
            ..Default::default()
        });
        assert_eq!(by_query.len(), 1);
        assert_eq!(by_query[0]["name"], "Canada");

        let by_protocol = store.groups(&GroupsOptions {
            protocol: "trojan".into(),
            ..Default::default()
        });
        assert_eq!(by_protocol.len(), 1);
        assert_eq!(by_protocol[0]["count"], 1);

        let untested = store.groups(&GroupsOptions {
            status: "untested".into(),
            ..Default::default()
        });
        let total: usize = untested
            .iter()
            .map(|g| g["count"].as_u64().unwrap_or(0) as usize)
            .sum();
        assert_eq!(total, 5);
    }

    #[test]
    fn rows_and_details_never_leak_credentials() {
        let store = store();
        for row in store.rows() {
            let text = serde_json::to_string(&row).unwrap();
            assert!(!text.contains("vless://"));
            assert!(!text.contains("password"));
        }
        let id = store.rows()[0].id.clone();
        let details = store.details(&id).unwrap();
        assert!(details["credentialMasked"]
            .as_str()
            .unwrap()
            .starts_with("••••"));
        assert!(store.raw_uri(&id).unwrap().starts_with("vless://"));
    }

    #[test]
    fn stale_selection_and_latency_are_dropped() {
        let mut store = store();
        let id = store.rows()[0].id.clone();
        store.select(Some(id.clone()));
        store.set_latency(
            &id,
            LatencyRecord {
                ms: Some(42),
                ok: true,
                kind: "tcp".into(),
                at: now_ms(),
            },
        );
        store.load_document("trojan://pw@9.9.9.9:443#Fresh", "x");
        assert_eq!(store.selected_id(), None);
        assert!(!store.set_latency(
            &id,
            LatencyRecord {
                ms: Some(1),
                ok: true,
                kind: "tcp".into(),
                at: now_ms()
            }
        ));
    }
}
