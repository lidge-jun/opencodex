import { CliUsageError, printData, rejectArgs, runtimeRequest, takeFlag, takeOption, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage:
  ocx alias list [--json]
  ocx alias set <provider> <alias>
  ocx alias set <provider>/<native-model-id> <alias>
  ocx alias rm <provider>[/<native-model-id>]
  ocx alias defaults <on|off> [--provider <name>]`;

function selector(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  return slash < 0 ? { provider: value } : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export async function handleAliasCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/aliases", {}, deps);
    const lines: string[] = [];
    for (const [target, alias] of Object.entries((result.providers ?? {}) as Record<string, string>)) lines.push(`provider  ${target}  ${alias}  user`);
    for (const [provider, rows] of Object.entries((result.models ?? {}) as Record<string, Record<string, { alias: string; source: string }>>)) {
      for (const [model, value] of Object.entries(rows)) lines.push(`model     ${provider}/${model}  ${value.alias}  ${value.source}`);
    }
    printData(result, wantsJson, lines.length ? lines : ["No aliases configured."]);
    return 0;
  }
  if (action === "defaults") {
    const state = args.shift()?.toLowerCase();
    const provider = takeOption(args, "--provider");
    rejectArgs(args, USAGE);
    if (state !== "on" && state !== "off") throw new CliUsageError("defaults requires on or off", USAGE);
    const result = await runtimeRequest("/api/default-aliases", { method: "PUT", body: JSON.stringify({ enabled: state === "on", ...(provider ? { provider } : {}) }) }, deps);
    printData(result, wantsJson, [`Default aliases ${state}${provider ? ` for ${provider}` : " globally"}.`]);
    return 0;
  }
  const target = args.shift()?.trim();
  if (!target) throw new CliUsageError("alias target is required", USAGE);
  const parsed = selector(target);
  if (!parsed.provider || parsed.model === "") throw new CliUsageError("target must be provider or provider/native-model-id", USAGE);
  if (action === "set") {
    const alias = args.shift()?.trim();
    rejectArgs(args, USAGE);
    if (!alias) throw new CliUsageError("alias value is required", USAGE);
    const path = parsed.model === undefined
      ? `/api/providers/${encodeURIComponent(parsed.provider)}/alias`
      : `/api/providers/${encodeURIComponent(parsed.provider)}/model-aliases`;
    const body = parsed.model === undefined ? { alias } : { set: { [parsed.model]: alias } };
    const result = await runtimeRequest(path, { method: "PUT", body: JSON.stringify(body) }, deps);
    printData(result, wantsJson, [`${target} → ${alias}`]);
    return 0;
  }
  if (action === "rm") {
    rejectArgs(args, USAGE);
    const path = parsed.model === undefined
      ? `/api/providers/${encodeURIComponent(parsed.provider)}/alias`
      : `/api/providers/${encodeURIComponent(parsed.provider)}/model-aliases`;
    const body = parsed.model === undefined ? { alias: null } : { remove: [parsed.model] };
    const result = await runtimeRequest(path, { method: "PUT", body: JSON.stringify(body) }, deps);
    printData(result, wantsJson, [`Removed alias for ${target}.`]);
    return 0;
  }
  throw new CliUsageError(`unknown alias action '${action}'`, USAGE);
}
