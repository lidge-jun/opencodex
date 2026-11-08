import type { ReactNode, SyntheticEvent } from "react";
import { StatusDot } from "./surface";
import { cn } from "@/lib/utils";

/*
 * One Codex account as a row of the accounts panel (React Bits Pro `ai-usage-4` per-seat
 * list): state dot, name, a few quiet chips, the one action people come for on the right,
 * and an overflow (⋯) for everything else. The row keeps the `.card` hook the behaviour
 * tests find accounts by; the v2 look comes from `acc-row` in design/pages/accounts.css.
 */
export function AccountRow({ active = false, paused = false, dot, name, sub, chips, actions, more, children }: {
  active?: boolean;
  paused?: boolean;
  dot: "ok" | "warn" | "err" | "idle" | "active";
  name: ReactNode;
  sub?: ReactNode;
  chips?: ReactNode;
  /** Primary and quiet inline actions, rendered before the overflow. */
  actions?: ReactNode;
  /** The overflow disclosure (`AccountMore`). Its summary docks top-right of the row. */
  more?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn("card acc-row", active && "card-active is-active", paused && "is-paused", more ? "has-more" : undefined)}>
      <div className="acc-row__head flex min-w-0 items-start gap-3">
        <span className="flex h-5 items-center"><StatusDot tone={dot} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="acc-row__name min-w-0 truncate text-[14px] leading-5 font-semibold tracking-[-0.005em] text-fg">{name}</strong>
            {chips && <span className="card-badges acc-chips flex flex-wrap items-center gap-1">{chips}</span>}
          </div>
          {sub && <div className="acc-row__sub min-w-0 truncate text-[12.5px] leading-[18px] text-fg-muted">{sub}</div>}
        </div>
        {actions && <div className="acc-row__actions flex shrink-0 flex-wrap items-center justify-end gap-1">{actions}</div>}
      </div>
      {children}
      {more}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/**
 * The overflow: a native disclosure, so the body stays in the DOM (and out of the tab order)
 * while closed. The summary is a bare icon button docked to the row's top-right corner; the
 * body opens full width under the row as an inset settings list.
 */
export function AccountMore({ label, title, open, onToggle, heading, children }: {
  /** Accessible name of the ⋯ button, naming the account. */
  label: string;
  title: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  heading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="codex-account-more acc-more" open={open}
      onToggle={onToggle ? (e: SyntheticEvent<HTMLDetailsElement>) => onToggle(e.currentTarget.open) : undefined}>
      <summary className="acc-more__summary" aria-label={label} title={title}><DotsIcon /></summary>
      <div className="codex-account-more-body acc-settings">
        {heading && <div className="acc-settings__heading">{heading}</div>}
        {children}
      </div>
    </details>
  );
}

/** One line of the overflow list: a label on the left, its control on the right. */
export function AccountSetting({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("acc-setting", className)}>
      {label && <span className="acc-setting__label">{label}</span>}
      <div className="acc-setting__control">{children}</div>
    </div>
  );
}
