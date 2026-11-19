//! Updates through the Tauri updater: GitHub Releases metadata and a signed installer. Under the user's
//! control: MasterDeck only looks for a new version (at start when "Check for updates at start" is on,
//! or when asked) and shows its version and notes; it installs only when the user says so.
//!
//! Release builds embed their own repository and public key. Local builds keep updates disabled.

use serde::Serialize;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::engine::Engine;

/// Event with an [`UpdateInfo`] when the check at start found a new version.
pub const AVAILABLE_EVENT: &str = "update://available";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release notes (changelog) of that version.
    pub notes: String,
    pub date: Option<String>,
}

/// The public key the updates are signed with; empty = updates are not set up in this build.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
static INSTALLING: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Whether this build can update itself (a signing key is configured).
pub fn enabled(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|key| !key.trim().is_empty())
}

fn repository(app: &AppHandle) -> Result<String, String> {
    let endpoint = app.config().plugins.0.get("updater").and_then(|u| u["endpoints"][0].as_str()).unwrap_or_default();
    release_repository(endpoint).ok_or_else(|| "GitHub release repository is not configured".into())
}

fn release_repository(endpoint: &str) -> Option<String> {
    let path = endpoint.strip_prefix("https://github.com/")?.strip_suffix("/releases/latest/download/latest.json")?;
    let (owner, repo) = path.split_once('/')?;
    let valid = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c));
    (valid(owner) && valid(repo)).then(|| path.to_string())
}

async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if !enabled(app) {
        return Ok(None);
    }
    app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
}

/// Look for a newer version: its version and notes, or None (also when updates are not set up).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(find(&app).await?.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone().unwrap_or_default(), date: u.date.map(|d| d.to_string()) }))
}

/// Download, verify and install the newer version, then restart. Only when the user asked.
#[tauri::command]
pub async fn update_install(app: AppHandle, version: String) -> Result<(), String> {
    let _install = INSTALLING.try_lock().map_err(|_| "An update is already in progress.")?;
    let update = find(&app).await?.ok_or("No newer version is available.")?;
    if update.version != version {
        return Err("The available version changed. Check for updates again before installing.".into());
    }
    install(&app, update).await
}

/// `0.1.2` or `v0.1.2` as numbers to compare; anything after `-` (a pre-release) is not a version
/// to go back to.
fn version_of(tag: &str) -> Option<(u64, u64, u64)> {
    let v = tag.trim().trim_start_matches('v');
    if v.contains('-') {
        return None;
    }
    let mut parts = v.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// The newest published release older than `current` in a GitHub releases list: (version, notes).
pub fn previous_release(releases: &serde_json::Value, current: &str) -> Option<(String, String)> {
    let now = version_of(current)?;
    releases
        .as_array()?
        .iter()
        .filter(|r| r["draft"] != true && r["prerelease"] != true)
        .filter(|r| r["assets"].as_array().is_some_and(|assets| assets.iter().any(|asset| asset["name"] == "latest.json")))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            let v = version_of(tag)?;
            (v < now).then(|| (v, tag.trim_start_matches('v').to_string(), r["body"].as_str().unwrap_or("").to_string()))
        })
        .max_by_key(|(v, _, _)| *v)
        .map(|(_, version, notes)| (version, notes))
}

/// The version before this one, to go back to after an update that broke something (owner's pick,
/// 2026-10-16: users of other decks roll back by hand after almost every update,
/// `docs/PAIN-POINTS.md` RD1). None when there is none or updates are not set up.
#[tauri::command]
pub async fn update_previous(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !enabled(&app) {
        return Ok(None);
    }
    let current = app.package_info().version.to_string();
    let repo = repository(&app)?;
    let list = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let url = format!("https://api.github.com/repos/{repo}/releases?per_page=30");
        let agent: ureq::Agent = crate::engine::calls::builder().timeout_global(Some(std::time::Duration::from_secs(15))).build().into();
        agent.get(&url).header("User-Agent", "MasterDeck").header("Accept", "application/vnd.github+json").call().map_err(|e| e.to_string())?.body_mut().read_json().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(previous_release(&list, &current).map(|(version, notes)| UpdateInfo { version, notes, date: None }))
}

/// Go back to `version`: the profiles are backed up first, then that release's signed update is
/// downloaded, its signature checked like any update, installed, and MasterDeck restarts.
#[tauri::command]
pub async fn update_rollback(app: AppHandle, version: String) -> Result<(), String> {
    let _install = INSTALLING.try_lock().map_err(|_| "An update is already in progress.")?;
    let current = app.package_info().version.to_string();
    if !enabled(&app) || !matches!((version_of(&version), version_of(&current)), (Some(wanted), Some(now)) if wanted < now) {
        return Err("no such version".into());
    }
    let repo = repository(&app)?;
    if let Ok(data) = app.path().app_data_dir() {
        crate::engine::backup::create(&data, &format!("before going back to {version}")).map_err(|e| e.to_string())?;
    }
    let url: tauri::Url = format!("https://github.com/{repo}/releases/download/v{version}/latest.json").parse().map_err(|e| format!("{e}"))?;
    let wanted = version.clone();
    let update = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        // an older version is the point here: take exactly the one asked for
        .version_comparator(move |_, release| release.version.to_string() == wanted)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("version {version} has no update file"))?;
    install(&app, update).await
}

async fn install(app: &AppHandle, mut update: tauri_plugin_updater::Update) -> Result<(), String> {
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    // Windows exits after launching the installer. Leave the watchdog alone until the
    // download and its signature have both been checked.
    log::info!("installing MasterDeck {}", update.version);
    crate::guard::leaving();
    if let Err(e) = update.install(bytes) {
        if let (Ok(data), Ok(logs)) = (app.path().app_data_dir(), app.path().app_log_dir()) {
            crate::guard::spawn(&data, &logs);
        }
        return Err(e.to_string());
    }
    app.restart()
}

/// (updates set up in this build, "Check for updates at start").
#[tauri::command]
pub fn update_settings_get(app: AppHandle, engine: State<'_, Engine>) -> (bool, bool, bool) {
    let s = engine.lock();
    (enabled(&app), s.store.settings.check_updates, s.store.settings.notify_updates)
}

/// Settings > Updates: look at start, and a notification when a new version is out.
#[tauri::command]
pub fn update_settings_set(engine: State<'_, Engine>, check_at_start: Option<bool>, notify: Option<bool>) -> Result<(), String> {
    let mut s = engine.lock();
    if let Some(on) = check_at_start {
        s.store.settings.check_updates = on;
    }
    if let Some(on) = notify {
        s.store.settings.notify_updates = on;
        log::info!("update notifications {}", if on { "on" } else { "off" });
    }
    s.store.save_settings().map_err(|e| e.to_string())
}

/// Whether a version found deserves a notification: the switch is on and this version was not
/// told yet (once a version, whatever the restarts and the checks every 6 hours).
fn should_notify(on: bool, told: Option<&str>, found: &str) -> bool {
    on && told != Some(found)
}

/// The system's notification for a new version (Windows' toast, macOS' banner). A click starts
/// MasterDeck again, and the running copy shows its window (the single-instance hand-over), where the
/// update waits. Never in a test copy: it would come up on the owner's screen.
fn notify_new_version(app: &AppHandle, version: &str) {
    use tauri_plugin_notification::NotificationExt;
    if crate::automation::get().is_some() {
        return;
    }
    let polish = app.state::<Engine>().lock().store.settings.language == "pl";
    let (title, body) = if polish {
        (format!("MasterDeck {version} jest gotowy"), "Otwórz MasterDecka, żeby go zaktualizować.".to_string())
    } else {
        (format!("MasterDeck {version} is ready"), "Open MasterDeck to update.".to_string())
    };
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => {
            log::info!("update notification shown for {version}");
            let engine = app.state::<Engine>();
            let mut s = engine.lock();
            s.store.settings.notified_version = Some(version.to_string());
            if let Err(e) = s.store.save_settings() {
                log::warn!("saving the notified version: {e}");
            }
        }
        Err(e) => log::warn!("update notification: {e}"),
    }
}

/// A newer version found by the last check, kept for the window and the tray: the window is
/// made only when it is opened, so the event at start reached nobody (owner, 2026-10-16: "nie
/// widzę info o update").
static AVAILABLE: std::sync::Mutex<Option<UpdateInfo>> = std::sync::Mutex::new(None);

/// How often MasterDeck looks again while it runs: it can stay in the tray for days.
const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// The newer version found, if any (the window asks when it opens).
#[tauri::command]
pub fn update_available() -> Option<UpdateInfo> {
    AVAILABLE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The newer version for the tray menu.
pub fn available_version() -> Option<String> {
    AVAILABLE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|i| i.version.clone())
}

/// At start and then every few hours: look in the background, keep what was found, tell the window
/// and the tray; never installs anything.
pub fn check_at_start(app: &AppHandle) {
    let wanted = app.state::<Engine>().lock().store.settings.check_updates;
    if !wanted || !enabled(app) || cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("update check".into())
        .spawn(move || {
            loop {
                if app.state::<Engine>().lock().store.settings.check_updates {
                    match tauri::async_runtime::block_on(update_check(app.clone())) {
                        Ok(Some(info)) => {
                            let new = AVAILABLE.lock().unwrap_or_else(|e| e.into_inner()).replace(info.clone()).as_ref() != Some(&info);
                            if new {
                                log::info!("MasterDeck {} is available", info.version);
                                let notify = {
                                    let s = app.state::<Engine>().lock().store.settings.clone();
                                    should_notify(s.notify_updates, s.notified_version.as_deref(), &info.version)
                                };
                                if notify {
                                    notify_new_version(&app, &info.version);
                                }
                                let _ = app.emit(AVAILABLE_EVENT, info);
                                crate::tray::refresh(&app);
                            }
                        }
                        Ok(None) => {}
                        Err(e) => log::info!("update check: {e}"),
                    }
                }
                std::thread::sleep(CHECK_EVERY);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_version_is_told_once() {
        assert!(should_notify(true, None, "0.2.2"));
        assert!(!should_notify(true, Some("0.2.2"), "0.2.2"), "not again after a restart or the next check");
        assert!(should_notify(true, Some("0.2.2"), "0.2.3"));
        assert!(!should_notify(false, None, "0.2.2"), "the switch off");
    }

    #[test]
    fn the_previous_release_is_the_newest_older_published_one() {
        // the GitHub releases list (tag_name, draft, prerelease, body)
        let list = serde_json::json!([
            {"tag_name": "v0.2.0", "draft": false, "prerelease": false, "body": "new"},
            {"tag_name": "v0.1.5", "draft": false, "prerelease": false, "body": "no feed", "assets": []},
            {"tag_name": "v0.1.2", "draft": false, "prerelease": false, "body": "fixes", "assets": [{"name": "latest.json"}]},
            {"tag_name": "v0.1.3-rc.1", "draft": false, "prerelease": true, "body": "rc"},
            {"tag_name": "v0.1.1", "draft": false, "prerelease": false, "body": "old", "assets": [{"name": "latest.json"}]},
            {"tag_name": "v0.1.9", "draft": true, "prerelease": false, "body": "draft"}
        ]);
        assert_eq!(previous_release(&list, "0.2.0"), Some(("0.1.2".into(), "fixes".into())));
        assert_eq!(previous_release(&list, "0.1.1"), None);
        assert_eq!(previous_release(&serde_json::json!([]), "0.1.0"), None);
        assert_eq!(version_of("v0.10.2"), Some((0, 10, 2)));
        assert!(version_of("0.1.0-rc.6").is_none());
        assert!(version_of("0.1.0.1").is_none());
    }

    #[test]
    fn update_history_uses_the_bundled_repository() {
        assert_eq!(release_repository("https://github.com/Deck-Creator/hubdeck/releases/latest/download/latest.json"), Some("Deck-Creator/hubdeck".into()));
        assert_eq!(release_repository("https://example.com/Deck-Creator/hubdeck/releases/latest/download/latest.json"), None);
        assert_eq!(release_repository("https://github.com/Deck-Creator/hubdeck/extra/releases/latest/download/latest.json"), None);
    }
}
