import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "../ui";
import { useDataSurface } from "../data-surface";
import { useT, type TKey } from "../i18n/shared";
import { AdvisorModelSelect } from "../components/AdvisorModelSelect";
import AdvisorActivity from "./advisor/AdvisorActivity";
import "./advisor/advisor.css";

/**
 * Advisor sidecar configuration (PR1: minimal but real). Reads and writes the RESOLVED
 * runtime state through GET/PUT /api/advisor/settings — the same view the CLI sees.
 * Loading follows the shared data-surface contract; the editor remounts when the first
 * load settles so its draft always starts from real runtime state.
 */

export interface AdvisorSettings {
  enabled: boolean;
  model: string;
  effort: string;
  policy: "manual" | "preflight" | "adaptive";
  maxConsultationsPerTask?: number;
  timeoutMs: number;
  contextSharingConsent: "v1" | null;
}

export interface AdvisorDto {
  settings: AdvisorSettings;
  runnable: boolean;
  warning?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function AdvisorEditor({ apiBase, initial }: { apiBase: string; initial: AdvisorSettings }) {
  const t = useT();
  // Mount-time snapshot. The parent remounts this editor when the first load settles
  // (`key` flips cold → ready), so later parent dto changes do not need to be copied here.
  // After mount, `saved` only advances from a successful PUT.
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState("");
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedFlashTimerRef.current !== null) {
        clearTimeout(savedFlashTimerRef.current);
        savedFlashTimerRef.current = null;
      }
    };
  }, []);

  const save = useCallback(async () => {
    if (savedFlashTimerRef.current !== null) {
      clearTimeout(savedFlashTimerRef.current);
      savedFlashTimerRef.current = null;
    }
    setSavedFlash(false);
    setSaving(true);
    setSaveError("");
    const submitted = draft;
    try {
      const response = await fetch(`${apiBase}/api/advisor/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Strict patch: send ONLY the accepted fields. draft may still carry GET-only
        // properties (sources) that the PUT parser must reject.
        body: JSON.stringify({
          enabled: submitted.enabled,
          model: submitted.model,
          effort: submitted.effort,
          policy: submitted.policy,
          ...(submitted.maxConsultationsPerTask !== undefined ? { maxConsultationsPerTask: submitted.maxConsultationsPerTask } : {}),
          timeoutMs: submitted.timeoutMs,
          contextSharingConsent: submitted.contextSharingConsent,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setSaveError(body?.error?.message ?? String(response.status));
        return;
      }
      const body = (await response.json()) as AdvisorDto;
      setSaved(body.settings);
      // Edits made while the PUT was in flight stay in the draft: only overwrite the draft
      // when the user has not touched it since this save started.
      setDraft(current => (JSON.stringify(current) === JSON.stringify(submitted) ? body.settings : current));
      setSavedFlash(true);
      savedFlashTimerRef.current = setTimeout(() => {
        savedFlashTimerRef.current = null;
        setSavedFlash(false);
      }, 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [apiBase, draft]);

  // Every field edit invalidates the previous failure notice: it describes the state that was
  // submitted, and it must not outlive the field the operator is now correcting. A revert to the
  // saved value would otherwise leave the notice with no way to clear at all.
  const edit = useCallback((patch: Partial<AdvisorSettings>) => {
    setSaveError("");
    setDraft(current => ({ ...current, ...patch }));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const modelMissing = draft.enabled && draft.model.trim() === "";
  const consentMissing = draft.enabled && draft.model.trim() !== "" && draft.contextSharingConsent !== "v1";

  return (
    <>
      <div style={{ marginTop: "0.75rem" }}>
        <div className="advisor-editor-row">
          <span className="advisor-editor-label">{t("advisor.enabled")}</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={saving}
              aria-label={t("advisor.enabled")}
              onChange={event => edit({ enabled: event.target.checked })}
            />
            <span className="slider" aria-hidden="true" />
          </label>
        </div>
        <div className="advisor-editor-row">
          <label htmlFor="advisor-model" className="advisor-editor-label">{t("advisor.model")}</label>
          <AdvisorModelSelect
            apiBase={apiBase}
            value={draft.model}
            disabled={saving}
            onChange={model => edit({ model })}
          />
        </div>
        <div className="advisor-editor-row">
          <label htmlFor="advisor-effort" className="advisor-editor-label">{t("advisor.effort")}</label>
          <select
            id="advisor-effort"
            value={draft.effort}
            disabled={saving}
            onChange={event => edit({ effort: event.target.value })}
          >
            {EFFORTS.map(effort => (
              <option key={effort} value={effort}>{t(`models.reasoningEffort.${effort}` as TKey)}</option>
            ))}
          </select>
        </div>
        <div className="advisor-editor-row">
          <label htmlFor="advisor-policy" className="advisor-editor-label">{t("advisor.policy")}</label>
          <select
            id="advisor-policy"
            value={draft.policy}
            disabled={saving}
            onChange={event => edit({ policy: event.target.value as AdvisorSettings["policy"] })}
          >
            <option value="manual">{t("advisor.policy.manual")}</option>
            <option value="preflight">{t("advisor.policy.preflight")}</option>
            <option value="adaptive">{t("advisor.policy.adaptive")}</option>
          </select>
        </div>
        {draft.policy === "adaptive" && <div className="advisor-editor-row">
          <label htmlFor="advisor-task-limit" className="advisor-editor-label">{t("advisor.taskLimit")}</label>
          <select id="advisor-task-limit" value={draft.maxConsultationsPerTask ?? 3} disabled={saving}
            onChange={event => edit({ maxConsultationsPerTask: Number(event.target.value) })}>
            {[1, 2, 3].map(limit => <option key={limit} value={limit}>{limit}</option>)}
          </select>
        </div>}
        {draft.policy === "adaptive" && <p className="muted">{t("advisor.adaptiveNote")}</p>}
        <div style={{ margin: "0.8rem 0" }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
            <input
              type="checkbox"
              checked={draft.contextSharingConsent === "v1"}
              disabled={saving}
              aria-label={t("advisor.consent.label")}
              onChange={event => edit({ contextSharingConsent: event.target.checked ? "v1" : null })}
            />
            <span>{t("advisor.consent.label")}</span>
          </label>
        </div>
        <div className="advisor-editor-row">
          <label htmlFor="advisor-timeout" className="advisor-editor-label">{t("advisor.timeout")}</label>
          <input
            id="advisor-timeout"
            type="number"
            min={1000}
            max={600000}
            value={draft.timeoutMs}
            disabled={saving}
            onChange={event => {
              const raw = event.target.value.trim();
              if (raw === "") return;
              const parsed = Number(raw);
              if (!Number.isFinite(parsed)) return;
              edit({ timeoutMs: parsed });
            }}
          />
        </div>
      </div>
      {modelMissing && <Notice tone="warn">{t("advisor.warning.noModel")}</Notice>}
      {consentMissing && <Notice tone="warn">{t("advisor.consent.required")}</Notice>}
      {saveError && <Notice tone="err">{saveError}</Notice>}
      {savedFlash && <Notice tone="ok">{t("advisor.saved")}</Notice>}
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t("common.loading") : t("advisor.save")}
        </button>
      </div>
    </>
  );
}

export default function Advisor({ apiBase }: { apiBase: string }) {
  const t = useT();
  const resource = useDataSurface<AdvisorDto>(
    `advisor-settings:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/advisor/settings`, { signal });
      if (!response.ok) throw new Error(String(response.status));
      return await response.json() as AdvisorDto;
    },
    { isEmpty: () => false },
  );
  const { state } = resource;
  const heading = <h2>{t("nav.advisor")}</h2>;
  return (
    <section className="panel">
      {heading}
      <p className="muted">{t("advisor.description")}</p>
      {/* Collapsed by default: three stacked warnings buried the settings below them. The
          consent checkbox and its required notice stay visible, so folding them hides no gate. */}
      <details className="advisor-notices" style={{ margin: "0.5rem 0" }}>
        <summary className="muted text-label" style={{ cursor: "pointer", padding: "2px 2px" }}>{t("advisor.notices")}</summary>
        <Notice tone="warn">{t("advisor.costNote")}</Notice>
        <Notice tone="warn">{t("advisor.privacyNote")}</Notice>
        <Notice tone="warn">{t("advisor.disclosure")}</Notice>
      </details>
      {state.showSkeleton && <Notice tone="warn">{t("common.loading")}</Notice>}
      {state.showError && !state.showSkeleton && (
        <Notice tone="err">
          {t("advisor.loadFailed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      {state.data !== undefined && (
        <AdvisorEditor
          key={resource.hasSucceeded ? "ready" : "cold"}
          apiBase={apiBase}
          initial={state.data.settings}
        />
      )}
      <AdvisorActivity apiBase={apiBase} />
    </section>
  );
}
