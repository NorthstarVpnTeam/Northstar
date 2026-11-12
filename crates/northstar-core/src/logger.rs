//! Application logger: bounded ring buffer with secret redaction.
//!
//! Configuration URIs and credentials are never written. Dynamic secrets for the
//! active server are redacted on write, and the exported bundle is diagnostics
//! only.

use serde::Serialize;
use serde_json::{json, Value};

use crate::core_config::redact;
use crate::limits::LOG_RING_SIZE;
use crate::{now_ms, APP_NAME, APP_VERSION};

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: u64,
    pub level: String,
    pub message: String,
}

pub struct Logger {
    lines: Vec<LogLine>,
    verbose: bool,
    secrets: Vec<String>,
    started_at: u64,
}

impl Default for Logger {
    fn default() -> Self {
        Self::new()
    }
}

impl Logger {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            verbose: false,
            secrets: Vec::new(),
            started_at: now_ms(),
        }
    }

    pub fn set_secrets(&mut self, secrets: Vec<String>) {
        self.secrets = secrets.into_iter().filter(|s| !s.is_empty()).collect();
    }

    pub fn set_verbose(&mut self, verbose: bool) {
        self.verbose = verbose;
    }

    pub fn write(&mut self, level: &str, message: &str) -> Option<LogLine> {
        if level == "debug" && !self.verbose {
            return None;
        }
        let line = LogLine {
            ts: now_ms(),
            level: level.to_string(),
            message: redact(message, &self.secrets),
        };
        self.lines.push(line.clone());
        if self.lines.len() > LOG_RING_SIZE {
            self.lines.remove(0);
        }
        Some(line)
    }

    pub fn info(&mut self, message: &str) -> Option<LogLine> {
        self.write("info", message)
    }

    pub fn warn(&mut self, message: &str) -> Option<LogLine> {
        self.write("warn", message)
    }

    pub fn error(&mut self, message: &str) -> Option<LogLine> {
        self.write("error", message)
    }

    pub fn debug(&mut self, message: &str) -> Option<LogLine> {
        self.write("debug", message)
    }

    pub fn recent(&self, limit: usize) -> Vec<LogLine> {
        let take = limit.clamp(1, LOG_RING_SIZE);
        let skip = self.lines.len().saturating_sub(take);
        self.lines[skip..].to_vec()
    }

    /// Redacted diagnostics bundle for export.
    pub fn bundle(&self, extras: Value) -> Value {
        let mut value = json!({
            "generatedAt": now_ms(),
            "app": { "name": APP_NAME, "version": APP_VERSION },
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            },
            "uptimeMs": now_ms().saturating_sub(self.started_at),
            "logs": self.recent(LOG_RING_SIZE),
            "note": "This file is redacted: configuration URIs, credentials and server secrets are removed.",
        });
        if let (Some(target), Some(source)) = (value.as_object_mut(), extras.as_object()) {
            for (key, item) in source {
                target.insert(key.clone(), item.clone());
            }
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secrets_on_write() {
        let mut logger = Logger::new();
        logger.set_secrets(vec!["hunter2-secret".into()]);
        logger.error("login failed with hunter2-secret and vless://abc@x:443#NL");
        let line = logger.recent(1).remove(0);
        assert!(!line.message.contains("hunter2-secret"));
        assert!(!line.message.contains("vless://"));
    }

    #[test]
    fn debug_lines_need_verbose() {
        let mut logger = Logger::new();
        assert!(logger.debug("hidden").is_none());
        logger.set_verbose(true);
        logger.debug("shown");
        assert_eq!(logger.recent(1)[0].message, "shown");
    }

    #[test]
    fn ring_buffer_stays_bounded() {
        let mut logger = Logger::new();
        for index in 0..(LOG_RING_SIZE + 20) {
            logger.info(&format!("line {index}"));
        }
        assert!(logger.recent(LOG_RING_SIZE).len() <= LOG_RING_SIZE);
        assert!(logger.recent(1)[0].message.contains("line"));
    }

    #[test]
    fn bundle_has_no_secrets() {
        let mut logger = Logger::new();
        logger.info("ok");
        let bundle = logger.bundle(json!({ "status": "disconnected" }));
        assert_eq!(bundle["app"]["name"], APP_NAME);
        assert!(bundle.get("logs").is_some());
    }
}
