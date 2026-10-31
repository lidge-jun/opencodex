import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/*
 * Design system v2 button. The primary variant is the Aceternity studio
 * button: a blue top-to-bottom gradient with a soft inner glow and an inset
 * ring that brighten on hover. The rest are quiet neutrals so one primary
 * action per surface stands out.
 */
const VARIANTS = {
  primary:
    "bg-linear-to-b from-accent-top to-accent-bottom text-on-accent shadow-glow ring-1 ring-inset ring-white/20 hover:shadow-glow-hover hover:ring-white/40",
  outline:
    "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line-strong hover:bg-surface",
  ghost: "bg-transparent text-fg-muted hover:bg-surface hover:text-fg",
  danger:
    "bg-danger-soft text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger hover:text-on-accent",
} as const;

const SIZES = {
  sm: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 gap-2 px-4 text-sm",
  icon: "size-8 p-0",
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
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
