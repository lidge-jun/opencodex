import { useId, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { HelpCircleIcon } from "@hugeicons/core-free-icons";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";

/*
 * Settings building blocks for the expert pages (Proxy details, Advisor), after the React Bits
 * Pro settings forms: a titled frame with a one-line lede, an inset body of ruled rows, and
 * each row as label + one-line hint on the left and its control on the right. Long policy
 * text stays one click away behind the row's "?" instead of filling the page.
 *
 * These hold v1 controls (the app's Select, .switch, .btn), so no container here carries
 * `ui-v2`: its reset would outrank the bridge that paints those controls.
 */

export function SettingsSection({ id, title, lede, children, className }: {
  id: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cn("pv2-section min-w-0 scroll-mt-6 rounded-card bg-surface p-1", className)}>
      <header className="flex flex-col gap-0.5 px-4 pt-3 pb-3">
        <h3 id={headingId} className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg">{title}</h3>
        {lede && <p className="m-0 max-w-[70ch] text-[13px] leading-[18px] text-fg-muted">{lede}</p>}
      </header>
      <div className="pv2-section-body flex min-w-0 flex-col divide-y divide-line rounded-[12px] bg-raised ring-1 ring-line">
        {children}
      </div>
    </section>
  );
}

/** The bare "?" beside a label: no plate at rest, a soft one on hover. */
export function HelpButton({ label, expanded, controls, onClick, buttonRef, popup }: {
  label: string;
  expanded: boolean;
  controls: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** "dialog" when the button opens one of the page's help dialogs instead of an inline region. */
  popup?: "dialog";
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={popup}
      className={cn(
        "pv2-help inline-grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-fg-subtle",
        "transition-colors duration-150 hover:bg-surface-2 hover:text-fg",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        expanded && "bg-surface-2 text-fg",
      )}
    >
      <HugeiconsIcon icon={HelpCircleIcon} size={15} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  /** Wires a native <label> to the control (Select ids, inputs). Without it the label is text. */
  labelFor?: string;
  labelId?: string;
  /** One plain line under the label. */
  hint?: ReactNode;
  /** Longer explanation, shown inline when the row's "?" is pressed. */
  details?: ReactNode;
  /** A "?" that opens something else (one of the page's help dialogs) instead of `details`. */
  help?: ReactNode;
  /** Small trailing marker after the label (a badge, a code chip). */
  badge?: ReactNode;
  control?: ReactNode;
  /** Full-width content below the row: notices, sub-options, status lines. */
  children?: ReactNode;
  /** Stack the control under the copy at every width (wide controls such as a source list). */
  stacked?: boolean;
  /** Keep a small control (a switch) on the right even on a phone. */
  inline?: boolean;
  className?: string;
  busy?: boolean;
}

export function SettingsRow({ label, labelFor, labelId, hint, details, help, badge, control, children, stacked, inline, className, busy }: SettingsRowProps) {
  const t = useT();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const labelText = typeof label === "string" ? label : undefined;
  const labelClass = "m-0 text-[14px] leading-5 font-medium text-fg";
  return (
    <div className={cn("pv2-row flex min-w-0 flex-col gap-3 px-4 py-3.5", className)} aria-busy={busy || undefined}>
      <div className={cn("flex min-w-0 flex-col gap-3", !stacked && "sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        inline && "flex-row items-center justify-between gap-4")}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-h-[22px] flex-wrap items-center gap-x-1.5 gap-y-1">
            {labelFor
              ? <label htmlFor={labelFor} id={labelId} className={labelClass}>{label}</label>
              : <span id={labelId} className={labelClass}>{label}</span>}
            {details && (
              <HelpButton
                label={labelText ? t("proxyV2.detailsFor", { name: labelText }) : t("proxyV2.details")}
                expanded={open}
                controls={detailsId}
                onClick={() => setOpen(value => !value)}
              />
            )}
            {help}
            {badge}
          </div>
          {hint && <p className="m-0 max-w-[62ch] text-[13px] leading-[18px] text-fg-muted">{hint}</p>}
          {details && (
            <div id={detailsId} hidden={!open} className="pv2-details mt-1.5 max-w-[68ch] text-[13px] leading-[19px] text-fg-muted">
              {details}
            </div>
          )}
        </div>
        {control && (
          <div className={cn("pv2-row-control flex min-w-0 flex-wrap items-center gap-2", !stacked && "sm:shrink-0 sm:justify-end", inline && "shrink-0")}>
            {control}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
