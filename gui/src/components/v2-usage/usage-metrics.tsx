import type { ReactNode } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatTokens } from "../../format-tokens";
import { formatEstimatedUsdValue as formatUsdEstimate } from "../../intl-formatters";
import { IconInfo } from "../../icons";
import { formatPct, hasThroughput, throughputTitle, type UsageDay, type UsageSummaryTotals } from "./usage-model";

/*
 * The four figures people open Usage for, as one hairline-divided stat group with a sparkline
 * each (React Bits Pro dashboard-1), and the secondary counts on one quiet line below it.
 * Every sparkline is drawn from the same `days` the activity chart uses, so they always agree.
 */

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every(value => value <= 0)) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => `${((index / (values.length - 1)) * 100).toFixed(2)},${(92 - ((value - min) / span) * 84).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"
      className="hidden h-7 w-14 shrink-0 text-fg-subtle @min-[13rem]:block">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.75}
        vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A hint people can reach by keyboard as well as by pointer: the button carries the sentence. */
export function UsageHint({ text }: { text: string }) {
  return (
    <button type="button" aria-label={text} title={text}
      className="ui-v2 inline-grid size-5 shrink-0 cursor-help place-items-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-highlight [&_svg]:size-3.5">
      <IconInfo aria-hidden="true" />
    </button>
  );
}

function Stat({ label, term, hint, value, spark, foot, meter }: {
  label: string;
  term?: string;
  hint?: string;
  value: string;
  spark?: number[];
  foot?: ReactNode;
  meter?: number;
}) {
  return (
    <div className="@container flex min-w-0 flex-col gap-2 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-fg-muted">{label}</span>
        {term && <span className="truncate font-mono text-[11px] text-fg-subtle">{term}</span>}
        {hint && <UsageHint text={hint} />}
      </div>
      <div className="mt-auto flex min-w-0 items-end justify-between gap-3">
        <span className="stat-value truncate text-stat font-semibold tracking-[-0.025em] text-fg tabular-nums">{value}</span>
        {spark && <Sparkline values={spark} />}
      </div>
      {meter !== undefined && (
        <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span className="block h-full rounded-full bg-fg" style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }} />
        </span>
      )}
      {foot && <span className="truncate text-xs text-fg-subtle tabular-nums">{foot}</span>}
    </div>
  );
}

export function UsageSummaryCards({
  summary,
  days,
  activeDays,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  days: UsageDay[];
  activeDays: number;
  locale: Locale;
  t: TFn;
}) {
  const number = new Intl.NumberFormat(locale);
  const excluded = (summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0);
  const hasCost = summary.estimatedCostUsd !== undefined;
  const costSpark = days.some(day => day.estimatedCostUsd !== undefined) ? days.map(day => day.estimatedCostUsd ?? 0) : undefined;
  const cacheReads = summary.cacheReadInputTokens ?? summary.cachedInputTokens;
  const cacheWrites = summary.cacheCreationInputTokens ?? 0;
  const facts: { label: string; value: string; title?: string }[] = [
    { label: t("usage.card.measured"), value: number.format(summary.measuredRequests) },
    { label: t("usage.card.cachedTokens"), value: formatTokens(cacheReads, locale), title: t("usage.card.cachedTokensHint") },
    ...(cacheWrites > 0 ? [{ label: t("usage.card.cacheWriteTokens"), value: formatTokens(cacheWrites, locale) }] : []),
    {
      label: t("usage.col.tokPerSec"),
      value: hasThroughput(summary.throughputTokensPerSec) ? summary.throughputTokensPerSec.toFixed(1) : t("usage.unavailable"),
      title: throughputTitle(summary, t),
    },
    { label: t("usage.card.activeDays"), value: number.format(activeDays) },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="@container overflow-hidden rounded-[12px] bg-surface ring-1 ring-line" role="group" aria-label={t("usage.section.overview")}>
        <div className="grid grid-cols-1 *:-mt-px *:-ml-px *:border-t *:border-l *:border-line @md:grid-cols-2 @3xl:grid-cols-4">
          <Stat
            label={t("usage.card.requests")}
            value={number.format(summary.requests)}
            spark={days.map(day => day.requests)}
            foot={t("usageV2.activeDaysFoot", { days: number.format(activeDays) })}
          />
          <Stat
            label={t("usage.card.totalTokens")}
            value={formatTokens(summary.totalTokens, locale)}
            spark={days.map(day => day.totalTokens)}
            foot={t("usageV2.tokensSplit", { input: formatTokens(summary.inputTokens, locale), output: formatTokens(summary.outputTokens, locale) })}
          />
          <Stat
            label={t("usageV2.costLabel")}
            term={t("usage.col.apiListPrice")}
            hint={`${t("usage.cost.total")}. ${t("usage.cost.disclaimer")}`}
            value={hasCost ? formatUsdEstimate(summary.estimatedCostUsd ?? 0, locale) : t("usage.unavailable")}
            {...(hasCost && costSpark ? { spark: costSpark } : {})}
            foot={excluded > 0 ? t("usage.cost.unpricedNote", { count: excluded }) : t(hasCost ? "usageV2.costFoot" : "usageV2.costMissing")}
          />
          <Stat
            label={t("usage.card.coverage")}
            hint={t("usageV2.coverageHint")}
            value={formatPct(summary.coverageRatio)}
            meter={summary.coverageRatio}
            foot={t("usageV2.coverageFoot", { measured: number.format(summary.measuredRequests), requests: number.format(summary.requests) })}
          />
        </div>
      </div>
      <dl className="m-0 flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-[13px]">
        {facts.map(fact => (
          <div key={fact.label} className="usage-fact flex items-baseline gap-1.5" title={fact.title}>
            <dt className="text-fg-subtle">
              {fact.label}
              {/* A `title` reaches a pointer and nothing else, so the sentence is also read. */}
              {fact.title && <span className="sr-only"> ({fact.title})</span>}
            </dt>
            <dd className="usage-fact-value m-0 font-medium text-fg-muted tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
