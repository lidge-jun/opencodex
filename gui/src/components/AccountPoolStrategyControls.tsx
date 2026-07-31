import { useT } from "../i18n/shared";
import {
  ACCOUNT_POOL_STRATEGIES,
  type AccountPoolStrategy,
} from "../account-pool-strategy";
import { clampNumberDraft } from "../clamp-draft";
import { NumberStepper } from "./NumberStepper";
import { Select } from "../ui";

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
  /** Optional draft overrides React state when steppers commit in the same tick as a draft change. */
  onStickyCommit(nextDraft?: string): void;
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
  const strategyOptions = ACCOUNT_POOL_STRATEGIES.map((value) => ({
    value,
    label: t(STRATEGY_LABEL_KEYS[value]),
  }));

  return (
    <div className="account-pool-strategy-controls">
      <div className="field">
        <span
          className={strategyLabelHidden ? "sr-only" : "field-label"}
          id={`${strategySelectId}-label`}
        >
          {t("accountPool.strategy")}
        </span>
        <Select
          id={strategySelectId}
          value={strategy}
          options={strategyOptions}
          disabled={disabled}
          label={t("accountPool.strategy")}
          style={{ width: "100%", display: "block" }}
          onChange={(next) => onStrategyChange(next as AccountPoolStrategy)}
        />
      </div>
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
              onIncrement={() => {
                const next = clampNumberDraft(stickyDraft, 1, 1, 100);
                onStickyDraftChange(next);
                onStickyCommit(next);
              }}
              onDecrement={() => {
                const next = clampNumberDraft(stickyDraft, -1, 1, 100);
                onStickyDraftChange(next);
                onStickyCommit(next);
              }}
            />
          </span>
          <div className="card-sub">{t("accountPool.stickyLimitHelp")}</div>
        </label>
      )}
    </div>
  );
}
