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
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`;

async function key(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const keys = Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [];
    printData(result, wantsJson, keys.length
      ? keys.map(entry => `${String(entry.id)}  ${String(entry.name)}  ${String(entry.prefix ?? "")}`)
      : ["No API access keys configured."]);
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
