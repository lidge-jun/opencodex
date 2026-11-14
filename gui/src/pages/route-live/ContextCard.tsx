/**
 * "Context window" card for the selected request: what filled the prompt (system prompt, tools,
 * skills, memory, files, tool results, conversation) as one stacked bar plus a legend, how full the
 * model's window is, and a prompt-cache meter. The categories follow Magpie's context card (MIT,
 * Copyright (c) 2026 yetone); the markup is this page's own.
 */
import { useMemo } from "react";
import { useI18n, LOCALES } from "../../i18n/shared";
import type { RouteLiveCopyKey } from "../../i18n/route-live-copy";
import { CONTEXT_CATEGORIES, calibrateContext, contextHealth, type ContextCategory, type ContextHealth } from "./context-tiles";
import { formatCount, formatPercent } from "./route-format";
import { cacheMeterOf, countedInputTokens, type RouteRow } from "./route-rows";

const KIND_LABEL = {
  system: "routeLive.ctxSystem",
  tools: "routeLive.ctxTools",
  skills: "routeLive.ctxSkills",
  memory: "routeLive.ctxMemory",
  files: "routeLive.ctxFiles",
  results: "routeLive.ctxResults",
  chat: "routeLive.ctxChat",
} as const satisfies Record<ContextCategory, RouteLiveCopyKey>;

const HEALTH_LABEL = {
  ok: "routeLive.ctxHealthOk",
  filling: "routeLive.ctxHealthFilling",
  near: "routeLive.ctxHealthNear",
} as const satisfies Record<ContextHealth, RouteLiveCopyKey>;

function CacheMeter({ row }: { row: RouteRow }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const meter = cacheMeterOf(row);
  if (!meter) {
    return (
      <p className="rl-ctx-cache rl-muted">
        <span className="rl-ctx-cache-head">{t("routeLive.ctxCacheHead")}</span> {t("routeLive.ctxCacheUnknown")}
      </p>
    );
  }
  const percent = (100 * meter.read) / meter.total;
  return (
    <div className="rl-ctx-cache">
      <span className="rl-ctx-cache-head">{t("routeLive.ctxCacheHead")}</span>
      <strong>{t("routeLive.ctxCacheHit", { pct: formatPercent(percent, localeTag) })}</strong>
      <div
        className="rl-ctx-meter" role="meter" aria-label={t("routeLive.ctxCacheHead")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
      >
        <i style={{ width: `${percent.toFixed(1)}%` }} />
      </div>
      <span className="rl-muted">
        {t("routeLive.ctxCacheSplit", {
          cached: formatCount(meter.read, localeTag), fresh: formatCount(meter.total - meter.read, localeTag),
        })}
      </span>
    </div>
  );
}

function ContextCardBody({ row }: { row: RouteRow }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const breakdown = row.contextBreakdown!;
  const windowTokens = row.contextWindow;
  const shares = useMemo(() => calibrateContext(breakdown, countedInputTokens(row)), [breakdown, row]);

  const used = Math.max(shares.used, 1);
  const fraction = windowTokens ? shares.used / windowTokens : undefined;
  const tokensText = (tokens: number) => formatCount(Math.round(tokens), localeTag);
  /** Share of the prompt, not of the window: the header already says how full the window is. */
  const share = (tokens: number) => {
    const value = tokens / used;
    return value > 0 && value < 0.01 ? `<${formatPercent(1, localeTag)}` : formatPercent(100 * value, localeTag);
  };
  const parts = CONTEXT_CATEGORIES.flatMap(kind => (shares.parts[kind] > 0 ? [{ kind, tokens: shares.parts[kind] }] : []));

  return (
    <section className="rl-ctx" aria-label={t("routeLive.ctxMapLabel")}>
      <div className="rl-ctx-head">
        <h4 className="rl-h">
          {windowTokens
            ? t("routeLive.ctxHead", { used: tokensText(shares.used), window: formatCount(windowTokens, localeTag) })
            : t("routeLive.ctxHeadNoWindow", { used: tokensText(shares.used) })}
        </h4>
        {fraction !== undefined && (
          <span className={`rl-ctx-health rl-ctx-health--${contextHealth(fraction)}`}>
            {t("routeLive.ctxFill", { pct: formatPercent(100 * fraction, localeTag) })}
            {" · "}
            {t(HEALTH_LABEL[contextHealth(fraction)])}
          </span>
        )}
        {!shares.calibrated && <span className="rl-ctx-badge" title={t("routeLive.ctxEstimatedTitle")}>{t("routeLive.ctxEstimated")}</span>}
      </div>
      {windowTokens === undefined && <p className="rl-muted rl-hint">{t("routeLive.ctxWindowUnknown")}</p>}
      {parts.length > 0 && (
        <>
          <div className="rl-time-bar rl-ctx-bar" aria-hidden="true">
            {parts.map(part => (
              <span
                key={part.kind}
                className={`rl-ctx-seg rl-ctx-kind--${part.kind}`}
                style={{ flexGrow: part.tokens / used }}
                title={`${t(KIND_LABEL[part.kind])} ${tokensText(part.tokens)} (${share(part.tokens)})`}
              />
            ))}
          </div>
          <ul className="rl-ctx-legend">
            {parts.map(part => (
              <li key={part.kind}>
                <span className={`rl-ctx-dot rl-ctx-kind--${part.kind}`} aria-hidden="true" />
                <span>{t(KIND_LABEL[part.kind])}</span>
                <span className="rl-num rl-muted">{tokensText(part.tokens)} · {share(part.tokens)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {shares.held && <p className="rl-muted rl-hint">{t("routeLive.ctxHeld")}</p>}
      <CacheMeter row={row} />
    </section>
  );
}

/** Hidden for a row that carries no breakdown (an older request, or a path that does not record one). */
export function ContextCard({ row }: { row: RouteRow }) {
  return row.contextBreakdown ? <ContextCardBody row={row} /> : null;
}
