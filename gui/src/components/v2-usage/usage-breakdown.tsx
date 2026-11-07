import type { ReactNode } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatTokens } from "../../format-tokens";
import { formatEstimatedUsdValue as formatUsdEstimate } from "../../intl-formatters";
import { formatProviderDisplayName } from "../../provider-icons";
import { modelLabel } from "../../model-display";
import { IconSearch } from "../../icons";
import { cn } from "@/lib/utils";
import {
  cacheHitRateTitle, formatOptionalPct, formatOptionalTokens, formatPct, hasThroughput, throughputTitle,
  type UsageApp, type UsageModel, type UsageProvider, type UsageSummaryTotals,
} from "./usage-model";

/*
 * Breakdowns by model and provider: plain tables with the share drawn inline, so the long tail
 * reads at a glance before anyone compares a column. Every column the old report had is still
 * here; the identity and the three comparison figures lead, the per-request detail follows.
 */

type UsageCostRow = Pick<UsageModel, "estimatedCostUsd" | "pricedRequests" | "unpricedRequests">;

/**
 * Renders a row's API list-price estimate with explicit pricing coverage.
 * Newer proxies return the coverage fields even when every request is
 * unpriced; older proxies have none of them, so their cells stay unavailable
 * rather than making an unknown amount look free.
 *
 * The coverage caption is `usage-cost-note`, which the stylesheet makes a block so it always
 * begins the line under the amount instead of trailing it and folding mid-phrase. Its leading
 * space stays in the markup: a block box drops leading white space when it lays out, so the cell
 * reads the same either way, and the space keeps the rendered text exactly what it was for
 * anything reading the cell as one string.
 */
function UsageListPrice({ row, locale, t }: { row: UsageCostRow; locale: Locale; t: TFn }) {
  const hasPriceData = row.estimatedCostUsd !== undefined
    || row.pricedRequests !== undefined
    || row.unpricedRequests !== undefined;
  if (!hasPriceData) return <span className="muted">—</span>;

  const excludedRequests = row.unpricedRequests ?? 0;
  const excludedCaption = t(
    excludedRequests === 1 ? "usage.cost.excludedOne" : "usage.cost.excluded",
    { count: excludedRequests },
  );
  if (row.estimatedCostUsd === undefined) {
    return (
      <>
        <span className="muted">—</span>
        {excludedRequests > 0 && (
          <span className="muted text-caption usage-cost-note"> {excludedCaption}</span>
        )}
      </>
    );
  }
  return (
    <>
      <span className="mono">{formatUsdEstimate(row.estimatedCostUsd ?? 0, locale)}</span>
      {excludedRequests > 0 && (
        <span className="muted text-caption usage-cost-note"> {excludedCaption}</span>
      )}
    </>
  );
}

/** Share of the window's tokens: a bar and the number, so the bar is never the only signal. */
function ShareBar({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="flex items-center gap-2.5">
      <div className="usage-bar h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="usage-bar-fill h-full rounded-full bg-fg/75" style={{ width: `${Math.round(clamped * 100)}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs text-fg-muted tabular-nums">{formatPct(clamped)}</span>
    </div>
  );
}

/** One report section: a titled card that is also the anchor the page links to. */
export function UsageWorkspaceSection({
  title,
  titleId,
  meta,
  actions,
  children,
}: {
  title: string;
  titleId: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="usw-section flex min-w-0 flex-col gap-3 rounded-[12px] bg-surface p-5 ring-1 ring-line" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={titleId} className="h-section m-0 text-[15px] leading-6 font-semibold tracking-normal text-fg">{title}</h3>
          {meta && <span className="text-[13px] text-fg-subtle tabular-nums">{meta}</span>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function UsageModelsTable({
  models,
  totalModels,
  modelQuery,
  onModelQuery,
  locale,
  t,
}: {
  models: UsageModel[];
  totalModels: number;
  modelQuery: string;
  onModelQuery: (query: string) => void;
  locale: Locale;
  t: TFn;
}) {
  const searchLabel = t("usage.search.models");
  const listPriceDisclaimerId = "usage-models-list-price-disclaimer";
  const unavailable = t("usage.unavailable");
  return (
    <UsageWorkspaceSection
      title={t("usage.section.models")}
      titleId="usage-models-title"
      meta={String(totalModels)}
      actions={(
        <label className="usw-section-toolbar relative m-0 flex w-full max-w-60 items-center">
          <span className="pointer-events-none absolute left-2.5 text-fg-subtle [&_svg]:size-3.5" aria-hidden="true"><IconSearch /></span>
          <input
            className="input h-[var(--ocx-control-h)] w-full rounded-control pl-8 text-[13px]"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={modelQuery}
            onChange={event => onModelQuery(event.target.value)}
          />
        </label>
      )}
    >
      <div className="tbl-wrap usage-v2-tbl">
        {/*
          Identity, then the three figures a reader compares models on, then the detail behind
          them. The pair in front is also the pair the stylesheet pins while the rest scrolls
          sideways, so their position here is load-bearing rather than cosmetic.
        */}
        <table className="tbl usage-models-tbl">
          <thead>
            <tr>
              <th>{t("logs.col.model")}</th>
              <th>{t("logs.col.provider")}</th>
              <th>{t("usage.col.share")}</th>
              <th className="num">{t("usage.col.tokens")}</th>
              <th className="num" aria-describedby={listPriceDisclaimerId}>{t("usage.col.apiListPrice")}</th>
              <th className="num">{t("usage.col.requests")}</th>
              <th className="num">{t("usage.col.measured")}</th>
              <th className="num">{t("usage.col.inputTokens")}</th>
              <th className="num">{t("usage.col.outputTokens")}</th>
              <th className="num">{t("usage.col.tokPerSec")}</th>
              <th className="num">{t("usage.col.cacheHits")}</th>
              <th className="num">{t("usage.col.cacheWrites")}</th>
              <th className="num">{t("usage.col.cacheHitRate")}</th>
            </tr>
          </thead>
          <tbody>
            {models.map(model => {
              const providerName = formatProviderDisplayName(model.provider, t);
              const cacheCoverage = cacheHitRateTitle(model, locale, t);
              const throughputNote = throughputTitle(model, t);
              return (
                <tr key={`${model.provider}/${model.model}`}>
                  {/* Both pinned columns are width-capped, so carry the full value in a tooltip. */}
                  <td className="mono font-medium text-fg" title={model.model}>{modelLabel(model.model)}</td>
                  <td className="muted" title={providerName}>{providerName}</td>
                  <td><ShareBar ratio={model.shareRatio} /></td>
                  <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
                  <td className="num"><UsageListPrice row={model} locale={locale} t={t} /></td>
                  <td className="num">{model.requests}</td>
                  <td className="num">{model.measuredRequests}</td>
                  <td className="num mono">{formatTokens(model.inputTokens, locale)}</td>
                  <td className="num mono">{formatTokens(model.outputTokens, locale)}</td>
                  <td className="num mono" title={throughputNote}>
                    <span className="usage-hit-rate">
                      {hasThroughput(model.throughputTokensPerSec) ? `${model.throughputTokensPerSec.toFixed(1)} tok/s` : unavailable}
                    </span>
                    {hasThroughput(model.throughputTokensPerSec) && <span className="sr-only">{throughputNote}</span>}
                  </td>
                  <td className="num mono">{formatOptionalTokens(model.cacheReadInputTokens ?? model.cachedInputTokens, locale, unavailable)}</td>
                  <td className="num mono">{formatOptionalTokens(model.cacheCreationInputTokens, locale, unavailable)}</td>
                  {/*
                    The summary already averages only the input tokens whose cache detail was
                    reported, so whatever number it returns has a basis. Suppressing it unless that
                    basis covered the row's whole input is what hid a measured hit rate behind an em
                    dash for every provider that leaves some requests unreported; the coverage is a
                    note on the cell now, not a gate.
                  */}
                  <td className="num mono" title={cacheCoverage}>
                    <span className="usage-hit-rate">{formatOptionalPct(model.cacheHitRate, unavailable)}</span>
                    {/* A `title` reaches a pointer and nothing else, so the sentence is also read. */}
                    {cacheCoverage !== undefined && <span className="sr-only">{cacheCoverage}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p id={listPriceDisclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
    </UsageWorkspaceSection>
  );
}

export function UsageAppsTable({ apps, locale, t }: { apps?: UsageApp[]; locale: Locale; t: TFn }) {
  const names: Record<UsageApp["client"], string> = {
    codex: "Codex", claude_code: "Claude Code", claude_desktop: "Claude Desktop", grok: "Grok", opencode: "OpenCode", aside: "Aside",
    other: t("usageV2.other"), unknown: t("usageV2.unknown"), unclassified: t("usageV2.unclassified"),
  };
  const disclaimerId = "usage-apps-list-price-disclaimer";
  return (
    <UsageWorkspaceSection title={t("usageV2.apps")} titleId="usage-apps-title" meta={apps ? String(apps.length) : undefined}>
      {!apps || apps.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-muted" role="status">{t(apps ? "usageV2.appsEmpty" : "usageV2.appsUnavailable")}</p>
      ) : <>
        <div className="tbl-wrap usage-v2-tbl">
          <table className="tbl">
            <thead><tr>
              <th>{t("usageV2.app")}</th><th>{t("usage.col.share")}</th>
              <th className="num">{t("usage.col.tokens")}</th>
              <th className="num" aria-describedby={disclaimerId}>{t("usage.col.apiListPrice")}</th>
              <th className="num">{t("usage.col.requests")}</th><th className="num">{t("usage.col.measured")}</th>
            </tr></thead>
            <tbody>{apps.toSorted((a, b) => b.totalTokens - a.totalTokens).map(app => (
              <tr key={app.client}>
                <td className="font-medium text-fg">{names[app.client]}</td>
                <td><ShareBar ratio={app.shareRatio} /></td>
                <td className="num mono">{formatTokens(app.totalTokens, locale)}</td>
                <td className="num"><UsageListPrice row={app} locale={locale} t={t} /></td>
                <td className="num">{app.requests}</td><td className="num">{app.measuredRequests}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p id={disclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
      </>}
    </UsageWorkspaceSection>
  );
}

export function UsageProvidersTable({ providers, locale, t }: { providers: UsageProvider[]; locale: Locale; t: TFn }) {
  const unavailable = t("usage.unavailable");
  const listPriceDisclaimerId = "usage-providers-list-price-disclaimer";
  return (
    <UsageWorkspaceSection title={t("usage.section.providers")} titleId="usage-providers-title" meta={String(providers.length)}>
      <div className="tbl-wrap usage-v2-tbl">
        <table className="tbl usage-providers-tbl">
          <thead>
            <tr>
              <th>{t("logs.col.provider")}</th>
              <th>{t("usage.col.share")}</th>
              <th className="num">{t("usage.col.tokens")}</th>
              <th className="num" aria-describedby={listPriceDisclaimerId}>{t("usage.col.apiListPrice")}</th>
              <th className="num">{t("usage.col.requests")}</th>
              <th className="num">{t("usage.col.measured")}</th>
              <th className="num">{t("usage.col.tokPerSec")}</th>
            </tr>
          </thead>
          <tbody>
            {providers.map(provider => (
              <tr key={provider.provider}>
                <td className="font-medium text-fg">{formatProviderDisplayName(provider.provider, t)}</td>
                <td><ShareBar ratio={provider.shareRatio} /></td>
                <td className="num mono">{formatTokens(provider.totalTokens, locale)}</td>
                <td className="num"><UsageListPrice row={provider} locale={locale} t={t} /></td>
                <td className="num">{provider.requests}</td>
                <td className="num">{provider.measuredRequests}</td>
                <td className="num mono" title={throughputTitle(provider, t)}>
                  <span className="usage-hit-rate">
                    {hasThroughput(provider.throughputTokensPerSec) ? `${provider.throughputTokensPerSec.toFixed(1)} tok/s` : unavailable}
                  </span>
                  {hasThroughput(provider.throughputTokensPerSec) && <span className="sr-only">{throughputTitle(provider, t)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p id={listPriceDisclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
    </UsageWorkspaceSection>
  );
}

/**
 * How the request count splits by what is known about its tokens, as one stacked meter
 * (React Bits Pro dashboard-5) with the exact counts beside each swatch.
 */
export function UsageCoveragePanel({ summary, locale, t }: { summary: UsageSummaryTotals; locale: Locale; t: TFn }) {
  const number = new Intl.NumberFormat(locale);
  const total = Math.max(1, summary.requests);
  // Measured = reported + estimated; whatever the two do not explain stays inside "measured".
  const otherMeasured = Math.max(0, summary.measuredRequests - summary.reportedRequests - summary.estimatedRequests);
  const parts = [
    { key: "reported", label: t("usage.coverage.reported"), count: summary.reportedRequests + otherMeasured, tone: "bg-fg" },
    { key: "estimated", label: t("usage.coverage.estimated"), count: summary.estimatedRequests, tone: "bg-fg/45" },
    { key: "unreported", label: t("logs.tokens.unreported"), count: summary.unreportedRequests, tone: "bg-warning" },
    { key: "unsupported", label: t("logs.tokens.unsupported"), count: summary.unsupportedRequests, tone: "bg-line-strong" },
  ];
  return (
    <UsageWorkspaceSection
      title={t("usage.section.coverage")}
      titleId="usage-coverage-title"
      meta={formatPct(summary.coverageRatio)}
    >
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {parts.filter(part => part.count > 0).map(part => (
          <span key={part.key} className={cn("block h-full first:rounded-l-full last:rounded-r-full", part.tone)}
            style={{ width: `${(part.count / total) * 100}%` }} />
        ))}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-fg-subtle">{t("usage.coverage.measured")}</dt>
          <dd className="m-0 text-[17px] font-semibold text-fg tabular-nums">{number.format(summary.measuredRequests)}</dd>
        </div>
        {parts.map(part => (
          <div key={part.key} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span className={cn("size-2 shrink-0 rounded-[2px]", part.tone)} aria-hidden="true" />
              {part.label}
            </dt>
            <dd className="m-0 text-[17px] font-semibold text-fg tabular-nums">
              {number.format(part.key === "reported" ? summary.reportedRequests : part.count)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-xs leading-5 text-fg-subtle">{t("usage.coverage.note")}</p>
    </UsageWorkspaceSection>
  );
}
