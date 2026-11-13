import { COMBO_STRATEGY_HINT_KEYS, COMBO_STRATEGY_LABEL_KEYS, type ComboStrategy } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { ROUTE_BOARD_STRATEGIES } from "../../route-board-model";
import { Select } from "../../ui";

/** Row strategy picker: every option carries its one-line explanation; the trigger shows the name. */
export function StrategyMenu({ value, label, disabled, onChange }: {
  value: ComboStrategy;
  label: string;
  disabled?: boolean;
  onChange: (next: ComboStrategy) => void;
}) {
  const t = useT();
  const options = ROUTE_BOARD_STRATEGIES.map((strategy) => ({
    value: strategy,
    textValue: t(COMBO_STRATEGY_LABEL_KEYS[strategy]),
    label: (
      <span className="rb-strategy-option">
        <span className="rb-strategy-name">{t(COMBO_STRATEGY_LABEL_KEYS[strategy])}</span>
        <span className="rb-strategy-hint">{t(COMBO_STRATEGY_HINT_KEYS[strategy])}</span>
      </span>
    ),
  }));
  return (
    <Select
      size="sm"
      className="rb-strategy"
      value={value}
      options={options}
      label={label}
      disabled={disabled}
      align="right"
      dropdownStyle={{ width: 360 }}
      onChange={(next) => onChange(next as ComboStrategy)}
    />
  );
}
