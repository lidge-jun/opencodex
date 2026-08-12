import {
  CliUsageError,
  csv,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx provider edit <name> [--adapter <id>] [--base-url <url>] [--default-model <id|->]
      [--auth-mode <key|forward|oauth|local|->] [--note <text|->]
      [--api-key-transport <x-api-key|bearer|->]
      [--headers <json>] [--enabled <on|off>] [--live-models <on|off>]
      [--allow-private-network <on|off>] [--json]
  ocx provider test <name> [--json]
  ocx provider quota [--refresh] [--json]
  ocx provider presets [--json]
  ocx provider account-mode <pool|direct> [--json]
  ocx provider selected <name> [--set <model,model...>] [--clear] [--json]`;

function cleared(value: string | undefined): string | undefined {
  return value === "-" ? "" : value;
}

async function edit(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("provider name is required", USAGE);
  const wantsJson = takeFlag(args, "--json");
  const patch: Record<string, unknown> = {};
  const adapter = takeOption(args, "--adapter");
  const baseUrl = takeOption(args, "--base-url");
  const defaultModel = cleared(takeOption(args, "--default-model"));
  const authMode = cleared(takeOption(args, "--auth-mode"));
  const note = cleared(takeOption(args, "--note"));
  const apiKeyTransport = cleared(takeOption(args, "--api-key-transport"));
  const headers = takeOption(args, "--headers");
  const enabled = takeBooleanOption(args, "--enabled");
  const liveModels = takeBooleanOption(args, "--live-models");
  const allowPrivateNetwork = takeBooleanOption(args, "--allow-private-network");
  rejectArgs(args, USAGE);
  if (adapter !== undefined) patch.adapter = adapter;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  if (defaultModel !== undefined) patch.defaultModel = defaultModel;
  if (authMode !== undefined) patch.authMode = authMode;
  if (note !== undefined) patch.note = note;
  if (apiKeyTransport !== undefined) patch.apiKeyTransport = apiKeyTransport;
  if (headers !== undefined) {
    if (headers === "-") {
      patch.headers = null;
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(headers); } catch { throw new CliUsageError("--headers must be valid JSON"); }
      if (parsed === null) {
        patch.headers = null;
      } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliUsageError("--headers must be a JSON object like {\"X-Custom\":\"value\"}");
      } else {
        patch.headers = parsed;
      }
    }
  }
  if (enabled !== undefined) patch.disabled = !enabled;
  if (liveModels !== undefined) patch.liveModels = liveModels;
  if (allowPrivateNetwork !== undefined) patch.allowPrivateNetwork = allowPrivateNetwork;
  if (Object.keys(patch).length === 0) throw new CliUsageError("at least one edit option is required", USAGE);
  const result = await runtimeRequest(`/api/providers?name=${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }, deps);
  printData(result, wantsJson, [`Updated provider ${name}.`]);
}

async function testProvider(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const name = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (!name) throw new CliUsageError("provider name is required", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>(`/api/providers/test?name=${encodeURIComponent(name)}`, {
    method: "POST",
  }, deps);
  if (result.applicable === false) {
    printData(result, wantsJson, [
      `${name}: not applicable`,
      "Static catalog; no live model-discovery endpoint to test.",
    ]);
    return;
  }
  const ok = result.ok === true;
  printData(result, wantsJson, [
    `${name}: ${ok ? "connected" : "failed"}`,
    String(result.message ?? result.error ?? "No detail"),
    `Latency: ${String(result.latencyMs ?? "?")} ms`,
  ]);
  if (!ok) process.exitCode = 1;
}

async function quota(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const refresh = takeFlag(args, "--refresh");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`/api/provider-quotas${refresh ? "?refresh=1" : ""}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function presets(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ providers?: unknown[] } | unknown[]>("/api/provider-presets", {}, deps);
  const rows = Array.isArray(result) ? result : result.providers ?? [];
  printData(result, wantsJson, rows.map(row => {
    const record = row as Record<string, unknown>;
    return `${String(record.id ?? record.name ?? "?")}  ${String(record.label ?? record.adapter ?? "")}`.trimEnd();
  }));
}

async function accountMode(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const mode = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (mode !== "pool" && mode !== "direct") throw new CliUsageError("mode must be pool or direct", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest("/api/providers?name=openai", {
    method: "PATCH",
    body: JSON.stringify({ codexAccountMode: mode }),
  }, deps);
  printData(result, wantsJson, [`OpenAI Codex account mode: ${mode}`]);
}

async function selected(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const name = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const set = csv(takeOption(args, "--set"));
  const clear = takeFlag(args, "--clear");
  if (!name) throw new CliUsageError("provider name is required", USAGE);
  if (set !== undefined && clear) throw new CliUsageError("--set and --clear cannot be combined", USAGE);
  rejectArgs(args, USAGE);
  if (set === undefined && !clear) {
    const result = await runtimeRequest<Record<string, unknown>>("/api/selected-models", {}, deps);
    const selectedMap = (result.selected ?? {}) as Record<string, string[]>;
    const availableMap = (result.available ?? {}) as Record<string, string[]>;
    printData({ provider: name, selected: selectedMap[name] ?? [], available: availableMap[name] ?? [] }, wantsJson,
      [`Selected models for ${name}: ${(selectedMap[name] ?? []).join(", ") || "all"}`]);
    return;
  }
  const models = clear ? [] : (set ?? []);
  const result = await runtimeRequest("/api/selected-models", {
    method: "PUT",
    body: JSON.stringify({ provider: name, models }),
  }, deps);
  printData(result, wantsJson, [`${name}: ${models.length ? models.join(", ") : "all models"}`]);
}

export async function handleProviderRuntimeCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
  const handlers: Record<string, (args: string[], deps: RuntimeApiDeps) => Promise<void>> = {
    edit,
    update: edit,
    test: testProvider,
    quota,
    presets,
    "account-mode": accountMode,
    selected,
  };
  const handler = handlers[sub];
  if (!handler) return null;
  return runCliAction(() => handler(argv, deps));
}

export const PROVIDER_RUNTIME_USAGE = USAGE;
