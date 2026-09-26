import { useMemo, useState, type CSSProperties } from "react";
import { useT } from "../i18n/shared";
import type { AccountPoolStrategy } from "../account-pool-strategy";
import { barWidth, isQuotaExhausted, quotaBarTone } from "./QuotaBars";

type PoolKind = "generic" | "anthropic" | "codex";

function barStyle(percent: number): CSSProperties {
  return { ["--bar-scale" as string]: String(barWidth(percent) / 100) };
}

/**
 * Compact live diagram for the account-pool card. Generic OAuth keeps round-robin
 * and fill-first stored until pool.kernel is on, so the picture shows the live
 * Quota path and labels the selected strategy as saved when it is inert.
 */
export default function AccountPoolStrategyPreview({
  strategy,
  threshold,
  kind,
  enabled,
}: {
  strategy: AccountPoolStrategy;
  threshold: number;
  kind: PoolKind;
  enabled: boolean;
}) {
  const t = useT();
  const [usage, setUsage] = useState(90);
  const storedOnly = kind === "generic" && strategy !== "quota" && strategy !== "reset-first";
  const liveStrategy: AccountPoolStrategy = storedOnly ? "quota" : strategy;
  const switchAt = useMemo(() => {
    if (!enabled) return null;
    if (liveStrategy === "fill-first") {
      return threshold > 0 ? threshold : null;
    }
    if (liveStrategy === "round-robin" || liveStrategy === "reset-first") return null;
    if (kind === "generic") return 100;
    return threshold > 0 ? threshold : 100;
  }, [enabled, kind, liveStrategy, threshold]);
  const switches = switchAt !== null && usage >= switchAt;
  const showTurns = liveStrategy === "round-robin" && !storedOnly;
  const accountA = t("genericPool.visualAccountA");
  const accountB = t("genericPool.visualAccountB");
  const liveCaption = liveStrategy === "fill-first"
    ? t("genericPool.visualFillFirst", { threshold })
    : liveStrategy === "round-robin"
      ? t("genericPool.visualRoundRobin")
      : liveStrategy === "reset-first"
        ? t("genericPool.visualResetFirst")
      : t("genericPool.visualQuota");

  if (kind === "generic") {
    return (
      <div className="account-pool-preview" style={{ marginTop: "8px" }}>
        <div className="account-pool-minimal-info" style={{
          padding: "10px 14px",
          borderRadius: "8px",
          background: "var(--raised, #2a2a2a)",
          border: "1px solid var(--border-soft, #383838)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          fontSize: "13px",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <strong style={{ color: "var(--text)" }}>
              {strategy === "reset-first" && "📅 " + t("accountPool.strategyResetFirst")}
              {strategy === "quota" && "⚡ " + t("accountPool.strategyQuota")}
              {strategy === "round-robin" && "🔄 " + t("accountPool.strategyRoundRobin")}
              {strategy === "fill-first" && "🎯 " + t("accountPool.strategyFillFirst")}
            </strong>
            {storedOnly && (
              <span className="account-pool-preview__tag account-pool-preview__tag--stored">
                {t("genericPool.visualStored")}
              </span>
            )}
          </div>
          <div className="card-sub" style={{ margin: 0, lineHeight: 1.4 }}>
            {liveCaption}
          </div>
          <div className="card-sub" style={{ margin: 0, fontSize: "12px", color: "var(--muted)" }}>
            {t("genericPool.visual429")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="account-pool-preview">
      <div className="account-pool-preview__head">
        <span className="account-pool-preview__title">{t("genericPool.visualTitle")}</span>
        {storedOnly && (
          <span className="account-pool-preview__tag account-pool-preview__tag--stored">
            {t("genericPool.visualStored")}
          </span>
        )}
      </div>
      <figure className="account-pool-preview__figure">
        {showTurns ? (
          <div className="account-pool-preview__turns" aria-hidden="true">
            {[accountA, accountB, accountA].map((account, index) => (
              <span key={`${account}-${index}`} className="account-pool-preview__turn is-on">
                {t("genericPool.visualTurn", { n: index + 1, account })}
              </span>
            ))}
          </div>
        ) : (
          <div className="quota-stacked" aria-hidden="true">
            <PreviewAccount
              name={accountA}
              percent={usage}
              threshold={switchAt ?? 100}
              tag={switches ? null : t("genericPool.visualLive")}
            />
            <PreviewAccount
              name={accountB}
              percent={12}
              threshold={switchAt ?? 100}
              tag={switches ? t("genericPool.visualLive") : null}
            />
          </div>
        )}
        {!showTurns && (
          <label className="account-pool-preview__slider">
            <span className="field-label">{t("genericPool.visualUsage")}</span>
            {switchAt !== null && (
              <span className="card-sub">{t("genericPool.visualSwitchAt", { pct: switchAt })}</span>
            )}
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={usage}
              aria-label={t("genericPool.visualUsageAria")}
              onChange={(event) => setUsage(Number(event.target.value))}
            />
          </label>
        )}
        {!showTurns && (
          <figcaption className="account-pool-preview__caption">
            {switches ? t("genericPool.visualSwitch") : t("genericPool.visualStay")}
          </figcaption>
        )}
      </figure>
      <div className="card-sub">{liveCaption}</div>
      {storedOnly && <div className="card-sub">{t("genericPool.visualKernelGap")}</div>}
      <div className="card-sub">{t("genericPool.visual429")}</div>
    </div>
  );
}

function PreviewAccount({
  name,
  percent,
  threshold,
  tag,
}: {
  name: string;
  percent: number;
  threshold: number;
  tag: string | null;
}) {
  const t = useT();
  const exhausted = isQuotaExhausted(percent);
  const color = quotaBarTone(percent, threshold);
  return (
    <div className={`quota-stacked-row${exhausted ? " quota-stacked-row--exhausted" : ""}`}>
      <div className="account-pool-preview__row-head">
        <span className="account-pool-preview__name">{name}</span>
        {tag && <span className="account-pool-preview__tag">{tag}</span>}
      </div>
      <div className="quota-stacked-bar-row">
        <div className="bar quota-stacked-bar">
          <div className={`bar-fill ${color}`} style={barStyle(percent)} />
        </div>
        <span className={`quota-stacked-used${color === "bar-warn" ? " quota-stacked-used--warn" : ""}`}>
          {t("quota.usedPercent", { pct: Math.round(percent) })}
        </span>
      </div>
    </div>
  );
}
