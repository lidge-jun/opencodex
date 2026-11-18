import { useEffect, useRef, useState, type FormEvent } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { authorizeDesktop, CompatibilityApiError } from "../desktop-compatibility-api";

export default function DesktopCompatibilityAuthorization({ apiBase, authorized, onAuthorized }: {
  apiBase: string; authorized: boolean; onAuthorized: () => Promise<void>;
}) {
  const t = useT(), [grant, setGrant] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const owner = useRef({ alive: true, pending: false, operation: null as BoundedFetch | null });
  useEffect(() => { const current = owner.current; current.alive = true; return () => {
    current.alive = false; current.operation?.controller.abort(); current.operation?.clear();
  }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); const current = owner.current; if (current.pending) return;
    current.pending = true; setBusy(true); setError(null); const code = grant.trim(); setGrant("");
    const operation = createBoundedFetch(15000); current.operation = operation;
    try {
      await authorizeDesktop(apiBase, code, operation.signal);
      if (current.alive) await onAuthorized();
    } catch (cause) { if (current.alive) setError(cause instanceof CompatibilityApiError ? cause.code : "connection_unconfirmed"); }
    finally { operation.clear(); current.pending = false; current.operation = null; if (current.alive) setBusy(false); }
  }
  return <div className="panel">
    <p className={authorized ? "notice-ok" : "notice-warn"}>{t(authorized ? "desktopCompat.authorized" : "desktopCompat.authorizeHint")}</p>
    {!authorized && <form onSubmit={event => void submit(event)}>
      <pre><code>{`ocx gui pair --desktop --origin ${new URL(apiBase || "/", window.location.href).origin}`}</code></pre>
      <label>{t("desktopCompat.authorizationCode")}<input className="input" type="password" autoComplete="off" value={grant} disabled={busy} onChange={event => setGrant(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={busy || !grant.trim()}>{t("desktopCompat.authorize")}</button>
    </form>}
    {error && <p className="notice-err" role="alert">{t("desktopCompat.authorizeHint")} <code>{error}</code></p>}
  </div>;
}
