/**
 * Delegation settings for the Subagents tab.
 *
 * This panel used to sit on the Dashboard, which is otherwise a read-only status page — the
 * one place you could change something was also the first thing a new user saw. It reads
 * better next to the roster it affects: the roster picks who may be called, this picks who
 * gets called first.
 */
import { useState } from "react";
import { Select, Tooltip } from "../../ui";
import { IconInfo } from "../../icons";
import { useT, type TKey } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import type { DelegationPatch, DelegationModelOption } from "../../pages/use-subagent-delegation";
import type { UltraModePatch, UltraModeState } from "../../pages/use-subagent-delegation";

export interface SubagentDelegationSectionProps {
  model: string;
  effort: string;
  efforts: string[];
  available: DelegationModelOption[];
  guidanceEnabled: boolean;
  syncCodexDefaults: boolean;
  saving: boolean;
  onSave: (patch: DelegationPatch) => void;
  ultraMode: UltraModeState;
  ultraSaving: boolean;
  onUltraModeSave: (patch: UltraModePatch) => void;
  ultraLoadFailed: boolean;
  onUltraModeRetry: () => void;
  fallback: string[];
  fallbackPollMs: number;
  useSubagentModels: boolean;
  fallbackBusy: boolean;
  availableModels: string[];
  onFallbackChange: (models: string[]) => void;
  onFallbackPollMsChange: (pollMs: number) => void;
  onUseSubagentModelsChange: (enabled: boolean) => void;
  onFallbackSave: () => void;
}

export default function SubagentDelegationSection({
  model,
  effort,
  efforts,
  available,
  guidanceEnabled,
  syncCodexDefaults,
  saving,
  onSave,
  ultraMode,
  ultraSaving,
  onUltraModeSave,
  ultraLoadFailed,
  onUltraModeRetry,
  fallback, fallbackPollMs, useSubagentModels, fallbackBusy, availableModels, onFallbackChange, onFallbackPollMsChange, onUseSubagentModelsChange, onFallbackSave,
}: SubagentDelegationSectionProps) {
  const t = useT();
  // A present empty/whitespace hint is an upstream override that suppresses the
  // Proactive message, so it must render as OFF (and the toggle can install the
  // preset). Only a nonblank hint is "on".
  const ultraOn = (ultraMode.hintText ?? "").trim().length > 0;

  return (
    <div className="swi-delegation">
      {ultraLoadFailed && (
        <div className="swi-delegation-row">
          <div className="setting-copy">
            <div className="font-semibold">{t("sub.ultraMode")}</div>
            <div className="muted setting-hint">{t("sub.ultraModeLoadFail")}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onUltraModeRetry}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.delegation.model")}</div>
          <div className="muted setting-hint">{t("sub.delegation.modelHint")}</div>
        </div>
        <div className="swi-delegation-controls">
          <Select
            value={model}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...available.map(m => ({ value: m.namespaced, label: formatNamespacedModelId(`${m.provider}/${m.model}`, t) })),
            ]}
            onChange={v => onSave({ model: v || null, effort: effort || null })}
            disabled={saving}
            label={t("dash.injectionLabel")}
            align="right"
          />
          {model && efforts.length > 0 && (
            <Select
              value={effort}
              options={[
                { value: "", label: t("dash.injectionEffortNone") },
                ...efforts.map(e => ({ value: e, label: e })),
              ]}
              onChange={v => onSave({ model: model || null, effort: v || null })}
              disabled={saving}
              label={t("dash.injectionEffortLabel")}
              align="right"
            />
          )}
        </div>
      </div>

      <div className="swi-delegation-row swi-fallback-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.fallbackLabel")}</div>
          <div className="muted setting-hint">{t("sub.fallbackHint")}</div>
        </div>
        <div className="swi-fallback-controls">
          <div className="swi-fallback-list">
            {fallback.length === 0 && <div className="muted setting-hint swi-fallback-empty">{t("sub.fallbackAdd")}</div>}
            {fallback.map((modelName, index) => (
              <div key={modelName} className="swi-fallback-row">
                <span className="swi-fallback-index">{index + 1}</span>
                <span className="swi-fallback-model">{modelName}</span>
                <div className="swi-fallback-actions">
                  <button type="button" className="btn btn-ghost btn-icon swi-fallback-action" onClick={() => { const next = [...fallback]; if (index > 0) [next[index - 1], next[index]] = [next[index], next[index - 1]]; onFallbackChange(next); }} disabled={fallbackBusy || index === 0} aria-label={t("sub.moveUp", { m: modelName })}>↑</button>
                  <button type="button" className="btn btn-ghost btn-icon swi-fallback-action" onClick={() => { const next = [...fallback]; if (index < next.length - 1) [next[index], next[index + 1]] = [next[index + 1], next[index]]; onFallbackChange(next); }} disabled={fallbackBusy || index === fallback.length - 1} aria-label={t("sub.moveDown", { m: modelName })}>↓</button>
                  <button type="button" className="btn btn-ghost btn-icon swi-fallback-action" onClick={() => onFallbackChange(fallback.filter(item => item !== modelName))} disabled={fallbackBusy} aria-label={t("sub.removeAria", { m: modelName })}>×</button>
                </div>
              </div>
            ))}
          </div>
          <div className="swi-fallback-add">
            <select className="input" value="" onChange={e => { if (e.target.value && !fallback.includes(e.target.value)) onFallbackChange([...fallback, e.target.value]); }} disabled={fallbackBusy}>
              <option value="">{t("sub.fallbackAdd")}</option>
              {availableModels.filter(modelName => !fallback.includes(modelName)).map(modelName => <option key={modelName} value={modelName}>{modelName}</option>)}
            </select>
          </div>
          <div className="swi-fallback-options">
            <label className="swi-fallback-poll setting-hint">{t("sub.fallbackPoll")}
              <span className="swi-fallback-poll-input"><input className="input" type="number" min={5000} max={600000} step={1000} value={fallbackPollMs} onChange={e => onFallbackPollMsChange(Number(e.target.value) || 60000)} disabled={fallbackBusy} /> ms</span>
            </label>
            <label className="swi-fallback-roster setting-hint">
              <button type="button" className={`switch ${useSubagentModels ? "on" : ""}`} onClick={() => onUseSubagentModelsChange(!useSubagentModels)} disabled={fallbackBusy} aria-label={t("sub.fallbackUseRoster")} aria-pressed={useSubagentModels}>
                <span className="knob" />
              </button>
              <span>{t("sub.fallbackUseRoster")}</span>
            </label>
            <button type="button" className="btn btn-primary btn-sm swi-fallback-save" onClick={onFallbackSave} disabled={fallbackBusy}>{t("common.save")}</button>
          </div>
        </div>
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("dash.syncCodexSubagentDefaults")}</div>
          <div className="muted setting-hint">{t("dash.syncCodexSubagentDefaultsHint")}</div>
        </div>
        <button
          type="button"
          className={`switch ${syncCodexDefaults ? "on" : ""}`}
          onClick={() => onSave({ syncCodexSubagentDefaults: !syncCodexDefaults })}
          disabled={saving || !model}
          aria-label={t("dash.syncCodexSubagentDefaults")}
          aria-pressed={syncCodexDefaults}
        >
          <span className="knob" />
        </button>
      </div>

      {/*
        Prompt-injection guidance, ultra mode and its editor are policy tuning, not daily
        decisions: one closed disclosure keeps them reachable under the two settings that are.
      */}
      <details className="swi-advanced">
        <summary className="muted text-label">{t("sub.advanced")}</summary>
      {/*
        The multi-agent surface switch (v1 / base / v2). It lived on Models and on the
        dashboard; both were editors for the same /api/v2 value. It is a delegation
        setting, so it sits above the model that gets delegated to. The long help text
        stays reachable from the focusable info button.
      */}
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {t("models.v2Label")}
            <Tooltip content={t("models.v2Help")} side="top" maxWidth={380}>
              <IconInfo width={13} height={13} aria-hidden="true" />
              <span className="sr-only">{t("models.v2Label")}</span>
            </Tooltip>
          </div>
          <div className="muted setting-hint">
            <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
        </div>
        <div className="swi-delegation-controls">
          <div className="segmented models-segmented" role="radiogroup" aria-label={t("models.v2Label")}>
            {(["v1", "default", "v2"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={ultraMode.multiAgentMode === mode}
                className={`btn btn-sm${ultraMode.multiAgentMode === mode ? " btn-primary" : " btn-ghost"}`}
                style={{ background: ultraMode.multiAgentMode === mode ? undefined : "transparent", color: ultraMode.multiAgentMode === mode ? undefined : "var(--muted)" }}
                disabled={ultraSaving || ultraLoadFailed}
                onClick={() => { if (ultraMode.multiAgentMode !== mode) onUltraModeSave({ multiAgentMode: mode }); }}
              >
                {t(`models.v2Mode_${mode}` as TKey)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("dash.multiAgentGuidance")}</div>
          <div className="muted setting-hint">{t("dash.multiAgentGuidanceHint")}</div>
        </div>
        <button
          type="button"
          className={`switch ${guidanceEnabled ? "on" : ""}`}
          onClick={() => onSave({ multiAgentGuidanceEnabled: !guidanceEnabled })}
          disabled={saving}
          aria-label={t("dash.multiAgentGuidance")}
          aria-pressed={guidanceEnabled}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.ultraMode")}</div>
          <div className="muted setting-hint">{t("sub.ultraModeHint")}</div>
        </div>
        <button
          type="button"
          className={`switch ${ultraOn ? "on" : ""}`}
          onClick={() => onUltraModeSave({ multiAgentModeHintText: ultraOn ? null : ULTRA_MODE_PRESET })}
          // Turning OFF (clear) is always safe, even when v2 is disabled — a stale
          // hint would otherwise silently re-activate on the next v2 enable.
          disabled={saving || ultraSaving || (!ultraOn && !ultraMode.multiAgentV2Enabled)}
          aria-label={t("sub.ultraMode")}
          aria-pressed={ultraOn}
        >
          <span className="knob" />
        </button>
        {!ultraMode.multiAgentV2Enabled && (
          <div className="muted setting-hint">{t("sub.ultraModeV2Required")}</div>
        )}
      </div>
      {ultraOn && (
        <div className="swi-delegation-row swi-ultra-mode-editor">
          <UltraModeEditor
            key={ultraMode.hintText}
            initialHint={ultraMode.hintText ?? ""}
            disabled={saving || ultraSaving}
            onSave={onUltraModeSave}
            preset={ULTRA_MODE_PRESET}
            labels={{
              text: t("sub.ultraModeText"),
              preset: t("sub.ultraModePreset"),
              save: t("common.save"),
            }}
          />
        </div>
      )}
      </details>
    </div>
  );
}

/**
 * Local-draft editor for the Ultra mode hint. Drafts are owned here and committed
 * explicitly; the parent remounts this editor (via `key`) whenever the committed
 * server value changes, so a stale draft never survives a reload or toggle flip.
 */
function UltraModeEditor({
  initialHint,
  disabled,
  onSave,
  preset,
  labels,
}: {
  initialHint: string;
  disabled: boolean;
  onSave: (patch: UltraModePatch) => void;
  preset: string;
  labels: { text: string; preset: string; save: string };
}) {
  const [draft, setDraft] = useState(initialHint);
  const commit = () => {
    if (draft.trim().length === 0) return;
    onSave({ multiAgentModeHintText: draft });
  };
  return (
    <>
      <textarea
        className="input swi-ultra-mode-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        rows={4}
        aria-label={labels.text}
      />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setDraft(preset)}
        disabled={disabled}
      >
        {labels.preset}
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={commit}
        disabled={disabled || draft.trim().length === 0}
      >
        {labels.save}
      </button>
    </>
  );
}

/** Canonical Proactive delegation text mirrored from codex-rs (multi_agent_mode_instructions.rs). */
export const ULTRA_MODE_PRESET =
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently. Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself. This mode remains active until a later multi-agent mode developer message changes it.";
