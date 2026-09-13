import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";

type Account = { id: string; label: string; activation: string; busy: boolean; providerName?: string };
type Job = { jobId: string; accountId: string; phase: string; url?: string; error?: string };
type Activation = { activation?: string; providerName?: string };
export default function ZcodeAccountsPane({ apiBase, runtime, workspace, onProviderActivated, onProviderStateMutation }: {
  apiBase: string;
  runtime: string;
  workspace: string;
  onProviderActivated?: (name: string) => void;
  onProviderStateMutation?: () => void;
}) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [label, setLabel] = useState("");
  const [consented, setConsented] = useState<string | null>(null);
  const consentScope = JSON.stringify([apiBase, runtime, workspace]);
  const consent = consented === consentScope;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const onProviderActivatedRef = useRef(onProviderActivated);
  const onProviderStateMutationRef = useRef(onProviderStateMutation);
  useEffect(() => { onProviderActivatedRef.current = onProviderActivated; }, [onProviderActivated]);
  useEffect(() => { onProviderStateMutationRef.current = onProviderStateMutation; }, [onProviderStateMutation]);
  const read = useCallback(async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(apiBase + "/api/zcode-accounts" + path, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, consent: true }),
    } : undefined);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "native_oauth_failed");
    return value;
  }, [apiBase]);
  const refresh = useCallback(async () => {
    const value = await read("");
    setAccounts(value.accounts ?? []);
  }, [read]);
  const completeJob = useCallback(async (current: Job, stopped: () => boolean = () => false) => {
    let result: Activation;
    try {
      result = await read("/complete", { jobId: current.jobId }) as Activation;
    } catch (e) {
      if (!stopped()) {
        setError(e instanceof Error ? e.message : "native_oauth_failed");
        // A recovery retry already owns a finished, idempotent job. Keep that state so a
        // transient /complete failure cannot restart OAuth polling or hide Retry activation.
        setJob({ ...current, phase: current.phase === "recovery" ? "recovery" : "authenticated", url: undefined });
      }
      return;
    }
    if (stopped()) return;
    onProviderStateMutationRef.current?.();
    const ready = result.activation === "ready";
    let refreshFailed = false;
    try { await refresh(); } catch { refreshFailed = true; }
    if (stopped()) return;
    setError(!ready ? "catalog_update_failed" : refreshFailed ? "account_refresh_failed" : "");
    // Server completion is idempotent. Retain its finished job id whenever the account row could
    // not be refreshed so the user can retry /complete directly without repeating OAuth. This
    // also covers a ready provider whose new account row is not visible in existing Settings.
    setJob({ ...current, phase: refreshFailed ? "recovery" : "finished", url: undefined });
    if (ready && result.providerName && onProviderActivatedRef.current) {
      onProviderActivatedRef.current(result.providerName);
    }
  }, [read, refresh]);
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
          await completeJob(next, () => stopped);
        } else { setJob(next); if (next.phase === "failed") { setError(next.error || "native_oauth_failed"); await refresh(); } }
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : "native_oauth_failed"); setJob(j => j ? { ...j, phase: "failed", url: undefined } : null); } }
      finally { pending = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [jobId, jobPhase, consent, read, refresh, completeJob]);
  const action = async (path: string, body: Record<string, unknown>) => {
    if ((!consent && path !== "/cancel") || busy) return;
    setBusy(true); setError("");
    try {
      const result = await read(path, body);
      if (path === "/login") setJob(result);
      else if (path === "/cancel") setJob(null);
      else if (result.activation && result.activation !== "ready") setError("catalog_update_failed");
      if (path === "/activate" || path === "/rename" || path === "/remove") {
        onProviderStateMutationRef.current?.();
      }
      const ready = path === "/activate" && result.activation === "ready";
      const activation = ready && result.providerName && onProviderActivatedRef.current
        ? { name: result.providerName, notify: onProviderActivatedRef.current } : undefined;
      try { await refresh(); } catch (error) { if (path !== "/activate") throw error; }
      if (activation) activation.notify(activation.name);
    } catch (e) {
      const code = e instanceof Error ? e.message : "native_oauth_failed";
      // Removal revokes and persists provider state before catalog convergence. Its bounded
      // partial error must still invalidate the parent and refresh this account list.
      if (path === "/remove" && ["account_removal_partial", "catalog_update_failed"].includes(code)) {
        onProviderStateMutationRef.current?.();
        try { await refresh(); } catch { /* The mutation callback remains authoritative. */ }
      }
      setError(code);
    }
    finally { setBusy(false); }
  };
  const retryCompletion = async () => {
    if (!job || job.phase !== "recovery" || !consent || busy) return;
    setBusy(true); setError("");
    try { await completeJob(job); } finally { setBusy(false); }
  };
  // Failed jobs retain their hidden profile until Cancel, so they must also block another Add or
  // Reconnect attempt. The server applies the same ownership rule and the ten-minute expiry is a
  // final cleanup bound rather than the ordinary retry path.
  const loggingIn = !!job && ["waiting", "authenticated", "failed"].includes(job.phase);
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
    {job && ["waiting", "authenticated"].includes(job.phase) && <div role="status">
      <p>{t("zcodeAccounts.loginHint")}</p>
      {job.url && <a href={job.url} target="_blank" rel="noopener noreferrer">{t("zcodeAccounts.login")}</a>}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void action("/cancel", { jobId: job.jobId })}>{t("common.cancel")}</button>
    </div>}
    {job?.phase === "failed" && <button type="button" className="btn btn-ghost" disabled={busy}
      onClick={() => void action("/cancel", { jobId: job.jobId })}>{t("common.cancel")}</button>}
    {job?.phase === "recovery" && <div role="status">
      <p>{t("zcodeAccounts.pending")}</p>
      <button type="button" className="btn btn-primary" disabled={!consent || busy}
        onClick={() => void retryCompletion()}>{t("zcodeDesktop.retryActivation")}</button>
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
