import { cn } from "@/lib/utils";

/*
 * Shared class strings for the v2 Logs, Debug and Storage surfaces, in the React Bits
 * application-UI form: a hairline panel (12px) holding an inset body (8px), controls at 10px,
 * quiet neutrals, and the inverse primary for anything selected.
 */

/** Outer panel: the raised frame a toolbar, a list and a footer sit in (monitoring-5). */
export const panel = "flex min-w-0 flex-col rounded-[12px] bg-surface ring-1 ring-inset ring-line";

/** The inset body inside a panel: the page colour again, so the rows read as the content. */
export const panelBody = "mx-1 mb-1 min-w-0 overflow-hidden rounded-[8px] bg-bg ring-1 ring-line";

/** A settings card: the same frame with its own padding, for switches and short forms. */
export const card = "flex min-w-0 flex-col gap-4 rounded-[12px] bg-surface p-5 ring-1 ring-inset ring-line";

export const cardTitle = "m-0 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg";
export const cardHint = "m-0 text-[13px] leading-5 text-fg-muted";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight";

/** Secondary action: bare at rest, a soft plate on hover. */
export const quietButton = cn(
  "ui-v2 inline-flex h-[var(--ocx-control-h)] shrink-0 cursor-pointer items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium text-fg-muted",
  "transition-colors hover:bg-accent-soft hover:text-fg aria-expanded:bg-accent-soft aria-expanded:text-fg",
  focusRing,
  "[&_svg]:size-4 [&_svg]:shrink-0",
);

/** Icon-only secondary action. */
export const quietIconButton = cn(
  "ui-v2 inline-grid size-8 shrink-0 cursor-pointer place-items-center rounded-control text-fg-muted transition-colors",
  "hover:bg-accent-soft hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
  focusRing,
  "[&_svg]:size-4",
);

/** A removable filter chip. */
export const chip = cn(
  "ui-v2 inline-flex h-[var(--ocx-control-h-sm)] max-w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-[8px] bg-raised px-2.5 text-[12.5px] font-medium text-fg",
  "shadow-sm ring-1 ring-inset ring-line-strong transition-colors hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-raised",
  focusRing,
  "[&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-fg-subtle",
);

/** Label above a compact field in a filter grid. */
export const fieldLabel = "flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-fg-muted";

/** Compact native select or input; the bridge paints `.input`, these set the v2 size. */
export const fieldControl = "input select-sm h-[var(--ocx-control-h)] w-full min-w-0 max-w-none px-2.5 text-[13px] text-fg";
