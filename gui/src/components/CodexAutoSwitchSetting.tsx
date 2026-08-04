import { useRef } from "react";
import { useT } from "../i18n/shared";
import { clampNumberDraft } from "../clamp-draft";
import type { AccountPoolStrategy } from "../account-pool-strategy";
import { NumberStepper } from "./NumberStepper";

export type AutoSwitchFeedback = { tone: "ok" | "err"; message: string } | null;

const AUTO_SWITCH_DESCRIPTION_KEYS = {
  quota: {
    on: "codexAuth.autoSwitchQuotaDesc",
    off: "codexAuth.autoSwitchQuotaOffDesc",
  },
  "round-robin": {
    on: "codexAuth.autoSwitchRoundRobinDesc",
    off: "codexAuth.autoSwitchRoundRobinDesc",
  },
  "fill-first": {
    on: "codexAuth.autoSwitchFillFirstDesc",
    off: "codexAuth.autoSwitchFillFirstOffDesc",
  },
} as const;

export interface CodexAutoSwitchSettingProps {
  threshold: number;
  draft: string;
  strategy?: AccountPoolStrategy;
  /** When false, chrome still paints but interaction is blocked until /active confirms. */
  hydrated?: boolean;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  onDraftChange(value: string): void;
  onEditingChange(editing: boolean): void;
  onCommit(): Promise<boolean>;
  onCancel(): void;
  onToggle(): Promise<boolean>;
  onRetry(): void;
}

export function CodexAutoSwitchSetting({
  threshold,
  draft,
  strategy = "quota",
  hydrated = true,
  saving,
  loadError,
  feedback,
  onDraftChange,
  onEditingChange,
  onCommit,
  onCancel,
  onToggle,
  onRetry,
}: CodexAutoSwitchSettingProps) {
  const t = useT();
  const togglePointerIntentRef = useRef(false);
  const enabled = threshold > 0;
  const descriptionKey = AUTO_SWITCH_DESCRIPTION_KEYS[strategy][enabled ? "on" : "off"];
  const controlsDisabled = saving || !hydrated;
  const feedbackMessage = saving ? t("common.saving") : feedback?.message ?? "";
  const feedbackTone = saving ? "pending" : feedback?.tone;
  const describedBy = feedbackMessage
    ? "codex-auto-switch-desc codex-auto-switch-feedback"
    : "codex-auto-switch-desc";
  return (
    <div
      className="card card-row codex-auto-switch-card"
      style={{ marginTop: 16 }}
      aria-busy={saving || (!hydrated && !loadError) || undefined}
    >
      <div className="codex-auto-switch-copy">
        <strong>{t("codexAuth.autoSwitch")}</strong>
        <div
          id="codex-auto-switch-desc"
          className="card-sub"
          role={loadError ? "alert" : undefined}
        >
          {loadError
            ? t("codexAuth.autoSwitchLoadFailed")
            : t(descriptionKey, { threshold })}
        </div>
        <div className="card-sub">{t("codexAuth.failureRecoveryNote")}</div>
        <div className="card-sub">{t("codexAuth.cacheWarning")}</div>
      </div>
      <div
        className="codex-auto-switch-controls"
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onEditingChange(false);
          if (togglePointerIntentRef.current) {
            togglePointerIntentRef.current = false;
            return;
          }
          if (enabled && !controlsDisabled) void onCommit();
        }}
      >
        {loadError && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t("pws.retryAccounts")}
          </button>
        )}
        {enabled && (
          <label className="codex-auto-switch-threshold">
            <span className="field-label">{t("codexAuth.autoSwitchThreshold")}</span>
            <span className="codex-auto-switch-input-wrap">
              <input
                className="input mono codex-auto-switch-input"
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={draft}
                readOnly={controlsDisabled}
                aria-disabled={controlsDisabled}
                aria-label={t("codexAuth.autoSwitchThresholdAria")}
                aria-describedby={describedBy}
                onChange={(event) => onDraftChange(event.target.value)}
                onFocus={() => {
                  if (!controlsDisabled) onEditingChange(true);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || controlsDisabled) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void onCommit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    onCancel();
                  }
                }}
              />
              <span className="codex-auto-switch-unit" aria-hidden="true">%</span>
              <NumberStepper
                disabled={controlsDisabled}
                incrementLabel={t("codexAuth.autoSwitchThresholdInc")}
                decrementLabel={t("codexAuth.autoSwitchThresholdDec")}
                onIncrement={() => {
                  onEditingChange(true);
                  onDraftChange(clampNumberDraft(draft, 1, 1, 100));
                }}
                onDecrement={() => {
                  onEditingChange(true);
                  onDraftChange(clampNumberDraft(draft, -1, 1, 100));
                }}
              />
            </span>
          </label>
        )}
        {/*
          The toggle sits in a slot as tall as the threshold field so the two controls share a
          center line. The row is bottom-aligned (a 20px toggle against a 32px number compound
          offset their centers by 6px, which is what read as a height bug), and the slot fixes
          that without flipping the container to center — the mobile breakpoint deliberately
          keeps bottom alignment.

          Rendered outside the `enabled` branch on purpose: if the slot came and went with the
          threshold field, the toggle would shift every time auto-switch was turned off.
        */}
        <span className="codex-auto-switch-toggle-slot">
          <button
            type="button"
            className={`toggle ${enabled ? "on" : ""}`}
            onPointerDownCapture={() => {
              togglePointerIntentRef.current = true;
            }}
            onPointerUp={() => {
              togglePointerIntentRef.current = false;
            }}
            onPointerCancel={() => {
              togglePointerIntentRef.current = false;
            }}
            onClick={() => {
              togglePointerIntentRef.current = false;
              void onToggle();
            }}
            disabled={controlsDisabled}
            aria-pressed={enabled}
            aria-label={t("codexAuth.autoSwitch")}
            aria-describedby={describedBy}
            title={t("codexAuth.autoSwitch")}
          >
            <span className="toggle-knob" />
          </button>
        </span>
      </div>
      {feedbackMessage && (
        <div
          id="codex-auto-switch-feedback"
          className={`codex-auto-switch-feedback${feedbackTone === "err" ? " is-error" : ""}`}
          role={feedbackTone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedbackMessage}
        </div>
      )}
    </div>
  );
}

export default CodexAutoSwitchSetting;
