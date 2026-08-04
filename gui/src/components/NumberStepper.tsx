import { IconArrowDown, IconArrowUp } from "../icons";

export interface NumberStepperProps {
  disabled?: boolean;
  /** Increase the bound value (parent owns parsing / clamping). */
  onIncrement(): void;
  /** Decrease the bound value. */
  onDecrement(): void;
  incrementLabel: string;
  decrementLabel: string;
}

/** Compact up/down pair matching dashboard control chrome (inbound inside input wraps). */
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
        onMouseDown={(event) => event.preventDefault()}
        onClick={onIncrement}
      >
        <IconArrowUp width={10} height={10} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="ocx-stepper__btn"
        disabled={disabled}
        aria-label={decrementLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDecrement}
      >
        <IconArrowDown width={10} height={10} aria-hidden="true" />
      </button>
    </div>
  );
}
