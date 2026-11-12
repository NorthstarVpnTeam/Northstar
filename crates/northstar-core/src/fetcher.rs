//! Configuration fetching with explicit timeouts, a bounded response size and
//! progress reporting. Document contents are never logged.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt;

use crate::limits::{FETCH_MAX_BYTES, FETCH_TIMEOUT_MS};

#[derive(Debug, Clone)]
pub struct FetchError {
    pub message: String,
    pub code: &'static str,
    pub status: u16,
}

impl FetchError {
    fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
            status: 0,
        }
    }
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FetchError {}

/// Downloads a configuration document.
///
/// `on_progress` receives `(phase, loaded_bytes)` where phase is `connecting`,
/// `downloading` or `done`.
pub async fn fetch_configuration<F>(url: &str, mut on_progress: F) -> Result<String, FetchError>
where
    F: FnMut(&str, usize),
{
    let parsed = url::Url::parse(url)
        .map_err(|_| FetchError::new("The configuration source URL is invalid.", "invalid-url"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(FetchError::new(
            "The configuration source must use http or https.",
            "invalid-url",
        ));
    }

    let client = reqwest::Client::builder()
        .user_agent("NorthstarV2Ray/2.1")
        .connect_timeout(Duration::from_millis(10_000))
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| FetchError::new(error.to_string(), "network"))?;

    on_progress("connecting", 0);
    let response = client.get(parsed).send().await.map_err(map_error)?;

    let status = response.status();
    if !status.is_success() {
        let mut error = FetchError::new(
            format!(
                "The configuration source returned HTTP {}.",
                status.as_u16()
            ),
            "http-error",
        );
        error.status = status.as_u16();
        return Err(error);
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.is_empty()
        && !["text", "json", "plain", "octet-stream"]
            .iter()
            .any(|token| content_type.contains(token))
    {
        return Err(FetchError::new(
            format!(
                "The configuration source returned an unexpected content type ({content_type})."
            ),
            "bad-content-type",
        ));
    }

    if let Some(length) = response.content_length() {
        if length as usize > FETCH_MAX_BYTES {
            return Err(FetchError::new(
                "The configuration document is too large.",
                "too-large",
            ));
        }
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_error)?;
        if buffer.len() + chunk.len() > FETCH_MAX_BYTES {
            return Err(FetchError::new(
                "The configuration document is too large.",
                "too-large",
            ));
        }
        buffer.extend_from_slice(&chunk);
        on_progress("downloading", buffer.len());
    }

    let text = String::from_utf8_lossy(&buffer).into_owned();
    on_progress("done", buffer.len());
    Ok(text)
}

fn map_error(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        return FetchError::new(
            "The configuration source did not respond in time.",
            "timeout",
        );
    }
    if error.is_connect() {
        let text = error.to_string().to_lowercase();
        if text.contains("dns") || text.contains("resolve") || text.contains("name or service") {
            return FetchError::new(
                "The configuration host could not be resolved (DNS failure).",
                "dns",
            );
        }
        if text.contains("refused") {
            return FetchError::new(
                "The configuration source refused the connection.",
                "refused",
            );
        }
        return FetchError::new("The network connection was interrupted.", "network");
    }
    FetchError::new("Could not download configurations.", "network")
}
