import { useT } from "../i18n/shared";
import { Select } from "../ui";
import {
  ACCOUNT_PRIORITY_PRESETS,
  accountPriorityLabel,
  DEFAULT_ACCOUNT_PRIORITY,
  isAccountPriorityPreset,
  normalizeAccountPriority,
} from "../account-priority";

export interface AccountPriorityControlProps {
  value: number;
  disabled?: boolean;
  /** Unique per card: several controls share one page. */
  selectId: string;
  onChange(priority: number): void;
}

/**
 * Compact inline selection-order control for one account card.
 *
 * The presets cover every value the dashboard can create; a stored value from the API or
 * CLI that is not a preset is prepended as a selectable peer so switching away from it is
 * possible without losing what it currently is. The hint is a description rather than a
 * line of its own: it would otherwise repeat on every card in the pool.
 */
export default function AccountPriorityControl({
  value,
  disabled = false,
  selectId,
  onChange,
}: AccountPriorityControlProps) {
  const t = useT();
  const current = normalizeAccountPriority(value);
  const hint = t("accountPool.priorityHint");
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- element id suffix, not UI text
  const hintId = `${selectId}-hint`;
  const presets = ACCOUNT_PRIORITY_PRESETS.map(preset => ({
    value: String(preset),
    label: accountPriorityLabel(t, preset),
  }));
  const options = isAccountPriorityPreset(current)
    ? presets
    : [{ value: String(current), label: accountPriorityLabel(t, current) }, ...presets];
  return (
    <div className="codex-account-priority">
      <label className="codex-account-priority-label" htmlFor={selectId}>
        {t("accountPool.priority")}
      </label>
      <Select
        id={selectId}
        value={String(current)}
        options={options}
        disabled={disabled}
        label={t("accountPool.priorityAria")}
        describedBy={hintId}
        title={hint}
        onChange={(next) => onChange(normalizeAccountPriority(Number.parseInt(next, 10)))}
      />
      <span id={hintId} className="sr-only">{hint}</span>
    </div>
  );
}

/** Muted card badge naming a non-default selection order. */
export function AccountPriorityBadge({ value }: { value: number }) {
  const t = useT();
  const current = normalizeAccountPriority(value);
  if (current === DEFAULT_ACCOUNT_PRIORITY) return null;
  return <span className="badge badge-muted">{accountPriorityLabel(t, current)}</span>;
}
