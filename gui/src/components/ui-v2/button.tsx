import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/*
 * Design system v2 button. The primary is a flat fill in the inverse primary
 * (white on dark, near-black on light); hover only eases it a touch. No
 * gradient, sheen or glow: the rest are quiet neutrals so one primary action
 * per surface stands out (foundations.md, "Motion and decoration").
 */
const VARIANTS = {
  primary:
    "bg-accent text-on-accent shadow-sm hover:bg-accent/88",
  outline:
    "bg-raised text-fg ring-1 ring-inset ring-line-strong hover:bg-surface",
  ghost: "bg-transparent text-fg-muted hover:bg-surface hover:text-fg",
  danger:
    "bg-danger-soft text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger hover:text-on-accent",
} as const;

const SIZES = {
  // Heights are the two control tokens (theme.css), shared with every v1 field and button.
  // In a row that holds a field or a select, bridge.css sets --ocx-row-control-h on the row's
  // children so a small button matches its neighbour (foundations.md, "Control sizes").
  sm: "h-[var(--ocx-row-control-h,var(--ocx-control-h-sm))] gap-1.5 px-3 text-[13px]",
  md: "h-[var(--ocx-control-h)] gap-2 px-4 text-[13px]",
  icon: "size-[var(--ocx-control-h)] p-0",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "ui-v2 inline-flex shrink-0 cursor-pointer items-center justify-center rounded-control font-medium whitespace-nowrap select-none",
        "transition-[background-color,color,box-shadow,scale] duration-200 ease-soft active:scale-[0.97]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});
