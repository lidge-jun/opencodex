import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  takeOptionWithSyntax,
  type RuntimeApiDeps,
} from "./runtime-api";
import { followLogs } from "./log-follow";
import { handleLogFilterCommand } from "./log-view-filter";
import { followInjection } from "./injection-follow";
import type { ObserveStreamDeps } from "./observe-stream";
import { formatUsageReport } from "./usage-report";
import { selectUsageModelView, takeUsageSearchOption } from "./usage-model-search";
import { USAGE_RANGES, USAGE_SURFACES, type UsageSummary, type UsageFilterEcho } from "../usage/summary";
import { parseUsageTimeWindow, type UsageTimeWindow } from "../usage/time-range";
import { redactSecretString } from "../lib/redact";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { fetchHubUsage } from "../client/hub-client";
import type { HubUsageReport } from "../remote/hub-usage";

const USAGE = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--conversation <id>] [--account <label>] [--limit <n>] [--follow] [--json|--jsonl] [--events]
  ocx logs explain <request-id> [--json]
  ocx logs filter [selectors] [--scan-limit <1..2000>] [--limit <1..2000>] [--json|--jsonl]
  ocx logs rebuild-index
  ocx logs index-status
  ocx observe usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>]
      [--since <epoch-ms|ISO-datetime>] [--until <epoch-ms|ISO-datetime>]
      [--provider <name>] [--model <id>] [--api-key-id <id>] [--search <text>] [--json]
  ocx observe storage [codex-logs [status|protect|unprotect|repair|compact] [--mode <compat|quiet>]] [--json]
  ocx observe memory [--json]
  ocx observe debug [--json]
  ocx observe claude-inbound [--limit <n>] [--json]
  ocx observe injection [--limit <n>] [--follow [--jsonl]] [--json]`;

type LogEntry = Record<string, unknown> & { id?: string | number; timestamp?: string; provider?: string; model?: string; status?: number };

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function logRows(data: unknown): LogEntry[] {
  if (Array.isArray(data)) return data as LogEntry[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["logs", "entries", "requests"]) if (Array.isArray(record[key])) return record[key] as LogEntry[];
  }
  return [];
}

/** Render one human log row with an exact, control-free request ID suitable for history lookup. */
function formatLog(row: LogEntry): string {
  const time = String(row.timestamp ?? row.createdAt ?? "");
  const route = [row.provider, row.model].filter(Boolean).join("/");
  const status = row.status ?? row.statusCode ?? "?";
  const duration = row.durationMs !== undefined ? `${String(row.durationMs)}ms` : "";
  // The conversation id is shown because a conversation FILTER whose output never names the
  // conversation is hard to trust: an empty result and a wrong-id result look identical (#2704).
  const conversation = typeof row.conversationId === "string" && row.conversationId.length > 0
    ? `conv=${row.conversationId}`
    : "";
  // The account label is printed for the same reason, and for one more: it is the answer to
  // "which of my accounts served this?" (#4057). It is only ever the stable non-PII label the
  // proxy already persists (`main`, `p<hex6>`, `o<hex6>`) — never an email, a key, or an
  // upstream account id. Rows from a single-account provider carry no label and print none.
  const account = typeof row.accountLogLabel === "string" && row.accountLogLabel.length > 0
    ? `acct=${row.accountLogLabel}`
    : "";
  const requestId = typeof row.requestId === "string" && row.requestId.length > 0
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(row.requestId)
    ? `id=${row.requestId}` : "";
  return [time, String(status), route, duration, account, conversation, requestId].filter(Boolean).join("  ");
}

/** Read or follow request logs while preserving raw JSON and JSONL output. */
async function logs(argv: string[], deps: ObserveStreamDeps): Promise<number> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const wantsEvents = takeFlag(args, "--events");
  const wantsJsonl = takeFlag(args, "--jsonl") || wantsEvents;
  const follow = takeFlag(args, "--follow") || takeFlag(args, "-f");
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const status = takeOption(args, "--status");
  // Both spellings, because the server accepts both (`request-log.ts:1032`) and an operator
  // should not have to remember which one this surface wanted.
  const conversationId = takeOption(args, "--conversation") ?? takeOption(args, "--conversationId");
  // Server-side, so `--limit` caps the rows that MATCHED rather than the rows scanned; a
  // client-side filter after a 200-row cap would silently hide older matches.
  const account = takeOption(args, "--account");
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? 200;
  rejectArgs(args, USAGE);
  if (wantsJson && wantsJsonl) throw new CliUsageError("--json and --jsonl cannot be combined", USAGE);
  if (follow && wantsJson) {
    throw new CliUsageError("--follow cannot be combined with --json; use --jsonl for streaming JSONL", USAGE);
  }
  if (wantsEvents && !follow) throw new CliUsageError("--events requires --follow", USAGE);
  const params = { provider, model, status, conversationId, account, limit };
  if (follow) {
    if (limit > 2000) throw new CliUsageError("--limit must be between 1 and 2000 for follow", USAGE);
    return followLogs({ query: new URLSearchParams(query(params)), limit, jsonl: wantsJsonl, events: wantsEvents, formatRow: formatLog }, deps);
  }
  const data = await runtimeRequest(`/api/logs${query(params)}`, {}, deps);
  if (wantsJson) printData(data, true);
  else for (const row of logRows(data)) {
    if (wantsJsonl) console.log(JSON.stringify(row));
    else console.log(formatLog(row));
  }
  return 0;
}

async function explain(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const requestId = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!requestId) throw new CliUsageError("request id is required", USAGE);
  rejectArgs(args, USAGE);
  const encoded = encodeURIComponent(requestId);
  const result = await runtimeRequest(`/api/request-history/${encoded}/route-decision`, {}, deps);
  // One entry per line: printData escapes control characters per entry, so a single
  // pretty-printed string would print its line breaks as literal `\x0a`.
  printData(result, wantsJson, wantsJson ? undefined : JSON.stringify(result, null, 2).split("\n"));
}

async function rebuildIndex(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const { rebuildRequestHistoryIndex } = await import("../routing/history/indexer");
  const meta = await rebuildRequestHistoryIndex();
  if (wantsJson) printData(meta, true);
  else {
    console.log(`Request-history index rebuilt (${meta.dbPath})`);
    console.log(`  schema version: ${meta.schemaVersion}`);
    console.log(`  indexed rows:   ${meta.indexedRows}`);
    console.log(`  source size:    ${meta.sourceSize} bytes`);
    console.log(`  last error:     ${meta.lastError ?? "none"}`);
  }
}

async function indexStatus(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const { requestHistoryIndexStatus } = await import("../routing/history/indexer");
  const meta = await requestHistoryIndexStatus();
  if (wantsJson) printData(meta, true);
  else {
    console.log(`Request-history index (${meta.dbPath})`);
    console.log(`  schema version: ${meta.schemaVersion}`);
    console.log(`  indexed rows:   ${meta.indexedRows}`);
    console.log(`  source size:    ${meta.sourceSize} bytes`);
    console.log(`  indexed offset: ${meta.indexedOffset} bytes`);
    console.log(`  last error:     ${meta.lastError ?? "none"}`);
  }
}

async function usage(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const search = takeUsageSearchOption(args);
  const wantsJson = takeFlag(args, "--json");
  const range = takeOption(args, "--range") ?? "30d";
  const surface = takeOption(args, "--surface") ?? "all";
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const since = takeOption(args, "--since");
  const until = takeOption(args, "--until");
  const rawKeyId = takeOptionWithSyntax(args, "--api-key-id")?.value;
  const apiKeyId = rawKeyId?.trim();
  if (apiKeyId !== undefined && !apiKeyId) throw new CliUsageError("--api-key-id must not be blank", USAGE);
  let window: UsageTimeWindow | undefined;
  try {
    window = parseUsageTimeWindow(since, until);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : "invalid usage time window", USAGE);
  }
  // `1d` is accepted here as well as server-side so the CLI does not reject an
  // alias the API would have understood.
  const ranges = [...USAGE_RANGES, "1d"];
  if (!ranges.includes(range)) throw new CliUsageError(`--range must be one of ${USAGE_RANGES.join(", ")} (1d aliases today)`, USAGE);
  if (!USAGE_SURFACES.includes(surface as (typeof USAGE_SURFACES)[number])) {
    throw new CliUsageError(`--surface must be one of ${USAGE_SURFACES.join(", ")}`, USAGE);
  }
  rejectArgs(args.map(redactSecretString), USAGE);
  const suffix = query({ range, surface, provider, model, apiKeyId, since: window?.since, until: window?.until });
  const connection = readClientConnectionState();
  let result: (UsageSummary & { filter?: UsageFilterEcho }) | HubUsageReport;
  if (connection.kind === "invalid" || connection.kind === "mismatched") {
    throw new Error(`Client usage unavailable: ${connection.reason}`);
  }
  if (connection.kind === "connected") {
    if (apiKeyId !== undefined) throw new CliUsageError("--api-key-id is unavailable on connected clients; run on the hub for a selected key, or omit it for this client's usage", USAGE);
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== connection.value.tokenFingerprint) {
      throw new Error("Client usage unavailable: the enrolled data key is missing or changed; repair the client connection");
    }
    result = await fetchHubUsage(connection.value.serverUrl, token.token, new URLSearchParams(suffix), {
      fetchImpl: deps.fetchImpl, timeoutMs: 60_000,
    });
    const current = readClientConnectionState();
    const currentToken = readServiceApiTokenState();
    if (current.kind !== "connected" || !sameClientConnectionOwner(current.value, connection.value)
      || current.value.tokenFingerprint !== token.fingerprint
      || currentToken.kind !== "present" || currentToken.fingerprint !== token.fingerprint) {
      throw new Error("Client connection changed while reading usage; retry for the current connection");
    }
  } else {
    if (apiKeyId === undefined) result = await runtimeRequest<UsageSummary>(`/api/usage${suffix}`, {}, deps);
    else {
      try {
        result = await runtimeRequest<UsageSummary & { filter?: UsageFilterEcho }>(`/api/usage${suffix}`, { redirect: "error", credentials: "omit" }, deps);
      } catch (error) {
        if (error instanceof RuntimeApiError && error.code === "proxy_not_running") throw error;
        throw new Error("Key-scoped usage could not be read. Check runtime access and retry.");
      }
      if (result?.filter?.apiKeyId !== apiKeyId) {
        throw new Error("The server did not confirm the requested API key scope. Upgrade and restart the proxy, then retry.");
      }
    }
  }
  // Older daemons ignore custom bounds and return successful preset reports.
  if (window && (result?.customWindow !== true || result.since !== window.since || result.until !== window.until)) {
    throw new Error("The server did not confirm the requested custom usage window. Upgrade and restart the proxy, then retry.");
  }
  // Built only when it will be printed: JavaScript evaluates arguments before
  // the call, so passing formatUsageReport(...) inline would run the human
  // renderer during --json and let its assumptions affect a path that is meant
  // to bypass it entirely.
  const view = search === undefined ? undefined : selectUsageModelView(result, search);
  const displayed = view ?? result;
  if (wantsJson) printData(displayed, true);
  else printData(displayed, false, formatUsageReport(displayed as Parameters<typeof formatUsageReport>[0], view ? { modelView: view.modelView } : undefined));
}

async function simple(path: string, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const limit = takeIntegerOption(args, "--limit", { min: 1 });
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`${path}${query({ limit })}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function storage(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  if (argv[0] !== "codex-logs") {
    await simple("/api/storage", argv, deps);
    return;
  }

  const args = argv.slice(1);
  const action = args[0] && !args[0].startsWith("-") ? args.shift()! : "status";
  const wantsJson = takeFlag(args, "--json");
  const mode = takeOption(args, "--mode");
  rejectArgs(args, USAGE);

  let result: unknown;
  if (action === "status") {
    if (mode !== undefined) throw new CliUsageError("--mode is only valid with codex-logs protect", USAGE);
    result = await runtimeRequest("/api/storage/codex-logs", {}, deps);
  } else if (action === "protect") {
    const requestedMode = mode ?? "compat";
    if (requestedMode !== "compat" && requestedMode !== "quiet") {
      throw new CliUsageError("--mode must be compat or quiet", USAGE);
    }
    result = await runtimeRequest("/api/storage/codex-logs/protect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: requestedMode }),
    }, deps);
  } else if (action === "unprotect" || action === "repair" || action === "compact") {
    if (mode !== undefined) throw new CliUsageError("--mode is only valid with codex-logs protect", USAGE);
    result = await runtimeRequest(`/api/storage/codex-logs/${action}`, { method: "POST" }, deps);
  } else {
    throw new CliUsageError(`unknown codex-logs action ${action}`, USAGE);
  }

  printData(result, wantsJson, summaryLines(result));
}

async function injection(argv: string[], deps: ObserveStreamDeps): Promise<number> {
  const args = [...argv];
  const follow = takeFlag(args, "--follow");
  const jsonl = takeFlag(args, "--jsonl");
  if (!follow) {
    if (jsonl) throw new CliUsageError("--jsonl requires --follow for injection logs", USAGE);
    await simple("/api/debug/injection-logs", args, deps);
    return 0;
  }
  if (takeFlag(args, "--json")) throw new CliUsageError("--follow cannot be combined with --json; use --jsonl", USAGE);
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? 500;
  if (limit > 2000) throw new CliUsageError("--limit must be between 1 and 2000 for follow", USAGE);
  rejectArgs(args, USAGE);
  return followInjection(limit, jsonl, deps);
}

export async function handleObserveCommand(argv: string[], deps: ObserveStreamDeps = {}): Promise<number> {
  let streamExit = 0;
  const exit = await runCliAction(async () => {
    const [sub = "logs", ...rest] = argv;
    if (sub === "logs") {
      const action = rest[0];
      if (action === "filter") streamExit = await handleLogFilterCommand(rest.slice(1), deps, formatLog);
      else if (action === "explain") await explain(rest.slice(1), deps);
      else if (action === "rebuild-index") await rebuildIndex(rest.slice(1), deps);
      else if (action === "index-status") await indexStatus(rest.slice(1), deps);
      else streamExit = await logs(rest, deps);
    }
    else if (sub === "usage") await usage(rest, deps);
    else if (sub === "storage") await storage(rest, deps);
    else if (sub === "memory") await simple("/api/system/memory", rest, deps);
    else if (sub === "debug") await simple("/api/debug", rest, deps);
    else if (sub === "claude-inbound") await simple("/api/claude/inbound-debug", rest, deps);
    else if (sub === "injection") streamExit = await injection(rest, deps);
    else throw new CliUsageError(`unknown observe command ${sub}`, USAGE);
  });
  return exit || streamExit;
}

export const OBSERVE_USAGE = USAGE;
