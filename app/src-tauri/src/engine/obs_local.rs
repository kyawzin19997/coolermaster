//! Discover the local OBS control service from OBS's own configuration.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const CONFIG_LIMIT: u64 = 1024 * 1024;

pub(super) struct Endpoint {
    pub(super) enabled: bool,
    pub(super) port: u16,
    pub(super) password: Option<String>,
}

enum Config {
    Json(serde_json::Map<String, serde_json::Value>),
    Ini(String),
}

impl Config {
    fn endpoint(&self) -> Endpoint {
        let (enabled, port, auth, password) = match self {
            Self::Json(data) => (
                data.get("server_enabled").and_then(|v| v.as_bool()),
                data.get("server_port").and_then(|v| v.as_u64()),
                data.get("auth_required").and_then(|v| v.as_bool()),
                data.get("server_password").and_then(|v| v.as_str()),
            ),
            Self::Ini(text) => (
                ini_value(text, "ServerEnabled").and_then(ini_bool),
                ini_value(text, "ServerPort").and_then(|v| v.parse().ok()),
                ini_value(text, "AuthRequired").and_then(ini_bool),
                ini_value(text, "ServerPassword"),
            ),
        };
        Endpoint {
            enabled: enabled.unwrap_or(false),
            port: port.and_then(|p| u16::try_from(p).ok()).filter(|&p| p != 0).unwrap_or(4455),
            password: password.filter(|p| auth.unwrap_or(true) && !p.is_empty()).map(str::to_string),
        }
    }

    fn enable(mut self) -> Result<Vec<u8>, String> {
        let had_password = self.endpoint().password.is_some();
        match &mut self {
            Self::Json(data) => {
                data.insert("server_enabled".into(), true.into());
                data.insert("auth_required".into(), true.into());
                if !data.get("server_password").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()) {
                    data.insert("server_password".into(), uuid::Uuid::new_v4().simple().to_string().into());
                }
                serde_json::to_vec_pretty(data).map_err(|_| "Could not prepare the OBS configuration.".into())
            }
            Self::Ini(text) if had_password => Ok(enable_ini(text).into_bytes()),
            Self::Ini(_) => Err("This older OBS installation needs a password-protected control service. Update OBS Studio or enable authentication in OBS once.".into()),
        }
    }
}

fn ini_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

fn section(line: &str) -> Option<&str> {
    line.trim().trim_start_matches('\u{feff}').strip_prefix('[')?.split_once(']').map(|(name, _)| name)
}

fn ini_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut in_obs = false;
    for line in text.lines() {
        if let Some(name) = section(line) {
            in_obs = name.eq_ignore_ascii_case("OBSWebSocket");
        } else if in_obs
            && let Some((name, value)) = line.split_once('=')
            && name.trim().eq_ignore_ascii_case(key)
        {
            return Some(value.trim());
        }
    }
    None
}

fn enable_ini(text: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut result = String::with_capacity(text.len() + 32);
    let mut in_obs = false;
    let mut written = false;
    for line in text.split_inclusive('\n') {
        if let Some(name) = section(line) {
            if in_obs && !written {
                result.push_str("ServerEnabled=true");
                result.push_str(newline);
                written = true;
            }
            in_obs = name.eq_ignore_ascii_case("OBSWebSocket");
        } else if in_obs && line.split_once('=').is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("ServerEnabled")) {
            result.push_str("ServerEnabled=true");
            result.push_str(newline);
            written = true;
            continue;
        }
        result.push_str(line);
    }
    if !written && in_obs {
        if !result.ends_with('\n') {
            result.push_str(newline);
        }
        result.push_str("ServerEnabled=true");
        result.push_str(newline);
    }
    result
}

fn read(path: &Path) -> std::io::Result<String> {
    let mut content = String::new();
    fs::File::open(path)?.take(CONFIG_LIMIT + 1).read_to_string(&mut content)?;
    if content.len() as u64 > CONFIG_LIMIT {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "OBS configuration is too large"));
    }
    Ok(content)
}

fn find(roots: &[PathBuf]) -> std::io::Result<Option<(PathBuf, Config)>> {
    use std::io::{Error, ErrorKind};
    for root in roots {
        let json_path = root.join("plugin_config/obs-websocket/config.json");
        match read(&json_path) {
            Ok(text) => {
                let data = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| Error::new(ErrorKind::InvalidData, "invalid OBS configuration"))?;
                return Ok(Some((json_path, Config::Json(data))));
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        for name in ["user.ini", "global.ini"] {
            let path = root.join(name);
            match read(&path) {
                Ok(text) if ["ServerEnabled", "ServerPort", "AuthRequired", "ServerPassword"].iter().any(|key| ini_value(&text, key).is_some()) => return Ok(Some((path, Config::Ini(text)))),
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(None)
}

pub(super) fn discover(roots: &[PathBuf]) -> std::io::Result<Option<Endpoint>> {
    Ok(find(roots)?.map(|(_, config)| config.endpoint()))
}

fn obs_running() -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    system.processes().values().any(|p| ["obs", "obs-studio", "obs.exe", "obs64.exe", "obs32.exe"].iter().any(|name| p.name().eq_ignore_ascii_case(name)))
}

fn replace_config(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("masterdeck-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(&temporary)?;
    let result = handle.write_all(bytes).and_then(|()| handle.sync_all());
    drop(handle);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn enable(roots: &[PathBuf]) -> Result<(), String> {
    static EDIT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = EDIT.lock().map_err(|_| "OBS setup is unavailable.")?;
    let (path, config) = find(roots).map_err(|_| "MasterDeck could not read the local OBS configuration.")?.ok_or("Open and close OBS Studio once, then try again.")?;
    if config.endpoint().enabled {
        return Ok(());
    }
    if obs_running() {
        return Err("Close OBS Studio, then try again. MasterDeck can set up the connection when OBS is closed.".into());
    }
    let bytes = config.enable()?;
    replace_config(&path, &bytes).map_err(|_| "MasterDeck could not save the local OBS connection settings.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_obs_config_wins_over_legacy_and_preserves_settings() {
        let root = std::env::temp_dir().join(format!("masterdeck-obs-{}", uuid::Uuid::new_v4()));
        let modern = root.join("plugin_config/obs-websocket/config.json");
        fs::create_dir_all(modern.parent().unwrap()).unwrap();
        fs::write(root.join("global.ini"), "[OBSWebSocket]\nServerEnabled=true\nServerPort=9999\n").unwrap();
        fs::write(&modern, r#"{"server_port":45678,"server_enabled":false,"auth_required":false,"alerts_enabled":true,"extra":"keep"}"#).unwrap();
        let (_, config) = find(std::slice::from_ref(&root)).unwrap().unwrap();
        let before = config.endpoint();
        assert!(!before.enabled);
        assert_eq!(before.port, 45678);
        assert!(before.password.is_none());
        replace_config(&modern, &config.enable().unwrap()).unwrap();
        let after = discover(std::slice::from_ref(&root)).unwrap().unwrap();
        assert!(after.enabled);
        assert_eq!(after.port, before.port);
        assert!(after.password.is_some_and(|p| p.len() >= 24));
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&modern).unwrap()).unwrap();
        assert_eq!(json["extra"], json!("keep"));
        assert_eq!(json["alerts_enabled"], json!(true));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_setup_preserves_other_sections_and_credentials() {
        let before = "[General]\r\nVersion=old\r\n[OBSWebSocket]\r\nServerPort=4460\r\nAuthRequired=true\r\nServerPassword=example=fixture\r\n[Video]\r\nBaseCX=1920\r\n";
        let after = Config::Ini(before.into()).enable().unwrap();
        let after = String::from_utf8(after).unwrap();
        assert_eq!(after, before.replace("[Video]", "ServerEnabled=true\r\n[Video]"));
        let endpoint = Config::Ini(after).endpoint();
        assert!(endpoint.enabled);
        assert_eq!(endpoint.port, 4460);
        assert_eq!(endpoint.password.as_deref(), Some("example=fixture"));
    }
}
