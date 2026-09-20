import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key get <id-or-name> [--json]
  ocx access key set <id-or-name> [--allow-provider <name>]... [--allow-model <id>]... [--clear] [--json]
  ocx access key rotate <id> [--json]
  ocx access key rotate commit <id> <rotation-id> [--json]
  ocx access key rotate abort <id> <rotation-id> [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`;

/**
 * Render the key table with the usage fields the API already returns (#2705).
 *
 * `usage` is a DISCRIMINATED UNION server-side (`api-key-usage.ts`): the `{ambiguous:true}`
 * variant carries no numbers at all, because when two config entries share an id there IS no
 * per-key total. The union exists specifically so a consumer cannot print a number beside an
 * ambiguity marker, so this renders the word `ambiguous` across the numeric columns rather
 * than a fabricated 0 -- reporting 0 requests for a key that may be in heavy use is the
 * dangerous answer to hand someone deciding what to delete.
 *
 * `attributionSince` and `historyTruncated` describe the DATA SET, not a key, so they print
 * once as a footer. Without `attributionSince`, an absent `lastUsedAt` is unreadable: it
 * could mean "never used" or "nothing is attributable yet".
 */
function formatKeyRows(payload: Record<string, unknown>, keys: Array<Record<string, unknown>>): string[] {
  const cells: string[][] = [["ID", "NAME", "PREFIX", "REQ 7D", "TOTAL", "LAST USED"]];
  for (const entry of keys) {
    const usage = (entry.usage ?? {}) as Record<string, unknown>;
    const ambiguous = usage.ambiguous === true;
    const num = (value: unknown): string => (typeof value === "number" ? value.toLocaleString("en-US") : "-");
    cells.push([
      String(entry.id ?? ""),
      String(entry.name ?? ""),
      String(entry.prefix ?? ""),
      // One marker spanning both numeric columns: the union guarantees neither exists.
      ambiguous ? "ambiguous" : num(usage.requests7d),
      ambiguous ? "" : num(usage.totalRequests),
      ambiguous ? "" : (typeof usage.lastUsedAt === "string" ? usage.lastUsedAt : "never"),
    ]);
  }
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map(row => (row[column] ?? "").length)));
  const lines = cells.map(row => row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
  const footer: string[] = [];
  if (typeof payload.attributionSince === "string") {
    footer.push(`attribution since ${payload.attributionSince}`);
  }
  if (payload.historyTruncated === true) {
    footer.push("older history truncated");
  }
  if (keys.some(entry => (entry.usage as Record<string, unknown> | undefined)?.ambiguous === true)) {
    footer.push("ambiguous: two configured keys share an id, so per-key totals do not exist");
  }
  return footer.length > 0 ? [...lines, "", ...footer] : lines;
}

/**
 * Repeatable option values, in the order given.
 *
 * takeOption removes one occurrence, so a scope with several entries needs the
 * loop: reading it once would silently keep only the first `--allow-model` and
 * write a narrower scope than the operator typed.
 */
function takeAllOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) break;
    values.push(value);
  }
  return values;
}

/**
 * Find a key by id or by name, without ever reading the secret.
 *
 * The management API keys every mutation by id, so a name has to be resolved
 * here. An ambiguous name is refused rather than resolved to the first match:
 * silently scoping one of two keys that share a name is the kind of mistake
 * only discovered when the wrong client stops working.
 */
function findKeyRow(keys: Array<Record<string, unknown>>, selector: string): Record<string, unknown> {
  const wanted = selector.trim().toLowerCase();
  const byId = keys.filter(entry => String(entry.id ?? "").toLowerCase() === wanted);
  if (byId.length === 1) return byId[0]!;
  const byName = keys.filter(entry => String(entry.name ?? "").trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new CliUsageError("key name " + selector + " is ambiguous; use the id", USAGE);
  throw new CliUsageError("no API key matches " + selector, USAGE);
}

function scopeLines(entry: Record<string, unknown>): string[] {
  const list = (value: unknown): string =>
    Array.isArray(value) && value.length > 0 ? (value as string[]).join(", ") : "(any)";
  return [
    "API key " + String(entry.name ?? "") + " (" + String(entry.id ?? "") + ")",
    "  allowed providers: " + list(entry.allowedProviders),
    "  allowed models:    " + list(entry.allowedModels),
  ];
}

async function key(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const keys = Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [];
    printData(result, wantsJson, keys.length ? formatKeyRows(result, keys) : ["No API access keys configured."]);
    return;
  }
  if (action === "create") {
    const name = args.shift() ?? "default";
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, deps);
    // The plaintext key is returned once. Keep text output explicit so callers know to store it.
    printData(result, wantsJson, [
      `Created API key ${String(result.name ?? name)} (${String(result.id ?? "")}).`,
      `Key (shown once): ${String(result.key ?? "")}`,
    ]);
    return;
  }
  if (action === "get") {
    const selector = args.shift();
    if (!selector) throw new CliUsageError("key id or name is required", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const entry = findKeyRow(Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [], selector);
    // The list response carries the masked prefix and never the secret, so the
    // row is safe to print as-is under --json.
    printData(entry, wantsJson, scopeLines(entry));
    return;
  }
  if (action === "set") {
    const selector = args.shift();
    if (!selector) throw new CliUsageError("key id or name is required", USAGE);
    const clear = takeFlag(args, "--clear");
    const providers = takeAllOptions(args, "--allow-provider");
    const models = takeAllOptions(args, "--allow-model");
    rejectArgs(args, USAGE);
    if (!clear && providers.length === 0 && models.length === 0) {
      throw new CliUsageError("set requires --allow-provider, --allow-model, or --clear", USAGE);
    }
    const listed = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const target = findKeyRow(Array.isArray(listed.keys) ? listed.keys as Array<Record<string, unknown>> : [], selector);
    // A set REPLACES the named dimension rather than appending to it, and
    // --clear removes both. Naming one dimension leaves the other alone, so
    // narrowing providers cannot accidentally widen models.
    const body: Record<string, unknown> = { id: target.id };
    if (clear) {
      body.allowedProviders = null;
      body.allowedModels = null;
    }
    if (providers.length > 0) body.allowedProviders = providers;
    if (models.length > 0) body.allowedModels = models;
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {
      method: "PATCH",
      body: JSON.stringify(body),
    }, deps);
    printData(result, wantsJson, scopeLines(result));
    return;
  }
  if (action === "rotate") {
    const operation = args[0] === "commit" || args[0] === "abort" ? args.shift()! : "start";
    const id = args.shift();
    if (!id) throw new CliUsageError("key id is required", USAGE);
    if (operation === "start") {
      rejectArgs(args, USAGE);
      const result = await runtimeRequest<Record<string, unknown>>("/api/keys/rotate", {
        method: "POST",
        body: JSON.stringify({ id }),
      }, deps);
      printData(result, wantsJson, [
        `Started rotation for API key ${id}.`,
        `New key (shown once): ${String(result.key ?? "")}`,
        `After the client accepts it, commit with rotation id ${String(result.rotationId ?? "")}.`,
      ]);
      return;
    }
    const rotationId = args.shift();
    if (!rotationId) throw new CliUsageError("rotation id is required", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest(operation === "commit" ? "/api/keys/rotate/commit" : "/api/keys/rotate", {
      method: operation === "commit" ? "POST" : "DELETE",
      body: JSON.stringify({ id, rotationId }),
    }, deps);
    printData(result, wantsJson, [`${operation === "commit" ? "Committed" : "Aborted"} rotation for API key ${id}.`]);
    return;
  }
  if (action === "remove" || action === "delete") {
    const id = args.shift();
    const yes = takeFlag(args, "--yes");
    if (!id) throw new CliUsageError("key id is required", USAGE);
    if (!yes) throw new CliUsageError("remove requires --yes", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/keys", { method: "DELETE", body: JSON.stringify({ id }) }, deps);
    printData(result, wantsJson, [`Removed API key ${id}.`]);
    return;
  }
  throw new CliUsageError(`unknown key command ${action}`, USAGE);
}

async function endpoints(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
  const view = Object.fromEntries(Object.entries(result).filter(([key]) => key.endsWith("Endpoint") || key === "baseUrl" || key === "endpoint"));
  printData(view, wantsJson, Object.entries(view).map(([name, value]) => `${name}: ${String(value)}`));
}

async function models(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/v1/models", {}, deps);
  const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
  printData(result, wantsJson, rows.map(row => `${String(row.id)}  ${String(row.owned_by ?? "")}`.trimEnd()));
}

async function testModel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const model = args.shift();
  const wantsJson = takeFlag(args, "--json");
  const protocol = takeOption(args, "--protocol") ?? "chat";
  if (!model) throw new CliUsageError("model is required", USAGE);
  if (!(["chat", "responses", "messages"] as const).includes(protocol as "chat" | "responses" | "messages")) {
    throw new CliUsageError("--protocol must be chat, responses, or messages", USAGE);
  }
  rejectArgs(args, USAGE);
  const request = protocol === "responses"
    ? { path: "/v1/responses", body: { model, input: "Reply with OK.", max_output_tokens: 16 } }
    : protocol === "messages"
      ? { path: "/v1/messages", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 } }
      : { path: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16, stream: false } };
  const result = await runtimeRequest(request.path, { method: "POST", body: JSON.stringify(request.body) }, deps);
  printData(result, wantsJson, [`${model}: ${protocol} request succeeded.`]);
}

export async function handleAccessCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "key", ...rest] = argv;
    if (sub === "key" || sub === "keys") await key(rest, deps);
    else if (sub === "endpoints") await endpoints(rest, deps);
    else if (sub === "models") await models(rest, deps);
    else if (sub === "test") await testModel(rest, deps);
    else throw new CliUsageError(`unknown access command ${sub}`, USAGE);
  });
}

export const ACCESS_USAGE = USAGE;
