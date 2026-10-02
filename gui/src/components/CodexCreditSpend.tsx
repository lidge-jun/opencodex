import { useId } from "react";
import { useT } from "../i18n/shared";
import { IconChevron } from "../icons";
import { computeCodexUsageScore } from "../codex-quota-utils";
import type { CreditSpendSummary } from "../codex-credit-spend";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import "../styles/codex-credits.css";

/**
 * Spending ChatGPT credits after a usage limit is opt-in (#6334). Upstream keeps serving an account
 * that holds credits at 100% and draws the balance, so by default every account is switched out at
 * 100% and returns after its reset. The header carries one global switch beside the credits
 * display; its count opens a panel with one switch per account. The global switch is derived from
 * the accounts: off when none may spend, mixed when some may, on when all may.
 */
export function CodexCreditSpendSwitch({ summary, busy, expanded, panelId, onToggleAll, onToggleExpanded }: {
  summary: CreditSpendSummary;
  busy: boolean;
  expanded: boolean;
  panelId: string;
  /** The requested global state: true allows every account, false clears them all. */
  onToggleAll(enabled: boolean): void;
  onToggleExpanded(): void;
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
      <button
        type="button"
        className="btn btn-ghost btn-sm codex-credit-spend__disclosure"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={t("codexAuth.creditSpendChoose", { enabled: String(summary.enabled), total: String(summary.total) })}
        disabled={summary.total === 0}
        onClick={onToggleExpanded}
      >
        <span className="codex-credit-spend__count">{summary.enabled}/{summary.total}</span>
        <IconChevron className="codex-credit-spend__chevron" width={14} height={14} aria-hidden="true" />
      </button>
    </span>
  );
}

export function CodexCreditSpendPanel({ id, rows, updatingId, onToggle }: {
  id: string;
  rows: readonly CodexAccountEntry[];
  /** The account being written, or "*" while the global switch writes. */
  updatingId: string | null;
  onToggle(account: CodexAccountEntry, enabled: boolean): void;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <section id={id} className="card codex-credit-spend-panel" aria-labelledby={titleId}>
      <div className="card-head">
        <strong id={titleId}>{t("codexAuth.creditsAfterLimit")}</strong>
      </div>
      <p className="card-sub codex-credit-spend-panel__hint">{t("codexAuth.creditsAfterLimitHint")}</p>
      <ul className="codex-credit-spend-panel__list">
        {rows.map(row => {
          const name = row.alias ?? row.email;
          const label = name || t("codexAuth.mainAccount");
          const on = row.creditsAfterLimit === true;
          const atLimit = (computeCodexUsageScore(row.quota, row.plan) ?? 0) >= 100;
          return (
            <li key={row.id} className="codex-credit-spend-panel__row">
              <span className="codex-credit-spend-panel__name">
                <span className="codex-credit-spend-panel__label">{label}</span>
                {row.isMain && name && <span className="badge badge-muted">{t("codexAuth.mainAccount")}</span>}
                {atLimit && <span className="badge badge-amber">{t("codexAuth.creditSpendAtLimit")}</span>}
              </span>
              <button
                type="button"
                className={`toggle ${on ? "on" : ""}`}
                aria-pressed={on}
                aria-label={t("codexAuth.creditsAfterLimitAria", { email: label })}
                disabled={updatingId !== null}
                aria-busy={updatingId === row.id || undefined}
                onClick={() => onToggle(row, !on)}
              >
                <span className="toggle-knob" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
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
