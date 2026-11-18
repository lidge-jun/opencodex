import { cn } from "@/lib/utils";

/** Bare icon at rest, a soft plate on hover; the shape every secondary icon button shares. */
export const iconButton = cn(
  "ui-v2 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-fg-muted",
  "transition-colors duration-150 hover:bg-surface-2 hover:text-fg",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
  "disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
);

/** Numbered square in front of an ordered row. */
export const stepIndicator =
  "grid size-6 shrink-0 place-items-center rounded-[7px] text-[12px] font-medium tabular-nums ring-1 ring-inset";
