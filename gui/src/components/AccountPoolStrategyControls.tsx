import { useT } from "../i18n/shared";
import {
  ACCOUNT_POOL_STRATEGIES,
  type AccountPoolStrategy,
} from "../account-pool-strategy";
import { NumberStepper } from "./NumberStepper";

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
  /** When true, omit the outer strategy label (parent card already titled). */
  hideStrategyLabel?: boolean;
  onStrategyChange(strategy: AccountPoolStrategy): void;
  onStickyDraftChange(value: string): void;
  onStickyCommit(): void;
}

function clampStickyDraft(raw: string, delta: number): string {
  const parsed = Number.parseInt(raw, 10);
  const base = Number.isFinite(parsed) ? parsed : 1;
  return String(Math.min(100, Math.max(1, base + delta)));
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
  hideStrategyLabel = false,
  onStrategyChange,
  onStickyDraftChange,
  onStickyCommit,
}: AccountPoolStrategyControlsProps) {
  const t = useT();
  return (
    <div className="account-pool-strategy-controls">
      <label className="field" htmlFor={strategySelectId}>
        {!hideStrategyLabel && <span className="field-label">{t("accountPool.strategy")}</span>}
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
      <div className="card-sub">{t("accountPool.strategyHint")}</div>
      {strategy === "round-robin" && (
        <label className="field" htmlFor={stickyInputId}>
          <span className="field-label">{t("accountPool.stickyLimit")}</span>
          <span className="codex-auto-switch-input-wrap">
            <input
              id={stickyInputId}
              className="input mono codex-auto-switch-input"
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
            <NumberStepper
              disabled={disabled}
              incrementLabel={t("accountPool.stickyLimitInc")}
              decrementLabel={t("accountPool.stickyLimitDec")}
              onIncrement={() => onStickyDraftChange(clampStickyDraft(stickyDraft, 1))}
              onDecrement={() => onStickyDraftChange(clampStickyDraft(stickyDraft, -1))}
            />
          </span>
          <div className="card-sub">{t("accountPool.stickyLimitHelp")}</div>
        </label>
      )}
    </div>
  );
}
