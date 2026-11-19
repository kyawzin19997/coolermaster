import { useEffect, useRef, useState } from "react";
import { api, DISCORD, THEMES } from "../engine";
import { t, useLanguage, type Key } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { Thumb } from "./Thumb";

/** Featured release notes, opened from the Help menu. */
interface Release {
  hero: { title: Key; text: Key; preset: string };
  items: { icon: IconName; title: Key; text: Key; open?: "saver" | "music" | "discord" }[];
}
const RELEASES: Record<string, Release> = {
  "0.2": {
    hero: { title: "whatsNew.0.2.heroTitle", text: "whatsNew.0.2.heroText", preset: "halloween-hill" },
    items: [
      { icon: "moon", title: "whatsNew.0.2.saverTitle", text: "whatsNew.0.2.saverText", open: "saver" },
      { icon: "music", title: "whatsNew.0.2.musicTitle", text: "whatsNew.0.2.musicText", open: "music" },
      { icon: "image", title: "whatsNew.0.2.editorTitle", text: "whatsNew.0.2.editorText" },
      { icon: "users", title: "whatsNew.0.2.discordTitle", text: "whatsNew.0.2.discordText", open: "discord" },
    ],
  },
};
const NOTES = "https://github.com/Przemotar/hubdeck/releases/latest";
const newest = Object.keys(RELEASES).sort().reverse()[0];

export function WhatsNew({ onOpenLook }: { onOpenLook: () => void }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);
  const release = RELEASES[newest];
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("hubdeck:whats-new", show);
    return () => window.removeEventListener("hubdeck:whats-new", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    okRef.current?.focus();
    const on = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });
  if (!open || !release) return null;
  const close = () => {
    setOpen(false);
    if (tried) {
      setTried(false);
      api.effectsTry(null).catch(() => {});
    }
  };
  const hero = THEMES.find((th) => th.id === release.hero.preset);
  const go = (to: Release["items"][number]["open"]) => {
    close();
    if (to === "discord") api.openLink(DISCORD).catch(() => {});
    else if (to) window.dispatchEvent(new CustomEvent(`hubdeck:open-${to}`));
  };
  return (
    <div className="sheet-backdrop confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="whatsnew" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <div className="wn-head">
          <span className="wn-eyebrow">{t("whatsNew.eyebrow", { version: newest })}</span>
          <button type="button" className="tool ghost small icon-only" aria-label={t("whatsNew.close")} onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="wn-hero">
          {/* its own picture at the dialog's size (the presets' thumbnails are 240 px wide and went soft) */}
          <Thumb id={`wn-${release.hero.preset}`} moving />
          <h2 id="wn-title">{t(release.hero.title)}</h2>
          <p>{t(release.hero.text)}</p>
          <div className="wn-actions">
            {hero && (
              <button
                type="button"
                className="tool"
                onClick={() => {
                  api.effectsTry({ layers: hero.layers, theme: hero.id }).catch(() => {});
                  setTried(true);
                }}
              >
                <Icon name="play" />
                {tried ? t("whatsNew.onDeck") : t("whatsNew.try")}
              </button>
            )}
            <button type="button" className="tool" onClick={() => (close(), onOpenLook())}>
              {t("whatsNew.openLook")}
            </button>
          </div>
        </div>
        <ul className="wn-items">
          {release.items.map((it) => {
            const Row = it.open ? "button" : "div";
            return (
              <li key={it.title}>
                <Row {...(it.open ? { type: "button" as const, onClick: () => go(it.open) } : {})} className={`wn-item${it.open ? " is-link" : ""}`}>
                  <span className="wn-icon">
                    <Icon name={it.icon} />
                  </span>
                  <span className="wn-text">
                    <b>{t(it.title)}</b>
                    <small>{t(it.text)}</small>
                  </span>
                  {it.open && <Icon name="chevron-right" className="wn-go" />}
                </Row>
              </li>
            );
          })}
        </ul>
        <div className="wn-foot">
          <button type="button" className="link-btn" onClick={() => api.openLink(NOTES).catch(() => {})}>
            {t("whatsNew.notes")}
          </button>
          <button type="button" ref={okRef} className="tool primary" onClick={close}>
            {t("whatsNew.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
