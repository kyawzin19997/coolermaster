import { useEffect, useState } from "react";
import type { ControlRef, LiveState, ModuleKind } from "../deck";
import { t, useLanguage, type Key } from "../i18n";
import { Icon } from "./Icon";

export type GuideKind = "start" | "modules";

const LESSONS = ["modules", "actions", "gestures", "profiles", "display", "obs", "plugins"] as const;
type Lesson = (typeof LESSONS)[number];
const MODULES = ["keys", "dial", "knobs", "faders", "rollers"] as const satisfies readonly ModuleKind[];

export function DetachedModuleGuide() {
  useLanguage();
  return (
    <ol className="detached-module-guide help">
      <li>{t("workshop.detachedStep1")}</li>
      <li>{t("workshop.detachedStep2")}</li>
      <li>{t("workshop.detachedStep3")}</li>
    </ol>
  );
}

export function WorkspaceGuide({ kind, live, selected, onClose, onModules, onArrange, onPersonalize, onKeys, onProfiles, onDisplay, onOBS, onPlugins }: {
  kind: GuideKind;
  live: LiveState;
  selected: ControlRef | null;
  onClose: () => void;
  onModules: () => void;
  onArrange: () => void;
  onPersonalize: () => void;
  onKeys: () => void;
  onProfiles: () => void;
  onDisplay: () => void;
  onOBS: () => void;
  onPlugins: () => void;
}) {
  useLanguage();
  const [step, setStep] = useState(0);
  const [moduleAt, setModuleAt] = useState(0);
  useEffect(() => {
    const next = MODULES.findIndex((module) => module === selected?.kind);
    if (next >= 0) setModuleAt(next);
  }, [selected]);
  const modules = kind === "modules";
  const current = LESSONS[step];
  const module = MODULES[moduleAt];
  const attached = live.deck.modules.some((entry) => entry.kind === module);
  const title = t(modules ? "workshop.modules" : "workshop.start");
  const routes: Record<Lesson, [Key, () => void]> = {
    modules: ["workshop.modules", onModules],
    actions: ["workshop.editKey", onKeys],
    gestures: ["workshop.editKey", onKeys],
    profiles: ["profiles.title", onProfiles],
    display: ["settings.lightsScreens", onDisplay],
    obs: ["settings.connections", onOBS],
    plugins: ["topbar.plugins", onPlugins],
  };
  const [action, run] = routes[current];
  const last = modules ? moduleAt === MODULES.length - 1 : step === LESSONS.length - 1;
  return (
    <div className="workspace-guide">
      <header className="workspace-pane-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="workspace-pane-scroll">
        <section className="sec">
          {modules ? (
            <>
              <label className="field">
                <span className="label">{t("workshop.module")}</span>
                <select className="input" value={moduleAt} onChange={(event) => setModuleAt(Number(event.target.value))}>
                  {MODULES.map((entry, index) => <option key={entry} value={index}>{t(`module.${entry}`)}</option>)}
                </select>
              </label>
              <h3>{t(`module.${module}`)} {attached && <small className="guide-attached">{t("welcome.attached")}</small>}</h3>
              <p>{t(`workshop.module.${module}` as Key)}</p>
              {!attached && <DetachedModuleGuide />}
              <div className="row wrap">
                <button type="button" className="tool" onClick={onArrange}><Icon name="layout-grid" />{t("stage.editLayout")}</button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span className="label">{t("workshop.lesson")}</span>
                <select className="input" value={step} onChange={(event) => setStep(Number(event.target.value))}>
                  {LESSONS.map((entry, index) => <option key={entry} value={index}>{index + 1}. {t(`workshop.lesson.${entry}` as Key)}</option>)}
                </select>
              </label>
              <p>{t(`workshop.lesson.${current}.body` as Key)}</p>
              <button type="button" className="tool align-start" onClick={run}>{t(action)}</button>
              {current === "profiles" && <button type="button" className="link-btn align-start" onClick={onPersonalize}>{t("workshop.personalize")}</button>}
            </>
          )}
        </section>
      </div>
      <footer className="workspace-guide-nav">
        <button type="button" className="tool ghost" disabled={(modules ? moduleAt : step) === 0}
          onClick={() => modules ? setModuleAt(moduleAt - 1) : setStep(step - 1)}>{t("workshop.previous")}</button>
        <button type="button" className="tool primary" onClick={() => last ? onClose() : modules ? setModuleAt(moduleAt + 1) : setStep(step + 1)}>
          {t(last ? "workshop.finish" : "workshop.next")}
        </button>
      </footer>
    </div>
  );
}
