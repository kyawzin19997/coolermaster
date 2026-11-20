import { readPreference, writePreference } from "../preferences";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { askInWindow, confirmed, open, save, told } from "../confirm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ControlRef, LiveState, ModuleKind } from "../deck";
import { api, withUpright, type FrameCost, FX_OPTIONS, FX_TINT, fxName, GPU_KINDS, type FxKind, type FxLayer, SKIN_MOTION, type Skin, type Look, GAMES_ENABLED, pageReachable, setPreviewSalt, type AppInfo, type AppsState, type CrashReport, type LightSettings, LED_EFFECTS, METRICS, type EngineView, type GameSummary, type Imported, type Metric, type Moved, type PluginInfo, type LocalPlugin, type InstalledItem, type PresetSummary, type Profile, type ProfileSummary, type Screens, triedPresets, SAVER_SCENES, saverOf, knownScreens, screensChanged, saverEnd, useSaverShown, type CustomSaver, SAVER_FROM_LOOK, saverPreset, PRESETS_HIDDEN, THEMES, themeTitle, layersOf } from "../engine";
import { Icon } from "./Icon";
import { AssistantPanel, refreshNudge, useNudge, useSetUp } from "./Assistant";
import { InstalledPicker, pickImage } from "./Inspector";
import { ModuleThumb } from "./DeckView";
import { DiagnosticsSettings } from "./Diagnostics";
import { demoParam } from "../demo/params";
import { setTheme, useTheme, type Theme } from "../theme";
import { updates, useAppVersion, useUpdateAvailable, type UpdateInfo } from "../update";
import { keysOfKind, MODULE_KINDS, ownedKey, type Placement } from "../layout";
import { BUILT_IN_LANGUAGES, getLanguage, languageTemplate, localizeError, localizeGame, localizePreset, t, useLanguage, type Key } from "../i18n";
import masterdeckIcon from "../../src-tauri/icons/masterdeck.svg";

// macOS has no listening to the music yet (engine/beat.rs: Windows only)
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

const moduleName = (kind: ModuleKind) => t(`module.${kind}`);

/** "Key 2", "Dial", "Knob 1": the name of a control as the user sees it. */
export const controlName = (c: ControlRef) => (c.kind === "dial" ? t("control.dial") : `${t(`control.${c.kind}`)} ${c.index + 1}`);

/** The name of a stored control id (`dial`, `faders.1`, `controls/keys.3`), with its page. */
function controlIdName(id: string, pages: Profile["pages"] = []): string {
  const [page, rest] = id.includes("/") ? (id.split("/", 2) as [string, string]) : [null, id];
  const [kind, index] = rest.split(":")[0].split(".");
  const name = kind === "dial" ? t("control.dial") : `${t(`control.${kind as ModuleKind}`)} ${Number(index) + 1}`;
  return page ? `${name} (${pages.find((p) => p.id === page)?.name ?? page})` : name;
}

/** A control id from the engine ("keys.2", "dial:hold", "page/knobs.0") as its name; other text as is. */
function controlLabel(id: string, pages: Profile["pages"] = []): string {
  return /^([^/]+\/)?((keys|knobs|faders|rollers)\.\d+|dial)(:|$)/.test(id) ? controlIdName(id, pages) : id;
}

/** Uninstall a plugin after asking in the window, naming the keys that use it (issue #8). Settings >
 * Plugins and the catalog's card both use it (owner's pick 1a, 2026-10-23: he looked for it on the
 * card). Resolves true when it was uninstalled; an error is thrown for the caller to show. */
export async function askUninstall(p: { id: string; name: string }): Promise<boolean> {
  const uses = await api.pluginUses(p.id).catch(() => []);
  const details = uses.map((u) => `${u.profile} · ${controlLabel(u.control, u.pages)}${u.label ? ` “${u.label}”` : ""}`);
  const yes = await askInWindow({
    title: t("plugins.uninstallTitle", { name: p.name }),
    body: uses.length ? t("plugins.uninstallBody", { count: uses.length }) : t("plugins.uninstallUnused"),
    details,
    ok: t("plugins.uninstall"),
    danger: true,
  });
  if (!yes) return false;
  await api.pluginUninstall(p.id);
  return true;
}

/** The note after an import or "Adapt to my modules": "Volume: Dial → Knob 1; ...". */
export function movedNote(moved: Moved[] | undefined, pages: Profile["pages"] = []): string {
  if (!moved?.length) return "";
  const list = moved.map((m) => `${m.label}: ${controlIdName(m.from, pages)} → ${m.to.map((c) => controlIdName(c, pages)).join(" / ")}`).join("; ");
  return t("profile.moved", { list });
}

export const Logo = () => <img className="logo" src={masterdeckIcon} alt="" />;

export type LeftTab = "profiles" | "assistant";

/** Suggestions whose dot was seen (per viewer, a convenience: lost storage only brings a dot back). */
function nudgeSeen(subject: string): boolean {
  try {
    return (JSON.parse(readPreference("nudgeSeen") ?? "[]") as string[]).includes(subject);
  } catch {
    return false;
  }
}
function markNudgeSeen(subject: string) {
  try {
    const seen = JSON.parse(readPreference("nudgeSeen") ?? "[]") as string[];
    writePreference("nudgeSeen", JSON.stringify([...seen.filter((s) => s !== subject), subject].slice(-50)));
  } catch {
    // not remembered: the dot may come back once
  }
}

/**
 * The left column: Get started (the assistant) and the profiles list as two tabs. Actions are chosen
 * only in the right panel, where the control is known (owner's pick 1a, 2026-10-16, variant A).
 * Once set up, Profiles comes first and is open at start; Get started keeps the same places
 * (owner's pick 2a, 2026-10-16: "zawsze to samo" stays; docs/FLOWS.md difference 3).
 */
export function LeftPanel({ view, tab, onTab, onOpenProfile, onNewProfile, onBuild, onTour }: { view: EngineView; tab: LeftTab; onTab: (tab: LeftTab) => void; onOpenProfile: () => void; onNewProfile: () => void; onBuild?: () => void; onTour?: () => void }) {
  useLanguage();
  const setUp = useSetUp(view);
  // MasterDeck's own suggestion (an app without a deck): a dot on the Assistant tab, looked at now and then
  const nudge = useNudge();
  // the dot goes once the tab was looked at with that suggestion in it, as badges do
  const [, seenNow] = useState(0);
  useEffect(() => {
    if (tab === "assistant" && nudge && !nudgeSeen(nudge.subject)) {
      markNudgeSeen(nudge.subject);
      seenNow((n) => n + 1);
    }
  }, [tab, nudge]);
  useEffect(() => {
    refreshNudge();
    const timer = setInterval(refreshNudge, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    // one width for every tab (owner, 2026-10-14: Get started widening the column looked odd);
    // Get started comes first and is open at start
    <aside data-guide="library" className="library" aria-label={tab === "profiles" ? t("profiles.title") : t("assistant.title")}>
      <div className={`lib-tabs seg full${setUp ? " is-set-up" : ""}`} role="tablist">
        <button role="tab" aria-selected={tab === "assistant"} className={`tab${tab === "assistant" ? " is-active" : ""}`} onClick={() => onTab("assistant")}>
          {t("assistant.tab")}
          {nudge && tab !== "assistant" && !nudgeSeen(nudge.subject) && <span className="tab-dot" aria-label={t("nudge.ask")} />}
        </button>
        <button role="tab" data-guide="profiles" aria-selected={tab === "profiles"} className={`tab${tab === "profiles" ? " is-active" : ""}`} onClick={() => onTab("profiles")}>
          {t("profiles.title")}
        </button>
      </div>
      {tab === "profiles" ? (
        <ProfilesList view={view} onOpenProfile={onOpenProfile} onNewProfile={onNewProfile} />
      ) : (
        <AssistantPanel view={view} onTour={onTour} onBuild={onBuild} />
      )}
    </aside>
  );
}

/** Ready-made profiles; picking one shows it on the deck for a try, Add on the trying bar keeps it. */
export function PresetList({ onPicked, kinds }: { onPicked?: () => void; kinds?: string[] }) {
  useLanguage();
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.presets().then(setPresets).catch((e) => setError(String(e)));
  }, []);
  const [open, setOpen] = useState<string | null>(null);
  const row = (p: PresetSummary) => (
    <button
      key={p.id}
      className="menu-row compact preset-row"
      title={p.description}
      onClick={() =>
        api
          .addPreset(p.id, kinds, true)
          .then((profile) => (triedPresets.add(profile.id), api.tryProfile(profile.id)))
          .then(() => onPicked?.(), (e) => setError(String(e)))
      }
    >
      <span className="menu-text">
        <b>{p.name}</b>
      </span>
    </button>
  );
  // the test benches are for developing MasterDeck: only in a development build
  const all = presets.map(localizePreset).filter((p) => import.meta.env.DEV || !p.test);
  // one line per group, only the clicked one opens (owner's pick 1A); the description is the tooltip
  const groups = PRESET_GROUPS.map(([id, icon]) => ({ id, icon, items: all.filter((p) => (p.group ?? "tools") === id) })).filter((g) => g.items.length);
  return (
    <div className="menu-list">
      {groups.map((g) => (
        <div key={g.id} className="preset-group">
          <button className={`menu-row compact group-row${open === g.id ? " is-open" : ""}`} aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
            <span className={`menu-ic is-plain${g.id === "test" ? " is-test" : ""}`}>
              <Icon name={g.icon} />
            </span>
            <span className="menu-text">
              <b>{t(`presets.group.${g.id}` as Key)}</b>
            </span>
            <span className="count">{g.items.length}</span>
            <Icon name={open === g.id ? "chevron-down" : "chevron-right"} />
          </button>
          {open === g.id && g.items.map(row)}
        </div>
      ))}
      {error && <p className="help">{error}</p>}
    </div>
  );
}

/** The groups of ready-made profiles in menu order, with their icons. */
const PRESET_GROUPS: [string, string][] = [
  ["start", "compass"],
  ["streaming", "radio"],
  ["photo", "palette"],
  ["video", "video"],
  ["games", "gamepad-2"],
  ["tools", "terminal"],
  ["showcase", "sparkles"],
  ["test", "crosshair"],
];


/** Closes a popover on a click outside `ref` or on Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, ref, close]);
}

/** Apps with their icons (open now and seen recently), read again when the app in front changes. */
function useApps(foreground?: string): AppInfo[] {
  const [apps, setApps] = useState<AppInfo[]>([]);
  useEffect(() => {
    api.apps().then(setApps, () => {});
  }, [foreground]);
  return apps;
}

/** The exe part of a profile's app entry (`chrome.exe: YouTube` -> `chrome.exe`). */
const entryExe = (entry: string) => entry.split(":")[0].trim();

/** Icon of an app entry, if MasterDeck has seen the app. */
function appIcon(apps: AppInfo[], entry: string): string | undefined {
  const exe = entryExe(entry).toLowerCase().replace(/\.exe$/, "");
  return apps.find((a) => a.exe.toLowerCase().replace(/\.exe$/, "") === exe)?.icon ?? linkedIcons.get(entryExe(entry).toLowerCase()) ?? undefined;
}

/** Icons of programs profiles link to that were not in front lately (games): asked once each. */
const linkedIcons = new Map<string, string | null>();
const askedIcons = new Set<string>();

/** Fetch the icons of these profiles' programs that the seen apps lack; re-renders when they come. */
function useLinkedIcons(profiles: ProfileSummary[], apps: AppInfo[]) {
  const [, setVersion] = useState(0);
  const seen = new Set(apps.map((a) => a.exe.toLowerCase()));
  const missing = [...new Set(profiles.flatMap((p) => p.apps.map((a) => entryExe(a).toLowerCase())))].filter((e) => e && !seen.has(e) && !askedIcons.has(e));
  const key = missing.join("|");
  useEffect(() => {
    if (!missing.length || !("__TAURI_INTERNALS__" in window)) return;
    missing.forEach((e) => askedIcons.add(e));
    api.appIcons(missing).then((found) => {
      for (const [exe, icon] of Object.entries(found ?? {})) linkedIcons.set(exe.toLowerCase(), icon);
      setVersion((v) => v + 1);
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Linked apps as chips with their real icons, and a picker of the apps open now or seen lately. */
function AppLinks({ apps, value, onChange, foreground }: { apps: AppInfo[]; value: string[]; onChange: (apps: string[]) => void; foreground: string }) {
  useLanguage();
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setPicking(false), []);
  useDismiss(picking, ref, close);
  const linked = value.map((v) => entryExe(v).toLowerCase());
  const offer = apps.filter((a) => !linked.includes(a.exe.toLowerCase()));
  return (
    <div className="field">
      <div className="label">{t("profile.apps")}</div>
      <div className="row wrap">
        {value.map((entry) => {
          const icon = appIcon(apps, entry);
          return (
            <button key={entry} className="chip" title={t("profile.unlinkApp", { app: entry })} onClick={() => onChange(value.filter((v) => v !== entry))}>
              {icon ? <img src={icon} alt="" width={16} height={16} /> : <Icon name="app-window" />}
              {appLabel(entry)}
              <Icon name="x" />
            </button>
          );
        })}
        <span className="pop-anchor" ref={ref}>
          <button className="chip" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            <Icon name="plus" />
            {t("profile.linkApp")}
          </button>
          {picking && (
            <div className="popover" role="menu">
              {offer.length === 0 && <div className="pop-label">{t("profile.noApps")}</div>}
              {offer.some((a) => a.running) && <div className="pop-label">{t("profile.appsOpen")}</div>}
              <div className="menu-list">
                {offer.map((a, i) => (
                  <div key={a.exe} style={{ display: "contents" }}>
                    {!a.running && (i === 0 || offer[i - 1].running) && <div className="pop-label">{t("profile.appsRecent")}</div>}
                    <button role="menuitem" className="menu-row compact" onClick={() => (onChange([...value, a.exe]), setPicking(false))}>
                      <span className="menu-ic is-plain">{a.icon ? <img src={a.icon} alt="" width={20} height={20} /> : <Icon name="app-window" />}</span>
                      <span className="menu-text">
                        <b>{appLabel(a.exe)}</b>
                        {a.title && <small>{a.title}</small>}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </span>
        {foreground && !linked.includes(foreground.toLowerCase()) && (
          <button className="chip" onClick={() => onChange([...value, foreground])}>
            <Icon name="plus" />
            {t("profile.addApp", { app: appLabel(foreground).replace(/^./, (c) => c.toUpperCase()) })}
          </button>
        )}
      </div>
    </div>
  );
}

/** `Photoshop.exe` -> `Photoshop`, `chrome.exe: YouTube` -> `chrome: YouTube`. */
const appLabel = (entry: string) => entry.replace(/\.exe\b/i, "");

/** Shown as a tab: as stored, else profiles without apps are and app profiles are not. */
const inBar = (p: ProfileSummary) => p.inBar ?? p.apps.length === 0;

/** Change one stored profile (rename, show in the bar...). */
async function editProfile(id: string, change: (p: Profile) => Profile) {
  const p = await api.profile(id);
  await api.saveProfile(change(p));
}

async function exportProfileFile(profile: Pick<Profile, "id" | "name">, json = false) {
  const name = profile.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[ .]+$/, "") || "MasterDeck profile";
  const extension = json ? "json" : "masterdeck";
  const path = await save({
    defaultPath: `${name}.${extension}`,
    filters: [{ name: t(json ? "profile.fileTypeJson" : "profile.fileTypePackage"), extensions: [extension] }],
  });
  if (!path) return null;
  const target = path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
  await api.exportProfile(profile.id, target);
  return target;
}

async function importProfileFile() {
  const path = await open({ multiple: false, filters: [{ name: t("profile.fileType"), extensions: ["masterdeck", "hubdeck", "json", "mhz"] }] });
  if (typeof path !== "string") return null;
  const profile = await api.importProfile(path);
  if (!(await keepImported(profile))) return null;
  await api.activate(profile.id);
  return profile;
}

function deleteProfile(p: ProfileSummary) {
  void confirmed(t("profile.confirmDelete", { name: p.name })).then((yes) => yes && api.deleteProfile(p.id).catch((e) => told(t("error.deleteProfile"), localizeError(String(e)))));
}

/** True while MasterDeck's own window has the focus. */
function useWindowFocus() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

/** Right-click menu of a profile tab: rename, duplicate, show in or hide from the bar, delete. */
function ProfileMenu({ profile, x, y, count, onSetHome, onClose }: { profile: ProfileSummary; x: number; y: number; count: number; onSetHome?: () => Promise<unknown>; onClose: () => void }) {
  useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  useDismiss(true, ref, onClose);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y + 6, window.innerHeight - height - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [x, y, name === null]);
  const run = (action: () => Promise<unknown>) => {
    onClose();
    void action().catch((err) => told(t("topbar.profileSettings"), localizeError(String(err))));
  };
  return createPortal(
    <div className="popover ctx-menu profile-context-menu" role="menu" ref={ref} aria-label={t("profiles.options", { name: profile.name })}>
      <div className="pop-label">{profile.name}</div>
      {name === null ? (
        <div className="menu-list">
          <button role="menuitem" className="menu-row compact" autoFocus onClick={() => setName(profile.name)}>
            <Icon name="pencil" />
            <span className="menu-text">{t("profiles.rename")}</span>
          </button>
          <button role="menuitem" className="menu-row compact" onClick={() => run(() => api.createProfile(t("profile.copyName", { name: profile.name }), profile.id))}>
            <Icon name="copy" />
            <span className="menu-text">{t("profile.duplicate")}</span>
          </button>
          <button role="menuitem" className="menu-row compact" onClick={() => run(() => exportProfileFile(profile))}>
            <Icon name="download" />
            <span className="menu-text">{t("profile.export")}</span>
          </button>
          {onSetHome && (
            <button role="menuitem" className="menu-row compact" title={t("profiles.setHome")} onClick={() => run(onSetHome)}>
              <Icon name="home" />
              <span className="menu-text">{t("profiles.makeHome")}</span>
            </button>
          )}
          <button role="menuitem" className="menu-row compact" onClick={() => run(() => editProfile(profile.id, (p) => ({ ...p, inBar: !inBar(profile) })))}>
            <Icon name={inBar(profile) ? "eye-off" : "eye"} />
            <span className="menu-text">{inBar(profile) ? t("profiles.hide") : t("profiles.show")}</span>
          </button>
          <button role="menuitem" className="menu-row compact danger" disabled={count <= 1} onClick={() => (onClose(), deleteProfile(profile))}>
            <Icon name="trash" />
            <span className="menu-text">{t("profile.delete")}</span>
          </button>
        </div>
      ) : (
        <form
          className="ctx-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (next) editProfile(profile.id, (p) => ({ ...p, name: next }));
            onClose();
          }}
        >
          <input className="input" autoFocus value={name} aria-label={t("profile.name")} onChange={(e) => setName(e.target.value)} />
          <button className="tool small primary" type="submit">
            {t("connections.save")}
          </button>
        </form>
      )}
    </div>,
    document.body,
  );
}

/** A control's right-click menu in the drawing, as Stream Deck's ("Right-click keys to copy,
 * delete or move them"; owner's 1a, 2026-10-20): what the shortcuts do, with the shortcuts shown. */
export function ControlMenu({ title, x, y, isSet, canPaste, opensPage, onCopy, onPaste, onPasteLook, onClear, onOpenPage, onClose }: { title: string; x: number; y: number; isSet: boolean; canPaste: boolean; opensPage: boolean; onCopy: () => void; onPaste: () => void; onPasteLook: () => void; onClear: () => void; onOpenPage: () => void; onClose: () => void }) {
  useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onClose);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.max(6, Math.min(y + 6, window.innerHeight - 230));
  const mod = /Mac/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";
  const row = (icon: string, text: string, keys: string | null, on: () => void, enabled: boolean, danger = false) => (
    <button role="menuitem" className={`menu-row compact${danger ? " danger" : ""}`} disabled={!enabled} onClick={() => (onClose(), on())}>
      <Icon name={icon} />
      <span className="menu-text">{text}</span>
      {keys && <kbd className="menu-kbd">{keys}</kbd>}
    </button>
  );
  return (
    <div className="popover ctx-menu" role="menu" ref={ref} style={{ position: "fixed", left, top }}>
      <div className="pop-label">{title}</div>
      <div className="menu-list">
        {opensPage && row("folder-open", t("ctl.openPage"), null, onOpenPage, true)}
        {row("copy", t("ctl.copy"), `${mod}C`, onCopy, isSet)}
        {row("clipboard-paste", t("ctl.paste"), `${mod}V`, onPaste, canPaste)}
        {row("palette", t("ctl.pasteLook"), mod === "⌘" ? "⇧⌘V" : "Ctrl+Shift+V", onPasteLook, canPaste && isSet)}
        {row("trash", t("ctl.clear"), "Delete", onClear, isSet, true)}
      </div>
    </div>
  );
}

/** Every profile: search, switch, rename, duplicate, delete, show in the top bar. */
function ProfilesList({ view, onOpenProfile, onNewProfile }: { view: EngineView; onOpenProfile: () => void; onNewProfile: () => void }) {
  useLanguage();
  const state = view.state;
  const apps = useApps(state?.foreground);
  useLinkedIcons(state?.profiles ?? [], apps);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  if (!state) return null;
  const q = query.trim().toLowerCase();
  // drafts live in the assistant until picked; ready profiles have their own group
  const found = state.profiles.filter((p) => !p.draft).filter((p) => !q || p.name.toLowerCase().includes(q) || p.apps.some((a) => a.toLowerCase().includes(q)));
  const list = found.filter((p) => !p.ready);
  const ready = found.filter((p) => p.ready);
  const menuProfile = menu && state.profiles.find((p) => p.id === menu.id);
  // grouped (owner's pick A, 2026-10-22): home, the user's own, the ones that switch in with an app
  const groups = [
    { key: "home", title: t("profiles.groupHome"), help: t("profiles.groupHomeHelp"), rows: list.filter((p) => p.id === state.fallback) },
    { key: "own", title: t("profiles.groupOwn"), help: "", rows: list.filter((p) => p.id !== state.fallback && p.apps.length === 0) },
    { key: "apps", title: t("profiles.groupApps"), help: t("profiles.groupAppsHelp"), rows: list.filter((p) => p.id !== state.fallback && p.apps.length > 0) },
  ].filter((g) => g.rows.length > 0);
  return (
    <>
      <div className="lib-head">
        <div className="search">
          <Icon name="search" />
          <input className="input" placeholder={t("profiles.searchShort")} aria-label={t("profiles.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className="tool" onClick={() => void importProfileFile().catch((err) => told(t("profile.import"), localizeError(String(err))))}>
          <Icon name="upload" />{t("profile.import")}
        </button>
      </div>
      <div className="lib-groups lib-profiles">
        {groups.map((g, gi) => (
        <section key={g.key} className="plist-group" aria-label={g.title}>
        <div className="plist-head" aria-hidden="true" title={g.help || undefined}>
          <span>{g.title}</span>
          {gi === 0 && <span>{t("profiles.inBar")}</span>}
        </div>
        <ul className="plist">
          {g.rows.map((p) => {
            const icons = p.apps.map((a) => appIcon(apps, a)).filter(Boolean).slice(0, 3) as string[];
            const active = state.active === p.id;
            return (
              <li key={p.id} className={`prow${active ? " is-active" : ""}`} data-profile={p.id}>
                <button className="prow-main" onClick={() => (active ? onOpenProfile() : api.activate(p.id))} title={`${p.name} · ${t(active ? "topbar.profileSettings" : "topbar.activate")}`}>
                  <span className="prow-ic">{icons.length ? icons.map((src) => <img key={src} src={src} alt="" width={16} height={16} />) : <Icon name={state.fallback === p.id ? "home" : "layers"} />}</span>
                  <span className="prow-text">
                    <b>{p.name}</b>
                    <small>
                      {state.fallback === p.id && <span className="tag">{t("profiles.home")}</span>}
                      {active && <span className="tag is-acc">{t("profiles.active")}</span>}
                      {state.autoMade?.includes(p.id) && <span className="tag is-acc">{t("auto.new")}</span>}
                      {p.apps.length > 0 && <span className="mono">{p.apps.join(", ")}</span>}
                    </small>
                  </span>
                </button>
                <button
                  className="icon-btn prow-more"
                  type="button"
                  aria-label={t("profiles.options", { name: p.name })}
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === p.id}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ id: p.id, x: rect.left, y: rect.bottom });
                  }}
                >
                  <Icon name="more-horizontal" />
                </button>
                <label className="bar-toggle" title={inBar(p) ? t("profiles.hide") : t("profiles.show")}>
                  <input
                    type="checkbox"
                    checked={inBar(p)}
                    aria-label={t("profiles.inBar")}
                    onChange={(e) => {
                      // read now: after editProfile's await React has already put the box back
                      const on = e.target.checked;
                      editProfile(p.id, (x) => ({ ...x, inBar: on }));
                    }}
                  />
                </label>
              </li>
            );
          })}
        </ul>
        </section>
        ))}
        {list.length === 0 && ready.length === 0 && <p className="help">{t("profiles.none")}</p>}
        {ready.length > 0 && (
          // owner's pick 1a, 2026-10-14: made at once for the apps installed, off until switched on
          <details className="ready-apps" open={!!q || undefined}>
            <summary className="plist-head">
              <span id="ready-title">{t("profiles.ready", { count: ready.length })}</span>
            </summary>
            <p className="help">{t("profiles.readyHelp")}</p>
            <ul className="plist">
              {ready.map((p) => {
                const icon = p.apps.map((a) => appIcon(apps, a)).find(Boolean);
                const active = state.active === p.id;
                return (
                  <li key={p.id} className={`prow${active ? " is-active" : ""}`} data-profile={p.id}>
                    <button className="prow-main" onClick={() => (active ? onOpenProfile() : api.activate(p.id))} title={active ? t("topbar.profileSettings") : t("topbar.activate")}>
                      <span className="prow-ic">{icon ? <img src={icon} alt="" width={16} height={16} /> : <Icon name="app-window" />}</span>
                      <span className="prow-text">
                        <b>{p.name}</b>
                        <small>
                          {active && <span className="tag is-acc">{t("profiles.active")}</span>}
                          <span className="mono">{p.apps.join(", ")}</span>
                        </small>
                      </span>
                    </button>
                    <label className="bar-toggle" title={t("profiles.switchInHelp", { app: p.name })}>
                      <input type="checkbox" checked={p.switchIn !== false} aria-label={t("profiles.switchInFor", { app: p.name })} onChange={(e) => api.profileSwitchIn(p.id, e.target.checked).catch(() => {})} />
                    </label>
                    <span className="prow-tools">
                      <button className="icon-btn danger" title={t("profile.delete")} aria-label={t("profile.delete")} disabled={state.profiles.length <= 1} onClick={() => deleteProfile(p)}>
                        <Icon name="trash" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        <button className="tool lib-new" onClick={onNewProfile}>
          <Icon name="plus" />
          {t("topbar.newDeck")}…
        </button>
        <p className="help">{t("profiles.help")}</p>
      </div>
      {menu && menuProfile && (
        <ProfileMenu
          key={menuProfile.id}
          profile={menuProfile}
          x={menu.x}
          y={menu.y}
          count={state.profiles.length}
          onSetHome={state.fallback !== menuProfile.id ? () => api.settings({ fallback: menuProfile.id }) : undefined}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** "+" > For an app...: pick an app (open now or installed) and get a profile made for it. */
export function ForAppPanel({ view, kinds, onClose, onMade }: { view: EngineView; kinds?: string[]; onClose: () => void; onMade: (profileId: string) => void }) {
  useLanguage();
  const open = useApps(view.state?.foreground);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [codeCli, setCodeCli] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<{ codeCli: boolean }>("mcp_info").then((i) => setCodeCli(i.codeCli), () => setCodeCli(false));
  }, []);
  /** "Build with AI": Claude Code builds it with MasterDeck's tools; without Claude Code the request is copied. */
  const buildWithAi = async (exe: string, name: string, target: string, picture: string | null) => {
    const prompt = await api.aiPrompt(name, exe, target, picture, getLanguage());
    const before = new Set((await api.state()).profiles.map((p) => p.id));
    try {
      const said = await api.aiBuild(prompt);
      const file = (exe.split(/[\\/]/).pop() ?? exe).toLowerCase();
      const fresh = (await api.state()).profiles.filter((p) => !before.has(p.id));
      const made = fresh.find((p) => p.apps.some((a) => a.split(":")[0].toLowerCase() === file)) ?? fresh[0];
      setBusy(null);
      if (made) {
        await api.activate(made.id);
        onMade(made.id);
      } else {
        setNote(said || t("ai.nothing"));
      }
    } catch (e) {
      setBusy(null);
      if (String(e) !== "no-cli") throw e;
      await navigator.clipboard.writeText(prompt).catch(() => {});
      setNote(t("ai.copied"));
    }
  };
  const make = async (exe: string, name: string, target: string, item?: InstalledItem) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const picture = item ? await api.installedPicture(item).catch(() => null) : null;
      if (ai) return await buildWithAi(exe, name, target, picture);
      const p = await api.profileForApp(exe, name, target, picture, kinds);
      await api.activate(p.id);
      onMade(p.id);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };
  const running = open.filter((a) => a.running && !/^hubdeck/i.test(a.exe));
  return (
    <aside className="inspector sectioned side-panel">
      <PanelHead title={t("forApp.title")} crumb={t("topbar.newDeck")} icon="app-window" onClose={onClose} />
      <section className="sec">
        <p className="help">{t("forApp.help")}</p>
        <label className="check">
          <input type="checkbox" checked={ai} disabled={!!busy} onChange={(e) => setAi(e.target.checked)} />
          {t("ai.toggle")}
        </label>
        {ai && <p className="help">{codeCli === false ? t("ai.helpCopy") : t("ai.help")}</p>}
        {busy && (
          <p className="hint">
            <Icon name="sparkles" />
            {ai ? t("ai.making", { app: busy }) : t("forApp.making", { app: busy })}
          </p>
        )}
        {note && (
          <p className="hint">
            <Icon name="info" />
            {note}
          </p>
        )}
        {error && <p className="help">{error}</p>}
      </section>
      {running.length > 0 && (
        <section className="sec">
          <h3 className="sec-title">{t("forApp.open")}</h3>
          <div className="menu-list">
            {running.map((a) => (
              <button key={a.exe} className="menu-row compact" disabled={!!busy} title={a.exe} onClick={() => make(a.exe, a.name ?? appName(a.exe), a.path || a.exe)}>
                <span className="menu-ic is-plain">{a.icon ? <img src={a.icon} alt="" width={20} height={20} /> : <Icon name="app-window" />}</span>
                <span className="menu-text">
                  <b>{a.name ?? appName(a.exe)}</b>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="sec">
        <h3 className="sec-title">{t("forApp.installed")}</h3>
        <InstalledPicker games={false} onPick={(item) => !busy && make(item.exe || item.target, item.name, item.target, item)} />
      </section>
    </aside>
  );
}

/** Profile tabs that fit the top bar; the rest go into a "More" menu (the active one always shows). */
function ProfileTabs({ view, onOpenProfile, onOpenForApp, onOpenAssistant, onOpenTour, kinds, newRequest }: { view: EngineView; onOpenProfile: () => void; onOpenForApp: () => void; onOpenAssistant: () => void; onOpenTour: () => void; kinds?: string[]; newRequest?: number }) {
  const state = view.state;
  const all = state?.profiles ?? [];
  // the bar: profiles shown in it, the home profile and the active one
  // home always first, set apart by a thin line (owner's pick A, 2026-10-22)
  const profiles = all
    .filter((p) => inBar(p) || p.id === state?.active || p.id === state?.home || p.id === state?.fallback)
    .sort((x, y) => Number(y.id === state?.fallback) - Number(x.id === state?.fallback));
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const apps = useApps(state?.foreground);
  useLinkedIcons(all, apps);
  const [naming, setNaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(demoParam("popover") === "new");
  const [moreOpen, setMoreOpen] = useState(demoParam("popover") === "more");
  const [readyOpen, setReadyOpen] = useState(false);
  const [fit, setFit] = useState(Infinity);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useDismiss(adding, addRef, closeAdd);
  useDismiss(moreOpen, moreRef, closeMore);
  // "New profile..." in the profiles tab opens this same menu
  useEffect(() => {
    if (newRequest) setAdding(true);
  }, [newRequest]);
  const signature = profiles.map((p) => `${p.name}${state?.autoSwitch && p.apps.length ? "*" : ""}`).join("|");

  // measure every tab once (hidden copies), then keep as many as the bar has room for
  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const calc = () => {
      // fractional widths rounded up, and a little room: the active tab (its dot, its weight) is wider
      // than its measured copy (the last tab was cut by 4px at 1440; release audit)
      const widths = Array.from(measure.children, (c) => Math.ceil(c.getBoundingClientRect().width) + 2 + (c.classList.contains("is-home") ? 6 : 0));
      const tabs = widths.slice(0, profiles.length);
      const more = widths[profiles.length] ?? 90;
      const gap = 2;
      // the New deck button sits after the tabs: its own width, not a fixed icon's
      const room = nav.clientWidth - (addRef.current?.getBoundingClientRect().width ?? 36) - 8;
      if (tabs.reduce((s, w) => s + w + gap, 0) <= room) return setFit(profiles.length);
      let used = more + gap;
      let n = 0;
      while (n < tabs.length && used + tabs[n] + gap <= room) used += tabs[n++] + gap;
      setFit(Math.max(1, n));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [signature, profiles.length]);

  const activeIndex = profiles.findIndex((p) => p.id === state?.active);
  let shown = profiles.slice(0, fit);
  if (activeIndex >= fit && fit < profiles.length) shown = [...profiles.slice(0, Math.max(0, fit - 1)), profiles[activeIndex]];
  const hidden = profiles.filter((p) => !shown.includes(p));
  const tab = (p: (typeof profiles)[number], measuring = false) => (
    <button
      key={p.id}
      className={`tab${state?.active === p.id ? " is-active" : ""}${state?.fallback === p.id ? " is-home" : ""}`}
      tabIndex={measuring ? -1 : undefined}
      onClick={measuring ? undefined : () => (state?.active === p.id ? onOpenProfile() : api.activate(p.id))}
      onContextMenu={
        measuring
          ? undefined
          : (e) => {
              e.preventDefault();
              setMenu({ id: p.id, x: e.clientX, y: e.clientY });
            }
      }
      title={measuring ? undefined : state?.active === p.id ? t("topbar.profileSettings") : p.apps.length ? t("topbar.switchesFor", { apps: p.apps.join(", ") }) : t("topbar.activate")}
    >
      {state?.autoSwitch && p.apps.length > 0 && <span className="auto" aria-hidden="true" />}
      {state?.fallback === p.id && <Icon name="home" />}
      {/* pinned (3A): the tab of the profile the deck stays on carries the pin */}
      {state?.pinned && state.active === p.id && <Icon name="pin" className="tab-pin" />}
      {p.apps.slice(0, 3).map((a) => {
        const icon = appIcon(apps, a);
        return icon ? <img key={a} src={icon} alt="" width={14} height={14} /> : null;
      })}
      {p.name}
    </button>
  );

  return (
    <>
      <nav className="profiles" aria-label={t("topbar.profiles")} ref={navRef}>
        <div className="tabs-row">
          {shown.map((p, i) => (
            <Fragment key={p.id}>
              {tab(p)}
              {i === 0 && p.id === state?.fallback && shown.length > 1 && <span className="tab-sep" aria-hidden="true" />}
            </Fragment>
          ))}
        </div>
        {hidden.length > 0 && (
          <span className="pop-anchor" ref={moreRef}>
            <button className={`tab more${moreOpen ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              {t("topbar.more")}
              <span className="count">{hidden.length}</span>
              <Icon name="chevron-down" />
            </button>
            {moreOpen && (
              <div className="popover" role="menu">
                <div className="pop-label">{t("topbar.profiles")}</div>
                <div className="menu-list">
                  {hidden.map((p) => (
                    <button key={p.id} role="menuitem" className="menu-row compact" onClick={() => (api.activate(p.id), setMoreOpen(false))}>
                      <span className="menu-dot">{state?.autoSwitch && p.apps.length > 0 && <span className="auto" />}</span>
                      <span className="menu-text">
                        <b>{p.name}</b>
                        {p.apps.length > 0 && <small className="mono">{p.apps.join(", ")}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
        )}
        {naming === null ? (
          <span className="pop-anchor" ref={addRef}>
            <button data-guide="newDeck" className={`tab new-deck${adding ? " is-active" : ""}`} aria-expanded={adding} title={t("topbar.newDeck")} onClick={() => (setAdding((a) => !a), setReadyOpen(false))}>
              <Icon name="plus" />
              <span className="tb-label">{t("topbar.newDeck")}</span>
            </button>
            {adding && (
              <div className="popover new-deck-pop" role="dialog" aria-label={t("topbar.newDeck")}>
                {/* the one way into a new deck (owner's pick after the release audit, 2026-10-13) */}
                <div className="pop-title">{t("topbar.newDeck")}</div>
                <button
                  className="menu-row is-primary"
                  onClick={() => {
                    setAdding(false);
                    onOpenTour();
                  }}
                >
                  <span className="menu-ic">
                    <Icon name="play" />
                  </span>
                  <span className="menu-text">
                    <b>{t("newDeck.tour")}</b>
                    <small>{t("newDeck.tourHelp")}</small>
                  </span>
                </button>
                <button
                  className="menu-row"
                  onClick={() => {
                    setAdding(false);
                    onOpenForApp();
                  }}
                >
                  <span className="menu-ic is-plain">
                    <Icon name="app-window" />
                  </span>
                  <span className="menu-text">
                    <b>{t("forApp.menu")}</b>
                    <small>{t("forApp.menuHelp")}</small>
                  </span>
                </button>
                <button className="menu-row" aria-expanded={readyOpen} onClick={() => setReadyOpen((o) => !o)}>
                  <span className="menu-ic is-plain">
                    <Icon name="layout-grid" />
                  </span>
                  <span className="menu-text">
                    <b>{t("newDeck.ready")}</b>
                    <small>{t("newDeck.readyHelp")}</small>
                  </span>
                  <Icon name={readyOpen ? "chevron-up" : "chevron-down"} />
                </button>
                {readyOpen && <PresetList kinds={kinds} onPicked={() => setAdding(false)} />}
                <button
                  className="menu-row"
                  onClick={() => {
                    setAdding(false);
                    onOpenAssistant();
                  }}
                >
                  <span className="menu-ic is-plain">
                    <Icon name="sparkles" />
                  </span>
                  <span className="menu-text">
                    <b>{t("assistant.menu")}</b>
                    <small>{t("assistant.menuHelp")}</small>
                  </span>
                </button>
                <button
                  className="menu-row"
                  onClick={() => {
                    setAdding(false);
                    setNaming("");
                  }}
                >
                  <span className="menu-ic is-plain">
                    <Icon name="file-plus" />
                  </span>
                  <span className="menu-text">
                    <b>{t("newDeck.empty")}</b>
                  </span>
                </button>
              </div>
            )}
          </span>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = naming.trim();
              setNaming(null);
              if (name) api.createProfile(name).then((p) => api.activate(p.id));
            }}
          >
            <input className="input tab-input" autoFocus placeholder={t("topbar.profileName")} value={naming} onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)} />
          </form>
        )}
      </nav>
      {menu &&
        (() => {
          const p = all.find((x) => x.id === menu.id);
          return p ? <ProfileMenu profile={p} x={menu.x} y={menu.y} count={all.length} onClose={() => setMenu(null)} /> : null;
        })()}
      <div className="tabs-measure" ref={measureRef} aria-hidden="true">
        {profiles.map((p) => tab(p, true))}
        <button className="tab more" tabIndex={-1}>
          {t("topbar.more")}
          <span className="count">{hidden.length || 9}</span>
          <Icon name="chevron-down" />
        </button>
      </div>
    </>
  );
}

/** `Photoshop.exe` -> `Photoshop`. */
const appName = (exe: string) => exe.replace(/\.exe$/i, "");

/** Shown only while an app's own profile took over the deck: that app's icon, the why in its tooltip. */
function TakeoverMark({ app, focused }: { app: string; focused: boolean }) {
  const apps = useApps(app);
  const icon = appIcon(apps, app);
  const name = appName(app);
  const help = `${t("topbar.autoHelp", { app: name })}${focused ? ` ${t("topbar.lastAppHelp")}` : ""}`;
  return (
    <span className="fg" title={help} aria-label={help}>
      {icon ? <img src={icon} alt="" width={16} height={16} /> : <Icon name="app-window" />}
    </span>
  );
}

export function TopBar({
  live,
  view,
  onOpenProfile,
  onOpenProfileLibrary,
  onOpenSettings,
  onCheckUpdates,
  onOpenPlugins,
  onOpenGames,
  onOpenForApp,
  kinds,
  newRequest,
  onOpenAssistant,
  onOpenTour,
  setupPending,
}: {
  kinds?: string[];
  newRequest?: number;
  onOpenAssistant: () => void;
  onOpenTour: () => void;
  onOpenForApp: () => void;
  live: LiveState;
  view: EngineView;
  onOpenProfile: () => void;
  onOpenProfileLibrary: () => void;
  onOpenSettings: () => void;
  onCheckUpdates?: () => void;
  onOpenPlugins: () => void;
  onOpenGames: () => void;
  setupPending: boolean;
}) {
  useLanguage();
  const count = live.deck.modules.filter((m) => m.kind !== "base").length;
  const orientation = live.deck.orientation;
  const state = view.state;
  const focused = useWindowFocus();
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        MasterDeck
      </div>
      <button type="button" className="tool ghost topbar-profile-library" onClick={onOpenProfileLibrary} aria-label={t("profiles.title")} aria-haspopup="dialog">
        <Icon name="layers" />
        <span className="tb-label">{t("profiles.title")}</span>
      </button>
      <ProfileTabs view={view} onOpenProfile={onOpenProfile} onOpenForApp={onOpenForApp} onOpenAssistant={onOpenAssistant} onOpenTour={onOpenTour} kinds={kinds} newRequest={newRequest} />
      {state?.autoApp && <TakeoverMark app={state.autoApp} focused={focused} />}
      {state && (
        <label className="check auto-switch" title={state.pinned ? t("topbar.autoOffHelp", { profile: state.profiles.find((p) => p.id === state.active)?.name ?? "" }) : t("topbar.autoOnHelp")}>
          <input type="checkbox" checked={!state.pinned} onChange={(e) => api.pin(!e.target.checked)} />
          {t("topbar.autoSwitch")}
        </label>
      )}
      <span className="sep" />
      {setupPending && <button type="button" className="tool ghost" onClick={onOpenTour}>{t("stage.setup")}</button>}
      {GAMES_ENABLED && (
        <button className="tool ghost" onClick={onOpenGames}>
          {t("topbar.games")}
        </button>
      )}
      <button className="tool ghost" onClick={onOpenPlugins} title={t("topbar.plugins")}>
        <Icon name="plug" />
        <span className="tb-label">{t("topbar.plugins")}</span>
      </button>
      <button className="tool ghost" onClick={onOpenSettings} title={t("topbar.settings")}>
        <Icon name="settings" />
        <span className="tb-label">{t("topbar.settings")}</span>
      </button>
      {onCheckUpdates && (
        <button type="button" className="tool ghost topbar-update" onClick={onCheckUpdates} aria-label={t("updates.checkNow")} title={t("updates.checkNow")}>
          <Icon name="refresh-cw" />
          <span className="tb-label">{t("updates.title")}</span>
        </button>
      )}
      <span className="sep" />
      <div className="status" title={orientation ? t("topbar.baseLies", { orientation: t(`orientation.${orientation}`) }) : undefined}>
        <span className={`dot${count > 0 ? " is-on" : ""}`} />
        {t("topbar.modules", { count })}
      </div>
    </header>
  );
}

export function DeckTools({ canArrange, modulesOpen, onModules, onArrange, onBuild, onDisplay, onSaver }: {
  canArrange: boolean;
  modulesOpen: boolean;
  onModules: () => void;
  onArrange: () => void;
  onBuild: () => void;
  onDisplay: () => void;
  onSaver: () => void;
}) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const actions = [
    { label: t("settings.lightsScreens"), icon: "sun", run: onDisplay },
    { label: t("saver.title"), icon: "moon", run: onSaver },
    { label: t("stage.editLayout"), icon: "layout-grid", run: onArrange, disabled: !canArrange },
    { label: t("builder.title"), icon: "pencil", run: onBuild },
    { label: t(modulesOpen ? "stage.hideModules" : "stage.showModules"), icon: "layers", run: onModules },
  ];
  return (
    <span className="pop-anchor deck-tools" ref={ref}>
      <button type="button" className="tool deck-tools-trigger" data-guide="edge" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="sliders-horizontal" />
        {t("stage.tools")}
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="popover" role="menu" aria-label={t("stage.tools")}>
          {actions.map(({ label, icon, run, disabled }) => (
            <button key={icon} type="button" role="menuitem" className="menu-row compact" disabled={disabled} onClick={() => { close(); run(); }}>
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The hardware light effect and its speed (base edge, knob and fader LEDs). */
/** Ready-made tunings of the lights to the music (beat.rs `PRESETS`): [id, darker between beats, from how loud]. */
const MUSIC_PRESETS = [
  ["soft", 20, 10],
  ["beat", 60, 45],
  ["punchy", 85, 60],
  ["beats", 100, 100],
] as const;

/** Lights to the music: a preset, then the two sliders it sets, for every light that follows the music. */
function MusicTuning({ l, setL, save }: { l: LightSettings; setL: (l: LightSettings) => void; save: (l: LightSettings) => void }) {
  const dim = l.musicDim ?? 60;
  const from = l.musicFrom ?? 45;
  const preset = MUSIC_PRESETS.find(([, d, f]) => d === dim && f === from)?.[0] ?? "own";
  const slider = (id: string, label: string, value: number, set: (v: number) => LightSettings) => (
    <div className="field">
      <div className="row between">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className="mono value">{value}</span>
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        style={{ "--fill": `${value}%` } as React.CSSProperties}
        onChange={(e) => setL(set(Number(e.target.value)))}
        onPointerUp={() => save(l)}
        onKeyUp={() => save(l)}
      />
    </div>
  );
  return (
    <div className="music-tuning">
      <div className="field">
        <label htmlFor="lights-music-preset" className="label">
          {t("lights.musicTitle")}
        </label>
        <select
          id="lights-music-preset"
          className="input"
          value={preset}
          onChange={(e) => {
            const p = MUSIC_PRESETS.find(([id]) => id === e.target.value);
            if (p) save({ ...l, musicDim: p[1], musicFrom: p[2] });
          }}
        >
          {MUSIC_PRESETS.map(([id]) => (
            <option key={id} value={id}>
              {t(`lights.musicPreset.${id}`)}
            </option>
          ))}
          {preset === "own" && <option value="own">{t("lights.musicPreset.own")}</option>}
        </select>
      </div>
      <div className="field">
        <label htmlFor="lights-music-mode" className="label">
          {t("lights.musicMode")}
        </label>
        <select id="lights-music-mode" className="input" value={l.musicMode ?? "predict"} onChange={(e) => save({ ...l, musicMode: e.target.value })}>
          <option value="predict">{t("lights.musicMode.predict")}</option>
          <option value="react">{t("lights.musicMode.react")}</option>
        </select>
      </div>
      <div className="field">
        <span className="label">{t("lights.musicWhich")}</span>
        <label className="check">
          <input type="checkbox" checked disabled />
          {t("lights.musicEdge")}
        </label>
        <label className="check">
          <input type="checkbox" checked={l.musicKnobs ?? false} onChange={(e) => save({ ...l, musicKnobs: e.target.checked })} />
          {t("lights.musicKnobs")}
        </label>
        <label className="check">
          <input type="checkbox" checked={l.musicFaders ?? false} onChange={(e) => save({ ...l, musicFaders: e.target.checked })} />
          {t("lights.musicFaders")}
        </label>
      </div>
      {slider("lights-music-dim", t("lights.musicDim"), dim, (v) => ({ ...l, musicDim: v }))}
      {slider("lights-music-from", t("lights.musicFrom"), from, (v) => ({ ...l, musicFrom: v }))}
      {(l.musicMode ?? "predict") === "predict" && (
        <>
          <div className="field">
            <div className="row between">
              <label htmlFor="lights-music-lead" className="label">
                {t("lights.musicLead")}
              </label>
              <span className="mono value">{l.musicLead ?? 20} ms</span>
            </div>
            <input
              id="lights-music-lead"
              className="range"
              type="range"
              min={0}
              max={200}
              step={5}
              value={l.musicLead ?? 20}
              style={{ "--fill": `${((l.musicLead ?? 20) / 200) * 100}%` } as React.CSSProperties}
              onChange={(e) => setL({ ...l, musicLead: Number(e.target.value) })}
              onPointerUp={() => save(l)}
              onKeyUp={() => save(l)}
            />
          </div>
          <div className="row wrap">
            <button className="tool ghost" onClick={() => api.musicTest().catch(() => {})}>
              <Icon name="play" />
              {t("lights.musicTest")}
            </button>
          </div>
          <p className="help">{t("lights.musicTestHelp")}</p>
          <label className="check">
            <input type="checkbox" checked={l.musicWhite ?? true} onChange={(e) => save({ ...l, musicWhite: e.target.checked })} />
            {t("lights.musicWhite")}
          </label>
        </>
      )}
      <p className="help">{t(IS_MAC ? "lights.musicHelpMac" : "lights.musicHelp")}</p>
    </div>
  );
}

/** The style the lights had before they followed the music, to go back to when the music is switched off. */
const BEFORE_MUSIC = "lightsBeforeMusic";

/** Lights to the music, from its chip under the deck (owner's "3 a", 2026-10-30): on or off for every
 * profile, which lights join, and how they follow it. */
export function MusicPanel({ onClose }: { onClose: () => void }) {
  useLanguage();
  const [l, setL] = useState<LightSettings | null>(null);
  useEffect(() => {
    api.lights().then(setL, () => {});
  }, []);
  const head = <PanelHead title={t("music.title")} crumb={t("music.allProfiles")} icon="music" onClose={onClose} />;
  if (!l) return <aside className="inspector sectioned living-panel">{head}</aside>;
  const save = (next: LightSettings) => {
    setL(next);
    api.setLights(next).catch(() => {});
  };
  const on = l.style === "music";
  const toggle = (want: boolean) => {
    if (want) {
      try {
        writePreference(BEFORE_MUSIC, l.style);
      } catch {
        // a page without storage goes back to the rainbow
      }
      save({ ...l, style: "music" });
    } else {
      let before = "rainbow";
      try {
        before = readPreference(BEFORE_MUSIC) || "rainbow";
      } catch {
        // as above
      }
      save({ ...l, style: before === "music" ? "rainbow" : before });
    }
  };
  return (
    <aside className="inspector sectioned living-panel">
      {head}
      <section className="sec">
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          {t("music.on")}
        </label>
        <p className="help">{t("music.onHelp")}</p>
        {/* the tuning only while the lights follow the music (ROADMAP Next, 2026-11-01) */}
        {on && <MusicTuning l={l} setL={setL} save={save} />}
      </section>
    </aside>
  );
}

export function EffectFields({ idPrefix, effect, speed, onChange }: { idPrefix: string; effect?: string; speed?: number; onChange: (effect?: string, speed?: number) => void }) {
  useLanguage();
  const current = effect ?? "static";
  const value = speed ?? 50;
  return (
    <div className="effect-fields">
      <div className="field">
        <label htmlFor={`${idPrefix}-effect`} className="label">
          {t("look.effect")}
        </label>
        <select id={`${idPrefix}-effect`} className="input" value={current} onChange={(e) => onChange(e.target.value === "static" ? undefined : e.target.value, e.target.value === "static" ? undefined : speed)}>
          {LED_EFFECTS.map((fx) => (
            <option key={fx} value={fx}>
              {t(`effect.${fx}`)}
            </option>
          ))}
        </select>
      </div>
      {current === "music" && <p className="help">{t("lights.musicWhere")}</p>}
      {current !== "static" && current !== "music" && (
        <div className="field">
          <div className="row between">
            <label htmlFor={`${idPrefix}-speed`} className="label">
              {t("look.speed")}
            </label>
            <span className="mono value">{value}</span>
          </div>
          <input
            id={`${idPrefix}-speed`}
            className="range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={value}
            style={{ "--fill": `${value}%` } as React.CSSProperties}
            onChange={(e) => onChange(effect, Number(e.target.value))}
          />
        </div>
      )}
    </div>
  );
}

/** Title row of a side panel: icon, small caption, title, close. */
/** A panel over the window (For an app, Gallery, Games, a deck's settings): the editor on the right stays. Esc or a click outside closes it. */
export function Sheet({ onClose, label, children }: { onClose: () => void; label?: string; children: React.ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // a popover inside closes first (its own Escape); the sheet only when nothing else is open
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".sheet .popover")) close.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function PanelHead({ title, crumb, icon, onClose }: { title: string; crumb?: string; icon?: string; onClose?: () => void }) {
  return (
    <div className="insp-head panel-head">
      {icon && (
        <span className="ph-icon">
          <Icon name={icon} />
        </span>
      )}
      <div className="grow">
        {crumb && <div className="crumb">{crumb}</div>}
        <h2>{title}</h2>
      </div>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label={t("profile.close")} title={t("profile.close")}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

/** Name, apps that switch to it, auto-switch, export / import / duplicate / delete. */
/**
 * "Edge" under the drawing: this profile's lights (its color, its own edge) and the way to every
 * profile's lights in Settings, so lights live in two places, not three (owner's pick 3a,
 * 2026-10-16; docs/FLOWS.md difference 6).
 */
export function EdgePanel({ view, onClose, onAll }: { view: EngineView; onClose: () => void; onAll: () => void }) {
  useLanguage();
  const profile = view.profile;
  const [draft, setDraft] = useState<Profile | null>(profile);
  const [message, setMessage] = useState<string | null>(null);
  // the style every profile follows, named in the first choice (owner's pick 2a, 2026-10-16: a
  // profile color that did nothing under Rainbow was confusing; one choice that works at once)
  const [style, setStyle] = useState<string | null>(null);
  useEffect(() => setDraft(profile), [profile?.id]);
  useEffect(() => {
    api.lights().then((l) => setStyle(l.style), () => setStyle(null));
  }, []);
  if (!profile || !draft) return null;
  const commit = (next: Profile) => {
    // his own edge colour wins: the preset's colours on the lights go off (owner's "1 a", 2026-10-30)
    // his own edge colour is the more particular setting: the preset's colour leaves the edge only
    if (next.edge !== profile.edge && next.effects?.lights) {
      const to = (next.effects.lightsTo ?? ["edge", "controls"]).filter((p) => p !== "edge");
      next = { ...next, effects: { ...next.effects, lights: to.length ? next.effects.lights : undefined, lightsTo: to.length ? to : undefined } };
    }
    setDraft(next);
    api.saveProfile(next).catch((e) => setMessage(String(e)));
  };
  const mode = !draft.edge ? "follow" : draft.edgeEffect ? "effect" : "color";
  const styleName = style === "rainbow" ? t("lights.rainbow") : style === "color" ? t("lights.oneColor") : style === "profile" ? t("lights.profileColor") : style === "off" ? t("lights.off") : style === "music" ? t("lights.music") : "";
  const pick = (next: "follow" | "color" | "effect") => {
    if (next === "follow") commit({ ...draft, edge: undefined, edgeEffect: undefined, edgeSpeed: undefined });
    else if (next === "color") commit({ ...draft, edge: draft.edge ?? draft.color ?? "#8b7cf6", edgeEffect: undefined, edgeSpeed: undefined });
    else commit({ ...draft, edge: draft.edge ?? draft.color ?? "#8b7cf6", edgeEffect: draft.edgeEffect ?? "breathing", edgeSpeed: draft.edgeSpeed ?? 50 });
  };
  return (
    <aside className="inspector sectioned side-panel edge-panel">
      <PanelHead title={t("edge.title")} crumb={draft.name} icon="sun" onClose={onClose} />
      <section className="sec">
        <h3 className="sec-title">{t("profile.edgeTitle")}</h3>
        <div className="seg full edge-modes" role="radiogroup" aria-label={t("profile.edgeTitle")}>
          {(["follow", "color", "effect"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={`tab${mode === m ? " is-active" : ""}`} onClick={() => pick(m)}>
              {t(`edge.mode.${m}` as Key)}
            </button>
          ))}
        </div>
        {mode === "follow" && (
          <>
            <p className="help">{styleName ? t("edge.followStyle", { style: styleName }) : t("edge.followHelp")}</p>
            {style === "profile" && (
              <div className="row between">
                <span className="label">{t("profile.color")}</span>
                <label className="color">
                  <input type="color" value={draft.color ?? "#8b7cf6"} aria-label={t("profile.color")} onChange={(e) => setDraft({ ...draft, color: e.target.value })} onBlur={() => commit(draft)} />
                </label>
              </div>
            )}
          </>
        )}
        {mode !== "follow" && draft.edge && (
          <div className="row between">
            <span className="label">{t("look.color")}</span>
            <label className="color">
              <input type="color" value={draft.edge} aria-label={t("look.color")} onChange={(e) => setDraft({ ...draft, edge: e.target.value })} onBlur={() => commit(draft)} />
              <span className="mono">{draft.edge.toUpperCase()}</span>
            </label>
          </div>
        )}
        {mode === "effect" && <EffectFields idPrefix="edge" effect={draft.edgeEffect} speed={draft.edgeSpeed} onChange={(edgeEffect, edgeSpeed) => commit({ ...draft, edgeEffect: edgeEffect ?? "breathing", edgeSpeed })} />}
      </section>
      <section className="sec end">
        <button className="tool align-start" onClick={onAll}>
          <Icon name="sun" />
          {t("edge.all")}
        </button>
        <p className="help">{t("edge.allHelp")}</p>
        {message && <p className="help">{message}</p>}
      </section>
    </aside>
  );
}

/** One option of a layer as a slider (0..100, wind -100..100), its default in the middle. */
function FxSlider({ id, label, value, min, max, fallback, show, onChange }: { id: string; label: string; value?: number; min: number; max: number; fallback: number; show: (v: number) => string; onChange: (v: number) => void }) {
  const v = value ?? fallback;
  return (
    <label className="field fx-opt" htmlFor={id}>
      <span className="label">
        {label} <span className="tx2">{show(v)}</span>
      </span>
      <input id={id} type="range" min={min} max={max} step={5} value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** The options of one switched-on effect (only those its kind listens to). */
export function FxOptions({ layer, onChange }: { layer: FxLayer; onChange: (l: FxLayer) => void }) {
  const opts = FX_OPTIONS[layer.kind];
  const id = `fx-${layer.kind}`;
  return (
    <div className="fx-card-body">
      {opts.includes("strength") && <FxSlider id={`${id}-strength`} label={t("effects.strength")} value={layer.strength} min={10} max={100} fallback={60} show={(v) => `${v}%`} onChange={(strength) => onChange({ ...layer, strength })} />}
      {opts.includes("speed") && <FxSlider id={`${id}-speed`} label={t("effects.speed")} value={layer.speed} min={0} max={100} fallback={50} show={(v) => `${(0.25 * Math.pow(16, v / 100)).toFixed(1)}×`} onChange={(speed) => onChange({ ...layer, speed })} />}
      {opts.includes("density") && <FxSlider id={`${id}-density`} label={t(layer.kind === "bats" ? "effects.often" : layer.kind === "finish" ? "effects.grain" : layer.kind === "scene" ? "effects.stars" : "effects.density")} value={layer.density} min={0} max={100} fallback={50} show={(v) => `${v}%`} onChange={(density) => onChange({ ...layer, density })} />}
      {opts.includes("wind") && <FxSlider id={`${id}-wind`} label={t(layer.kind === "light" ? "effects.angle" : "effects.wind")} value={layer.wind} min={-100} max={100} fallback={0} show={(v) => (v === 0 ? t("effects.calm") : `${v < 0 ? "←" : "→"} ${Math.abs(v)}%`)} onChange={(wind) => onChange({ ...layer, wind })} />}
      {opts.includes("tint") && (
        <div className="row between">
          <label className="check">
            <input type="checkbox" checked={!!layer.tint} onChange={(e) => onChange({ ...layer, tint: e.target.checked ? FX_TINT[layer.kind] : undefined })} />
            {t("effects.tint")}
          </label>
          {layer.tint && (
            <label className="color">
              <input type="color" value={layer.tint} aria-label={t("effects.tint")} onChange={(e) => onChange({ ...layer, tint: e.target.value })} />
              <span className="mono">{layer.tint.toUpperCase()}</span>
            </label>
          )}
        </div>
      )}
      {layer.kind === "finish" && (layer.density ?? 50) > 50 && <p className="help">{t("effects.grainCost")}</p>}
      {opts.includes("moving") && (
        <label className="check">
          <input type="checkbox" checked={layer.moving === true} onChange={(e) => onChange({ ...layer, moving: e.target.checked || undefined })} />
          {t("effects.moving")}
        </label>
      )}
      {opts.includes("side") && (
        <div className="row between">
          <span className="label">{t("effects.side")}</span>
          <span className="seg" role="radiogroup" aria-label={t("effects.side")}>
            {(["left", "right"] as const).map((sd) => (
              <button key={sd} role="radio" aria-checked={(layer.side ?? "right") === sd} className={`tab${(layer.side ?? "right") === sd ? " is-active" : ""}`} onClick={() => onChange({ ...layer, side: sd === "right" ? undefined : sd })}>
                {t(`effects.side.${sd}` as Key)}
              </button>
            ))}
          </span>
        </div>
      )}
      {opts.includes("react") && (
        <label className="check">
          <input type="checkbox" checked={layer.react !== false} onChange={(e) => onChange({ ...layer, react: e.target.checked ? undefined : false })} />
          {t("effects.react")}
        </label>
      )}
      {GPU_KINDS.includes(layer.kind) && <p className="help">{t("effects.gpuHelp")}</p>}
      <button className="tool small ghost align-start" onClick={() => onChange({ kind: layer.kind })}>
        {t("effects.reset")}
      </button>
    </div>
  );
}

/**
 * The order the engine draws effects in, whatever order they were switched on (owner, 2026-10-26:
 * categories with effects switched on and off, not a stack of layers): the scene at the back, the
 * water and the ripple bending what is under them, across the keys, the press's sparks, the
 * visitors, the lamp, the finish on top.
 */
export const FX_ORDER: FxKind[] = [
  "goldlight",
  "woodland",
  "fuji",
  "matrix",
  "code",
  "synthwave",
  "ink",
  "nebula",
  "spectrum",
  "circuit",
  "orbit",
  "vinyl",
  "impasto",
  "hollowhill",
  "lanternhollow",
  "tokyorain",
  "ukiyo",
  "koi",
  "scene",
  "aurora",
  "aquarium",
  "cover",
  "lava",
  "caustics",
  "haunt",
  "lanterns",
  "storks",
  "liquid",
  "glass",
  "water",
  "ripple",
  "fog",
  "mist",
  "rain",
  "neonrain",
  "snow",
  "fireflies",
  "embers",
  "fire",
  "leaves",
  "sakura",
  "burst",
  "bats",
  "hop",
  "light",
  "frames",
  "holo",
  "relief",
  "gold",
  "chrome",
  "crystal",
  "candle",
  "spectral",
  "frost",
  "heart",
  "finish",
  "springs",
  "pumpkins",
  "webs",
  "stone",
  "carved",
  "slime",
  "mushrooms",
  "eyes",
  "ghost",
  "spider",
  "batburst",
  "ghostrise",
  "bloom",
  "magnet",
  "shockwave",
  "chain",
  "firework",
  "domino",
  "flip",
];

/**
 * What each effect costs a frame on the CPU (ms, release build, the whole panel, 2026-10-26
 * `canvas_cost`), and whether it moves the whole screen all the time (more to send each picture).
 * The water and the ripple cost only for a few seconds after a press.
 */
export const FX_COST: Record<FxKind, { ms: number; moves: boolean }> = withUpright({
  fog: { ms: 2.2, moves: true },
  rain: { ms: 0.3, moves: true },
  snow: { ms: 0.2, moves: true },
  fireflies: { ms: 0.5, moves: true },
  embers: { ms: 2.4, moves: true },
  ripple: { ms: 0.6, moves: false },
  water: { ms: 0.4, moves: false },
  burst: { ms: 0.2, moves: false },
  bats: { ms: 0.1, moves: false },
  light: { ms: 0.5, moves: true },
  scene: { ms: 0.4, moves: true },
  finish: { ms: 0.4, moves: false },
  fire: { ms: 0.5, moves: true },
  aurora: { ms: 0.5, moves: true },
  aquarium: { ms: 0.5, moves: true },
  cover: { ms: 0.5, moves: true },
  lava: { ms: 0.5, moves: true },
  glass: { ms: 0.5, moves: true },
  frames: { ms: 0.5, moves: true },
  liquid: { ms: 0.5, moves: true },
  frost: { ms: 0.5, moves: true },
  springs: { ms: 0.4, moves: false },
  heart: { ms: 0.4, moves: false },
  flip: { ms: 0.5, moves: false },
  hop: { ms: 0.5, moves: true },
  holo: { ms: 0.5, moves: true },
  relief: { ms: 0.5, moves: true },
  gold: { ms: 0.5, moves: true },
  chrome: { ms: 0.5, moves: true },
  crystal: { ms: 0.5, moves: true },
  mist: { ms: 0.5, moves: true },
  neonrain: { ms: 0.5, moves: true },
  caustics: { ms: 0.6, moves: true },
  pumpkins: { ms: 0.5, moves: true },
  eyes: { ms: 0.5, moves: true },
  ghost: { ms: 0.5, moves: true },
  spider: { ms: 0.5, moves: true },
  webs: { ms: 0.4, moves: true },
  batburst: { ms: 0.4, moves: false },
  ghostrise: { ms: 0.4, moves: false },
  domino: { ms: 0.4, moves: false },
  chain: { ms: 0.4, moves: false },
  firework: { ms: 0.4, moves: false },
  shockwave: { ms: 0.4, moves: false },
  magnet: { ms: 0.4, moves: false },
  bloom: { ms: 0.4, moves: false },
  haunt: { ms: 0.5, moves: true },
  candle: { ms: 0.5, moves: true },
  carved: { ms: 0.5, moves: true },
  stone: { ms: 0.4, moves: false },
  slime: { ms: 0.5, moves: true },
  spectral: { ms: 0.5, moves: true },
  leaves: { ms: 0.6, moves: true },
  storks: { ms: 0.5, moves: true },
  goldlight: { ms: 0.6, moves: true },
  sakura: { ms: 0.6, moves: true },
  lanterns: { ms: 0.5, moves: true },
  ukiyo: { ms: 0.5, moves: true },
  koi: { ms: 0.6, moves: true },
  mushrooms: { ms: 0.5, moves: false },
  woodland: { ms: 0.7, moves: true },
  fuji: { ms: 0.7, moves: true },
  matrix: { ms: 0.7, moves: true },
  code: { ms: 0.7, moves: true },
  synthwave: { ms: 0.7, moves: true },
  ink: { ms: 0.7, moves: true },
  nebula: { ms: 0.7, moves: true },
  spectrum: { ms: 0.7, moves: true },
  circuit: { ms: 0.7, moves: true },
  orbit: { ms: 0.7, moves: true },
  vinyl: { ms: 0.7, moves: true },
  impasto: { ms: 0.7, moves: true },
  hollowhill: { ms: 1.9, moves: true },
  lanternhollow: { ms: 1.9, moves: true },
  tokyorain: { ms: 1.9, moves: true },
});

/** A key's look in a skin (with the motion it was made with) or in none (its own motion goes too). */
export function skinned(look: Look, skin: Skin | undefined): Look {
  const own = look.skin && look.motion === SKIN_MOTION[look.skin];
  if (!skin) return { ...look, skin: undefined, motion: own ? undefined : look.motion };
  return { ...look, skin, motion: SKIN_MOTION[skin] ?? (own ? undefined : look.motion) };
}

/** The deck's frame budget at 24 pictures a second, ms. */
const FRAME_BUDGET_MS = 1000 / 24;

/**
 * The frame cost debugger (owner, 2026-10-27: "debugger który pokaże mi ile każdy z efektów/laerów
 * dodane ms na obliczenia i co sklada sie na te \"ciężkie obliczenia\""; his "ok" to the sketch):
 * each layer's ms a frame, the heaviest marked, and the frame's parts, live once a second (the
 * panel asks; the load bar uses the same numbers). Its open state is kept per viewer. Shown nowhere
 * since the Living deck panel gave way to the Deck look view; kept until the owner picks whether
 * the frame's parts (keys, JPEG, USB send) get a place there.
 */
export function FrameCostView({ cost }: { cost: FrameCost | null }) {
  const [open, setOpen] = useState(() => {
    try {
      return readPreference("frameCost") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      writePreference("frameCost", open ? "1" : "0");
    } catch {
      /* private window: the state is not kept */
    }
  }, [open]);
  const rows = cost?.layers ?? [];
  const heaviest = rows.reduce((m, r) => (r.ms > m ? r.ms : m), 0);
  const parts = cost ? [cost.layersMs, cost.keysMs, cost.encodeMs] : [];
  const total = parts.reduce((a, b) => a + b, 0);
  // the effects against the heaviest effect, the picture's parts against the largest part: one
  // scale for both left the effects' bars a sliver beside "Effects together"
  const partScale = Math.max(...parts, cost?.sendMs ?? 0, 0.5);
  const name = (kind: string) => (kind === "halo" ? t("effects.cost.halo") : fxName(kind as FxKind));
  const bar = (label: string, ms: number, scale: number, extra?: string, mark?: boolean) => (
    <div className={`fx-cost-row${mark ? " is-heaviest" : ""}`} key={label}>
      <span className="fx-cost-name">{label}</span>
      <span className="fx-load-bar" aria-hidden="true">
        <i style={{ width: `${Math.min(100, (ms / scale) * 100)}%` }} />
      </span>
      <span className="fx-cost-ms mono">{t("effects.cost.ms", { ms: ms.toFixed(ms < 10 ? 2 : 1) })}</span>
      <span className="fx-cost-note">{extra ?? ""}</span>
    </div>
  );
  return (
    <details className="fx-cost" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary title={t("effects.cost.help")}>
        <span>{t("effects.cost")}</span>
        {cost && <span className="mono fx-cost-total">{t("effects.cost.total", { ms: total.toFixed(1), budget: FRAME_BUDGET_MS.toFixed(1) })}</span>}
      </summary>
      {!cost ? (
        <p className="help">{t("effects.cost.waiting")}</p>
      ) : (
        <div className="fx-cost-body">
          <span className="label">{t("effects.cost.layers")}</span>
          {rows.map((r) => bar(name(r.kind), r.ms, Math.max(heaviest, 0.5), r.ms === heaviest && rows.length > 1 ? t("effects.cost.heaviest") : undefined, r.ms === heaviest && rows.length > 1))}
          <span className="label">{t("effects.cost.frame")}</span>
          {bar(t("effects.cost.layersTotal"), cost.layersMs, partScale)}
          {bar(t("effects.cost.keys"), cost.keysMs, partScale)}
          {bar(t("effects.cost.encode"), cost.encodeMs, partScale)}
          {bar(t("effects.cost.send"), cost.sendMs, partScale, t("effects.cost.ownThread"))}
        </div>
      )}
    </details>
  );
}


const SAVER_NOT_PRESETS = ["music-spectrum", "music-spectrum-up"];

function SaverPanel({ view }: { view: EngineView }) {
  useLanguage();
  const profile = view.profile;
  const [draft, setDraft] = useState(profile);
  const [shared, setShared] = useState<Screens | null>(knownScreens);
  const [custom, setCustom] = useState<CustomSaver[]>([]);
  const [busy, setBusy] = useState<"saving" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const previewing = !!useSaverShown()?.preview;

  useEffect(() => setDraft(profile), [profile]);
  useEffect(() => {
    let active = true;
    Promise.all([api.screens(), api.saversList()]).then(([screens, library]) => {
      if (active) {
        setShared(screens);
        setCustom(library);
      }
    }, (error) => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);

  const run = async (task: () => Promise<unknown>, action: "saving" | "importing" = "saving") => {
    setBusy(action);
    setError(null);
    try {
      await task();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(null);
    }
  };
  const refreshShared = async () => {
    const updated = await api.screens();
    setShared(updated);
    screensChanged(updated);
  };

  if (!draft || !shared) return (
    <section className="sec" aria-label={t("saver.title")}>
      {error ? <p className="help warn" role="alert">{error}</p> : <p className="help" role="status">{t("app.loadingPanel")}</p>}
    </section>
  );

  const now = saverOf(draft, shared);
  const item = custom.find((entry) => entry.id === now.effect);
  const effect = now.effect.startsWith("custom:") && !item ? "" : now.effect;
  const layersFor = (choice: string) => {
    if (choice === now.effect) return now.own ? draft.saver?.layers : shared.saverLayers;
    return THEMES.find((theme) => theme.id === saverPreset(choice))?.layers;
  };
  const save = async (choice: string, afterMinutes = now.afterMinutes, own = now.own) => {
    const assignment = { effect: choice, afterMinutes, layers: layersFor(choice) };
    await api.saverConfigure(own ? draft.id : null, assignment);
    if (own) setDraft(await api.profile(draft.id));
    else await refreshShared();
  };
  const commitDisplays = (patch: Partial<Screens>) => run(async () => {
    await api.setScreens({ ...await api.screens(), ...patch });
    await refreshShared();
  });
  const scenes = SAVER_SCENES.filter((scene) => !scene.hidden || scene.id === effect);
  const presets = THEMES.filter((theme) => effect === "preset:" + theme.id || (
    !PRESETS_HIDDEN.has(theme.id) && !SAVER_NOT_PRESETS.includes(theme.id) && layersOf({ layers: theme.layers }).length > 0
  ));
  const fromLook = effect === SAVER_FROM_LOOK || layersOf(draft.effects).length > 0;
  const extraPreset = effect !== SAVER_FROM_LOOK && !presets.some((theme) => "preset:" + theme.id === effect) ? saverPreset(effect) : undefined;
  const choices = (options: number[], stored: number) => [...new Set([...options, stored])].sort((a, b) => a - b);
  const startImport = () => run(async () => {
    const path = await open({ multiple: false, filters: [{ name: t("saver.fileType"), extensions: ["gif", "webp", "png", "jpg", "jpeg"] }] });
    if (typeof path !== "string") return;
    const media = await api.saverImport(path);
    setCustom((items) => [...items, media]);
    setConfirmRemove(false);
    await save(media.id);
  }, "importing");

  return (
    <div className="saver-settings">
      <section className="sec">
        <label className="field">
          <span className="label">{t("screens.saver")}</span>
          <select className="input" value={effect} disabled={!!busy} onChange={(event) => {
            setConfirmRemove(false);
            const choice = event.currentTarget.value;
            void run(() => save(choice));
          }}>
            <option value="">{t("screens.saverOff")}</option>
            <optgroup label={t("saver.scenes")}>
              {scenes.map((scene) => <option key={scene.id} value={scene.id}>{t(("saver.scene." + scene.id) as Key)}</option>)}
            </optgroup>
            {custom.length > 0 && <optgroup label={t("saver.custom")}>
              {custom.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </optgroup>}
            <optgroup label={t("saver.presets")}>
              {fromLook && <option value={SAVER_FROM_LOOK}>{t("saver.fromLook")}</option>}
              {presets.map((theme) => <option key={theme.id} value={"preset:" + theme.id}>{themeTitle(theme.id)}</option>)}
              {extraPreset && <option value={effect}>{themeTitle(extraPreset)}</option>}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span className="label">{t("screens.saverAfter")}</span>
          <select className="input" value={now.afterMinutes} disabled={!!busy || !effect} onChange={(event) => {
            const minutes = Number(event.currentTarget.value);
            void run(() => save(effect, minutes));
          }}>
            {choices([1, 2, 5, 10, 15, 30, 60], now.afterMinutes).map((minutes) =>
              <option key={minutes} value={minutes}>{t("screens.minutes", { count: minutes })}</option>)}
          </select>
        </label>
        {effect && shared.blankAfterMinutes > 0 && shared.blankAfterMinutes <= now.afterMinutes &&
          <p className="help warn">{t("saver.blankWarning")}</p>}
        <div className="saver-buttons">
          <button type="button" className="tool" disabled={!!busy} onClick={() => void startImport()}>
            <Icon name="plus" />{t("saver.add")}
          </button>
          <button type="button" className="tool" disabled={!!busy || !effect} onClick={() =>
            void run(() => previewing ? saverEnd() : api.saverTry(effect, layersFor(effect)))}>
            <Icon name={previewing ? "x" : "play"} />{t(previewing ? "saver.stopPreview" : "saver.preview")}
          </button>
        </div>
        {busy === "importing" && <p className="help" role="status">{t("saver.importing")}</p>}
        {previewing && <p className="help" role="status">{t("saver.tryHelp")}</p>}
        <p className="help">{t("saver.files")}</p>
        {item && (confirmRemove ? <div className="field">
          <p className="help">{t("saver.removeConfirm", { name: item.name })}</p>
          <div className="saver-buttons">
            <button type="button" className="tool" disabled={!!busy} onClick={() => setConfirmRemove(false)}>{t("confirm.cancel")}</button>
            <button type="button" className="tool" disabled={!!busy} onClick={() => void run(async () => {
              await api.saverRemove(item.id);
              setCustom((items) => items.filter((entry) => entry.id !== item.id));
              setConfirmRemove(false);
              await refreshShared();
            })}>{t("saver.remove")}</button>
          </div>
        </div> : <button type="button" className="link-btn align-start" disabled={!!busy} onClick={() => setConfirmRemove(true)}>{t("saver.remove")}</button>)}
        {error && <p className="help warn" role="alert">{error}</p>}
      </section>
      <details className="sec saver-advanced">
        <summary>{t("saver.advanced")}</summary>
        <label className="field">
          <span className="label">{t("saver.forProfile")}</span>
          <select className="input" value={now.own ? "own" : "shared"} disabled={!!busy} onChange={(event) => {
            if (event.currentTarget.value === "own") void run(() => save(effect, now.afterMinutes, true));
            else void run(async () => {
              await api.saverConfigure(draft.id, undefined);
              setDraft(await api.profile(draft.id));
            });
          }}>
            <option value="shared">{t("saver.shared")}</option>
            <option value="own">{t("saver.own")}</option>
          </select>
        </label>
        <label className="field">
          <span className="label">{t("saver.dial")}</span>
          <select className="input" value={shared.saverDial ?? "clock"} disabled={!!busy} onChange={(event) => void commitDisplays({ saverDial: event.currentTarget.value as Screens["saverDial"] })}>
            {(["clock", "same", "off"] as const).map((value) => <option key={value} value={value}>{t(("saver.dial." + value) as Key)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">{t("saver.lights")}</span>
          <select className="input" value={shared.saverLights ?? "scene"} disabled={!!busy} onChange={(event) => void commitDisplays({ saverLights: event.currentTarget.value as Screens["saverLights"] })}>
            {(["scene", "same", "off"] as const).map((value) => <option key={value} value={value}>{t(("saver.lights." + value) as Key)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">{t("screens.after")}</span>
          <select className="input" value={shared.blankAfterMinutes} disabled={!!busy} onChange={(event) => void commitDisplays({ blankAfterMinutes: Number(event.currentTarget.value) })}>
            {choices([0, 5, 10, 15, 30, 60], shared.blankAfterMinutes).map((minutes) =>
              <option key={minutes} value={minutes}>{minutes ? t("screens.minutes", { count: minutes }) : t("screens.never")}</option>)}
          </select>
        </label>
      </details>
    </div>
  );
}

export function ProfilePanel({ view, onClose }: { view: EngineView; onClose: () => void }) {
  useLanguage();
  const profile = view.profile;
  const state = view.state;
  const [draft, setDraft] = useState<Profile | null>(profile);
  const writes = useRef(Promise.resolve());
  const [apps, setApps] = useState("");
  const known = useApps(view.state?.foreground);
  const [issues, setIssues] = useState<{ control: string; message: string }[]>([]);
  useEffect(() => {
    let current = true;
    if (profile?.id) api.checkProfile(profile.id).then((next) => { if (current) setIssues(next); }, () => { if (current) setIssues([]); });
    return () => { current = false; };
  }, [profile?.id, profile]);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setDraft(profile);
    setApps(profile?.apps.join(", ") ?? "");
  }, [profile?.id]);
  if (!profile || !draft || !state) return null;
  const commit = (patch: Partial<Pick<Profile, "name" | "apps" | "panel">>) => {
    setDraft((current) => current && { ...current, ...patch });
    writes.current = writes.current.then(async () => {
      const current = await api.profile(profile.id);
      await api.saveProfile({ ...current, ...patch });
    }).catch((e) => { setMessage(localizeError(String(e))); });
  };
  const exportFile = async (json = false) => {
    await writes.current;
    const path = await exportProfileFile({ id: profile.id, name: draft.name }, json);
    if (path) setMessage(t("profile.savedTo", { path }));
  };
  const showError = (err: unknown) => setMessage(localizeError(String(err)));
  const isFallback = state.fallback === profile.id;
  return (
    <aside className="inspector sectioned side-panel">
      <PanelHead title={t("topbar.profileSettings")} crumb={draft.name || profile.name} icon="layers" onClose={onClose} />
      <section className="sec">
        <div className="field">
          <label htmlFor="profile-name" className="label">
            {t("profile.name")}
          </label>
          <input id="profile-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onBlur={() => {
            const name = draft.name.trim() || profile.name;
            if (name !== profile.name) commit({ name });
            else setDraft({ ...draft, name });
          }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        </div>
        <AppLinks
          apps={known}
          value={draft.apps}
          foreground={state.foreground}
          onChange={(next) => {
            setApps(next.join(", "));
            commit({ apps: next });
          }}
        />
        <details className="field">
          <summary className="label">{t("profile.appsAdvanced")}</summary>
          <input
            id="profile-apps"
            className="input mono"
            placeholder="obs64.exe, chrome.exe: YouTube"
            value={apps}
            onChange={(e) => setApps(e.target.value)}
            onBlur={() => {
              const next = apps.split(",").map((app) => app.trim()).filter(Boolean);
              if (next.join(", ") !== draft.apps.join(", ")) commit({ apps: next });
            }}
          />
          <p className="help">{t("profile.appsHelp")}</p>
        </details>
      </section>
      <section className="sec">
        <h3 className="sec-title">{t("profile.switching")}</h3>
        {/* only what belongs to this profile; the switches for every profile are in Settings > Profiles */}
        <label className="check">
          <input type="checkbox" checked={isFallback} disabled={isFallback} onChange={() => api.settings({ fallback: profile.id }).catch(showError)} />
          {t("profile.fallback")}
        </label>
        <p className="help">{t("profile.switchingWhere")}</p>
      </section>
      <section className="sec">
        <h3 className="sec-title">{t("profile.transfer")}</h3>
        <p className="help">{t("profile.transferHelp")}</p>
        <div className="btn-grid">
          <button className="tool" onClick={() => void exportFile().catch(showError)}><Icon name="download" />{t("profile.export")}</button>
          <button className="tool" onClick={() => void importProfileFile().then((p) => {
            if (p) setMessage(movedNote(p.moved, p.pages) || t("profile.imported", { name: p.name }));
          }, showError)}><Icon name="upload" />{t("profile.import")}</button>
        </div>
      </section>
      <details className="sec profile-details">
        <summary>{t("profile.panel")}</summary>
        <select
          id="panel-content"
          aria-label={t("profile.panel")}
          className="input"
          value={draft.panel?.kind ?? "keys"}
          onChange={async (e) => {
            const kind = e.target.value;
            if (kind === "keys") return commit({ panel: undefined });
            if (kind === "clock") return commit({ panel: { kind: "clock" } });
            if (kind === "graph") return commit({ panel: { kind: "graph", metric: "cpu" } });
            const image = await pickImage().catch((err) => (setMessage(String(err)), null));
            if (image) commit({ panel: { kind: "picture", image } });
          }}
        >
          <option value="keys">{t("profile.panelKeys")}</option>
          <option value="picture">{t("profile.panelPicture")}</option>
          <option value="clock">{t("profile.panelClock")}</option>
          <option value="graph">{t("profile.panelGraph")}</option>
        </select>
        {draft.panel?.kind === "graph" && (
          <select className="input" aria-label={t("profile.panelGraph")} value={draft.panel.metric} onChange={(e) => commit({ panel: { kind: "graph", metric: e.target.value as Metric } })}>
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {t(`metric.${m}`)}
              </option>
            ))}
          </select>
        )}
        {draft.panel?.kind === "picture" && (
          <button className="tool align-start" onClick={() => pickImage().then((image) => image && commit({ panel: { kind: "picture", image } }), showError)}>
            <Icon name="image" />
            {t("look.changePicture")}
          </button>
        )}
        <p className="help">{t("profile.panelHelp")}</p>
      </details>
      {issues.length > 0 && (
        <details className="sec profile-details">
          <summary>{t("profile.checkTitle")} ({issues.length})</summary>
          {issues.map((i) => (
            <p key={`${i.control}${i.message}`} className="help">
              <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#f5c518", marginRight: 6 }} />
              <b>{controlLabel(i.control, draft.pages)}</b> {localizeError(i.message)}
            </p>
          ))}
          <p className="help">{t("profile.checkHelp")}</p>
        </details>
      )}
      <details className="sec profile-details">
        <summary>{t("profile.manage")}</summary>
        <div className="btn-grid">
          <button className="tool" title={t("suggest.fillHelp")} onClick={() => api.profileFill(profile.id, view.state?.page ?? null).catch(showError)}>
            <Icon name="sparkles" />
            {t("suggest.fill")}
          </button>
          <button className="tool" onClick={() => writes.current.then(() => api.createProfile(t("profile.copyName", { name: draft.name }), profile.id)).then((p) => api.activate(p.id)).catch(showError)}>
            <Icon name="copy" />
            {t("profile.duplicate")}
          </button>
          <button className="tool" onClick={() => void exportFile(true).catch(showError)}>
            <Icon name="download" />{t("profile.fileTypeJson")}
          </button>
          <button
            className="tool"
            title={t("profile.adaptHelp")}
            onClick={() =>
              api.adaptProfile(profile.id).then(
                (moved) => {
                  setMessage(movedNote(moved, profile.pages) || t("profile.adaptNothing"));
                  // the panel keeps a draft of the whole profile: take the adapted one
                  if (moved.length) api.profile(profile.id).then(setDraft, () => {});
                },
                (e) => setMessage(String(e)),
              )
            }
          >
            <Icon name="layout-grid" />
            {t("profile.adapt")}
          </button>
          <button
            className="tool danger"
            disabled={state.profiles.length <= 1}
            onClick={() => {
              void confirmed(t("profile.confirmDelete", { name: profile.name })).then((yes) => yes && api.deleteProfile(profile.id).catch((e) => setMessage(String(e))));
            }}
          >
            <Icon name="trash" />
            {t("profile.delete")}
          </button>
        </div>
      </details>
      {message && <p className="sec help" role="status">{message}</p>}
    </aside>
  );
}

/** Settings of the whole app: language, look, screens, profiles folder, backups, connections, updates, help, about. */
export type SettingsSection = "general" | "text" | "connections" | "plugins" | "backups" | "updates" | "diagnostics";

const SETTINGS_SECTIONS: { id: SettingsSection; icon: string; label: Key }[] = [
  { id: "general", icon: "settings", label: "settings.general" },
  // the font of the deck's text, like Stream Deck's Style tab (owner's pick 2a, 2026-10-18)
  { id: "text", icon: "type", label: "settings.text" },
  { id: "connections", icon: "link", label: "settings.connections" },
  { id: "plugins", icon: "plug", label: "topbar.plugins" },
  { id: "backups", icon: "archive", label: "settings.backups" },
  { id: "updates", icon: "download", label: "updates.title" },
  // check one module (owner, 2026-11-02, after a faders user's light stuck red)
  { id: "diagnostics", icon: "gauge", label: "diag.title" },
];

/** Settings as a page of its own over the whole window (owner, 2026-10-13: a panel in the right
 *  column covered the key editor): sections on the left, one section's content on the right. */
export function SettingsPanel({ live, view, section, updateCheckRequest, onSection, onClose, onBrowsePlugins, onPickPlugin, onPhone, onUsePlugin }: {
  live: LiveState;
  view: EngineView;
  section: SettingsSection;
  updateCheckRequest: number;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  onBrowsePlugins: () => void;
  onPickPlugin: (update?: { id: string; name: string }) => void;
  onPhone: () => void;
  onUsePlugin: (id: string) => void;
}) {
  useLanguage();
  return (
    <div className="settings-page">
      <header className="settings-head">
        <button className="tool ghost" onClick={onClose}>
          <Icon name="chevron-left" />
          {t("settings.back")}
        </button>
        <h2>{t("settings.title")}</h2>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          {SETTINGS_SECTIONS.map((x) => (
            <button key={x.id} className={`settings-nav-item${x.id === section ? " is-active" : ""}`} aria-current={x.id === section ? "page" : undefined} onClick={() => onSection(x.id)}>
              <Icon name={x.icon} />
              {t(x.label)}
            </button>
          ))}
        </nav>
        <div className="settings-content sectioned" key={section}>
          {section === "general" && (
            <>
              <LanguageSettings />
              <Appearance />
              <SwitchingSettings view={view} />
              <StartupSettings />
              <ProfilesFolder />
            </>
          )}
          {section === "text" && <DeckTextSettings />}
          {section === "connections" && <Connections />}
          {section === "plugins" && <PluginsList onBrowse={onBrowsePlugins} onPickFile={onPickPlugin} onPhone={onPhone} onUse={onUsePlugin} />}
          {section === "backups" && <Backups />}
          {section === "updates" && <UpdatesSettings checkRequest={updateCheckRequest} />}
          {section === "diagnostics" && <DiagnosticsSettings live={live} />}
        </div>
      </div>
    </div>
  );
}

export type DeckDisplaySection = "lights" | "screens" | "edge" | "music" | "saver";

export function DeckDisplayPanel({ live, view, section, setSection, onClose, onCalibrate, onOpenScenes }: {
  live: LiveState;
  view: EngineView;
  section: DeckDisplaySection;
  setSection: (section: DeckDisplaySection) => void;
  onClose: () => void;
  onCalibrate: () => void;
  onOpenScenes: () => void;
}) {
  const lighting = section === "lights" || section === "edge" || section === "music";
  const lightDetail = () => setSection("lights");
  return (
    <aside className="deck-display-panel sectioned" aria-label={t("settings.lightsScreens")}>
      <PanelHead title={t("settings.lightsScreens")} icon="sun" onClose={onClose} />
      <nav className="seg display-tabs" aria-label={t("settings.lightsScreens")}>
        <button type="button" className={`tab${lighting ? " is-active" : ""}`} aria-pressed={lighting} onClick={lightDetail}>{t("settings.lighting")}</button>
        <button type="button" className={`tab${section === "screens" ? " is-active" : ""}`} aria-pressed={section === "screens"} onClick={() => setSection("screens")}>{t("settings.screens")}</button>
        <button type="button" className={`tab${section === "saver" ? " is-active" : ""}`} aria-pressed={section === "saver"} onClick={() => setSection("saver")}>{t("saver.title")}</button>
      </nav>
      <div className="display-controls">
        {section === "lights" && <LightsSettings onOpenEdge={() => setSection("edge")} onOpenScenes={onOpenScenes} onOpenMusic={() => setSection("music")} />}
        {section === "edge" && <EdgePanel key={view.profile?.id} view={view} onClose={lightDetail} onAll={lightDetail} />}
        {section === "music" && <MusicPanel onClose={lightDetail} />}
        {section === "saver" && <SaverPanel key={view.profile?.id} view={view} />}
        {section === "screens" && (
          <>
            <ScreensSettings />
            <section className="sec btn-grid">
              <button className="tool" onClick={() => setSection("saver")}><Icon name="moon" />{t("screens.saver")}</button>
              {live.deck.modules.some((m) => m.kind === "keys") && (
                <button className="tool" title={t("settings.calibrateHelp")} onClick={onCalibrate}><Icon name="crosshair" />{t("topbar.calibrate")}</button>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

/** Starting with the system: the same switch as the tray's (issue #10: only the tray had it). */
function StartupSettings() {
  useLanguage();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.autostart().then(setOn, () => {});
  }, []);
  if (on === null) return null;
  const mac = navigator.userAgent.includes("Mac");
  return (
    <section className="sec">
      <h3 className="sec-title">{t("startup.title")}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setError("");
            api.autostartSet(e.target.checked).then(setOn, (err) => setError(String(err)));
          }}
        />
        {t(mac ? "startup.mac" : "startup.windows")}
      </label>
      <p className="help">{error || t("startup.help")}</p>
    </section>
  );
}

/** How the deck switches profiles, for every profile. */
function SwitchingSettings({ view }: { view: EngineView }) {
  useLanguage();
  const state = view.state;
  if (!state) return null;
  return (
    <section className="sec">
      <h3 className="sec-title">{t("settings.profiles")}</h3>
      <label className="check">
        <input type="checkbox" checked={state.autoSwitch} onChange={(e) => api.settings({ autoSwitch: e.target.checked })} />
        {t("switching.main")}
      </label>
      {/* one switch on top, the rest folded (owner's pick 10a) */}
      <details className="more-opts">
        <summary>{t("switching.more")}</summary>
        <label className="check">
          <input type="checkbox" checked={state.autoProfiles ?? true} onChange={(e) => api.autoSet(e.target.checked)} />
          {t("auto.setting")}
        </label>
        <label className="check" title={t("call.settingHelp")}>
          <input type="checkbox" checked={state.callSwitch ?? true} onChange={(e) => api.callSwitchSet(e.target.checked)} />
          {t("call.setting")}
        </label>
        <p className="help">{t("profile.homeHelp")}</p>
      </details>
      <p className="help">{t("switching.example")}</p>
    </section>
  );
}

/** System, dark or light. */
function LightsSettings({ onOpenEdge, onOpenScenes, onOpenMusic }: { onOpenEdge: () => void; onOpenScenes: () => void; onOpenMusic: () => void }) {
  useLanguage();
  const [l, setL] = useState<LightSettings | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<LightSettings | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(Promise.resolve());
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    saving.current = saving.current.then(() => api.setLights(next)).then(() => { setError(""); }, (e) => { setError(String(e)); });
  }, []);
  useEffect(() => {
    let active = true;
    api.lights().then((value) => { if (active) setL(value); }, (e) => { if (active) setError(String(e)); });
    return () => { active = false; flush(); };
  }, [flush]);
  if (!l) return error ? <p className="sec help" role="alert">{error}</p> : null;
  const save = (next: LightSettings, delay = 0) => {
    setL(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    if (delay) timer.current = window.setTimeout(flush, delay);
    else flush();
  };
  const reactions: [keyof LightSettings["react"] & ("mic" | "live" | "agents" | "timer" | "call"), Key][] = [
    ["call", "lights.reactCall"],
    ["mic", "lights.reactMic"],
    ["live", "lights.reactLive"],
    ["agents", "lights.reactAgents"],
    ["timer", "lights.reactTimer"],
  ];
  return (
    <section className="sec lighting-controls">
      <div className="lighting-row">
        <label htmlFor="lights-mode">{t("lights.style")}</label>
        <div className="row wrap">
        <select id="lights-mode" className="input" value={l.style} onChange={(e) => save({ ...l, style: e.target.value })}>
          <option value="rainbow">{t("lights.rainbow")}</option>
          <option value="color">{t("lights.oneColor")}</option>
          <option value="profile">{t("lights.profileColor")}</option>
          <option value="music">{t("lights.music")}</option>
          <option value="off">{t("lights.off")}</option>
        </select>
        {l.style === "color" && (
          <label className="color">
            <input type="color" value={l.color} aria-label={t("look.color")} onChange={(e) => save({ ...l, color: e.target.value }, 120)} />
          </label>
        )}
        </div>
      </div>
      <div className="lighting-row">
      <label htmlFor="lights-brightness" title={t("lights.brightness")}>
        {t("lighting.ledBrightness")}
      </label>
      <div className="lighting-range">
      <input
        id="lights-brightness"
        className="range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={l.brightness}
        style={{ "--fill": `${l.brightness}%` } as React.CSSProperties}
        onChange={(e) => save({ ...l, brightness: Number(e.target.value) }, 120)}
      />
      <output htmlFor="lights-brightness" className="mono">{l.brightness}%</output>
      </div>
      </div>
      <div className="lighting-destinations">
        <button type="button" className="tool" onClick={onOpenScenes}><Icon name="image" />{t("lighting.scenes")}</button>
        <button type="button" className="tool" onClick={onOpenEdge}><Icon name="sun" />{t("lighting.profileEdge")}</button>
        <button type="button" className="tool" onClick={onOpenMusic}><Icon name="music" />{t("music.chip")}</button>
      </div>
      <details className="lighting-advanced">
        <summary>{t("lighting.reactions")}</summary>
      {l.style === "rainbow" && (
        <label className="check" title={t("lights.hubRainbowHelp")}>
          <input type="checkbox" checked={l.hubRainbow ?? true} onChange={(e) => save({ ...l, hubRainbow: e.target.checked })} />
          {t("lights.hubRainbow")}
        </label>
      )}
      <div className="label">{t("lights.reactTo")}</div>
      {reactions.map(([key, label]) => (
        <div className="row between" key={key}>
          <label className="check">
            <input type="checkbox" checked={l.react[key].on} onChange={(e) => save({ ...l, react: { ...l.react, [key]: { ...l.react[key], on: e.target.checked } } })} />
            {t(label)}
          </label>
          <label className="color">
            <input
              type="color"
              value={l.react[key].color}
              aria-label={t("look.color")}
              onChange={(e) => save({ ...l, react: { ...l.react, [key]: { ...l.react[key], color: e.target.value } } }, 120)}
            />
          </label>
        </div>
      ))}
      <label className="check">
        <input type="checkbox" checked={l.react.levels} onChange={(e) => save({ ...l, react: { ...l.react, levels: e.target.checked } })} />
        {t("lights.reactLevels")}
      </label>
      </details>
      {error && <p className="help" role="alert">{error}</p>}
    </section>
  );
}

/** English, Polish, or a language file of the user's own (`languages/` in the data folder), and
 * the way to make one: every English text in `template.json` (Discussions #3, 2026-10-18). */
function LanguageSettings() {
  const { lang, setLanguage } = useLanguage();
  const [files, setFiles] = useState<{ code: string; name: string }[]>([]);
  const [message, setMessage] = useState("");
  const refresh = () => api.languages().then(setFiles, () => {});
  useEffect(() => {
    refresh();
    // a file added while the window is open shows when it comes back to the front
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const pick = (code: string) => {
    setMessage("");
    if (code === "en" || code === "pl") return setLanguage(code);
    const builtIn = BUILT_IN_LANGUAGES[code];
    (builtIn ? builtIn.load() : api.languageFile(code)).then(
      (file) => setLanguage(code, file),
      (e) => setMessage(localizeError(String(e))),
    );
  };
  const makeTemplate = async () => {
    setMessage("");
    try {
      const [catalog, presets, games] = await Promise.all([api.catalog(), api.presets(), api.games().catch(() => [])]);
      const path = await api.languageTemplate(languageTemplate(catalog.actions, presets, games));
      setMessage(t("language.templateMade", { path }));
    } catch (e) {
      setMessage(localizeError(String(e)));
    }
  };
  return (
    <section className="sec">
      <h3 className="sec-title">{t("topbar.language")}</h3>
      <select id="language" aria-label={t("topbar.language")} className="input" value={lang} onChange={(e) => pick(e.target.value)}>
        <option value="en">English</option>
        <option value="pl">Polski</option>
        {Object.entries(BUILT_IN_LANGUAGES).map(([code, l]) => (
          <option key={code} value={code}>
            {l.name}
          </option>
        ))}
        {files.filter((f) => !BUILT_IN_LANGUAGES[f.code]).map((f) => (
          <option key={f.code} value={f.code}>
            {f.name}
          </option>
        ))}
        {/* a file picked before and gone now: the window is in English, the list says so */}
        {lang !== "en" && lang !== "pl" && !BUILT_IN_LANGUAGES[lang] && !files.some((f) => f.code === lang) && <option value={lang}>{lang}</option>}
      </select>
      <p className="help">{t("language.filesHelp")}</p>
      <div className="row wrap">
        <button className="tool align-start" onClick={makeTemplate}>
          <Icon name="file-plus" />
          {t("language.makeFile")}
        </button>
        <button className="tool align-start" onClick={() => api.languagesOpenFolder().catch((e) => setMessage(String(e)))}>
          <Icon name="folder-open" />
          {t("language.openFolder")}
        </button>
      </div>
      {message && <p className="help">{message}</p>}
    </section>
  );
}

function Appearance() {
  useLanguage();
  const theme = useTheme();
  const options: [Theme, Key][] = [
    ["system", "theme.system"],
    ["dark", "theme.dark"],
    ["light", "theme.light"],
  ];
  return (
    <section className="sec">
      <h3 className="sec-title">{t("settings.appearance")}</h3>
      <div className="seg full" role="radiogroup" aria-label={t("settings.appearance")}>
        {options.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={theme === value} className={`tab${theme === value ? " is-active" : ""}`} onClick={() => setTheme(value)}>
            {t(label)}
          </button>
        ))}
      </div>
      <p className="help">{t("theme.help")}</p>
    </section>
  );
}

/** What a found update says, with the one button that installs it. */
function UpdateCard({ info }: { info: UpdateInfo }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="update-card">
      <div className="row">
        <span className="ph-icon small">
          <Icon name="sparkles" />
        </span>
        <div className="grow">
          <b>{t("updates.available", { version: info.version })}</b>
          {info.date && <div className="help mono">{info.date.slice(0, 10)}</div>}
        </div>
      </div>
      {info.notes && <div className="notes">{info.notes}</div>}
      <button
        className="tool primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          updates.install(info.version).catch((e) => (setError(String(e)), setBusy(false)));
        }}
      >
        <Icon name="download" />
        {busy ? t("updates.installing") : t("updates.install")}
      </button>
      {error && <p className="help">{error}</p>}
    </div>
  );
}

/** Look for a new version at start or now; install only on request. */
function UpdatesSettings({ checkRequest }: { checkRequest: number }) {
  useLanguage();
  const version = useAppVersion();
  const [cfg, setCfg] = useState<[boolean, boolean, boolean] | null>(null);
  const [result, setResult] = useState<"checking" | "latest" | UpdateInfo | { error: string } | null>(null);
  const [manualCheck, setManualCheck] = useState(0);
  useEffect(() => {
    updates.settings().then(setCfg, () => setCfg([false, false, false]));
  }, []);
  const canCheck = cfg?.[0] === true;
  useEffect(() => {
    if (!canCheck || (checkRequest === 0 && manualCheck === 0)) return;
    let cancelled = false;
    setResult("checking");
    updates.check().then(
      (info) => { if (!cancelled) setResult(info ?? "latest"); },
      (error) => { if (!cancelled) setResult({ error: String(error) }); },
    );
    return () => { cancelled = true; };
  }, [canCheck, checkRequest, manualCheck]);
  if (!cfg) return <p className="help" role="status">{t("app.loadingPanel")}</p>;
  const [enabled, atStart, notify] = cfg;
  // a build without updates: say so, no switch and button that cannot work
  if (!enabled)
    return (
      <section className="sec">
        <h3 className="sec-title">{t("updates.title")}</h3>
        {version && <p className="help">MasterDeck {version}</p>}
        <p className="help">{t("updates.notSetUp")}</p>
      </section>
    );
  return (
    <section className="sec">
      <h3 className="sec-title">{t("updates.title")}</h3>
      {version && <p className="help">MasterDeck {version}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={atStart}
          disabled={!enabled}
          onChange={(e) => {
            setCfg([enabled, e.target.checked, notify]);
            updates.setCheckAtStart(e.target.checked).catch(() => {});
          }}
        />
        {t("updates.atStart")}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={notify}
          disabled={!enabled || !atStart}
          onChange={(e) => {
            setCfg([enabled, atStart, e.target.checked]);
            updates.setNotify(e.target.checked).catch(() => {});
          }}
        />
        {t("updates.notify")}
      </label>
      <div className="row wrap">
        <button
          className="tool"
          disabled={!enabled || result === "checking"}
          onClick={() => setManualCheck((n) => n + 1)}
        >
          <Icon name="refresh-cw" />
          {result === "checking" ? t("updates.checking") : t("updates.checkNow")}
        </button>
        {result === "latest" && (
          <span className="pill is-ok" role="status">{t("updates.latest")}</span>
        )}
      </div>
      {result && typeof result === "object" && "version" in result && <UpdateCard info={result} />}
      {result && typeof result === "object" && "error" in result && <p className="help" role="alert" title={result.error}>{t("updates.checkFailed")}</p>}
      <p className="help">{enabled ? t("updates.help") : t("updates.notSetUp")}</p>
      <GoBack />
    </section>
  );
}

/** After an update that broke something: back to the version before, signed like any update,
 *  the profiles backed up first (owner's pick, 2026-10-16; PAIN-POINTS RD1). */
function GoBack() {
  useLanguage();
  const [previous, setPrevious] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<"idle" | "going" | { error: string }>("idle");
  useEffect(() => {
    updates.previous().then(setPrevious, () => setPrevious(null));
  }, []);
  if (!previous) return null;
  return (
    <div className="field go-back">
      <span className="label">{t("updates.backTitle")}</span>
      <p className="help">{t("updates.backHelp", { version: previous.version })}</p>
      <button
        className="tool align-start"
        disabled={state === "going"}
        onClick={async () => {
          if (!(await askInWindow({ title: t("updates.backConfirm", { version: previous.version }), ok: t("confirm.goBack") }))) return;
          setState("going");
          updates.rollback(previous.version).catch((e) => setState({ error: String(e) }));
        }}
      >
        <Icon name="chevron-left" />
        {state === "going" ? t("updates.going") : t("updates.goBack", { version: previous.version })}
      </button>
      {typeof state === "object" && <p className="help">{state.error}</p>}
    </div>
  );
}

/** The shared profiles gallery (repo `hubdeck-profiles`) is not online yet: its entry stays hidden. */
/** macOS: without Accessibility, shortcuts and typed text from the deck do nothing; say so and
 *  lead to the switch. Checked again every few seconds until it is on. */
function AccessibilityBanner() {
  useLanguage();
  const [ok, setOk] = useState(true);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let live = true;
    const check = () => api.accessibilityOk().then((v) => live && setOk(v !== false), () => {});
    check();
    const timer = window.setInterval(check, 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  if (ok) return null;
  return (
    <div className="banner is-info" role="status">
      <Icon name="keyboard" />
      <span className="grow">{t("access.banner")}</span>
      <button className="tool small" onClick={() => api.accessibilityAsk().catch(() => {})}>
        {t("access.allow")}
      </button>
    </div>
  );
}

/** After MasterDeck ended without quitting (a crash, Task Manager): when, and the details to copy. */
function CrashBanner() {
  useLanguage();
  const [report, setReport] = useState<CrashReport | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.crashReport().then(setReport, () => setReport(null));
  }, []);
  if (!report) return null;
  const at = report.at.slice(11, 16);
  const details = [`MasterDeck ended without quitting at ${report.at}${report.restarted ? " (started again by its guard)" : ""}.`, report.panic ?? "", "", ...report.log].join("\n");
  return (
    <div className="banner is-warn" role="status">
      <Icon name="alert" />
      <span className="grow">{t(report.restarted ? "crash.back" : "crash.stopped", { at })}</span>
      <button className="tool small" onClick={() => navigator.clipboard.writeText(details).then(() => setCopied(true), () => {})}>
        <Icon name="copy" />
        {copied ? t("crash.copied") : t("crash.copy")}
      </button>
      <button className="tool small" onClick={() => (api.crashSeen(), setReport(null))}>
        {t("crash.ok")}
      </button>
    </div>
  );
}

/** A timer that ran out says where it is and stops from here (a timer on another page or profile
 * only lights the base's edge; owner, 2026-10-16). */
function RingingBanner({ view }: { view: EngineView }) {
  useLanguage();
  const ringing = view.state?.ringing ?? [];
  return (
    <>
      {ringing.map((r) => {
        const name = r.label ?? t("ringing.timer");
        const page = r.page && view.profile?.id === r.profile ? (view.profile.pages?.find((p) => p.id === r.page)?.name ?? r.page) : r.page;
        const where = r.profile !== view.state?.active ? t("ringing.onProfile", { profile: r.profileName }) : page ? t("ringing.onPage", { page }) : "";
        return (
          <div key={`${r.profile}/${r.control}`} className="banner is-warn" role="alert">
            <Icon name="timer" />
            <span className="grow">{t("ringing.text", { name, where })}</span>
            <button className="tool small primary" onClick={() => api.timerStop(r.profile, r.control).catch(() => {})}>
              {t("ringing.stop")}
            </button>
          </div>
        );
      })}
    </>
  );
}

function UpdateBanner() {
  useLanguage();
  const [info, dismiss] = useUpdateAvailable();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info) return null;
  return (
    <>
      <div className="banner is-info" role="status">
        <Icon name="sparkles" />
        <span className="grow">
          {t("updates.available", { version: info.version })}
          {error && <span className="banner-note"> ({error})</span>}
        </span>
        {info.notes && (
          <button className="tool ghost small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {t("updates.whatsNew")}
          </button>
        )}
        <button
          className="tool small primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            updates.install(info.version).catch((e) => (setError(String(e)), setBusy(false)));
          }}
        >
          <Icon name="download" />
          {busy ? t("updates.installing") : t("updates.install")}
        </button>
        <button className="icon-btn" aria-label={t("updates.later")} title={t("updates.later")} onClick={dismiss}>
          <Icon name="x" />
        </button>
      </div>
      {open && <div className="banner-notes">{info.notes}</div>}
    </>
  );
}

const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** Restart a wedged module's USB device (Windows, with a UAC prompt); reseating always works. */
function Unresponsive({ kind }: { kind: string }) {
  useLanguage();
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  const name = ["base", "keys", "faders", "knobs", "rollers", "dial"].includes(kind) ? moduleName(kind as ModuleKind) : kind;
  return (
    <div className="banner is-warn" role="alert">
      <Icon name="alert" />
      <span className="grow">
        {t(IS_WINDOWS ? "banner.unresponsiveWin" : "banner.unresponsive", { name })}
        {state !== "idle" && state !== "busy" && <span className="banner-note"> ({state})</span>}
      </span>
      {IS_WINDOWS && (
        <button
          className="tool small"
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            api.restartModule(kind).then(
              () => setState(t("banner.restarted")),
              (e) => setState(String(e)),
            );
          }}
        >
          <Icon name="refresh-cw" />
          {state === "busy" ? t("banner.restarting") : t("banner.restart")}
        </button>
      )}
    </div>
  );
}

const TURNS: (number | null)[] = [null, 0, 90, 180, 270];

/** How the base lies on the desk. The sensor only tells "turned right" (90°) from the rest. */
/** The right column while arranging modules: what to check and how to finish (no key editor). */
export function ArrangePanel({ onDone, live, saved, onPlace }: { onDone: () => void; live: LiveState; saved: Record<string, Placement>; onPlace: (key: string, placement: Placement | null) => void }) {
  useLanguage();
  return (
    <aside className="inspector sectioned side-panel">
      <PanelHead title={t("stage.editLayout")} icon="layout-grid" />
      <section className="sec">
        <p className="help">{t("app.hintArranging")}</p>
        <button className="tool primary align-start" onClick={onDone}>
          <Icon name="check" />
          {t("stage.doneLayout")}
        </button>
      </section>
      {/* modules owned but not attached: set up before they are on the base (from the old welcome) */}
      <section className="sec">
        <h3 className="sec-title">{t("welcome.ownedTitle")}</h3>
        <p className="help">{t("welcome.owned")}</p>
        <OwnedKinds live={live} saved={saved} onPlace={onPlace} />
      </section>
    </aside>
  );
}

export function BaseTurnPicker({ live }: { live: LiveState }) {
  useLanguage();
  const { turnOverride, orientation } = live.deck;
  const sensed = orientation === "vertical" ? t("turn.standing") : orientation === "horizontal" ? t("turn.lying") : t("turn.noSensor");
  return (
    <div className="row wrap turn-picker" role="group" aria-label={t("turn.group")}>
      <span className="muted small">{t("turn.label")}</span>
      {TURNS.map((turn) => {
        const label = turn === null ? t("turn.auto") : `${turn}°`;
        return (
          <button key={String(turn)} className={`tool small${turnOverride === turn ? " is-active" : ""}`} onClick={() => api.setBaseTurn(turn)} title={turn === null ? t("turn.follow", { sensed }) : t("turn.always", { turn: label })}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Arrange mode: share the modules the user placed by hand (slot, position, turn) on a GitHub issue
 * form, so slots not yet verified on hardware get right for everyone. Nothing else goes along.
 */
export function PageBar({ view }: { view: EngineView }) {
  useLanguage();
  const profile = view.profile;
  const current = view.state?.page ?? null;
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  if (!profile) return null;
  const pages = profile.pages ?? [];
  const currentPage = pages.find((p) => p.id === current);
  const submit = () => {
    if (!naming) return;
    const name = naming.name.trim();
    const editing = naming;
    setNaming(null);
    if (!name) return;
    api.renamePage(profile.id, editing.id, name).catch((e) => told(t("pages.title"), String(e)));
  };
  return (
    <nav
      className="page-bar row wrap"
      aria-label={t("pages.title")}
      // the tabs may scroll sideways (narrow window): the mouse wheel moves them
      onWheel={(e) => {
        if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      <span className="label">{t("pages.keys")}</span>
      <span className="seg">
        <button className={`tab${current === null ? " is-active" : ""}`} onClick={() => api.setPage(null)}>
          {t("pages.main")}
        </button>
        {pages.map((p) => (
          <button key={p.id} className={`tab${current === p.id ? " is-active" : ""}`} onClick={() => api.setPage(p.id)}>
            {p.name}
          </button>
        ))}
      </span>
      {naming ? (
        <form onSubmit={(e) => (e.preventDefault(), submit())}>
          <input className="input tab-input" autoFocus placeholder={t("pages.name")} value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} onBlur={submit} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setNaming(null); } }} />
        </form>
      ) : (
        <button className="tab icon-only" aria-label={t("pages.new")} title={t("pages.newHelp")} onClick={() => void api.createPage(profile.id, "", t("pages.autoName", { n: "{n}" })).then((p) => api.setPage(p.id)).catch((e) => told(t("pages.title"), String(e)))}>
          <Icon name="plus" />
        </button>
      )}
      {currentPage && !naming && (
        <>
          {!pageReachable(profile, currentPage.id) && (
            <span className="page-warn row">
              <Icon name="alert" />
              {t("pages.unreachable")}
              <button className="tool small" title={t("pages.addWayHelp")} onClick={() => api.addWayToPage(profile.id, currentPage.id).catch((e) => told(t("error.addWay"), localizeError(String(e))))}>
                {t("pages.addWay")}
              </button>
            </span>
          )}
          <button className="tool ghost small" onClick={() => setNaming({ id: currentPage.id, name: currentPage.name })}>
            {t("pages.rename")}
          </button>
          <button
            className="tool danger small"
            onClick={() => {
              void confirmed(t("pages.confirmDelete", { name: currentPage.name })).then((yes) => yes && api.deletePage(profile.id, currentPage.id).catch((e) => console.error(e)));
            }}
          >
            {t("pages.delete")}
          </button>
        </>
      )}
    </nav>
  );
}

/** Brightness of the key panel and the dial, and when they turn off. */
function ScreensSettings() {
  useLanguage();
  const [s, setS] = useState<Screens | null>(null);
  useEffect(() => {
    api.screens().then(setS, () => {});
  }, []);
  if (!s) return null;
  const save = (next: Screens) => {
    setS(next);
    setPreviewSalt(`${next.appIcons ?? ""}|${next.deckFont ?? ""}`);
    api.setScreens(next).catch(() => {});
  };
  return (
    <section className="sec">
      <div className="field">
        <div className="row between">
          <label htmlFor="screen-brightness" className="label">
            {t("settings.brightness")}
          </label>
          <span className="mono value">{s.brightness}%</span>
        </div>
        <input id="screen-brightness" className="range" type="range" min={5} max={100} step={5} value={s.brightness} style={{ "--fill": `${((s.brightness - 5) / 95) * 100}%` } as React.CSSProperties} onChange={(e) => save({ ...s, brightness: Number(e.target.value) })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={s.blankWhenLocked} onChange={(e) => save({ ...s, blankWhenLocked: e.target.checked })} />
        {t("screens.locked")}
      </label>
      <div className="field">
        <label htmlFor="blank-after" className="label">
          {t("screens.after")}
        </label>
        <select id="blank-after" className="input" value={s.blankAfterMinutes} onChange={(e) => save({ ...s, blankAfterMinutes: Number(e.target.value) })}>
          {[0, 5, 10, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? t("screens.never") : t("screens.minutes", { count: m })}
            </option>
          ))}
        </select>
      </div>
      <p className="help">{t("screens.help")}</p>
      <div className="field">
        <label htmlFor="app-icons" className="label">
          {t("screens.appIcons")}
        </label>
        <select id="app-icons" className="input" value={s.appIcons ?? "icon"} onChange={(e) => save({ ...s, appIcons: e.target.value as Screens["appIcons"] })}>
          <option value="icon">{t("screens.appIconsIcon")}</option>
          <option value="fill">{t("screens.appIconsFill")}</option>
          <option value="fillLabel">{t("screens.appIconsFillLabel")}</option>
        </select>
        <p className="help">{t("screens.appIconsHelp")}</p>
      </div>
    </section>
  );
}

/** The font of the text on the keys and the dial, any font on this computer (Discussions #3, owner's
 * pick 2a, 2026-10-18: a section of its own, as Stream Deck's Style tab), with a few labels in it. */
function DeckTextSettings() {
  useLanguage();
  const [s, setS] = useState<Screens | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    api.screens().then(setS, () => {});
    api.deckFonts().then(setFonts, () => {});
  }, []);
  if (!s) return null;
  const save = (next: Screens) => {
    setS(next);
    setPreviewSalt(`${next.appIcons ?? ""}|${next.deckFont ?? ""}`);
    api.setScreens(next).catch(() => {});
  };
  const family = s.deckFont ? `"${s.deckFont}", "IBM Plex Sans", sans-serif` : `"IBM Plex Sans", sans-serif`;
  return (
    <section className="sec">
      <h3 className="sec-title">{t("settings.text")}</h3>
      <div className="field">
        <label htmlFor="deck-font" className="label">
          {t("screens.font")}
        </label>
        <select id="deck-font" className="input" value={s.deckFont ?? ""} onChange={(e) => save({ ...s, deckFont: e.target.value })}>
          <option value="">{t("screens.fontOwn")}</option>
          {fonts
            .filter((f) => f !== "IBM Plex Sans")
            .map((f) => (
              <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
                {f}
              </option>
            ))}
        </select>
        <p className="help">{t("screens.fontHelp")}</p>
      </div>
      {/* how labels read in it, Japanese too */}
      <div className="font-sample" aria-label={t("screens.fontSample")} style={{ fontFamily: family }}>
        {["Mute", "Next track", "ミュート", "配信開始", "Żółw 42"].map((label) => (
          <span key={label} className="font-key">
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Where the profiles are kept: the app's own folder, or a shared one (OneDrive, Dropbox...). */
function ProfilesFolder() {
  useLanguage();
  const [dir, setDir] = useState<[string, boolean] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => api.profilesDir().then(setDir, () => {});
  useEffect(() => {
    load();
  }, []);
  if (!dir) return null;
  const change = (next: string | null) =>
    api.setProfilesDir(next).then(
      () => (setMessage(t("folder.changed")), load()),
      (e) => setMessage(String(e)),
    );
  return (
    <section className="sec">
      <h3 className="sec-title">{t("folder.title")}</h3>
      <div className="pathbox" title={dir[0]}>
        <Icon name="folder" />
        <span className="mono">{dir[0]}</span>
      </div>
      <div className="row wrap">
        <button
          className="tool"
          onClick={async () => {
            const picked = await open({ directory: true, multiple: false });
            if (typeof picked === "string") change(picked);
          }}
        >
          <Icon name="folder-open" />
          {t("folder.choose")}
        </button>
        {dir[1] && (
          <button className="tool ghost" onClick={() => change(null)}>
            {t("folder.default")}
          </button>
        )}
      </div>
      <p className="help">{message ?? t("folder.help")}</p>
    </section>
  );
}

/** Copies of all profiles and settings: made daily and before risky changes; restore any. */
function Backups() {
  useLanguage();
  const [list, setList] = useState<{ id: string; when: string; reason: string; profiles: number }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const load = () => api.backups().then(setList, () => {});
  useEffect(() => {
    load();
  }, []);
  const reasons: Record<string, string> = { daily: t("backups.daily"), "before import": t("backups.beforeImport"), "before delete": t("backups.beforeDelete"), "before restore": t("backups.beforeRestore"), "by hand": t("backups.byHand") };
  return (
    <section className="sec">
      <div className="sec-head">
        <h3 className="sec-title">{t("settings.backups")}</h3>
        <button className="tool ghost small" onClick={() => api.backupNow().then(() => (setMessage(t("backups.made")), load()), (e) => setMessage(String(e)))}>
          <Icon name="archive" />
          {t("backups.now")}
        </button>
      </div>
      <p className="help">{t("backups.help")}</p>
      {list.length > 0 && (
        <ul className="rows">
          {(all ? list : list.slice(0, 5)).map((b) => (
            <li key={b.id} className="row-item">
              <span className="row-ic">
                <Icon name="archive" />
              </span>
              <span className="grow row-text">
                <span className="mono">{b.when}</span>
                <small>
                  {reasons[b.reason] ?? b.reason} · {t("backups.profiles", { count: b.profiles })}
                </small>
              </span>
              <button
                className="tool ghost small"
                onClick={async () => {
                  if (await askInWindow({ title: t("backups.confirm", { when: b.when }), ok: t("confirm.putBack") }))
                    api.restoreBackup(b.id).then(
                      () => (setMessage(t("backups.restored")), load()),
                      (e) => setMessage(String(e)),
                    );
                }}
              >
                {t("backups.restore")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 5 && (
        <button className="tool ghost small align-start" onClick={() => setAll((a) => !a)}>
          {all ? t("backups.fewer") : t("backups.all", { count: list.length })}
        </button>
      )}
      {message && <p className="help">{message}</p>}
    </section>
  );
}

/** One connected service: a row with its state that opens to its fields. */
function Service({ icon, hue, name, state, open, children }: { icon: string; hue: string; name: string; state: [ok: boolean, text: string]; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="svc" open={open}>
      <summary>
        <span className="svc-ic" style={{ "--h": hue } as React.CSSProperties}>
          <Icon name={icon} />
        </span>
        <span className="grow svc-name">{name}</span>
        <span className={`pill${state[0] ? " is-ok" : ""}`}>{state[1]}</span>
        <Icon name="chevron-down" className="svc-chev" />
      </summary>
      <div className="svc-body">{children}</div>
    </details>
  );
}

/** Connections shared by every profile. Passwords and tokens go to the system credential store. */
function Connections() {
  useLanguage();
  return (
    <section className="sec">
      <h3 className="sec-title">{t("settings.connections")}</h3>
      <div className="svc-list">
        <ObsConnection />
        <StreamlabsConnection />
        <TwitchConnection />
        <HomeAssistantConnection />
        <SpotifyConnection />
        <ClaudeConnection />
        <AssistantConnection />
        <YourApps />
      </div>
    </section>
  );
}

/** Your own apps (docs/APP-CONTRACT.md): MasterDeck listens to their state; keys show it. */
function YourApps() {
  useLanguage();
  const [state, setState] = useState<AppsState | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => api.appsState().then(setState, () => {});
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);
  const apps = state?.apps ?? [];
  const items = (id: string) => Object.entries(state?.states ?? {}).filter(([k]) => k.startsWith(`${id}.`));
  const add = () => {
    setBusy(true);
    setMessage(null);
    api.appConnect(url.trim()).then(
      (a) => (setMessage(t("apps.added", { name: a.name, id: a.id })), setUrl(""), setBusy(false), load()),
      (e) => (setMessage(String(e)), setBusy(false)),
    );
  };
  const copyPrompt = () =>
    api
      .appContractPrompt()
      .then((p) => navigator.clipboard.writeText(p))
      .then(() => setMessage(t("apps.promptCopied")), (e) => setMessage(String(e)));
  return (
    <Service icon="app-window" hue="#3b82f6" name={t("apps.title")} state={[apps.length > 0, apps.length ? t("apps.count", { count: apps.length }) : t("connections.stateOff")]}>
      <p className="help">{t("apps.help")}</p>
      {apps.map((a) => {
        const list = items(a.id);
        const waiting = list.filter(([, i]) => i.state === "waiting").length;
        return (
          <div key={a.id} className="row wrap app-row">
            <span className="grow">
              <b>{a.name}</b> <span className="help mono">{a.id}.*</span>
              <br />
              <span className="help">{list.length ? t("apps.items", { count: list.length, waiting }) : t("apps.noItems")}</span>
            </span>
            <button className="icon-btn" title={t("apps.remove")} aria-label={t("apps.remove")} onClick={() => api.appRemove(a.id).then(load, () => {})}>
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      <div className="field">
        <label htmlFor="app-url" className="label">
          {t("apps.address")}
        </label>
        <div className="row">
          <input id="app-url" className="input mono grow" placeholder="http://127.0.0.1:4317/hubdeck/manifest" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="tool primary" disabled={busy || !url.trim()} onClick={add}>
            {t("apps.add")}
          </button>
        </div>
      </div>
      <button className="link-btn align-start" onClick={copyPrompt}>
        {t("apps.copyPrompt")}
      </button>
      {message && <p className="help">{message}</p>}
    </Service>
  );
}

function ObsConnection() {
  useLanguage();
  const [url, setUrl] = useState("");
  const [passwordSet, setPasswordSet] = useState(false);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api.integrations().then((i) => {
      setUrl(i.obsUrl);
      setPasswordSet(i.obsPasswordSet);
    }, () => {});
  }, []);
  return (
    <Service icon="video" hue="#f0506e" name="OBS Studio" state={[passwordSet, passwordSet ? t("connections.stateSet") : t("connections.stateNotSet")]} open={demoParam("svc") === "obs"}>
      <div className="field">
        <label htmlFor="obs-url" className="label">
          {t("connections.obsUrl")}
        </label>
        <input id="obs-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="obs-password" className="label">
          {t("connections.obsPassword")}
        </label>
        <input
          id="obs-password"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={passwordSet ? t("connections.passwordKept") : t("connections.passwordNone")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="row wrap">
        <button
          className="tool"
          onClick={() =>
            api.setIntegrations(url, password ? password : null).then(
              () => {
                if (password) setPasswordSet(true);
                setPassword("");
                setMessage(t("connections.saved"));
              },
              (e) => setMessage(String(e)),
            )
          }
        >
          {t("connections.save")}
        </button>
        {passwordSet && (
          <button
            className="tool ghost"
            onClick={() =>
              api.setIntegrations(url, "").then(
                () => {
                  setPasswordSet(false);
                  setMessage(t("connections.passwordRemoved"));
                },
                (e) => setMessage(String(e)),
              )
            }
          >
            {t("connections.removePassword")}
          </button>
        )}
      </div>
      <p className="help">{message ?? t("connections.obsHelp")}</p>
    </Service>
  );
}

/** Claude Code: MasterDeck's hooks in ~/.claude/settings.json, so session keys show each session's state. */
function ClaudeConnection() {
  useLanguage();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [approve, setApprove] = useState(false);
  useEffect(() => {
    invoke<boolean>("claude_status").then((v) => setOn(!!v), () => {});
    invoke<boolean>("claude_approving").then((v) => setApprove(!!v), () => {});
  }, []);
  return (
    <Service icon="bot" hue="#d97757" name="Claude Code" state={[on, on ? t("connections.stateConnected") : t("connections.stateOff")]}>
      <div className="row wrap">
        <button
          className={`tool${on ? " ghost" : ""}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            invoke<boolean>("claude_connect", { on: !on }).then(
              (v) => (setOn(!!v), setBusy(false)),
              (e) => (setMessage(String(e)), setBusy(false)),
            );
          }}
        >
          <Icon name="link" />
          {on ? t("connections.claudeDisconnect") : t("connections.claudeConnect")}
        </button>
      </div>
      {on && (
        <label className="check" title={t("connections.claudeApproveHelp")}>
          <input
            type="checkbox"
            checked={approve}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked;
              setBusy(true);
              invoke<boolean>("claude_connect", { on: true, approve: next }).then(
                () => (setApprove(next), setBusy(false)),
                (err) => (setMessage(String(err)), setBusy(false)),
              );
            }}
          />
          {t("connections.claudeApprove")}
        </label>
      )}
      <p className="help">{message ?? t("connections.claudeHelp")}</p>
    </Service>
  );
}

/** What `mcp_info` tells about connecting an AI assistant (`engine/mcp.rs`). */
interface McpInfo {
  exe: string;
  desktop: boolean;
  codeCli: boolean;
  codeCommand: string;
  deckCommand?: string;
  snippet: string;
}

/** The user's own AI assistant builds profiles through `hubdeck --mcp` (docs/MCP.md). */
function AssistantConnection() {
  useLanguage();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => invoke<McpInfo>("mcp_info").then(setInfo, () => {});
  useEffect(() => {
    load();
  }, []);
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setMessage(t("connections.mcpCopied")), (e) => setMessage(String(e)));
  const run = (job: Promise<string>) => {
    setBusy(true);
    setMessage(null);
    job.then(
      (m) => (setMessage(m), setBusy(false), load()),
      (e) => (setMessage(String(e)), setBusy(false)),
    );
  };
  return (
    <Service icon="sparkles" hue="#8b7cf6" name={t("connections.mcpName")} state={[!!info?.desktop, info?.desktop ? t("connections.mcpDesktopOn") : t("connections.stateOff")]}>
      <div className="row wrap">
        <button
          className="tool"
          disabled={busy || !info}
          onClick={() => run(invoke<string | null>("mcp_connect_desktop").then((backup) => t("connections.mcpDesktopDone", { backup: backup ?? "-" })))}
        >
          <Icon name="link" />
          {t("connections.mcpDesktop")}
        </button>
        <button
          className="tool"
          disabled={busy || !info}
          onClick={() => (info?.codeCli ? run(invoke<string>("mcp_connect_code").then(() => t("connections.mcpCodeDone"))) : info && copy(info.codeCommand))}
        >
          <Icon name={info?.codeCli ? "link" : "copy"} />
          {info?.codeCli ? t("connections.mcpCode") : t("connections.mcpCodeCopy")}
        </button>
        <button className="tool ghost" disabled={!info} onClick={() => info && copy(info.snippet)}>
          <Icon name="copy" />
          {t("connections.mcpSnippet")}
        </button>
        <button className="tool ghost" disabled={!info?.deckCommand} title={t("connections.mcpDeckHelp")} onClick={() => info?.deckCommand && copy(info.deckCommand)}>
          <Icon name="copy" />
          {t("connections.mcpDeck")}
        </button>
      </div>
      <p className="help">{message ?? t("connections.mcpHelp")}</p>
    </Service>
  );
}

/** Where Spotify sends the browser back after the sign-in (spotify.rs `REDIRECT`). */
const SPOTIFY_REDIRECT = "http://127.0.0.1:43123/callback";

/**
 * Spotify needs an app of the user's own (Spotify gives apps for everyone only to companies), so
 * the setup is walked in four steps with the link and the address to copy (owner's 1a, 2026-10-19,
 * as Essentials for Spotify guides it); once connected, who it is and whether they have Premium.
 */
function SpotifyConnection() {
  useLanguage();
  const [clientId, setClientId] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.spotifyStatus().then(([id, ok]) => (setClientId(id), setConnected(ok)), () => {});
  }, []);
  const copyRedirect = () =>
    navigator.clipboard.writeText(SPOTIFY_REDIRECT).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1600)),
      (e) => setMessage(String(e)),
    );
  const connect = () => {
    setBusy(true);
    setMessage(t("connections.spotifyWaiting"));
    api.spotifyConnect(clientId).then(
      (a) => {
        setConnected(true);
        setBusy(false);
        const who = a.name ? t("connections.spotifyAs", { name: a.name }) : t("connections.spotifyConnected");
        setMessage(a.premium === false ? `${who} ${t("connections.spotifyNoPremium")}` : who);
      },
      (e) => (setMessage(String(e)), setBusy(false)),
    );
  };
  const button = (
    <button className="tool" disabled={busy || clientId.trim().length < 16} onClick={connect}>
      <Icon name="link" />
      {connected ? t("connections.spotifyReconnect") : t("connections.spotifyConnect")}
    </button>
  );
  const steps = (
    <div className="steps spotify-steps">
      <div className="step">
        <div className="step-head">
          <span className="step-n">1</span>
          <span className="grow">{t("connections.spotifyStep1")}</span>
        </div>
        <button className="tool ghost align-start" onClick={() => api.openLink("https://developer.spotify.com/dashboard")}>
          <Icon name="globe" />
          {t("connections.spotifyOpenDashboard")}
        </button>
      </div>
      <div className="step">
        <div className="step-head">
          <span className="step-n">2</span>
          <span className="grow">{t("connections.spotifyStep2")}</span>
        </div>
      </div>
      <div className="step">
        <div className="step-head">
          <span className="step-n">3</span>
          <span className="grow">{t("connections.spotifyStep3")}</span>
        </div>
        <div className="row">
          <code className="input mono grow spotify-uri">{SPOTIFY_REDIRECT}</code>
          <button className="tool ghost" onClick={copyRedirect}>
            <Icon name={copied ? "check" : "copy"} />
            {copied ? t("connections.mcpCopied") : t("connections.spotifyCopy")}
          </button>
        </div>
      </div>
      <div className="step">
        <div className="step-head">
          <span className="step-n">4</span>
          <label htmlFor="spotify-id" className="grow">
            {t("connections.spotifyStep4")}
          </label>
        </div>
        <input id="spotify-id" className="input mono" placeholder={t("connections.spotifyIdPlaceholder")} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <div className="row wrap">{button}</div>
      </div>
    </div>
  );
  return (
    <Service icon="music" hue="#1ed760" name="Spotify" state={[connected, connected ? t("connections.stateConnected") : t("connections.stateOff")]}>
      {connected ? (
        <>
          <div className="row wrap">
            {button}
            <button className="tool ghost" onClick={() => api.spotifyDisconnect().then(() => (setConnected(false), setMessage(null)))}>
              {t("connections.spotifyDisconnect")}
            </button>
          </div>
          {message && <p className="help">{message}</p>}
          <details className="spotify-how">
            <summary className="help">{t("connections.spotifyHowAgain")}</summary>
            {steps}
          </details>
        </>
      ) : (
        <>
          <p className="help">{t("connections.spotifyWhy")}</p>
          {steps}
          {message && <p className="help">{message}</p>}
        </>
      )}
    </Service>
  );
}

function TwitchConnection() {
  useLanguage();
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api.twitchStatus().then(([ok, signedIn]) => (setAvailable(ok), setConnected(signedIn)), () => {});
  }, []);
  // a build without a Twitch app id cannot connect: not shown at all
  if (!available) return null;
  return (
    <Service icon="twitch" hue="#a970ff" name={t("connections.twitch")} state={[connected, connected ? t("connections.stateConnected") : available ? t("connections.stateOff") : t("connections.stateUnavailable")]}>
      <div className="row wrap">
        <button
          className="tool"
          disabled={busy || !available}
          onClick={() => {
            setBusy(true);
            setMessage(t("connections.twitchWaiting"));
            api.twitchConnect().then(
              () => (setConnected(true), setMessage(t("connections.twitchConnected")), setBusy(false)),
              (e) => (setMessage(String(e)), setBusy(false)),
            );
          }}
        >
          <Icon name="link" />
          {connected ? t("connections.spotifyReconnect") : t("connections.twitchConnect")}
        </button>
        {connected && (
          <button className="tool ghost" onClick={() => api.twitchDisconnect().then(() => (setConnected(false), setMessage(null)))}>
            {t("connections.spotifyDisconnect")}
          </button>
        )}
      </div>
      <p className="help">{message ?? (available ? t("connections.twitchHelp") : t("connections.twitchNotSetUp"))}</p>
    </Service>
  );
}

function StreamlabsConnection() {
  useLanguage();
  const [url, setUrl] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api.integrations().then((i) => {
      setUrl(i.streamlabsUrl);
      setTokenSet(i.streamlabsTokenSet);
    }, () => {});
  }, []);
  const save = (tok: string | null) =>
    api.setStreamlabs(url, tok).then(
      () => {
        if (tok !== null) setTokenSet(tok !== "");
        setToken("");
        setMessage(t("connections.saved"));
      },
      (e) => setMessage(String(e)),
    );
  return (
    <Service icon="radio" hue="#80f5d2" name="Streamlabs Desktop" state={[tokenSet, tokenSet ? t("connections.stateSet") : t("connections.stateOff")]}>
      <div className="field">
        <label htmlFor="sl-url" className="label">
          {t("connections.streamlabsUrl")}
        </label>
        <input id="sl-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="sl-token" className="label">
          {t("connections.streamlabsToken")}
        </label>
        <input
          id="sl-token"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={tokenSet ? t("connections.passwordKept") : t("connections.tokenNone")}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="row wrap">
        <button className="tool" onClick={() => save(token ? token : null)}>
          {t("connections.save")}
        </button>
        {tokenSet && (
          <button className="tool ghost" onClick={() => save("")}>
            {t("connections.removeToken")}
          </button>
        )}
      </div>
      <p className="help">{message ?? t("connections.streamlabsHelp")}</p>
    </Service>
  );
}

function HomeAssistantConnection() {
  useLanguage();
  const [url, setUrl] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api.integrations().then((i) => {
      setUrl(i.haUrl);
      setTokenSet(i.haTokenSet);
    }, () => {});
  }, []);
  const save = (tok: string | null) =>
    api.setHomeAssistant(url, tok).then(
      () => {
        if (tok !== null) setTokenSet(tok !== "");
        setToken("");
        setMessage(t("connections.saved"));
      },
      (e) => setMessage(String(e)),
    );
  return (
    <Service icon="home" hue="#41bdf5" name="Home Assistant" state={[tokenSet && !!url, tokenSet && url ? t("connections.stateSet") : t("connections.stateOff")]}>
      <div className="field">
        <label htmlFor="ha-url" className="label">
          {t("connections.haUrl")}
        </label>
        <input id="ha-url" className="input mono" placeholder="http://homeassistant.local:8123" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ha-token" className="label">
          {t("connections.haToken")}
        </label>
        <input
          id="ha-token"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={tokenSet ? t("connections.passwordKept") : t("connections.tokenNone")}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="row wrap">
        <button className="tool" onClick={() => save(token ? token : null)}>
          {t("connections.save")}
        </button>
        {tokenSet && (
          <button className="tool ghost" onClick={() => save("")}>
            {t("connections.removeToken")}
          </button>
        )}
      </div>
      <p className="help">{message ?? t("connections.haHelp")}</p>
    </Service>
  );
}

/** The games the deck can play, with the best scores. */
export function GamesPanel({ view, onClose }: { view: EngineView; onClose: () => void }) {
  useLanguage();
  const [games, setGames] = useState<GameSummary[]>([]);
  const playing = !!view.state?.playing;
  useEffect(() => {
    api.games().then(setGames, () => {});
  }, [playing]);
  return (
    <aside className="inspector">
      <div className="row">
        <h2 className="grow">{t("games.title")}</h2>
        <button className="tool" onClick={onClose}>
          {t("profile.close")}
        </button>
      </div>
      <p className="muted small">{t("games.help")}</p>
      <button className={`tool${playing ? "" : " is-active"}`} onClick={() => api.playGames(!playing)}>
        {playing ? t("games.stop") : t("games.play")}
      </button>
      <ul className="plugin-list">
        {games.map((g) => {
          const icon = view.icons.find((i) => i.name === g.icon);
          return (
            <li key={g.id} className="plugin-item">
              <div className="row">
                {icon && <img className="game-icon" src={`data:image/svg+xml;utf8,${encodeURIComponent(icon.svg.replace(/currentColor/g, "#c4b5fd"))}`} alt="" />}
                <strong className="grow">{localizeGame(g.id, "name", g.name)}</strong>
                <span className="muted small">{g.best !== null ? t("games.best", { score: g.best }) : t("games.noBest")}</span>
              </div>
              <div className="muted small">{localizeGame(g.id, "about", g.about)}</div>
            </li>
          );
        })}
      </ul>
      <WheelChoices />
      <p className="muted small">{t("games.key")}</p>
    </aside>
  );
}

/** The wheel's fields, one per line. */
function WheelChoices() {
  useLanguage();
  const [text, setText] = useState("");
  useEffect(() => {
    api.wheel().then((c) => setText(c.join("\n")), () => {});
  }, []);
  return (
    <div className="field">
      <label htmlFor="wheel-choices" className="label">
        {t("games.wheel")}
      </label>
      <textarea
        id="wheel-choices"
        className="input"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => api.setWheel(text.split("\n")).then((c) => setText(c.join("\n")), () => {})}
      />
      <div className="muted small">{t("games.wheelHelp")}</div>
    </div>
  );
}

/** Installed plugins, foreground operations, and local sources. */
function PluginsList({ onBrowse, onPickFile, onPhone, onUse }: {
  onBrowse: () => void;
  onPickFile: (update?: { id: string; name: string }) => void;
  onPhone: () => void;
  onUse: (id: string) => void;
}) {
  useLanguage();
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => api.plugins().then((rows) => {
    setPlugins([...rows].sort((a, b) => a.name.localeCompare(b.name)));
  }), []);
  useEffect(() => {
    const load = () => refresh().catch(() => {});
    refresh().catch((e) => setError(localizeError(String(e))));
    const off = listen("engine://catalog", load);
    const timer = window.setInterval(load, 2000);
    return () => { window.clearInterval(timer); void off.then((unlisten) => unlisten(), () => {}); };
  }, [refresh]);
  const run = async (plugin: PluginInfo, change: () => Promise<unknown>) => {
    setBusy(plugin.id);
    setError(null);
    try {
      await change();
      await refresh();
    } catch (e) {
      setError(localizeError(String(e)));
    } finally {
      setBusy(null);
    }
  };
  const sourceLabels = {
    manual: "plugins.sourceManual",
    marketplace: "plugins.sourceMarket",
    streamDeck: "plugins.sourceStreamDeck",
    existing: "plugins.sourceExisting",
  } as const;

  return (
    <>
      <section className="sec plugin-manager">
        <div className="plugin-manager-head">
          <div><h3>{t("plugins.installedTitle")}</h3><p className="help">{t("plugins.installedIntro")}</p></div>
          <button type="button" className="tool primary" onClick={() => onPickFile()}><Icon name="upload" />{t("plugins.installFile")}</button>
        </div>
        <div className="row wrap plugin-manager-links">
          <button type="button" className="tool" onClick={onPhone}><Icon name="upload" />{t("phone.title")}</button>
          <button type="button" className="tool" onClick={onBrowse}><Icon name="search" />{t("plugins.browse")}</button>
          <button type="button" className="tool ghost" onClick={() => api.openPluginsFolder().catch((e) => setError(localizeError(String(e))))}><Icon name="folder-open" />{t("plugins.openFolder")}</button>
        </div>
        {error && <p className="help plugin-feedback" role="alert">{error}</p>}
        {plugins === null && !error && <p className="help" role="status">{t("plugins.loadingInstalled")}</p>}
        {plugins?.length === 0 && <p className="plugin-manager-empty">{t("plugins.none")} <span>{t("plugins.noneManualHelp")}</span></p>}
        {!!plugins?.length && (
          <ul className="installed-plugins">
            {plugins.map((plugin) => {
              const isBusy = busy === plugin.id;
              const source = plugin.source ?? "existing";
              return (
                <li key={plugin.id} className="installed-plugin">
                  <div className="installed-plugin-title">
                    <span className="installed-plugin-icon"><Icon name="plug" /></span>
                    <div className="grow">
                      <strong>{plugin.name}</strong>
                      <span className="meta">
                        {t(sourceLabels[source])}
                        {plugin.version && <span> · {t("plugins.version", { version: plugin.version })}</span>}
                        <span> · {t("plugins.actions", { count: plugin.actions })}</span>
                      </span>
                    </div>
                    <span className={plugin.connected ? "pill is-ok" : "pill"}>{t(plugin.held ? "plugins.disabled" : plugin.connected ? "plugins.running" : "plugins.enabled")}</span>
                  </div>
                  {!plugin.held && !plugin.connected && <p className="help plugin-runtime">{localizeError(plugin.status)}</p>}
                  <div className="row wrap installed-plugin-tools">
                    {plugin.held ? (
                      <button className="tool small" disabled={busy !== null} onClick={() => run(plugin, () => api.pluginStart(plugin.id))}><Icon name="play" />{t("plugins.enable")}</button>
                    ) : (
                      <>
                        <button className="tool small" disabled={busy !== null} onClick={() => onUse(plugin.id)}><Icon name="chevron-right" />{t("plugins.useActions")}</button>
                        <button className="tool small ghost" disabled={busy !== null} onClick={() => run(plugin, () => api.pluginStop(plugin.id))}>{t("plugins.disable")}</button>
                        {!plugin.connected && <button className="tool small ghost" disabled={busy !== null} onClick={() => run(plugin, () => api.pluginStart(plugin.id))}>{t("plugins.start")}</button>}
                      </>
                    )}
                    {(source === "manual" || source === "existing") &&
                      <button className="tool small ghost" disabled={busy !== null} onClick={() => onPickFile(plugin)}><Icon name="upload" />{t("plugins.updateFile")}</button>
                    }
                    <button className="tool small ghost" disabled={busy !== null} onClick={() => run(plugin, () => askUninstall(plugin))}><Icon name="trash" />{t("plugins.uninstall")}</button>
                    {isBusy && <span className="help" role="status">{t("plugins.working")}</span>}
                  </div>
                  <details className="installed-plugin-details">
                    <summary>{t("plugins.details")}</summary>
                    <div className="meta">
                      <span className="mono">{plugin.id}</span>
                      {plugin.cpu !== null && <span>CPU {plugin.cpu.toFixed(1)}%</span>}
                      {plugin.memoryMb !== null && <span>{plugin.memoryMb} MB</span>}
                      {plugin.restarts > 0 && <span>{t("plugins.restarts", { count: plugin.restarts })}</span>}
                      {plugin.cpu !== null && plugin.cpu > 20 && <span className="pill is-warn">{t("plugins.busy")}</span>}
                      {plugin.permissions.length > 0 && <span>{t("plugins.uses")} {plugin.permissions.join(", ")}</span>}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <SdFromStreamDeck installed={new Set(plugins?.map((p) => p.id))} onInstalled={() => void refresh().catch((e) => setError(localizeError(String(e))))} />
    </>
  );
}

/** The plugins Elgato's Stream Deck app installed on this computer, each used here with one click
 * (a copy; files Elgato encrypted for its app say so). Nothing shows without the Stream Deck app. */
function SdFromStreamDeck({ installed, onInstalled }: { installed: Set<string>; onInstalled: () => void }) {
  useLanguage();
  const [list, setList] = useState<LocalPlugin[]>([]);
  const [state, setState] = useState<Record<string, "installing" | string>>({});
  useEffect(() => {
    api.sdStreamDeck().then(setList, () => {});
  }, []);
  if (list.length === 0) return null;
  // Elgato's encrypted ones cannot run here: one line says how many, so none seems lost (owner's
  // 5a, 2026-10-18: "pokażmy te które są dostępne")
  const locked = (p: LocalPlugin) => !!p.problem && /encrypted/i.test(p.problem) && !installed.has(p.id);
  const lockedCount = list.filter(locked).length;
  const use = (p: LocalPlugin) => {
    setState((s) => ({ ...s, [p.id]: "installing" }));
    api.sdImport(p.id).then(
      () => (setState((s) => ({ ...s, [p.id]: "" })), onInstalled()),
      (e) => setState((s) => ({ ...s, [p.id]: localizeError(String(e)) })),
    );
  };
  return (
    <section className="sec">
      <h3 className="sec-title">{t("plugins.fromSd")}</h3>
      <p className="help">{t("plugins.fromSdHelp")}</p>
      <ul className="cards">
        {list.filter((p) => !locked(p)).map((p) => {
          const s = state[p.id];
          return (
            <li key={p.id} className="card catalog-item">
              {p.icon ? <img className="catalog-icon" src={p.icon} alt="" /> : <span className="catalog-icon" />}
              <div className="grow">
                <div className="row">
                  <strong className="grow">{p.name}</strong>
                  {installed.has(p.id) ? (
                    <span className="pill is-ok">{t("plugins.isInstalled")}</span>
                  ) : p.problem ? (
                    <span className="pill">{t("plugins.cannotRun")}</span>
                  ) : (
                    <button className="tool small" disabled={s === "installing"} onClick={() => use(p)}>
                      <Icon name="download" />
                      {s === "installing" ? t("plugins.installing") : t("plugins.use")}
                    </button>
                  )}
                </div>
                {p.problem && !installed.has(p.id) && <div className="help">{localizeError(p.problem)}</div>}
                <div className="meta">
                  {p.author && <span>{t("plugins.byAuthor", { author: p.author })}</span>}
                  {p.version && <span>{t("plugins.version", { version: p.version })}</span>}
                </div>
                {s && s !== "installing" && <div className="help catalog-err">{s}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {lockedCount > 0 && <p className="help">{t("plugins.locked", { count: lockedCount })}</p>}
    </section>
  );
}

/** A picker, drop, or file association all lead to the same preview and consent. */
export function PluginFileSheet({ path, update, onClose, onManage, onUse }: {
  path: string;
  update?: { id: string; name: string };
  onClose: () => void;
  onManage: () => void;
  onUse: (id: string) => void;
}) {
  useLanguage();
  const [plugin, setPlugin] = useState<LocalPlugin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"installing" | "enabling" | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const file = path.split(/[\\/]/).pop() ?? path;
  const wrongPlugin = plugin?.id && update && plugin.id !== update.id;
  const problem = plugin?.problem || (wrongPlugin ? t("plugins.wrongFile", { name: update.name }) : null);
  const replacing = plugin?.installedVersion != null;

  useEffect(() => {
    let current = true;
    api.sdPeek(path).then(
      (result) => { if (current) setPlugin(result); },
      (e) => { if (current) setError(localizeError(String(e))); },
    );
    return () => { current = false; };
  }, [path]);

  const install = async () => {
    if (!plugin?.digest || problem || busy) return;
    setBusy("installing");
    setError(null);
    try {
      setInstalled(await api.sdInstall(path, plugin.digest, plugin.id));
    } catch (e) {
      setError(localizeError(String(e)));
    } finally {
      setBusy(null);
    }
  };
  const enable = async () => {
    if (!installed || busy) return;
    setBusy("enabling");
    setError(null);
    try {
      await api.pluginStart(installed);
      setEnabled(true);
    } catch (e) {
      setError(localizeError(String(e)));
    } finally {
      setBusy(null);
    }
  };
  const manage = () => { onClose(); onManage(); };

  return (
    <Sheet label={t("plugins.reviewTitle")} onClose={() => { if (!busy) onClose(); }}>
      <aside className="inspector sectioned plugin-file" aria-busy={!!busy}>
        <PanelHead title={t("plugins.reviewTitle")} icon="plug" onClose={busy ? undefined : onClose} />
        <section className="sec">
          <p className="help plugin-filename">{file}</p>
          {!plugin && !error && <p className="help" role="status">{t("plugins.fileReading")}</p>}
          {plugin && !plugin.problem && (
            <div className="row plugin-preview-row">
              <span className="installed-plugin-icon">{plugin.icon ? <img className="catalog-icon" src={plugin.icon} alt="" /> : <Icon name="plug" />}</span>
              <div className="grow">
                <strong>{plugin.name}</strong>
                <div className="meta">
                  {plugin.author && <span>{t("plugins.byAuthor", { author: plugin.author })}</span>}
                  {plugin.version && <span>{t("plugins.version", { version: plugin.version })}</span>}
                  {plugin.actions !== undefined && <span>{t("plugins.actions", { count: plugin.actions })}</span>}
                </div>
              </div>
            </div>
          )}
          {replacing && !installed && !problem && <p className="help">{t("plugins.replaces", { version: plugin?.installedVersion || t("plugins.unknownVersion") })}</p>}
          {problem && <p className="help plugin-feedback" role="alert">{localizeError(problem)}</p>}
          {error && <p className="help plugin-feedback" role="alert">{error}</p>}
          {!problem && plugin && (
            <p className="help" role={busy || installed ? "status" : undefined}>
              {t(busy === "installing" ? "plugins.installing" : busy === "enabling" ? "plugins.enabling" : enabled ? "plugins.readyActions" : installed ? "plugins.installedDisabled" : "plugins.reviewTrust")}
            </p>
          )}
          <div className="row wrap plugin-review-controls">
            {installed ? (
              <>
                <button className="tool" disabled={!!busy} onClick={manage}>{t("plugins.installedTitle")}</button>
                {enabled ? <button className="tool primary" onClick={() => { onClose(); onUse(installed); }}>{t("plugins.useActions")}</button>
                  : <button className="tool primary" disabled={!!busy} onClick={enable}>{t("plugins.enable")}</button>}
              </>
            ) : (
              <>
                <button className="tool ghost" disabled={!!busy} onClick={onClose}>{t(problem || !plugin && error ? "profile.close" : "chooser.cancel")}</button>
                {plugin?.digest && !problem && <button className="tool primary" disabled={!!busy} onClick={install}><Icon name="download" />{t(replacing ? "plugins.applyUpdate" : "plugins.install")}</button>}
              </>
            )}
          </div>
        </section>
      </aside>
    </Sheet>
  );
}

function OwnedKinds({ live, saved, onPlace }: { live: LiveState; saved: Record<string, Placement>; onPlace: (key: string, placement: Placement | null) => void }) {
  const attached = new Set(live.deck.modules.map((m) => m.kind));
  return (
    <div className="owned-kinds" role="group" aria-label={t("welcome.ownedTitle")}>
      {MODULE_KINDS.map((kind) => {
        const isAttached = attached.has(kind);
        const owned = isAttached || keysOfKind(saved, kind).length > 0;
        return (
          <button
            key={kind}
            className="owned-kind"
            role="checkbox"
            aria-checked={owned}
            disabled={isAttached}
            onClick={() => (owned ? keysOfKind(saved, kind).forEach((k) => onPlace(k, null)) : onPlace(ownedKey(kind), { col: 0, row: 0, rotation: 0 }))}
          >
            <span className="owned-tick" aria-hidden="true">
              {owned && (
                <svg viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
            <ModuleThumb kind={kind} muted={!owned} />
            {t(`module.${kind}`)}
            {isAttached && <small>{t("welcome.attached")}</small>}
          </button>
        );
      })}
    </div>
  );
}

export function Banner({ live, view, onOpenProfiles, onOpenConnections }: { live: LiveState; view: EngineView; onOpenProfiles?: (ids: string[]) => void; onOpenConnections?: () => void }) {
  useLanguage();
  const made = (view.state?.autoMade ?? []).map((id) => view.state?.profiles.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const names = made.length > 4 ? `${made.slice(0, 4).join(", ")} +${made.length - 4}` : made.join(", ");
  return (
    <>
      <UpdateBanner />
      <RingingBanner view={view} />
      <CrashBanner />
      <AccessibilityBanner />
      {view.state?.interruptedTry && (
        // a restart in the middle of a try took the draft off the deck (owner, 2026-10-22)
        <div className="banner is-info" role="status">
          <Icon name="sparkles" />
          <span className="grow">{t("try.interrupted", { name: view.state.profiles.find((p) => p.id === view.state?.interruptedTry)?.name ?? "" })}</span>
          <button className="tool small" onClick={() => api.tryProfile(view.state?.interruptedTry ?? null)}>
            {t("try.putBack")}
          </button>
          <button className="tool small" onClick={() => api.settleDraft(view.state?.interruptedTry ?? "", true)}>
            {t("try.useThis")}
          </button>
          <button className="tool small" onClick={() => api.tryProfile(null)}>
            {t("try.dismiss")}
          </button>
        </div>
      )}
      {made.length > 0 && (
        <div className="banner is-info" role="status">
          <Icon name="sparkles" />
          <span className="grow">{t(made.length === 1 ? "auto.bannerOne" : "auto.banner", { names })}</span>
          {onOpenProfiles && (
            <button className="tool small" onClick={() => (onOpenProfiles(view.state?.autoMade ?? []), api.autoSeen())}>
              {t("auto.show")}
            </button>
          )}
          <button className="tool small" onClick={() => api.autoSeen()}>
            {t("auto.ok")}
          </button>
        </div>
      )}
      {(view.state?.appsJoined?.length ?? 0) > 0 && (
        <div className="banner is-info" role="status">
          <Icon name="link" />
          <span className="grow">{t("apps.joined", { names: view.state?.appsJoined?.join(", ") ?? "" })}</span>
          {onOpenConnections && (
            <button className="tool small" onClick={() => (onOpenConnections(), api.appsSeen())}>
              {t("auto.show")}
            </button>
          )}
          <button className="tool small" onClick={() => api.appsSeen()}>
            {t("auto.ok")}
          </button>
        </div>
      )}
      {view.state?.playing && (
        <div className="banner is-info" role="status">
          <Icon name="play" />
          <span className="grow">{t("games.banner")}</span>
          <button className="tool small" onClick={() => api.playGames(false)}>
            {t("games.stop")}
          </button>
        </div>
      )}
      {live.deck.paused && (
        <div className="banner is-info" role="status">
          <Icon name="pause" />
          <span className="grow">{t("banner.paused")}</span>
          <button className="tool small" onClick={() => api.pauseDeck(false)}>
            <Icon name="play" />
            {t("banner.resume")}
          </button>
        </div>
      )}
      {live.deck.unresponsive.map((kind) => (
        <Unresponsive key={kind} kind={kind} />
      ))}
      {view.error && (
        <div className="banner is-err" role="alert">
          <Icon name="alert" />
          <span className="grow">
            <b>{controlLabel(view.error.control)}</b> {localizeError(view.error.message)}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * An imported profile that runs commands, web requests or scripts: the user sees them and keeps it
 * or removes it before it is ever used (release audit, 2026-10-13). True = keep.
 */
export async function keepImported(p: Imported): Promise<boolean> {
  const runs = p.runs ?? [];
  if (!runs.length) return true;
  const list = runs.slice(0, 8).map((r) => `• ${r.length > 90 ? `${r.slice(0, 90)}…` : r}`).join("\n") + (runs.length > 8 ? `\n${t("import.runsMore", { count: runs.length - 8 })}` : "");
  const keep = await askInWindow({ title: t("import.runsTitle"), body: t("import.runsAsk", { name: p.name, list }), ok: t("import.keep"), cancel: t("import.remove") });
  if (!keep) await api.deleteProfile(p.id).catch(() => {});
  return keep;
}
