import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";

type Account = { id: string; label: string; activation: string; busy: boolean; providerName?: string };
type Job = { jobId: string; accountId: string; phase: string; url?: string; error?: string };
export default function ZcodeAccountsPane({ apiBase, runtime, workspace }: { apiBase: string; runtime: string; workspace: string }) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [label, setLabel] = useState("");
  const [consented, setConsented] = useState<string | null>(null);
  const consentScope = JSON.stringify([apiBase, runtime, workspace]);
  const consent = consented === consentScope;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useCallback(async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(apiBase + "/api/zcode-accounts" + path, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, consent: true }),
    } : undefined);
    const value = await response.json();
    if (!response.ok || value.error) throw new Error(value.error || "native_oauth_failed");
    return value;
  }, [apiBase]);
  const refresh = useCallback(async () => {
    const value = await read("");
    setAccounts(value.accounts ?? []);
  }, [read]);
  useEffect(() => {
    let stopped = false;
    void read("").then(value => { if (!stopped) setAccounts(value.accounts ?? []); })
      .catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [read]);
  const jobId = job?.jobId, jobPhase = job?.phase;
  useEffect(() => {
    if (!jobId || !consent || !["waiting", "authenticated"].includes(jobPhase ?? "")) return;
    let stopped = false, pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const next: Job = await read("/login?jobId=" + encodeURIComponent(jobId));
        if (stopped) return;
        if (next.phase === "authenticated") {
          const result = await read("/complete", { jobId: next.jobId });
          if (stopped) return;
          setJob({ ...next, phase: "finished", url: undefined });
          if (result.activation !== "ready") setError("catalog_update_failed");
          await refresh();
        } else { setJob(next); if (next.phase === "failed") { setError(next.error || "native_oauth_failed"); await refresh(); } }
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : "native_oauth_failed"); setJob(j => j ? { ...j, phase: "failed", url: undefined } : null); } }
      finally { pending = false; }
    };
    const timer = setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [jobId, jobPhase, consent, read, refresh]);
  const action = async (path: string, body: Record<string, unknown>) => {
    if ((!consent && path !== "/cancel") || busy) return;
    setBusy(true); setError("");
    try {
      const result = await read(path, body);
      if (path === "/login") setJob(result);
      else if (path === "/cancel") setJob(null);
      else if (result.activation && result.activation !== "ready") setError("catalog_update_failed");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "native_oauth_failed"); }
    finally { setBusy(false); }
  };
  const loggingIn = !!job && job.phase !== "finished";
  return <section style={{ display: "grid", gap: 8 }}>
    <h3>{t("zcodeAccounts.title")}</h3>
    <p className="muted text-label">{t("zcodeAccounts.help")}</p>
    <label className="modal-field"><span>{t("zcodeAccounts.name")}</span>
      <input className="input" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} />
    </label>
    <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={consent} onChange={e => setConsented(e.target.checked ? consentScope : null)} />
      <span>{t("zcodeAccounts.consent")}</span>
    </label>
    <button type="button" className="btn" disabled={!consent || busy || loggingIn || !label.trim() || !runtime || !workspace}
      onClick={() => void action("/login", { label, runtime, workspace })}>{t("zcodeAccounts.add")}</button>
    {job && job.phase !== "finished" && <div role="status">
      <p>{t("zcodeAccounts.loginHint")}</p>
      {job.url && <a href={job.url} target="_blank" rel="noopener noreferrer">{t("zcodeAccounts.login")}</a>}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void action("/cancel", { jobId: job.jobId })}>{t("common.cancel")}</button>
    </div>}
    {error && <p role="alert">{t("zcodeAccounts.failed")} <code>{error}</code></p>}
    {accounts.some(account => account.activation === "ready") && <p className="muted text-label">{t("zcodeDesktop.restartNotice")}</p>}
    {accounts.map(account => <div key={account.id} style={{ display: "grid", gap: 4 }}>
      <strong>{account.label}</strong>
      <span>{account.activation === "ready" ? t("zcodeDesktop.connected") : t("zcodeAccounts.pending")}</span>
      {account.providerName && <code>{account.providerName}</code>}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={!consent || busy || account.busy}
          onClick={() => void action("/activate", { accountId: account.id })}>{t("zcodeDesktop.retryActivation")}</button>
        <button type="button" className="btn" disabled={!consent || busy || account.busy || loggingIn || !runtime || !workspace}
          onClick={() => void action("/login", { accountId: account.id, label: account.label, runtime, workspace })}>{t("zcodeAccounts.reconnect")}</button>
        <button type="button" className="btn" disabled={!consent || busy || account.busy} onClick={() => {
          const name = window.prompt(t("zcodeAccounts.name"), account.label);
          if (name?.trim()) void action("/rename", { accountId: account.id, label: name });
        }}>{t("zcodeAccounts.rename")}</button>
        <button type="button" className="btn btn-ghost" disabled={!consent || busy || account.busy} onClick={() => {
          if (window.confirm(t("zcodeAccounts.removeConfirm"))) void action("/remove", { accountId: account.id });
        }}>{t("zcodeAccounts.remove")}</button>
      </div>
    </div>)}
  </section>;
}
