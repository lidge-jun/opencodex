import { IconChevron } from "../icons";

export interface NumberStepperProps {
  disabled?: boolean;
  /** Increase the bound value (parent owns parsing / clamping). */
  onIncrement(): void;
  /** Decrease the bound value. */
  onDecrement(): void;
  incrementLabel: string;
  decrementLabel: string;
}

/** Compact up/down chevron pair matching dashboard control chrome. */
export function NumberStepper({
  disabled = false,
  onIncrement,
  onDecrement,
  incrementLabel,
  decrementLabel,
}: NumberStepperProps) {
  return (
    <div className="ocx-stepper" role="group">
      <button
        type="button"
        className="ocx-stepper__btn"
        disabled={disabled}
        aria-label={incrementLabel}
        onClick={onIncrement}
      >
        <IconChevron width={10} height={10} aria-hidden="true" style={{ transform: "rotate(-90deg)" }} />
      </button>
      <button
        type="button"
        className="ocx-stepper__btn"
        disabled={disabled}
        aria-label={decrementLabel}
        onClick={onDecrement}
      >
        <IconChevron width={10} height={10} aria-hidden="true" style={{ transform: "rotate(90deg)" }} />
      </button>
    </div>
  );
}
