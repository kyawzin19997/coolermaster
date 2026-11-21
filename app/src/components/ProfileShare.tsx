import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, type EngineView, type ProfileSummary } from "../engine";
import { t, useLanguage } from "../i18n";
import { Icon } from "./Icon";
import { ToastMessage } from "./Notice";
import { Sheet, exportProfileFile } from "./Panels";

type NamedProfile = Pick<ProfileSummary, "id" | "name">;
type Link = { url: string; qr: string; seconds: number };

export function ProfilePicker({ view, onClose }: { view: EngineView; onClose: () => void }) {
  useLanguage();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const profiles = (view.state?.profiles ?? []).filter((p) => !p.draft && p.name.toLocaleLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
  const switchTo = async (id: string) => {
    setPending(true);
    try { await api.activate(id); onClose(); }
    catch (error) { setError(String(error)); setPending(false); }
  };
  return (
    <Sheet label={t("profiles.switcher")} className="profile-picker-dialog" onClose={onClose}>
      <section className="share-sheet">
        <header className="workspace-pane-head"><h2>{t("profiles.switcher")}</h2><button className="icon-btn" aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button></header>
        <div className="share-body">
          <input className="input" aria-label={t("profiles.search")} placeholder={t("profiles.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="profile-picker-list">
            {profiles.map((profile) => <button key={profile.id} className="menu-row" disabled={pending} onClick={() => void switchTo(profile.id)}>
              <Icon name="layers" /><span>{profile.name}</span>
              {profile.id === view.state?.active && <span className="muted">{t("profiles.active")}</span>}
            </button>)}
            {!profiles.length && <p className="help">{t("profiles.none")}</p>}
          </div>
          {error && <ToastMessage message={error} />}
        </div>
      </section>
    </Sheet>
  );
}

export function ProfileShare({ profile, onClose }: { profile: NamedProfile; onClose: () => void }) {
  useLanguage();
  const [link, setLink] = useState<(Link & { expires: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const systemShare = /Windows|Macintosh/i.test(navigator.userAgent);
  useEffect(() => {
    if (!link) return;
    const timer = window.setTimeout(() => { setLink(null); setCopied(false); }, Math.max(0, link.expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [link]);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const generate = () => run(async () => {
    const result = await invoke<Link>("profile_share_link", { id: profile.id });
    setLink({ ...result, expires: Date.now() + result.seconds * 1000 });
    setCopied(false);
  });
  return (
    <Sheet label={t("profile.shareNamed", { name: profile.name })} onClose={onClose} className="profile-share-dialog">
      <section className="share-sheet">
        <header className="workspace-pane-head"><div><h2>{t("profile.share")}</h2><p className="muted">{profile.name}</p></div>
          <button className="icon-btn" aria-label={t("profile.close")} onClick={onClose}><Icon name="x" /></button></header>
        <div className="share-body">
          <div className="row wrap">
            {systemShare && <button type="button" className="tool primary" disabled={busy} onClick={() => void run(() => invoke("profile_share_native", { id: profile.id }))}><Icon name="share" />{t("profile.shareSystem")}</button>}
            <button type="button" className="tool" disabled={busy} onClick={() => void run(() => exportProfileFile(profile))}><Icon name="download" />{t("profile.export")}</button>
          </div>
          <section className="profile-share-transfer">
            <h3>{t("profile.sharePhone")}</h3>
            <p className="help">{t("profile.shareNetwork")}</p>
            {link ? (
              <>
                <div className="phone-qr" role="img" aria-label={t("phone.code")} dangerouslySetInnerHTML={{ __html: link.qr }} />
                <p className="help">{t("profile.shareImport")}</p>
                <div className="row wrap">
                  <button className="tool small" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(link.url); setCopied(true); })}>{t(copied ? "phone.copied" : "phone.copy")}</button>
                  <button className="tool small ghost" disabled={busy} onClick={() => void run(async () => { await invoke("profile_share_stop"); setLink(null); setCopied(false); })}>{t("profile.shareStop")}</button>
                </div>
              </>
            ) : <button className="tool small" disabled={busy} onClick={() => void generate()}>{t("profile.shareGenerate")}</button>}
          </section>
          {error && <ToastMessage message={error} />}
        </div>
      </section>
    </Sheet>
  );
}
