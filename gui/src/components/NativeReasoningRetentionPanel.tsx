import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Switch } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson } from "../pages/dashboard-shared";

interface Settings { modelSwitch: boolean; accountSwitch: boolean }
function readSettings(payload: unknown): Settings {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid reasoning settings");
  const value = payload as Record<string, unknown>;
  if (typeof value.modelSwitch !== "boolean" || typeof value.accountSwitch !== "boolean") {
    throw new Error("Missing reasoning settings");
  }
  return { modelSwitch: value.modelSwitch, accountSwitch: value.accountSwitch };
}

export default function NativeReasoningRetentionPanel({ apiBase }: { apiBase: string }) {
  return <NativeReasoningRetentionControls key={apiBase} apiBase={apiBase} />;
}

function NativeReasoningRetentionControls({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [saved, setSaved] = useState<Settings | undefined>();
  const [modelSwitch, setModelSwitch] = useState(false);
  const [accountSwitch, setAccountSwitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);
  const accept = useCallback((value: Settings) => {
    setSaved(value); setModelSwitch(value.modelSwitch); setAccountSwitch(value.accountSwitch);
  }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request; setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/native-reasoning-retention`, { signal: request.signal });
      const value = readSettings(await requireJson(response));
      if (active.current && pending.current === request) accept(value);
    } catch {
      if (active.current && pending.current === request) setLoadError(true);
    } finally {
      request.clear();
      if (pending.current === request) pending.current = null;
    }
  }, [apiBase, accept]);
  useEffect(() => {
    active.current = true;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer); active.current = false;
      pending.current?.controller.abort(); pending.current?.clear(); pending.current = null;
    };
  }, [load]);
  const save = async (reset = false) => {
    if (pending.current || saved === undefined) return;
    const request = createBoundedFetch(15_000);
    pending.current = request; setBusy(true); setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/native-reasoning-retention`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify(reset ? null : { modelSwitch, accountSwitch }),
      });
      const value = readSettings(await requireJson(response));
      if (active.current && pending.current === request) { accept(value); setFeedback("saved"); }
    } catch {
      if (active.current && pending.current === request) setFeedback("failed");
    } finally {
      request.clear();
      if (active.current && pending.current === request) setBusy(false);
      if (pending.current === request) pending.current = null;
    }
  };
  const disabled = busy || saved === undefined || loadError;
  const changed = modelSwitch !== saved?.modelSwitch || accountSwitch !== saved?.accountSwitch;
  return <section className="panel" aria-labelledby="native-reasoning-retention-title" aria-busy={busy || (saved === undefined && !loadError)}>
    <div className="font-semibold" id="native-reasoning-retention-title">{t("nativeReasoningRetention.title")}</div>
    <p className="muted setting-hint">{t("nativeReasoningRetention.description")}</p>
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div className="spread">
        <span>{t("nativeReasoningRetention.modelSwitch")}</span>
        <Switch on={modelSwitch} disabled={disabled} label={t("nativeReasoningRetention.modelSwitch")}
          onClick={() => { setModelSwitch(value => !value); setFeedback(null); }} />
      </div>
      <div className="spread">
        <span>{t("nativeReasoningRetention.accountSwitch")}</span>
        <Switch on={accountSwitch} disabled={disabled} label={t("nativeReasoningRetention.accountSwitch")}
          onClick={() => { setAccountSwitch(value => !value); setFeedback(null); }} />
      </div>
      <p className="muted setting-hint">{t("nativeReasoningRetention.accountHint")}</p>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={disabled || !changed} onClick={() => { void save(); }}>{t("common.save")}</button>
        <button type="button" className="btn btn-ghost" disabled={disabled || (!changed && !saved?.modelSwitch && !saved?.accountSwitch)} onClick={() => { void save(true); }}>{t("nativeReasoningRetention.reset")}</button>
      </div>
    </div>
    {loadError && <div className="notice notice-err" role="alert">{t("nativeReasoningRetention.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
    {feedback === "failed" && <div className="notice notice-err" role="alert">{t("nativeReasoningRetention.saveFailed")}</div>}
    {feedback === "saved" && <div className="muted setting-hint" role="status">{t("nativeReasoningRetention.saved")}</div>}
  </section>;
}
