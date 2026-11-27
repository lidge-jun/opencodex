import { useEffect, useState } from "react";
import { validProfileName } from "../../../../src/adapters/agy-acp/profile-name";
import { isApiTargetCaptureCurrent, targetFetch } from "../../api";
import { setClientResourceData, useKeyedClientResource } from "../../client-resource";
import { useT } from "../../i18n/shared";
import { useRenderTargetCapture } from "../../use-render-target-capture";

type Accounts = { names: string[]; selected: string; canOpenTerminal: boolean };

export default function AgyAccounts({ apiBase, targetKey }: { apiBase: string; targetKey?: string }) {
  const t = useT();
  const capture = useRenderTargetCapture(apiBase, targetKey);
  const endpoint = apiBase + "/api/antigravity-acp/accounts";
  const key = JSON.stringify(["agy-accounts", apiBase, targetKey]);
  const [name, setName] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data, loading, lastAttemptOk, refresh } = useKeyedClientResource(key, [capture], async signal => {
    const res = await targetFetch(capture, endpoint, { signal, cache: "no-store" });
    if (!res.ok) throw new Error("Account list unavailable");
    return await res.json() as Accounts;
  }, { pollMs: pending ? 2500 : undefined, staleAfterMs: 0 });

  const signedIn = !!pending && data?.names.includes(pending);
  if (signedIn) {
    setPending("");
    setName("");
  }
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(""), 10 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  async function change(action: "add" | "use", label: string) {
    if (busy || !isApiTargetCaptureCurrent(capture)) return;
    setBusy(true);
    setError("");
    try {
      const res = await targetFetch(capture, endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: label }) });
      if (!isApiTargetCaptureCurrent(capture)) return;
      if (!res.ok) {
        setError(action === "use" ? t("prov.accountSwitchFail") : t("agyAccounts.manual"));
        return;
      }
      if (action === "add") setPending(label);
      else setClientResourceData(key, await res.json() as Accounts);
    } catch { setError(t("prov.networkError")); }
    finally { setBusy(false); }
  }

  const label = name.trim();
  const valid = validProfileName(label);
  const duplicate = data?.names.includes(label);
  return (
    <section className="pwi-auth-section">
      <div className="pwi-auth-head">
        <h3>{t("agyAccounts.title")}</h3>
        <button type="button" className="btn btn-ghost" onClick={() => refresh()}>{t("startup.refresh")}</button>
      </div>
      <p className="pwi-auth-wait-copy">{t("agyAccounts.hint")}</p>
      {loading ? <p role="status">{t("common.loading")}</p> : !lastAttemptOk && <p role="alert">{t("agyAccounts.unavailable")}</p>}
      {data && <>
        <ul className="pwi-auth-list">
          {data.names.map(account => <li key={account} className={account === data.selected ? "pwi-auth-optin-row pwi-auth-row--active" : "pwi-auth-optin-row"}>
            <span className="pwi-auth-optin-label">{account === "default" ? t("agyAccounts.default") : account}</span>
            {account === data.selected ? <strong>{t("pws.accountCurrent")}</strong>
              : <button type="button" className="btn btn-ghost" disabled={busy || !lastAttemptOk}
                  onClick={() => void change("use", account)}>{t("prov.accountSwitchTitle")}</button>}
          </li>)}
        </ul>
        <form className="pwi-auth-actions" onSubmit={event => {
          event.preventDefault();
          if (valid && !duplicate && data.canOpenTerminal && !pending && lastAttemptOk) void change("add", label);
        }}>
          <label>{t("agyAccounts.label")}
            <input className="input" value={name} maxLength={32} disabled={busy || !!pending}
              onChange={event => { setName(event.target.value); setError(""); }} />
          </label>
          {data.canOpenTerminal && <button type="submit" className="btn btn-primary" disabled={!valid || duplicate || busy || !!pending || !lastAttemptOk}>
            {t("pws.addAccount")}
          </button>}
        </form>
        {!!name && (!valid || duplicate) && <p role="status">{t(duplicate ? "agyAccounts.exists" : "agyAccounts.format")}</p>}
        {pending && <p role="status">{t("agyAccounts.pending")}</p>}
        {(!data.canOpenTerminal || error) && <div role="status">
          <p>{error || t("agyAccounts.manual")}</p>
          {(!data.canOpenTerminal || error === t("agyAccounts.manual")) && <code>ocx account agy add {valid ? label : "work"}</code>}
        </div>}
      </>}
    </section>
  );
}
