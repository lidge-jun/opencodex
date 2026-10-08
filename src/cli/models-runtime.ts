import {
  CliUsageError,
  csv,
  printData,
  rejectArgs,
  runCliAction,
  RuntimeApiError,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import { isModelsRuntimeSubcommand } from "./models-runtime-subcommands";
import { MODELS_CONTEXT_USAGE } from "./help-models-context";
import { isValidProviderName } from "../config/provider-name";
import { isValidModelDiscoveryModelId } from "../providers/model-discovery-limits";
import { redactSecretString } from "../lib/redact";
import type { ProviderCostOverlay } from "../types";
import { resolveMatchedPrice } from "../usage/cost";
import { MAX_COST4_RATE } from "../usage/expected-prices";
import { isValidCost4Rate, validCost4 } from "../usage/user-cost-overlays";

const USAGE = `Usage:
  ocx models display-name <provider/raw-model> (--set <text> | --clear) [--json]
  ocx models order status|reset [--json]
  ocx models order set (--models <csv> | --mode <default|alphabetical|provider|most-used>) [--json]
  ocx models live [--provider <name>] [--free-only] [--json]
  ocx models price <provider/model> [--json]
  ocx models set-price <provider/model> --input N --output N [--cache-read N] [--cache-write N] [--json]
  ocx models set-price <provider/model> --auto [--json]
  ocx models edit <custom-id> [--model-id <id>] [--display-name <name|->]
      [--context-window <tokens|0>] [--modalities <text,image,audio|->]
      [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra|->]
      [--default-reasoning-effort <level|->] [--json]
  ocx models set <provider/model> [--context-window <tokens|0|->]
      [--modalities <text,image,audio|->]
      [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra|"">|->]
      [--default-reasoning-effort <level|->] [--reset] [--json]
  ocx models <enable|disable> <provider/model|native-model> [--native] [--json]
  ocx models provider <name> <on|off> [--json]
  ocx models selected <provider> [--set <id,id...>|--clear] [--json]
  ocx models preset show [--provider <name>] [--json]
  ocx models preset apply <provider> [--all] [--json]
  ocx models new-policy [on|off] [--provider <name>] [--json]
  ocx models new-arrivals [--json]
${MODELS_CONTEXT_USAGE}
  ocx models shadow <status|set> [model|-] [--enabled <on|off>] [--json]

Prices are USD per 1M tokens. Omitted cache rates default to 0.
Price selectors use the exact upstream model ID after the first slash.`;

type ModelRow = {
  provider?: string;
  id?: string;
  namespaced?: string;
  native?: boolean;
  disabled?: boolean;
  initialSelectionPending?: boolean;
  custom?: boolean;
  customId?: string;
  displayName?: string;
  pricingStatus?: "free" | "paid";
};

async function live(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const provider = takeOption(args, "--provider");
  // Absent pricingStatus means the provider published no usable per-token pair, so it is
  // excluded here for the same fail-closed reason the classifier omits it (#3666).
  const freeOnly = takeFlag(args, "--free-only");
  rejectArgs(args, USAGE);
  const rows = await runtimeRequest<ModelRow[]>("/api/models", {}, deps);
  const byProvider = provider ? rows.filter(row => row.provider === provider) : rows;
  const filtered = freeOnly ? byProvider.filter(row => row.pricingStatus === "free") : byProvider;
  printData(filtered, wantsJson, filtered.map(row => {
    const flags = [row.native ? "native" : "routed", row.custom ? "custom" : "", row.pricingStatus === "free" ? "free" : "", row.initialSelectionPending ? "initial discovery pending" : row.disabled ? "disabled" : "enabled"].filter(Boolean);
    return `${row.namespaced ?? `${row.provider}/${row.id}`}  [${flags.join(", ")}]`;
  }));
}

function priceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PRICE_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function validPriceCost(value: unknown): value is ProviderCostOverlay {
  return priceRecord(value) && validCost4(value)
    && Object.keys(value).every(key => key === "promptLengthPricing" || (PRICE_RATE_KEYS as readonly string[]).includes(key));
}

async function price(write: boolean, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  try {
    await priceRequest(write, argv, deps);
  } catch (error) {
    // Duplicated, inline and stray options also reach parser diagnostics.
    // Keep HTTP-specific RuntimeApiError exits while masking usage errors.
    if (error instanceof CliUsageError) {
      throw new CliUsageError(redactSecretString(error.message), error.usage);
    }
    throw error;
  }
}

async function priceRequest(write: boolean, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const selector = args.shift() ?? "";
  const slash = selector.indexOf("/");
  const provider = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  if (slash < 1 || !isValidProviderName(provider) || !isValidModelDiscoveryModelId(modelId)) {
    throw new CliUsageError("model selector must be provider/model with an exact upstream model id", USAGE);
  }
  if (redactSecretString(modelId) !== modelId) {
    throw new CliUsageError("modelId cannot be displayed safely", USAGE);
  }
  const wantsJson = takeFlag(args, "--json");
  const path = `/api/providers/${encodeURIComponent(provider)}/model-costs`;
  if (!write) {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<unknown>(path, {}, deps);
    if (!priceRecord(result) || result.provider !== provider || !priceRecord(result.modelCosts)
      || !Object.values(result.modelCosts).every(validPriceCost)) {
      throw new Error("Invalid model price response");
    }
    let cost: ProviderCostOverlay | null = null;
    if (Object.hasOwn(result.modelCosts, modelId)) {
      const stored = result.modelCosts[modelId];
      if (!validPriceCost(stored)) throw new Error("Invalid model price response");
      cost = { ...stored };
    }
    // The API map owns manual overrides; bundled defaults remain derived rather
    // than being persisted as overrides that would mask later catalog updates.
    const effectiveCost = cost
      ? { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite }
      : resolveMatchedPrice(provider, modelId, undefined, [])?.cost4 ?? null;
    printData({ provider, modelId, cost, effectiveCost }, wantsJson, [
      effectiveCost === null ? `${selector}: automatic pricing (unknown)`
        : `${selector}: ${JSON.stringify(effectiveCost)} USD per 1M tokens${cost === null ? " (automatic estimate)" : ""}`,
    ]);
    return;
  }
  const auto = takeFlag(args, "--auto");
  const input = takeOption(args, "--input");
  const output = takeOption(args, "--output");
  const cacheRead = takeOption(args, "--cache-read");
  const cacheWrite = takeOption(args, "--cache-write");
  rejectArgs(args, USAGE);
  if (auto && [input, output, cacheRead, cacheWrite].some(value => value !== undefined)) {
    throw new CliUsageError("--auto cannot be combined with price rates", USAGE);
  }
  if (!auto && (input === undefined || output === undefined)) {
    throw new CliUsageError("--input and --output are required unless --auto is used", USAGE);
  }
  const rate = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!raw.trim() || !isValidCost4Rate(value)) {
      throw new CliUsageError(`${flag} must be a finite number between 0 and ${MAX_COST4_RATE}`, USAGE);
    }
    return value;
  };
  // Validate every rate before any request, so a bad flag never reaches the management plane.
  const rates: ProviderCostOverlay | undefined = auto ? undefined : {
    input: rate(input!, "--input"),
    output: rate(output!, "--output"),
    cacheRead: rate(cacheRead ?? "0", "--cache-read"),
    cacheWrite: rate(cacheWrite ?? "0", "--cache-write"),
  };
  // A base-rate write replaces the whole row, so read the current row first and carry the
  // stored prompt-length policy for exactly this model forward instead of silently deleting it.
  let carriedPromptLengthPricing: ProviderCostOverlay["promptLengthPricing"];
  if (rates) {
    const current = await runtimeRequest<unknown>(path, {}, deps);
    if (!priceRecord(current) || current.provider !== provider || !priceRecord(current.modelCosts)
      || !Object.values(current.modelCosts).every(validPriceCost)) {
      throw new Error("Invalid model price response");
    }
    if (Object.hasOwn(current.modelCosts, modelId)) {
      carriedPromptLengthPricing = (current.modelCosts[modelId] as ProviderCostOverlay).promptLengthPricing;
    }
  }
  const cost: ProviderCostOverlay | null = rates
    ? { ...rates, ...(carriedPromptLengthPricing ? { promptLengthPricing: carriedPromptLengthPricing } : {}) }
    : null;
  const result = await runtimeRequest(path, { method: "PUT", body: JSON.stringify({ modelId, cost }) }, deps);
  // Absent and { mode: "automatic" } are the same policy (the server stores automatic as
  // absent), and key order carries no meaning in a JSON receipt, so compare canonically.
  const canonicalPolicy = (policy: ProviderCostOverlay["promptLengthPricing"]): string =>
    policy === undefined || policy.mode === "automatic" ? `{"mode":"automatic"}`
      : JSON.stringify(policy, (_key, item: unknown) => (item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item));
  const receivedCost = priceRecord(result) ? result.cost : undefined;
  if (!priceRecord(result) || result.ok !== true || result.provider !== provider || result.modelId !== modelId
    || (cost === null ? receivedCost !== null : !validPriceCost(receivedCost)
      || !PRICE_RATE_KEYS.every(key => receivedCost[key] === cost[key])
      || canonicalPolicy(receivedCost.promptLengthPricing) !== canonicalPolicy(cost.promptLengthPricing))) {
    throw new Error("Invalid model price persistence receipt");
  }
  // Project the acknowledged fields only; unrelated response fields are not CLI output.
  printData({ ok: true, provider, modelId, cost }, wantsJson,
    [auto ? `${selector}: automatic pricing restored.` : `${selector}: manual pricing saved.`]);
}

/**
 * True for the management handler's own unknown-id 404, and only that.
 *
 * Two different listeners answer 404 on this route. `src/server/management/model-routes.ts`
 * means "no custom model with that id"; a listener that does not route the request at all
 * reports `{error, method, path}` (src/client/machine-listener.ts), and runtime-api.ts already
 * renders that shape as a routing statement. Narrowing on the absence of `method`/`path` keeps
 * this rewrite from relabelling a not-served-here 404 as a missing record — the exact confusion
 * #4662 was reported as.
 */
function unknownCustomModelId(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record.method === undefined && record.path === undefined;
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
    if (!Number.isSafeInteger(value) || value < 0) throw new CliUsageError("--context-window must be a safe integer >= 0", USAGE);
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
  let result: unknown;
  try {
    result = await runtimeRequest(`/api/custom-models/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }, deps);
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 404 && unknownCustomModelId(error.body)) {
      throw new RuntimeApiError(
        `No custom model has id ${id}. Edits address the custom-model id, not the provider/model slug; list the ids with: ocx models list-custom`,
        404,
        error.body,
      );
    }
    throw error;
  }
  printData(result, wantsJson, [`Updated custom model ${id}.`]);
}

/**
 * Per-model overrides on a routed row: the twin of `ocx models edit` for rows that already
 * exist, rather than for a custom definition.
 *
 * Every option has a clear spelling instead of an empty-value sentinel, because the API treats
 * `null` as "hand this fact back to the registry, the catalog and the provider default". That is
 * a different intent from storing a value that merely looks blank, and collapsing the two is how
 * an override outlives the data it was copied from.
 */
async function setModelSettings(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const selector = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const reset = takeFlag(args, "--reset");
  if (!selector) throw new CliUsageError("model selector is required", USAGE);
  const contextRaw = takeOption(args, "--context-window");
  const modalitiesRaw = takeOption(args, "--modalities");
  const reasoningEffortsRaw = takeOption(args, "--reasoning-efforts");
  const defaultEffortRaw = takeOption(args, "--default-reasoning-effort");
  rejectArgs(args, USAGE);
  const target = parseSelector(selector, false);
  if (target.native) {
    throw new CliUsageError(
      "model settings address a routed model; use provider/model (the native openai lane has no per-model overrides)",
      USAGE,
    );
  }
  const patch: Record<string, unknown> = {};
  if (contextRaw !== undefined) {
    const raw = contextRaw.trim();
    if (raw === "-") patch.contextWindow = null;
    else {
      const value = Number(raw.replace(/[_,]/g, ""));
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new CliUsageError("--context-window must be a safe integer >= 0 (0 or - clears the override)", USAGE);
      }
      patch.contextWindow = value === 0 ? null : value;
    }
  }
  if (modalitiesRaw !== undefined) {
    // "-" is the one spelling that clears. A blank value or a blank member would otherwise
    // become [] after CSV normalization, which the server also reads as "clear".
    const trimmed = modalitiesRaw.trim();
    if (trimmed === "-") patch.inputModalities = null;
    else {
      const members = trimmed.split(",").map(item => item.trim());
      if (members.some(item => !["text", "image", "audio"].includes(item))) {
        throw new CliUsageError("--modalities must list text, image or audio (comma-separated), or - to clear", USAGE);
      }
      patch.inputModalities = [...new Set(members)];
    }
  }
  if (reasoningEffortsRaw !== undefined) {
    // "-" restores inheritance by clearing the stored ladder (null); "" stores an explicit empty
    // ladder, which is the "this model does not reason" override. Embedded blank CSV members
    // (`low,,high`) are malformed and rejected rather than normalized away.
    const trimmed = reasoningEffortsRaw.trim();
    if (trimmed === "-") {
      patch.reasoningEfforts = null;
    } else if (trimmed === "") {
      patch.reasoningEfforts = [];
    } else {
      const values = trimmed.split(",").map(value => value.trim());
      if (values.some(value => value === "")) {
        throw new CliUsageError("--reasoning-efforts must be comma-separated values from none, minimal, low, medium, high, xhigh, max, ultra (\"\" for no reasoning, \"-\" to inherit)", USAGE);
      }
      patch.reasoningEfforts = values;
    }
  }
  if (defaultEffortRaw !== undefined) patch.defaultReasoningEffort = defaultEffortRaw.trim() === "-" ? null : defaultEffortRaw.trim();
  if (reset) {
    if (Object.keys(patch).length > 0) {
      throw new CliUsageError("--reset clears every override and cannot be combined with other options", USAGE);
    }
    for (const key of ["contextWindow", "inputModalities", "reasoningEfforts", "defaultReasoningEffort"]) patch[key] = null;
  }
  if (Object.keys(patch).length === 0) throw new CliUsageError("at least one setting or --reset is required", USAGE);
  const result = await runtimeRequest<{ changed?: boolean; hasOverrides?: boolean; saved?: boolean; catalogRefresh?: { status?: string; retryable?: boolean } }>("/api/model-settings", {
    method: "PUT",
    body: JSON.stringify({ provider: target.provider, modelId: target.id, ...patch }),
  }, deps);
  const message = result?.changed === false
    ? (reset && result.hasOverrides === false ? "Nothing to restore for " + selector + "." : "No settings changed for " + selector + ".")
    : "Updated model settings for " + selector + ".";
  printData(result, wantsJson, [message,
    // A non-retryable skip means there is no managed Codex catalog to refresh, which is normal.
    ...(result?.saved && (result.catalogRefresh?.status === "failed"
      || (result.catalogRefresh?.status === "skipped" && result.catalogRefresh.retryable === true))
      ? ["Settings saved, but the Codex model catalog did not refresh. Run `ocx sync` so Codex picks up the change."] : []),
  ]);
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
    if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError("context value must be a positive safe integer", USAGE);
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
  if (sub === "order" || sub === "display-name") {
    const { handleModelsOrderCommand, handleModelsDisplayNameCommand } = await import("./models-order");
    return sub === "order" ? handleModelsOrderCommand(argv, deps) : handleModelsDisplayNameCommand(argv, deps);
  }
  // The dispatch below and MODELS_RUNTIME_SUBCOMMANDS must name the same set;
  // tests/cli/cli-models-runtime-dispatch.test.ts fails if they drift (#3094).
  if (!isModelsRuntimeSubcommand(sub)) return null;
  let action: (() => Promise<void>) | undefined;
  if (sub === "live") action = () => live(argv, deps);
  else if (sub === "price") action = () => price(false, argv, deps);
  else if (sub === "set-price") action = () => price(true, argv, deps);
  else if (sub === "edit") action = () => edit(argv, deps);
  else if (sub === "set") action = () => setModelSettings(argv, deps);
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
