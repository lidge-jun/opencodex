import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";
import { useT } from "../i18n/shared";
import type { NoticeTone } from "../ui";

type Feedback = { tone: NoticeTone; message: string } | null;

/** Dashboard toggle for showing or hiding synthetic Fast selector rows. */
export default function FastRowsSetting({
  apiBase,
  onSaved,
}: {
  apiBase: string;
  onSaved?: () => void;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const enabledRef = useRef(true);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!response.ok) throw new Error("load");
      const payload = await response.json() as { fastRows?: unknown };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      if (typeof payload.fastRows !== "boolean") throw new Error("shape");
      enabledRef.current = payload.fastRows;
      setEnabled(payload.fastRows);
      setHydrated(true);
      setLoadError(false);
    } catch {
      if (!savingRef.current && generation === loadGenerationRef.current) {
        setLoadError(true);
      }
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
    if (savingRef.current || !hydrated) return;
    const previous = enabledRef.current;
    const requested = !previous;
    enabledRef.current = requested;
    setEnabled(requested);
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    loadGenerationRef.current += 1;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fastRows: requested }),
        signal: bounded.signal,
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        fastRows?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      if (payload.ok !== true || typeof payload.fastRows !== "boolean") {
        throw new Error("unconfirmed");
      }
      enabledRef.current = payload.fastRows;
      setEnabled(payload.fastRows);
      setHydrated(true);
      setLoadError(false);
      setFeedback(payload.catalogRefreshPending === true
        ? { tone: "warn", message: t("models.fastRows.refreshHint") }
        : { tone: "ok", message: t(payload.fastRows ? "models.fastRows.enabled" : "models.fastRows.disabled") });
      onSaved?.();
    } catch {
      enabledRef.current = previous;
      setEnabled(previous);
      setFeedback({ tone: "err", message: t("models.fastRows.updateFailed") });
    } finally {
      bounded.clear();
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, hydrated, onSaved, t]);

  const initialLoadFailed = loadError && !hydrated;

  return (
    <div
      className="card card-row fast-rows-card"
      aria-busy={saving || (!hydrated && !initialLoadFailed) || undefined}
    >
      <div className="fast-rows-copy">
        <strong>{t("models.fastRows.title")}</strong>
        <div className="card-sub" role={initialLoadFailed ? "status" : undefined}>
          {initialLoadFailed
            ? t("models.fastRows.loadFailed")
            : !hydrated
              ? t("common.loading")
              : t("models.fastRows.desc")}
        </div>
        {hydrated && loadError && (
          <div className="card-sub faint" role="status">
            {t("models.fastRows.loadFailed")}
          </div>
        )}
      </div>
      <div className="fast-rows-controls">
        {loadError && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { void load(); }}
            disabled={saving}
          >
            {t("common.retry")}
          </button>
        )}
        {hydrated && (
          <button
            type="button"
            className={`toggle ${enabled ? "on" : ""}`}
            onClick={() => { void toggle(); }}
            disabled={saving}
            aria-pressed={enabled}
            aria-label={t("models.fastRows.title")}
            title={t("models.fastRows.title")}
          >
            <span className="toggle-knob" />
          </button>
        )}
      </div>
      {feedback && (
        <div
          className={`fast-rows-feedback is-${feedback.tone}`}
          role={feedback.tone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
