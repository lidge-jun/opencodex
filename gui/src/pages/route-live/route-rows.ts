/**
 * Row shape and metrics for the Live routing tab.
 *
 * `/api/logs` rows are arbitrary JSON to this page, so `parseRouteRows` is the one
 * boundary: every field the flow model and the request list read is checked here or read
 * through a numeric guard below. Nothing past this file trusts a row's types.
 */
import { parseLogPollResponse } from "../log-poll";
import {
  sanitizeLogEntryRouteDecision,
  type LogEntryBase,
  type LogRouteDecision,
} from "../log-route-decision";
import { cacheSplit } from "../logs-token-title";
import { CONTEXT_CATEGORIES, type ContextBreakdown } from "./context-tiles";
import type { formatEstimatedUsd } from "../logs-cost-format";

export const ROUTE_LIVE_ROW_CAP = 200;

export type AccountRosterState =
  | "available" | "paused" | "needs-reauth" | "cooldown" | "quota-exhausted" | "model-unlisted";

const ROSTER_STATES: ReadonlySet<string> = new Set<AccountRosterState>([
  "available", "paused", "needs-reauth", "cooldown", "quota-exhausted", "model-unlisted",
]);

export interface RouteAttempt {
  provider: string;
  model: string;
  status: number;
  durationMs?: number;
  firstOutputMs?: number;
  accountLogLabel?: string;
  accountTag?: string;
  errorCode?: string;
  /** This attempt's own usage; the row's `usage` sums every attempt of a retried request. */
  usage?: { inputTokens?: number };
}

export interface RouteRoster {
  provider: string;
  accounts: Array<{ label: string; state: AccountRosterState }>;
  truncated?: true;
}

type RowCost = Parameters<typeof formatEstimatedUsd>[0];

export interface RouteRow extends LogEntryBase {
  requestedModel?: string;
  requestedAlias?: string;
  resolvedModel?: string;
  servedModel?: string;
  firstOutputMs?: number;
  /** ms from request start until the final attempt started (src/server/request-log-route-live.ts). */
  upstreamSendMs?: number;
  privacyRedactionMs?: number;
  requestedEffort?: string;
  effectiveEffort?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  totalTokens?: number;
  attempts?: RouteAttempt[];
  accountRoster?: RouteRoster;
  /** Estimated size of each part of the request as the client sent it (src/server/context-breakdown.ts). */
  contextBreakdown?: ContextBreakdown;
  /** The serving model's context window in tokens, when known. */
  contextWindow?: number;
  accountLogLabel?: string;
  accountTag?: string;
  conversationId?: string;
  apiKeyId?: string;
  admissionKind?: string;
  client?: unknown;
  surface?: string;
  errorCode?: string;
  displayMetrics?: {
    tokPerSecond?: { kind?: string; value?: number; estimated?: boolean };
    cost?: RowCost;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseAttempts(value: unknown): RouteAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is RouteAttempt => isRecord(item)
    && typeof item.provider === "string" && typeof item.model === "string" && finite(item.status));
}

function parseRoster(value: unknown): RouteRoster | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || !Array.isArray(value.accounts)) return undefined;
  const accounts = value.accounts.filter((item): item is RouteRoster["accounts"][number] => isRecord(item)
    && typeof item.label === "string" && typeof item.state === "string" && ROSTER_STATES.has(item.state));
  return accounts.length === 0 ? undefined
    : { provider: value.provider, accounts, ...(value.truncated === true ? { truncated: true as const } : {}) };
}

const tokenCount = (value: unknown): value is number => finite(value) && value >= 0;

/** A breakdown missing any part, or carrying a negative or non-numeric size, is dropped whole. */
export function parseContextBreakdown(value: unknown): ContextBreakdown | undefined {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.parts) || !Array.isArray(value.turns)) return undefined;
  const parts = {} as ContextBreakdown["parts"];
  for (const category of CONTEXT_CATEGORIES) {
    const size = value.parts[category];
    if (!tokenCount(size)) return undefined;
    parts[category] = size;
  }
  if (!value.turns.every(tokenCount) || !tokenCount(value.toolCount)) return undefined;
  return {
    v: 1, parts, turns: value.turns, toolCount: value.toolCount,
    ...(tokenCount(value.turnsEarlier) && value.turnsEarlier > 0 ? { turnsEarlier: value.turnsEarlier } : {}),
    ...(value.held === true ? { held: true as const } : {}),
  };
}

function parseRow(raw: unknown): RouteRow | null {
  if (!isRecord(raw) || !finite(raw.timestamp) || typeof raw.model !== "string"
    || typeof raw.provider !== "string" || !finite(raw.status) || !finite(raw.durationMs)) return null;
  const { attempts, accountRoster, contextBreakdown, contextWindow, ...rest } = raw;
  const row = { ...rest } as unknown as RouteRow;
  const breakdown = parseContextBreakdown(contextBreakdown);
  if (breakdown) row.contextBreakdown = breakdown;
  if (finite(contextWindow) && contextWindow > 0) row.contextWindow = contextWindow;
  const parsedAttempts = parseAttempts(attempts);
  if (parsedAttempts) row.attempts = parsedAttempts;
  const roster = parseRoster(accountRoster);
  if (roster) row.accountRoster = roster;
  return sanitizeLogEntryRouteDecision(row);
}

/** Newest first, capped. Rows that fail the shape check are dropped, not repaired. */
export function parseRouteRows(body: unknown): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const raw of parseLogPollResponse<unknown>(body).rows) {
    const row = parseRow(raw);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows.slice(0, ROUTE_LIVE_ROW_CAP);
}

export function rowKey(row: RouteRow): string {
  return row.requestId ?? `${row.timestamp}:${row.provider}:${row.model}`;
}

export function routeDecisionOf(row: RouteRow): LogRouteDecision | undefined {
  return row.routeDecision;
}

/** The label that names the account on a row: the row's own, else the last attempt's. */
export function rowAccountLabel(row: RouteRow): string | undefined {
  const last = row.attempts?.at(-1);
  return row.accountLogLabel ?? row.accountTag ?? last?.accountLogLabel ?? last?.accountTag;
}

const KEY_ACCOUNT_LABEL_RE = /^k[0-9a-f]{32}$/;

/** An API-key account label is a 32-hex digest; show it as its provider plus a short fingerprint. */
export function readableAccountLabel(label: string, provider: string): string {
  return KEY_ACCOUNT_LABEL_RE.test(label) ? `${provider} #${label.slice(1, 7)}` : label;
}

/** A combo row's own provider is "combo"; the account belongs to the provider of the final attempt. */
export function servingProviderOf(row: RouteRow): string {
  return row.attempts?.at(-1)?.provider ?? row.provider;
}

/** What the client asked for. A combo row's alias names the target it landed on, not the combo. */
export function requestedOf(row: RouteRow): string {
  return row.routeDecision?.routeKind === "combo"
    ? row.requestedModel ?? row.model
    : row.requestedAlias ?? row.requestedModel ?? row.model;
}

export function servedModelOf(row: RouteRow): string {
  return row.servedModel ?? row.resolvedModel ?? row.model;
}

/** Same rule as the Logs table: `inputTokens` already includes cache, `max` keeps legacy rows honest. */
export function tokenTotal(row: RouteRow): number | undefined {
  const usage = row.usage;
  if (!usage || !finite(usage.inputTokens) || !finite(usage.outputTokens)) {
    return finite(row.totalTokens) ? row.totalTokens : undefined;
  }
  const base = usage.inputTokens + usage.outputTokens;
  const explicit = finite(usage.totalTokens) ? usage.totalTokens : row.totalTokens;
  return finite(explicit) ? Math.max(explicit, base) : base;
}

/** Input tokens the provider counted, cached ones included. Undefined when the row has no usable usage. */
export function countedInputTokens(row: Pick<RouteRow, "usage">): number | undefined {
  const input = row.usage?.inputTokens;
  return finite(input) && input > 0 ? input : undefined;
}

/**
 * Input the serving model held, for sizing its context. A retried row's `usage` sums every
 * attempt, so it reads the final attempt's own; without that, undefined (the estimate stands).
 */
export function contextInputTokens(row: Pick<RouteRow, "usage" | "attempts">): number | undefined {
  if ((row.attempts?.length ?? 0) <= 1) return countedInputTokens(row);
  const input = row.attempts!.at(-1)?.usage?.inputTokens;
  return finite(input) && input > 0 ? input : undefined;
}

/** Cached vs total input tokens. Unknown cache detail stays undefined, never a zero read. */
export function cacheMeterOf(row: RouteRow): { read: number; total: number } | undefined {
  const usage = row.usage;
  const total = countedInputTokens(row);
  if (!usage || total === undefined) return undefined;
  const { read } = cacheSplit({ provider: row.provider, usage: { inputTokens: total, outputTokens: usage.outputTokens ?? 0, ...usage } });
  return finite(read) ? { read: Math.min(total, Math.max(0, read)), total } : undefined;
}

/** Cache read share of the input, 0..100. Unknown cache detail stays undefined, never 0. */
export function cacheHitPercent(row: RouteRow): number | undefined {
  const meter = cacheMeterOf(row);
  return meter ? (100 * meter.read) / meter.total : undefined;
}

export function tokPerSecondOf(row: RouteRow): { value: number; estimated: boolean } | undefined {
  const rate = row.displayMetrics?.tokPerSecond;
  if (rate?.kind !== "value" || !finite(rate.value) || rate.value <= 0) return undefined;
  return { value: rate.value, estimated: rate.estimated === true };
}

export function costUsdOf(row: RouteRow): number | undefined {
  const cost = row.displayMetrics?.cost;
  if (cost?.kind !== "value") return undefined;
  const total = cost.estimate.cost.total;
  return finite(total) && total >= 0 ? total : undefined;
}
