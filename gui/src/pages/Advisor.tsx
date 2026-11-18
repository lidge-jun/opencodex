import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, Select } from "../ui";
import { cn } from "../lib/utils";
import { useDataSurface } from "../data-surface";
import { useT, type TKey } from "../i18n/shared";
import { AdvisorModelSelect } from "../components/AdvisorModelSelect";
import { HelpButton, SettingsRow, SettingsSection } from "../components/v2-proxy/settings-layout";
import AdvisorActivity from "./advisor/AdvisorActivity";
import { AdvisorConsentCallout } from "./advisor/AdvisorConsentCallout";
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
  contextMode?: "context" | "question-only";
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
// One field width for the editor's dropdowns and the timeout box; full width on a phone.
const ADVISOR_FIELD_WIDTH = "w-[16rem] max-w-full max-[640px]:w-full";

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
          contextMode: submitted.contextMode ?? "context",
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
      <SettingsSection id="advisor-settings" title={t("proxyV2.advisorSettings")}>
        <SettingsRow
          label={t("advisor.enabled")}
          hint={t("proxyV2.enabledHint")}
          inline
          control={(
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
          )}
        />
        <SettingsRow
          className="advisor-model-row"
          label={t("advisor.model")}
          labelFor="advisor-model"
          control={(
            <div className={ADVISOR_FIELD_WIDTH}>
              <AdvisorModelSelect
                apiBase={apiBase}
                value={draft.model}
                disabled={saving}
                onChange={model => edit({ model })}
              />
            </div>
          )}
        />
        <SettingsRow
          label={t("advisor.effort")}
          labelFor="advisor-effort"
          hint={t("proxyV2.effortHint")}
          control={(
            <Select
              id="advisor-effort"
              value={draft.effort}
              disabled={saving}
              fullWidth
              className={ADVISOR_FIELD_WIDTH}
              options={EFFORTS.map(effort => ({ value: effort, label: t(`models.reasoningEffort.${effort}` as TKey) }))}
              onChange={effort => edit({ effort })}
            />
          )}
        />
        <SettingsRow
          label={t("advisor.questionOnly")}
          labelFor="advisor-question-only"
          inline
          hint={draft.contextMode === "question-only" ? t("advisor.questionOnlyNote") : undefined}
          control={(
            <label className="toggle">
              <input
                id="advisor-question-only"
                type="checkbox"
                checked={draft.contextMode === "question-only"}
                disabled={saving}
                aria-label={t("advisor.questionOnly")}
                onChange={event => edit({ contextMode: event.target.checked ? "question-only" : "context" })}
              />
              <span className="slider" aria-hidden="true" />
            </label>
          )}
        />
        <SettingsRow
          label={t("advisor.policy")}
          labelFor="advisor-policy"
          hint={t("proxyV2.policyHint")}
          control={(
            <Select
              id="advisor-policy"
              value={draft.policy}
              disabled={saving || draft.contextMode === "question-only"}
              fullWidth
              className={ADVISOR_FIELD_WIDTH}
              options={[
                { value: "manual", label: t("advisor.policy.manual") },
                { value: "preflight", label: t("advisor.policy.preflight") },
                { value: "adaptive", label: t("advisor.policy.adaptive") },
              ]}
              onChange={policy => edit({ policy: policy as AdvisorSettings["policy"] })}
            />
          )}
        />
        {draft.policy === "adaptive" && (
          <SettingsRow
            label={t("advisor.taskLimit")}
            labelFor="advisor-task-limit"
            hint={t("proxyV2.taskLimitHint")}
            details={draft.contextMode === "question-only" ? undefined : t("advisor.adaptiveNote")}
            control={(
              <Select id="advisor-task-limit" value={String(draft.maxConsultationsPerTask ?? 3)} disabled={saving}
                fullWidth
                className={ADVISOR_FIELD_WIDTH}
                options={[1, 2, 3].map(limit => ({ value: String(limit), label: String(limit) }))}
                onChange={limit => edit({ maxConsultationsPerTask: Number(limit) })} />
            )}
          />
        )}
        <SettingsRow
          label={t("advisor.timeout")}
          labelFor="advisor-timeout"
          hint={t("proxyV2.timeoutHint")}
          control={(
            <input
              id="advisor-timeout"
              className={cn("input mono", ADVISOR_FIELD_WIDTH)}
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
          )}
        />
      </SettingsSection>

      <AdvisorConsentCallout
        agreed={draft.contextSharingConsent === "v1"}
        disabled={saving}
        onChange={agreed => edit({ contextSharingConsent: agreed ? "v1" : null })}
      />

      <div className="flex flex-col gap-2">
        {modelMissing && <Notice tone="warn">{t("advisor.warning.noModel")}</Notice>}
        {consentMissing && <Notice tone="warn">{t("advisor.consent.required")}</Notice>}
        {saveError && <Notice tone="err">{saveError}</Notice>}
        {savedFlash && <Notice tone="ok">{t("advisor.saved")}</Notice>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && !saving && <span className="text-[13px] text-fg-muted" role="status">{t("proxyV2.unsaved")}</span>}
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("common.loading") : t("advisor.save")}
          </button>
        </div>
      </div>
    </>
  );
}

export default function Advisor({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [aboutOpen, setAboutOpen] = useState(false);
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
  return (
    <div className="pv2-page flex max-w-[60rem] flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <h2 className="m-0 text-title font-semibold tracking-[-0.025em] text-fg">{t("nav.advisor")}</h2>
          <HelpButton label={t("proxyV2.detailsFor", { name: t("nav.advisor") })} expanded={aboutOpen}
            controls="advisor-about" onClick={() => setAboutOpen(open => !open)} />
        </div>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[1.55] text-fg-muted">{t("proxyV2.advisorLede")}</p>
        <p id="advisor-about" hidden={!aboutOpen} className="m-0 mt-1 max-w-[72ch] rounded-control bg-surface px-4 py-3 text-[13px] leading-[19px] text-fg-muted">
          {t("advisor.description")}
        </p>
      </header>
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
    </div>
  );
}
