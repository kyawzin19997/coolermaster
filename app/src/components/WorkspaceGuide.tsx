import { useState } from "react";
import { t, useLanguage, type Key } from "../i18n";
import { Icon } from "./Icon";

const LESSONS = ["actions", "gestures", "profiles", "display", "modules", "obs", "plugins"] as const;

export function WorkspaceGuide({ onClose, onArrange, onProfiles, onDisplay, onOBS, onPlugins }: {
  onClose: () => void;
  onArrange: () => void;
  onProfiles: () => void;
  onDisplay: () => void;
  onOBS: () => void;
  onPlugins: () => void;
}) {
  useLanguage();
  const [step, setStep] = useState(0);
  const current = LESSONS[step];
  const next = step < LESSONS.length - 1;
  const routes: Partial<Record<(typeof LESSONS)[number], [Key, () => void]>> = {
    modules: ["stage.editLayout", onArrange],
    profiles: ["profiles.title", onProfiles],
    display: ["settings.lightsScreens", onDisplay],
    obs: ["settings.connections", onOBS],
    plugins: ["topbar.plugins", onPlugins],
  };
  const route = routes[current];
  return (
    <div className="workspace-guide">
      <header className="workspace-pane-head">
        <h2>{t("workshop.start")}</h2>
        <button type="button" className="icon-btn" aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="workspace-pane-scroll">
        <section className="sec">
          <span className="muted">{t("workshop.step", { step: step + 1, total: LESSONS.length })}</span>
          <h3>{t(`workshop.lesson.${current}`)}</h3>
          <p>{t(`workshop.lesson.${current}.body`)}</p>
          {route && <button type="button" className="tool align-start" onClick={route[1]}>{t(route[0])}</button>}
        </section>
      </div>
      <footer className="workspace-guide-nav">
        <button type="button" className="tool ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>{t("workshop.previous")}</button>
        <button type="button" className="tool primary" onClick={() => next ? setStep(step + 1) : onClose()}>{t(next ? "workshop.next" : "workshop.finish")}</button>
      </footer>
    </div>
  );
}
