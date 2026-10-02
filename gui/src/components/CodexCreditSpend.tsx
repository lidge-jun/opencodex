import { useId } from "react";
import { useT } from "../i18n/shared";
import type { CreditSpendSummary } from "../codex-credit-spend";
import "../styles/codex-credits.css";

/**
 * Spending ChatGPT credits after a usage limit is opt-in (#6334). Upstream keeps serving an account
 * that holds credits at 100% and draws the balance, so by default every account is switched out at
 * 100% and returns after its reset. The header carries one global switch beside the credits
 * display; each account's own switch lives in that card's "more" disclosure. The global switch is
 * derived from the accounts: off when none may spend, mixed when some may, on when all may.
 */
export function CodexCreditSpendSwitch({ summary, busy, onToggleAll }: {
  summary: CreditSpendSummary;
  busy: boolean;
  /** The requested global state: true allows every account, false clears them all. */
  onToggleAll(enabled: boolean): void;
}) {
  const t = useT();
  const hintId = useId();
  const all = summary.total > 0 && summary.enabled === summary.total;
  const mixed = summary.enabled > 0 && !all;
  return (
    <span className="codex-credit-spend" aria-busy={busy || undefined}>
      <span className="codex-auth-credits-toggle__label">{t("codexAuth.creditSpend")}</span>
      <button
        type="button"
        className={`toggle ${all ? "on" : ""}`}
        aria-label={t("codexAuth.creditSpendAria")}
        aria-describedby={hintId}
        aria-pressed={mixed ? "mixed" : all}
        title={t("codexAuth.creditsAfterLimitHint")}
        disabled={busy || summary.total === 0}
        onClick={() => onToggleAll(!all)}
      >
        <span className="toggle-knob" />
      </button>
      <span id={hintId} className="sr-only">{t("codexAuth.creditsAfterLimitHint")}</span>
    </span>
  );
}

/** One account's switch, rendered inside its card's "more" disclosure. */
export function AccountCreditsToggle({ accountLabel, enabled, saving, disabled, hint, onChange }: {
  accountLabel: string;
  /** Absent on rows from an older server; the default is off. */
  enabled: boolean | undefined;
  saving: boolean;
  disabled: boolean;
  /** Replaces the shared hint; the main login uses it to name its hard lock. */
  hint?: string;
  onChange(enabled: boolean): void;
}) {
  const t = useT();
  const hintId = useId();
  const on = enabled === true;
  const description = hint ?? t("codexAuth.creditsAfterLimitHint");
  return (
    <div className="codex-account-credits" title={description} aria-busy={saving || undefined}>
      <span className="codex-account-credits__label">{t("codexAuth.creditsAfterLimit")}</span>
      <button
        type="button"
        className={`toggle codex-account-credits__toggle ${on ? "on" : ""}`}
        disabled={disabled || saving}
        aria-pressed={on}
        aria-label={t("codexAuth.creditsAfterLimitAria", { email: accountLabel })}
        aria-describedby={hintId}
        onClick={() => onChange(!on)}
      >
        <span className="toggle-knob" />
      </button>
      <span id={hintId} className="sr-only">{description}</span>
    </div>
  );
}

/** Marks an account allowed to spend credits, so the exception is visible on its card. */
export function CreditsOnBadge({ enabled }: { enabled: boolean | undefined }) {
  const t = useT();
  if (enabled !== true) return null;
  return (
    <span className="badge badge-amber" title={t("codexAuth.creditsAfterLimitHint")}>
      {t("codexAuth.creditsOn")}
    </span>
  );
}
