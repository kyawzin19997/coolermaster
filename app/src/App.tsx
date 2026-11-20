import { iconPacks } from "./iconpacks";
import { ConfirmHost } from "./components/ConfirmHost";
import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import "./workspace.css";
import "./theme";
import { useDeck, type ControlRef } from "./deck";
import type { LeftTab } from "./components/Panels";
import { api, saverEnd, triedPresets, useEngine, useSaverShown } from "./engine";
import { DeckView } from "./components/DeckView";
import { Inspector, type InspectorHandle } from "./components/Inspector";
import { ActionLibrary } from "./components/ActionChooser";
import type { SettingsSection } from "./components/Panels";
import { ArrangePanel, Banner, ControlMenu, BaseTurnPicker, DeckTools, EdgePanel, SaverPanel, MusicPanel, ForAppPanel, GamesPanel, LeftPanel, PageBar, PluginFileSheet, ProfilePanel, SettingsPanel, Sheet, TopBar } from "./components/Panels";
import { listen } from "@tauri-apps/api/event";
import { askAssistant } from "./components/Assistant";
import { Icon } from "./components/Icon";
import { CalibrationPanel } from "./components/Calibration";
import { detachedKinds, placeModules, placementKey, usePlacements } from "./layout";
import { clearIdentify, identifyModule } from "./identify";
import { useEditing } from "./editing";
import { BUILT_IN_LANGUAGES, setLanguage, storedLanguageFile, t, useLanguage, type Key } from "./i18n";
import { demoParam } from "./demo/params";
import { open, told } from "./confirm";

const Builder = lazy(() => import("./components/Builder").then(({ Builder }) => ({ default: Builder })));
const DeckLook = lazy(() => import("./components/DeckLook").then(({ DeckLook }) => ({ default: DeckLook })));
const KeyStudio = lazy(() => import("./components/KeyStudio").then(({ KeyStudio }) => ({ default: KeyStudio })));
const PluginsTab = lazy(() => import("./components/PluginsTab").then(({ PluginsTab }) => ({ default: PluginsTab })));
const Tour = lazy(() => import("./components/Tour").then(({ Tour }) => ({ default: Tour })));

// `?demo&panel=profile|settings|plugins|calibrate` opens a side panel at start (screenshots)
const DEMO_PANEL = demoParam("panel");
// `&select=keys.6` (or `dial`, `knobs.1`...) selects that control at start
const DEMO_SELECT = demoParam("select");
type PluginFile = { path: string; update?: { id: string; name: string } };

export default function App() {
  const { lang } = useLanguage();
  // a language file picked last time: read it once (the window is in English until then)
  useEffect(() => {
    const code = storedLanguageFile();
    if (code && BUILT_IN_LANGUAGES[code]) BUILT_IN_LANGUAGES[code].load().then((file) => setLanguage(code, file), () => {});
    else if (code && "__TAURI_INTERNALS__" in window) api.languageFile(code).then((file) => setLanguage(code, file), () => {});
  }, []);
  // the deck shows some words itself (the dial gallery): in the window's language
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) api.languageSet(lang).catch(() => {});
  }, [lang]);
  const live = useDeck();
  const view = useEngine();
  const saverOn = !!useSaverShown();
  // using the window is using HubDeck: it ends a screensaver and keeps the next one from starting
  // (owner, 2026-10-30: the deck's screensaver ran on while he worked in the window, and Deck look
  // then showed it instead of the preset he tried); a touch is sent at most every 20 s while none runs
  const saverOnRef = useRef(saverOn);
  saverOnRef.current = saverOn;
  useEffect(() => {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (saverOnRef.current || now - last > 20_000) {
        last = now;
        saverEnd();
      }
    };
    window.addEventListener("pointerdown", touch, true);
    window.addEventListener("keydown", touch, true);
    return () => (window.removeEventListener("pointerdown", touch, true), window.removeEventListener("keydown", touch, true));
  }, []);
  const [selected, setSelected] = useState<ControlRef | null>(null);
  const inspector = useRef<InspectorHandle>(null);
  const [arranging, setArranging] = useState(false);
  const [profileOpen, setProfileOpen] = useState(DEMO_PANEL === "profile");
  const [calibrating, setCalibrating] = useState(DEMO_PANEL === "calibrate");
  const [gamesOpen, setGamesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(DEMO_PANEL === "settings" || DEMO_PANEL === "plugins");
  // the full key editor, on one key (owner's "2 a", 2026-10-25)
  const [studio, setStudio] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(DEMO_PANEL === "plugins" ? "plugins" : "general");
  const [updateCheckRequest, setUpdateCheckRequest] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(DEMO_PANEL === "catalog");
  // "Use it" in the Plugins tab: the deck, with the library open at that plugin's actions
  const [focusPlugin, setFocusPlugin] = useState<{ id: string; at: number } | null>(null);

  const [newRequest, setNewRequest] = useState(0);
  const [profileLibrary, setProfileLibrary] = useState<LeftTab | null>(null);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [forAppOpen, setForAppOpen] = useState(DEMO_PANEL === "forapp");
  // "Edge" under the drawing: this profile's lights (owner's pick 3a, 2026-10-16)
  const [edgeOpen, setEdgeOpen] = useState(false);
  const [livingOpen, setLivingOpen] = useState(false);
  // "Screensaver" under the deck, beside the living deck (owner, 2026-10-26)
  const [saverOpen, setSaverOpen] = useState(false);
  // "Music" under the deck, beside the screensaver (owner's "3 a", 2026-10-30)
  const [musicOpen, setMusicOpen] = useState(false);
  useEffect(() => {
    const open = () => (setSettingsOpen(false), setLivingOpen(false), setSaverOpen(false), setSelected(null), setMusicOpen(true));
    window.addEventListener("hubdeck:open-music", open);
    return () => window.removeEventListener("hubdeck:open-music", open);
  }, []);
  useEffect(() => {
    const open = () => (setSettingsOpen(false), setLivingOpen(false), setSelected(null), setSaverOpen(true));
    window.addEventListener("hubdeck:open-saver", open);
    return () => window.removeEventListener("hubdeck:open-saver", open);
  }, []);
  // a profile just made for an app: the inspector suggests next steps until something is picked
  const { saved, save } = usePlacements();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string, ms = 2500) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const { dropAction, moveKey, openControl, copy, pasteLook, clear, isSet, canPaste, opensPage } = useEditing(view, selected, notify);
  // a ready-made profile tried and left without Add (Back, or another profile picked) is thrown away
  const tried = useRef<string | null>(null);
  useEffect(() => {
    const now = view.state?.trying ?? null;
    const was = tried.current;
    tried.current = now;
    if (was && was !== now && triedPresets.has(was)) {
      triedPresets.delete(was);
      if (view.state?.profiles.some((p) => p.id === was && p.draft)) api.settleDraft(was, false).catch(() => {});
    }
  }, [view.state?.trying, view.state?.profiles]);
  // a control's right-click menu (owner's 1a, 2026-10-20)
  const [ctlMenu, setCtlMenu] = useState<{ c: ControlRef; x: number; y: number } | null>(null);
  // a control picked in the window is to be edited: whatever covers the inspector goes away
  const showInspector = () => {
    setLivingOpen(false);
    setSaverOpen(false);
    setMusicOpen(false);
    setProfileOpen(false);
    setSettingsOpen(false);
    setGamesOpen(false);

    setForAppOpen(false);
  };
  useEffect(() => {
    if (!DEMO_SELECT || selected) return;
    const [kind, index] = DEMO_SELECT.split(".");
    const m = live.deck.modules.find((x) => x.kind === kind);
    if (m) setSelected({ module: m.id, kind: m.kind, index: Number(index ?? 0) } as ControlRef);
  }, [live.deck.modules, selected]);
  // module kinds the user has (attached and owned), so presets come adapted to them
  const kinds = useMemo(() => [...new Set([...live.deck.modules.filter((m) => m.kind !== "base").map((m) => m.kind), ...detachedKinds(live.deck.modules, saved)])], [live.deck.modules, saved]);

  // "Build my deck step by step" (layout A): a page of its own
  const [builderOpen, setBuilderOpen] = useState(DEMO_PANEL === "builder");
  // the tour (show, then ask, then build): a page of its own
  const [tourOpen, setTourOpen] = useState(DEMO_PANEL === "tour" || DEMO_PANEL === "welcome" || demoParam("demo") === "welcome");
  // plugin files opened with HubDeck (a double click, Open with) or dropped on the window: one at a
  // time, each asked about before it installs
  const [pluginFiles, setPluginFiles] = useState<PluginFile[]>(DEMO_PANEL === "pluginfile" ? [{ path: "AudioSwitcher.streamDeckPlugin" }] : []);
  const choosePlugin = async (update?: PluginFile["update"]) => {
    try {
      const path = await open({ multiple: false, filters: [{ name: t("plugins.sdFile"), extensions: ["streamDeckPlugin", "zip"] }] });
      if (typeof path === "string") setPluginFiles((files) => [...files, { path, update }]);
    } catch {
      void told(t("plugins.pickFailed"));
    }
  };
  const openInstalledPlugins = () => {
    setPluginsOpen(false);
    setGamesOpen(false);
    setForAppOpen(false);
    setLivingOpen(false);
    setProfileOpen(false);
    setStudio(null);
    setSettingsSection("plugins");
    setSettingsOpen(true);
  };
  const usePlugin = (id: string) => {
    setPluginsOpen(false);
    setSettingsOpen(false);
    setStudio(null);
    setSelected(null);
    setFocusPlugin({ id, at: Date.now() });
  };
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // a Stream Deck icon pack (double click, Open with, dropped) goes in at once: pictures only
    const isPack = (p: string) => /\.streamdeckiconpack$/i.test(p);
    const addPacks = (files: string[]) => {
      for (const f of files.filter(isPack)) iconPacks.install(f).then((p) => notify(t("icons.packAdded", { name: p.name }), 6000), (e) => notify(String(e)));
    };
    const add = (all: string[]) => {
      addPacks(all);
      const files = all.filter((f) => !isPack(f));
      if (files.length > 0) setPluginFiles((now) => [...now, ...files.filter((f) => !now.some(({ path }) => path === f)).map((path) => ({ path }))]);
    };
    const take = () => api.sdOpened().then(add, () => {});
    take();
    const none = () => () => {};
    const offOpened = listen("engine://plugin-file", take).catch(none);
    const isPlugin = (p: string) => /\.(streamdeckplugin|streamdeckiconpack|zip)$/i.test(p);
    // a plugin file dropped on the window, through the window's own drag and drop: the system's
    // (Tauri's dragDropEnabled) stops actions being dragged onto keys on Windows (owner found it,
    // 2026-10-18), so the file's bytes go to the engine, which keeps them in a temp file
    const files = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setDropping(true);
    };
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (files(e) && --depth <= 0) (depth = 0), setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      for (const f of [...(e.dataTransfer?.files ?? [])].filter((f) => isPlugin(f.name))) {
        f.arrayBuffer().then((b) => api.sdDropFile(f.name, new Uint8Array(b))).then((path) => add([path]), (error) => notify(String(error)));
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    const offDrop = Promise.resolve(() => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    });
    return () => {
      offOpened.then((f) => f());
      offDrop.then((f) => f());
    };
  }, []);
  const setupPending = !!view.state && !view.state.onboarded;
  const tourShown = tourOpen && !arranging && !builderOpen;
  // leaving arrange mode confirms every module as it is shown, touched or not
  const toggleArrange = () => {
    if (arranging) {
      for (const p of placeModules(live.deck.modules, saved)) {
        const key = placementKey(p.module);
        if (key && p.source !== "user") save(key, { col: p.col, row: p.row, rotation: p.rotation });
      }
    }
    setArranging(!arranging);
  };

  // while arranging, mark every control on the hardware (numbers, arrow, LED colors);
  // when arranging ends the engine draws the profile again
  const moduleIds = live.deck.modules.map((m) => m.id).join(",");
  useEffect(() => {
    if (!arranging) {
      // LEDs back to the default effect; keys and dial are redrawn by the engine
      live.deck.modules.filter((m) => m.kind === "knobs" || m.kind === "faders").forEach((m) => clearIdentify(m).catch(() => {}));
      if ("__TAURI_INTERNALS__" in window) api.redraw().catch(() => {});
      return;
    }
    live.deck.modules.forEach((m) => identifyModule(m).catch((e) => console.error("identify", m.id, e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arranging, moduleIds]);

  // touching a control on the hardware selects it, so you can find a key by pressing it
  useEffect(() => {
    if (live.lastTouched) {
      const touched = live.lastTouched;
      // after the deck's drawing: the control's panel is heavy and the first move of a fader
      // waited for it (2026-10-15)
      startTransition(() => {
        setSelected(touched);
        setProfileOpen(false);
      });
    }
  }, [live.lastTouched]);

  // "Show" on the made-by-itself banner: the profile list was often open already, so the click
  // looked dead (owner, 2026-10-22); bring the first new profile into view and light it once
  const showProfiles = (ids: string[]) => {
    setProfileLibrary("profiles");
    window.setTimeout(() => {
      const row = ids.map((id) => document.querySelector<HTMLElement>(`.prow[data-profile="${CSS.escape(id)}"]`)).find(Boolean);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.remove("is-shown");
      void row.offsetWidth; // restart the glow on a second click
      row.classList.add("is-shown");
    }, 50);
  };

  return (
    <div className="app">
      <TopBar
        kinds={kinds}
        newRequest={newRequest}
        live={live}
        view={view}
        onOpenProfile={() => (setProfileOpen((o) => !o), setSettingsOpen(false))}

        onOpenForApp={() => (setForAppOpen(true), setSettingsOpen(false), setProfileOpen(false))}
        onOpenProfileLibrary={() => setProfileLibrary("profiles")}
        onOpenAssistant={() => setProfileLibrary("assistant")}
        onOpenTour={() => (setTourOpen(true), setPluginsOpen(false), setStudio(null), setLivingOpen(false), setSettingsOpen(false), setForAppOpen(false), setProfileOpen(false))}
        setupPending={setupPending && !tourOpen && !builderOpen}
        onOpenSettings={() => (setUpdateCheckRequest(0), setSettingsOpen((o) => !o), setPluginsOpen(false), setGamesOpen(false), setForAppOpen(false))}
        onCheckUpdates={tourShown || builderOpen || calibrating || arranging || studio ? undefined : () => {
          setPluginsOpen(false);
          setGamesOpen(false);
          setForAppOpen(false);
          setProfileOpen(false);
          setLivingOpen(false);
          setSettingsSection("updates");
          setSettingsOpen(true);
          setUpdateCheckRequest((n) => n + 1);
        }}
        onOpenPlugins={() => settingsOpen && settingsSection === "plugins" ? setSettingsOpen(false) : openInstalledPlugins()}
        onOpenGames={() => (setGamesOpen((o) => !o), setSettingsOpen(false))}
      />
      <Banner
        live={live}
        view={view}
        onOpenProfiles={showProfiles}
        onOpenConnections={() => (setSettingsSection("connections"), setSettingsOpen(true))}
      />
      <Suspense fallback={<main className="workspace workspace-loading" role="status">{t("app.loadingPanel")}</main>}>
      {tourShown ? (
        <main className="workspace">
          <Tour
            live={live}
            view={view}
            saved={saved}
            onPlace={save}
            deskCheck={setupPending}
            onArrange={toggleArrange}
            onClose={() => setTourOpen(false)}
            onBuild={() => (setTourOpen(false), setBuilderOpen(true))}
            onAsk={(message) => (setTourOpen(false), setProfileLibrary("assistant"), askAssistant(message))}
          />
        </main>
      ) : builderOpen ? (
        <main className="workspace">
          <Builder live={live} view={view} saved={saved} onPlace={save} onClose={() => setBuilderOpen(false)} />
        </main>
      ) : pluginsOpen ? (
        <main className="workspace">
          <PluginsTab onClose={() => setPluginsOpen(false)} onManage={openInstalledPlugins} onPickFile={choosePlugin} onUse={usePlugin} />
        </main>
      ) : studio ? (
        <main className="workspace">
          <KeyStudio key={`${view.profile?.id}/${studio}`} view={view} control={studio} onClose={() => setStudio(null)} />
        </main>
      ) : livingOpen && !calibrating && !arranging ? (
        // the Deck look view over the whole window (owner, 2026-10-28: "edycja może powinna być w dedykowanym oknie")
        <main className="workspace">
          <DeckLook
            view={view}
            keysModule={[...live.deck.modules].filter((m) => m.kind === "keys").sort((a, b) => (a.first ?? 0) - (b.first ?? 0))[0]?.id}
            keysCount={Math.max(15, ...live.deck.modules.filter((m) => m.kind === "keys").map((m) => (m.first ?? 0) + 15))}
            keysTurn={(placeModules(live.deck.modules, saved).find((p) => p.module.kind === "keys")?.rotation ?? 0) + live.deck.turn}
            onClose={() => setLivingOpen(false)}
          />
        </main>
      ) : settingsOpen && !calibrating ? (
        <main className="workspace">
          <SettingsPanel
            live={live} view={view} section={settingsSection} updateCheckRequest={updateCheckRequest}
            onSection={(section) => { setUpdateCheckRequest(0); setSettingsSection(section); }}
            onClose={() => { setUpdateCheckRequest(0); setSettingsOpen(false); }}
            onCalibrate={() => { setCalibrating(true); setSettingsOpen(false); }}
            onBrowsePlugins={() => { setPluginsOpen(true); setSettingsOpen(false); }}
            onPickPlugin={choosePlugin}
            onUsePlugin={usePlugin}
            onOpenEdge={() => setEdgeOpen(true)}
            onOpenScenes={() => { setSaverOpen(false); setMusicOpen(false); setLivingOpen(true); }}
          />
        </main>
      ) : (
      <main className={`workspace deck-workspace${arranging ? " is-arranging" : ""}${selected && !arranging && !calibrating ? " workspace-with-properties" : ""}`}>
        <section className="center">
          <div className="workbench-title">
            <h1>MasterHUB</h1>
            {!arranging && live.deck.modules.some((m) => m.kind === "keys") && <PageBar view={view} />}
            <span className="spacer" />
            {arranging ? (
              <button className="tool primary layout-tool" onClick={toggleArrange}>
                <Icon name={arranging ? "check" : "layout-grid"} />
                {t("stage.doneLayout")}
              </button>
            ) : <>
            <button type="button" className="tool ghost" onClick={() => { setSettingsSection("lights"); setSettingsOpen(true); }}><Icon name="sun" />{t("settings.lighting")}</button>
            <DeckTools
              canArrange={live.deck.modules.length > 0}
              modulesOpen={modulesOpen}
              onModules={() => setModulesOpen((open) => !open)}
              onArrange={toggleArrange}
              onBuild={() => setBuilderOpen(true)}
            /></>}
          </div>
          {(view.state?.trying || saverOn) && <div className="stage-bar">
            {/* a draft the assistant or the user put on the deck for a try: say so, and the way back */}
            {view.state?.trying && (
              <span className="chip is-trying" role="status">
                <Icon name="play" />
                {view.state.comparing
                  ? t("assistant.comparingBar", { n: view.state.comparing[0], count: view.state.comparing[1] })
                  : t("assistant.tryingBar", { name: view.state.profiles.find((p) => p.id === view.state?.trying)?.name ?? "" })}
                {triedPresets.has(view.state.trying) && (
                  <button className="link-btn" onClick={() => {
                      // out of the tried set first: the end of the try must not throw it away
                      const id = view.state!.trying!;
                      triedPresets.delete(id);
                      api.settleDraft(id, true).catch((e) => notify(String(e)));
                    }}>
                    {t("stage.addProfile")}
                  </button>
                )}
                <button className="link-btn" onClick={() => api.tryProfile(null)}>
                  {t("assistant.back")}
                </button>
              </span>
            )}
            {/* the deck shows its screensaver; the window shows the keys, says so, and can end it */}
            {saverOn && (
              <span className="chip" role="status">
                <Icon name="sparkles" />
                {t("stage.saverOn")}
                <button className="link-btn" onClick={() => saverEnd()}>
                  {t("stage.saverEnd")}
                </button>
              </span>
            )}
          </div>}
          <div className="deck-area">
          <DeckView
            live={live}
            selected={selected}
            onSelect={(c) => {
              setSelected(c);
              showInspector();
              // a click on the deck in the window is a touch: the screensaver ends
              if (saverOn) saverEnd();
            }}
            saved={saved}
            onPlace={save}
            arranging={arranging}
            onEdge={() => setEdgeOpen(true)}
            showShelf={modulesOpen}
            showStrip={false}
            onDeselect={() => setSelected(null)}
            profile={view.profile}
            page={view.state?.page ?? null}
            onDropAction={(c, action) => {
              if (dropAction(c, action, "tap", () => inspector.current?.flush())) {
                inspector.current?.selectTrigger("tap");
                setSelected(c);
              }
            }}
            onMoveKey={(from, to) => {
              moveKey(from, to);
              setSelected(to);
            }}
            onOpenControl={openControl}
            onControlMenu={(c, x, y) => setCtlMenu({ c, x, y })}
          />
          {ctlMenu && (
            <ControlMenu
              title={`${t(`control.${ctlMenu.c.kind}` as Key)}${ctlMenu.c.kind === "dial" && ctlMenu.c.index === 0 ? "" : ` ${ctlMenu.c.index + 1}`}`}
              x={ctlMenu.x}
              y={ctlMenu.y}
              isSet={isSet(ctlMenu.c)}
              canPaste={canPaste()}
              opensPage={opensPage(ctlMenu.c)}
              onCopy={() => copy(ctlMenu.c)}

              onPasteLook={() => pasteLook(ctlMenu.c)}
              onClear={() => clear(ctlMenu.c)}
              onOpenPage={() => openControl(ctlMenu.c)}
              onClose={() => setCtlMenu(null)}
            />
          )}
          {arranging && <BaseTurnPicker live={live} />}
          </div>
          {toast && (
            <div className="toast" role="status">
              {toast}
            </div>
          )}
        </section>
        {!arranging && !calibrating && selected && (
          <Inspector
            ref={inspector} selected={selected} view={view} onClose={() => setSelected(null)}
            onDropAction={(control, action, gesture) => dropAction(control, action, gesture, () => inspector.current?.flush())}
            onOpenStudio={setStudio}
          />
        )}
        <div className="editor-sidebar" hidden={arranging || calibrating}>
          <ActionLibrary catalog={view.catalog} icons={view.icons} selectedKind={selected?.kind} focusPlugin={focusPlugin} disabled={arranging || calibrating} onOpenPlugins={openInstalledPlugins} />
        </div>
        {calibrating ? (
          <CalibrationPanel onClose={() => setCalibrating(false)} />
        ) : arranging ? (
          <ArrangePanel onDone={toggleArrange} live={live} saved={saved} onPlace={save} />
        ) : null}
      </main>
      )}
      </Suspense>
      {profileLibrary && !tourShown && (
        <Sheet label={t("profiles.title")} onClose={() => setProfileLibrary(null)}>
          <div className="profile-library-sheet">
            <div className="profile-library-header">
              <h2>{t("profiles.title")}</h2>
              <button type="button" className="tool ghost icon-only" aria-label={t("profile.close")} onClick={() => setProfileLibrary(null)}><Icon name="x" /></button>
            </div>
            <LeftPanel
              view={view}
              tab={profileLibrary}
              onTab={setProfileLibrary}
              onBuild={() => (setProfileLibrary(null), setBuilderOpen(true))}
              onTour={() => (setProfileLibrary(null), setTourOpen(true), setSettingsOpen(false))}
              onNewProfile={() => (setProfileLibrary(null), setNewRequest((n) => n + 1))}
              onOpenProfile={() => (setProfileLibrary(null), setProfileOpen(true), setSettingsOpen(false), setForAppOpen(false))}
            />
          </div>
        </Sheet>
      )}
      {!tourShown && !arranging && !calibrating && (saverOpen || musicOpen) && (
        <Sheet label={t(saverOpen ? "saver.title" : "music.chip")} onClose={() => (setSaverOpen(false), setMusicOpen(false))}>
          {saverOpen ? <SaverPanel view={view} onClose={() => setSaverOpen(false)} /> : <MusicPanel onClose={() => setMusicOpen(false)} />}
        </Sheet>
      )}
      {/* panels open over the window, so a touch on a control still shows its editor (docs/FLOWS.md, difference 4) */}
      {!tourShown && !arranging && !calibrating && (forAppOpen || gamesOpen || profileOpen || edgeOpen) && (
        <Sheet onClose={() => (setForAppOpen(false), setGamesOpen(false), setProfileOpen(false), setEdgeOpen(false))}>
          {edgeOpen ? (
            <EdgePanel view={view} onClose={() => setEdgeOpen(false)} onAll={() => (setEdgeOpen(false), setSettingsSection("lights"), setSettingsOpen(true))} />
          ) : forAppOpen ? (
            <ForAppPanel view={view} kinds={kinds} onClose={() => setForAppOpen(false)} onMade={() => (setForAppOpen(false), setSelected(null))} />
          ) : gamesOpen ? (
            <GamesPanel view={view} onClose={() => setGamesOpen(false)} />
          ) : (
            <ProfilePanel view={view} onClose={() => setProfileOpen(false)} />
          )}
        </Sheet>
      )}
      <ConfirmHost />
      {pluginFiles.length > 0 && <PluginFileSheet key={pluginFiles[0].path} path={pluginFiles[0].path} update={pluginFiles[0].update} onUse={usePlugin} onManage={openInstalledPlugins} onClose={() => setPluginFiles((now) => now.slice(1))} />}
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="plug" />
          {t("plugins.dropHere")}
        </div>
      )}
    </div>
  );
}
