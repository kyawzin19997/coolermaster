import { Notice } from "./components/Notice";
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
import type { DeckDisplaySection, SettingsSection } from "./components/Panels";
import {
  AppPageHeader, ArrangePanel, BaseTurnPicker, ControlMenu, DeckDisplayPanel, DeckTools, ForAppPanel, GamesPanel,
  LeftPanel, Notifications, PageBar, PluginFileSheet, PluginsPage, ProfilePanel, SettingsPage, Sheet, TopBar, UpdatesPage, keepImported,
} from "./components/Panels";
import { PhoneUpload } from "./components/PhoneUpload";
import { listen } from "@tauri-apps/api/event";
import { askAssistant } from "./components/Assistant";
import { Icon } from "./components/Icon";
import { WorkspaceGuide, type GuideKind } from "./components/WorkspaceGuide";
import { CalibrationPanel } from "./components/Calibration";
import { detachedKinds, placeModules, placementKey, usePlacements } from "./layout";
import { clearIdentify, identifyModule } from "./identify";
import { useEditing } from "./editing";
import { BUILT_IN_LANGUAGES, setLanguage, storedLanguageFile, t, useLanguage, type Key } from "./i18n";
import { demoParam } from "./demo/params";
import { askInWindow, open, told } from "./confirm";

const Builder = lazy(() => import("./components/Builder").then(({ Builder }) => ({ default: Builder })));
const DeckLook = lazy(() => import("./components/DeckLook").then(({ DeckLook }) => ({ default: DeckLook })));
const KeyStudio = lazy(() => import("./components/KeyStudio").then(({ KeyStudio }) => ({ default: KeyStudio })));
const PluginsTab = lazy(() => import("./components/PluginsTab").then(({ PluginsTab }) => ({ default: PluginsTab })));
const Tour = lazy(() => import("./components/Tour").then(({ Tour }) => ({ default: Tour })));

// `?demo&panel=profile|settings|plugins|catalog|updates|calibrate` opens a view at start (screenshots)
const DEMO_PANEL = demoParam("panel");
// `&select=keys.6` (or `dial`, `knobs.1`...) selects that control at start
const DEMO_SELECT = demoParam("select");
type PluginFile = { path: string; update?: { id: string; name: string } };
type AppPage = "settings" | "plugins" | "catalog" | "updates";

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
  const shownSaver = useSaverShown();
  const saverOn = !!shownSaver;
  // using the window is using MasterDeck: it ends a screensaver and keeps the next one from starting
  // (owner, 2026-10-30: the deck's screensaver ran on while he worked in the window, and Deck look
  // then showed it instead of the preset he tried); a touch is sent at most every 20 s while none runs
  const saverOnRef = useRef(shownSaver);
  saverOnRef.current = shownSaver;
  useEffect(() => {
    let last = 0;
    const touch = (event: Event) => {
      const target = event.target;
      if (saverOnRef.current?.preview && target instanceof Element && target.closest(".saver-settings")) return;
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
  const [appPage, setAppPage] = useState<AppPage | null>(
    DEMO_PANEL === "settings" || DEMO_PANEL === "plugins" || DEMO_PANEL === "catalog" || DEMO_PANEL === "updates" ? DEMO_PANEL : null,
  );
  // the full key editor, on one key (owner's "2 a", 2026-10-25)
  const [studio, setStudio] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [updateCheckRequest, setUpdateCheckRequest] = useState(0);
  // "Use it" in the Plugins tab: the deck, with the library open at that plugin's actions
  const [focusPlugin, setFocusPlugin] = useState<{ id: string; at: number } | null>(null);

  const [newRequest, setNewRequest] = useState(0);
  const [profileLibrary, setProfileLibrary] = useState<LeftTab | null>(null);
  const [forAppOpen, setForAppOpen] = useState(DEMO_PANEL === "forapp");
  const [displayPanel, setDisplayPanel] = useState<DeckDisplaySection | null>(null);
  const [livingOpen, setLivingOpen] = useState(false);
  // a profile just made for an app: the inspector suggests next steps until something is picked
  const { saved, save } = usePlacements();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string, ms = 2500) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  const { dropAction, moveKey, openControl, copy, paste, pasteLook, clear, isSet, canPaste, opensPage } = useEditing(view, selected, notify, () => inspector.current?.flush(), appPage === null);
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
  const [tourOpen, setTourOpen] = useState(DEMO_PANEL === "tour-advanced");
  const [guide, setGuide] = useState<GuideKind | null>(DEMO_PANEL === "tour" || DEMO_PANEL === "welcome" || demoParam("demo") === "welcome" ? "start" : null);
  // plugin files opened with MasterDeck (a double click, Open with) or dropped on the window: one at a
  // time, each asked about before it installs
  const [pluginFiles, setPluginFiles] = useState<PluginFile[]>(DEMO_PANEL === "pluginfile" ? [{ path: "AudioSwitcher.streamDeckPlugin" }] : []);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const closePhone = () => setPhoneOpen(false);
  const importPhoneFile = async (path: string, kind: string, name: string) => {
    if (kind === "plugin") {
      closePhone();
      setPluginFiles((files) => [...files, { path }]);
      return;
    }
    if (!(await askInWindow({ title: t("phone.confirmImport", { name }), ok: t("profile.import") }))) return;
    if (kind === "profile") {
      const imported = await api.importProfile(path);
      if (await keepImported(imported)) {
        await api.activate(imported.id);
        closePhone();
        setAppPage(null);
      }
    } else if (kind === "icons") {
      const pack = await iconPacks.install(path);
      await told(t("icons.packAdded", { name: pack.name }));
    }
  };
  const choosePlugin = async (update?: PluginFile["update"]) => {
    try {
      const path = await open({ multiple: false, filters: [{ name: t("plugins.sdFile"), extensions: ["streamDeckPlugin", "zip"] }] });
      if (typeof path === "string") setPluginFiles((files) => [...files, { path, update }]);
    } catch {
      void told(t("plugins.pickFailed"));
    }
  };
  const usePlugin = (id: string) => {
    setAppPage(null);
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

  const closeTools = () => {
    setDisplayPanel(null);
    setGuide(null);
  };
  const openDisplay = (section: DeckDisplaySection) => {
    closeTools();
    setDisplayPanel(section);
  };
  const closeAppPage = () => setAppPage(null);
  const openAppPage = (page: AppPage) => {
    setAppPage(page);
    setProfileOpen(false);
    setForAppOpen(false);
    setGamesOpen(false);
    setStudio(null);
    setLivingOpen(false);
    setCtlMenu(null);
  };
  const openInstalledPlugins = () => openAppPage("plugins");
  const openSettings = (section?: SettingsSection) => {
    if (section) setSettingsSection(section);
    openAppPage("settings");
  };
  const openGuide = (kind: GuideKind) => {
    closeTools();
    setGuide(kind);
  };
  const dismissGuide = () => {
    setGuide(null);
    if (guide === "start" && setupPending) api.onboardingDone().catch((error) => notify(String(error)));
  };
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
        onOpenProfile={() => (setProfileOpen((o) => !o), closeAppPage())}

        onOpenForApp={() => (setForAppOpen(true), closeAppPage(), setProfileOpen(false))}
        onOpenProfileLibrary={() => setProfileLibrary("profiles")}
        onOpenAssistant={() => setProfileLibrary("assistant")}
        onOpenTour={() => (closeAppPage(), openGuide("start"))}
        setupPending={setupPending && !guide && !tourOpen && !builderOpen}
        onOpenSettings={() => appPage === "settings" ? closeAppPage() : openSettings()}
        onCheckUpdates={!appPage && (tourShown || builderOpen || calibrating || arranging || studio) ? undefined : () => {
          openAppPage("updates");
          setUpdateCheckRequest((n) => n + 1);
        }}
        onOpenPlugins={() => appPage === "plugins" || appPage === "catalog" ? closeAppPage() : openInstalledPlugins()}
        onOpenGames={() => (setGamesOpen((o) => !o), closeAppPage())}
      />
      <Notifications
        live={live}
        view={view}
        onOpenProfiles={showProfiles}
        onOpenConnections={() => openSettings("connections")}
      >
          {view.state?.trying && (
            <Notice key={view.state.trying} onDismiss={() => api.tryProfile(null)}>
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
              </Notice>
          )}
        {toast && <Notice key={toast} onDismiss={() => setToast(null)}><span className="grow">{toast}</span></Notice>}
      </Notifications>
      <main className={`workspace deck-workspace stable-workspace${arranging ? " is-arranging" : ""}`} hidden={appPage !== null}>
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
            <DeckTools
              canArrange={live.deck.modules.length > 0}
              onArrange={toggleArrange}
              onBuild={() => setBuilderOpen(true)}
              onDisplay={() => openDisplay("lights")}
              onSaver={() => openDisplay("saver")}
              onGuide={() => openGuide("start")}
              onModulesGuide={() => openGuide("modules")}
            /></>}
          </div>
          <div className="deck-area">
          <DeckView
            live={live}
            selected={selected}
            onSelect={(c) => {
              setSelected(c);
              // a click on the deck in the window is a touch: the screensaver ends
              if (saverOn) saverEnd();
            }}
            saved={saved}
            onPlace={save}
            arranging={arranging}
            onEdge={() => openDisplay("edge")}
            obsStudioMode={view.state?.obsStudioMode}
            showShelf={false}
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
              onPaste={() => void paste(ctlMenu.c)}
              onPasteLook={() => pasteLook(ctlMenu.c)}
              onClear={() => clear(ctlMenu.c)}
              onOpenPage={() => openControl(ctlMenu.c)}
              onClose={() => setCtlMenu(null)}
            />
          )}
          {arranging && <BaseTurnPicker live={live} />}
          </div>
        </section>

        <section className="workspace-details" aria-label={t("workshop.editKey")}>
          {!arranging && !calibrating && (displayPanel || guide) && (
            <div className="workspace-details-nav">
              <button type="button" className="tool ghost small" onClick={closeTools}><Icon name="chevron-left" />{t("workshop.editKey")}</button>
            </div>
          )}
          <div className="workspace-key-pane" hidden={!!(arranging || calibrating || displayPanel || guide)}>
            {selected ? (
              <Inspector ref={inspector} selected={selected} view={view} onClose={() => setSelected(null)}
                onDropAction={(control, action, gesture) => dropAction(control, action, gesture, () => inspector.current?.flush())}
                onOpenStudio={setStudio}
              />
            ) : (
              <div className="workspace-empty">
                <header className="workspace-pane-head"><h2>{t("workshop.editKey")}</h2></header>
                <p>{t("workshop.pickKey")}</p>
              </div>
            )}
          </div>
          {calibrating ? <CalibrationPanel onClose={() => setCalibrating(false)} /> :
           arranging ? <ArrangePanel onDone={toggleArrange} live={live} saved={saved} onPlace={save} /> :
           displayPanel ? (
            <DeckDisplayPanel live={live} view={view} section={displayPanel} setSection={setDisplayPanel} onClose={closeTools}
              onCalibrate={() => { setDisplayPanel(null); setCalibrating(true); }} onOpenScenes={() => setLivingOpen(true)}
            />
          ) : guide && (
            <WorkspaceGuide key={guide} kind={guide} live={live} selected={selected} onClose={dismissGuide}
              onModules={() => openGuide("modules")}
              onArrange={toggleArrange}
              onBuild={() => setBuilderOpen(true)}
              onPersonalize={() => setTourOpen(true)}
              onKeys={closeTools}
              onProfiles={() => setProfileLibrary("profiles")}
              onDisplay={() => openDisplay("lights")}
              onOBS={() => openSettings("connections")}
              onPlugins={openInstalledPlugins}
            />
          )}
        </section>
        <div className="editor-sidebar">
          <ActionLibrary catalog={view.catalog} icons={view.icons} selectedKind={selected?.kind} focusPlugin={focusPlugin} disabled={arranging || calibrating} onOpenPlugins={openInstalledPlugins} />
        </div>
      </main>
      {appPage && (
        <main className="workspace app-page" aria-labelledby="app-page-title">
          {appPage === "settings" && <SettingsPage live={live} view={view} section={settingsSection} onSection={setSettingsSection} onClose={closeAppPage} />}
          {appPage === "plugins" && <PluginsPage onClose={closeAppPage} onBrowse={() => setAppPage("catalog")} onPickFile={choosePlugin} onPhone={() => setPhoneOpen(true)} onUse={usePlugin} />}
          {appPage === "catalog" && (
            <Suspense fallback={
              <div className="settings-page">
                <AppPageHeader title={t("plugins.catalog")} onClose={closeAppPage} />
                <div className="settings-content workspace-loading" role="status">{t("app.loadingPanel")}</div>
              </div>
            }>
              <PluginsTab onClose={closeAppPage} onManage={openInstalledPlugins} onPickFile={choosePlugin} onPhone={() => setPhoneOpen(true)} onUse={usePlugin} />
            </Suspense>
          )}
          {appPage === "updates" && <UpdatesPage checkRequest={updateCheckRequest} onClose={closeAppPage} />}
        </main>
      )}
      <Suspense fallback={null}>
        {tourShown && (
          <Sheet wide label={t("workshop.personalize")} onClose={() => setTourOpen(false)}>
            <Tour live={live} view={view} saved={saved} onPlace={save} deskCheck={setupPending} onArrange={toggleArrange}
              onClose={() => setTourOpen(false)}
              onBuild={() => (setTourOpen(false), setBuilderOpen(true))}
              onAsk={(message) => (setTourOpen(false), setProfileLibrary("assistant"), askAssistant(message))}
            />
          </Sheet>
        )}
        {builderOpen && <Sheet wide label={t("builder.title")} onClose={() => setBuilderOpen(false)}>
          <Builder live={live} view={view} saved={saved} onPlace={save} onClose={() => setBuilderOpen(false)} />
        </Sheet>}
        {studio && <Sheet wide label={t("workshop.editKey")} onClose={() => setStudio(null)}>
          <KeyStudio key={`${view.profile?.id}/${studio}`} view={view} control={studio} onClose={() => setStudio(null)} />
        </Sheet>}
        {livingOpen && <Sheet wide label={t("settings.lightsScreens")} onClose={() => setLivingOpen(false)}>
          <DeckLook view={view}
            keysModule={[...live.deck.modules].filter((m) => m.kind === "keys").sort((a, b) => (a.first ?? 0) - (b.first ?? 0))[0]?.id}
            keysCount={Math.max(15, ...live.deck.modules.filter((m) => m.kind === "keys").map((m) => (m.first ?? 0) + 15))}
            keysTurn={(placeModules(live.deck.modules, saved).find((p) => p.module.kind === "keys")?.rotation ?? 0) + live.deck.turn}
            onClose={() => setLivingOpen(false)}
          />
        </Sheet>}
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
              onTour={() => (setProfileLibrary(null), setTourOpen(true))}
              onNewProfile={() => (setProfileLibrary(null), setNewRequest((n) => n + 1))}
              onOpenProfile={() => (setProfileLibrary(null), setProfileOpen(true), closeAppPage(), setForAppOpen(false))}
            />
          </div>
        </Sheet>
      )}
      {/* panels open over the window, so a touch on a control still shows its editor (docs/FLOWS.md, difference 4) */}
      {!tourShown && !arranging && !calibrating && (forAppOpen || gamesOpen || profileOpen) && (
        <Sheet onClose={() => (setForAppOpen(false), setGamesOpen(false), setProfileOpen(false))}>
          {forAppOpen ? (
            <ForAppPanel view={view} kinds={kinds} onClose={() => setForAppOpen(false)} onMade={() => (setForAppOpen(false), setSelected(null))} />
          ) : gamesOpen ? (
            <GamesPanel view={view} onClose={() => setGamesOpen(false)} />
          ) : (
            <ProfilePanel view={view} onClose={() => setProfileOpen(false)} />
          )}
        </Sheet>
      )}
      <ConfirmHost />
      {phoneOpen && <PhoneUpload onClose={closePhone} onImport={importPhoneFile} />}
      {!phoneOpen && pluginFiles.length > 0 && <PluginFileSheet key={pluginFiles[0].path} path={pluginFiles[0].path} update={pluginFiles[0].update} onUse={usePlugin} onManage={openInstalledPlugins} onClose={() => setPluginFiles((now) => now.slice(1))} />}
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="plug" />
          {t("plugins.dropHere")}
        </div>
      )}
    </div>
  );
}
