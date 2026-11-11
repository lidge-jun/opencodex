import { CliUsageError, printData, rejectArgs, runCliAction, runtimeRequest, takeFlag, takeOption, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage:
  ocx alias list [--json]
  ocx alias set <provider> <alias>
  ocx alias set <provider>/<native-model-id> <alias>
  ocx alias rm <provider>[/<native-model-id>]
  ocx alias defaults <on|off> [--provider <name>]
  ocx alias template set <provider> <template>
  ocx alias template rm <provider>
  ocx alias template show [<provider>]`;

function selector(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  return slash < 0 ? { provider: value } : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Manage model aliases, consuming JSON output selection before the default list action. */
export async function handleAliasCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => { await runAliasAction(argv, deps); });
}

async function runAliasAction(argv: string[], deps: RuntimeApiDeps): Promise<number> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const action = (args.shift() ?? "list").toLowerCase();
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
  if (action === "template") return runTemplateAction(args, wantsJson, deps);
  if (action === "defaults") {
    const state = args.shift()?.toLowerCase();
    const provider = takeOption(args, "--provider");
    rejectArgs(args, USAGE);
    if (state !== "on" && state !== "off") throw new CliUsageError("defaults requires on or off", USAGE);
    const result = await runtimeRequest("/api/default-aliases", { method: "PUT", body: JSON.stringify({ enabled: state === "on", ...(provider ? { provider } : {}) }) }, deps);
    printData(result, wantsJson, [`Default aliases ${state}${provider ? ` for ${provider}` : " globally"}.`]);
    return 0;
  }
  if (action !== "set" && action !== "rm") throw new CliUsageError(`Unknown alias action: ${action}. See: ocx help alias`, USAGE);
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
  return 0;
}

/**
 * #7705: opt-in per-provider alias templates. The template is stored as text and the aliases are
 * derived when models resolve; `set` prints how many aliases it produces and how many it skipped.
 */
async function runTemplateAction(args: string[], wantsJson: boolean, deps: RuntimeApiDeps): Promise<number> {
  const sub = args.shift()?.toLowerCase();
  if (sub === "show") {
    const provider = args.shift()?.trim();
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<{ templates?: Record<string, string> }>("/api/aliases", {}, deps);
    const templates = Object.entries(result.templates ?? {}).filter(([name]) => !provider || name === provider);
    printData(provider ? { provider, template: Object.fromEntries(templates)[provider] ?? null } : (result.templates ?? {}), wantsJson,
      templates.length ? templates.map(([name, template]) => `${name}: ${template}`) : ["No alias templates configured."]);
    return 0;
  }
  if (sub !== "set" && sub !== "rm") throw new CliUsageError("alias template requires set, rm or show", USAGE);
  const provider = args.shift()?.trim();
  if (!provider) throw new CliUsageError("alias template requires a provider", USAGE);
  const template = sub === "set" ? args.shift() : null;
  if (sub === "set" && !template?.trim()) throw new CliUsageError("alias template set requires a template", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ preview?: { generated: number; skippedTotal?: number; skipped?: unknown[] } }>(
    `/api/providers/${encodeURIComponent(provider)}/alias-template`,
    { method: "PUT", body: JSON.stringify({ template }) },
    deps,
  );
  const skipped = result.preview?.skippedTotal ?? result.preview?.skipped?.length ?? 0;
  printData(result, wantsJson, sub === "set"
    ? [`${provider}: ${template} (${result.preview?.generated ?? 0} aliases, ${skipped} skipped)`]
    : [`Removed the alias template for ${provider}.`]);
  return 0;
}
