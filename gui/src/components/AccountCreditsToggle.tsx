import { useId } from "react";
import { useT } from "../i18n/shared";
import "./account-auto-switch-control.css";

export interface AccountCreditsToggleProps {
  accountLabel: string;
  /** Absent on rows from an older server; the default is on. */
  enabled: boolean | undefined;
  saving: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
}

/**
 * Account switch for spending ChatGPT credits once a usage window is full (#6334). Off makes
 * selection skip the account until the window resets. Shares the threshold control's row styles
 * so the two read as one group on the card. Cards render it only while the page's "Codex credits"
 * display is on; {@link CreditsOffBadge} covers the hidden case.
 */
export default function AccountCreditsToggle({ accountLabel, enabled, saving, disabled, onChange }: AccountCreditsToggleProps) {
  const t = useT();
  const hintId = useId();
  const on = enabled !== false;
  const blocked = disabled || saving;
  return (
    <div className="codex-account-auto-switch" title={t("codexAuth.creditsAfterLimitHint")} aria-busy={saving}>
      <span className="codex-account-auto-switch-label">{t("codexAuth.creditsAfterLimit")}</span>
      <button
        type="button"
        className={`toggle codex-account-auto-switch-toggle ${on ? "on" : ""}`}
        disabled={blocked}
        aria-pressed={on}
        aria-label={t("codexAuth.creditsAfterLimitAria", { email: accountLabel })}
        aria-describedby={hintId}
        onClick={() => onChange(!on)}
      >
        <span className="toggle-knob" />
      </button>
      <span id={hintId} className="sr-only">{t("codexAuth.creditsAfterLimitHint")}</span>
    </div>
  );
}

/**
 * Shown while the "Codex credits" display hides the switch, so an account held by it never looks
 * like an ordinary one. The display setting changes what the card shows, never routing.
 */
export function CreditsOffBadge({ enabled }: { enabled: boolean | undefined }) {
  const t = useT();
  if (enabled !== false) return null;
  return (
    <span className="badge badge-muted" title={t("codexAuth.creditsAfterLimitHint")}>
      {t("codexAuth.creditsOff")}
    </span>
  );
}
