/**
 * The on/off switch for one model row, shared by the Models "Overall" tab and the provider
 * Models tab. An ARIA switch (role="switch", aria-checked) whose name is the model identifier
 * and never changes with its state; the change applies at once, with no Save step.
 */
import { Switch } from "./ui";
import { rowVisibilityLabel, type VisibilityRow } from "./model-visibility-rows";

export function ModelVisibilitySwitch({ row, on, disabled, onToggle }: {
  row: VisibilityRow;
  on: boolean;
  disabled: boolean;
  /** Receives the requested next state. */
  onToggle: (enable: boolean) => void;
}) {
  return <Switch on={on} disabled={disabled} label={rowVisibilityLabel(row)} onClick={() => onToggle(!on)} />;
}

