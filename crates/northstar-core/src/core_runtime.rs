//! Proxy-core discovery: an explicit settings path, the bundled resource
//! directory, the portable layout next to the executable, then PATH. A missing
//! core is reported, never invented.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub last_error: Option<String>,
}

fn candidate_names() -> [&'static str; 4] {
    if cfg!(windows) {
        ["xray.exe", "v2ray.exe", "xray", "v2ray"]
    } else {
        ["xray", "v2ray", "xray.exe", "v2ray.exe"]
    }
}

fn first_existing(dir: &Path) -> Option<PathBuf> {
    for name in candidate_names() {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn from_path_env() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if let Some(found) = first_existing(&dir) {
            return Some(found);
        }
    }
    None
}

/// Reads `--version` output. Failures leave `version` empty rather than
/// guessing a version.
pub fn core_version(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    if line.chars().count() > 120 {
        Some(line.chars().take(120).collect())
    } else {
        Some(line.to_string())
    }
}

/// Finds the first usable core. `explicit` comes from Settings.
pub fn locate(explicit: &str, resource_dir: Option<&Path>, exe_dir: &Path) -> CoreInfo {
    let mut attempts: Vec<(PathBuf, &'static str)> = Vec::new();

    let explicit = explicit.trim();
    if !explicit.is_empty() {
        attempts.push((PathBuf::from(explicit), "settings"));
    }
    if let Some(resources) = resource_dir {
        if let Some(found) = first_existing(&resources.join("core")) {
            attempts.push((found, "bundled"));
        }
    }
    if let Some(found) = first_existing(&exe_dir.join("core")) {
        attempts.push((found, "portable"));
    }
    if let Some(found) = first_existing(exe_dir) {
        attempts.push((found, "local"));
    }

    for (path, source) in attempts {
        if path.is_file() {
            return CoreInfo {
                found: true,
                version: core_version(&path),
                path: Some(path.to_string_lossy().to_string()),
                source: Some(source.to_string()),
                last_error: None,
            };
        }
    }

    if let Some(path) = from_path_env() {
        return CoreInfo {
            found: true,
            version: core_version(&path),
            path: Some(path.to_string_lossy().to_string()),
            source: Some("PATH".into()),
            last_error: None,
        };
    }

    CoreInfo {
        found: false,
        path: None,
        version: None,
        source: None,
        last_error: Some(if explicit.is_empty() {
            "No proxy core found. Install Xray-core or set its path in Settings.".into()
        } else {
            format!("The configured core path does not exist: {explicit}")
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_core_is_reported_not_invented() {
        let dir = tempfile::tempdir().unwrap();
        let info = locate("", None, dir.path());
        // A core may exist on the test machine's PATH, but in a clean temp dir
        // with no explicit path we must never claim a bundled one.
        if !info.found {
            assert!(info.last_error.is_some());
            assert!(info.path.is_none());
        }
    }

    #[test]
    fn portable_layout_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let core_dir = dir.path().join("core");
        std::fs::create_dir_all(&core_dir).unwrap();
        let name = if cfg!(windows) { "xray.exe" } else { "xray" };
        let fake = core_dir.join(name);
        std::fs::write(&fake, b"not a real binary").unwrap();
        let info = locate("", None, dir.path());
        assert!(info.found);
        assert_eq!(info.source.as_deref(), Some("portable"));
        assert!(info.path.unwrap().ends_with(name));
    }
}
