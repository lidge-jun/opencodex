/**
 * Recent requests, flat or grouped by session / API key. Rows are real buttons, so Tab, Enter and
 * Space work without extra wiring; Esc anywhere in the list unpins. A metric with no value shows
 * a dash, never a zero.
 */
import { useState, type KeyboardEvent } from "react";
import { useI18n, LOCALES, type TFn } from "../../i18n/shared";
import { formatEstimatedUsdValue } from "../logs-cost-format";
import { LogsClientChip } from "../logs-client-chip";
import type { AccountNames } from "./flow-model";
import { groupRows, type GroupLabel, type GroupMode, type GroupStats } from "./request-groups";
import { formatClock, formatCount, formatDuration, formatPercent, formatRate, shortId } from "./route-format";
import {
  cacheHitPercent, costUsdOf, readableAccountLabel, requestedOf, rowAccountLabel, servingProviderOf, rowKey, servedModelOf, tokPerSecondOf, tokenTotal, type RouteRow,
} from "./route-rows";
import "./route-live.css";

const DASH = "—";
const MODES: ReadonlyArray<{ mode: GroupMode; key: "routeLive.modeRequest" | "routeLive.modeSession" | "routeLive.modeKey" }> = [
  { mode: "request", key: "routeLive.modeRequest" },
  { mode: "session", key: "routeLive.modeSession" },
  { mode: "key", key: "routeLive.modeKey" },
];

function groupLabelText(label: GroupLabel, t: TFn): string {
  switch (label.kind) {
    case "session": return t("routeLive.groupSession", { id: shortId(label.id) });
    case "no-session": return t("routeLive.groupNoSession");
    case "key": return t("routeLive.groupKey", { id: shortId(label.id) });
    case "admission":
      if (label.admission === "loopback") return t("routeLive.admLoopback");
      if (label.admission === "environment") return t("routeLive.admEnvironment");
      if (label.admission === "configured") return t("routeLive.admConfigured");
      return t("routeLive.admUnknown");
  }
}

function effortText(row: RouteRow): string {
  const asked = row.requestedEffort;
  const used = row.effectiveEffort;
  if (asked && used && asked !== used) return `${asked} → ${used}`;
  return used ?? asked ?? DASH;
}

function whoText(row: RouteRow, names: AccountNames): string {
  const label = rowAccountLabel(row);
  const provider = row.accountRoster?.provider ?? servingProviderOf(row);
  const named = label ? names[provider]?.[label] ?? names[row.provider]?.[label] : undefined;
  return named ?? (label ? readableAccountLabel(label, servingProviderOf(row)) : servingProviderOf(row));
}

function GroupHead({ label, stats, open, onToggle, localeTag }: {
  label: GroupLabel; stats: GroupStats; open: boolean; onToggle: () => void; localeTag?: string;
}) {
  const { t } = useI18n();
  const bits = [t("routeLive.groupCount", { count: stats.count })];
  if (stats.tokens !== undefined) bits.push(t("routeLive.groupTokens", { value: formatCount(stats.tokens, localeTag) }));
  if (stats.cacheHit !== undefined) bits.push(t("routeLive.groupCache", { value: formatPercent(stats.cacheHit, localeTag) }));
  if (stats.tokPerSecond !== undefined) bits.push(`${formatRate(stats.tokPerSecond, false, localeTag)} tok/s`);
  if (stats.costUsd !== undefined) bits.push(formatEstimatedUsdValue(stats.costUsd, t, localeTag));
  return (
    <button type="button" className="rl-group-head" aria-expanded={open} onClick={onToggle}>
      <span className="rl-group-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <strong>{groupLabelText(label, t)}</strong>
      <span className="rl-muted">{bits.join(" · ")}</span>
    </button>
  );
}

function Field({ label }: { label: string }) {
  return <span className="sr-only">{label}: </span>;
}

function RequestRow({ row, pinned, names, localeTag, onPin }: {
  row: RouteRow; pinned: boolean; names: AccountNames; localeTag?: string; onPin: (key: string) => void;
}) {
  const { t } = useI18n();
  const failed = row.status >= 400;
  const tokens = tokenTotal(row);
  const cache = cacheHitPercent(row);
  const rate = tokPerSecondOf(row);
  const cost = costUsdOf(row);
  const tries = row.attempts?.length ?? 0;
  return (
    <li>
      <button type="button" className={`rl-row${pinned ? " rl-row--pinned" : ""}`} aria-pressed={pinned} onClick={() => onPin(rowKey(row))}>
        <span className="rl-cell rl-cell--time">{formatClock(row.timestamp, localeTag)}</span>
        <span className="rl-cell rl-cell--client">
          <LogsClientChip client={row.client} t={t} />
          <code className="rl-ellipsis">{requestedOf(row)}</code>
        </span>
        <span className="rl-cell rl-cell--who">
          <strong className="rl-ellipsis">{whoText(row, names)}</strong>
          <code className="rl-ellipsis rl-muted">{servedModelOf(row)}</code>
          {tries > 1 && <span className="rl-muted">{t("routeLive.rowTries", { count: tries })}</span>}
        </span>
        {/* The column headings are aria-hidden, so each value carries its own name for screen readers. */}
        <span className="rl-cell"><Field label={t("logs.col.effort")} />{effortText(row)}</span>
        <span className="rl-cell rl-num"><Field label={t("logs.col.duration")} />{formatDuration(row.durationMs, localeTag)}</span>
        <span className="rl-cell rl-num"><Field label={t("routeLive.colTtft")} />{row.firstOutputMs === undefined ? DASH : formatDuration(row.firstOutputMs, localeTag)}</span>
        <span className="rl-cell rl-num"><Field label={t("logs.col.tokens")} />{tokens === undefined ? DASH : formatCount(tokens, localeTag)}</span>
        <span className="rl-cell rl-num"><Field label={t("routeLive.colCache")} />{cache === undefined ? DASH : formatPercent(cache, localeTag)}</span>
        <span className="rl-cell rl-num"><Field label={t("logs.col.tokPerSec")} />{rate ? formatRate(rate.value, rate.estimated, localeTag) : DASH}</span>
        <span className="rl-cell rl-num"><Field label={t("logs.col.estimatedCost")} />{cost === undefined ? DASH : formatEstimatedUsdValue(cost, t, localeTag)}</span>
        <span className={`rl-cell rl-num${failed ? " rl-bad" : ""}`}><Field label={t("logs.col.status")} />{row.status}</span>
      </button>
    </li>
  );
}

export function RequestList({ rows, pinnedKey, onPin, mode, onMode, names }: {
  rows: RouteRow[];
  pinnedKey: string | null;
  onPin: (key: string | null) => void;
  mode: GroupMode;
  onMode: (mode: GroupMode) => void;
  names: AccountNames;
}) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const groups = mode === "request" ? undefined : groupRows(rows, mode);
  const toggle = (id: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const pin = (key: string) => onPin(key === pinnedKey ? null : key);
  const renderRows = (list: RouteRow[]) => list.map(row => (
    <RequestRow key={rowKey(row)} row={row} pinned={rowKey(row) === pinnedKey} names={names} localeTag={localeTag} onPin={pin} />
  ));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && pinnedKey !== null) onPin(null);
  };

  return (
    <section className="rl-list" aria-label={t("routeLive.listLabel")} onKeyDown={onKeyDown}>
      <div className="rl-list-bar">
        <h3 className="rl-h">{t("routeLive.listLabel")}</h3>
        <div className="usage-segmented" role="group" aria-label={t("routeLive.modeLabel")}>
          {MODES.map(({ mode: m, key }) => (
            <button key={m} type="button" className={`usage-segmented-btn${mode === m ? " active" : ""}`} aria-pressed={mode === m} onClick={() => onMode(m)}>
              {t(key)}
            </button>
          ))}
        </div>
      </div>
      <p className="rl-muted rl-hint">{t("routeLive.rowHint")}</p>
      <div className="rl-row rl-row--head" aria-hidden="true">
        <span>{t("logs.col.time")}</span><span>{t("routeLive.colClient")} · {t("logs.col.model")}</span>
        <span>{t("routeLive.colAccount")}</span><span>{t("logs.col.effort")}</span><span className="rl-num">{t("logs.col.duration")}</span>
        <span className="rl-num">{t("routeLive.colTtft")}</span><span className="rl-num">{t("logs.col.tokens")}</span>
        <span className="rl-num">{t("routeLive.colCache")}</span><span className="rl-num">{t("logs.col.tokPerSec")}</span>
        <span className="rl-num">{t("logs.col.estimatedCost")}</span><span className="rl-num">{t("logs.col.status")}</span>
      </div>
      {groups ? groups.map(group => {
        const open = !collapsed.has(group.id);
        return (
          <div key={group.id} className="rl-group">
            <GroupHead label={group.label} stats={group.stats} open={open} onToggle={() => toggle(group.id)} localeTag={localeTag} />
            {open && <ul className="rl-rows">{renderRows(group.rows)}</ul>}
          </div>
        );
      }) : <ul className="rl-rows">{renderRows(rows)}</ul>}
    </section>
  );
}
