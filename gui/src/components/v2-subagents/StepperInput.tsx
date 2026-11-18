import type { InputHTMLAttributes, ReactNode } from "react";
import { IconMinus, IconPlus } from "../../icons";
import { cn } from "@/lib/utils";

interface StepperInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  decrementLabel: string;
  incrementLabel: string;
  onDecrement: () => void;
  onIncrement: () => void;
  /** Disables both buttons; the input keeps its own `disabled` / `readOnly`. */
  stepDisabled?: boolean;
  /** Unit shown after the number, such as `ms`. */
  unit?: ReactNode;
  className?: string;
  inputClassName?: string;
}

const stepButton = cn(
  "inline-flex h-full w-8 shrink-0 cursor-pointer items-center justify-center text-fg-muted transition-colors",
  "hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-highlight",
  "disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5",
);

/**
 * A number field with a minus and a plus on either side (React Bits settings forms), so a
 * value can be nudged without typing. The parent owns parsing and clamping.
 */
export function StepperInput({
  decrementLabel, incrementLabel, onDecrement, onIncrement, stepDisabled, unit, className, inputClassName, ...input
}: StepperInputProps) {
  return (
    <span
      className={cn(
        "ui-v2 inline-flex h-[var(--ocx-control-h)] items-stretch overflow-hidden rounded-control bg-raised shadow-sm ring-1 ring-inset ring-line-strong",
        "transition-shadow focus-within:ring-2 focus-within:ring-highlight",
        "has-[input[aria-invalid=true]]:ring-danger",
        "has-[input:disabled]:opacity-60 has-[input[readonly]]:bg-surface",
        className,
      )}
    >
      <button
        type="button"
        className={cn(stepButton, "border-r border-line")}
        disabled={stepDisabled}
        aria-label={decrementLabel}
        onMouseDown={event => event.preventDefault()}
        onClick={onDecrement}
      >
        <IconMinus aria-hidden="true" />
      </button>
      <span className="flex min-w-0 items-center">
        <input
          type="number"
          {...input}
          className={cn(
            "h-full w-20 min-w-0 border-0 bg-transparent px-2 text-center font-mono text-[13px] text-fg tabular-nums outline-none",
            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            inputClassName,
          )}
        />
        {unit && <span className="pr-2 font-mono text-[12px] text-fg-subtle select-none">{unit}</span>}
      </span>
      <button
        type="button"
        className={cn(stepButton, "border-l border-line")}
        disabled={stepDisabled}
        aria-label={incrementLabel}
        onMouseDown={event => event.preventDefault()}
        onClick={onIncrement}
      >
        <IconPlus aria-hidden="true" />
      </button>
    </span>
  );
}
