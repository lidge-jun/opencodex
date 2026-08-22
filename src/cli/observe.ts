import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--limit <n>] [--follow] [--json|--jsonl]
  ocx logs explain <request-id> [--json]
  ocx logs rebuild-index
  ocx logs index-status
  ocx observe usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]
  ocx observe storage [codex-logs [status|protect|unprotect|repair|compact] [--mode <compat|quiet>]] [--json]
  ocx observe memory [--json]
  ocx observe debug [--json]
  ocx observe claude-inbound [--limit <n>] [--json]
  ocx observe injection [--limit <n>] [--json]`;

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

function formatLog(row: LogEntry): string {
  const time = String(row.timestamp ?? row.createdAt ?? "");
  const route = [row.provider, row.model].filter(Boolean).join("/");
  const status = row.status ?? row.statusCode ?? "?";
  const duration = row.durationMs !== undefined ? `${String(row.durationMs)}ms` : "";
  return [time, String(status), route, duration].filter(Boolean).join("  ");
}

async function logs(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const wantsJsonl = takeFlag(args, "--jsonl");
  const follow = takeFlag(args, "--follow") || takeFlag(args, "-f");
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const status = takeOption(args, "--status");
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? 200;
  rejectArgs(args, USAGE);
  if (wantsJson && wantsJsonl) throw new CliUsageError("--json and --jsonl cannot be combined", USAGE);
  if (follow && wantsJson) throw new CliUsageError("--follow uses --jsonl, not --json", USAGE);
  let seen = new Set<string>();
  do {
    const data = await runtimeRequest(`/api/logs${query({ provider, model, status, limit })}`, {}, deps);
    const rows = logRows(data);
    if (!follow && wantsJson) printData(data, true);
    else {
      for (const row of rows) {
        const key = String(row.id ?? `${row.timestamp}:${row.provider}:${row.model}:${row.status}`);
        if (follow && seen.has(key)) continue;
        if (wantsJsonl) console.log(JSON.stringify(row));
        else console.log(formatLog(row));
        seen.add(key);
      }
    }
    if (!follow) return;
    if (seen.size > 5_000) seen = new Set([...seen].slice(-2_500));
    await Bun.sleep(1_000);
  } while (true);
}

async function explain(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const requestId = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!requestId) throw new CliUsageError("request id is required", USAGE);
  rejectArgs(args, USAGE);
  const encoded = encodeURIComponent(requestId);
  const result = await runtimeRequest(`/api/request-history/${encoded}/route-decision`, {}, deps);
  printData(result, wantsJson, wantsJson ? undefined : [JSON.stringify(result, null, 2)]);
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
  const wantsJson = takeFlag(args, "--json");
  const range = takeOption(args, "--range") ?? "30d";
  const surface = takeOption(args, "--surface") ?? "all";
  if (!["7d", "30d", "all"].includes(range)) throw new CliUsageError("--range must be 7d, 30d, or all", USAGE);
  if (!["all", "codex", "claude", "grok"].includes(surface)) throw new CliUsageError("--surface must be all, codex, claude, or grok", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`/api/usage${query({ range, surface })}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
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

export async function handleObserveCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "logs", ...rest] = argv;
    if (sub === "logs") {
      const action = rest[0];
      if (action === "explain") await explain(rest.slice(1), deps);
      else if (action === "rebuild-index") await rebuildIndex(rest.slice(1), deps);
      else if (action === "index-status") await indexStatus(rest.slice(1), deps);
      else await logs(rest, deps);
    }
    else if (sub === "usage") await usage(rest, deps);
    else if (sub === "storage") await storage(rest, deps);
    else if (sub === "memory") await simple("/api/system/memory", rest, deps);
    else if (sub === "debug") await simple("/api/debug", rest, deps);
    else if (sub === "claude-inbound") await simple("/api/claude/inbound-debug", rest, deps);
    else if (sub === "injection") await simple("/api/debug/injection-logs", rest, deps);
    else throw new CliUsageError(`unknown observe command ${sub}`, USAGE);
  });
}

export const OBSERVE_USAGE = USAGE;
