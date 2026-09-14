import { useId, useRef, useState } from "react";
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
  const pendingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const enabled = override !== null;
  const [editor, setEditor] = useState({ override, draft: String(override ?? globalThreshold) });
  // Only an account override change replaces the draft. Global refreshes must not
  // erase an unfinished custom edit, and neither update should replace focused DOM.
  if (editor.override !== override) {
    setEditor({ override, draft: String(override ?? globalThreshold) });
  }
  const { draft } = editor;
  const setDraft = (value: string) => setEditor(current => ({ ...current, draft: value }));
  const resetDraft = () => setEditor(current => ({
    ...current,
    draft: String(current.override ?? globalThreshold),
  }));
  const blocked = disabled || saving;
  const hint = t("accountPool.autoSwitchHint");
  const hintId = useId();

  const write = async (next: number | null) => {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      // The controller owns acceptance. Reconcile even when a rejected toggle
      // leaves the override unchanged (including zero), without falling back to global.
      resetDraft();
      pendingRef.current = false;
      setSaving(false);
    }
  };

  const commit = async () => {
    if (!enabled || disabled || pendingRef.current) return;
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      resetDraft();
      return;
    }
    if (parsed === override) return;
    await write(parsed);
  };

  const step = (delta: -1 | 1) => {
    if (disabled || pendingRef.current) return;
    const nextDraft = clampNumberDraft(draft, delta, 0, 100);
    setDraft(nextDraft);
    const next = Number(nextDraft);
    if (next !== override) {
      void write(next);
    }
  };

  return (
    <div
      className="codex-account-auto-switch"
      title={hint}
      aria-busy={saving}
      aria-disabled={blocked}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (togglePointerIntentRef.current) {
          togglePointerIntentRef.current = false;
          return;
        }
        void commit();
      }}
    >
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
            readOnly={blocked}
            aria-disabled={blocked}
            aria-label={t("accountPool.autoSwitchThresholdAria", { email: accountLabel })}
            aria-describedby={hintId}
            onChange={(event) => { if (!blocked) setDraft(event.target.value); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || blocked) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                resetDraft();
              }
            }}
          />
          <span className="codex-account-auto-switch-unit" aria-hidden="true">%</span>
          <NumberStepper
            disabled={disabled && !saving}
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
        disabled={disabled && !saving}
        aria-disabled={blocked}
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
          void write(enabled ? null : globalThreshold);
        }}
      >
        <span className="toggle-knob" />
      </button>
      <span id={hintId} className="sr-only">{hint}</span>
    </div>
  );
}
