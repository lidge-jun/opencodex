/** GUI-equivalent selection within one bounded, observed request-log window. */
import { parseProtocolTraceV1 } from "../protocols/dto";
import { decodeRequestLogCursor } from "../server/request-log-cursor";
import { matchesLogConversationId, normalizeLogConversationId, LOG_CONVERSATION_ID_INPUT_MAX } from "../server/request-log-conversation";
import { CliUsageError, printData, runCliAction, takeFlag, takeOptionWithSyntax } from "./runtime-api";
import { ObservationError, withObserveStream, type ObserveStreamDeps } from "./observe-stream";

type LogRow = Record<string, unknown>;
export interface LogViewFilterDeps extends ObserveStreamDeps { now?: () => number }
const MAX_WINDOW = 2000;
const WINDOWS = { all: undefined, "15m": 15 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 };

function enumOption<T extends string>(args: string[], flag: string, choices: readonly T[], fallback: T): T {
  const value = takeOptionWithSyntax(args, flag)?.value;
  if (value === undefined) return fallback;
  if (!choices.includes(value as T)) throw new CliUsageError(`${flag} must be ${choices.join("|")}`);
  return value as T;
}

function numberOption(args: string[], flag: string, integer = false): number | undefined {
  const raw = takeOptionWithSyntax(args, flag)?.value;
  if (raw === undefined) return undefined;
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW))) {
    throw new CliUsageError(`${flag} must be ${integer ? "an integer between 1 and 2000" : "a finite nonnegative number"}`);
  }
  return value;
}

function parseOptions(argv: string[]) {
  const args = [...argv];
  const json = takeFlag(args, "--json"), jsonl = takeFlag(args, "--jsonl");
  const surface = enumOption(args, "--surface", ["all", "codex", "claude", "grok"], "all");
  const model = (takeOptionWithSyntax(args, "--model")?.value ?? "").trim().toLowerCase();
  const provider = (takeOptionWithSyntax(args, "--provider")?.value ?? "").trim().toLowerCase();
  const status = enumOption(args, "--status", ["all", "success", "errors"], "all");
  const timeWindow = enumOption(args, "--time-window", ["all", "15m", "1h", "24h"], "all");
  const protocolMode = enumOption(args, "--protocol-mode", ["all", "native", "translated", "legacy-bridge", "blocked", "none"], "all");
  const minTokPerSec = numberOption(args, "--min-tok-per-sec");
  const maxTokPerSec = numberOption(args, "--max-tok-per-sec");
  const interceptedOnly = takeFlag(args, "--intercepted-only");
  const conversation = takeOptionWithSyntax(args, "--conversation")?.value;
  const alias = takeOptionWithSyntax(args, "--conversationId")?.value;
  if (conversation !== undefined && alias !== undefined) throw new CliUsageError("Use only one conversation option");
  const rawConversation = conversation ?? alias;
  if (rawConversation !== undefined && (rawConversation.length > LOG_CONVERSATION_ID_INPUT_MAX
    || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(rawConversation) || !normalizeLogConversationId(rawConversation))) {
    throw new CliUsageError("Conversation must be a nonempty, control-free identifier of at most 4096 characters");
  }
  const scanLimit = numberOption(args, "--scan-limit", true) ?? MAX_WINDOW;
  const limit = numberOption(args, "--limit", true) ?? 200;
  if (args.length) throw new CliUsageError("Unknown or repeated option. Use ocx logs filter --help; follow/events are not supported");
  if (json && jsonl) throw new CliUsageError("--json and --jsonl cannot be combined");
  if (minTokPerSec !== undefined && maxTokPerSec !== undefined && minTokPerSec >= maxTokPerSec) {
    throw new CliUsageError("--min-tok-per-sec must be less than --max-tok-per-sec");
  }
  return { json, jsonl, scanLimit, limit, filters: {
    surface, model, provider, status, timeWindow, protocolMode, minTokPerSec, maxTokPerSec,
    interceptedOnly, conversationId: rawConversation?.trim() ?? "",
  } };
}

function record(value: unknown): value is LogRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWindow(body: unknown, limit: number): { logs: LogRow[]; cursor: string | null } {
  let rows: unknown = body;
  let cursor: string | null = null;
  if (record(body)) {
    if (Object.hasOwn(body, "cursor") || Object.hasOwn(body, "reset")) {
      if (typeof body.cursor !== "string" || !decodeRequestLogCursor(body.cursor) || typeof body.reset !== "boolean") {
        throw new ObservationError("Invalid log cursor response. Upgrade the runtime and retry the command.");
      }
      cursor = body.cursor;
      rows = body.logs;
    } else {
      for (const key of ["logs", "entries", "requests"]) {
        if (Object.hasOwn(body, key)) { rows = body[key]; break; }
      }
    }
  }
  if (!Array.isArray(rows) || rows.length > limit || !rows.every(record)) {
    throw new ObservationError("Invalid log window. Check --scan-limit and upgrade the runtime before retrying the command.");
  }
  return { logs: rows, cursor };
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function matches(row: LogRow, filters: ReturnType<typeof parseOptions>["filters"], now: number): boolean {
  const { surface, status, protocolMode, model, provider, conversationId } = filters;
  if (surface === "codex" && row.surface !== undefined) return false;
  if (surface === "claude" && row.surface !== "claude" && row.surface !== "claude-desktop") return false;
  if (surface === "grok" && row.surface !== "grok") return false;
  if (filters.interceptedOnly && typeof row.shadowCallRewrittenFrom !== "string") return false;
  if (protocolMode !== "all") {
    const mode = parseProtocolTraceV1(row.protocolTrace)?.mode;
    if (protocolMode === "none" ? mode !== undefined : mode !== protocolMode) return false;
  }
  if (conversationId && !matchesLogConversationId(typeof row.conversationId === "string" ? row.conversationId : undefined, conversationId)) return false;
  if (status !== "all") {
    if (typeof row.status !== "number" || !Number.isInteger(row.status)) return false;
    if (status === "success" ? row.status < 200 || row.status >= 300 : row.status < 400 || row.status > 599) return false;
  }
  const attempts = Array.isArray(row.attempts) ? row.attempts.filter(record) : [];
  if (model && ![row.model, row.resolvedModel, row.servedModel, ...attempts.map(attempt => attempt.model)].some(value => normalized(value) === model)) return false;
  if (provider && ![row.provider, ...attempts.map(attempt => attempt.provider)].some(value => normalized(value) === provider)) return false;
  const duration = WINDOWS[filters.timeWindow];
  if (duration !== undefined && (typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp) || row.timestamp < now - duration)) return false;
  const metric = record(row.displayMetrics) ? row.displayMetrics.tokPerSecond : undefined;
  const speed = record(metric) && metric.kind === "value" && typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : undefined;
  if (filters.minTokPerSec !== undefined && (speed === undefined || speed < filters.minTokPerSec)) return false;
  if (filters.maxTokPerSec !== undefined && (speed === undefined || speed >= filters.maxTokPerSec)) return false;
  return true;
}

/** argv starts after `logs filter`; the shared renderer escapes human row values. */
export async function handleLogFilterCommand(
  argv: string[], deps: LogViewFilterDeps, formatRow: (row: LogRow) => string,
): Promise<number> {
  let result = 0;
  const parsingExit = await runCliAction(async () => {
    const options = parseOptions(argv);
    result = await withObserveStream(deps, async stream => {
      const snapshot = parseWindow(await stream.get("/api/logs", new URLSearchParams({ limit: String(options.scanLimit) })), options.scanLimit);
      stream.signal.throwIfAborted();
      const now = (deps.now ?? Date.now)();
      const selected = snapshot.logs.filter(row => matches(row, options.filters, now));
      const logs = selected.slice(-options.limit);
      const window = { scanLimit: options.scanLimit, loaded: snapshot.logs.length, matched: selected.length, returned: logs.length, limit: options.limit };
      if (options.json) printData({ schemaVersion: 1, logs, cursor: snapshot.cursor, filters: options.filters, window }, true);
      else if (options.jsonl) {
        for (const row of logs) { stream.signal.throwIfAborted(); console.log(JSON.stringify(row)); }
      } else {
        printData(null, false, [
          `${logs.length} returned / ${selected.length} matched / ${snapshot.logs.length} scanned (current window; scan limit ${options.scanLimit}, output limit ${options.limit}).`,
          ...(logs.length ? logs.map(formatRow) : ["No matching logs in this window. Widen filters or increase --scan-limit to inspect a larger current window."]),
        ]);
      }
    }, { kind: "snapshot", limitOption: "--scan-limit" });
  });
  return parsingExit || result;
}
