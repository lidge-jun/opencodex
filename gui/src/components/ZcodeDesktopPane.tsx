import { useEffect, useState } from "react";
import { useT } from "../i18n/shared";

interface Status {
  connected: boolean; issue?: string; runtimes: string[]; runtime: string; workspace: string;
  activation?: string; providerName?: string; error?: string;
  models: Array<{ id: string; label: string }>;
}
interface Folders { current: string; parent: string | null; folders: Array<{ name: string; path: string }> }

export default function ZcodeDesktopPane({ apiBase, onConnected, onBack, error: parentError }: {
  apiBase: string; onConnected?: (name: string) => void; onBack?: () => void; error?: string;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [runtime, setRuntime] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const [model, setModel] = useState("");
  const [folders, setFolders] = useState<Folders | null>(null);
  const applyStatus = (next: Status) => {
    setStatus(next); setRuntime(next.runtime); setWorkspace(next.workspace);
    setModel(next.models[0]?.id ?? ""); setError(next.error ?? next.issue ?? "");
  };
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBase}/api/zcode-desktop`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const next = await response.json() as Status;
      if (!controller.signal.aborted) applyStatus(next);
    }).catch(() => { if (!controller.signal.aborted) setError("runtime_failed"); });
    return () => controller.abort();
  }, [apiBase]);

  const perform = async (action: "refresh" | "connect" | "activate" | "disconnect" | "test") => {
    setBusy(true); setError(""); setTested(false);
    try {
      const response = await fetch(`${apiBase}/api/zcode-desktop${action === "refresh" ? "" : `/${action}`}`, action === "refresh" ? {} : {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "connect" || action === "activate" ? { runtime, workspace, consent } : action === "test" ? { model, consent: true } : {}),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "runtime_failed"); return; }
      if (action === "test") setTested(result.ok === true);
      else {
        applyStatus(result as Status); setConsent(false);
        if ((action === "connect" || action === "activate") && result.activation === "ready" && result.providerName) onConnected?.(result.providerName);
      }
    } catch { setError("runtime_failed"); }
    finally { setBusy(false); }
  };
  const browse = async (path?: string) => {
    try {
      const response = await fetch(`${apiBase}/api/zcode-desktop/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`);
      if (!response.ok) throw new Error();
      setFolders(await response.json());
    } catch { setError("workspace_invalid"); }
  };
  const problem = error === "desktop_missing" ? t("zcodeDesktop.missing")
    : error === "sandbox_missing" ? t("zcodeDesktop.sandboxMissing")
    : error === "node_missing" ? t("zcodeDesktop.nodeMissing")
    : error === "node_incompatible" ? t("zcodeDesktop.nodeIncompatible")
    : error === "platform_unsupported" ? t("zcodeDesktop.platformUnsupported")
    : error === "profile_missing" || error === "models_missing" ? t("zcodeDesktop.loginNeeded")
    : error === "workspace_invalid" ? t("zcodeDesktop.workspaceInvalid")
    : error === "inference_failed" ? t("zcodeDesktop.inferenceFailed")
    : error === "provider_registration_failed" ? t("zcodeDesktop.providerPending")
    : error === "catalog_update_failed" ? t("zcodeDesktop.catalogPending")
    : error ? t("zcodeDesktop.failed") : "";
  const changed = runtime !== status?.runtime || workspace !== status?.workspace;
  const partial = status?.connected && status.activation !== "ready";
  return <section className="setup-guide" style={{ padding: 16, display: "grid", gap: 12 }} aria-label="ZCode Desktop">
    <strong>ZCode Desktop</strong>
    <p className="muted text-label">{t("zcodeDesktop.intro")}</p>
    <div role="status">{status?.connected ? status.activation === "ready" ? t("zcodeDesktop.connected")
      : status.activation === "provider_pending" ? t("zcodeDesktop.providerPending") : t("zcodeDesktop.catalogPending")
      : t("zcodeDesktop.notConnected")}</div>
    <p className="muted text-label">{t("zcodeDesktop.restartNotice")}</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <a className="btn btn-ghost" href="zcode://">{t("zcodeDesktop.open")}</a>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void perform("refresh")}>{t("zcodeDesktop.detect")}</button>
      <a href="https://zcode.z.ai/en/docs/install" target="_blank" rel="noreferrer">{t("zcodeDesktop.download")}</a>
    </div>
    {runtime && <code className="text-hint" style={{ overflowWrap: "anywhere" }}>{runtime}</code>}
    <details open={!runtime}>
      <summary>{t("zcodeDesktop.location")}</summary>
      <label className="modal-field"><span>{t("zcodeDesktop.location")}</span>
        <input className="input" value={runtime} disabled={busy} onChange={e => { setRuntime(e.target.value); setConsent(false); }} />
      </label>
      {status?.runtimes.map(path => <button key={path} type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setRuntime(path); setConsent(false); }}><code>{path}</code></button>)}
    </details>
    <label className="modal-field"><span>{t("zcodeDesktop.workspace")}</span>
      <input className="input" value={workspace} disabled={busy} onChange={e => { setWorkspace(e.target.value); setConsent(false); }} />
    </label>
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void browse()}>{t("zcodeDesktop.browse")}</button>
    {folders && <div style={{ maxHeight: 200, overflow: "auto", display: "grid", gap: 4 }}>
      <code>{folders.current}</code>
      {folders.parent && <button type="button" className="btn btn-ghost" onClick={() => void browse(folders.parent!)}>{t("zcodeDesktop.up")}</button>}
      {folders.folders.map(folder => <div key={folder.path} style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={() => void browse(folder.path)}>{folder.name}</button>
        <button type="button" className="btn" onClick={() => { setWorkspace(folder.path); setFolders(null); setConsent(false); }}>{t("zcodeDesktop.select")}</button>
      </div>)}
    </div>}
    {(!status?.connected || changed || partial) && <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
      <input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
      <span className="text-label">{t("zcodeDesktop.consent")}</span>
    </label>}
    {(problem || parentError) && <p role="alert">{parentError || problem}</p>}
    {tested && <p role="status">{t("zcodeDesktop.testPassed")}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {onBack && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onBack}>{t("zcodeDesktop.back")}</button>}
      {(!status?.connected || changed) && <button type="button" className="btn btn-primary" disabled={busy || !consent || !runtime || !workspace} onClick={() => void perform("connect")}>{t("zcodeDesktop.connect")}</button>}
      {status?.connected && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void perform("disconnect")}>{t("zcodeDesktop.disconnect")}</button>}
      {partial && !changed && <button type="button" className="btn btn-primary" disabled={busy || !consent} onClick={() => void perform("activate")}>{t("zcodeDesktop.retryActivation")}</button>}
    </div>
    {status?.connected && !changed && <>
      <p className="muted text-label">{t("zcodeDesktop.testHint")}</p>
      <label className="modal-field"><span>{t("zcodeDesktop.model")}</span>
        <select className="input" value={model} disabled={busy} onChange={e => setModel(e.target.value)}>{status.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
      </label>
      <button type="button" className="btn" disabled={busy || !model} onClick={() => void perform("test")}>{t("zcodeDesktop.test")}</button>
    </>}
  </section>;
}
