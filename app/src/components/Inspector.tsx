import { ToastMessage } from "./Notice";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { open } from "../confirm";
import { invoke } from "@tauri-apps/api/core";
import type { ControlRef } from "../deck";
import { KeyDesigner, type OtherKey } from "./KeyDesigner";
import { withLook } from "../editing";
import { themeTitle, ADVANCED_PARAMS, api, BACKGROUNDS, COMMON_SHORTCUTS, controlId, hasState, inWindow, newBinding, pressable, TURN_PARAMS, usePreview, type ActionDef, type Binding, type DialFace, type EngineView, type Gesture, type AppInfo, type InstalledItem, type Look, type Mode, type ParamDef, type Step, STEP_CONDITIONS } from "../engine";
import { actionName, localizeAction, specialKeyName, t, useLanguage, type Key } from "../i18n";
import { Icon } from "./Icon";
import { IconPicker } from "./IconPicker";
import { EffectFields, Sheet } from "./Panels";
import { ActionIcon } from "./ActionChooser";
import { ACTION_MIME } from "./DeckView";
import { demoParam } from "../demo/params";

// `?demo&gesture=hold` opens the hold tab of the selected control (screenshots)
const DEMO_GESTURE = demoParam("gesture") as Gesture | null;

/** Flush using the control and profile captured when the edit was made. */
function useDebouncedSave(save: (b: Binding | null) => Promise<void> | undefined) {
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<(() => Promise<void> | undefined) | null>(null);
  const saving = useRef<Promise<void> | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const write = pending.current;
    if (!write) return saving.current;
    pending.current = null;
    const result = saving.current ? saving.current.then(write) : write();
    saving.current = result;
    void result?.finally(() => {
      if (saving.current === result) saving.current = undefined;
    });
    return result;
  }, []);
  const schedule = (b: Binding | null, delay = 350) => {
    pending.current = () => save(b);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  };
  useEffect(() => () => { flush(); }, [flush]);
  const isPending = () => pending.current !== null;
  return { schedule, flush, isPending };
}

function keyName(e: React.KeyboardEvent): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null;
  const named: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Escape", Enter: "Enter" };
  if (named[k]) return named[k];
  if (/^F\d{1,2}$/.test(k)) return k;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

function HotkeyField({ value, onChange, specialKeys, onNamed }: { value: string; onChange: (v: string) => void; specialKeys: string[]; onNamed?: (keys: string, label: string, icon: string) => void }) {
  const [recording, setRecording] = useState(false);
  const common = COMMON_SHORTCUTS.map(([name, win, mac, icon]) => ({ name, keys: IS_MAC ? mac : win, icon })).filter((c) => c.keys);
  return (
    <div className="hotkey">
      <input
        className="input mono"
        value={recording ? t("hotkey.recording") : value}
        readOnly={recording}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          const key = keyName(e);
          if (!key) return;
          const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && (/Mac/i.test(navigator.platform) ? "Cmd" : "Win")].filter(Boolean);
          onChange([...mods, key].join("+"));
          setRecording(false);
        }}
        onBlur={() => setRecording(false)}
        placeholder={t("hotkey.placeholder")}
      />
      <button className="tool" onClick={(e) => (setRecording(true), (e.currentTarget.previousElementSibling as HTMLInputElement)?.focus())}>
        <Icon name="keyboard" />
        {t("hotkey.record")}
      </button>
      {onNamed && (
        <select
          className="input"
          value=""
          aria-label={t("hotkey.common")}
          onChange={(e) => {
            const c = common.find((x) => x.name === e.target.value);
            if (c?.keys) onNamed(c.keys, t(`shortcut.${c.name}` as Key), c.icon);
          }}
        >
          <option value="">{t("hotkey.common")}</option>
          {common.map((c) => (
            <option key={c.name} value={c.name}>
              {t(`shortcut.${c.name}` as Key)} ({c.keys})
            </option>
          ))}
        </select>
      )}
      <select className="input" value="" onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={t("hotkey.special")}>
        <option value="">{t("hotkey.specialPick")}</option>
        {specialKeys.map((k) => (
          <option key={k} value={k}>
            {specialKeyName(k)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A searchable list of the apps or games installed on this PC, with their icons; Refresh scans again. */
const SOURCE_NAMES: Record<string, string> = { steam: "Steam", epic: "Epic Games", gog: "GOG", store: "Microsoft Store" };

export function InstalledPicker({ games, onPick }: { games: boolean; onPick: (item: InstalledItem) => void }) {
  useLanguage();
  const [items, setItems] = useState<InstalledItem[] | null>(null);
  const [query, setQuery] = useState("");
  const load = (refresh: boolean) => {
    setItems(null);
    api.installed(refresh).then((all) => setItems(games ? all.games : all.apps), () => setItems([]));
  };
  useEffect(() => load(false), [games]);
  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q)).slice(0, 80);
  return (
    <div className="field">
      <div className="row">
        <input className="input grow" autoFocus placeholder={t(games ? "installed.searchGames" : "installed.searchApps")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="tool" title={t("installed.refresh")} onClick={() => load(true)}>
          <Icon name="refresh-cw" />
        </button>
      </div>
      <div className="menu-list" style={{ maxHeight: 260, overflowY: "auto" }}>
        {items === null && <p className="help">{t("installed.scanning")}</p>}
        {items !== null && shown.length === 0 && <p className="help">{t(games ? "installed.noGames" : "installed.noApps")}</p>}
        {shown.map((i) => (
          <button key={`${i.source}${i.target}`} className="menu-row compact" onClick={() => onPick(i)}>
            <span className="menu-ic is-plain">{i.icon ? <img src={i.icon} alt="" width={20} height={20} /> : <Icon name={games ? "play" : "app-window"} />}</span>
            <span className="menu-text">
              <b>{i.name}</b>
              {/* which launcher a game comes from helps; "startMenu" for an app does not */}
              {games && SOURCE_NAMES[i.source] && <small>{SOURCE_NAMES[i.source]}</small>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** `C:\\x\\Spotify.exe`, `Spotify.app`, `spotify` -> `spotify`: how MasterDeck matches an app. */
const appStem = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|app)$/, "");

/** `Spotify.app` / `spotify.exe` -> `Spotify` / `spotify`, for showing. */
const appShown = (name: string) => name.split(/[\\/]/).pop()!.replace(/\.(exe|app)$/i, "");

/**
 * An app chosen from a list (open now, used lately, installed) with icons and a search, not a
 * name to guess (owner, 2026-10-15: "jak użytkownik ma wiedzieć jaką apkę może wybrać?");
 * typing a name stays as a small fallback for an app that is not listed.
 */
function AppField({ id, value, onChange, onPicked, foreground }: { id: string; value: string; onChange: (v: unknown) => void; onPicked?: (value: string, look: { label: string }) => void; foreground: string }) {
  useLanguage();
  const [open, setOpen] = useState(!value);
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledItem[] | null>(null);
  useEffect(() => {
    api.apps().then(setApps, () => {});
  }, [foreground]);
  useEffect(() => {
    if (open && installed === null) api.installed(false).then((all) => setInstalled(all.apps), () => setInstalled([]));
  }, [open, installed]);
  const q = query.trim().toLowerCase();
  const fits = (name: string) => !q || name.toLowerCase().includes(q);
  const label = (a: AppInfo) => a.name ?? appShown(a.exe);
  // the control's label follows the app picked, so the deck and its drawing say whose sound it is
  // (owner, 2026-10-15: the fader still said "Volume")
  const pick = (name: string, shown = appShown(name)) => {
    if (onPicked) onPicked(name, { label: shown });
    else onChange(name);
    setOpen(false);
    setQuery("");
  };
  // apps sending sound now come first: a volume is mostly for one of them
  const playing = apps.filter((a) => a.playing && fits(label(a)));
  const openNow = apps.filter((a) => a.running && !a.playing && fits(label(a)));
  const recent = apps.filter((a) => !a.running && fits(label(a)));
  const listed = new Set(apps.map((a) => appStem(a.exe)));
  const more = (installed ?? []).filter((i) => !listed.has(appStem(i.exe || i.target || i.name)) && fits(i.name)).slice(0, 60);
  const chosen = value ? apps.find((a) => appStem(a.exe) === appStem(value)) : undefined;
  const row = (key: string, name: string, icon: string | undefined, onPick: () => void, sub?: string) => (
    <button key={key} type="button" className="menu-row compact" onClick={onPick}>
      <span className="menu-ic is-plain">{icon ? <img src={icon} alt="" width={20} height={20} /> : <Icon name="app-window" />}</span>
      <span className="menu-text">
        <b>{name}</b>
        {sub && <small>{sub}</small>}
      </span>
    </button>
  );
  if (typing) {
    return (
      <>
        <input id={id} className="input mono" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={IS_MAC ? "Spotify" : "spotify.exe"} />
        <button type="button" className="link-btn" onClick={() => (setTyping(false), setOpen(true))}>
          {t("param.listApps")}
        </button>
      </>
    );
  }
  return (
    <>
      <div className="row">
        <button id={id} type="button" className={`input grow app-choice${value ? "" : " is-empty"}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {value && (chosen?.icon ? <img src={chosen.icon} alt="" width={18} height={18} /> : <Icon name="app-window" />)}
          <span>{value ? (chosen ? label(chosen) : appShown(value)) : t("param.chooseApp")}</span>
          <Icon name="chevron-down" />
        </button>
      </div>
      {open && (
        <div className="field">
          <input className="input" autoFocus placeholder={t("installed.searchApps")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="menu-list" style={{ maxHeight: 280, overflowY: "auto" }}>
            {playing.length > 0 && <div className="pop-label">{t("param.playingNow")}</div>}
            {playing.map((a) => row(`p-${a.exe}`, label(a), a.icon, () => pick(a.exe, label(a))))}
            {openNow.length > 0 && <div className="pop-label">{t("profile.appsOpen")}</div>}
            {openNow.map((a) => row(`o-${a.exe}`, label(a), a.icon, () => pick(a.exe, label(a)), a.title && a.title !== label(a) ? a.title : undefined))}
            {recent.length > 0 && <div className="pop-label">{t("profile.appsRecent")}</div>}
            {recent.map((a) => row(`r-${a.exe}`, label(a), a.icon, () => pick(a.exe, label(a))))}
            {installed === null && <p className="help">{t("installed.scanning")}</p>}
            {more.length > 0 && <div className="pop-label">{t("param.installedApps")}</div>}
            {more.map((i) => row(`i-${i.target}`, i.name, i.icon, () => pick(i.exe || appShown(i.target) || i.name, i.name)))}
            {q && installed !== null && playing.length + openNow.length + recent.length + more.length === 0 && <p className="help">{t("param.appNotFound")}</p>}
          </div>
        </div>
      )}
      <div className="row wrap">
        {/* the app that was in front a moment ago, one click (never in the field's place) */}
        {foreground && appStem(foreground) !== appStem(value) && (
          <button type="button" className="link-btn" onClick={() => pick(foreground)}>
            {t("param.useApp", { app: (() => { const a = apps.find((x) => appStem(x.exe) === appStem(foreground)); return a ? label(a) : appShown(foreground); })() })}
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => setTyping(true)}>
          {t("param.typeApp")}
        </button>
      </div>
    </>
  );
}

/** The Mochi control whose body picture this one shows when it has none: the key named by its `from`, else the first with one. */
function sharedPetBody(controls: Record<string, Binding>, here: string | null, own: Binding): { control: string; binding: Binding } | null {
  const has = (b?: Binding) => b?.action === "core.pet" && !!String(b.params.body ?? "").trim();
  if (has(own)) return null;
  const from = String(own.params.from ?? "");
  if (from && from !== here && has(controls[from])) return { control: from, binding: controls[from] };
  const found = Object.entries(controls).find(([c, b]) => c !== here && has(b));
  return found ? { control: found[0], binding: found[1] } : null;
}

type PetFit = { size: number; x: number; y: number };
const PET_FIT: PetFit = { size: 100, x: 0, y: 0 };
const PET_PREVIEW_PX = 150;

/**
 * How Mochi's body picture sits (owner's 2a, 2026-10-18: "podgląd jak będzie wyglądać w różnych
 * stanach ... położenia i rozmiar"): the engine draws it happy, petted, hungry and asleep; the
 * picture is dragged in the big preview, Size scales it, Reset puts it back. Shown at once while it
 * changes, saved a moment after.
 */
function PetFitField({ id, value, siblings, onChange }: { id: string; value: unknown; siblings: Record<string, unknown>; onChange: (v: unknown) => void }) {
  useLanguage();
  const saved: PetFit = { ...PET_FIT, ...(value && typeof value === "object" ? (value as Partial<PetFit>) : {}) };
  const [live, setLive] = useState<PetFit | null>(null);
  const fit = live ?? saved;
  const [shots, setShots] = useState<string[]>([]);
  const body = String(siblings.body ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => api.petPreview({ ...siblings, bodyFit: fit }).then(setShots, () => setShots([])), 40);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, fit.size, fit.x, fit.y]);
  const commit = useRef<number | undefined>(undefined);
  const change = (next: PetFit) => {
    setLive(next);
    window.clearTimeout(commit.current);
    commit.current = window.setTimeout(() => (onChange(next), setLive(null)), 300);
  };
  const clamp = (v: number) => Math.round(Math.max(-100, Math.min(100, v)));
  const drag = useRef<{ x: number; y: number; from: PetFit; px: number } | null>(null);
  const names = [t("petFit.happy"), t("petFit.petted"), t("petFit.hungry"), t("petFit.asleep")];
  const src = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // four as big as the panel allows (owner, 2026-10-18: "takie małe - nie widać np. czy czapka
  // nocna pasuje"); a drag on any of them moves the picture
  return (
    <div className="pet-fit">
      <div className="pet-fit-shots">
        {names.map((name, i) => (
          <figure key={name}>
            {shots[i] ? (
              <img
                src={src(shots[i])}
                alt={name}
                title={t("petFit.drag")}
                draggable={false}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, from: fit, px: e.currentTarget.clientWidth || PET_PREVIEW_PX };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const k = 240 / d.px;
                  change({ ...d.from, x: clamp(d.from.x + (e.clientX - d.x) * k), y: clamp(d.from.y + (e.clientY - d.y) * k) });
                }}
                onPointerUp={() => (drag.current = null)}
              />
            ) : (
              <span className="pet-fit-empty" />
            )}
            <figcaption>{name}</figcaption>
          </figure>
        ))}
      </div>
      <div className="row">
        <label className="pet-fit-size" htmlFor={id}>
          {t("petFit.size")}
        </label>
        <input
          id={id}
          className="range grow"
          type="range"
          min={40}
          max={200}
          step={5}
          value={fit.size}
          style={{ "--fill": `${((fit.size - 40) / 160) * 100}%` } as React.CSSProperties}
          onChange={(e) => change({ ...fit, size: Number(e.target.value) })}
        />
        <span className="pet-fit-value">{fit.size} %</span>
        <button className="tool small ghost" disabled={fit.size === 100 && fit.x === 0 && fit.y === 0} onClick={() => change(PET_FIT)}>
          {t("petFit.reset")}
        </button>
      </div>
    </div>
  );
}

/** A picture from the pictures folder for an action (Mochi's body): pick, change, remove. */
function PictureField({ id, value, onChange }: { id: string; value: string; onChange: (v: unknown) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    setThumb(null);
    if (value) api.imageThumb(value).then(setThumb, () => {});
  }, [value]);
  const choose = () => {
    setError(null);
    pickImage().then((name) => name && onChange(name), (e) => setError(String(e)));
  };
  return (
    <>
      <div className="row wrap">
        {value && (thumb ? <img className="picture-thumb" src={thumb} alt="" /> : <span className="picture-thumb" />)}
        <button id={id} className="tool small" onClick={choose}>
          <Icon name="image" />
          {value ? t("param.pictureChange") : t("param.pictureNone")}
        </button>
        {value && (
          <button className="tool small ghost" onClick={() => onChange("")}>
            <Icon name="x" />
            {t("param.pictureRemove")}
          </button>
        )}
      </div>
      {error && <p className="help catalog-err">{error}</p>}
    </>
  );
}

/**
 * A token kept in the system's credential store (Live value): the param holds only its name, made
 * up the first time one is saved; the token itself never enters the profile.
 */
function SecretField({ id, name, onChange }: { id: string; name: string; onChange: (v: unknown) => void }) {
  useLanguage();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (name) invoke<boolean>("live_secret_saved", { name }).then(setSaved, () => setSaved(false));
    else setSaved(false);
  }, [name]);
  const store = (value: string) => {
    const key = name || `t${Math.random().toString(36).slice(2, 10)}`;
    invoke("live_secret_set", { name: key, token: value }).then(
      () => (setToken(""), setSaved(value !== ""), setMessage(value ? t("secret.saved") : t("secret.removed")), name || onChange(key)),
      (e) => setMessage(String(e)),
    );
  };
  return (
    <>
      <div className="row">
        <input id={id} className="input grow" type="password" autoComplete="off" value={token} placeholder={saved ? t("secret.kept") : t("secret.none")} onChange={(e) => setToken(e.target.value)} />
        <button className="tool" disabled={!token.trim()} onClick={() => store(token.trim())}>
          {t("secret.save")}
        </button>
        {saved && (
          <button className="tool ghost" onClick={() => store("")}>
            {t("secret.remove")}
          </button>
        )}
      </div>
      {message && <p className="help">{message}</p>}
    </>
  );
}

/** A place for the weather: a city search (Open-Meteo), stored as `Name|lat|lon`. */
function PlaceField({ id, value, onChange }: { id: string; value: string; onChange: (v: unknown) => void }) {
  useLanguage();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ name: string; detail: string; lat: number; lon: number; param: string }[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const search = () => {
    setMessage(null);
    invoke<{ name: string; detail: string; lat: number; lon: number; param: string }[]>("weather_search", { name: query }).then(
      (list) => (setFound(list), list.length === 0 && setMessage(t("place.none"))),
      (e) => setMessage(String(e)),
    );
  };
  const current = value.split("|")[0];
  return (
    <>
      {current && <p className="help">{t("place.current", { place: current })}</p>}
      <div className="row">
        <input id={id} className="input grow" value={query} placeholder={t("place.placeholder")} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button className="tool" disabled={query.trim().length < 2} onClick={search}>
          <Icon name="search" />
          {t("place.search")}
        </button>
      </div>
      {found?.map((p) => (
        <button
          key={`${p.lat},${p.lon}`}
          className="menu-row compact"
          onClick={() => (onChange(p.param), setFound(null), setQuery(""))}
        >
          <span className="menu-text">
            <b>{p.name}</b>
            <small>{p.detail}</small>
          </span>
        </button>
      ))}
      {message && <p className="help">{message}</p>}
    </>
  );
}

function ParamField({
  def,
  value,
  onChange,
  view,
  onPicked,
  siblings,
}: {
  def: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
  view: EngineView;
  /** The other params of the same binding (an OBS filter is listed for the source picked). */
  siblings?: Record<string, unknown>;
  /** An installed app or game (or a named shortcut) was picked: the param's value and the look it brings. */
  onPicked?: (value: string, look: { image?: string; icon?: string; label: string }) => void;
}) {
  const id = `param-${def.key}`;
  // an empty app or game field opens its list at once: picking is the next step (variant A)
  const [picking, setPicking] = useState(value == null || value === "");
  const str = value == null ? (def.key === "sceneTarget" ? "program" : "") : String(value);
  let field: React.ReactNode;
  switch (def.type) {
    case "text":
      field =
        def.key === "color" && !def.multiline ? (
          <div className="row">
            <label className="color">
              <input type="color" aria-label={def.label} value={/^#[0-9a-f]{6}$/i.test(str) ? str : "#ff2020"} onChange={(e) => onChange(e.target.value)} />
            </label>
            <input id={id} className="input mono grow" value={str} onChange={(e) => onChange(e.target.value)} />
          </div>
        ) : def.multiline ? (
        <textarea id={id} className="input" rows={3} value={str} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="input" value={str} onChange={(e) => onChange(e.target.value)} />
      );
      break;
    case "target":
    case "game": {
      const games = def.type === "game";
      const pick = (item: InstalledItem) => {
        setPicking(false);
        onChange(item.target);
        // the key gets the app's icon or the game's cover (a local cover stays on this PC)
        api.installedPicture(item).then((image) => onPicked?.(item.target, { image, label: item.name }), () => onPicked?.(item.target, { label: item.name }));
      };
      field = (
        <>
          <div className="row">
            <input id={id} className="input grow" value={str} onChange={(e) => onChange(e.target.value)} placeholder={t(games ? "installed.gamePlaceholder" : IS_MAC ? "param.targetPlaceholderMac" : "param.targetPlaceholder")} />
            <button className={`tool${picking ? " is-active" : ""}`} onClick={() => setPicking((p) => !p)}>
              <Icon name={games ? "play" : "app-window"} />
              {t(games ? "installed.pickGame" : "installed.pickApp")}
            </button>
            {!games && (
              <button
                className="tool"
                title={t("param.browse")}
                onClick={async () => {
                  const picked = await open({ multiple: false, directory: false });
                  if (typeof picked === "string") onChange(picked);
                }}
              >
                <Icon name="folder-open" />
              </button>
            )}
          </div>
          {picking && <InstalledPicker games={games} onPick={pick} />}
        </>
      );
      break;
    }
    case "hotkey":
      field = (
        <HotkeyField
          value={str}
          onChange={onChange}
          specialKeys={view.catalog?.specialKeys ?? []}
          onNamed={def.key === "keys" && onPicked ? (keys, label, icon) => onPicked(keys, { label, icon }) : undefined}
        />
      );
      break;
    case "select":
      field = (
        <select id={id} className="input" value={str} onChange={(e) => onChange(e.target.value)}>
          {def.options.map(([v, l]) => (
            <option key={v} value={v}>
              {def.key === "sceneTarget" ? t(v === "preview" ? "obs.targetPreview" : "obs.targetProgram") : l}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
      field = <input id={id} className="input" type="number" min={def.min} max={def.max} step={def.step} value={str} onChange={(e) => onChange(Number(e.target.value))} />;
      break;
    case "profile":
      field = (
        <select id={id} className="input" value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("param.chooseProfile")}</option>
          {view.state?.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
      break;
    case "page":
      field = (
        <select id={id} className="input" value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("param.mainPage")}</option>
          {view.profile?.pages?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
      break;
    case "steps":
      field = <StepsEditor steps={Array.isArray(value) ? (value as Step[]) : []} onChange={onChange} view={view} />;
      break;
    case "named":
      // an OBS filter is listed for the source picked next to it
      field = <NamedField id={id} value={str} onChange={onChange} what={def.what} arg={def.what === "obs.filter" ? String(siblings?.source ?? "") : undefined} />;
      break;
    case "audioDevice":
      field = <AudioDeviceField id={id} value={str} onChange={onChange} empty={def.key === "device" ? undefined : def.key === "with" ? t("audio.noSecond") : t("audio.keep")} />;
      break;
    case "midiPort":
      field = <MidiPortField id={id} value={str} onChange={onChange} />;
      break;
    case "modes":
      field = <ModesEditor modes={Array.isArray(value) ? (value as Mode[]) : []} onChange={onChange} view={view} />;
      break;
    case "secret":
      field = <SecretField id={id} name={str} onChange={onChange} />;
      break;
    case "place":
      field = <PlaceField id={id} value={str} onChange={onChange} />;
      break;
    case "picture":
      field = <PictureField id={id} value={str} onChange={onChange} />;
      break;
    case "petFit":
      // nothing to fit without a body picture
      if (!String(siblings?.body ?? "").trim()) return null;
      field = <PetFitField id={id} value={value} siblings={siblings ?? {}} onChange={onChange} />;
      break;
    case "app":
      field = <AppField id={id} value={str} onChange={onChange} onPicked={onPicked} foreground={view.state?.foreground ?? ""} />;
      break;
  }
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {def.key === "sceneTarget" ? t("obs.targetLabel") : def.label}
      </label>
      {field}
      {def.help && <p className="help">{def.help}</p>}
    </div>
  );
}

/** The steps of a multi-action: each waits its delay, then runs one press action. */
function StepsEditor({ steps, onChange, view }: { steps: Step[]; onChange: (s: Step[]) => void; view: EngineView }) {
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  // a second click stops; leaving the editor stops too
  useEffect(() => () => void (recording && api.macroRecordStop().catch(() => {})), [recording]);
  const record = () => {
    setRecordError(null);
    if (!recording) {
      api.macroRecordStart().then(() => setRecording(true), (e) => setRecordError(String(e)));
      return;
    }
    setRecording(false);
    api.macroRecordStop().then((recorded) => recorded.length && onChange([...steps, ...recorded]), (e) => setRecordError(String(e)));
  };
  const choices = (view.catalog?.actions ?? []).filter((a) => a.id !== "core.multi" && a.inputs.includes("press")).map(localizeAction);
  const set = (i: number, step: Step) => onChange(steps.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    onChange(next);
  };
  return (
    <div className="steps">
      {steps.map((step, i) => {
        const def = choices.find((a) => a.id === step.action);
        return (
          <div className="step" key={i}>
            <div className="step-head">
              <span className="step-n">{i + 1}</span>
              <select
                className="input grow"
                aria-label={t("steps.action", { n: i + 1 })}
                value={step.action}
                onChange={(e) => {
                  const d = choices.find((a) => a.id === e.target.value);
                  if (d) set(i, { action: d.id, params: newBinding(d).params, delay: step.delay });
                }}
              >
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.group} · {a.name}
                  </option>
                ))}
              </select>
              <span className="step-tools">
                <button className="icon-btn" aria-label={t("steps.up")} title={t("steps.up")} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="arrow-up" />
                </button>
                <button className="icon-btn" aria-label={t("steps.down")} title={t("steps.down")} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="arrow-down" />
                </button>
                <button className="icon-btn danger" aria-label={t("steps.remove")} title={t("steps.remove")} onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              </span>
            </div>
            <div className="step-grid">
              <label className="field">
                <span className="label">{t("steps.wait")}</span>
                <span className="suffixed">
                  <input className="input" type="number" min={0} max={10000} step={50} value={step.delay} onChange={(e) => set(i, { ...step, delay: Math.max(0, Math.min(10000, Number(e.target.value))) })} />
                  <span className="suffix">ms</span>
                </span>
              </label>
              <label className="field">
                <span className="label">{t("steps.when")}</span>
                <select className="input" value={step.when ?? ""} onChange={(e) => set(i, { ...step, when: e.target.value || undefined })}>
                  {STEP_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {t(`steps.when.${c || "always"}` as Key)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {def?.params
              .filter((p) => p.type !== "steps" && (!p.when || p.when[1].includes(String(step.params[p.when[0]] ?? ""))))
              .map((p) => (
                <ParamField key={p.key} def={p} value={step.params[p.key]} view={view} siblings={step.params} onChange={(v) => set(i, { ...step, params: { ...step.params, [p.key]: v } })} />
              ))}
          </div>
        );
      })}
      <button
        className="add-row"
        onClick={() => {
          const first = choices.find((a) => a.id === "core.hotkey") ?? choices[0];
          if (first) onChange([...steps, { action: first.id, params: newBinding(first).params, delay: steps.length ? 100 : 0 }]);
        }}
      >
        <Icon name="plus" />
        {t("steps.add")}
      </button>
      <button className={`tool${recording ? " recording" : ""}`} onClick={record} aria-pressed={recording}>
        {recording ? <span className="rec-dot" aria-hidden="true" /> : <Icon name="keyboard" />}
        {recording ? t("steps.stopRecord") : t("steps.record")}
      </button>
      <p className="help">{recordError ?? (recording ? t("steps.recording") : t("steps.recordHelp"))}</p>
    </div>
  );
}

/** A speaker or microphone picked from the active devices; a saved one that is unplugged stays. */
/** A scene or source OBS knows, from its list while it is connected (owner, 2026-10-15: names
 * are picked, not typed); typed while it is not. */
/** Which service a list field comes from, for "Connect ... to pick from its list". */
const SERVICE_NAMES: Record<string, string> = { obs: "OBS", streamlabs: "Streamlabs", ha: "Home Assistant", spotify: "Spotify", twitch: "Twitch" };

/**
 * A name a connected service knows, picked from its list (`names_list`): OBS scenes, sources,
 * transitions, filters; Streamlabs scenes and sources; Home Assistant entities; Spotify playlists;
 * Twitch categories as you type (owner, 2026-10-15/16: lists, not names from memory). While the
 * service is not connected the name is typed, and a typed name stays possible.
 */
function NamedField({ id, value, onChange, what, arg }: { id: string; value: string; onChange: (v: string) => void; what: string; arg?: string }) {
  useLanguage();
  type Name = { value: string; label: string };
  const [names, setNames] = useState<Name[] | null>(null);
  const [typing, setTyping] = useState(false);
  const search = what === "twitch.category";
  const ask = useCallback((text?: string) => invoke<Name[] | null>("names_list", { what, arg: text ?? arg ?? null }).then(setNames, () => setNames(null)), [what, arg]);
  useEffect(() => {
    ask(search ? value : undefined);
    // a list read over the network (Home Assistant, Spotify) comes a moment after the first ask
    const again = window.setTimeout(() => ask(search ? value : undefined), 1500);
    return () => window.clearTimeout(again);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);
  const service = SERVICE_NAMES[what.split(".")[0]] ?? what;
  if (search) {
    // a search: type, and the matching names come as suggestions
    const listId = `${id}-names`;
    return (
      <>
        <input
          id={id}
          className="input"
          list={listId}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            window.setTimeout(() => ask(e.target.value), 350);
          }}
        />
        <datalist id={listId}>
          {(names ?? []).map((n) => (
            <option key={n.value} value={n.value}>
              {n.label}
            </option>
          ))}
        </datalist>
        <p className="help">{names ? t("param.searchHint") : t("param.notConnected", { service })}</p>
      </>
    );
  }
  if (!names || typing) {
    return (
      <>
        <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} />
        {names ? (
          <button type="button" className="link-btn" onClick={() => setTyping(false)}>
            {t("param.pickName")}
          </button>
        ) : (
          <p className="help">{t("param.notConnected", { service })}</p>
        )}
      </>
    );
  }
  return (
    <>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("param.obsPick")}</option>
        {value && !names.some((n) => n.value === value) && <option value={value}>{value}</option>}
        {names.map((n) => (
          <option key={n.value} value={n.value}>
            {n.label}
          </option>
        ))}
      </select>
      <button type="button" className="link-btn" onClick={() => setTyping(true)}>
        {t("param.typeName")}
      </button>
    </>
  );
}

function AudioDeviceField({ id, value, onChange, empty }: { id: string; value: string; onChange: (v: string) => void; empty?: string }) {
  useLanguage();
  const [devices, setDevices] = useState<[{ id: string; name: string }[], { id: string; name: string }[]] | null>(null);
  useEffect(() => {
    api.audioDevices().then(setDevices, () => setDevices([[], []]));
  }, []);
  // a key may keep the device's system id (a converted Stream Deck key): it shows by its name
  const known = devices ? [...devices[0], ...devices[1]].some((d) => d.name === value || d.id === value) : true;
  const pick = (d: { id: string; name: string }) => (d.id === value ? d.id : d.name);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty ?? t("audio.next")}</option>
      {!known && value && <option value={value}>{value}</option>}
      {devices && (
        <>
          <optgroup label={t("audio.outputs")}>
            {devices[0].map((d) => (
              <option key={`o${d.name}`} value={pick(d)}>
                {d.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("audio.inputs")}>
            {devices[1].map((d) => (
              <option key={`i${d.name}`} value={pick(d)}>
                {d.name}
              </option>
            ))}
          </optgroup>
        </>
      )}
    </select>
  );
}

/** A MIDI output picked from the ports the system has now; a saved port that is gone stays listed. */
function MidiPortField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  useLanguage();
  const [ports, setPorts] = useState<string[] | null>(null);
  const load = () => api.midiPorts().then(setPorts, () => setPorts([]));
  useEffect(() => {
    load();
  }, []);
  const options = ports && value && !ports.includes(value) ? [value, ...ports] : (ports ?? []);
  return (
    <div className="row">
      <select id={id} className="input grow" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{ports && ports.length === 0 ? t("midi.noPorts") : t("midi.choose")}</option>
        {options.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button className="tool" onClick={load}>
        <Icon name="refresh-cw" />
        {t("midi.refresh")}
      </button>
    </div>
  );
}

/** Modes of a dial or knob: a name and a turning action each; a press goes to the next. */
function ModesEditor({ modes, onChange, view }: { modes: Mode[]; onChange: (m: Mode[]) => void; view: EngineView }) {
  const choices = (view.catalog?.actions ?? []).filter((a) => a.id !== "core.modes" && a.inputs.includes("turn")).map(localizeAction);
  const set = (i: number, mode: Mode) => onChange(modes.map((m, j) => (j === i ? mode : m)));
  return (
    <div className="steps">
      {modes.map((mode, i) => {
        const def = choices.find((a) => a.id === mode.action);
        return (
          <div className="step" key={i}>
            <div className="step-head">
              <span className="step-n">{i + 1}</span>
              <input className="input grow" aria-label={t("modes.name", { n: i + 1 })} placeholder={t("modes.namePlaceholder")} value={mode.label} onChange={(e) => set(i, { ...mode, label: e.target.value })} />
              <span className="step-tools">
                <button className="icon-btn danger" aria-label={t("modes.remove")} title={t("modes.remove")} onClick={() => onChange(modes.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              </span>
            </div>
            <select
              className="input"
              aria-label={t("modes.action", { n: i + 1 })}
              value={mode.action}
              onChange={(e) => {
                const d = choices.find((a) => a.id === e.target.value);
                if (d) set(i, { label: mode.label || d.name, action: d.id, params: newBinding(d).params });
              }}
            >
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.group} · {a.name}
                </option>
              ))}
            </select>
            {def?.params
              .filter((p) => p.type !== "modes" && (!p.when || p.when[1].includes(String(mode.params[p.when[0]] ?? ""))))
              .map((p) => (
                <ParamField key={p.key} def={p} value={mode.params[p.key]} view={view} siblings={mode.params} onChange={(v) => set(i, { ...mode, params: { ...mode.params, [p.key]: v } })} />
              ))}
          </div>
        );
      })}
      <button
        className="add-row"
        onClick={() => {
          const first = choices.find((a) => a.id === "core.volume") ?? choices[0];
          if (first) onChange([...modes, { label: first.name, action: first.id, params: newBinding(first).params }]);
        }}
      >
        <Icon name="plus" />
        {t("modes.add")}
      </button>
    </div>
  );
}

/** Knobs, faders and rollers: the name in the drawing and, for knobs and faders, the LED. */
function ControlLook({ look, onChange, led, fromPreset }: { look: Look; onChange: (l: Look) => void; led: boolean; fromPreset?: string | null }) {
  return (
    <section className="look">
      <div className="field">
        <label htmlFor="look-label" className="label">
          {t("look.name")}
        </label>
        <input id="look-label" className="input" value={look.label ?? ""} onChange={(e) => onChange({ ...look, label: e.target.value || undefined })} />
      </div>
      {led && (
        <details className="field" open={!!look.led}>
          <summary className="label">{t("look.advancedLights")}</summary>
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={!!look.led} onChange={(e) => onChange({ ...look, led: e.target.checked ? "#8b7cf6" : undefined, ledLevel: e.target.checked ? look.ledLevel : undefined })} />
              {t("look.ownColor")}
            </label>
            {look.led && (
              <label className="color">
                <input type="color" value={look.led} onChange={(e) => onChange({ ...look, led: e.target.value })} />
                {t("look.color")}
              </label>
            )}
          </div>
          {look.led && (
            <label className="check">
              <input type="checkbox" checked={!!look.ledLevel} onChange={(e) => onChange({ ...look, ledLevel: e.target.checked || undefined })} />
              {t("look.ledLevel")}
            </label>
          )}
          {look.led && <EffectFields idPrefix="led" effect={look.ledEffect} speed={look.ledSpeed} onChange={(ledEffect, ledSpeed) => onChange({ ...look, ledEffect, ledSpeed })} />}
          {look.led && look.ledEffect && <p className="help">{t("look.speedHelp")}</p>}
          {/* the preset's colour and this control's own: the particular wins (owner's "2 a", 2026-10-30) */}
          {fromPreset && <p className="help">{t("look.fromPresetLed", { name: fromPreset })}</p>}
          <p className="help">{t("look.ledHelp")}</p>
        </details>
      )}
    </section>
  );
}


const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/** Pick a picture file, copy it into the app; returns its name or null. */
export async function pickImage(): Promise<string | null> {
  const path = await open({ multiple: false, filters: [{ name: t("look.pictures"), extensions: IMAGE_EXTENSIONS }] });
  if (typeof path !== "string") return null;
  return api.importImage(path);
}

/** Icon colors of the house look (`house.rs` group hues) and the plain label color, for one click. */
const HOUSE_BG = "#1b1a20";
const HOUSE_LABEL = "#e6e4ee";
const ICON_TINTS = ["#8c79ec", "#79c6ec", "#79ecc6", "#ec798c", "#ecb279", HOUSE_LABEL];

/**
 * Quick appearance edits for a key or the dial, with the full designer available for keys.
 */
function LookEditor({ look, onChange, screen, view, idPrefix = "look", program, others = [], onApplyTo, onOpenStudio }: { look: Look; onChange: (l: Look) => void; screen: "key" | "dial"; view: EngineView; idPrefix?: string; program?: string; others?: OtherKey[]; onApplyTo?: (ids: string[]) => Promise<unknown>; onOpenStudio?: () => void }) {
  const svg = usePreview(screen, look);
  const [imageError, setImageError] = useState<string | null>(null);
  const [iconsOpen, setIconsOpen] = useState(false);
  const iconsRef = useRef<HTMLButtonElement>(null);
  const closeIcons = () => {
    setIconsOpen(false);
    iconsRef.current?.focus();
  };
  const choosePicture = () => {
    setImageError(null);
    pickImage().then((image) => image && onChange({ ...look, image }), (e) => setImageError(String(e)));
  };
  // a tint puts the key in the house look: graphite key, light label, the icon in that color
  const tint = (c: string) => onChange({ ...look, bg: HOUSE_BG, fg: HOUSE_LABEL, style: undefined, iconColor: c === HOUSE_LABEL ? undefined : c });
  const tinted = (c: string) => (look.bg ?? HOUSE_BG) === HOUSE_BG && (look.iconColor ?? HOUSE_LABEL) === c;
  return (
    <section className="look">
      <div className="look-head">
        {/* inline, not an <img>: an image cannot use the app's IBM Plex font and falls back to a serif */}
        <div className={`preview preview-${screen}`} role="img" aria-label={t("look.preview")} dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
        <div className="field grow">
          <label htmlFor={`${idPrefix}-label`} className="label">
            {t("look.label")}
          </label>
          <input id={`${idPrefix}-label`} className="input" value={look.label ?? ""} onChange={(e) => onChange({ ...look, label: e.target.value || undefined })} />
          <div className="row wrap look-actions">
            {!look.image && (
              <button ref={iconsRef} className="tool small" aria-haspopup="dialog" onClick={() => setIconsOpen(true)}>
                <Icon name="image" />
                {t("look.changeIcon")}
              </button>
            )}
            {onOpenStudio && (
              <button className="tool small" onClick={onOpenStudio} title={t("look.openStudioHelp")}>
                <Icon name="palette" />
                {t("look.openStudio")}
              </button>
            )}
            <button className="tool small" onClick={choosePicture} title={t(screen === "dial" ? "look.pictureHelpDial" : "look.pictureHelp")}>
              <Icon name="image" />
              {look.image ? t("look.changePicture") : t("look.picture")}
            </button>
            {look.image && (
              <button className="tool small ghost" onClick={() => onChange({ ...look, image: undefined })}>
                {t("look.removePicture")}
              </button>
            )}
          </div>
        </div>
      </div>
      {iconsOpen && createPortal(
        <Sheet onClose={closeIcons} label={t("look.changeIcon")}>
          <div className="icon-picker-sheet">
            <div className="insp-head">
              <h2 className="grow">{t("look.changeIcon")}</h2>
              <button type="button" className="tool ghost icon-only" aria-label={t("profile.close")} autoFocus onClick={closeIcons}><Icon name="x" /></button>
            </div>
            <div className="sec">
              <IconPicker
                value={look.icon}
                onChange={(icon) => (onChange({ ...look, icon }), closeIcons())}
                onPicture={(image) => (onChange({ ...look, image }), closeIcons())}
                view={view}
              />
            </div>
          </div>
        </Sheet>,
        document.body,
      )}
      {!look.image && (
        <div className="tints" role="listbox" aria-label={t("look.iconColor")}>
          {ICON_TINTS.map((c) => (
            <button key={c} role="option" aria-selected={tinted(c)} className={`tint${tinted(c) ? " is-active" : ""}`} style={{ background: c }} title={c} onClick={() => tint(c)} />
          ))}
        </div>
      )}
      {look.image && (
        <div className="field">
          <span className="label">{t("look.fit")}</span>
          <div className="seg full" role="radiogroup" aria-label={t("look.fit")}>
            {([undefined, "icon", "fill"] as const).map((f) => (
              <button key={f ?? "auto"} role="radio" aria-checked={look.fit === f} className={`tab${look.fit === f ? " is-active" : ""}`} onClick={() => onChange({ ...look, fit: f })}>
                {t(f === "icon" ? "look.fitIcon" : f === "fill" ? "look.fitFill" : "look.fitAuto")}
              </button>
            ))}
          </div>
          <p className="help">{t("look.fitHelp")}</p>
        </div>
      )}
      {imageError && <p className="help">{imageError}</p>}
      {screen === "key" ? (
        <details className="more-looks">
          <summary>{t("look.edit")}</summary>
          <KeyDesigner
            look={look}
            onChange={onChange}
            others={others}
            onApplyTo={onApplyTo ?? (() => Promise.resolve())}
            appIcon={
              program
                ? () => {
                    setImageError(null);
                    api.appIcon(program).then((image) => onChange({ ...look, image }), (e) => setImageError(String(e)));
                  }
                : undefined
            }
          />
          <p className="help">{t("look.pictureHelp")}</p>
        </details>
      ) : (
      <details className="more-looks">
        <summary>{t("look.moreDial")}</summary>
        <div className="look-colors">
          <label className="color">
            <input type="color" value={look.bg ?? HOUSE_BG} onChange={(e) => onChange({ ...look, bg: e.target.value })} />
            {t("look.background")}
          </label>
          <label className="color">
            <input type="color" value={look.fg ?? HOUSE_LABEL} onChange={(e) => onChange({ ...look, fg: e.target.value })} />
            {t("look.text")}
          </label>
          <label className="color">
            <input type="color" value={look.iconColor ?? look.fg ?? HOUSE_LABEL} onChange={(e) => onChange({ ...look, iconColor: e.target.value })} />
            {t("look.iconColor")}
          </label>
        </div>
        <div className="field">
          <span className="label">{t("look.presets")}</span>
          <div className="swatches" role="listbox" aria-label={t("look.presets")}>
            {BACKGROUNDS.map(([bg, fg]) => (
              <button key={bg} role="option" aria-selected={look.bg === bg} className={`swatch${look.bg === bg ? " is-active" : ""}`} style={{ background: bg, color: fg }} title={bg} onClick={() => onChange({ ...look, bg, fg })}>
                Aa
              </button>
            ))}
          </div>
        </div>
        {program && (
          <button
            className="tool small align-start"
            onClick={() => {
              setImageError(null);
              api.appIcon(program).then((image) => onChange({ ...look, image }), (e) => setImageError(String(e)));
            }}
          >
            {t("look.appIcon")}
          </button>
        )}
        <p className="help">{t("look.pictureHelpDial")}</p>
      </details>
      )}
    </section>
  );
}

const GESTURES: [Gesture, Key][] = [
  ["tap", "gesture.tap"],
  ["hold", "gesture.hold"],
  ["double", "gesture.double"],
];

function DialLooks({ onPick }: { onPick: (look: Look) => void }) {
  const { lang } = useLanguage();
  const [faces, setFaces] = useState<DialFace[]>([]);
  useEffect(() => {
    let current = true;
    api.dialGallery().then((items) => { if (current) setFaces(items); }, () => {});
    return () => { current = false; };
  }, []);
  if (!faces.length) return null;
  return (
    <details className="dial-face-options">
      <summary>{t("dialLooks.more")}</summary>
      <div className="dial-looks">
        {faces.map((face) => (
          <button key={face.id} type="button" className="dial-look" onClick={() => onPick(face.binding.look)} title={lang === "pl" ? face.captionPl : face.caption}>
            <span className="dial-look-face" dangerouslySetInnerHTML={{ __html: inWindow(face.svg) }} />
            <span className="sugg-label">{lang === "pl" ? face.captionPl : face.caption}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

/** A Stream Deck action's settings page (its property inspector), as the plugin made it. The
 *  address is asked once per control and action: the page talks to the plugin itself and saves
 *  through MasterDeck, so it is not reloaded while it edits. */
function SdInspector({ control, action, settings }: { control: string; action: string; settings: Record<string, unknown> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(120);
  const first = useRef(settings);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    api.sdInspector(control, action, first.current).then(setUrl, () => setUrl(null));
  }, [control, action]);
  // the page says how tall it is (MasterDeck's script in it), so the box has no empty space
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && typeof e.data?.hubdeckInspectorHeight === "number") setHeight(Math.min(1200, Math.max(48, e.data.hubdeckInspectorHeight)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  if (!url) return null;
  return (
    <div className="sd-inspector">
      <iframe ref={frame} title={t("inspector.pluginSettings")} src={url} style={{ height }} />
    </div>
  );
}

export type InspectorHandle = {
  flush: () => Promise<void> | undefined;
  selectTrigger: (gesture: Gesture) => void;
};

export function Inspector({ ref, selected, view, onDropAction, onOpenStudio, onClose }: {
  ref?: Ref<InspectorHandle>;
  selected: ControlRef | null;
  view: EngineView;
  onDropAction: (control: ControlRef, action: string, gesture: Gesture) => boolean;
  onOpenStudio?: (control: string) => void;
  onClose?: () => void;
}) {
  useLanguage();
  const profile = view.profile;
  const page = view.state?.page ?? null;
  const [gesture, setGesture] = useState<Gesture>("tap");
  const canGesture = !!selected && pressable(selected.kind);
  const activeGesture = canGesture ? gesture : "tap";
  const control = selected ? controlId(selected.kind, selected.index, page, activeGesture) : null;
  const stored = control && profile ? profile.controls[control] ?? null : null;
  const [draft, setDraft] = useState<Binding | null>(stored);
  const [writeError, setWriteError] = useState("");
  // the other keys of this page that do something: where "Apply this look to other keys" can go
  const otherKeys: OtherKey[] =
    selected?.kind === "keys" && profile
      ? Array.from({ length: 15 }, (_, i) => controlId("keys", i, page))
          .filter((id) => id !== control && profile.controls[id])
          .map((id) => {
            const b = profile.controls[id];
            const n = Number(id.split(".").pop()) + 1;
            const def = view.catalog?.actions.find((a) => a.id === b.action);
            // a plugin's action is not in the catalog: the last word of its id ("…audiooutputswitch.toggle": Toggle)
            const last = b.action.split(/[/.]/).pop() ?? b.action;
            return { id, name: `${n}. ${b.look?.label?.trim() || (def ? actionName(def) : last.charAt(0).toUpperCase() + last.slice(1))}` };
          })
      : [];
  const [appearance, setAppearance] = useState(false);
  const saver = useDebouncedSave((b) => {
    if (profile && control) return api.setBinding(profile.id, control, b).then(() => setWriteError(""), (error) => setWriteError(String(error)));
  });

  useImperativeHandle(ref, () => ({
    flush: saver.flush,
    selectTrigger: (next) => { setGesture(next); setAppearance(false); },
  }), [saver.flush]);
  const [draggedOver, setDraggedOver] = useState<Gesture | null>(null);
  const actionPane = useRef<HTMLDivElement>(null);
  const lookPane = useRef<HTMLDivElement>(null);

  // switching control or profile: save what was being typed, then load the new binding
  useEffect(() => {
    saver.flush();
    setDraft(stored);
    setDraggedOver(null);
    setWriteError("");
    setAppearance(false);
    if (actionPane.current) actionPane.current.scrollTop = 0;
    if (lookPane.current) lookPane.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control, profile?.id]);
  // another control starts on its plain press
  const selectedKey = selected ? `${selected.module}#${selected.index}` : "";
  useEffect(() => setGesture(DEMO_GESTURE ?? "tap"), [selectedKey]);
  // something else changed this binding (the library, an import): follow it unless mid-edit
  useEffect(() => {
    if (!saver.isPending()) setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(stored)]);

  if (!selected || !control) return null;
  const name = selected.kind === "dial" && selected.index === 0 ? t("control.dial") : `${t(`control.${selected.kind}`)} ${selected.index + 1}`;
  const found = draft ? view.catalog?.actions.find((a) => a.id === draft.action) : undefined;
  const action: ActionDef | undefined = found && localizeAction(found);
  const update = (b: Binding | null, delay?: number) => {
    setDraft(b);
    saver.schedule(b, delay);
  };
  const hasScreen = selected.kind === "keys" || selected.kind === "dial";
  // the inputs that apply here: the ones most people set, and the rest under "More options"
  const shownParams = (draft ? action?.params ?? [] : [])
    .filter((p) => draft?.action !== "obs.scene" || p.key !== "sceneTarget" || view.state?.obsStudioMode)
    .filter((p) => !p.when || p.when[1].includes(String(draft?.params[p.when[0]] ?? "")))
    .filter((p) => !(TURN_PARAMS.has(p.key) && (selected.kind === "keys" || activeGesture !== "tap")));
  const isAdvanced = (p: ParamDef) => ADVANCED_PARAMS.has(p.key) || ADVANCED_PARAMS.has(`${draft?.action}:${p.key}`);
  const basic = shownParams.filter((p) => !isAdvanced(p));
  const advanced = shownParams.filter(isAdvanced);
  const canAccel = !!action?.inputs.includes("turn") && selected.kind !== "faders" && selected.kind !== "keys" && activeGesture === "tap";
  // Mochi is one pet: a Mochi control without a body picture of its own shows and changes the one
  // set elsewhere, first on the key that put it on the dial (owner, 2026-10-18: the dial showed his
  // picture and its settings "Pick a picture")
  const petBody = draft?.action === "core.pet" && profile ? sharedPetBody(profile.controls, control, draft) : null;
  const paramProps = (p: ParamDef) =>
    petBody && (p.key === "body" || p.key === "bodyFit")
      ? {
          value: petBody.binding.params[p.key],
          siblings: petBody.binding.params,
          onChange: (v: unknown) => void api.setBinding(profile!.id, petBody.control, { ...petBody.binding, params: { ...petBody.binding.params, [p.key]: v } }).catch(() => {}),
        }
      : null;
  // on a dial or knob the first tab holds what turning does too
  const turns = selected.kind === "dial" || selected.kind === "knobs";
  const canEditAppearance = !!draft && activeGesture === "tap";
  const showLook = appearance && canEditAppearance;
  const panelTitle = t(selected.kind === "keys" ? "inspector.keySettings" : "inspector.panelTitle");

  return (
    <aside className="inspector sectioned control-inspector" data-guide="control-editor" aria-label={panelTitle}>
      <div className="insp-head">
        <Icon name="sliders-horizontal" />
        <div className="grow">
          <span className="control-panel-label">{panelTitle}</span>
          <h2>{name}</h2>
        </div>
        {canEditAppearance && (
          <div className="seg control-mode" role="group" aria-label={t("inspector.panelTitle")}>
            <button type="button" className={`tab${!showLook ? " is-active" : ""}`} aria-pressed={!showLook} onClick={() => setAppearance(false)}>{t("inspector.action")}</button>
            <button type="button" className={`tab${showLook ? " is-active" : ""}`} aria-pressed={showLook} onClick={() => setAppearance(true)}>{t("inspector.look")}</button>
          </div>
        )}
        {onClose && <button type="button" className="icon-btn control-panel-close" title={t("profile.close")} aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button>}
      </div>

      <div className="trigger-row" role="group" aria-label={t("inspector.gesture")}>
        {(canGesture ? GESTURES : GESTURES.slice(0, 1)).map(([trigger, label]) => {
          const slot = controlId(selected.kind, selected.index, page, trigger);
          const binding = trigger === activeGesture ? draft : profile?.controls[slot];
          const def = view.catalog?.actions.find((item) => item.id === binding?.action);
          const display = def ? actionName(def) : binding?.action || t("inspector.dropAction");
          const title = trigger === "tap" ? t(turns ? "gesture.turnPress" : selected.kind === "faders" ? "gesture.slide" : selected.kind === "rollers" ? "gesture.turn" : label) : t(label);
          const current = activeGesture === trigger;
          return (
            <div key={trigger} data-trigger={trigger}
              className={`trigger-slot${current ? " is-selected" : ""}${draggedOver === trigger ? " is-drag-over" : ""}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(ACTION_MIME)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggedOver(trigger);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggedOver(null);
              }}
              onDrop={(event) => {
                const dropped = event.dataTransfer.getData(ACTION_MIME);
                if (!dropped) return;
                event.preventDefault();
                event.stopPropagation();
                setDraggedOver(null);
                if (onDropAction(selected, dropped, trigger)) {
                  setGesture(trigger);
                  setAppearance(false);
                }
              }}>
              <button type="button" className="trigger-choice" aria-pressed={current} onClick={() => { setGesture(trigger); setAppearance(false); }}>
                <span className="trigger-label">{title}</span>
                <span className="trigger-binding">
                  {def && <ActionIcon action={def} icons={view.icons} />}
                  <strong id={current && binding?.action ? "action-name" : undefined} data-action={current ? binding?.action : undefined} title={display}>{display}</strong>
                </span>
              </button>
              {binding?.action && profile && <button type="button" className="icon-btn trigger-clear" title={t("inspector.removeAction", { trigger: title })} aria-label={t("inspector.removeAction", { trigger: title })}
                onClick={async () => {
                  try {
                    await saver.flush();
                    await api.setBinding(profile.id, slot, null);
                  } catch (error) {
                    setWriteError(String(error));
                  }
                }}><Icon name="x" /></button>}
            </div>
          );
        })}
      </div>
      {writeError && <ToastMessage message={writeError} />}
      <div className="control-editor-body">
        <div className="control-action-pane" ref={actionPane} hidden={showLook}>
          {draft && <div className="sec control-fields">
            {draft.look.note && <p className="help" role="note">{draft.look.note.startsWith("demo:") ? t(`demo.${draft.look.note.slice(5)}` as Key) : draft.look.note}</p>}
            {draft.action && !action && view.catalog && <ToastMessage tone="warn" message={t("inspector.missing", { plugin: draft.action.split("/")[0] })} />}
            {basic.map((p) => (
            <ParamField
              key={p.key}
              def={p}
              value={draft.params[p.key]}
              view={view}
              siblings={draft.params}
              onChange={(v) => update({ ...draft, params: { ...draft.params, [p.key]: v }, look: { ...draft.look, label: namedLabel(draft, p.key, v, view) ?? draft.look.label } })}
              {...paramProps(p)}
              onPicked={(v, look) => update({ ...draft, params: { ...draft.params, [p.key]: v }, look: { ...draft.look, label: look.label, ...(look.image ? { image: look.image } : {}), ...(look.icon ? { icon: look.icon, image: undefined } : {}) } })}
            />
          ))}

      {/* a Stream Deck plugin's own settings page */}
      {draft && control && draft.action.includes("/") && <SdInspector key={`${control}|${draft.action}`} control={control} action={draft.action} settings={draft.params} />}
      {draft && selected && selected.kind !== "keys" && draft.action.includes("/") && action?.inputs.includes("turn") && (
        <label className="check" title={t("inspector.swapTurnsHelp")}>
          <input type="checkbox" checked={!!draft.swapTurns} onChange={(e) => update({ ...draft, swapTurns: e.target.checked || undefined }, 0)} />
          {t("inspector.swapTurns")}
        </label>
      )}

      {/* every rarely changed option in one place, also "speed up when turned fast" */}
      {draft && (advanced.length > 0 || canAccel) && (
        <details className="more-opts" open={!!draft.accel || advanced.some((p) => draft.params[p.key] !== undefined && JSON.stringify(draft.params[p.key]) !== JSON.stringify(p.default)) || undefined}>
          <summary>{t("inspector.moreOptions")}</summary>
          {advanced.map((p) => (
            <ParamField key={p.key} def={p} value={draft.params[p.key]} view={view} siblings={draft.params} onChange={(v) => update({ ...draft, params: { ...draft.params, [p.key]: v } })} />
          ))}
          {canAccel && (
            <label className="check">
              <input type="checkbox" checked={!!draft.accel} onChange={(e) => update({ ...draft, accel: e.target.checked || undefined }, 0)} />
              {t("inspector.accel")}
            </label>
          )}
        </details>
      )}

          </div>}
        </div>
      {draft && showLook && (
        <div className="control-look-pane" ref={lookPane}>
        <div className="sec">
      {draft && !hasScreen && activeGesture === "tap" && <ControlLook
          look={draft.look}
          led={selected.kind === "knobs" || selected.kind === "faders"}
          fromPreset={profile?.effects?.lights && profile.effects.theme && (!profile.effects.lightsTo || profile.effects.lightsTo.includes("controls")) ? themeTitle(profile.effects.theme) : null}
          onChange={(look) => update({ ...draft, look })}
        />}

      {selected.kind === "dial" && <DialLooks onPick={(look) => update({ ...draft, look })} />}
      {draft && hasScreen && activeGesture === "tap" && (
        <LookEditor
          key={control}
          program={draft.action === "core.launch" && /\.exe"?$/i.test(String(draft.params.target ?? "").trim()) ? String(draft.params.target) : undefined}
          look={draft.look}
          screen={selected.kind === "dial" ? "dial" : "key"}
          view={view}
          onChange={(look) => update({ ...draft, look })}
          others={selected.kind === "keys" ? otherKeys : []}
          onOpenStudio={selected.kind === "keys" && onOpenStudio && control ? async () => {
            await saver.flush();
            onOpenStudio(control);
          } : undefined}
          onApplyTo={(ids) => {
            if (!profile) return Promise.resolve();
            const changes = Object.fromEntries(ids.filter((id) => profile.controls[id]).map((id) => [id, { ...profile.controls[id], look: withLook(profile.controls[id].look ?? {}, draft.look ?? {}) }]));
            return api.setBindings(profile.id, changes);
          }}
        />
      )}

      {draft && hasScreen && activeGesture === "tap" && hasState(draft.action) && (
        <section className="field">
          <label className="check">
            <input type="checkbox" checked={!!draft.lookOn} onChange={(e) => update({ ...draft, lookOn: e.target.checked ? { ...draft.look, bg: "#7a1f24" } : undefined }, 0)} />
            {t("look.onOwn")}
          </label>
          <p className="help">{t("look.onHelp")}</p>
          {draft.lookOn && <LookEditor idPrefix="look-on" look={draft.lookOn} screen={selected.kind === "dial" ? "dial" : "key"} view={view} onChange={(lookOn) => update({ ...draft, lookOn })} />}
        </section>
      )}
        </div>
        </div>
      )}
      </div>
    </aside>
  );
}

/**
 * A key that goes to a page or a profile takes its name, while the label is still the action's own
 * word or an earlier such name ("Go" became "Games"; found by scripts/ui/tasks.mjs). None = keep.
 */
function namedLabel(draft: Binding, key: string, value: unknown, view: EngineView): string | undefined {
  const pages = view.profile?.pages ?? [];
  const profiles = view.state?.profiles ?? [];
  const nameOf = draft.action === "core.page" && key === "page" ? (id: unknown) => (id ? pages.find((x) => x.id === id)?.name : t("pages.main")) : draft.action === "core.profile" && key === "profile" ? (id: unknown) => profiles.find((x) => x.id === id)?.name : null;
  if (!nameOf) return undefined;
  const label = draft.look.label ?? "";
  const def = view.catalog?.actions.find((x) => x.id === draft.action);
  const auto = !label || (!!def && [newBinding(def), newBinding(localizeAction(def))].some((b) => b.look.label === label)) || label === nameOf(draft.params[key]);
  return auto ? nameOf(value) : undefined;
}
