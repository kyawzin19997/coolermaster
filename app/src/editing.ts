import { withTemplate } from "./lookTemplates";
import { useEffect, useRef } from "react";
import type { ControlRef, ModuleKind } from "./deck";
import { actionName, t } from "./i18n";
import { actionFits, api, controlId, newBinding, pressable, type ActionDef, type Binding, type EngineView, type Gesture, type Look, type Profile } from "./engine";

const GESTURES: Gesture[] = ["tap", "hold", "double"];
const HISTORY = 50;
type CopiedControl = { kind: ModuleKind; bindings: Record<Gesture, Binding | null> };

export function actionFitsTrigger(action: ActionDef, kind: ModuleKind, trigger: Gesture) {
  return trigger === "tap" ? actionFits(action, kind) : pressable(kind) && action.inputs.includes("press");
}

function withoutArtwork({ icon: _icon, image: _image, fit: _fit, ...style }: Look): Look {
  return style;
}

export function bindingForDrop(action: ActionDef, profile: Profile, control: ControlRef, id: string): Binding {
  const previous = profile.controls[id];
  if (previous?.action === action.id) return previous;
  const binding = newBinding(action);
  if (previous) {
    binding.look = { ...withoutArtwork(previous.look), ...binding.look, label: binding.look.label };
    if (binding.look.rules) {
      binding.look.rules = binding.look.rules.map(rule => ({ ...rule, look: withoutArtwork(rule.look) }));
    }
  } else if (control.kind === "keys" && profile.keyStyle) {
    binding.look = withTemplate(binding.look, profile.keyStyle);
  }
  return binding;
}

/** What "Paste look" carries: colors, the LED and its effect, the key's style and the icon
 * editor's background, finish, label effect, frame and badge color; not the label, icon, picture
 * or badge text (issue #10, killa8boll: "Copy Color" / "Paste Color"; owner's pick 1a). */
const LOOK_FIELDS = ["bg", "fg", "iconColor", "led", "ledLevel", "ledEffect", "ledSpeed", "style", "bg2", "angle", "gloss", "labelEffect", "ring", "badgeColor", "pattern", "patternOpacity", "motion", "font"] as const;

/** `to` with the look fields of `from` (a field `from` leaves unset is unset on the result too). */
export function withLook(to: Look, from: Look): Look {
  const out: Look = { ...to };
  for (const f of LOOK_FIELDS) {
    if (from[f] === undefined) delete out[f];
    else (out as Record<string, unknown>)[f] = from[f];
  }
  return out;
}

/** Typing in a field keeps the browser's own copy, paste and undo. */
const inField = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

/**
 * Editing comfort for the deck view: an action dropped on a control, Ctrl+C / Ctrl+V of a
 * control's bindings (press, hold and double press), Delete to clear it, Ctrl+Z to undo the last
 * change to the profile.
 */
export function useEditing(view: EngineView, selected: ControlRef | null, notify: (text: string) => void, flush: () => Promise<void> | undefined, shortcutsEnabled: boolean) {
  const clipboard = useRef<CopiedControl | null>(null);
  const copying = useRef<Promise<void> | undefined>(undefined);
  const history = useRef<Profile[]>([]);
  const last = useRef<Profile | null>(null);
  const undoing = useRef(false);

  // every new version of the same profile pushes the one before it, unless it came from an undo
  useEffect(() => {
    const p = view.profile;
    if (p && last.current && last.current.id === p.id && JSON.stringify(last.current) !== JSON.stringify(p)) {
      if (!undoing.current) history.current = [...history.current, last.current].slice(-HISTORY);
      undoing.current = false;
    }
    if (p && last.current?.id !== p.id) history.current = [];
    last.current = p;
  }, [view.profile]);

  const page = view.state?.page ?? null;

  const dropAction = (c: ControlRef, actionId: string, gesture: Gesture, flush: () => Promise<void> | undefined) => {
    const def = view.catalog?.actions.find((a) => a.id === actionId);
    const profile = view.profile;
    if (!def || !profile || profile.id !== view.state?.active) return false;
    if (!actionFitsTrigger(def, c.kind, gesture)) {
      notify(t("edit.notOn", { action: actionName(def), control: t(`on.${c.kind}`) }));
      return false;
    }
    const id = controlId(c.kind, c.index, page, gesture);
    const write = (current: Profile) => api.setBinding(profile.id, id, bindingForDrop(def, current, c, id));
    const pending = flush();
    (pending ? pending.then(() => api.profile(profile.id)).then(write) : write(profile)).catch((e) => notify(String(e)));
    return true;
  };

  // the key handler reads what is selected and shown at the moment of the key press: a handler
  // made at an earlier render copied the key selected before, or pasted over a change the window
  // had not heard of yet (8bitcanvascode, Discussions #3, 2026-10-19)
  const now = useRef({ view, selected, page, notify, flush, shortcutsEnabled });
  now.current = { view, selected, page, notify, flush, shortcutsEnabled };

  const gestureIds = (c: ControlRef, page: string | null) => Object.fromEntries(GESTURES.map((g) => [g, controlId(c.kind, c.index, page, g)])) as Record<Gesture, string>;

  /** Does the control do anything (press, hold or double press)? */
  const isSet = (c: ControlRef) => {
    const { view, page } = now.current;
    const ids = gestureIds(c, page);
    return !!view.profile && GESTURES.some((g) => view.profile?.controls[ids[g]]);
  };
  const canPaste = () => !!clipboard.current || !!copying.current;

  const copy = (control: ControlRef) => {
    const { view, page, notify, flush } = now.current;
    const profile = view.profile;
    if (!profile) return;
    const ids = gestureIds(control, page);
    const capture = (source: Profile) => {
      const bindings = Object.fromEntries(GESTURES.map((g) => [g, structuredClone(source.controls[ids[g]] ?? null)])) as CopiedControl["bindings"];
      if (!GESTURES.some((g) => bindings[g])) return notify(t("edit.empty"));
      clipboard.current = { kind: control.kind, bindings };
      notify(t("edit.copied"));
    };
    const pending = flush();
    if (!pending) {
      capture(profile);
    } else {
      const task = pending.then(() => api.profile(profile.id)).then(capture, (e) => notify(String(e)));
      copying.current = task;
      void task.finally(() => { if (copying.current === task) copying.current = undefined; });
    }
  };

  const paste = async (c: ControlRef) => {
    const { view, page, notify, flush } = now.current;
    const profile = view.profile;
    if (!profile) return;
    try {
      await copying.current;
      const from = clipboard.current;
      if (!from) return;
      await flush();
      const ids = gestureIds(c, page);
      const changes: Record<string, Binding | null> = {};
      let skipped = 0;
      let pasted = 0;
      for (const gesture of GESTURES) {
        const binding = from.bindings[gesture];
        const action = binding && view.catalog?.actions.find((a) => a.id === binding.action);
        if (binding && (from.kind !== c.kind && (!action || !actionFitsTrigger(action, c.kind, gesture))
          || binding.action === "core.page" && binding.params?.page && !profile.pages?.some((p) => p.id === binding.params.page))) {
          skipped++;
          continue;
        }
        changes[ids[gesture]] = binding;
        if (binding) pasted++;
      }
      if (!pasted) return notify(t("edit.pasteUnavailable"));
      await api.setBindings(profile.id, changes);
      notify(t(skipped ? "edit.pastedPartly" : "edit.pasted"));
    } catch (err) {
      notify(String(err));
    }
  };

  /** Paste only the look of what was copied onto the control's press: its action stays. */
  const pasteLook = async (c: ControlRef) => {
    const { view, page, notify, flush } = now.current;
    const profile = view.profile;
    if (!profile) return;
    try {
      await copying.current;
      const copied = clipboard.current;
      const from = copied && GESTURES.map((g) => copied.bindings[g]).find(Boolean);
      if (!from) return;
      const pending = flush();
      const current = pending ? await pending.then(() => api.profile(profile.id)) : profile;
      const id = controlId(c.kind, c.index, page);
      const to = current.controls[id];
      if (!to) return notify(t("edit.lookNeedsAction"));
      const next: Binding = { ...to, look: withLook(to.look ?? {}, from.look ?? {}) };
      if (to.lookOn && from.lookOn) next.lookOn = withLook(to.lookOn, from.lookOn);
      await api.setBindings(profile.id, { [id]: next });
      notify(t("edit.lookPasted"));
    } catch (err) {
      notify(String(err));
    }
  };

  /** Clear a control's press, hold and double press (Ctrl+Z brings them back). */
  const clear = (c: ControlRef) => {
    const { view, page, notify, flush } = now.current;
    const profile = view.profile;
    if (!profile || !isSet(c)) return;
    const ids = gestureIds(c, page);
    const changes: Record<string, Binding | null> = Object.fromEntries(GESTURES.map((g) => [ids[g], null]));
    void Promise.resolve(flush()).then(() => api.setBindings(profile.id, changes)).then(() => notify(t("edit.cleared")), (err) => notify(String(err)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { view, selected, notify, shortcutsEnabled } = now.current;
      if (!shortcutsEnabled || inField(e) || !view.profile) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        const prev = history.current.pop();
        if (!prev) return notify(t("edit.nothingToUndo"));
        e.preventDefault();
        undoing.current = true;
        api.saveProfile(prev).then(() => notify(t("edit.undone")), (err) => notify(String(err)));
        return;
      }
      if (!selected) return;
      if (mod && key === "c") {
        if (isSet(selected)) e.preventDefault();
        copy(selected);
      } else if (mod && key === "v" && canPaste()) {
        e.preventDefault();
        if (e.shiftKey) void pasteLook(selected);
        else void paste(selected);
      } else if ((key === "delete" || key === "backspace") && !mod) {
        if (!isSet(selected)) return;
        e.preventDefault();
        clear(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A key dragged onto another: its press, hold and double press go there, and that key's come
   * back in its place (a swap; a move when the other was empty). */
  const moveKey = (from: ControlRef, to: ControlRef) => {
    const { view, page, notify } = now.current;
    const profile = view.profile;
    if (!profile || from.kind !== to.kind) return;
    const changes: Record<string, Binding | null> = {};
    let swapped = false;
    for (const g of GESTURES) {
      const [a, b] = [controlId(from.kind, from.index, page, g), controlId(to.kind, to.index, page, g)];
      const [ba, bb] = [profile.controls[a], profile.controls[b]];
      if (!ba && !bb) continue;
      if (bb) swapped = true;
      changes[b] = ba ?? null;
      changes[a] = bb ?? null;
    }
    if (Object.keys(changes).length === 0) return;
    api.setBindings(profile.id, changes).then(() => notify(t(swapped ? "edit.swapped" : "edit.moved")), (err) => notify(String(err)));
  };

  /** A double click on a page key shows its page, here and on the deck. */
  const openControl = (c: ControlRef) => {
    const { view, page } = now.current;
    const profile = view.profile;
    const b = profile?.controls[controlId(c.kind, c.index, page)];
    if (!profile || !b) return;
    const all = [null, ...(profile.pages ?? []).map((p) => p.id)];
    const at = Math.max(0, all.indexOf(page));
    const to =
      b.action === "core.page" ? (typeof b.params?.page === "string" && b.params.page ? b.params.page : null)
      : b.action === "core.nextPage" ? all[(at + 1) % all.length]
      : b.action === "core.previousPage" ? all[(at + all.length - 1) % all.length]
      : undefined;
    if (to === undefined || to === page) return;
    api.setPage(to).catch((err) => now.current.notify(String(err)));
  };

  /** Is it a key that opens a page (a double click or Open page in its menu opens it)? */
  const opensPage = (c: ControlRef) => {
    const { view, page } = now.current;
    const a = view.profile?.controls[controlId(c.kind, c.index, page)]?.action;
    return a === "core.page" || a === "core.nextPage" || a === "core.previousPage";
  };

  return { dropAction, moveKey, openControl, copy, paste, pasteLook, clear, isSet, canPaste, opensPage };
}
