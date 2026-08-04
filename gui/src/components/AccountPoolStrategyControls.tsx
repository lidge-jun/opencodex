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

const STRATEGY_HINT_KEYS = {
  quota: "accountPool.strategyHintQuota",
  "round-robin": "accountPool.strategyHintRoundRobin",
  "fill-first": "accountPool.strategyHintFillFirst",
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
      {/*
        Canonical setting row: name and explanation on the left, control on the right. The old
        shape put an sr-only label above a full-width select, so the screen showed an unnamed
        picker under a card title.

        Both descriptions are kept deliberately. They answer different questions — the first
        what the setting does, the second what happens to threads that are already running —
        and collapsing them to one line silently drops the answer about account affinity.
      */}
      <div className="setting-row">
        <div className="setting-label">
          <span className="title" id={`${strategySelectId}-label`}>{t("accountPool.strategy")}</span>
          <span className="desc">{t("accountPool.strategyDesc")}</span>
          <span className="desc">{t(STRATEGY_HINT_KEYS[strategy])}</span>
          <span className="desc">{t("accountPool.unboundDefinition")}</span>
        </div>
        <div className="setting-controls">
          <Select
            id={strategySelectId}
            value={strategy}
            options={strategyOptions}
            disabled={disabled}
            label={t("accountPool.strategy")}
            onChange={(next) => onStrategyChange(next as AccountPoolStrategy)}
          />
        </div>
      </div>
      {strategy === "round-robin" && (
        <div className="setting-row">
          <label className="setting-label" htmlFor={stickyInputId}>
            <span className="title">{t("accountPool.stickyLimit")}</span>
            <span className="desc">{t("accountPool.stickyLimitHelp")}</span>
          </label>
          <div className="setting-controls">
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
          </div>
        </div>
      )}
    </div>
  );
}
