import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../i18n";

const KEY = "masterdeck.controlDockHeight";
const DEFAULT = 35;
const MIN = 30;
const MAX = 55;
const clamp = (height: number) => Math.max(MIN, Math.min(MAX, Math.round(height)));

function loadHeight() {
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= MIN && saved <= MAX) return saved;
  } catch {
    // The dock can still be resized for this session.
  }
  return DEFAULT;
}

export function ControlDock({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(loadHeight);
  const dock = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number; available: number } | null>(null);
  const changeHeight = (next: number, keep: boolean) => {
    const size = clamp(next);
    setHeight(size);
    if (keep) {
      try {
        localStorage.setItem(KEY, String(size));
      } catch {
        // The current size stays in memory.
      }
    }
  };

  return (
    <div className="control-dock" style={{ "--dock-height": `${height}%` } as CSSProperties} ref={dock}>
      <div
        className="control-dock-handle"
        role="separator"
        tabIndex={0}
        aria-label={t("inspector.resize")}
        aria-controls="control-dock-content"
        aria-orientation="horizontal"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={height}
        title={t("inspector.resize")}
        onPointerDown={(e) => {
          const available = dock.current?.parentElement?.clientHeight;
          if (e.button !== 0 || !available) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, height, available };
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start) changeHeight(start.height + (start.y - e.clientY) * 100 / start.available, false);
        }}
        onPointerUp={(e) => {
          const start = drag.current;
          drag.current = null;
          if (start) changeHeight(start.height + (start.y - e.clientY) * 100 / start.available, true);
        }}
        onLostPointerCapture={() => {
          if (!drag.current) return;
          changeHeight(drag.current.height, false);
          drag.current = null;
        }}
        onDoubleClick={() => changeHeight(DEFAULT, true)}
        onKeyDown={(e) => {
          const next = { ArrowUp: height + 4, ArrowDown: height - 4, Home: MIN, End: MAX }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          changeHeight(next, true);
        }}
      />
      <div id="control-dock-content">{children}</div>
    </div>
  );
}
