/**
 * "Context window" card for the selected request: what filled the model's window (system prompt,
 * tools, skills, memory, files, tool results, each conversation turn), as a treemap plus a legend,
 * and a prompt-cache meter. The idea and the layout follow Magpie's context card (MIT,
 * Copyright (c) 2026 yetone); the markup is this page's own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, LOCALES } from "../../i18n/shared";
import type { RouteLiveCopyKey } from "../../i18n/route-live-copy";
import {
  calibrateContext, contextHealth, layoutTiles, type ContextCategory, type ContextHealth, type ContextTile,
} from "./context-tiles";
import { formatCount, formatPercent } from "./route-format";
import { cacheMeterOf, countedInputTokens, type RouteRow } from "./route-rows";

type Kind = ContextCategory | "free";

const KIND_LABEL = {
  system: "routeLive.ctxSystem",
  tools: "routeLive.ctxTools",
  skills: "routeLive.ctxSkills",
  memory: "routeLive.ctxMemory",
  files: "routeLive.ctxFiles",
  results: "routeLive.ctxResults",
  chat: "routeLive.ctxChat",
  free: "routeLive.ctxFree",
} as const satisfies Record<Kind, RouteLiveCopyKey>;

const HEALTH_LABEL = {
  ok: "routeLive.ctxHealthOk",
  filling: "routeLive.ctxHealthFilling",
  near: "routeLive.ctxHealthNear",
} as const satisfies Record<ContextHealth, RouteLiveCopyKey>;

const LEGEND_ORDER: readonly Kind[] = ["system", "tools", "skills", "memory", "files", "results", "chat", "free"];
const DEFAULT_WIDTH = 640;
const TILE_GAP = 2;

/** Magpie's box: 3.1:1 (2:1 when narrow), never shorter than 132px or taller than 232px. */
function boxHeight(width: number): number {
  return Math.min(232, Math.max(132, width / (width <= 520 ? 2 : 3.1)));
}

function useBoxWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

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
  const [boxRef, width] = useBoxWidth();
  const breakdown = row.contextBreakdown!;
  const windowTokens = row.contextWindow;
  const shares = useMemo(() => calibrateContext(breakdown, countedInputTokens(row)), [breakdown, row]);
  const height = boxHeight(width);
  const tiles = useMemo(() => layoutTiles(shares, windowTokens, width, height), [shares, windowTokens, width, height]);

  const base = Math.max(windowTokens ?? shares.used, shares.used, 1);
  const fraction = windowTokens ? shares.used / windowTokens : undefined;
  const share = (tokens: number) => {
    const value = tokens / base;
    return value > 0 && value < 0.01 ? `<${formatPercent(1, localeTag)}` : formatPercent(100 * value, localeTag);
  };
  const tokensText = (tokens: number) => formatCount(Math.round(tokens), localeTag);
  const nameOf = (tile: Pick<ContextTile, "kind" | "turn" | "earlier">) => {
    if (tile.turn !== undefined) return t("routeLive.ctxTurn", { n: tile.turn });
    return tile.earlier ? t("routeLive.ctxEarlier") : t(KIND_LABEL[tile.kind]);
  };
  const freeTokens = tiles.find(tile => tile.kind === "free")?.tokens;
  const legend = LEGEND_ORDER.flatMap(kind => {
    const tokens = kind === "free" ? freeTokens : shares.parts[kind];
    return tokens !== undefined && tokens > 0 ? [{ kind, tokens }] : [];
  });

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
      <CacheMeter row={row} />
      <div ref={boxRef} className="rl-ctx-map" role="group" aria-label={t("routeLive.ctxMapLabel")} style={{ height }}>
        {tiles.map(tile => {
          const name = nameOf(tile);
          const label = `${name} ${tokensText(tile.tokens)} (${share(tile.tokens)})`;
          return (
            <div
              key={`${tile.kind}:${tile.turn ?? (tile.earlier ? "earlier" : "")}`}
              role="img" aria-label={label} title={label}
              className={`rl-ctx-tile rl-ctx-tile--${tile.kind}`}
              style={{
                left: tile.x + TILE_GAP / 2, top: tile.y + TILE_GAP / 2,
                width: Math.max(0, tile.w - TILE_GAP), height: Math.max(0, tile.h - TILE_GAP),
              }}
            >
              {tile.w >= 48 && tile.h >= 18 && <span className="rl-ctx-tile-name">{name}</span>}
              {tile.w >= 64 && tile.h >= 34 && <span className="rl-ctx-tile-value">{tokensText(tile.tokens)} · {share(tile.tokens)}</span>}
            </div>
          );
        })}
      </div>
      <ul className="rl-ctx-legend">
        {legend.map(item => (
          <li key={item.kind}>
            <span className={`rl-ctx-dot rl-ctx-tile--${item.kind}`} aria-hidden="true" />
            <span>{t(KIND_LABEL[item.kind])}</span>
            <span className="rl-num rl-muted">{tokensText(item.tokens)} · {share(item.tokens)}</span>
          </li>
        ))}
      </ul>
      {shares.held && <p className="rl-muted rl-hint">{t("routeLive.ctxHeld")}</p>}
    </section>
  );
}

/** Hidden for a row that carries no breakdown (an older request, or a path that does not record one). */
export function ContextCard({ row }: { row: RouteRow }) {
  return row.contextBreakdown ? <ContextCardBody row={row} /> : null;
}
