import { useCallback, useEffect, useRef, useState } from "react";
import { api, inTauri, inWindow, usePreview, type EngineView, type Look } from "../engine";
import { save as saveDialog } from "../confirm";
import { looksLike, templateOf } from "../lookTemplates";
import { actionName, t } from "../i18n";
import { actionIconName } from "../actionIcons";
import { ActionIcon } from "./ActionChooser";
import { Icon } from "./Icon";
import { IconPicker } from "./IconPicker";
import { IconSize, KeyDesigner } from "./KeyDesigner";
import { LabelValues } from "./LookRules";

/** Sixteenths of a second in one cycle of each motion (the engine's own, `render.rs`). */
const CYCLE: Record<string, (look: Look) => number> = {
  pulse: () => 40,
  shine: () => 48,
  glow: () => 48,
  sweep: () => 48,
  sparkle: () => 32,
  flow: () => 96,
  slide: (l) => 4 * (l.pattern === "stripes" ? 8 : l.pattern === "noise" ? 24 : l.pattern === "waves" ? 18 : l.pattern === "hex" ? 15 : 9),
};

/**
 * The key's drawing as the deck shows it, moving when the look moves: the engine draws each frame
 * of the cycle once (kept), the window plays them at the deck's 16 a second.
 */
function useLivePreview(look: Look): string | null {
  const still = usePreview("key", look);
  const [frame, setFrame] = useState<string | null>(null);
  const frames = useRef(new Map<string, string>());
  useEffect(() => {
    setFrame(null);
    const cycle = look.motion ? CYCLE[look.motion]?.(look) : undefined;
    if (!cycle || !inTauri()) return;
    const base = JSON.stringify(look);
    let step = 0;
    let live = true;
    let drawing = false;
    const timer = window.setInterval(() => {
      step = (step + 1) % cycle;
      const key = `${base}#${step}`;
      const kept = frames.current.get(key);
      if (kept) return setFrame(kept);
      if (drawing) return;
      drawing = true;
      api.preview("key", look, step / 16 + 0.001).then((raw) => {
        const svg = inWindow(raw);
        if (frames.current.size > 400) frames.current.clear();
        frames.current.set(key, svg);
        if (live) setFrame(svg);
      }, () => {}).finally(() => { drawing = false; });
    }, 1000 / 16);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(look)]);
  return frame ?? still;
}

/** Common appearance settings with a live preview and expandable precision tools. */
export function KeyStudio({ view, control, onClose }: { view: EngineView; control: string; onClose: () => void }) {
  const profile = view.profile;
  const profileId = profile?.id;
  const page = view.state?.page ?? null;
  const start = profile?.controls[control];
  const [look, setLook] = useState<Look>(start?.look ?? {});
  const [moving, setMoving] = useState<"icon" | "label">("icon");
  const [iconsOpen, setIconsOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const svg = useLivePreview(look);
  const pending = useRef<number | null>(null);
  const dirty = useRef(false);
  const writing = useRef(Promise.resolve(true));
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef(look);
  latest.current = look;
  const flush = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
    if (!dirty.current || !profileId) return writing.current;
    dirty.current = false;
    const snapshot = latest.current;
    writing.current = writing.current.then(async () => {
      const current = await api.profile(profileId);
      const binding = current.controls[control];
      if (!binding) throw new Error(t("studio.gone"));
      await api.setBinding(profileId, control, { ...binding, look: snapshot });
      return true;
    }).catch((e) => {
      dirty.current = true;
      setNote(t("studio.saveFailed", { message: String(e) }));
      return false;
    });
    return writing.current;
  }, [control, profileId]);
  useEffect(() => () => { void flush(); }, [flush]);
  // save the key as a picture, or the page's keys as a Stream Deck icon pack
  const savePng = async () => {
    const path = await saveDialog({ defaultPath: `${(look.label ?? "key").replace(/[\\/:*?"<>|\n]/g, " ").trim() || "key"}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (path) api.keyPngSave(look, path).then(() => setNote(t("studio.pngSaved", { path })), (e) => setNote(String(e)));
  };
  const savePack = async () => {
    if (!profile) return;
    if (!(await flush())) return;
    const path = await saveDialog({ defaultPath: `${profile.name.replace(/[\\/:*?"<>|]/g, " ").trim() || "keys"}.streamDeckIconPack`, filters: [{ name: "Stream Deck icon pack", extensions: ["streamDeckIconPack"] }] });
    if (path) api.exportKeysPack(profile.id, page, path).then((count) => setNote(t("studio.packSaved", { count, path })), (e) => setNote(String(e)));
  };
  // the profile's style: new keys start in it (only the look, as a template carries)
  // field by field (the engine sends a look's fields in its own order); shown at once on a click
  const [styleOn, setStyleOn] = useState<boolean | null>(null);
  const styled = styleOn ?? (!!profile?.keyStyle && looksLike(look, profile.keyStyle));
  useEffect(() => setStyleOn(null), [profile?.keyStyle, look]);
  const setStyle = async (on: boolean) => {
    if (!profile) return;
    setStyleOn(on);
    if (!(await flush())) { setStyleOn(null); return; }
    api.profile(profile.id).then((fresh) => api.saveProfile({ ...fresh, keyStyle: on ? templateOf(look) : undefined }))
      .then(() => setNote(t(on ? "studio.styleSet" : "studio.styleOff", { name: profile.name })), (e) => setNote(String(e)));
  };
  // undo and redo (owner, 2026-10-25: "brakuje mi opcji cofania i powtarzania akcji i skrótów
  // klawiszowych"): a quick run of changes (a drag, a color picker held, typing) is one step
  const past = useRef<Look[]>([]);
  const future = useRef<Look[]>([]);
  const lastStep = useRef(0);
  const holding = useRef(false);
  const [, setSteps] = useState(0);
  const apply = (next: Look) => {
    latest.current = next;
    dirty.current = true;
    setLook(next);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => void flush(), 300);
  };
  const change = (next: Look) => {
    const now = Date.now();
    if (!holding.current && now - lastStep.current > 700) {
      past.current = [...past.current, look].slice(-100);
      future.current = [];
      setSteps((n) => n + 1);
    }
    lastStep.current = now;
    apply(next);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(look);
    lastStep.current = 0;
    setSteps((n) => n + 1);
    apply(prev);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(look);
    lastStep.current = 0;
    setSteps((n) => n + 1);
    apply(next);
  };
  // Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z (Cmd on a Mac) undo the editor's steps, before the deck view's
  // own Ctrl+Z (the whole profile) sees them; a text field keeps its own undo
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && (el as HTMLInputElement).type !== "range" && (el as HTMLInputElement).type !== "color") return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (e.preventDefault(), e.stopImmediatePropagation(), undo());
      else if (k === "y" || (k === "z" && e.shiftKey)) (e.preventDefault(), e.stopImmediatePropagation(), redo());
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const close = async () => { if (await flush()) onClose(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input, select, textarea") && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // drag on the big key: the icon or the label moves by whole key pixels
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; zoom: number } | null>(null);
  const field = moving === "icon" ? (["iconDx", "iconDy"] as const) : (["labelDx", "labelDy"] as const);
  const clamp = (v: number) => Math.max(-36, Math.min(36, Math.round(v)));
  const onDown = (e: React.PointerEvent) => {
    if (!positionOpen || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // screen pixels per key pixel (a key is 72; shown at 288, or 216 in a narrow window)
    const zoom = (e.currentTarget as HTMLElement).getBoundingClientRect().width / 72 || 4;
    drag.current = { x: e.clientX, y: e.clientY, dx: look[field[0]] ?? 0, dy: look[field[1]] ?? 0, zoom };
    // the whole drag is one step to undo
    past.current = [...past.current, look].slice(-100);
    future.current = [];
    holding.current = true;
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = clamp(d.dx + (e.clientX - d.x) / d.zoom);
    const dy = clamp(d.dy + (e.clientY - d.y) / d.zoom);
    if (dx !== (look[field[0]] ?? 0) || dy !== (look[field[1]] ?? 0)) change({ ...look, [field[0]]: dx || undefined, [field[1]]: dy || undefined });
  };
  const nudge = (e: React.KeyboardEvent) => {
    if (!positionOpen) return;
    const by: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = by[e.key];
    if (!step) return;
    e.preventDefault();
    change({ ...look, [field[0]]: clamp((look[field[0]] ?? 0) + step[0]) || undefined, [field[1]]: clamp((look[field[1]] ?? 0) + step[1]) || undefined });
  };
  const moved = !!(look.iconDx || look.iconDy || look.labelDx || look.labelDy);

  const number = Number(control.split(".").pop()) + 1;
  const action = view.catalog?.actions.find((a) => a.id === start?.action);
  const defaultIcon = action && actionIconName(action.id, action.icon);
  const isDefaultIcon = defaultIcon === look.icon && !look.image;
  const stopDrag = () => { drag.current = null; holding.current = false; lastStep.current = Date.now(); };

  if (!start) {
    return (
      <div className="studio">
        <p className="help">{t("studio.gone")}</p>
        <button className="tool" onClick={onClose}>
          {t("studio.done")}
        </button>
      </div>
    );
  }
  return (
    <div className="studio key-studio" role="region" aria-label={t("studio.title")}>
      <div className="studio-bar">
        <button className="tool ghost" onClick={close}><Icon name="chevron-left" />{t("studio.back")}</button>
        <div className="key-studio-heading"><h1>{t("studio.title")}</h1><span>{profile?.name} · {t("studio.key", { n: number })}</span></div>
        <span className="spacer" />
        <button className="tool ghost icon-only" onClick={undo} disabled={past.current.length === 0} aria-label={t("studio.undo")} title={t("studio.undoHelp")}><Icon name="undo" /></button>
        <button className="tool ghost icon-only" onClick={redo} disabled={future.current.length === 0} aria-label={t("studio.redo")} title={t("studio.redoHelp")}><Icon name="redo" /></button>
        <button className="tool primary" onClick={close}>{t("studio.done")}</button>
      </div>
      <div className="studio-grid">
        <section className="studio-stage" aria-label={t("look.preview")}>
          <div className="studio-canvas">
            <div
              className={"studio-key" + (positionOpen ? " is-positioning" : "")}
              role="img"
              aria-label={t("look.preview")}
              tabIndex={positionOpen ? 0 : undefined}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onLostPointerCapture={stopDrag}
              onKeyDown={nudge}
              dangerouslySetInnerHTML={{ __html: svg ?? "" }}
            />
          </div>
          {action && <div className="studio-action"><ActionIcon action={action} icons={view.icons} /><span>{actionName(action)}</span></div>}
          <p className="help" role="status">{note ?? t(positionOpen ? "studio.dragHelp" : "studio.autoSave")}</p>
        </section>
        <div className="studio-props">
          <section className="studio-basic" aria-label={t("studio.appearance")}>
            <h2>{t("studio.appearance")}</h2>
            <label className="field">
              <span className="label">{t("look.label")}</span>
              <input className="input" value={look.label ?? ""} onChange={(e) => change({ ...look, label: e.target.value || undefined })} />
            </label>
            <div className="studio-colors">
              <label className="color"><input type="color" value={look.bg ?? "#1f1d26"} onChange={(e) => change({ ...look, bg: e.target.value })} />{t("look.background")}</label>
              <label className="color"><input type="color" value={look.fg ?? "#f0eef6"} onChange={(e) => change({ ...look, fg: e.target.value })} />{t("studio.labelColor")}</label>
            </div>
            <details className="studio-section studio-icons" onToggle={(e) => setIconsOpen(e.currentTarget.open)}>
              <summary><Icon name="image" />{t("studio.chooseIcon")}<Icon name="chevron-down" /></summary>
              {iconsOpen && (
                <div className="studio-section-body">
                  {defaultIcon && <button type="button" className="tool small align-start" disabled={isDefaultIcon} onClick={() => change({ ...look, icon: defaultIcon, image: undefined })}>{t("studio.actionIcon")}</button>}
                  <IconPicker value={look.icon} onChange={(icon) => change({ ...look, icon, image: undefined })} onPicture={(image) => change({ ...look, image })} view={view} />
                </div>
              )}
            </details>
          </section>
          <details className="studio-section" onToggle={(e) => setPositionOpen(e.currentTarget.open)}>
            <summary><Icon name="crosshair" />{t("studio.position")}<Icon name="chevron-down" /></summary>
            <div className="studio-section-body">
              <div className="row wrap studio-move">
                <div className="seg" role="radiogroup" aria-label={t("studio.drag")}>
                  {(["icon", "label"] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={moving === m} className={"tab" + (moving === m ? " is-active" : "")} onClick={() => setMoving(m)}>
                      {t(m === "icon" ? "look.icon" : "look.label")}
                    </button>
                  ))}
                </div>
                <button className="tool small ghost" disabled={!moved} onClick={() => change({ ...look, iconDx: undefined, iconDy: undefined, labelDx: undefined, labelDy: undefined })}>{t("studio.resetPlace")}</button>
              </div>
              <IconSize look={look} onChange={change} />
            </div>
          </details>
          <details className="studio-section" onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
            <summary><Icon name="sliders-horizontal" />{t("studio.advanced")}<Icon name="chevron-down" /></summary>
            {advancedOpen && (
              <div className="studio-section-body">
                <KeyDesigner look={look} onChange={change} showIconSize={false} />
                <LabelValues label={look.label ?? ""} onChange={(label) => change({ ...look, label })} />
                <label className="check" title={t("studio.styleHelp")}>
                  <input type="checkbox" checked={styled} onChange={(e) => void setStyle(e.target.checked)} />
                  {t("studio.style", { name: profile?.name ?? "" })}
                </label>
              </div>
            )}
          </details>
          <details className="studio-section">
            <summary><Icon name="download" />{t("studio.export")}<Icon name="chevron-down" /></summary>
            <div className="row wrap studio-section-body">
              <button className="tool small" onClick={savePng} title={t("studio.pngHelp")}>{t("studio.png")}</button>
              <button className="tool small" onClick={savePack} title={t("studio.packHelp")}>{t("studio.pack")}</button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
