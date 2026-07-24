import { useRef } from "react";
import { useT } from "../i18n";

export type AutoSwitchFeedback = { tone: "ok" | "err"; message: string } | null;

export interface CodexAutoSwitchSettingProps {
  threshold: number | null;
  draft: string;
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
  const ready = threshold !== null;
  const enabled = ready && threshold > 0;
  const feedbackMessage = saving ? t("common.saving") : feedback?.message ?? "";
  const feedbackTone = saving ? "pending" : feedback?.tone;
  const describedBy = feedbackMessage
    ? "codex-auto-switch-desc codex-auto-switch-feedback"
    : "codex-auto-switch-desc";
  return (
    <div
      className="card card-row codex-auto-switch-card"
      style={{ marginTop: 16 }}
      aria-busy={saving || (!ready && !loadError)}
    >
      <div className="codex-auto-switch-copy">
        <strong>{t("codexAuth.autoSwitch")}</strong>
        <div
          id="codex-auto-switch-desc"
          className="card-sub"
          role={!ready ? (loadError ? "alert" : "status") : undefined}
        >
          {!ready
            ? loadError ? t("codexAuth.autoSwitchLoadFailed") : t("common.loading")
            : enabled
            ? t("codexAuth.autoSwitchDesc", { threshold })
            : t("codexAuth.autoSwitchOffDesc")}
        </div>
      </div>
      {ready ? (
        <div
          className="codex-auto-switch-controls"
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            onEditingChange(false);
            if (togglePointerIntentRef.current) {
              togglePointerIntentRef.current = false;
              return;
            }
            if (enabled && !saving) void onCommit();
          }}
        >
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
                  readOnly={saving}
                  aria-disabled={saving}
                  aria-label={t("codexAuth.autoSwitchThresholdAria")}
                  aria-describedby={describedBy}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onFocus={() => onEditingChange(true)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || saving) return;
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
              </span>
            </label>
          )}
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
            disabled={saving}
            aria-pressed={enabled}
            aria-label={t("codexAuth.autoSwitch")}
            aria-describedby={describedBy}
            title={t("codexAuth.autoSwitch")}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      ) : loadError ? (
        <div className="codex-auto-switch-controls">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t("pws.retryAccounts")}
          </button>
        </div>
      ) : null}
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
