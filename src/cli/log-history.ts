/**
 * Indexed request-history reads: page the derived ledger, or fetch one canonical row.
 *
 * Distinct from `ocx logs` (the recent ring) and `ocx logs explain` (route-decision).
 */
import { REQUEST_HISTORY_DEFAULT_PAGE_SIZE, REQUEST_HISTORY_MAX_PAGE_SIZE } from "../routing/history/indexer";
import { parseUsageTimeWindow } from "../usage/time-range";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

type LogRow = Record<string, unknown>;

export const LOG_HISTORY_USAGE = `Usage:
  ocx logs history [--provider <name>] [--model <id>] [--requested-model <id>]
      [--status <code>] [--conversation <id>] [--surface <name>] [--protocol <responses|chat|messages>]
      [--api-key-id <id>] [--profile <id>] [--fallback <true|false>]
      [--from <epoch-ms|ISO-datetime>] [--to <epoch-ms|ISO-datetime>]
      [--cursor <token>] [--limit <1-${REQUEST_HISTORY_MAX_PAGE_SIZE}>] [--json|--jsonl]
  ocx logs get <request-id> [--json]`;

const GET_USAGE = "Usage: ocx logs get <request-id> [--json]";
const PROTOCOLS = ["responses", "chat", "messages"] as const;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function timestampOption(args: string[], flag: string): number | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  try {
    return parseUsageTimeWindow(raw, raw)!.since;
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? `${flag}: ${error.message}` : `${flag} is invalid`, LOG_HISTORY_USAGE);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatCost(row: Record<string, unknown>): string {
  const metrics = record(row.displayMetrics) ? row.displayMetrics : undefined;
  const cost = metrics && record(metrics.cost) ? metrics.cost : undefined;
  if (!cost || cost.kind !== "value" || !record(cost.estimate) || !record(cost.estimate.cost)) return "";
  const total = cost.estimate.cost.total;
  return typeof total === "number" && Number.isFinite(total) ? `~$${total.toFixed(4)}` : "";
}

function formatHistoryRow(row: LogRow, formatRow: (row: LogRow) => string): string {
  const tokens = typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens)
    ? `${row.totalTokens}tok`
    : "";
  return [formatRow(row), tokens, formatCost(row)].filter(Boolean).join("  ");
}

function historyPage(raw: unknown): {
  entries: Record<string, unknown>[];
  nextCursor?: string;
  hasMore: boolean;
  index?: Record<string, unknown>;
} {
  if (!record(raw) || !Array.isArray(raw.entries) || typeof raw.hasMore !== "boolean") {
    throw new Error("Invalid request-history page. Upgrade the proxy and retry.");
  }
  const entries = raw.entries;
  if (!entries.every(record)) throw new Error("Invalid request-history page. Upgrade the proxy and retry.");
  const nextCursor = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0 ? raw.nextCursor : undefined;
  const index = record(raw.index) ? raw.index : undefined;
  return { entries, nextCursor, hasMore: raw.hasMore, index };
}

/** Page the derived request-history index through GET /api/request-history. */
export async function handleLogHistoryCommand(
  argv: string[],
  deps: RuntimeApiDeps,
  formatRow: (row: LogRow) => string,
): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const wantsJsonl = takeFlag(args, "--jsonl");
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const requestedModel = takeOption(args, "--requested-model");
  const conversationId = takeOption(args, "--conversation") ?? takeOption(args, "--conversationId");
  const surface = takeOption(args, "--surface");
  const protocol = takeOption(args, "--protocol");
  const apiKeyId = takeOption(args, "--api-key-id");
  const profileId = takeOption(args, "--profile");
  const fallbackRaw = takeOption(args, "--fallback");
  const cursor = takeOption(args, "--cursor");
  const status = takeIntegerOption(args, "--status", { min: 100 });
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? REQUEST_HISTORY_DEFAULT_PAGE_SIZE;
  const from = timestampOption(args, "--from");
  const to = timestampOption(args, "--to");
  rejectArgs(args, LOG_HISTORY_USAGE);
  if (wantsJson && wantsJsonl) throw new CliUsageError("--json and --jsonl cannot be combined", LOG_HISTORY_USAGE);
  if (status !== undefined && status > 599) throw new CliUsageError("--status must be an integer from 100 to 599", LOG_HISTORY_USAGE);
  if (limit > REQUEST_HISTORY_MAX_PAGE_SIZE) {
    throw new CliUsageError(`--limit must be between 1 and ${REQUEST_HISTORY_MAX_PAGE_SIZE}`, LOG_HISTORY_USAGE);
  }
  if (protocol !== undefined && !PROTOCOLS.includes(protocol as (typeof PROTOCOLS)[number])) {
    throw new CliUsageError(`--protocol must be one of ${PROTOCOLS.join(", ")}`, LOG_HISTORY_USAGE);
  }
  let fallback: boolean | undefined;
  if (fallbackRaw !== undefined) {
    if (fallbackRaw !== "true" && fallbackRaw !== "false") {
      throw new CliUsageError("--fallback must be true or false", LOG_HISTORY_USAGE);
    }
    fallback = fallbackRaw === "true";
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new CliUsageError("--from must not be after --to", LOG_HISTORY_USAGE);
  }
  const data = await runtimeRequest(`/api/request-history${query({
    provider, model, requestedModel, status, conversationId, surface,
    inboundProtocol: protocol, apiKeyId, profileId, fallback, from, to, cursor, limit,
  })}`, {}, deps);
  const page = historyPage(data);
  if (wantsJson) {
    printData(data, true);
    return;
  }
  if (wantsJsonl) {
    for (const row of page.entries) console.log(JSON.stringify(row));
    if (page.hasMore && page.nextCursor) console.error(`nextCursor=${page.nextCursor}`);
    return;
  }
  const indexed = typeof page.index?.indexedRows === "number" ? page.index.indexedRows : undefined;
  if (page.entries.length === 0) {
    printData(data, false, [
      "No request-history row matched the filters.",
      ...(indexed !== undefined ? [`indexedRows=${indexed}`] : []),
    ]);
    return;
  }
  const footer = [
    ...(indexed !== undefined ? [`indexedRows=${indexed}`] : []),
    `hasMore=${page.hasMore}`,
    ...(page.nextCursor ? [`nextCursor=${page.nextCursor}`] : []),
  ];
  printData(data, false, [...page.entries.map(row => formatHistoryRow(row, formatRow)), ...footer]);
}

/** Read one canonical request-history row through GET /api/request-history/{id}. */
export async function handleLogGetCommand(
  argv: string[],
  deps: RuntimeApiDeps,
  formatRow: (row: LogRow) => string,
): Promise<void> {
  const args = [...argv];
  const requestId = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!requestId) throw new CliUsageError("request id is required", GET_USAGE);
  rejectArgs(args, GET_USAGE);
  const result = await runtimeRequest(`/api/request-history/${encodeURIComponent(requestId)}`, {}, deps);
  if (!record(result)) throw new Error("Invalid request-history row. Upgrade the proxy and retry.");
  printData(result, wantsJson, wantsJson ? undefined : [formatHistoryRow(result, formatRow)]);
}
