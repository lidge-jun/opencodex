import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { IconChevron } from "../../icons";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import type { UsageRangeError, UsageTimeWindow } from "../../usage-time-range";
import type { Range } from "./usage-model";

/*
 * The report's controls on one toolbar row: where the traffic came from, which window, and the
 * rarely needed custom interval as a disclosure at the end of the same row. The applied
 * interval is always printed under the row, so collapsing the form never hides which window
 * the totals cover.
 */

const SEGMENT_BUTTON = "h-[calc(var(--ocx-control-h)-4px)] gap-1.5 px-2.5 text-[13px]";

export function UsageFilters({
  range,
  onRange,
  t,
}: {
  range: Range | null;
  onRange: (range: Range) => void;
  t: TFn;
}) {
  return (
    <>
      <div className="usage-segmented" role="group" aria-label={t("usageV2.rangeLabel")}>
        {(["all", "30d", "7d"] as Range[]).map(choice => {
          const label = choice === "all" ? t("usage.range.available") : t(`usage.range.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              className={cn(`usage-segmented-btn${range === choice ? " active" : ""}`, SEGMENT_BUTTON)}
              aria-label={label}
              aria-pressed={range === choice}
              onClick={() => onRange(choice)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Hub scope: only shown when connected, because only then are there two stores to choose from. */
export function UsageScopeControl({ scope, onScope, t }: { scope: "machine" | "hub"; onScope: (scope: "machine" | "hub") => void; t: TFn }) {
  return (
    <div className="usage-source-row m-0 flex items-center gap-2 text-[13px] text-fg-muted">
      <span>{t("usage.source.connected")}</span>
      <div className="usage-segmented usage-scope-control" role="group" aria-label={t("usage.scope.label")}>
        {(["machine", "hub"] as const).map(choice => (
          <button key={choice} type="button" className={cn(`usage-segmented-btn${scope === choice ? " active" : ""}`, SEGMENT_BUTTON)}
            aria-pressed={scope === choice} onClick={() => onScope(choice)}>
            {t(choice === "machine" ? "usage.scope.machine" : "usage.scope.hub")}
          </button>
        ))}
      </div>
    </div>
  );
}

export function UsageRangeToggle({ open, active, onToggle, t }: { open: boolean; active: boolean; onToggle: () => void; t: TFn }) {
  return (
    <button
      type="button"
      className={cn(
        "usage-range-toggle ui-v2 inline-flex h-[var(--ocx-control-h)] cursor-pointer items-center gap-1.5 rounded-control border-0 px-3 text-[13px] font-medium whitespace-nowrap",
        "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
        active || open
          ? "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line-strong dark:bg-surface-2"
          : "bg-transparent text-fg-muted hover:bg-surface hover:text-fg",
        active && "is-active",
      )}
      aria-expanded={open}
      // The panel is unmounted while closed, so naming it then would leave a dangling IDREF.
      aria-controls={open ? "usage-range-panel" : undefined}
      onClick={onToggle}
    >
      <HugeiconsIcon icon={Calendar03Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{t("usage.range.custom")}</span>
      <IconChevron width={12} height={12} aria-hidden="true" className="usage-range-chevron" />
    </button>
  );
}

export function UsageAppliedWindow({ window, locale, t }: { window: UsageTimeWindow; locale: Locale; t: TFn }) {
  const formatter = new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    second: "2-digit", fractionalSecondDigits: 3, timeZoneName: "short",
  });
  return (
    <p className="usage-range-applied m-0 basis-full text-[13px] text-fg-muted" role="status">
      {t("usage.range.applied", { start: formatter.format(window.since), end: formatter.format(window.until) })}
    </p>
  );
}

function RangeField({ label, value, invalid, describedBy, onChange }: {
  label: string; value: string; invalid: boolean; describedBy: string; onChange: (value: string) => void;
}) {
  return (
    <label className="usage-range-field grid min-w-0 gap-1">
      <span className="field-label m-0 text-xs font-medium text-fg-muted">{label}</span>
      <input className="input h-[var(--ocx-control-h)]" type="datetime-local" step="60" required
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={event => onChange(event.currentTarget.value)} />
    </label>
  );
}

export function UsageRangePanel({
  draft,
  error,
  onDraft,
  onApply,
  onClear,
  t,
}: {
  draft: { since: string; until: string };
  error: UsageRangeError | null;
  onDraft: (patch: Partial<{ since: string; until: string }>) => void;
  onApply: () => void;
  onClear: () => void;
  t: TFn;
}) {
  const describedBy = error ? "usage-range-help usage-range-error" : "usage-range-help";
  return (
    <form id="usage-range-panel"
      className="usage-range-panel m-0 grid w-full max-w-full gap-3 rounded-[12px] border-0 bg-surface p-4 ring-1 ring-line sm:w-max"
      aria-label={t("usage.range.custom")} noValidate
      onSubmit={event => { event.preventDefault(); onApply(); }}>
      <div className="usage-range-fields">
        <RangeField label={t("usage.range.start")} value={draft.since} invalid={error !== null} describedBy={describedBy}
          onChange={since => onDraft({ since })} />
        <RangeField label={t("usage.range.end")} value={draft.until} invalid={error !== null} describedBy={describedBy}
          onChange={until => onDraft({ until })} />
        <Button type="submit" variant="primary" size="sm" className="usage-range-action h-9">{t("usage.range.apply")}</Button>
        <Button type="button" variant="ghost" size="sm" className="usage-range-action h-9" onClick={onClear}>{t("usage.range.clear")}</Button>
      </div>
      <p id="usage-range-help" className="m-0 text-xs text-fg-subtle">{t("usage.range.help")}</p>
      {error && <p id="usage-range-error" role="alert" className="notice notice-err m-0">{t(`usage.range.${error}`)}</p>}
    </form>
  );
}

export function UsageToolbarRow({ children }: { children: ReactNode }) {
  return <div className="usage-range-bar flex flex-wrap items-center gap-2">{children}</div>;
}
