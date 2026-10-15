import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Switch } from "../ui";
import { setClientResourceData, useClientResource } from "../client-resource";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { CompatibilityApiError, readCompatibilityStartupSettings, saveCompatibilityStartupSettings } from "../desktop-compatibility-api";

export default function DesktopCompatibilityStartupSetting({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT(), key = `desktop-compatibility-startup:${apiBase}`;
  const resource = useClientResource(key, signal => readCompatibilityStartupSettings(apiBase, signal), { enabled: active, deadlineMs: 15000, staleAfterMs: 0 });
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null);
  const ownership = useRef({ alive: true, pending: false, operation: null as BoundedFetch | null });
  useEffect(() => { const owned = ownership.current; owned.alive = true;
    return () => { owned.alive = false; owned.operation?.controller.abort(); owned.operation?.clear(); }; }, []);
  async function run(toggle: boolean) {
    const owner = ownership.current;
    if (owner.pending || (toggle && !resource.data)) return;
    owner.pending = true; setBusy(true); setError(null);
    const op = createBoundedFetch(15000); owner.operation = op;
    try {
      if (toggle) await saveCompatibilityStartupSettings(apiBase, resource.data!, !resource.data!.startOnProxyStart, op.signal);
      const actual = await readCompatibilityStartupSettings(apiBase, op.signal);
      if (owner.alive) { setClientResourceData(key, actual); setUncertain(false); }
    } catch (cause) {
      if (owner.alive) { setUncertain(true); setError(cause instanceof CompatibilityApiError ? cause.code : "connection_unconfirmed"); }
    } finally { op.clear(); owner.operation = null; owner.pending = false; if (owner.alive) setBusy(false); }
  }
  const readError = resource.error instanceof CompatibilityApiError ? resource.error.code : resource.error ? "connection_unconfirmed" : null;
  return <div className="panel">
    <Switch on={resource.data?.startOnProxyStart === true} label={t("desktopCompat.autoStart")} showLabel
      disabled={busy || uncertain || !resource.lastAttemptOk || resource.refreshing} onClick={() => void run(true)} />
    <p className="muted text-control">{t("desktopCompat.autoStartHint")}</p>
    {(error || readError) && <p className="notice-err" role="alert">{t("desktopCompat.error")} <code>{error ?? readError}</code></p>}
    {(uncertain || readError) && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(false)}>{t("desktopCompat.refresh")}</button>}
  </div>;
}
