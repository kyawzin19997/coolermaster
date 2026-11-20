import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleKind } from "../deck";
import { actionFits, type ActionDef, type EngineView } from "../engine";
import { groupName, localizeAction, t, useLanguage } from "../i18n";
import { ACTION_MIME } from "./DeckView";
import { Icon } from "./Icon";
import { defaultActionIcon } from "../actionIcons";

const GROUP_COLORS: Record<string, string> = {
  System: "#b6adfa", Media: "#71d8aa", Audio: "#7fcff5", OBS: "#f395a3",
  Spotify: "#75db9c", Twitch: "#c09afa", Streamlabs: "#77dfcd",
  "Home Assistant": "#79c1fa", MIDI: "#efbf78", Joystick: "#efa683",
};

const SEARCH_ALIASES: Record<string, string> = {
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

type ActionSource = Pick<EngineView, "icons" | "catalog">;

export function ActionIcon({ action, icons }: { action: ActionDef; icons: EngineView["icons"] }) {
  if (action.icon.startsWith("data:")) {
    return <span className="library-icon is-picture" aria-hidden="true"><img src={action.icon} alt="" /></span>;
  }
  const svg = defaultActionIcon(action.id) ?? icons.find((item) => item.name === action.icon)?.svg;
  const color = GROUP_COLORS[action.group] ?? Object.entries(GROUP_COLORS).find(([group]) => groupName(group) === action.group)?.[1] ?? "#aebce7";
  const style = { "--h": color } as React.CSSProperties;
  return svg ? <span className="library-icon" aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="library-icon" aria-hidden="true" style={style}><Icon name="plug" /></span>;
}

/** Keep the query, expanded groups and scroll position as controls are edited. */
export const ActionLibrary = memo(function ActionLibrary({
  catalog, icons, selectedKind, focusPlugin, disabled, onOpenPlugins,
}: ActionSource & {
  selectedKind?: ModuleKind;
  focusPlugin: { id: string; at: number } | null;
  disabled: boolean;
  onOpenPlugins?: () => void;
}) {
  const { lang } = useLanguage();
  const [query, setQuery] = useState("");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [hint, setHint] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const focusedGroup = useRef<HTMLElement>(null);
  const actions = useMemo(() => (catalog?.actions ?? []).map((original) => {
    const action = localizeAction(original);
    return { action, search: `${action.name} ${action.group} ${action.description} ${original.name} ${original.group} ${SEARCH_ALIASES[action.id] ?? ""}`.toLowerCase() };
  }), [catalog, lang]);
  const focusGroup = focusPlugin ? actions.find(({ action }) => action.id.startsWith(`${focusPlugin.id}/`))?.action.group : undefined;

  useEffect(() => {
    if (!focusGroup) return;
    setQuery("");
    setCompatibleOnly(false);
    setExpanded((current) => current.includes(focusGroup) ? current : [...current, focusGroup]);
    const frame = requestAnimationFrame(() => focusedGroup.current?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [focusGroup, focusPlugin?.at]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      if (!search.current?.getClientRects().length || search.current.closest("[inert]") || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      search.current.focus();
      search.current.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = actions.filter(({ action, search: text }) =>
    (!compatibleOnly || !selectedKind || actionFits(action, selectedKind)) && words.every((word) => text.includes(word)));
  const groups = new Map<string, ActionDef[]>();
  for (const { action } of matching) {
    const group = groups.get(action.group);
    if (group) group.push(action);
    else groups.set(action.group, [action]);
  }

  const actionRow = (action: ActionDef) => (
    <button
      key={action.id}
      type="button"
      className="library-item chooser-item"
      draggable
      title={action.description}
      onClick={() => setHint(true)}
      onDragStart={(event) => {
        event.dataTransfer.setData(ACTION_MIME, action.id);
        event.dataTransfer.effectAllowed = "copy";
        setHint(false);
      }}
    >
      <ActionIcon action={action} icons={icons} />
      <span className="nm">{action.name}</span>
      <Icon name="grip" className="action-grip" />
    </button>
  );

  return (
    <aside className="action-sidebar" aria-label={t("library.panelTitle")} inert={disabled}>
      <div className="chooser is-library">
        <div className="chooser-controls">
          <div className="chooser-head"><h2>{t("chooser.browseTitle")}</h2></div>
          <div className="search">
            <Icon name="search" />
            <input ref={search} id="library-search" className="input" aria-label={t("library.search")} aria-keyshortcuts="Control+K Meta+K" placeholder={t("library.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {query ? <button type="button" className="icon-btn search-clear" aria-label={t("library.clearSearch")} onClick={() => { setQuery(""); search.current?.focus(); }}><Icon name="x" /></button> : <kbd className="kbd search-key" aria-hidden="true">{navigator.userAgent.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>}
          </div>
          {selectedKind && <label className="check library-filter"><input type="checkbox" checked={compatibleOnly} onChange={(e) => setCompatibleOnly(e.target.checked)} />{t("library.compatibleShort")}</label>}
          <p className={`help chooser-browse${hint ? " is-nudged" : ""}`} role="status">{t("library.dragHint")}</p>
        </div>
        <div className="chooser-results">
          {!matching.length && words.length > 0 && <p className="help">{t("chooser.noMatch", { query: query.trim() })}</p>}
          {words.length > 0 ? (
            <div className="chooser-list">{matching.map(({ action }) => actionRow(action))}</div>
          ) : (
            <div className="chooser-groups">
              {[...groups].map(([group, items]) => {
                const open = expanded.includes(group);
                const image = catalog?.groupIcons?.[group];
                return (
                  <section key={group} className="chooser-group" ref={group === focusGroup ? focusedGroup : undefined}>
                    <button type="button" className="chooser-group-head" aria-expanded={open} onClick={() => setExpanded((current) => open ? current.filter((item) => item !== group) : [...current, group])}>
                      {image ? <span className="library-icon is-picture" aria-hidden="true"><img src={image} alt="" /></span> : <ActionIcon action={items[0]} icons={icons} />}
                      <span className="nm">{group}</span>
                      <Icon name={open ? "chevron-down" : "chevron-right"} />
                    </button>
                    {open && <div className="chooser-list">{items.map(actionRow)}</div>}
                  </section>
                );
              })}
            </div>
          )}
        </div>
        {onOpenPlugins && <div className="chooser-foot"><button type="button" className="link-btn" onClick={onOpenPlugins}><Icon name="plug" />{t("topbar.plugins")}</button></div>}
      </div>
    </aside>
  );
});
