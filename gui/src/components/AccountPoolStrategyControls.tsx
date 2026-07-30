import { useT } from "../i18n/shared";
import {
  ACCOUNT_POOL_STRATEGIES,
  type AccountPoolStrategy,
} from "../account-pool-strategy";

const STRATEGY_LABEL_KEYS = {
  quota: "accountPool.strategyQuota",
  "round-robin": "accountPool.strategyRoundRobin",
  "fill-first": "accountPool.strategyFillFirst",
} as const;

export interface AccountPoolStrategyControlsProps {
  strategy: AccountPoolStrategy;
  stickyDraft: string;
  disabled?: boolean;
  strategySelectId?: string;
  stickyInputId?: string;
  /**
   * Hide the visual strategy label when the surrounding card title already reads
   * "Rotation strategy". The select keeps its aria-label, so the accessible name
   * survives while the duplicated on-screen text disappears.
   */
  strategyLabelHidden?: boolean;
  onStrategyChange(strategy: AccountPoolStrategy): void;
  onStickyDraftChange(value: string): void;
  onStickyCommit(): void;
}

/**
 * Shared strategy select + round-robin sticky limit for Codex / Anthropic account pools.
 */
export default function AccountPoolStrategyControls({
  strategy,
  stickyDraft,
  disabled = false,
  strategySelectId = "account-pool-strategy",
  stickyInputId = "account-pool-sticky-limit",
  strategyLabelHidden = false,
  onStrategyChange,
  onStickyDraftChange,
  onStickyCommit,
}: AccountPoolStrategyControlsProps) {
  const t = useT();
  return (
    <div style={{ marginTop: 12 }}>
      <label className="field" style={{ display: "block" }} htmlFor={strategySelectId}>
        <span className={strategyLabelHidden ? "sr-only" : "field-label"}>
          {t("accountPool.strategy")}
        </span>
        <select
          id={strategySelectId}
          className="input"
          value={strategy}
          disabled={disabled}
          aria-label={t("accountPool.strategy")}
          onChange={(event) => {
            onStrategyChange(event.target.value as AccountPoolStrategy);
          }}
        >
          {ACCOUNT_POOL_STRATEGIES.map((value) => (
            <option key={value} value={value}>
              {t(STRATEGY_LABEL_KEYS[value])}
            </option>
          ))}
        </select>
      </label>
      <div className="card-sub" style={{ marginTop: 4 }}>
        {t("accountPool.strategyHint")}
      </div>
      {strategy === "round-robin" && (
        <label className="field" style={{ display: "block", marginTop: 12 }} htmlFor={stickyInputId}>
          <span className="field-label">{t("accountPool.stickyLimit")}</span>
          <input
            id={stickyInputId}
            className="input mono"
            type="number"
            min={1}
            max={100}
            step={1}
            inputMode="numeric"
            value={stickyDraft}
            disabled={disabled}
            aria-label={t("accountPool.stickyLimitAria")}
            onChange={(event) => onStickyDraftChange(event.target.value)}
            onBlur={() => onStickyCommit()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                onStickyCommit();
              }
            }}
          />
          <div className="card-sub" style={{ marginTop: 4 }}>{t("accountPool.stickyLimitHelp")}</div>
        </label>
      )}
    </div>
  );
}
