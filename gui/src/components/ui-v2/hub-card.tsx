import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type HubBadge = { tone: "done" | "todo" | "optional"; label: string };

interface HubCardProps {
  title: string;
  /** The original product term, shown small so docs and CLI names still connect. */
  term?: string | undefined;
  body: ReactNode;
  badge?: HubBadge | undefined;
  icon?: ReactNode;
  onOpen: () => void;
  openLabel: string;
}

const BADGE_TONE: Record<HubBadge["tone"], string> = {
  done: "bg-success-soft text-success",
  todo: "bg-highlight-soft text-highlight",
  optional: "bg-surface-2 text-fg-muted",
};

/*
 * Design system v2 hub card: a borderless surface that is one big button. The arrow and
 * the lift on hover say "this opens somewhere"; the badge carries state, never colour alone.
 */
export function HubCard({ title, term, body, badge, icon, onOpen, openLabel }: HubCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${title} — ${openLabel}`}
      className={cn(
        "ui-v2 group flex h-full w-full cursor-pointer flex-col gap-3 rounded-card bg-surface p-5 text-left",
        "transition-[translate,box-shadow,background-color] duration-300 ease-soft hover:-translate-y-0.5 hover:bg-raised hover:shadow-md hover:ring-1 hover:ring-line",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        {icon && (
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-raised text-fg shadow-sm ring-1 ring-line transition-colors group-hover:bg-fg group-hover:text-bg [&_svg]:size-[18px]">
            {icon}
          </span>
        )}
        {badge && <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold", BADGE_TONE[badge.tone])}>{badge.label}</span>}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">{title}</span>
        {term && <span className="font-mono text-[11px] text-fg-subtle">{term}</span>}
      </span>
      <span className="text-[13px] leading-5 text-fg-muted">{body}</span>
      <span className="mt-auto inline-flex items-center gap-1 pt-1 text-[13px] font-medium text-highlight">
        {openLabel}
        <span aria-hidden className="transition-transform duration-300 ease-soft group-hover:translate-x-0.5">→</span>
      </span>
    </button>
  );
}
