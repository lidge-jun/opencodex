/**
 * Delegation settings for the Subagents tab.
 *
 * This panel used to sit on the Dashboard, which is otherwise a read-only status page — the
 * one place you could change something was also the first thing a new user saw. It reads
 * better next to the roster it affects: the roster picks who may be called, this picks who
 * gets called first.
 */
import { useState } from "react";
import { Select, Switch } from "../../ui";
import { useT } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import type { DelegationPatch, DelegationModelOption } from "../../pages/use-subagent-delegation";
import type { UltraModePatch, UltraModeState, V2NativeParentOverrideState } from "../../pages/use-subagent-delegation";

export interface SubagentDelegationSectionProps {
  model: string;
  effort: string;
  efforts: string[];
  available: DelegationModelOption[];
  guidanceEnabled: boolean;
  syncCodexDefaults: boolean;
  saving: boolean;
  onSave: (patch: DelegationPatch) => void;
  prompt: string;
  childInstructions: string;
  childInstructionsSaving: boolean;
  onChildInstructionsSave: (value: string | null) => void;
  ultraMode: UltraModeState;
  ultraSaving: boolean;
  onUltraModeSave: (patch: UltraModePatch) => void;
  ultraLoadFailed: boolean;
  onUltraModeRetry: () => void;
  keepNativeChatGptOnV1: boolean;
  nativeParentOverride: V2NativeParentOverrideState;
  nativeParentOverrideSaving: boolean;
  onNativeParentOverrideSave: (state: V2NativeParentOverrideState) => void;
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
  prompt,
  childInstructions,
  childInstructionsSaving,
  onChildInstructionsSave,
  ultraMode,
  ultraSaving,
  onUltraModeSave,
  ultraLoadFailed,
  onUltraModeRetry,
  keepNativeChatGptOnV1,
  nativeParentOverride,
  nativeParentOverrideSaving,
  onNativeParentOverrideSave,
}: SubagentDelegationSectionProps) {
  const t = useT();
  // A present empty/whitespace hint is an upstream override that suppresses the
  // Proactive message, so it must render as OFF (and the toggle can install the
  // preset). Only a nonblank hint is "on".
  const ultraOn = (ultraMode.hintText ?? "").trim().length > 0;
  const nativeParentTargets = available.filter(option => option.provider !== "openai");
  const nativeParentCanActivate = ultraMode.multiAgentV2Enabled && !keepNativeChatGptOnV1 && nativeParentOverride.model !== null;

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

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.nativeParentOverride")}</div>
          <div className="muted setting-hint">{t("sub.nativeParentOverrideHint")}</div>
          <div className="muted setting-hint">{t("sub.nativeParentOverridePrivacyWarning")}</div>
        </div>
        <div className="swi-delegation-controls">
          <Select
            value={nativeParentOverride.model ?? ""}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...nativeParentTargets.map(option => ({
                value: option.namespaced,
                label: formatNamespacedModelId(`${option.provider}/${option.model}`, t),
              })),
            ]}
            onChange={value => onNativeParentOverrideSave({
              enabled: nativeParentOverride.enabled,
              model: value || null,
              active: nativeParentOverride.active,
            })}
            disabled={nativeParentOverrideSaving}
            label={t("sub.nativeParentOverrideModel")}
            align="right"
          />
          <Switch
            on={nativeParentOverride.enabled}
            onClick={() => onNativeParentOverrideSave({
              enabled: !nativeParentOverride.enabled,
              model: nativeParentOverride.model,
              active: nativeParentOverride.active,
            })}
            disabled={nativeParentOverrideSaving || (!nativeParentOverride.enabled && !nativeParentCanActivate)}
            label={t("sub.nativeParentOverride")}
          />
        </div>
        {!nativeParentCanActivate && !nativeParentOverride.active && (
          <div className="muted setting-hint">{t("sub.nativeParentOverrideV2Required")}</div>
        )}
      </div>

      <div className="swi-delegation-row swi-prompt-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.injectionPrompt")}</div>
          <div className="muted setting-hint">
            {t("sub.injectionPromptHint")}{" "}
            <code>{"{{model}}"}</code>{" "}
            <code>{"{{effort}}"}</code>{" "}
            <code>{"{{roster}}"}</code>{" "}
            <code>{"{{fallback}}"}</code>{" "}
            <code>{"{{roles}}"}</code>
          </div>
        </div>
        <PromptDraftEditor
          key={`prompt:${prompt}`}
          initialValue={prompt}
          disabled={saving}
          ariaLabel={t("sub.injectionPrompt")}
          saveLabel={t("sub.injectionPromptSave")}
          onSave={value => onSave({ prompt: value.trim() ? value : null })}
        />
      </div>

      <div className="swi-delegation-row swi-prompt-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.childInstructions")}</div>
          <div className="muted setting-hint">{t("sub.childInstructionsHint")}</div>
        </div>
        <PromptDraftEditor
          key={`child:${childInstructions}`}
          initialValue={childInstructions}
          disabled={saving || childInstructionsSaving}
          ariaLabel={t("sub.childInstructions")}
          saveLabel={t("sub.childInstructionsSave")}
          onSave={value => onChildInstructionsSave(value.trim() ? value : null)}
        />
      </div>
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

function PromptDraftEditor({
  initialValue,
  disabled,
  ariaLabel,
  saveLabel,
  onSave,
}: {
  initialValue: string;
  disabled: boolean;
  ariaLabel: string;
  saveLabel: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="swi-prompt-draft">
      <textarea
        className="input swi-ultra-mode-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        rows={4}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => onSave(draft)}
        disabled={disabled}
        aria-label={saveLabel}
      >
        {saveLabel}
      </button>
    </div>
  );
}
