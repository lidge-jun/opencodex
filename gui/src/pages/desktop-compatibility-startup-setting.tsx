import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Switch } from "../ui";
import { setClientResourceData, useClientResource } from "../client-resource";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { CompatibilityApiError, readCompatibilityStartupSettings, saveCompatibilityStartupSettings } from "../desktop-compatibility-api";
import { SESSION_CHANGED_EVENT } from "../api";

export default function DesktopCompatibilityStartupSetting({ apiBase, active, authorized }: { apiBase: string; active: boolean; authorized: boolean }) {
  const t = useT(), key = `desktop-compatibility-startup:${apiBase}`;
  const resource = useClientResource(key, signal => readCompatibilityStartupSettings(apiBase, signal), { enabled: active, deadlineMs: 15000, staleAfterMs: 0 });
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null);
  const ownership = useRef({ alive: true, pending: false, generation: 0, refreshRequired: false, operation: null as BoundedFetch | null });
  useEffect(() => { const owned = ownership.current; owned.alive = true;
    const invalidate = () => {
      owned.generation++; owned.pending = false;
      owned.operation?.controller.abort(); owned.operation?.clear(); owned.operation = null;
    };
    const expire = (event: Event) => {
      if ((event as CustomEvent<{ plane?: string }>).detail?.plane !== "machine") return;
      const interrupted = owned.pending;
      if (interrupted) owned.refreshRequired = true;
      invalidate(); setBusy(false);
      if (interrupted) { setUncertain(true); setError("connection_unconfirmed"); }
    };
    window.addEventListener(SESSION_CHANGED_EVENT, expire);
    return () => { window.removeEventListener(SESSION_CHANGED_EVENT, expire); owned.alive = false; invalidate(); }; }, []);
  async function run(toggle: boolean) {
    const owner = ownership.current;
    if (!owner.alive || owner.pending || (toggle && (owner.refreshRequired || !resource.data || !authorized))) return;
    owner.pending = true; const generation = ++owner.generation; setBusy(true); setError(null);
    const op = createBoundedFetch(15000); owner.operation = op;
    const current = () => owner.alive && owner.generation === generation && owner.operation === op;
    try {
      if (toggle) await saveCompatibilityStartupSettings(apiBase, resource.data!, !resource.data!.startOnProxyStart, op.signal);
      if (!current()) return; op.signal.throwIfAborted();
      const actual = await readCompatibilityStartupSettings(apiBase, op.signal);
      if (!current()) return; op.signal.throwIfAborted();
      owner.refreshRequired = false; setClientResourceData(key, actual); setUncertain(false);
    } catch (cause) {
      if (current()) { owner.refreshRequired = true; setUncertain(true); setError(cause instanceof CompatibilityApiError ? cause.code : "connection_unconfirmed"); }
    } finally {
      op.clear();
      if (owner.operation === op) owner.operation = null;
      if (owner.generation === generation) { owner.pending = false; if (owner.alive) setBusy(false); }
    }
  }
  const readError = resource.error instanceof CompatibilityApiError ? resource.error.code : resource.error ? "connection_unconfirmed" : null;
  return <div className="panel">
    <Switch on={resource.data?.startOnProxyStart === true} label={t("desktopCompat.autoStart")} showLabel
      disabled={!authorized || busy || uncertain || !resource.lastAttemptOk || resource.refreshing} onClick={() => void run(true)} />
    <p className="muted text-control">{t("desktopCompat.autoStartHint")}</p>
    {(error || readError) && <p className="notice-err" role="alert">{t("desktopCompat.error")} <code>{error ?? readError}</code></p>}
    {(uncertain || readError) && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(false)}>{t("desktopCompat.refresh")}</button>}
  </div>;
}
