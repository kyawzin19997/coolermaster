import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "../confirm";
import { t, useLanguage } from "../i18n";
import { Icon } from "./Icon";
import { Sheet } from "./Panels";

type Link = { url: string; qr: string };
type Upload = { id: string; name: string; size: number; bytes: number; speed: number; complete: boolean; kind: "plugin" | "profile" | "icons" | "file" };
type Status = {
  local: Link | null; remote: Link | null; remoteStatus: string; expired: boolean; pairSeconds: number;
  phone: { code: string; status: "pending" | "approved" | "denied"; mode: "local" | "internet"; online: boolean } | null;
  files: Upload[];
};

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

export function PhoneUpload({ onClose, onImport }: {
  onClose: () => void;
  onImport: (path: string, kind: Upload["kind"], name: string) => Promise<void> | void;
}) {
  useLanguage();
  const [state, setState] = useState<Status | null>(null);
  const [mode, setMode] = useState<"local" | "internet">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const refresh = () => invoke<Status>("phone_status").then(setState);
  const start = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try { setState(await invoke<Status>("phone_start")); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let live = true;
    invoke<Status>("phone_status").then((result) => { if (live) setState(result); }, () => { if (live) void start(); });
    const poll = window.setInterval(() => {
      invoke<Status>("phone_status").then((result) => { if (live) setState(result); }, () => {});
    }, 600);
    return () => { live = false; window.clearInterval(poll); };
  }, []);

  const command = (name: string, args: Record<string, unknown>) => {
    setError("");
    void invoke(name, args).then(refresh).catch((e) => setError(String(e)));
  };
  const review = async (file: Upload) => {
    setError("");
    try {
      if (file.kind === "file") {
        const destination = await save({ defaultPath: file.name });
        if (destination) await invoke("phone_save", { file: file.id, path: destination });
        return;
      }
      const path = await invoke<string>("phone_path", { file: file.id });
      await onImport(path, file.kind, file.name);
    } catch (e) { setError(String(e)); }
  };
  const stop = () => { command("phone_stop", {}); };
  const active = state?.phone?.status === "approved" && !state.expired;
  const link = state && (mode === "local" ? state.local : state.remote);
  const linkVisible = link && !state?.expired && !!state?.pairSeconds && !active;
  const connection = active ? state.phone : null;
  const name = (mode: string) => t(mode === "internet" ? "phone.internet" : "phone.local");

  return (
    <Sheet label={t("phone.title")} onClose={onClose}>
      <section className="phone-panel">
        <header className="row phone-heading"><Icon name="upload" /><h2 className="grow">{t("phone.title")}</h2><button className="icon-btn" aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button></header>
        <div className="phone-body">
          {!state && busy && <p className="help" role="status">{t("phone.starting")}</p>}
          {!connection && state && !state.expired && (
            <div className="seg" aria-label={t("phone.connection")} role="group">
              <button className={`tab${mode === "local" ? " is-active" : ""}`} aria-pressed={mode === "local"} onClick={() => setMode("local")}>{name("local")}</button>
              <button className={`tab${mode === "internet" ? " is-active" : ""}`} aria-pressed={mode === "internet"} onClick={() => setMode("internet")}>{name("internet")}</button>
            </div>
          )}
          {linkVisible && !state.phone && (
            <div className="phone-qr-row">
              <div className="phone-qr" role="img" aria-label={t("phone.code")} dangerouslySetInnerHTML={{ __html: link.qr }} />
              <div><p>{t("phone.scan")}</p><p className="help">{t(mode === "local" ? "phone.localHelp" : "phone.remoteHelp")}</p><button className="tool small" onClick={() => navigator.clipboard.writeText(link.url).then(() => setCopied(true), () => setError(t("phone.copyFailed")))}>{t(copied ? "phone.copied" : "phone.copy")}</button></div>
            </div>
          )}
          {state && !state.expired && !active && !state.phone && (!link || state.pairSeconds === 0) && <p className="help">{state.pairSeconds === 0 ? t("phone.expired") : mode === "internet" ? state.remoteStatus : t("phone.noLocal")}</p>}
          {!state?.expired && state?.phone?.status === "pending" && state.pairSeconds > 0 && (
            <div className="phone-approval">
              <div><span className="help">{t("phone.match")}</span><strong className="mono">{state.phone.code}</strong></div>
              <button className="tool" onClick={() => command("phone_approve", { code: state.phone?.code, approve: false })}>{t("phone.decline")}</button>
              <button className="tool primary" onClick={() => command("phone_approve", { code: state.phone?.code, approve: true })}>{t("phone.approve")}</button>
            </div>
          )}
          {state?.phone?.status === "denied" && !state.expired && <p className="help">{t("phone.declined")}</p>}
          {connection && <p role="status">{t(connection.online ? "phone.connected" : "phone.reconnect", { mode: name(connection.mode) })}</p>}
          {state?.expired && <p role="status" className="help">{t("phone.ended")}</p>}
          {!!state?.files.length && (
            <ul className="phone-files">
              {state.files.map((file) => <li key={file.id}>
                <div className="grow"><strong>{file.name}</strong>
                  {!file.complete && <progress max={file.size} value={file.bytes} aria-label={file.name} />}
                  <small>{file.complete ? `${size(file.size)} · ${t("phone.verified")}` : `${size(file.bytes)} / ${size(file.size)} · ${size(file.speed)}/s`}</small>
                </div>
                {file.complete ? <button className="tool small" onClick={() => void review(file)}>{t(file.kind === "file" ? "phone.save" : file.kind === "plugin" ? "plugins.reviewTitle" : "profile.import")}</button>
                  : !state.expired && <button className="tool small" onClick={() => command("phone_cancel", { file: file.id })}>{t("chooser.cancel")}</button>}
              </li>)}
            </ul>
          )}
          {error && <p className="plugin-feedback help" role="alert">{error}</p>}
          <div className="row wrap phone-actions">
            {state && !state.expired && <button className="tool ghost" onClick={stop}>{t("phone.end")}</button>}
            {(!state || state.expired || state.pairSeconds === 0 && !active || state.phone?.status === "denied" || !state.local && !state.remote)
              && <button className="tool" disabled={busy} onClick={() => void start()}>{t("phone.new")}</button>}
          </div>
        </div>
      </section>
    </Sheet>
  );
}
