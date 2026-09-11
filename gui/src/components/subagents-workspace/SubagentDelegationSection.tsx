/**
 * Delegation settings for the Subagents tab.
 *
 * This panel used to sit on the Dashboard, which is otherwise a read-only status page — the
 * one place you could change something was also the first thing a new user saw. It reads
 * better next to the roster it affects: the roster picks who may be called, this picks who
 * gets called first.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Select, Tooltip } from "../../ui";
import { IconArrowDown, IconArrowUp, IconInfo, IconX } from "../../icons";
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
  fallbackBusy: boolean;
  availableModels: string[];
  onFallbackChange: (models: string[]) => void;
  onFallbackPollMsChange: (pollMs: number) => void;
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
  fallback, fallbackPollMs, fallbackBusy, availableModels, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
}: SubagentDelegationSectionProps) {
  const t = useT();
  // A present empty/whitespace hint is an upstream override that suppresses the
  // Proactive message, so it must render as OFF (and the toggle can install the
  // preset). Only a nonblank hint is "on".
  const ultraOn = (ultraMode.hintText ?? "").trim().length > 0;
  const routedPreferred = available.some(option => option.namespaced === model
    && !(option.provider === "openai" && option.namespaced === option.model));
  const nativeMayUseV2 = ultraMode.enabled || (ultraMode.multiAgentMode !== "v1"
    && !(ultraMode.multiAgentMode === "v2" && ultraMode.keepNativeChatGptOnV1));
  const showV2Compatibility = !ultraLoadFailed && ultraMode.loaded === true && routedPreferred && nativeMayUseV2;
  const availableModelSet = new Set(availableModels);
  const fallbackSet = new Set(fallback);
  const [pollDraft, setPollDraft] = useState(() => ({ pollMs: fallbackPollMs, text: String(fallbackPollMs) }));
  // Keep blank/invalid input text while reconciling accepted settings from a load or save.
  if (!Object.is(pollDraft.pollMs, fallbackPollMs)) {
    setPollDraft({ pollMs: fallbackPollMs, text: Number.isFinite(fallbackPollMs) ? String(fallbackPollMs) : "" });
  }
  const fallbackControlsRef = useRef<HTMLDivElement>(null);
  const [identity, setIdentity] = useState(() => ({
    models: fallback,
    rows: fallback.map((rowModel, id) => ({ model: rowModel, id })),
    nextId: fallback.length,
  }));
  let rows = identity.rows;
  // Keys are render state. Guarded prop reconciliation retains each occurrence;
  // event handlers move the same identities with their corresponding models.
  if (identity.models !== fallback) {
    const remaining = [...identity.rows];
    let nextId = identity.nextId;
    rows = fallback.map(modelName => {
      const old = remaining.findIndex(row => row.model === modelName);
      return old >= 0 ? remaining.splice(old, 1)[0] : { model: modelName, id: nextId++ };
    });
    setIdentity({ models: fallback, rows, nextId });
  }
  const pendingFocus = useRef<{ row: number; action: string } | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const row = fallbackControlsRef.current?.querySelectorAll(".swi-fallback-row")[target.row];
    const enabledActions = row?.querySelectorAll<HTMLButtonElement>("button[data-action]:not(:disabled)");
    const action = Array.from(enabledActions ?? []).find(button => button.dataset.action === target.action)
      ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?? fallbackControlsRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]');
    action?.focus();
  }, [fallback]);
  const validPollMs = Number.isInteger(fallbackPollMs) && fallbackPollMs >= 5000 && fallbackPollMs <= 600000;
  const moveFallback = (index: number, direction: -1 | 1) => {
    const next = [...fallback];
    const target = index + direction;
    if (fallbackBusy || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    const nextRows = [...rows];
    [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
    setIdentity({ ...identity, models: next, rows: nextRows });
    pendingFocus.current = { row: target, action: direction === -1 ? "up" : "down" };
    onFallbackChange(next);
  };

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

      {showV2Compatibility && (
        <div className="swi-delegation-row swi-v2-compatibility" role="note">
          <div className="setting-copy">
            <div className="font-semibold">{t("sub.v2Compatibility.title")}</div>
            <p className="muted setting-hint">{t("sub.v2Compatibility.risk")}</p>
            <p className="muted setting-hint">{t("sub.v2Compatibility.recoveryUnknown")}</p>
            <a href="https://github.com/lidge-jun/opencodex/issues/92" target="_blank" rel="noreferrer">{t("sub.v2Compatibility.details")}</a>
          </div>
        </div>
      )}

      <div className="swi-delegation-row swi-fallback-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.fallbackLabel")}</div>
          <div className="muted setting-hint">{t("sub.fallbackHint")}</div>
        </div>
        <div className="swi-fallback-controls" ref={fallbackControlsRef}>
          {fallback.map((modelName, index) => (
            <div key={rows[index].id} className="swi-fallback-row">
              <span className="swi-fallback-model">{index + 1}. {modelName}
                {!availableModelSet.has(modelName) && <span className="muted setting-hint">{t("sub.fallbackUnavailable")}</span>}
              </span>
              <span className="swi-fallback-actions">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="up" onClick={() => moveFallback(index, -1)} disabled={fallbackBusy || index === 0} aria-label={t("sub.moveUp", { m: modelName })}><IconArrowUp /></button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="down" onClick={() => moveFallback(index, 1)} disabled={fallbackBusy || index === fallback.length - 1} aria-label={t("sub.moveDown", { m: modelName })}><IconArrowDown /></button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="remove" onClick={() => {
                  const next = fallback.filter((_, i) => i !== index);
                  setIdentity({ ...identity, models: next, rows: rows.filter((_, i) => i !== index) });
                  pendingFocus.current = { row: Math.max(0, Math.min(index, fallback.length - 2)), action: "remove" };
                  onFallbackChange(next);
                }} disabled={fallbackBusy} aria-label={t("sub.removeAria", { m: modelName })}><IconX /></button>
              </span>
            </div>
          ))}
          <Select value="" label={t("sub.fallbackAdd")} options={[
            { value: "", label: t("sub.fallbackAdd") },
            ...availableModels.filter(modelName => !fallbackSet.has(modelName)).map(modelName => ({ value: modelName, label: modelName })),
          ]} onChange={value => { if (value && !fallbackSet.has(value)) onFallbackChange([...fallback, value]); }} disabled={fallbackBusy} />
          <label className="setting-hint">{t("sub.fallbackPoll")}
            <input className="input" type="number" min={5000} max={600000} step={1000} value={pollDraft.text} onChange={e => {
              const text = e.currentTarget.value;
              const parsed = Number(text);
              const pollMs = text.trim() !== "" && Number.isFinite(parsed) ? parsed : Number.NaN;
              setPollDraft({ pollMs, text });
              onFallbackPollMsChange(pollMs);
            }} disabled={fallbackBusy} aria-invalid={!validPollMs} /> ms
          </label>
          {!validPollMs && <div className="setting-hint" role="alert">{t("sub.fallbackPollInvalid")}</div>}
          <button type="button" className="btn btn-primary btn-sm" onClick={onFallbackSave} disabled={fallbackBusy || !validPollMs}>{t("common.save")}</button>
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
          onClick={() => {
            if (ultraOn) onUltraModeSave({ multiAgentModeHintText: null });
            else if (ultraMode.recommendation) {
              onUltraModeSave({ multiAgentModeHintText: ultraMode.recommendation.text });
            }
          }}
          // Turning OFF (clear) is always safe, even when v2 is disabled — a stale
          // hint would otherwise silently re-activate on the next v2 enable.
          disabled={saving || ultraSaving || (!ultraOn && (!ultraMode.multiAgentV2Enabled || !ultraMode.recommendation))}
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
            preset={ultraMode.recommendation?.text ?? null}
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
  preset: string | null;
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
        onClick={() => { if (preset !== null) setDraft(preset); }}
        disabled={disabled || preset === null}
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
