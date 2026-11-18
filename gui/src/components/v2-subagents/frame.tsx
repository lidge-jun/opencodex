/*
 * v2 building blocks for the Subagents page, after the React Bits Application UI settings
 * forms (`settings-form-1`, `settings-form-3`) and the editable plan list (`agent-plan-2`):
 * a quiet panel with a head, an inset body of ruled rows, and an optional foot for status
 * and actions. Explanations stay one line; the rest opens from a "?" next to the title.
 */
import { useId, type ReactNode, type SVGProps } from "react";
import { useT } from "../../i18n/shared";
import { Tooltip } from "../../ui";
import { cn } from "@/lib/utils";

export function QuestionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.85.85c0 1.65-2.45 2.2-2.45 3.6" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** A focusable "?" that shows a short explanation on hover or focus. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const t = useT();
  return (
    <span className="inline-flex shrink-0 items-center text-fg-subtle transition-colors hover:text-fg-muted">
      <Tooltip content={children} side="bottom" maxWidth={380}>
        <QuestionIcon width={15} height={15} aria-hidden="true" />
        <span className="sr-only">{t("subagentsV2.moreAbout", { label })}</span>
      </Tooltip>
    </span>
  );
}

interface FrameProps {
  id?: string;
  title: ReactNode;
  /** One line under the title. Longer text goes behind `help`. */
  lede?: ReactNode;
  /** Items beside the title: a count, a "?" button. */
  meta?: ReactNode;
  /** Controls on the right of the head. */
  actions?: ReactNode;
  /** Opened "?" panel, rendered under the head. */
  below?: ReactNode;
  children?: ReactNode;
  className?: string;
  headClassName?: string;
  busy?: boolean;
}

/** Panel with a head; children are the inset body and an optional foot. */
export function Frame({ id, title, lede, meta, actions, below, children, className, headClassName, busy }: FrameProps) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      aria-busy={busy}
      className={cn("flex min-w-0 scroll-mt-[72px] flex-col rounded-[12px] bg-surface ring-1 ring-inset ring-line", className)}
    >
      <div className={cn("flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 pb-3", headClassName)}>
        <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 id={titleId} className="m-0 truncate text-[14px] leading-5 font-semibold text-fg">{title}</h3>
            {meta}
          </div>
          {lede && <p className="m-0 text-[13px] leading-5 text-fg-muted">{lede}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>}
      </div>
      {below && <div className="px-4 pb-3">{below}</div>}
      {children}
    </section>
  );
}

/** The inset body: a raised sheet one pixel in from the panel, rows ruled by hairlines. */
export function FrameBody({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "ol" | "ul" }) {
  return (
    <Tag
      className={cn(
        "m-1 mt-0 flex min-w-0 list-none flex-col divide-y divide-line overflow-hidden rounded-[8px] bg-raised p-0 shadow-sm ring-1 ring-line",
        "[&:has(+*)]:mb-0",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Status on the left, actions on the right. */
export function FrameFoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[13px] text-fg-muted", className)}>
      {children}
    </div>
  );
}

/** One settings row: plain label and one-line hint on the left, control on the right. */
export function SettingRow({
  label, hint, help, control, children, className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  help?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-4 py-3.5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[14px] leading-5 font-medium text-fg">{label}{help}</span>
          {hint && <span className="text-[13px] leading-5 text-fg-muted">{hint}</span>}
        </div>
        {control && <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** Small neutral count pill beside a title. */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] font-medium text-fg-muted tabular-nums">{children}</span>
  );
}
