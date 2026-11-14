/**
 * Models > Live routing. For the newest request, or the one the operator pinned, shows who was
 * asked, who answered, why the rest were skipped, then the list of recent requests. The flow
 * diagram is the one account of the route; the lines around it only add what it cannot show.
 */
import { useMemo, useState } from "react";
import { useI18n, LOCALES } from "../../i18n/shared";
import { EmptyState, Notice } from "../../ui";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { ContextCard } from "./ContextCard";
import { FlowDiagram } from "./FlowDiagram";
import { buildRouteFlow, candidateWho, summarizePool, type FlowOutcome, type RouteFlow } from "./flow-model";
import { FailedDetail, ReasonText } from "./ReasonText";
import { withSlots } from "./slots";
import { RequestList } from "./RequestList";
import { TimeSection } from "./TimeBar";
import { formatClock, formatDuration } from "./route-format";
import { rowKey, type RouteRow } from "./route-rows";
import type { GroupMode } from "./request-groups";
import { useAccountNames, useRouteRows } from "./use-route-live";
import "./route-live.css";

function OutcomeLine({ outcome, row }: { outcome: FlowOutcome; row: RouteRow }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  switch (outcome.kind) {
    case "ok":
    case "moved": {
      const who = <strong>{candidateWho(outcome.answered)}</strong>;
      const duration = formatDuration(outcome.answered.durationMs ?? row.durationMs, localeTag);
      const sentence = outcome.kind === "ok"
        ? withSlots(t("routeLive.outcomeOk", { who: "{who}", model: "{model}", duration: "{duration}" }), {
          who, model: <code>{outcome.answered.model}</code>, duration,
        })
        : withSlots(t("routeLive.outcomeMoved", { count: outcome.tries, who: "{who}" }), { who });
      return <p className="rl-outcome rl-outcome--ok" role="status">{sentence}</p>;
    }
    case "failed": {
      const fallback = <FailedDetail status={outcome.httpStatus} code={outcome.reasonCode} />;
      const withTries = outcome.tries > 1 && outcome.reasonCode !== undefined;
      return (
        <p className="rl-outcome rl-outcome--bad" role="status">
          {withTries
            ? withSlots(t("routeLive.outcomeFailedTries", { status: "{status}", reason: "{reason}", count: outcome.tries }), {
              status: outcome.httpStatus, reason: <ReasonText kind="fail" code={outcome.reasonCode ?? ""} />,
            })
            : fallback}
        </p>
      );
    }
    case "local":
      return <p className="rl-outcome" role="status">{t("routeLive.outcomeLocal")}</p>;
  }
}

/** Why the router picked this route, when it recorded a reason. */
export function WhyLine({ row }: { row: RouteRow }) {
  const { t } = useI18n();
  const reason = row.routeDecision?.selected?.reason;
  if (!reason) return null;
  return (
    <p className="rl-muted rl-hint">
      {withSlots(t("routeLive.routeWhy", { reason: "{reason}" }), { reason: <ReasonText kind="why" code={reason} /> })}
    </p>
  );
}

export function PoolLine({ row }: { row: RouteRow }) {
  const { t } = useI18n();
  const pool = summarizePool(row.accountRoster);
  if (!pool) return null;
  const states = [
    [pool.available, "routeLive.poolAvailable"], [pool.cooldown, "routeLive.poolCooldown"],
    [pool.paused, "routeLive.poolPaused"], [pool.needsReauth, "routeLive.poolReauth"],
    [pool.quotaExhausted, "routeLive.poolQuota"], [pool.modelUnlisted, "routeLive.poolUnlisted"],
  ] as const;
  const bits = [
    t("routeLive.poolHead", { provider: pool.provider, total: pool.total }),
    ...states.flatMap(([n, key]) => (n > 0 ? [t(key, { n })] : [])),
  ];
  return (
    <p className="rl-muted rl-pool">
      {bits.join(" · ")}
      {row.accountRoster?.truncated && ` ${t("routeLive.poolTruncated")}`}
      {" "}
      <a href={`#providers?provider=${encodeURIComponent(pool.provider)}&tab=accounts`}>{t("routeLive.linkAccounts")}</a>
    </p>
  );
}

function Selected({ row, flow, pinned, onBack }: { row: RouteRow; flow: RouteFlow; pinned: boolean; onBack: () => void }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const heading = pinned ? t("routeLive.pinnedHead", { time: formatClock(row.timestamp, localeTag) }) : t("routeLive.latestHead");
  return (
    <section className="rl-selected">
      <div className="rl-selected-bar">
        <h3 className="rl-h">{heading}</h3>
        {pinned && <button type="button" className="btn btn-sm" onClick={onBack}>{t("routeLive.backToLatest")}</button>}
      </div>
      <OutcomeLine outcome={flow.outcome} row={row} />
      <FlowDiagram flow={flow} />
      <WhyLine row={row} />
      <PoolLine row={row} />
      {flow.outcome.kind !== "local" && <TimeSection row={row} />}
      <ContextCard row={row} />
      {row.routeDecision?.routeKind === "combo" && <p className="rl-muted"><a href="#models/combos">{t("routeLive.linkCombos")}</a></p>}
    </section>
  );
}

export default function RouteLive({ apiBase, active }: { apiBase: string; active: boolean }) {
  const { t } = useI18n();
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<GroupMode>("request");
  const resource = useRouteRows(apiBase, active);
  const rows = useMemo(() => resource.data ?? [], [resource.data]);
  const providers = useMemo(() => [...new Set(rows.flatMap(r => (r.accountRoster ? [r.accountRoster.provider] : [])))], [rows]);
  const names = useAccountNames(apiBase, active, providers);
  const pinnedRow = pinnedKey === null ? undefined : rows.find(r => rowKey(r) === pinnedKey);
  const selected = pinnedRow ?? rows[0];
  const flow = useMemo(() => (selected ? buildRouteFlow(selected, names) : undefined), [selected, names]);

  if (resource.data === undefined) {
    return resource.error
      ? <Notice tone="err">{t("routeLive.loadFailed")}</Notice>
      : <DataSurfaceSkeleton label={t("common.loading")} rows={5} />;
  }
  if (rows.length === 0 || !selected || !flow) {
    return <EmptyState title={t("routeLive.empty")} />;
  }
  return (
    <div className="rl-page">
      {resource.error != null && !resource.lastAttemptOk && <Notice tone="err">{t("routeLive.loadFailed")}</Notice>}
      <Selected row={selected} flow={flow} pinned={pinnedRow !== undefined} onBack={() => setPinnedKey(null)} />
      <RequestList rows={rows} pinnedKey={pinnedRow ? pinnedKey : null} onPin={setPinnedKey} mode={mode} onMode={setMode} names={names} />
    </div>
  );
}
