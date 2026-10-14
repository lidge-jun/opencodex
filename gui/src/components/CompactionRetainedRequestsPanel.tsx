import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";

type Feedback = { tone: "ok" | "err"; message: string } | null;

/**
 * Opt-in `compactionDropRetainedRequests`: removes the user requests Codex keeps in front of a
 * plaintext compaction checkpoint from later turns (#6764). Absent on the server means off.
 */
export default function CompactionRetainedRequestsPanel({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    // A poll landing between the optimistic flip and the PUT response must not revert the switch.
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!res.ok) throw new Error("load");
      const payload = await res.json() as { compactionDropRetainedRequests?: unknown };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      setEnabled(payload.compactionDropRetainedRequests === true);
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
    let outcomeUnknown = false;
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compactionDropRetainedRequests: requested }),
        signal: bounded.signal,
      });
      if (!res.ok) throw new Error("save");
      const payload = await res.json() as { compactionDropRetainedRequests?: unknown };
      const confirmed = typeof payload.compactionDropRetainedRequests === "boolean" ? payload.compactionDropRetainedRequests : requested;
      setEnabled(confirmed);
      setFeedback({ tone: "ok", message: t(confirmed ? "compactionRetained.enabled" : "compactionRetained.disabled") });
    } catch {
      // A timeout or error response does not prove the server kept the old value, so the
      // switch is reconciled with a fresh read below instead of being flipped back blindly.
      outcomeUnknown = true;
      setFeedback({ tone: "err", message: t("compactionRetained.saveFailed") });
    } finally {
      bounded.clear();
      savingRef.current = false;
      if (outcomeUnknown) await load();
      setSaving(false);
    }
  }, [apiBase, enabled, hydrated, load, loadError, t]);

  const controlsDisabled = saving || !hydrated || loadError;

  return (
    <section className="panel" aria-labelledby="compaction-retained-title" aria-busy={saving || (!hydrated && !loadError) || undefined}>
      <div className="spread" style={{ alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: "1 1 20rem", minWidth: 0 }}>
          <div className="font-semibold" id="compaction-retained-title">{t("compactionRetained.title")}</div>
          <div className="muted setting-hint">{t("compactionRetained.description")}</div>
          <div className="muted setting-hint">{t("compactionRetained.scope")}</div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          onClick={() => { void toggle(); }}
          disabled={controlsDisabled}
          aria-pressed={enabled}
          aria-labelledby="compaction-retained-title"
          title={t("compactionRetained.title")}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {loadError && (
        <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {t("compactionRetained.loadFailed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button>
        </div>
      )}
      {feedback?.tone === "err" && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{feedback.message}</div>}
      {feedback?.tone === "ok" && <div className="muted setting-hint" role="status">{feedback.message}</div>}
    </section>
  );
}
