import { useId, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { IconAlert, IconCheck, IconInfo } from "../../icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";

/*
 * v2 building blocks shared by the Startup protection, Remote Link and Remote Workspace pages,
 * after the React Bits Pro Application UI panels: an outer surface that carries the heading,
 * an inset body one step closer to the canvas, hairline rules, quiet neutrals. Colour only
 * ever marks state, and never alone: a badge carries a word, a banner an icon shape.
 */

export type Tone = "ok" | "warn" | "err" | "neutral";

const BADGE_TONE: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  err: "bg-danger-soft text-danger",
  neutral: "bg-surface-2 text-fg-muted",
};

/** A state word in a soft pill with a dot (`integrations-6` status words). */
export function StateBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      "startup-badge inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] leading-4 font-semibold whitespace-nowrap",
      BADGE_TONE[tone],
      className,
    )}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A quiet tag beside a title ("Recommended", "Optional"). */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-5 items-center rounded-[6px] px-1.5 text-[11px] font-medium text-fg-muted ring-1 ring-line-strong ring-inset">{children}</span>;
}

/** Outer panel with a title row and an inset body (`dashboard-5`). */
export function Panel({ title, meta, description, actions, icon, children, className, bodyClassName, id }: {
  title?: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const fallback = useId();
  const headingId = id ?? fallback;
  return (
    <section aria-labelledby={title ? headingId : undefined}
      className={cn("flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-3">
          {icon && <IconTile>{icon}</IconTile>}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title && (
              <h3 id={headingId} className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
                {title}
                {meta !== undefined && meta !== null && <span className="text-[12px] font-normal text-fg-subtle tabular-nums">{meta}</span>}
              </h3>
            )}
            {description && <p className="m-0 text-[13px] leading-5 text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{actions}</div>}
        </div>
      )}
      {children !== undefined && children !== null && children !== false && (
        <div className={cn("flex min-w-0 flex-col rounded-[8px] bg-bg ring-1 ring-line", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/** The square icon plate cards lead with. */
export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(
      "grid size-9 shrink-0 place-items-center rounded-[10px] bg-raised text-fg shadow-sm ring-1 ring-line [&_svg]:size-[18px]",
      className,
    )}>{children}</span>
  );
}

const BANNER_ICON: Record<Exclude<Tone, "neutral">, string> = { ok: "text-success", warn: "text-warning", err: "text-danger" };

/** Inline status banner (`notifications-5`): neutral surface, tone-coloured icon, action on the right. */
export function Banner({ tone, children, action, role = "status", className }: {
  tone: Exclude<Tone, "neutral"> | "info";
  children: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  const Icon = tone === "ok" ? IconCheck : tone === "info" ? IconInfo : IconAlert;
  return (
    <div role={role} className={cn(
      "flex min-w-0 items-start gap-2.5 rounded-[10px] bg-raised px-3 py-2.5 text-[13px] leading-[19px] text-fg ring-1 ring-line",
      tone === "warn" && "bg-warning-soft ring-warning/25",
      tone === "err" && "bg-danger-soft ring-danger/25",
      className,
    )}>
      <span aria-hidden="true" className={cn("mt-px shrink-0 [&_svg]:size-4", tone === "info" ? "text-fg-muted" : BANNER_ICON[tone])}><Icon /></span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {action && <div className="-my-1 flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
    </div>
  );
}

/** A bare icon button that shows a soft plate only on hover. */
export function IconButton({ label, onClick, children, disabled, tone = "neutral", className }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: "neutral" | "danger";
  className?: string;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={cn(
        "ui-v2 inline-grid size-[var(--ocx-control-h-sm)] shrink-0 cursor-pointer place-items-center rounded-[8px] text-fg-muted transition-colors",
        "hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        tone === "danger" && "hover:bg-danger-soft hover:text-danger",
        className,
      )}>
      {children}
    </button>
  );
}

/** Copy-to-clipboard icon button; the icon turns into a tick while the copy is fresh. */
export function CopyButton({ copied, onCopy, className }: { copied: boolean; onCopy: () => void; className?: string }) {
  const t = useT();
  return (
    <IconButton label={t(copied ? "startup.copied" : "startup.copy")} onClick={onCopy} className={className}>
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={16} strokeWidth={1.8} aria-hidden="true" className={copied ? "text-success" : undefined} />
    </IconButton>
  );
}

/** One command in a copy list: a plain-words label, the command in mono, a copy button. */
export function CommandRow({ label, command, copied, onCopy }: { label?: ReactNode; command: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {label && <span className="text-[13px] leading-5 font-medium text-fg">{label}</span>}
        <code className="block min-w-0 font-mono text-[12.5px] leading-5 text-fg-muted [overflow-wrap:anywhere]">{command}</code>
      </div>
      <CopyButton copied={copied} onCopy={onCopy} />
    </div>
  );
}

/** The "?" beside a heading (state from `useHelp` in ./use-help). */
export function HelpButton({ open, controls, name, onToggle }: { open: boolean; controls: string; name: string; onToggle: () => void }) {
  const t = useT();
  const label = t("startupV2.about", { name });
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} aria-label={label} title={label} onClick={onToggle}
      className={cn(
        "ui-v2 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-fg-subtle transition-colors",
        "hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight [&_svg]:size-[15px]",
        open && "bg-surface-2 text-fg",
      )}>
      <IconInfo aria-hidden="true" />
    </button>
  );
}

/** The help text is `hidden`, not unmounted, so find-in-page and the copy contracts still see it. */
export function HelpRegion({ id, open, children, className }: { id: string; open: boolean; children: ReactNode; className?: string }) {
  return <div id={id} hidden={!open} className={cn("rounded-[8px] bg-surface-2/60 px-3 py-2.5 text-[13px] leading-[19px] text-fg-muted", className)}>{children}</div>;
}

/** Page header: the title, an optional sentence under it, and the page's actions. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="m-0 text-title font-semibold tracking-[-0.025em] text-fg">{title}</h2>
        {subtitle && <p className="m-0 max-w-[68ch] text-[14px] leading-5 text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
