import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ModuleKind } from "../deck";
import { actionFits, type ActionDef, type Binding, type EngineView, type Gesture, newPluginIds, onNewPlugins, pluginGroup } from "../engine";
import { groupName as localizeGroup, localizeAction, t, useLanguage, type Key } from "../i18n";
import { Icon } from "./Icon";
import { ACTION_MIME } from "./DeckView";
import { ideasIn, type Idea } from "../ideas";
import { getLanguage } from "../i18n";

/** One hue per action group for the icon tiles (by the English group name). */
const GROUP_HUES: Record<string, string> = {
  System: "#8b7cf6",
  Media: "#3ecf8e",
  Audio: "#38bdf8",
  OBS: "#f0506e",
  Spotify: "#1ed760",
  Twitch: "#a970ff",
  Streamlabs: "#80f5d2",
  "Home Assistant": "#41bdf5",
  MIDI: "#f5a524",
  Joystick: "#f97316",
  HubDeck: "#b2a6ff",
};
export const groupHue = (group: string) => GROUP_HUES[group] ?? Object.entries(GROUP_HUES).find(([g]) => localizeGroup(g) === group)?.[1] ?? "#b2a6ff";

type ActionSource = Pick<EngineView, "icons" | "catalog">;

/** What most people give each kind of control first (only the ones that exist and fit are shown). */
const FIRST_PICKS: Record<ModuleKind | "press", string[]> = {
  keys: ["core.launch", "core.hotkey", "core.mic", "core.media", "core.page", "core.clock"],
  dial: ["core.volume", "core.nowPlaying", "core.media", "core.clock", "core.brightness", "core.scroll"],
  knobs: ["core.volume", "core.brightness", "core.scroll", "core.media", "core.mic", "core.lighting"],
  faders: ["core.volume", "core.brightness", "core.deckBrightness", "core.lighting", "obs.volume", "midi.cc"],
  rollers: ["core.volume", "core.scroll", "core.media", "core.brightness", "core.seek", "core.lighting"],
  base: [],
  press: ["core.launch", "core.hotkey", "core.mic", "core.media", "core.page", "core.profile"],
};

/**
 * Other words people search with: the names HubDeck used before and the ones other decks use
 * (owner, 2026-10-16: names as in the most popular decks; the old ones still find the action).
 */
const ALSO_CALLED: Record<string, string> = {
  "core.launch": "open app file website url application program otwórz aplikację plik lub stronę",
  "core.media": "media control play pause next track previous sterowanie multimediami",
  "core.text": "type text wpisz tekst",
  "core.multi": "multi-action macro sequence sekwencja akcji makro",
  "core.toggle": "toggle hotkey switch on off przełącznik",
  "core.sound": "play sound soundboard odtwórz dźwięk",
  "core.page": "folder page strona",
  "core.nextPage": "page folder strona",
  "core.previousPage": "page folder back strona wstecz",
};

/** An action's icon tile: a plugin's own picture, else the icon in its group's hue. */
export function ActionIcon({ action, view }: { action: ActionDef; view: ActionSource }) {
  if (action.icon.startsWith("data:"))
    return (
      <span className="library-icon is-picture" aria-hidden="true">
        <img src={action.icon} alt="" />
      </span>
    );
  const icon = view.icons.find((i) => i.name === action.icon);
  return <span className="library-icon" aria-hidden="true" style={{ "--h": groupHue(action.group) } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: icon?.svg ?? "" }} />;
}

const NO_BINDINGS: Binding[] = [];

/** Browsing state belongs to this pane, independent of control selection and binding edits. */
export const ActionLibrary = memo(function ActionLibrary({
  catalog, icons, selectedKind, focusPlugin, disabled, onOpenPlugins,
}: ActionSource & {
  selectedKind?: ModuleKind;
  focusPlugin: { id: string; at: number } | null;
  disabled: boolean;
  onOpenPlugins?: () => void;
}) {
  const { lang } = useLanguage();
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  // "Use it" should reveal the plugin's complete action list.
  useEffect(() => {
    if (focusPlugin) setCompatibleOnly(false);
  }, [focusPlugin]);
  const all = useMemo(() => (catalog?.actions ?? []).map(localizeAction), [catalog, lang]);
  const kind = compatibleOnly ? selectedKind : undefined;
  const fitting = useMemo(() => kind ? all.filter((a) => actionFits(a, kind)) : all, [all, kind]);
  const focusGroup = focusPlugin ? all.find((a) => a.id.startsWith(`${focusPlugin.id}/`))?.group : undefined;

  return (
    <aside className="action-sidebar" aria-label={t("library.panelTitle")} inert={disabled}>
      <ActionChooser
        view={{ catalog, icons }}
        kind={selectedKind ?? "keys"}
        gesture="tap"
        fitting={fitting}
        others={NO_BINDINGS}
        browse
        onOpenPlugins={onOpenPlugins}
        focusGroup={focusGroup}
        focusRequest={focusPlugin?.at}
        filter={selectedKind && (
          <label className="check library-filter">
            <input type="checkbox" checked={!!kind} aria-label={t("library.compatible")} onChange={(e) => setCompatibleOnly(e.target.checked)} />
            {t("library.compatibleShort")}
          </label>
        )}
      />
    </aside>
  );
});

/**
 * "What should it do?": the one place an action is chosen (owner's pick 1a, 2026-10-16, variant A
 * of docs/FLOWS.md): a search, the first picks for this kind of control, what this deck already
 * does elsewhere, then every group. Only actions that fit the control are offered.
 */
export function ActionChooser({
  view,
  kind,
  gesture,
  fitting,
  current,
  others,
  onPick,
  onCopy,
  onClear,
  onCancel,
  onOpenPlugins,
  browse,
  onIdea,
  focusGroup,
  focusRequest,
  filter,
}: {
  /** Open this group and show it first, with a hint to drag (a plugin's "Use it"). */
  focusGroup?: string | null;
  focusRequest?: number;
  filter?: ReactNode;
  /** A key's ideas from other deck owners were picked (shown on keys only). */
  onIdea?: (idea: Idea) => void;
  view: ActionSource;
  kind: ModuleKind;
  /** Nothing is selected: every action, to drag onto a control (owner's pick 1a, 2026-10-16). */
  browse?: boolean;
  gesture: Gesture;
  /** The actions that fit this control and gesture, translated. */
  fitting: ActionDef[];
  current?: string;
  /** What other controls of this deck do (copied as they are). */
  others: Binding[];
  onPick?: (def: ActionDef) => void;
  onCopy?: (b: Binding) => void;
  onClear?: () => void;
  onCancel?: () => void;
  onOpenPlugins?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string[]>(focusGroup ? [focusGroup] : []);
  const focusRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterHint = useId();
  useEffect(() => {
    if (!focusGroup) return;
    setOpen((o) => (o.includes(focusGroup) ? o : [focusGroup, ...o]));
    setQuery("");
    const frame = requestAnimationFrame(() => focusRef.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focusGroup, focusRequest]);
  useEffect(() => {
    if (!browse) return;
    const focusSearch = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k" || !searchRef.current?.getClientRects().length) return;
      if (searchRef.current.closest("[inert]") || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [browse]);
  // plugins installed in this session marked New; where they are, at the bottom
  const [fresh, setFresh] = useState(() => [...newPluginIds()]);
  useEffect(() => onNewPlugins(() => setFresh([...newPluginIds()])), []);
  const freshGroups = useMemo(() => new Set(fresh.map((id) => pluginGroup(view.catalog?.actions ?? [], id))), [fresh, view.catalog]);
  // browsing: a click cannot give an action to nothing, so the hint says to drag it (lit 2 s)
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(nudgeTimer.current), []);
  const choose = (a: ActionDef) => {
    if (!browse) return onPick?.(a);
    setNudged(true);
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => setNudged(false), 2000);
  };
  const q = query.trim().toLowerCase();
  const raw = useMemo(() => new Map((view.catalog?.actions ?? []).map((a) => [a.id, a])), [view.catalog]);
  const { groups, byId, searchText } = useMemo(() => {
    const groups = new Map<string, ActionDef[]>();
    const byId = new Map<string, ActionDef>();
    const searchText = new Map<string, string>();
    for (const a of fitting) {
      const group = groups.get(a.group);
      if (group) group.push(a);
      else groups.set(a.group, [a]);
      byId.set(a.id, a);
      const original = raw.get(a.id);
      searchText.set(a.id, `${a.name} ${a.group} ${a.description} ${original?.name ?? ""} ${original?.group ?? ""} ${ALSO_CALLED[a.id] ?? ""}`.toLowerCase());
    }
    return { groups, byId, searchText };
  }, [fitting, raw]);
  const firsts = (browse ? [] : FIRST_PICKS[gesture === "tap" ? kind : "press"]).map((id) => byId.get(id)).filter((a): a is ActionDef => !!a);
  // a plugin's group: its own picture (Stream Deck's CategoryIcon), else its first action's
  const groupPicture = (g: string, items: ActionDef[]) => view.catalog?.groupIcons?.[g] ?? (items[0]?.icon.startsWith("data:") ? items[0].icon : null);
  const nameOf = (b: Binding) => {
    const def = raw.get(b.action);
    return b.look.label || (def ? localizeAction(def).name : b.action);
  };
  // every action can also be dragged onto any control of the drawing, as in other decks' apps
  // (owner's pick 2a, 2026-10-16)
  const drag = (a: ActionDef) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(ACTION_MIME, a.id);
      e.dataTransfer.effectAllowed = "copy";
    },
  });
  const row = (a: ActionDef) => (
    <button key={a.id} type="button" {...drag(a)} className={`library-item chooser-item${current === a.id ? " is-current" : ""}`} title={a.description} aria-describedby={browse ? filterHint : undefined} onClick={() => choose(a)}>
      <ActionIcon action={a} view={view} />
      <span className="nm">{a.name}</span>
      {current === a.id && <span className="tail">✓</span>}
      {browse && <Icon name="grip" className="action-grip" />}
    </button>
  );
  const found = q ? fitting.filter((a) => searchText.get(a.id)?.includes(q)) : [];
  return (
    <div className={`chooser${browse ? " is-library" : ""}`} data-guide={browse ? undefined : "chooser"}>
      <div className="chooser-controls">
      <div className="chooser-head">
        {browse ? (
          <h2>{t("chooser.browseTitle")}</h2>
        ) : <span className="label">{t("chooser.title")}</span>}
        {onCancel && (
          <button type="button" className="link-btn" onClick={onCancel}>
            {t("chooser.cancel")}
          </button>
        )}
      </div>
      <div className="search">
        <Icon name="search" />
        <input ref={searchRef} id={browse ? "library-search" : "action-search"} className="input" placeholder={browse ? t("library.search") : t("chooser.search", { count: fitting.length })} aria-label={t("library.search")} aria-keyshortcuts={browse ? "Control+K Meta+K" : undefined} value={query} onChange={(e) => setQuery(e.target.value)} />
        {browse && (query ? (
          <button type="button" className="icon-btn search-clear" aria-label={t("library.clearSearch")} onClick={() => (setQuery(""), searchRef.current?.focus())}><Icon name="x" /></button>
        ) : <kbd className="kbd search-key" aria-hidden="true">{navigator.userAgent.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>)}
      </div>
      {filter}
      {browse && <p id={filterHint} className={`help chooser-browse${nudged ? " is-nudged" : ""}`}>{t("library.dragHint")}</p>}
      </div>
      <div className="chooser-results">
      {q ? (
        <div className="chooser-list">
          {found.map(row)}
          {found.length === 0 && <p className="help">{t("chooser.noMatch", { query: query.trim() })}</p>}
        </div>
      ) : (
        <>
          {firsts.length > 0 && (
            <>
              <span className="sub-label">{t(gesture === "tap" ? (`chooser.for.${kind}` as Key) : "chooser.for.press")}</span>
              <div className="chooser-firsts">
                {firsts.map((a) => (
                  <button key={a.id} type="button" {...drag(a)} className={`chooser-tile${current === a.id ? " is-current" : ""}`} title={a.description} onClick={() => choose(a)}>
                    <ActionIcon action={a} view={view} />
                    <span className="nm">{a.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {onIdea && kind === "keys" && gesture === "tap" && !browse && (
            <>
              <span className="sub-label">{t("chooser.fromOthers")}</span>
              <div className="chips-row">
                {ideasIn(getLanguage()).map((idea) => (
                  <button key={idea.id} type="button" className="chip" title={idea.why} onClick={() => onIdea(idea)}>
                    {idea.binding.look.label}
                    {idea.hold && <span className="chip-note">{t("chooser.onHold")}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          {others.length > 0 && (
            <>
              <span className="sub-label">{t("chooser.onDeck")}</span>
              <div className="chips-row">
                {others.map((b, i) => (
                  <button key={`${b.action}${i}`} type="button" className="chip" title={t("chooser.copy")} onClick={() => onCopy?.(b)}>
                    {nameOf(b)}
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="sub-label">
            {t("chooser.all")}
            <span className="n">{fitting.length}</span>
          </span>
          <div className="chooser-groups">
            {[...groups].map(([g, items]) => {
              const isOpen = open.includes(g);
              return (
                <section key={g} className={`chooser-group${g === focusGroup ? " is-focus" : ""}`} ref={g === focusGroup ? focusRef : undefined}>
                  <button type="button" className="chooser-group-head" aria-expanded={isOpen} onClick={() => setOpen((o) => (isOpen ? o.filter((x) => x !== g) : [...o, g]))}>
                    {groupPicture(g, items) ? (
                      <span className="library-icon is-picture" aria-hidden="true">
                        <img src={groupPicture(g, items)!} alt="" />
                      </span>
                    ) : (
                      <span className="library-icon" aria-hidden="true" style={{ "--h": groupHue(g) } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: view.icons.find((i) => i.name === items[0]?.icon)?.svg ?? "" }} />
                    )}
                    <span className="nm">{g}</span>
                    {freshGroups.has(g) && <span className="pill is-new">{t("chooser.new")}</span>}
                    <span className="n">{items.length}</span>
                    <Icon name={isOpen ? "chevron-down" : "chevron-right"} />
                  </button>
                  {/* an arrow toward the deck, nudging a few times: where the actions go (owner, 2026-10-18) */}
                  {isOpen && g === focusGroup && (
                    <p className="help chooser-focus-hint">
                      <span className="focus-arrow" aria-hidden="true">
                        <Icon name="chevron-left" />
                      </span>
                      {t("chooser.focusHint")}
                    </p>
                  )}
                  {isOpen && <div className="chooser-list">{items.map(row)}</div>}
                </section>
              );
            })}
          </div>
        </>
      )}
      </div>
      <div className="row wrap chooser-foot">
        {onClear && (
          <button type="button" className="link-btn" onClick={onClear}>
            {t("chooser.clear")}
          </button>
        )}
        {onOpenPlugins && (
          <button type="button" className="link-btn" onClick={onOpenPlugins}>
            <Icon name="plug" />
            {t(browse ? "library.browsePlugins" : "library.morePlugins")}
          </button>
        )}
      </div>
    </div>
  );
}
