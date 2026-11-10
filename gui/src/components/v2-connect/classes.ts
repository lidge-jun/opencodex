import { cn } from "@/lib/utils";

/*
 * Class strings shared by the v2 Connect surfaces (overview, Claude, API keys, Set up hub),
 * after the React Bits Application UI blocks `integrations-1` (app grid), `settings-form-5`
 * (keys with reveal and rotate) and `onboarding-3` (checklist with progress).
 */

/** Bare icon at rest, a soft plate on hover; sized from the small control token. */
export const iconButton = cn(
  "ui-v2 inline-flex size-[var(--ocx-control-h-sm)] shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-fg-subtle",
  "transition-colors duration-150 hover:bg-surface-2 hover:text-fg",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
  "disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
);

/** Hairline frame for a list of ruled rows (the React Bits `frame`). */
export const frame = "flex min-w-0 flex-col overflow-hidden rounded-[12px] bg-raised ring-1 ring-inset ring-line";

/** Small section heading above a frame or a grid. */
export const sectionTitle = "m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg";
