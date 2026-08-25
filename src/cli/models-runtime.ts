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
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx models live [--provider <name>] [--json]
  ocx models edit <custom-id> [--model-id <id>] [--display-name <name|->]
      [--context-window <tokens|0>] [--modalities <text,image,audio|->]
      [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra|->]
      [--default-reasoning-effort <level|->] [--json]
  ocx models <enable|disable> <provider/model|native-model> [--native] [--json]
  ocx models provider <name> <on|off> [--json]
  ocx models selected <provider> [--set <id,id...>|--clear] [--json]
  ocx models preset show [--provider <name>] [--json]
  ocx models preset apply <provider> [--all] [--json]
  ocx models new-policy [on|off] [--provider <name>] [--json]
  ocx models new-arrivals [--json]
  ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]
  ocx models shadow <status|set> [model|-] [--enabled <on|off>] [--json]`;

type ModelRow = {
  provider?: string;
  id?: string;
  namespaced?: string;
  native?: boolean;
  disabled?: boolean;
  custom?: boolean;
  customId?: string;
  displayName?: string;
};

async function live(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const provider = takeOption(args, "--provider");
  rejectArgs(args, USAGE);
  const rows = await runtimeRequest<ModelRow[]>("/api/models", {}, deps);
  const filtered = provider ? rows.filter(row => row.provider === provider) : rows;
  printData(filtered, wantsJson, filtered.map(row => {
    const flags = [row.native ? "native" : "routed", row.custom ? "custom" : "", row.disabled ? "disabled" : "enabled"].filter(Boolean);
    return `${row.namespaced ?? `${row.provider}/${row.id}`}  [${flags.join(", ")}]`;
  }));
}

async function edit(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (!id) throw new CliUsageError("custom model id is required", USAGE);
  const patch: Record<string, unknown> = {};
  const modelId = takeOption(args, "--model-id");
  const displayName = takeOption(args, "--display-name");
  const contextRaw = takeOption(args, "--context-window");
  const modalitiesRaw = takeOption(args, "--modalities");
  const reasoningEffortsRaw = takeOption(args, "--reasoning-efforts");
  const defaultEffortRaw = takeOption(args, "--default-reasoning-effort");
  rejectArgs(args, USAGE);
  if (modelId !== undefined) patch.modelId = modelId;
  if (displayName !== undefined) patch.displayName = displayName === "-" ? "" : displayName;
  if (contextRaw !== undefined) {
    const value = Number(contextRaw.replace(/[_,]/g, ""));
    if (!Number.isInteger(value) || value < 0) throw new CliUsageError("--context-window must be an integer >= 0", USAGE);
    patch.contextWindow = value === 0 ? null : value;
  }
  if (modalitiesRaw !== undefined) patch.inputModalities = modalitiesRaw === "-" ? [] : csv(modalitiesRaw);
  // "-" restores inheritance by clearing the stored ladder (null); "" stores an explicit
  // empty ladder (the "no reasoning" override, same as the dashboard's uncheck-all).
  // Embedded blank CSV members (`low,,high`, `,,`) are malformed and must be rejected, not
  // silently normalized by csv().
  if (reasoningEffortsRaw !== undefined) {
    if (reasoningEffortsRaw === "-") {
      patch.reasoningEfforts = null;
    } else {
      const trimmed = reasoningEffortsRaw.trim();
      const values = trimmed === "" ? [] : trimmed.split(",").map(value => value.trim());
      if (values.some(value => value === "")) {
        throw new CliUsageError("--reasoning-efforts must be comma-separated values from none, minimal, low, medium, high, xhigh, max, ultra (\"\" for no reasoning, \"-\" to inherit)", USAGE);
      }
      patch.reasoningEfforts = values;
    }
  }
  if (defaultEffortRaw !== undefined) patch.defaultReasoningEffort = defaultEffortRaw === "-" ? null : defaultEffortRaw;
  if (Object.keys(patch).length === 0) throw new CliUsageError("at least one edit option is required", USAGE);
  const result = await runtimeRequest(`/api/custom-models/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  }, deps);
  printData(result, wantsJson, [`Updated custom model ${id}.`]);
}

function parseSelector(selector: string, forceNative: boolean): { provider: string; id: string; native: boolean } {
  if (forceNative || !selector.includes("/")) return { provider: "openai", id: selector, native: true };
  const slash = selector.indexOf("/");
  const provider = selector.slice(0, slash);
  const id = selector.slice(slash + 1);
  if (!provider || !id) throw new CliUsageError("model selector must be provider/model or a native model id", USAGE);
  return { provider, id, native: false };
}

async function visibility(enabled: boolean, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const selector = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const native = takeFlag(args, "--native");
  if (!selector) throw new CliUsageError("model selector is required", USAGE);
  rejectArgs(args, USAGE);
  const target = parseSelector(selector, native);
  const result = await runtimeRequest("/api/model-visibility", {
    method: "PUT",
    body: JSON.stringify({ scope: "models", provider: target.provider, enabled, targets: [{ id: target.id, native: target.native }] }),
  }, deps);
  printData(result, wantsJson, [`${enabled ? "Enabled" : "Disabled"} ${selector}.`]);
}

async function providerVisibility(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim();
  const state = args.shift()?.toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (!provider || (state !== "on" && state !== "off")) throw new CliUsageError("provider and on|off are required", USAGE);
  rejectArgs(args, USAGE);
  const rows = await runtimeRequest<ModelRow[]>("/api/models", {}, deps);
  const targets = rows.filter(row => row.provider === provider && typeof row.id === "string")
    .map(row => ({ id: row.id!, native: row.native === true }));
  if (targets.length === 0) throw new CliUsageError(`no models are available for provider ${provider}`);
  const result = await runtimeRequest("/api/model-visibility", {
    method: "PUT",
    body: JSON.stringify({ scope: "provider", provider, enabled: state === "on", targets }),
  }, deps);
  printData(result, wantsJson, [`${provider}: ${state}`]);
}

async function selected(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const selectedModels = csv(takeOption(args, "--set"));
  const clear = takeFlag(args, "--clear");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  if (selectedModels !== undefined && clear) throw new CliUsageError("--set and --clear cannot be combined", USAGE);
  rejectArgs(args, USAGE);
  if (selectedModels === undefined && !clear) {
    const result = await runtimeRequest<Record<string, unknown>>("/api/selected-models", {}, deps);
    const map = result.selected as Record<string, string[]> | undefined;
    const available = result.available as Record<string, string[]> | undefined;
    const view = { provider, selected: map?.[provider] ?? [], available: available?.[provider] ?? [] };
    printData(view, wantsJson, [`${provider}: ${view.selected.join(", ") || "all models"}`]);
    return;
  }
  const models = clear ? [] : selectedModels!;
  const result = await runtimeRequest("/api/selected-models", {
    method: "PUT",
    body: JSON.stringify({ provider, models }),
  }, deps);
  printData(result, wantsJson, [`${provider}: ${models.length ? models.join(", ") : "all models"}`]);
}


interface ModelPresetView {
  mode: string;
  appliedVersion?: number;
  availableVersion: number;
  presetIds: string[];
  presetCount: number;
  totalCount: number;
  fallback?: string;
}

function presetLine(name: string, view: ModelPresetView): string {
  const parts = [`${name}: mode=${view.mode}`];
  if (view.appliedVersion !== undefined && view.appliedVersion !== view.availableVersion) {
    parts.push(`applied v${view.appliedVersion}, available v${view.availableVersion}`);
  } else {
    parts.push(`preset v${view.availableVersion}`);
  }
  parts.push(`(${view.presetCount} of ${view.totalCount} models)`);
  if (view.fallback) parts.push(`fallback=${view.fallback}`);
  return parts.join(" ");
}

async function preset(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "show").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "show") {
    const only = takeOption(args, "--provider")?.trim();
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<{ providers?: Record<string, ModelPresetView> }>("/api/model-presets", {}, deps);
    const providers = result.providers ?? {};
    const entries = Object.entries(providers).filter(([name]) => !only || name === only);
    const lines = entries.length > 0
      ? entries.map(([name, view]) => presetLine(name, view))
      // A provider with no shipped preset is not an error: it simply has nothing to curate.
      : [only ? `${only}: no model preset is shipped for this provider` : "no providers have a shipped model preset"];
    printData(only ? providers[only] ?? {} : result, wantsJson, lines);
    return;
  }
  if (action !== "apply") throw new CliUsageError(`unknown preset action '${action}'`, USAGE);
  const provider = args.shift()?.trim();
  const all = takeFlag(args, "--all");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);
  const mode = all ? "all" : "preset";
  const result = await runtimeRequest<{ selected?: string[]; fallback?: string; appliedVersion?: number }>(
    "/api/model-presets",
    { method: "PUT", body: JSON.stringify({ provider, mode }) },
    deps,
  );
  const selectedIds = result.selected ?? [];
  const line = result.fallback === "preset-empty"
    // Never silently narrow to nothing: empty means ALL, so a zero-match preset keeps what was
    // there and says so.
    ? `${provider}: preset matched no models — selection unchanged (fallback to all)`
    : all
      ? `${provider}: showing all models (allowlist cleared)`
      : `${provider}: preset v${result.appliedVersion ?? "?"} applied — ${selectedIds.length} models selected`;
  printData(result, wantsJson, [line]);
}

async function newPolicy(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const state = args[0] && !args[0].startsWith("--") ? args.shift()!.toLowerCase() : undefined;
  const provider = takeOption(args, "--provider")?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (state !== undefined && state !== "on" && state !== "off") throw new CliUsageError("new policy must be on or off", USAGE);
  rejectArgs(args, USAGE);
  if (!state) {
    const result = await runtimeRequest<{ policy: string; providers: Record<string, string> }>("/api/model-discovery", {}, deps);
    const value = provider ? result.providers[provider] ?? "inherit" : result.policy;
    printData(provider ? { provider, policy: value } : result, wantsJson, [`${provider ?? "global"}: ${value}`]);
    return;
  }
  const result = await runtimeRequest<{ baselineBootstrapped?: boolean }>("/api/model-discovery", {
    method: "PUT", body: JSON.stringify({ policy: state, provider: provider ?? null }),
  }, deps);
  printData(result, wantsJson, [`${provider ?? "global"}: ${state}${result.baselineBootstrapped ? " (current models recorded as known)" : ""}`]);
}

async function newArrivals(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ recentArrivals: Record<string, Array<{ id: string; at: string; state: string }>> }>("/api/model-discovery", {}, deps);
  const lines = Object.entries(result.recentArrivals).flatMap(([provider, rows]) => rows.map(row => `${provider}/${row.id}  [${row.state}]  ${row.at}`));
  printData(result.recentArrivals, wantsJson, lines.length ? lines : ["no recent model arrivals"]);
}

async function context(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/provider-context-caps", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  let body: Record<string, unknown>;
  if (action === "value") {
    const raw = args.shift();
    if (!raw) throw new CliUsageError("context value is required", USAGE);
    const value = Number(raw.replace(/[_,]/g, ""));
    if (!Number.isInteger(value) || value <= 0) throw new CliUsageError("context value must be a positive integer", USAGE);
    body = { value };
    // Explicit apply-to-all switch for headless use: re-points every routed provider to
    // the new value, mirroring the dashboard's "apply to every routed provider" toggle.
    // Without it the value only becomes the default for future toggles.
    if (takeFlag(args, "--set-all")) body.setAll = true;
  } else if (action === "provider") {
    const provider = args.shift()?.trim();
    const state = args.shift()?.toLowerCase();
    if (!provider || (state !== "on" && state !== "off")) throw new CliUsageError("provider and on|off are required", USAGE);
    body = { provider, enabled: state === "on" };
    // Optional explicit cap value for this provider only (`ocx models context provider
    // openai on --value 128000`). Mirrors the dashboard's per-provider cap picker; the
    // value never leaks to other providers.
    const value = takeIntegerOption(args, "--value", { min: 1 });
    if (value !== undefined && state !== "on") {
      throw new CliUsageError("--value can only be used with on", USAGE);
    }
    if (value !== undefined) body.value = value;
  } else if (action === "all") {
    const state = args.shift()?.toLowerCase();
    if (state !== "on" && state !== "off") throw new CliUsageError("all requires on|off", USAGE);
    body = { setAll: state === "on" };
  } else throw new CliUsageError(`unknown context action ${action}`, USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest("/api/provider-context-caps", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Context cap settings updated."]);
}

async function shadow(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/shadow-call-settings", {}, deps);
    printData(result, wantsJson);
    return;
  }
  if (action !== "set") throw new CliUsageError(`unknown shadow action ${action}`, USAGE);
  const modelRaw = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const enabled = takeBooleanOption(args, "--enabled");
  rejectArgs(args, USAGE);
  const body: Record<string, unknown> = {};
  if (modelRaw !== undefined) body.model = modelRaw === "-" ? "" : modelRaw;
  if (enabled !== undefined) body.enabled = enabled;
  if (Object.keys(body).length === 0) throw new CliUsageError("model and/or --enabled is required", USAGE);
  const result = await runtimeRequest("/api/shadow-call-settings", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Shadow-call settings updated."]);
}

export async function handleModelsRuntimeCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
  let action: (() => Promise<void>) | undefined;
  if (sub === "live") action = () => live(argv, deps);
  else if (sub === "edit") action = () => edit(argv, deps);
  else if (sub === "enable") action = () => visibility(true, argv, deps);
  else if (sub === "disable") action = () => visibility(false, argv, deps);
  else if (sub === "provider") action = () => providerVisibility(argv, deps);
  else if (sub === "selected") action = () => selected(argv, deps);
  else if (sub === "preset") action = () => preset(argv, deps);
  else if (sub === "new-policy") action = () => newPolicy(argv, deps);
  else if (sub === "new-arrivals") action = () => newArrivals(argv, deps);
  else if (sub === "context") action = () => context(argv, deps);
  else if (sub === "shadow") action = () => shadow(argv, deps);
  if (!action) return null;
  return runCliAction(action);
}

export const MODELS_RUNTIME_USAGE = USAGE;
