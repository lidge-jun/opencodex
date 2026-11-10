/**
 * Delegation settings for the Subagents tab.
 *
 * This panel used to sit on the Dashboard, which is otherwise a read-only status page — the
 * one place you could change something was also the first thing a new user saw. It reads
 * better next to the roster it affects: the roster picks who may be called, this picks who
 * gets called first.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Select } from "../../ui";
import { IconArrowDown, IconArrowUp, IconChevron, IconX } from "../../icons";
import { useT, type TKey } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import { clampNumberDraft } from "../../clamp-draft";
import { cn } from "@/lib/utils";
import { Button } from "../ui-v2/button";
import { Frame, FrameBody, HelpTip, SettingRow } from "../v2-subagents/frame";
import { iconButton, stepIndicator } from "../v2-subagents/frame-classes";
import { StepperInput } from "../v2-subagents/StepperInput";
import type { DelegationPatch, DelegationModelOption } from "../../pages/use-subagent-delegation";
import type { UltraModePatch, UltraModeState } from "../../pages/use-subagent-delegation";
import DelegationSuggest from "./DelegationSuggest";

export interface SubagentDelegationSectionProps {
  apiBase: string;
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
  id?: string;
}

export default function SubagentDelegationSection({
  apiBase,
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
  id,
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
  const [suggestOpen, setSuggestOpen] = useState(false);
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

  const editPoll = (text: string) => {
    const parsed = Number(text);
    const pollMs = text.trim() !== "" && Number.isFinite(parsed) ? parsed : Number.NaN;
    setPollDraft({ pollMs, text });
    onFallbackPollMsChange(pollMs);
  };
  const pollLabel = t("sub.fallbackPoll");

  // A settings form after React Bits settings-form-3: one row per decision, the plain label
  // and a one-line hint on the left, the control on the right; the long hints moved behind "?".
  return (
    <Frame id={id} className="swi-delegation" title={t("subagentsV2.delegationTitle")}>
      <FrameBody>
        {ultraLoadFailed && (
          <SettingRow
            className="swi-delegation-row"
            label={t("sub.ultraMode")}
            hint={<span className="text-danger">{t("sub.ultraModeLoadFail")}</span>}
            control={<Button size="sm" variant="outline" onClick={onUltraModeRetry}>{t("common.retry")}</Button>}
          />
        )}
        <SettingRow
          className="swi-delegation-row swi-delegation-model-row"
          label={t("sub.delegation.model")}
          hint={t("subagentsV2.delegationShort")}
          help={<HelpTip label={t("sub.delegation.model")}>{t("sub.delegation.modelHint")}</HelpTip>}
          control={<>
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
            <Button
              size="sm"
              variant={suggestOpen ? "outline" : "ghost"}
              aria-expanded={suggestOpen}
              onClick={() => setSuggestOpen(open => !open)}
            >
              {t("sub.suggest.button")}
            </Button>
          </>}
        >
          {suggestOpen && (
            <DelegationSuggest
              apiBase={apiBase}
              model={model}
              effort={effort}
              available={available}
              saving={saving}
              onAccept={onSave}
            />
          )}
        </SettingRow>

        {showV2Compatibility && (
          <div className="swi-delegation-row swi-v2-compatibility px-4 py-3" role="note">
            <div className="flex flex-col gap-1 rounded-[8px] bg-warning-soft px-3 py-2.5 text-[13px] leading-5">
              <div className="font-semibold text-warning">{t("sub.v2Compatibility.title")}</div>
              <p className="m-0 text-fg-muted">{t("sub.v2Compatibility.risk")}</p>
              <p className="m-0 text-fg-muted">{t("sub.v2Compatibility.recoveryUnknown")}</p>
              <a className="w-fit text-highlight hover:underline" href="https://github.com/lidge-jun/opencodex/issues/92" target="_blank" rel="noreferrer">{t("sub.v2Compatibility.details")}</a>
            </div>
          </div>
        )}

        <SettingRow
          className="swi-delegation-row swi-fallback-editor"
          label={t("sub.fallbackLabel")}
          hint={t("sub.fallbackHint")}
        >
          <div className="swi-fallback-controls flex min-w-0 flex-col gap-2" ref={fallbackControlsRef}>
            {fallback.length > 0 && (
              <ol className="m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-[8px] p-0 ring-1 ring-line">
                {fallback.map((modelName, index) => (
                  <li key={rows[index].id} className="swi-fallback-row flex min-h-10 min-w-0 items-center gap-3 py-1 pr-1.5 pl-2.5">
                    <span className={cn(stepIndicator, "swi-fallback-pos bg-surface text-fg ring-line-strong")}>{index + 1}</span>
                    <span className="swi-fallback-model flex min-w-0 flex-1 flex-col">
                      <span className="swi-fallback-name truncate font-mono text-[13px] text-fg">{modelName}</span>
                      {!availableModelSet.has(modelName) && <span className="text-[12px] text-warning">{t("sub.fallbackUnavailable")}</span>}
                    </span>
                    <span className="swi-fallback-actions flex shrink-0 items-center gap-0.5">
                      <button type="button" className={iconButton} data-action="up" onClick={() => moveFallback(index, -1)} disabled={fallbackBusy || index === 0} aria-label={t("sub.moveUp", { m: modelName })}><IconArrowUp /></button>
                      <button type="button" className={iconButton} data-action="down" onClick={() => moveFallback(index, 1)} disabled={fallbackBusy || index === fallback.length - 1} aria-label={t("sub.moveDown", { m: modelName })}><IconArrowDown /></button>
                      <button type="button" className={cn(iconButton, "hover:bg-danger-soft hover:text-danger")} data-action="remove" onClick={() => {
                        const next = fallback.filter((_, i) => i !== index);
                        setIdentity({ ...identity, models: next, rows: rows.filter((_, i) => i !== index) });
                        pendingFocus.current = { row: Math.max(0, Math.min(index, fallback.length - 2)), action: "remove" };
                        onFallbackChange(next);
                      }} disabled={fallbackBusy} aria-label={t("sub.removeAria", { m: modelName })}><IconX /></button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Select value="" label={t("sub.fallbackAdd")} options={[
                { value: "", label: t("sub.fallbackAdd") },
                ...availableModels.filter(modelName => !fallbackSet.has(modelName)).map(modelName => ({ value: modelName, label: modelName })),
              ]} onChange={value => { if (value && !fallbackSet.has(value)) onFallbackChange([...fallback, value]); }} disabled={fallbackBusy} />
              <div className="ml-auto flex items-center gap-2 text-[13px] text-fg-muted">
                {/* A wrapping <label> would name the first labelable descendant, the decrement
                    button; tie the label to the input itself instead. */}
                <label htmlFor="subagent-fallback-poll-ms">{pollLabel}</label>
                <StepperInput
                  id="subagent-fallback-poll-ms"
                  min={5000} max={600000} step={1000} value={pollDraft.text}
                  onChange={e => editPoll(e.currentTarget.value)}
                  disabled={fallbackBusy} aria-invalid={!validPollMs}
                  stepDisabled={fallbackBusy}
                  unit="ms"
                  inputClassName="w-24"
                  decrementLabel={t("workflowBudget.decrease", { label: pollLabel })}
                  incrementLabel={t("workflowBudget.increase", { label: pollLabel })}
                  onDecrement={() => editPoll(clampNumberDraft(pollDraft.text, -1000, 5000, 600000))}
                  onIncrement={() => editPoll(clampNumberDraft(pollDraft.text, 1000, 5000, 600000))}
                />
              </div>
              <Button size="sm" variant="primary" onClick={onFallbackSave} disabled={fallbackBusy || !validPollMs}>{t("common.save")}</Button>
            </div>
            {!validPollMs && <div className="text-[12px] text-danger" role="alert">{t("sub.fallbackPollInvalid")}</div>}
          </div>
        </SettingRow>

        <SettingRow
          className="swi-delegation-row"
          label={t("dash.syncCodexSubagentDefaults")}
          hint={t("subagentsV2.syncShort")}
          help={<HelpTip label={t("dash.syncCodexSubagentDefaults")}>{t("dash.syncCodexSubagentDefaultsHint")}</HelpTip>}
          control={
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
          }
        />

        {/*
          Prompt-injection guidance, ultra mode and its editor are policy tuning, not daily
          decisions: one closed disclosure keeps them reachable under the two settings that are.
        */}
        <details className="swi-advanced">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-surface/60 [&::-webkit-details-marker]:hidden">
            <IconChevron className="size-4 shrink-0 text-fg-subtle transition-transform duration-200 [details[open]>summary>&]:rotate-90" aria-hidden="true" />
            <span className="text-[14px] font-medium text-fg">{t("sub.advanced")}</span>
            <span className="min-w-0 truncate text-[13px] text-fg-subtle">{t("subagentsV2.advancedHint")}</span>
          </summary>
          <div className="flex flex-col divide-y divide-line border-t border-line">
          {/*
            The multi-agent surface switch (v1 / base / v2). It lived on Models and on the
            dashboard; both were editors for the same /api/v2 value. It is a delegation
            setting, so it sits above the model that gets delegated to. The long help text
            stays reachable from the focusable "?".
          */}
          <SettingRow
            className="swi-delegation-row"
            label={t("models.v2Label")}
            hint={<>
              {t("subagentsV2.surfaceShort")}{" "}
              <a className="text-highlight hover:underline" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer">
                {t("models.v2DocsLink")}
              </a>
            </>}
            help={<HelpTip label={t("models.v2Label")}><span className="whitespace-pre-line">{t("models.v2Help")}</span></HelpTip>}
            control={
              <div className="segmented models-segmented" role="radiogroup" aria-label={t("models.v2Label")}>
                {(["v1", "default", "v2"] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={ultraMode.multiAgentMode === mode}
                    className={`btn btn-sm${ultraMode.multiAgentMode === mode ? " btn-primary" : " btn-ghost"}`}
                    disabled={ultraSaving || ultraLoadFailed}
                    onClick={() => { if (ultraMode.multiAgentMode !== mode) onUltraModeSave({ multiAgentMode: mode }); }}
                  >
                    {t(`models.v2Mode_${mode}` as TKey)}
                  </button>
                ))}
              </div>
            }
          />
          <SettingRow
            className="swi-delegation-row"
            label={t("dash.multiAgentGuidance")}
            hint={t("subagentsV2.guidanceShort")}
            help={<HelpTip label={t("dash.multiAgentGuidance")}>{t("dash.multiAgentGuidanceHint")}</HelpTip>}
            control={
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
            }
          />

          <SettingRow
            className="swi-delegation-row"
            label={t("sub.ultraMode")}
            hint={!ultraMode.multiAgentV2Enabled
              ? <span className="text-warning">{t("sub.ultraModeV2Required")}</span>
              : t("subagentsV2.ultraShort")}
            help={<HelpTip label={t("sub.ultraMode")}>{t("sub.ultraModeHint")}</HelpTip>}
            control={
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
            }
          />
          {ultraOn && (
            <div className="swi-delegation-row swi-ultra-mode-editor flex flex-col gap-2 px-4 py-3.5">
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
          </div>
        </details>
      </FrameBody>
    </Frame>
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
        className="input swi-ultra-mode-textarea min-h-24 w-full font-mono text-[12px] leading-5"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        rows={4}
        aria-label={labels.text}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { if (preset !== null) setDraft(preset); }}
          disabled={disabled || preset === null}
        >
          {labels.preset}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={commit}
          disabled={disabled || draft.trim().length === 0}
        >
          {labels.save}
        </Button>
      </div>
    </>
  );
}
