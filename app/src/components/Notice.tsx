import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { Icon } from "./Icon";

type Tone = "info" | "warn" | "err";
export const NOTICE_ROOT = "application-notices";

export function Notice({ tone = "info", severity, onDismiss, children }: {
  tone?: Tone;
  severity?: "status" | "alert";
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className={`notice is-${tone}`} role={severity ?? (tone === "err" ? "alert" : "status")}>
      <div className="notice-body">{children}</div>
      <button type="button" className="icon-btn notice-close" aria-label={t("workshop.dismiss")} onClick={() => {
        setDismissed(true);
        onDismiss?.();
      }}><Icon name="x" /></button>
    </div>
  );
}

export function ToastMessage({ message, tone = "err" }: { message: string; tone?: Tone }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.getElementById(NOTICE_ROOT)), []);
  return target && createPortal(
    <Notice key={message} tone={tone}>
      {tone !== "info" && <Icon name="alert" />}
      <span className="grow">{message}</span>
    </Notice>,
    target,
  );
}
