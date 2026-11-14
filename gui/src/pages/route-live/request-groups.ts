/** Grouping of request rows by session or API key, with the aggregates a group head shows. */
import { cacheHitPercent, costUsdOf, tokPerSecondOf, tokenTotal, type RouteRow } from "./route-rows";

export type GroupMode = "request" | "session" | "key";

export type GroupLabel =
  | { kind: "session"; id: string }
  | { kind: "no-session" }
  | { kind: "key"; id: string }
  | { kind: "admission"; admission: string };

export interface GroupStats {
  count: number;
  tokens?: number;
  cacheHit?: number;
  tokPerSecond?: number;
  costUsd?: number;
}

export interface RouteGroup {
  id: string;
  label: GroupLabel;
  rows: RouteRow[];
  stats: GroupStats;
}

const NO_SESSION = "session:none";

function groupOf(row: RouteRow, mode: Exclude<GroupMode, "request">): { id: string; label: GroupLabel } {
  if (mode === "session") {
    return row.conversationId
      ? { id: `session:${row.conversationId}`, label: { kind: "session", id: row.conversationId } }
      : { id: NO_SESSION, label: { kind: "no-session" } };
  }
  if (row.apiKeyId) return { id: `key:${row.apiKeyId}`, label: { kind: "key", id: row.apiKeyId } };
  const admission = row.admissionKind ?? "unknown";
  return { id: `admission:${admission}`, label: { kind: "admission", admission } };
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function known<T>(rows: RouteRow[], read: (row: RouteRow) => T | undefined): T[] {
  return rows.flatMap(row => { const value = read(row); return value === undefined ? [] : [value]; });
}

export function groupStats(rows: RouteRow[]): GroupStats {
  const tokens = known(rows, tokenTotal);
  const costs = known(rows, costUsdOf);
  const stats: GroupStats = { count: rows.length };
  if (tokens.length) stats.tokens = tokens.reduce((sum, v) => sum + v, 0);
  const cache = mean(known(rows, cacheHitPercent));
  if (cache !== undefined) stats.cacheHit = cache;
  const rate = mean(known(rows, row => tokPerSecondOf(row)?.value));
  if (rate !== undefined) stats.tokPerSecond = rate;
  if (costs.length) stats.costUsd = costs.reduce((sum, v) => sum + v, 0);
  return stats;
}

/** Groups keep first-seen order, so newest-first rows give newest-first groups. */
export function groupRows(rows: RouteRow[], mode: Exclude<GroupMode, "request">): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const row of rows) {
    const { id, label } = groupOf(row, mode);
    const group = groups.get(id) ?? { id, label, rows: [], stats: { count: 0 } };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].map(group => ({ ...group, stats: groupStats(group.rows) }));
}
