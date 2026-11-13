/**
 * Models > Live routing. For the newest request, or the one the operator pinned, shows who was
 * asked, who answered, why the rest were skipped, then the list of recent requests.
 */
import { useMemo, useState } from "react";
import { useI18n, LOCALES } from "../../i18n/shared";
import { EmptyState, Notice } from "../../ui";
import { FlowDiagram } from "./FlowDiagram";
import { buildRouteFlow, candidateWho, summarizePool, type FlowOutcome, type RouteFlow } from "./flow-model";
import { FailedDetail, ReasonText } from "./ReasonText";
import { withSlots } from "./slots";
import { RequestList } from "./RequestList";
import { RouteSteps } from "./RouteSteps";
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

function PoolLine({ row }: { row: RouteRow }) {
  const { t } = useI18n();
  const pool = summarizePool(row.accountRoster);
  if (!pool) return null;
  return (
    <p className="rl-muted rl-pool">
      {t("routeLive.poolSummary", {
        provider: pool.provider, total: pool.total, available: pool.available,
        cooldown: pool.cooldown, paused: pool.paused, reauth: pool.needsReauth,
      })}
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
      <PoolLine row={row} />
      <RouteSteps row={row} flow={flow} />
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
      : <p className="rl-muted" role="status">{t("routeLive.loading")}</p>;
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
