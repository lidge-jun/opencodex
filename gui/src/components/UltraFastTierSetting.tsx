import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";

type Feedback = { tone: "ok" | "err"; message: string } | null;

/**
 * Opt-in Ultra Fast service tier.
 *
 * The switch adds the documented Ultrafast choice to native GPT-6 Astra and GPT-6.1 Sol in
 * the Codex picker and keeps an operator-configured `ultrafast` tier on routed rows. The
 * description names the plan requirement because the generated catalog replaces ChatGPT's
 * plan-aware model list: the switch is the operator's statement that their plan is eligible.
 */
export default function UltraFastTierSetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    // A poll landing between the optimistic flip and the PUT response must not revert the
    // UI to the server's pre-save value.
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!res.ok) throw new Error("load");
      const payload = await res.json() as { ultraFastTier?: unknown };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      setEnabled(payload.ultraFastTier === true);
      setHydrated(true);
      setLoadError(false);
    } catch {
      if (!savingRef.current && generation === loadGenerationRef.current) setLoadError(true);
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [load]);

  const toggle = useCallback(async () => {
    if (savingRef.current || !hydrated || loadError) return;
    const requested = !enabled;
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    // Optimistic, then reconciled with what the server actually stored.
    setEnabled(requested);
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ultraFastTier: requested }),
        signal: bounded.signal,
      });
      if (!res.ok) throw new Error("save");
      const payload = await res.json() as { ultraFastTier?: unknown };
      const confirmed = typeof payload.ultraFastTier === "boolean" ? payload.ultraFastTier : requested;
      setEnabled(confirmed);
      setFeedback({ tone: "ok", message: t(confirmed ? "codexAuth.ultraFastEnabled" : "codexAuth.ultraFastDisabled") });
    } catch {
      setEnabled(!requested);
      setFeedback({ tone: "err", message: t("codexAuth.ultraFastFailed") });
    } finally {
      bounded.clear();
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, enabled, hydrated, loadError, t]);

  const controlsDisabled = saving || !hydrated || loadError;

  return (
    <div
      className="card card-row codex-ultrafast-card"
      style={{ marginTop: 16 }}
      aria-busy={saving || (!hydrated && !loadError) || undefined}
    >
      <div className="codex-ultrafast-copy">
        <strong>{t("codexAuth.ultraFastTitle")}</strong>
        <div className="card-sub" role={loadError ? "alert" : undefined}>
          {loadError ? t("codexAuth.ultraFastLoadFailed") : t("codexAuth.ultraFastDesc")}
        </div>
      </div>
      <div className="codex-ultrafast-controls">
        {loadError && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>
            {t("common.retry")}
          </button>
        )}
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          onClick={() => { void toggle(); }}
          disabled={controlsDisabled}
          aria-pressed={enabled}
          aria-label={t("codexAuth.ultraFastTitle")}
          title={t("codexAuth.ultraFastTitle")}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {feedback && (
        <div
          className={`codex-ultrafast-feedback${feedback.tone === "err" ? " is-error" : ""}`}
          role={feedback.tone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
