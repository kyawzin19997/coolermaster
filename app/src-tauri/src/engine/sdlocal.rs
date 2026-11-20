//! Stream Deck plugins already on this computer: the ones Elgato's Stream Deck app installed (taken
//! into HubDeck with one click; plugins whose files Elgato encrypted stay with Elgato's app) and
//! `.streamDeckPlugin` files opened with HubDeck (a double click, Open with, a drop on the window).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sdplugins;

/// Where Elgato's Stream Deck app keeps its plugins (`<uuid>.sdPlugin` folders).
pub fn stream_deck_folder() -> Option<PathBuf> {
    // a folder made for a check (`scripts/ui/plugin-sources.mjs`), so Elgato's own is never touched
    if let Some(dir) = std::env::var_os("HUBDECK_STREAM_DECK_PLUGINS") {
        return Some(dir.into());
    }
    #[cfg(windows)]
    return std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Elgato").join("StreamDeck").join("Plugins"));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/com.elgato.StreamDeck/Plugins"));
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

/// A plugin found on this computer.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    /// Its icon as a data URI.
    pub icon: Option<String>,
    /// Why HubDeck cannot run it; None: it can.
    pub problem: Option<String>,
    pub actions: usize,
    pub digest: Option<String>,
    pub installed_version: Option<String>,
}

/// What a `<uuid>.sdPlugin` folder holds.
pub fn look(dir: &Path) -> Local {
    let id = dir.file_name().and_then(|n| n.to_str()).map(|n| n.trim_end_matches(".sdPlugin").to_string()).unwrap_or_default();
    let mut found = Local { name: id.clone(), id, ..Local::default() };
    let raw = std::fs::read(dir.join("manifest.json")).unwrap_or_default();
    let Some(v) = serde_json::from_slice::<Value>(sdplugins::without_bom(&raw)).ok() else {
        found.problem = Some(if sdplugins::is_encrypted(&raw) { sdplugins::ENCRYPTED } else { "the plugin has no readable manifest.json" }.into());
        return found;
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !s("Name").is_empty() {
        found.name = s("Name");
    }
    found.author = s("Author");
    found.version = s("Version");
    found.icon = icon(dir, &s("Icon"));
    found.problem = match sdplugins::read(&v, dir) {
        Err(e) => Some(e),
        Ok(sd) if sdplugins::inside(dir, &sd.code_path).is_some_and(|path| sdplugins::encrypted_file(&path)) => Some(sdplugins::ENCRYPTED.into()),
        Ok(sd) => sdplugins::runs_here(&sd).err().map(|e| format!("this plugin is {e}")),
    };
    found
}

/// The manifest's `Icon` (a path without its extension) as a PNG data URI.
fn icon(dir: &Path, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let bytes = [format!("{name}@2x.png"), format!("{name}.png"), name.to_string()]
        .iter()
        .filter_map(|n| sdplugins::inside(dir, n))
        .filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() < 512 * 1024))
        .find_map(|p| std::fs::read(p).ok())
        .filter(|b| b.starts_with(b"\x89PNG"))?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Parts of the Stream Deck app itself that sit in its plugins folder (its tutorial, its icon
/// library): nothing to use on another deck.
const BUILT_IN: &[&str] = &["com.elgato.tutorial", "com.elgato.keycreator"];

/// The Stream Deck app's plugins, by name; empty when it is not installed.
pub fn stream_deck_plugins() -> Vec<Local> {
    let Some(folder) = stream_deck_folder() else { return Vec::new() };
    let mut list: Vec<Local> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.extension().is_some_and(|x| x == "sdPlugin"))
        .map(|p| look(&p))
        .filter(|l| !BUILT_IN.contains(&l.id.as_str()))
        .collect();
    list.sort_by_key(|l| l.name.to_lowercase());
    list
}

/// A plugin folder as a `.streamDeckPlugin` file (a zip holding `<uuid>.sdPlugin/`, stored, not
/// compressed), so it installs the same way and through the same checks as a downloaded one.
fn zip_folder(dir: &Path) -> Result<Vec<u8>, String> {
    use std::io::Write as _;
    let root = dir.file_name().and_then(|n| n.to_str()).ok_or("no folder name")?.to_string();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
    let mut todo = vec![dir.to_path_buf()];
    while let Some(at) = todo.pop() {
        for entry in std::fs::read_dir(&at).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(dir).map_err(|e| e.to_string())?;
            let name = std::iter::once(root.as_str()).chain(rel.iter().filter_map(|p| p.to_str())).collect::<Vec<_>>().join("/");
            // a link could point anywhere on the disk: not followed
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                zip.add_directory(format!("{name}/"), options).map_err(|e| e.to_string())?;
                todo.push(path);
            } else if kind.is_file() {
                zip.start_file(name, options).map_err(|e| e.to_string())?;
                zip.write_all(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}

/// Install one of the Stream Deck app's plugins (copied; the Stream Deck app keeps its own).
pub fn import(id: &str) -> Result<String, String> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err("not a plugin id".into());
    }
    let dir = stream_deck_folder().ok_or("no Stream Deck app here")?.join(format!("{id}.sdPlugin"));
    if !dir.is_dir() {
        return Err("the Stream Deck app has no such plugin".into());
    }
    if let Some(problem) = look(&dir).problem {
        return Err(problem);
    }
    super::plugins::install_sd_from(&zip_folder(&dir)?, super::plugins::Source::StreamDeck, Some(id))
}

/// A private staging directory. Preview and installation share the same validation.
pub struct Stage(pub PathBuf);

impl Stage {
    pub fn new(parent: &Path) -> Result<Self, String> {
        let dir = parent.join(format!(".masterdeck-plugin-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }

    pub fn validate(&self, bytes: &[u8]) -> Result<(PathBuf, sdplugins::SdManifest), String> {
        let id = sdplugins::install(bytes, &self.0)?;
        let dir = self.0.join(format!("{id}.sdPlugin"));
        let raw = std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?;
        let manifest: Value = serde_json::from_slice(sdplugins::without_bom(&raw)).map_err(|e| e.to_string())?;
        let sd = sdplugins::read(&manifest, &dir).map_err(|e| format!("Invalid plugin manifest. {e}"))?;
        if sd.uuid != id {
            return Err("The plugin ID in manifest.json does not match its folder name.".into());
        }
        if !sd.actions.iter().any(|action| (action.keypad || action.encoder) && super::plugins::safe_id(&action.uuid)) {
            return Err("This plugin has no compatible key or dial actions.".into());
        }
        if !sdplugins::inside(&dir, &sd.code_path).is_some_and(|path| path.is_file()) {
            return Err(format!("The plugin’s program is missing. Expected {} in the archive.", sd.code_path));
        }
        Ok((dir, sd))
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn package_bytes(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn’t open the plugin file. {e}"))?;
    let info = file.metadata().map_err(|e| e.to_string())?;
    if !info.is_file() {
        return Err("Select a .streamDeckPlugin or .zip file.".into());
    }
    let too_large = "The plugin file exceeds 300 MB.";
    if info.len() > sdplugins::MAX_PLUGIN_FILE {
        return Err(too_large.into());
    }
    let mut bytes = Vec::new();
    file.take(sdplugins::MAX_PLUGIN_FILE + 1).read_to_end(&mut bytes).map_err(|e| format!("Couldn’t read the plugin file. {e}"))?;
    if bytes.len() as u64 > sdplugins::MAX_PLUGIN_FILE {
        return Err(too_large.into());
    }
    Ok(bytes)
}

pub fn package_digest(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(bytes))
}

pub fn peek_file(path: &Path) -> Local {
    let preview = || -> Result<Local, String> {
        let bytes = package_bytes(path)?;
        let stage = Stage::new(&std::env::temp_dir())?;
        let (dir, sd) = stage.validate(&bytes)?;
        let raw = std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?;
        let manifest: Value = serde_json::from_slice(sdplugins::without_bom(&raw)).map_err(|e| e.to_string())?;
        Ok(Local {
            installed_version: super::plugins::installed_version(&sd.uuid),
            name: if sd.name.is_empty() { sd.uuid.clone() } else { sd.name },
            id: sd.uuid,
            author: sd.author,
            version: sd.version,
            icon: icon(&dir, manifest["Icon"].as_str().unwrap_or_default()),
            problem: None,
            actions: sd.actions.len(),
            digest: Some(package_digest(&bytes)),
        })
    };
    preview().unwrap_or_else(|e| Local { name: path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(), problem: Some(e), ..Local::default() })
}

/// Plugin files the system asked HubDeck to open, kept until the window takes them.
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The plugin files among a start's arguments (a double click starts `HubDeck.exe <file>`).
pub fn files_in(args: &[String]) -> Vec<String> {
    // plugins, and icon packs (the window installs those at once: pictures only, nothing runs)
    args.iter().filter(|a| (a.to_lowercase().ends_with(".streamdeckplugin") || a.to_lowercase().ends_with(".streamdeckiconpack")) && Path::new(a).is_file()).cloned().collect()
}

/// Keep plugin files for the window and tell it (it asks before installing).
pub fn opened(app: &tauri::AppHandle, files: Vec<String>) {
    use tauri::Emitter as _;
    if files.is_empty() {
        return;
    }
    log::info!("asked to open {} plugin file(s)", files.len());
    OPENED.lock().unwrap_or_else(|e| e.into_inner()).extend(files);
    let _ = app.emit("engine://plugin-file", ());
}

/// The Stream Deck app's plugins on this computer.
#[tauri::command]
pub async fn sd_stream_deck() -> Result<Vec<Local>, String> {
    tauri::async_runtime::spawn_blocking(stream_deck_plugins).await.map_err(|e| e.to_string())
}

/// Install one of the Stream Deck app's plugins; returns its id.
#[tauri::command]
pub async fn sd_import(app: tauri::AppHandle, id: String) -> Result<String, String> {
    use tauri::Emitter as _;
    let id = tauri::async_runtime::spawn_blocking(move || import(&id)).await.map_err(|e| e.to_string())??;
    let _ = app.emit("engine://catalog", ());
    Ok(id)
}

/// What a plugin file holds (the window shows it before Install).
#[tauri::command]
pub async fn sd_peek(path: String) -> Result<Local, String> {
    tauri::async_runtime::spawn_blocking(move || peek_file(Path::new(&path))).await.map_err(|e| e.to_string())
}

/// Plugin files opened with HubDeck since the window last asked.
#[tauri::command]
pub fn sd_opened() -> Vec<String> {
    std::mem::take(&mut *OPENED.lock().unwrap_or_else(|e| e.into_inner()))
}

/// A plugin file dropped on the window: the window sends its bytes (a dropped file has no path the
/// window may read), kept here in a temp folder under its own name; returns that file's path, which
/// then goes the way of an opened file (asked about, then installed).
#[tauri::command]
pub fn sd_drop_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    const MAX: usize = 200 * 1024 * 1024;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("no file came with the drop".into()) };
    if bytes.len() > MAX {
        return Err("the file is larger than 200 MB".into());
    }
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let name = name.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    let lower = name.to_lowercase();
    if name.is_empty() || name.contains("..") || !(lower.ends_with(".streamdeckplugin") || lower.ends_with(".streamdeckiconpack") || lower.ends_with(".zip")) {
        return Err(format!("{name} is not a Stream Deck plugin file"));
    }
    let dir = std::env::temp_dir().join("hubdeck-dropped").join(format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// `%E3%81%82` back to text (the window sends a file's name that way in a header).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_file_names_are_decoded() {
        assert_eq!(percent_decode("com.x%20y.streamDeckPlugin"), "com.x y.streamDeckPlugin");
        assert_eq!(percent_decode("%E6%97%A5.zip"), "日.zip");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn folders_are_read_zipped_and_refused_when_encrypted() {
        let base = std::env::temp_dir().join(format!("hubdeck-sdlocal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("com.x.clock.sdPlugin");
        std::fs::create_dir_all(dir.join("imgs")).unwrap();
        let manifest = serde_json::json!({"Name": "Clock", "Author": "X", "Version": "1.2", "Icon": "imgs/icon", "CodePath": "bin/plugin.js", "Actions": [{"UUID": "com.x.clock.time"}]});
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin/plugin.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("imgs/icon.png"), b"\x89PNG....").unwrap();
        let found = look(&dir);
        assert_eq!((found.id.as_str(), found.name.as_str(), found.author.as_str(), found.problem.clone()), ("com.x.clock", "Clock", "X", None));
        assert!(found.icon.unwrap().starts_with("data:image/png;base64,"));
        // the zip installs like a downloaded file
        let out = base.join("out");
        std::fs::create_dir_all(&out).unwrap();
        assert_eq!(sdplugins::install(&zip_folder(&dir).unwrap(), &out).unwrap(), "com.x.clock");
        assert_eq!(std::fs::read_to_string(out.join("com.x.clock.sdPlugin/bin/plugin.js")).unwrap(), "console.log(1)");
        // a file opened with HubDeck is read without installing it
        let file = base.join("clock.streamDeckPlugin");
        std::fs::write(&file, zip_folder(&dir).unwrap()).unwrap();
        let reviewed = peek_file(&file);
        assert_eq!((reviewed.name.as_str(), reviewed.actions, reviewed.problem), ("Clock", 1, None));
        assert_eq!(reviewed.digest, Some(package_digest(&std::fs::read(&file).unwrap())));
        let bad = base.join("missing-program.zip");
        std::fs::write(dir.join("manifest.json"), manifest.to_string().replace("bin/plugin.js", "bin/missing.js")).unwrap();
        std::fs::write(&bad, zip_folder(&dir).unwrap()).unwrap();
        assert!(peek_file(&bad).problem.unwrap().contains("program is missing"));
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        assert_eq!(files_in(&["HubDeck.exe".into(), file.to_string_lossy().into_owned()]).len(), 1);
        // Elgato's encrypted program, then its encrypted manifest
        std::fs::write(dir.join("bin/plugin.js"), b"ELGATO\x01\x02\x03").unwrap();
        assert!(look(&dir).problem.unwrap().contains("encrypted"));
        assert!(sdplugins::install(&zip_folder(&dir).unwrap(), &out).unwrap_err().contains("encrypted"));
        std::fs::write(dir.join("manifest.json"), b"ELGATO\x01\x02\x03").unwrap();
        let found = look(&dir);
        assert_eq!(found.name, "com.x.clock");
        assert!(found.problem.unwrap().contains("encrypted"));
        assert!(import("../x").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod window_tests {
    /// The window's own drag and drop must stay on: with the system's drop handler on
    /// (`dragDropEnabled`), Windows drags nothing inside the window, so no action could be dragged
    /// onto a key (owner found it on 2026-10-18; a Playwright drag passes either way, it does not go
    /// through Windows). Plugin files dropped on the window come through the window instead.
    #[test]
    fn the_windows_drag_and_drop_is_its_own() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        for w in conf["app"]["windows"].as_array().unwrap() {
            assert_eq!(w["dragDropEnabled"], serde_json::json!(false), "window {}", w["title"]);
        }
    }
}
