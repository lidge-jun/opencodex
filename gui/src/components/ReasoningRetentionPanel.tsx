import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson } from "../pages/dashboard-shared";

type Setting = { maxContextPercent?: number; maxTokens?: number } | null;
function readSetting(payload: { reasoningRetention?: Setting }): Setting {
  if (!("reasoningRetention" in payload)) throw new Error("Missing reasoningRetention settings");
  return payload.reasoningRetention ?? null;
}

export default function ReasoningRetentionPanel({ apiBase }: { apiBase: string }) {
  return <ReasoningRetentionControls key={apiBase} apiBase={apiBase} />;
}
function ReasoningRetentionControls({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [saved, setSaved] = useState<Setting | undefined>();
  const [percent, setPercent] = useState("20");
  const [tokens, setTokens] = useState("100000");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);
  const accept = useCallback((value: Setting) => {
    setSaved(value);
    setPercent(String(value?.maxContextPercent ?? 20));
    setTokens(String(value?.maxTokens ?? 100000));
  }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: request.signal });
      const value = readSetting(await requireJson(response));
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
      window.clearTimeout(timer);
      active.current = false;
      pending.current?.controller.abort();
      pending.current?.clear();
      pending.current = null;
    };
  }, [load]);
  const validPercent = percent.trim() !== "" && Number.isFinite(Number(percent)) && Number(percent) > 0 && Number(percent) <= 100;
  const validTokens = tokens.trim() !== "" && Number.isSafeInteger(Number(tokens)) && Number(tokens) > 0;
  const valid = validPercent && validTokens;
  const changed = Number(percent) !== (saved?.maxContextPercent ?? 20) || Number(tokens) !== (saved?.maxTokens ?? 100000);
  const save = async (reset = false) => {
    if (pending.current || saved === undefined || (!reset && !valid)) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setBusy(true); setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify({ reasoningRetention: reset ? null : { maxContextPercent: Number(percent), maxTokens: Number(tokens) } }),
      });
      const value = readSetting(await requireJson(response));
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
  return <section className="panel" aria-labelledby="reasoning-retention-title" aria-busy={busy || (saved === undefined && !loadError)}>
    <div className="font-semibold" id="reasoning-retention-title">{t("reasoningRetention.title")}</div>
    <p className="muted setting-hint">{t("reasoningRetention.description")}</p>
    <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
      <label className="field-label" htmlFor="reasoning-retention-percent">{t("reasoningRetention.percent")}
        <input id="reasoning-retention-percent" className="input" type="number" min="0" max="100" step="any" value={percent} disabled={disabled}
          aria-invalid={!validPercent || undefined} aria-describedby={!validPercent ? "reasoning-retention-error" : undefined}
          onInput={e => { setPercent(e.currentTarget.value); setFeedback(null); }} />
      </label>
      <label className="field-label" htmlFor="reasoning-retention-tokens">{t("reasoningRetention.tokens")}
        <input id="reasoning-retention-tokens" className="input" type="number" min="1" step="1" value={tokens} disabled={disabled}
          aria-invalid={!validTokens || undefined} aria-describedby={!validTokens ? "reasoning-retention-error" : undefined}
          onInput={e => { setTokens(e.currentTarget.value); setFeedback(null); }} />
      </label>
      <button type="button" className="btn btn-primary" disabled={disabled || !valid || !changed} onClick={() => { void save(); }}>{t("common.save")}</button>
      <button type="button" className="btn btn-ghost" disabled={disabled || (saved === null && !changed)} onClick={() => { void save(true); }}>{t("reasoningRetention.reset")}</button>
    </div>
    {!valid && <div id="reasoning-retention-error" className="notice notice-err" role="alert">{t("reasoningRetention.invalid")}</div>}
    {loadError && <div className="notice notice-err" role="alert">{t("reasoningRetention.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
    {feedback === "failed" && <div className="notice notice-err" role="alert">{t("reasoningRetention.saveFailed")}</div>}
    {feedback === "saved" && <div className="muted setting-hint" role="status">{t("reasoningRetention.saved")}</div>}
  </section>;
}
