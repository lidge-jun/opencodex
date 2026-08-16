import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";

const FEATURE_ENDPOINT = "/api/codex-auth/features/default-mode-request-user-input";

type Feedback = { tone: "ok" | "err"; message: string } | null;

/**
 * Codex Auth page toggle for Codex's own `default_mode_request_user_input`
 * feature flag. Reads/writes $CODEX_HOME/config.toml through the management
 * API, which flips the flag via the official `codex features` CLI.
 */
export default function DefaultModeRequestUserInputSetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const savingRef = useRef(false);
  const enabledRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    // A poll landing between the optimistic flip and the PUT response must not
    // revert the UI to the server's pre-save value. The generation also drops
    // GETs that were already in flight when a save started.
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}${FEATURE_ENDPOINT}`, { signal: bounded.signal });
      if (!res.ok) throw new Error("load");
      const payload = await res.json() as { enabled?: unknown };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      enabledRef.current = payload.enabled === true;
      setEnabled(enabledRef.current);
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
    const next = !enabledRef.current;
    const previous = enabledRef.current;
    enabledRef.current = next;
    setEnabled(next);
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    loadGenerationRef.current++;
    try {
      const res = await fetch(`${apiBase}${FEATURE_ENDPOINT}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const payload = (await readJsonOrThrow<{ ok?: boolean; enabled?: unknown; changed?: unknown }>(res)) ?? {};
      if (payload.ok !== true) throw new Error(String(res.status));
      enabledRef.current = payload.enabled === true;
      setEnabled(enabledRef.current);
      setHydrated(true);
      setFeedback({
        tone: "ok",
        message: t(payload.changed === true ? "codexAuth.requestUserInputUpdatedRestart" : "codexAuth.requestUserInputUpdated"),
      });
    } catch (error) {
      enabledRef.current = previous;
      setEnabled(previous);
      const reason = error instanceof Error && error.message && !/^HTTP \d{3}$/.test(error.message)
        ? error.message
        : t("codexAuth.requestUserInputUpdateFailed");
      setFeedback({ tone: "err", message: reason });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, hydrated, loadError, t]);

  const controlsDisabled = saving || !hydrated || loadError;

  return (
    <div
      className="card card-row codex-request-user-input-card"
      style={{ marginTop: 16 }}
      aria-busy={saving || (!hydrated && !loadError) || undefined}
    >
      <div className="codex-request-user-input-copy">
        <strong>{t("codexAuth.requestUserInput")}</strong>
        <div className="card-sub" role={loadError ? "alert" : undefined}>
          {loadError ? t("codexAuth.requestUserInputLoadFailed") : t("codexAuth.requestUserInputDesc")}
        </div>
        <code className="mono codex-request-user-input-config">
          {`[features]\ndefault_mode_request_user_input = true`}
        </code>
      </div>
      <div className="codex-request-user-input-controls">
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
          aria-label={t("codexAuth.requestUserInput")}
          title={t("codexAuth.requestUserInput")}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {feedback && (
        <div
          className={`codex-request-user-input-feedback${feedback.tone === "err" ? " is-error" : ""}`}
          role={feedback.tone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
