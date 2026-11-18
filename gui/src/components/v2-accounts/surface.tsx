import { useId, type ReactNode } from "react";
import { IconAlert, IconCheck, IconInfo } from "../../icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";

/*
 * v2 building blocks for the Accounts & limits page, after the React Bits Pro Application UI
 * panels (`ai-usage-3`, `dashboard-5`): an outer surface that carries the title and actions,
 * an inset body one step closer to the canvas that carries the rows, hairline rules between
 * rows, quiet neutrals. Colour only ever marks state.
 */

/** Outer panel: title row plus an inset body. `bodyClassName` styles the inset. */
export function Panel({ title, meta, actions, children, className, bodyClassName, labelledBy, as: Tag = "section" }: {
  title?: ReactNode;
  /** Small text beside the title (a count, a status word). */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
  as?: "section" | "div";
}) {
  const fallbackId = useId();
  const headingId = labelledBy ?? fallbackId;
  return (
    <Tag className={cn("acc-panel flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line", className)}
      aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-1.5">
          {title && (
            <h3 id={headingId} className="m-0 flex min-w-0 items-baseline gap-2 text-[14px] leading-5 font-semibold tracking-[-0.01em] text-fg">
              {title}
              {meta !== undefined && meta !== null && <span className="text-[12px] font-normal text-fg-subtle tabular-nums">{meta}</span>}
            </h3>
          )}
          {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn("acc-panel__body flex min-w-0 flex-col rounded-[8px] bg-bg ring-1 ring-line", bodyClassName)}>
        {children}
      </div>
    </Tag>
  );
}

export type BannerTone = "info" | "warn" | "err" | "ok";

const BANNER_ICON: Record<BannerTone, string> = {
  info: "text-fg-muted",
  warn: "text-warning",
  err: "text-danger",
  ok: "text-success",
};

/**
 * Inline status banner (`notifications-5`): a neutral surface, a tone-coloured icon, the
 * message, and its action on the right. The tone never rides on colour alone; the icon shape
 * changes with it.
 */
export function InlineBanner({ tone = "info", children, action, role, className }: {
  tone?: BannerTone;
  children: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  const Icon = tone === "ok" ? IconCheck : tone === "info" ? IconInfo : IconAlert;
  return (
    <div role={role} className={cn(
      "acc-banner flex min-w-0 items-start gap-2.5 rounded-[10px] bg-raised px-3 py-2.5 text-[13px] leading-[18px] text-fg ring-1 ring-line",
      tone === "warn" && "acc-banner--warn",
      tone === "err" && "acc-banner--err",
      className,
    )}>
      <span className={cn("mt-px shrink-0 [&_svg]:size-4", BANNER_ICON[tone])} aria-hidden="true"><Icon /></span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {action && <div className="-my-1 flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
    </div>
  );
}

/** A small round state mark. */
export function StatusDot({ tone }: { tone: "ok" | "warn" | "err" | "idle" | "active" }) {
  return (
    <span aria-hidden="true" className={cn(
      "inline-block size-2 shrink-0 rounded-full",
      tone === "ok" && "bg-success",
      tone === "warn" && "bg-warning",
      tone === "err" && "bg-danger",
      tone === "idle" && "bg-fg-subtle",
      tone === "active" && "bg-fg",
    )} />
  );
}

/*
 * The "?" beside a setting (state from `useHelp` in ./use-help): the plain state stays on
 * screen, the explanation opens below. The region is `hidden`, not unmounted, so its text
 * stays in the document for find-in-page and for the copy contracts the tests read.
 */

export function HelpButton({ open, controls, name, onToggle, className }: {
  open: boolean;
  controls: string;
  /** What the explanation is about; read as "About: <name>". */
  name: string;
  onToggle: () => void;
  className?: string;
}) {
  const t = useT();
  const label = t("accountsV2.about", { name });
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} aria-label={label} title={label} onClick={onToggle}
      className={cn(
        "acc-help-btn ui-v2 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-fg-subtle transition-colors",
        "hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        open && "bg-surface-2 text-fg",
        "[&_svg]:size-[15px]",
        className,
      )}>
      <IconInfo aria-hidden="true" />
    </button>
  );
}

export function HelpRegion({ id, open, children, className }: { id: string; open: boolean; children: ReactNode; className?: string }) {
  return (
    <div id={id} hidden={!open} className={cn(
      "acc-help rounded-[8px] bg-surface-2/60 px-3 py-2.5 text-[13px] leading-[19px] text-fg-muted",
      className,
    )}>
      {children}
    </div>
  );
}
