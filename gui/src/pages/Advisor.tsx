import { useCallback, useState } from "react";
import { Notice } from "../ui";
import { useDataSurface } from "../data-surface";
import { useT } from "../i18n/shared";

/**
 * Advisor sidecar configuration (PR1: minimal but real). Reads and writes the RESOLVED
 * runtime state through GET/PUT /api/advisor/settings — the same view the CLI sees.
 * Loading follows the shared data-surface contract; the editor remounts when the first
 * load settles so its draft always starts from real runtime state.
 */

interface AdvisorSettings {
  enabled: boolean;
  model: string;
  effort: string;
  policy: "manual" | "preflight";
  timeoutMs: number;
}

interface AdvisorDto {
  settings: AdvisorSettings;
  runnable: boolean;
  warning?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function AdvisorEditor({ apiBase, dto }: { apiBase: string; dto: AdvisorDto }) {
  const t = useT();
  const [draft, setDraft] = useState<AdvisorSettings>(dto.settings);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState("");

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch(`${apiBase}/api/advisor/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setSaveError(body?.error?.message ?? String(response.status));
        return;
      }
      const body = (await response.json()) as AdvisorDto;
      setDraft(body.settings);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [apiBase, draft]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(dto.settings);
  const modelMissing = draft.enabled && draft.model.trim() === "";
  const rowStyle = { display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.6rem 0" } as const;
  const labelStyle = { minWidth: "11rem" } as const;

  return (
    <>
      <div style={{ marginTop: "0.75rem" }}>
        <div style={rowStyle}>
          <span style={labelStyle}>{t("advisor.enabled")}</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              aria-label={t("advisor.enabled")}
              onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span className="slider" aria-hidden="true" />
          </label>
          {dto.warning === "advisor_enabled_without_model" && <span className="muted">{t("advisor.warning.noModel")}</span>}
        </div>
        <div style={rowStyle}>
          <label htmlFor="advisor-model" style={labelStyle}>{t("advisor.model")}</label>
          <input
            id="advisor-model"
            type="text"
            value={draft.model}
            placeholder={t("advisor.modelPlaceholder")}
            onChange={event => setDraft({ ...draft, model: event.target.value })}
          />
        </div>
        <div style={rowStyle}>
          <label htmlFor="advisor-effort" style={labelStyle}>{t("advisor.effort")}</label>
          <select
            id="advisor-effort"
            value={draft.effort}
            onChange={event => setDraft({ ...draft, effort: event.target.value })}
          >
            {EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <label htmlFor="advisor-policy" style={labelStyle}>{t("advisor.policy")}</label>
          <select
            id="advisor-policy"
            value={draft.policy}
            onChange={event => setDraft({ ...draft, policy: event.target.value === "preflight" ? "preflight" : "manual" })}
          >
            <option value="manual">{t("advisor.policy.manual")}</option>
            <option value="preflight">{t("advisor.policy.preflight")}</option>
          </select>
        </div>
        <div style={rowStyle}>
          <label htmlFor="advisor-timeout" style={labelStyle}>{t("advisor.timeout")}</label>
          <input
            id="advisor-timeout"
            type="number"
            min={1000}
            max={600000}
            value={draft.timeoutMs}
            onChange={event => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
          />
        </div>
      </div>
      {modelMissing && <Notice tone="warn">{t("advisor.warning.noModel")}</Notice>}
      {saveError && <Notice tone="err">{saveError}</Notice>}
      {savedFlash && <Notice tone="ok">{t("advisor.saved")}</Notice>}
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={() => void save()}>
          {t("advisor.save")}
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
      <Notice tone="warn">{t("advisor.costNote")}</Notice>
      {state.showSkeleton && <Notice tone="warn">{t("common.loading")}</Notice>}
      {state.showError && !state.showSkeleton && (
        <Notice tone="err">
          {t("advisor.loadFailed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      {state.data !== undefined && (
        <AdvisorEditor key={resource.hasSucceeded ? "ready" : "cold"} apiBase={apiBase} dto={state.data} />
      )}
    </section>
  );
}
