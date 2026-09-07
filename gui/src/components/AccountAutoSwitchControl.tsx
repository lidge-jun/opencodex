import { useRef, useState } from "react";
import { clampNumberDraft } from "../clamp-draft";
import { useT } from "../i18n/shared";
import { NumberStepper } from "./NumberStepper";

export interface AccountAutoSwitchControlProps {
  accountLabel: string;
  globalThreshold: number;
  override: number | null;
  disabled?: boolean;
  inputId: string;
  onChange(threshold: number | null): Promise<boolean>;
}

/** Compact account-card override for global usage-driven switching threshold. */
export default function AccountAutoSwitchControl({
  accountLabel,
  globalThreshold,
  override,
  disabled = false,
  inputId,
  onChange,
}: AccountAutoSwitchControlProps) {
  const t = useT();
  const togglePointerIntentRef = useRef(false);
  const enabled = override !== null;
  const [draft, setDraft] = useState(String(override ?? globalThreshold));
  const hint = t("accountPool.autoSwitchHint");
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- element id suffix, not UI text
  const hintId = `${inputId}-hint`;

  const commit = async () => {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setDraft(String(override ?? globalThreshold));
      return;
    }
    if (parsed === override) return;
    if (!await onChange(parsed)) setDraft(String(override));
  };

  const step = (delta: -1 | 1) => {
    const nextDraft = clampNumberDraft(draft, delta, 0, 100);
    setDraft(nextDraft);
    const next = Number(nextDraft);
    if (next !== override) {
      void onChange(next).then(accepted => {
        if (!accepted) setDraft(String(override));
      });
    }
  };

  return (
    <div className="codex-account-auto-switch" title={hint}>
      <label className="codex-account-auto-switch-label" htmlFor={enabled ? inputId : undefined}>
        {t("accountPool.autoSwitchThreshold")}
      </label>
      {enabled && (
        <span className="codex-account-auto-switch-input-wrap">
          <input
            id={inputId}
            className="input mono codex-auto-switch-input codex-account-auto-switch-input"
            type="number"
            min={0}
            max={100}
            step={1}
            inputMode="numeric"
            value={draft}
            disabled={disabled}
            aria-label={t("accountPool.autoSwitchThresholdAria", { email: accountLabel })}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (togglePointerIntentRef.current) {
                togglePointerIntentRef.current = false;
                return;
              }
              void commit();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(String(override));
              }
            }}
          />
          <span className="codex-account-auto-switch-unit" aria-hidden="true">%</span>
          <NumberStepper
            disabled={disabled}
            incrementLabel={t("codexAuth.autoSwitchThresholdInc")}
            decrementLabel={t("codexAuth.autoSwitchThresholdDec")}
            onIncrement={() => step(1)}
            onDecrement={() => step(-1)}
          />
        </span>
      )}
      <button
        type="button"
        className={`toggle codex-account-auto-switch-toggle ${enabled ? "on" : ""}`}
        disabled={disabled}
        aria-pressed={enabled}
        aria-label={t("accountPool.autoSwitchOverrideAria", { email: accountLabel })}
        aria-describedby={hintId}
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
          void onChange(enabled ? null : globalThreshold);
        }}
      >
        <span className="toggle-knob" />
      </button>
      <span id={hintId} className="sr-only">{hint}</span>
    </div>
  );
}
