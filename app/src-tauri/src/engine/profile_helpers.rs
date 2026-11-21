//! Shared profile preparation for the local tour and profile previews.

use serde_json::{Value, json};

use super::{Engine, profile::Profile};

/// Keys that open an app or a game get the real thing (owner, session 6: a sketch promised game
/// covers and showed only text; keys named "Visual Studio Code" could not open): a name becomes
/// the installed app's or game's target, and a key without a picture gets the app's icon or the
/// game's cover at once.
pub(crate) fn with_real_apps(p: &mut Profile) {
    let is_target = |t: &str| t.contains("://") || t.contains('\\') || t.contains('/') || t.starts_with("shell:");
    for b in p.controls.values_mut() {
        // a key with only a label looks unfinished (owner: "same teksty"): its action's icon
        let bare = b.look.icon.as_deref().unwrap_or_default().is_empty() && b.look.image.as_deref().unwrap_or_default().is_empty();
        if bare && let Some(def) = super::actions::find(&b.action).filter(|d| super::render::icon_svg(d.icon).is_some()) {
            b.look.icon = Some(def.icon.to_string());
        }
        let key = match b.action.as_str() {
            "core.launch" => "target",
            "core.game" => "game",
            _ => continue,
        };
        let named = super::actions::param_str(&b.params, key).trim().to_string();
        let item = if is_target(&named) {
            super::installed::cached_items().into_iter().find(|i| i.target.eq_ignore_ascii_case(&named))
        } else {
            super::installed::item_named(&named).or_else(|| b.look.label.as_deref().and_then(|l| super::installed::item_named(&l.replace('\n', " "))))
        };
        let Some(item) = item else {
            // a program by its own path outside the installed apps (2026-10-14: an app of the
            // user's own in a build folder showed the placeholder icon): its icon from the file
            let own_file = key == "target" && is_target(&named) && !named.contains("://") && std::path::Path::new(&named).exists();
            if own_file
                && b.look.image.as_deref().unwrap_or_default().is_empty()
                && let Some(image) = super::appicon::png(&named).ok().and_then(|png| super::images::import_bytes(&png, "png").ok())
            {
                b.look.image = Some(image);
                b.look.icon = None;
            }
            // not installed but seen in front: the user's own tools
            if key == "target"
                && !is_target(&named)
                && let Some(path) = super::apps::seen_named(&named).or_else(|| b.look.label.as_deref().and_then(|l| super::apps::seen_named(&l.replace('\n', " "))))
            {
                b.params[key] = json!(path);
                if b.look.image.as_deref().unwrap_or_default().is_empty()
                    && let Some(image) = super::appicon::png(&path).ok().and_then(|png| super::images::import_bytes(&png, "png").ok())
                {
                    b.look.image = Some(image);
                    b.look.icon = None;
                }
            }
            continue;
        };
        if !is_target(&named) {
            b.params[key] = json!(item.target);
        }
        if b.look.image.as_deref().unwrap_or_default().is_empty()
            && let Ok(image) = super::installed::picture(&item)
        {
            // the picture stays on Auto: app icons follow Settings > Screens > App icons
            b.look.image = Some(image);
            b.look.icon = None;
        }
    }
}

/// Programs nobody makes a deck for (the Windows shell, MasterDeck, terminals, system tools).
pub fn not_for_a_deck(exe: &str) -> bool {
    let e = exe.to_lowercase();
    [
        "masterdeck",
        "hubdeck",
        "explorer.exe",
        "searchhost",
        "searchapp",
        "shellexperiencehost",
        "startmenuexperiencehost",
        "applicationframehost",
        "lockapp",
        "taskmgr",
        "cmd.exe",
        "windowsterminal",
        "powershell",
        "conhost",
        "systemsettings",
        "claude.exe",
        "rundll32",
        "dllhost",
    ]
    .iter()
    .any(|s| e.contains(s))
}

/// The apps used most that could get a deck (no profile yet first): (program, name, path).
/// An app's name for people: its own (from the program seen), the installed app's, or the
/// program's name capitalised.
pub fn app_name(exe: &str) -> String {
    let file = |p: &str| p.rsplit(['\\', '/']).next().unwrap_or(p).to_lowercase();
    super::apps::path_of_seen(exe)
        .and_then(|p| super::apps::friendly_name(&p))
        .or_else(|| super::installed::list(false).apps.into_iter().find(|a| file(&a.exe) == exe.to_lowercase()).map(|a| a.name))
        .unwrap_or_else(|| {
            let stem = exe.trim_end_matches(".exe").trim_end_matches(".EXE");
            let mut c = stem.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        })
}

pub(crate) fn top_apps(have_profile: &[String], n: usize) -> Vec<(String, String, Option<String>)> {
    let mut list: Vec<(String, String, Option<String>, bool)> = super::usage::top(30)
        .into_iter()
        .filter(|(exe, h, _)| *h >= 0.05 && !not_for_a_deck(exe))
        .map(|(exe, _, _)| {
            let path = super::apps::path_of_seen(&exe);
            let name = app_name(&exe);
            let has = have_profile.iter().any(|a| a.eq_ignore_ascii_case(&exe));
            (exe, name, path, has)
        })
        .collect();
    // nothing measured yet (a new install): the apps seen in front lately
    if list.is_empty() {
        for a in super::apps::list().into_iter().filter(|a| !not_for_a_deck(&a.exe)) {
            let has = have_profile.iter().any(|x| x.eq_ignore_ascii_case(&a.exe));
            let name = a.name.clone().unwrap_or_else(|| a.exe.trim_end_matches(".exe").to_string());
            list.push((a.exe, name, Some(a.path).filter(|p| !p.is_empty()), has));
        }
    }
    list.sort_by_key(|x| x.3);
    list.into_iter().take(n).map(|(e, n, p, _)| (e, n, p)).collect()
}

/// Show a draft on the deck for a try (None: back to what was showing).
#[tauri::command]
pub fn profile_try(engine: tauri::State<'_, Engine>, id: Option<String>) -> Result<(), String> {
    engine.try_profile(id.as_deref())
}

/// Keep a previewed profile or discard the draft.
#[tauri::command]
pub fn draft_settle(engine: tauri::State<'_, Engine>, id: String, keep: bool) -> Result<Option<Value>, String> {
    if keep {
        let (id, replaced) = engine.use_draft(&id)?;
        Ok(Some(json!({"id": id, "replaced": replaced})))
    } else {
        engine.settle_draft(&id, false)?;
        Ok(None)
    }
}
