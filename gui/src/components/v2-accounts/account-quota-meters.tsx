import { Fragment, type ReactNode } from "react";
import type { AccountQuota } from "../../codex-quota-utils";
import { useI18n, type TFn } from "../../i18n/shared";
import { buildQuotaRows, formatResetFuture, isQuotaExhausted, isQuotaWarn } from "../QuotaBars";
import { cn } from "@/lib/utils";

/*
 * Remaining-quota meters for one Codex account (React Bits Pro `dashboard-5` / `ai-usage-3`
 * meter rows): window name and what is LEFT on one line, a thin track whose fill is what
 * is left, and when it resets underneath. The account question is "how much is left", so
 * the meter reads that way; the used share stays in the tooltip and the accessible value.
 *
 * Rows come from the same `buildQuotaRows` the other quota surfaces use, so window order,
 * plan normalisation and custom windows stay identical. `afterWeekly` keeps the credits slot
 * right after the weekly window, as before.
 */
export default function AccountQuotaMeters({ quota, plan, threshold, t, pending = false, afterWeekly, size = "row" }: {
  quota: AccountQuota | null;
  plan?: string | null;
  threshold: number;
  t: TFn;
  /** Quota still unknown (soft /accounts before WHAM): reserve the meter slot. */
  pending?: boolean;
  afterWeekly?: ReactNode;
  size?: "row" | "hero";
}) {
  const { locale } = useI18n();
  const rows = buildQuotaRows(quota, plan, t);
  const grid = size === "hero"
    ? "grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2"
    : "grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-6 gap-y-3";

  if (rows.length === 0) {
    if (!pending) {
      return afterWeekly ? <div className={cn("acc-meters codex-account-quota-slot grid", grid)}>{afterWeekly}</div> : null;
    }
    return (
      <div className={cn("acc-meters acc-meters--pending quota-compact--pending grid", grid)} aria-busy="true" role="status">
        {[0, 1].map(index => (
          <div key={index} className="flex flex-col gap-1.5" aria-hidden="true">
            <span className="flex justify-between gap-3">
              <span className="acc-skel h-3 w-10 rounded-full" />
              <span className="acc-skel h-3 w-14 rounded-full" />
            </span>
            <span className="acc-skel h-1.5 w-full rounded-full" />
          </div>
        ))}
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }

  return (
    <div className={cn("acc-meters codex-account-quota-slot grid", grid)}>
      {rows.map(row => {
        const used = Math.max(0, Math.min(100, row.percent));
        const left = Math.max(0, Math.round(100 - used));
        const exhausted = isQuotaExhausted(used);
        const warn = !exhausted && isQuotaWarn(used, threshold);
        const reset = formatResetFuture(row.resetAt, t, locale);
        const usedLabel = t("quota.usedPercent", { pct: Math.round(used) });
        return (
          <Fragment key={row.id}>
            <div className={cn("acc-meter flex min-w-0 flex-col gap-1.5", warn && "is-warn", exhausted && "is-exhausted")} title={usedLabel}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[12px] leading-4 text-fg-muted">{row.limitLabel}</span>
                <span className={cn(
                  "shrink-0 tabular-nums",
                  size === "hero" ? "text-[15px] leading-5 font-semibold" : "text-[13px] leading-4 font-medium",
                  exhausted ? "text-danger" : warn ? "text-warning" : "text-fg",
                )}>
                  {exhausted ? t("quota.limitReached") : t("accountsV2.left", { pct: left })}
                </span>
              </span>
              <meter aria-label={row.limitLabel} min={0} max={100} value={left}
                aria-valuetext={`${t("accountsV2.left", { pct: left })} · ${usedLabel}`}
                className={cn(
                  "acc-quota-meter",
                  size === "hero" ? "h-2" : "h-1.5",
                  exhausted ? "[--acc-meter-fill:var(--color-danger)]" : warn ? "[--acc-meter-fill:var(--color-warning)]" : undefined,
                )} />
              {reset && <span className="truncate text-[11.5px] leading-4 text-fg-subtle tabular-nums">{reset}</span>}
            </div>
            {row.windowKey === "weekly" && afterWeekly}
          </Fragment>
        );
      })}
      {!rows.some(row => row.windowKey === "weekly") && afterWeekly}
    </div>
  );
}
