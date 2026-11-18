import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconTile, StateBadge, Tag, type Tone } from "./primitives";

/*
 * One way to bring OpenCodex back after a restart, as a card (React Bits `integrations-1`
 * marketplace tile): icon plate and state badge on top, the plain name with its product term
 * under it, one sentence of what it does, and the one action it needs at the bottom.
 */
export function OptionCard({ icon, title, term, tag, badge, children, actions, option }: {
  icon: ReactNode;
  title: ReactNode;
  /** The original product term, small, so docs and CLI names still connect. */
  term?: ReactNode;
  tag?: ReactNode;
  badge: { tone: Tone; label: ReactNode };
  children: ReactNode;
  actions?: ReactNode;
  /** Names the card for tests and find-in-page (`data-option`). */
  option: string;
}) {
  return (
    <article data-option={option} className="startup-option flex min-w-0 flex-col gap-3 rounded-[12px] bg-surface p-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <IconTile>{icon}</IconTile>
        <StateBadge tone={badge.tone}>{badge.label}</StateBadge>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 className="m-0 flex flex-wrap items-center gap-2 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
          {title}
          {tag && <Tag>{tag}</Tag>}
        </h4>
        {term && <span className="text-[12px] leading-4 text-fg-subtle">{term}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-5 text-fg-muted">{children}</div>
      {actions && <div className={cn("mt-auto flex flex-wrap items-center gap-2 pt-1")}>{actions}</div>}
    </article>
  );
}
