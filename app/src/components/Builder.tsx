// Preview a working draft on the deck and choose an action for each control.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ControlRef, LiveState } from "../deck";
import { api, controlId, svgDataUrl, type Binding, type EngineView, type Gesture, type Profile } from "../engine";
import { actionFitsTrigger, bindingForDrop } from "../editing";
import { actionName, t, useLanguage } from "../i18n";
import type { Placement } from "../layout";
import { ActionLibrary } from "./ActionChooser";
import { DeckView } from "./DeckView";
import { Icon } from "./Icon";
import { Inspector, type InspectorHandle } from "./Inspector";

interface BuilderOption {
  id: string;
  group: string;
  name: string;
  does: string;
  source: string;
  setup: boolean;
  binding: Binding;
  svg: string | null;
  /** The double press and hold that go with it (`double`, `hold`). */
  extra?: Record<string, Binding>;
}

/** One step: a control (the dial, one knob) or the review at the end. */
interface Step {
  key: string;
  label: string;
  /** Control id in the profile (`dial`, `knobs.0`); null for the review. */
  control: string | null;
  kind: "dial" | "knobs" | null;
  ref: ControlRef | null;
}


export function Builder({ live, view, saved, onPlace, onClose }: { live: LiveState; view: EngineView; saved: Record<string, Placement>; onPlace: (key: string, p: Placement | null) => void; onClose: () => void }) {
  const { lang } = useLanguage();
  const [draft, setDraft] = useState<Profile | null>(null);
  const [options, setOptions] = useState<Record<string, BuilderOption[]>>({});
  const [at, setAt] = useState(0);
  const [trying, setTrying] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [name, setName] = useState(t("builder.defaultName"));
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<ControlRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kept = useRef(false);
  const draftRef = useRef<Profile | null>(null);
  const inspector = useRef<InspectorHandle>(null);

  // the steps follow the modules attached: the dial, then each knob, then the review
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    const dial = live.deck.modules.find((m) => m.kind === "dial");
    if (dial) out.push({ key: "dial", label: t("builder.stepDial"), control: "dial", kind: "dial", ref: { module: dial.id, kind: "dial", index: 0 } });
    // every knobs module, in the order of its numbers (a second one's knobs are 4-6)
    const knobs = live.deck.modules.filter((m) => m.kind === "knobs").sort((a, b) => (a.first ?? 0) - (b.first ?? 0));
    for (const m of knobs)
      for (let i = 0; i < 3; i++) {
        const n = (m.first ?? 0) + i;
        out.push({ key: `knobs.${n}`, label: t("builder.stepKnob", { n: n + 1 }), control: `knobs.${n}`, kind: "knobs", ref: { module: m.id, kind: "knobs", index: n } });
      }
    out.push({ key: "review", label: t("builder.stepReview"), control: null, kind: null, ref: null });
    return out;
  }, [live.deck.modules, lang]);
  const step = steps[Math.min(at, steps.length - 1)];
  const activeDraft = draft && view.profile?.id === draft.id ? view.profile : null;
  const selection = editingKey ?? step.ref;

  // a working draft from the profile on the deck now; thrown away unless the review keeps it
  useEffect(() => {
    let live = true;
    invoke<Profile>("builder_draft", { from: view.state?.active ?? null, name: t("builder.defaultName") }).then((p) => {
      if (!live) return;
      draftRef.current = p;
      setDraft(p);
    });
    for (const kind of ["dial", "knobs"]) invoke<BuilderOption[]>("builder_options", { kind }).then((o) => live && setOptions((all) => ({ ...all, [kind]: o })));
    return () => {
      live = false;
      const d = draftRef.current;
      if (d && !kept.current) {
        api.tryProfile(null).catch(() => {});
        api.settleDraft(d.id, false).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Put an option on the draft's control and show the draft on the deck. */
  const put = async (o: BuilderOption) => {
    const d = draftRef.current;
    if (!d || !step.control) return;
    await inspector.current?.flush();
    const latest = await api.profile(d.id);
    const controls = { ...latest.controls, [step.control]: o.binding };
    // each option brings its own double press and hold; without them, the ones from before go
    for (const g of ["double", "hold"]) {
      const id = `${step.control}:${g}`;
      if (o.extra?.[g]) controls[id] = o.extra[g];
      else delete controls[id];
    }
    const next: Profile = { ...latest, controls };
    draftRef.current = next;
    setDraft(next);
    await api.saveProfile(next);
    await api.tryProfile(next.id);
    setTrying((tr) => ({ ...tr, [step.control as string]: o.id }));
  };
  const pick = async (o: BuilderOption) => {
    await put(o);
    setPicked((p) => ({ ...p, [step.control as string]: o.id }));
    setFilter("");
    setEditingKey(null);
    setAt((i) => Math.min(i + 1, steps.length - 1));
  };
  const save = async () => {
    const d = draftRef.current;
    if (!d) return;
    setSaving(true);
    setError(null);
    try {
      await inspector.current?.flush();
      const latest = await api.profile(d.id);
      const named: Profile = { ...latest, name: name.trim() || t("builder.defaultName") };
      await api.saveProfile(named);
      await api.settleDraft(named.id, true);
      kept.current = true;
      await api.activate(named.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const selectStep = (index: number) => {
    setEditingKey(null);
    setFilter("");
    setAt(index);
  };

  const assignKey = (control: ControlRef, actionId: string, gesture: Gesture = "tap") => {
    if (!draft || control.kind !== "keys") return false;
    const action = view.catalog?.actions.find((item) => item.id === actionId);
    if (!action) return false;
    if (!actionFitsTrigger(action, control.kind, gesture)) {
      setError(t("edit.notOn", { action: actionName(action), control: t("on.keys") }));
      return false;
    }
    setError(null);
    const assign = async () => {
      await inspector.current?.flush();
      if (!activeDraft) await api.tryProfile(draft.id);
      const latest = await api.profile(draft.id);
      const id = controlId(control.kind, control.index, null, gesture);
      await api.setBinding(draft.id, id, bindingForDrop(action, latest, control, id));
      setEditingKey(control);
    };
    void assign().catch((error) => setError(String(error)));
    return true;
  };

  const all = step.kind ? options[step.kind] ?? [] : [];
  const words = filter.trim().toLowerCase();
  const shown = words ? all.filter((o) => `${o.name} ${o.does} ${o.source} ${o.group}`.toLowerCase().includes(words)) : all;
  const groups = [...new Set(shown.map((o) => o.group))];
  const iconSvg = (name?: string) => view.icons.find((i) => i.name === name)?.svg ?? "";
  const talk = step.kind === "dial" ? t("builder.talkDial") : step.kind === "knobs" ? t("builder.talkKnob", { n: (step.ref?.index ?? 0) + 1 }) : t("builder.talkReview");
  const chips = step.kind === "dial" ? [t("builder.chipMusic"), t("builder.chipWork"), t("builder.chipAll")] : step.kind === "knobs" ? [t("builder.chipVolume"), t("builder.chipMusic"), t("builder.chipAll")] : [];
  const chipWords: Record<string, string> = { [t("builder.chipMusic")]: "song", [t("builder.chipWork")]: "load", [t("builder.chipVolume")]: "volume", [t("builder.chipAll")]: "" };

  return (
    <div className="builder-page">
      <header className="settings-head builder-head">
        <button className="tool ghost" onClick={onClose}>
          <Icon name="chevron-left" />
          {t("settings.back")}
        </button>
        <h2>{t("builder.title")}</h2>
        <nav className="builder-steps" aria-label={t("builder.steps")}>
          {steps.map((s, i) => (
            <button key={s.key} className={`builder-step${i === at ? " is-current" : ""}${s.control && picked[s.control] ? " is-done" : ""}`} aria-current={i === at ? "step" : undefined} onClick={() => selectStep(i)}>
              {s.control && picked[s.control] && <Icon name="check" />}
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <div className={`builder-body${selection && activeDraft ? " workspace-with-properties" : ""}`}>
        <section className="builder-canvas" aria-label={t("builder.soFar")}>
          <div className="builder-deck">
          <DeckView
            live={live}
            selected={selection}
            onSelect={(control) => {
              const next = steps.findIndex((item) => item.ref?.module === control.module && item.ref.index === control.index);
              if (next >= 0) {
                selectStep(next);
              } else if (control.kind === "keys" && draft) {
                setEditingKey(control);
                if (!activeDraft) api.tryProfile(draft.id).catch((e) => setError(String(e)));
              }
            }}
            onDeselect={() => setEditingKey(null)}
            onDropAction={editingKey ? (control, action) => {
              if (assignKey(control, action)) inspector.current?.selectTrigger("tap");
            } : undefined}
            saved={saved}
            onPlace={onPlace}
            arranging={false}
            profile={activeDraft ?? draft}
            page={null}
            showShelf={false}
            showStrip={false}
          />
          </div>
        </section>
        {selection && activeDraft && (
          <Inspector
            ref={inspector} selected={selection} view={{ ...view, profile: activeDraft, state: view.state && { ...view.state, page: null } }}
            onClose={editingKey ? () => setEditingKey(null) : undefined} onDropAction={assignKey}
          />
        )}
        {editingKey ? (
          <div className="editor-sidebar">
            {error && <p className="help builder-notice" role="alert">{error}</p>}
            <ActionLibrary catalog={view.catalog} icons={view.icons} selectedKind="keys" focusPlugin={null} disabled={false} />
          </div>
        ) : (
        <aside className="builder-main" aria-label={t("chooser.browseTitle")}>
          {error && <p className="help" role="alert">{error}</p>}
          {step.kind ? (
            <>
              <div className="builder-title">
                <h3>{step.label}</h3>
                <span>{t("builder.stepOf", { n: at + 1, count: steps.length })}</span>
              </div>
              <div className="builder-filters">
                <label className="search">
                  <Icon name="search" />
                  <span className="sr-only">{t("builder.narrow")}</span>
                  <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("builder.narrow")} />
                </label>
                {chips.length > 0 && <div className="builder-chips">
                  {chips.map((c) => (
                    <button key={c} className="builder-chip" onClick={() => setFilter(chipWords[c] ?? "")}>
                      {c}
                    </button>
                  ))}
                </div>}
              </div>
              {groups.map((g) => (
                <section key={g} className="builder-group">
                  <h4 className="builder-group-title">{g}</h4>
                  <div className="builder-grid">
                    {shown
                      .filter((o) => o.group === g)
                      .map((o) => {
                        const isTrying = step.control && trying[step.control] === o.id;
                        const isPicked = step.control && picked[step.control] === o.id;
                        return (
                          // a click anywhere on the card tries it (owner, 2026-10-14: not only the button)
                          <article
                            key={o.id}
                            className={`builder-card${isTrying ? " is-trying" : ""}${isPicked ? " is-picked" : ""}`}
                            role="button"
                            tabIndex={0}
                            aria-pressed={!!isTrying}
                            onClick={() => draft && !isTrying && put(o)}
                            onKeyDown={(e) => {
                              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && draft) {
                                e.preventDefault();
                                put(o);
                              }
                            }}
                          >
                            {o.svg ? (
                              <img className="builder-face" src={svgDataUrl(o.svg)} alt="" />
                            ) : (
                              <span className="builder-knob" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(o.binding.look.icon) }} />
                            )}
                            <div className="builder-card-text">
                              <h5>{o.name}</h5>
                              <span className="builder-does">{o.does}</span>
                              <span className={`builder-source${o.setup ? " needs-setup" : ""}`}>
                                {o.source}
                                {o.setup ? ` · ${t("builder.needsSetup")}` : ""}
                              </span>
                            </div>
                            <div className="builder-card-actions">
                              <button
                                className="tool small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  put(o);
                                }}
                                disabled={!draft}
                              >
                                {isTrying ? t("builder.onDeck") : t("builder.try")}
                              </button>
                              <button
                                className="tool small primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pick(o);
                                }}
                                disabled={!draft}
                              >
                                {t("builder.pick")}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                  </div>
                </section>
              ))}
              {shown.length === 0 && <p className="help">{t("builder.nothing")}</p>}
              <details className="builder-tips">
                <summary>{t("builder.tips")}</summary>
                <p className="help">{talk}</p>
                <p className="help">{t("builder.tryHelp")}</p>
              </details>
              <div className="builder-nav">
                <button className="tool ghost" onClick={() => selectStep(Math.min(at + 1, steps.length - 1))}>
                  {t("builder.skip")}
                </button>
              </div>
            </>
          ) : (
            <div className="builder-review">
              <h3>{t("builder.reviewTitle")}</h3>
              <p className="help">{talk}</p>
              <ul>
                {steps
                  .filter((s) => s.control)
                  .map((s) => {
                    const o = (s.kind ? options[s.kind] ?? [] : []).find((x) => x.id === picked[s.control as string]);
                    return (
                      <li key={s.key}>
                        <b>{s.label}</b>: {o ? o.name : t("builder.unchanged")}
                      </li>
                    );
                  })}
              </ul>
              <label className="field">
                <span className="label">{t("builder.name")}</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="row wrap">
                <button className="tool primary" onClick={save} disabled={!draft || saving}>
                  <Icon name="check" />
                  {t("builder.save")}
                </button>
                <button className="tool ghost" onClick={onClose}>
                  {t("builder.throwAway")}
                </button>
              </div>
            </div>
          )}
        </aside>
        )}
      </div>
    </div>
  );
}
