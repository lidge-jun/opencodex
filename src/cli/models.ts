/**
 * `ocx models` subcommand — list configured models and manage custom models.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { syncModelsToCodex } from "../codex/sync";
import { hasOwnProvider, isValidProviderName, loadConfig, saveConfig } from "../config";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort, modelRecordValue } from "../reasoning-effort";
import { encodedModelIdCollides, routedSlug, slugEquals } from "../providers/slug-codec";
import { knownModelIdsForProvider } from "../router";
import { findLiveProxy } from "../server/proxy-liveness";
import { modelInList, type OcxConfig, type OcxCustomModel } from "../types";

const ADD_USAGE = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>]";
const REMOVE_USAGE = "Usage: ocx models remove <customId|provider/modelId> [--yes]";
const LIST_CUSTOM_USAGE = "Usage: ocx models list-custom [--json]";
const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

/**
 * Parse and validate the reasoning flags shared by `ocx models add` (offline path).
 * "-" means "inherit" and omits the field entirely; "" means an explicit empty ladder
 * ("no reasoning" override, the same state the dashboard stores for the toggle-off
 * checkbox set). Malformed CSV like `low,,high` or `,,` is rejected instead of being
 * silently normalized. Values are canonicalized into Codex ladder order so the stored
 * config matches what the API stores.
 */
export function parseReasoningArgs(
  reasoningEffortsValue: string | undefined,
  defaultEffortValue: string | undefined,
): { reasoningEfforts?: string[]; defaultReasoningEffort?: string; error?: string } {
  if (reasoningEffortsValue === undefined && defaultEffortValue === undefined) return {};
  let reasoningEfforts: string[] | undefined;
  if (reasoningEffortsValue !== undefined) {
    const trimmed = reasoningEffortsValue.trim();
    if (trimmed === "-") {
      reasoningEfforts = undefined;
    } else if (trimmed === "") {
      // Explicit no-reasoning override, exactly like the API's [] / the dashboard's
      // uncheck-all state.
      reasoningEfforts = [];
    } else {
      const parts = trimmed.split(",").map(value => value.trim());
      if (parts.some(part => part === "")) {
        return { error: "--reasoning-efforts must be comma-separated values from none, minimal, low, medium, high, xhigh, max, ultra (\"\" for no reasoning, \"-\" to inherit)" };
      }
      const invalid = parts.filter(value => !isDeclaredReasoningEffort(value));
      if (invalid.length > 0) {
        return { error: `unsupported reasoning effort: ${invalid.join(", ")} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
      }
      reasoningEfforts = canonicalizeReasoningEfforts(parts);
    }
  }
  let defaultReasoningEffort: string | undefined;
  if (defaultEffortValue !== undefined) {
    const trimmed = defaultEffortValue.trim();
    if (trimmed === "-") {
      defaultReasoningEffort = undefined;
    } else {
      if (!isDeclaredReasoningEffort(trimmed)) {
        return { error: `unsupported reasoning effort: ${trimmed} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
      }
      if (!reasoningEfforts || reasoningEfforts.length === 0) {
        return { error: "--default-reasoning-effort requires --reasoning-efforts" };
      }
      if (!reasoningEfforts.includes(trimmed)) {
        return { error: `--default-reasoning-effort "${trimmed}" is not in the declared reasoning efforts` };
      }
      defaultReasoningEffort = trimmed;
    }
  }
  return { reasoningEfforts, defaultReasoningEffort };
}

interface ModelEntry {
  provider: string;
  model: string;
  isDefault: boolean;
  contextWindow: number | null;
  inputModalities: string[] | null;
  reasoningEfforts: string[] | null;
}

function collectModels(config: OcxConfig, providerFilter?: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const providers = providerFilter
    ? { [providerFilter]: config.providers[providerFilter] }
    : config.providers;

  for (const [provName, prov] of Object.entries(providers)) {
    if (!prov) continue;
    const seen = new Set<string>();
    const contextWindows = prov.modelContextWindows ?? {};
    const inputModalities = prov.modelInputModalities ?? {};
    const reasoningEfforts = prov.modelReasoningEfforts ?? {};
    const globalContext = prov.contextWindow ?? null;

    const addModel = (model: string, isDefault: boolean) => {
      if (seen.has(model)) return;
      seen.add(model);

      // Resolve exactly as the runtime does, or this command reports capabilities the
      // proxy will not honour: `isModelTextOnly` matches noVisionModels with modelInList
      // and reads modelInputModalities with modelRecordValue, so a `gpt-oss` entry covers
      // `gpt-oss:120b`. A bare lookup reported that model as unclassified on every field.
      // noVisionModels is checked first because `isModelTextOnly` returns true on that
      // match before it ever reads modelInputModalities: a `gpt-oss` noVision entry beats
      // an exact `gpt-oss:120b` entry that lists "image", and the proxy rejects the image.
      const noVision = modelInList(prov.noVisionModels, model);
      const modalities = noVision ? ["text"] : (modelRecordValue(inputModalities, model) ?? null);
      const efforts = modelRecordValue(reasoningEfforts, model) ?? prov.reasoningEfforts ?? null;

      entries.push({
        provider: provName,
        model,
        isDefault,
        contextWindow: modelRecordValue(contextWindows, model) ?? globalContext,
        inputModalities: modalities,
        reasoningEfforts: efforts,
      });
    };

    // defaultModel first
    if (prov.defaultModel) addModel(prov.defaultModel, true);

    // models array
    if (prov.models) {
      for (const m of prov.models) addModel(m, m === prov.defaultModel);
    }
  }

  return entries;
}

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function fail(message: string, usage?: string): never {
  console.error(`Error: ${message}`);
  if (usage) console.error(usage);
  process.exit(1);
}

function rejectUnexpectedArgs(args: string[], usage: string): void {
  if (args.length === 0) return;
  const unknown = args.filter(arg => arg.startsWith("-"));
  fail(
    unknown.length > 0
      ? `Unknown flag(s): ${unknown.join(", ")}`
      : `Unexpected argument(s): ${args.join(", ")}`,
    usage,
  );
}

async function syncCustomModelsIfLive(): Promise<void> {
  const live = await findLiveProxy();
  if (!live) return;
  const synced = await syncModelsToCodex(live.port).catch(error => {
    console.error(`Warning: custom model saved, but catalog sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (synced?.status === "skipped") {
    console.log("Custom model saved; Codex integration is OFF, so its catalog was not changed.");
  }
}

async function handleCustomAdd(args: string[]): Promise<void> {
  const rest = [...args];
  const provider = rest.shift()?.trim() ?? "";
  const modelId = rest.shift()?.trim() ?? "";
  const displayNameValue = consumeFlagValue(rest, "--display-name");
  const contextWindowValue = consumeFlagValue(rest, "--context-window");
  const modalitiesValue = consumeFlagValue(rest, "--modalities");
  const reasoningEffortsValue = consumeFlagValue(rest, "--reasoning-efforts");
  const defaultEffortValue = consumeFlagValue(rest, "--default-reasoning-effort");
  rejectUnexpectedArgs(rest, ADD_USAGE);

  if (!provider || !modelId) fail("provider and modelId are required", ADD_USAGE);
  if (!isValidProviderName(provider)) fail(`invalid provider name "${provider}"`);

  const config = loadConfig();
  if (!hasOwnProvider(config.providers, provider)) {
    fail(`provider "${provider}" is not configured. See: ocx provider list`);
  }

  const displayName = displayNameValue?.trim() || undefined;
  if (displayName?.includes("/")) fail("displayName must not contain /");

  let contextWindow: number | undefined;
  if (contextWindowValue !== undefined) {
    contextWindow = Number(contextWindowValue);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      fail("context window must be a positive integer");
    }
  }

  let inputModalities: string[] | undefined;
  if (modalitiesValue !== undefined) {
    inputModalities = modalitiesValue.split(",").map(value => value.trim());
    const invalid = inputModalities.filter(value => !ALLOWED_MODALITIES.has(value));
    if (inputModalities.length === 0 || invalid.length > 0) {
      fail("modalities must be comma-separated values from text|image|audio");
    }
    inputModalities = [...new Set(inputModalities)];
  }

  const parsed = parseReasoningArgs(reasoningEffortsValue, defaultEffortValue);
  if (parsed.error) fail(parsed.error);

  const existing = config.customModels ?? [];
  const slug = routedSlug(provider, modelId);
  if (existing.some(model => routedSlug(model.provider, model.modelId) === slug)) {
    fail(`custom model "${slug}" already exists`);
  }
  const known = knownModelIdsForProvider(provider, config.providers[provider], config);
  if (encodedModelIdCollides(modelId, known)) {
    fail(`custom model "${slug}" is ambiguous; it encodes to an existing model id`);
  }

  const entry: OcxCustomModel = {
    id: randomUUID(),
    provider,
    modelId,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(parsed.reasoningEfforts ? { reasoningEfforts: parsed.reasoningEfforts } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
    addedAt: new Date().toISOString(),
  };
  config.customModels = [...existing, entry];
  saveConfig(config);
  await syncCustomModelsIfLive();
  console.log(`Added custom model ${slug} (${entry.id}).`);
}

async function confirmCustomRemoval(model: OcxCustomModel): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("remove requires --yes in non-interactive mode");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Remove custom model ${routedSlug(model.provider, model.modelId)}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function handleCustomRemove(args: string[]): Promise<void> {
  const rest = [...args];
  const confirmed = consumeFlag(rest, "--yes");
  const target = rest.shift()?.trim() ?? "";
  rejectUnexpectedArgs(rest, REMOVE_USAGE);
  if (!target) fail("custom model id or provider/modelId is required", REMOVE_USAGE);

  const config = loadConfig();
  const existing = config.customModels ?? [];
  const matchingIndexes = existing.flatMap((model, index) => (
    target.includes("/")
      ? slugEquals(target, model.provider, model.modelId)
      : model.id === target
  ) ? [index] : []);
  if (matchingIndexes.length === 0) fail(`custom model "${target}" not found`);
  if (matchingIndexes.length > 1) {
    fail(`custom model selector "${target}" is ambiguous; use the custom model id`);
  }
  const index = matchingIndexes[0]!;

  const model = existing[index];
  if (!confirmed && !(await confirmCustomRemoval(model))) {
    console.log("Cancelled.");
    return;
  }

  const next = existing.filter((_, modelIndex) => modelIndex !== index);
  config.customModels = next.length > 0 ? next : undefined;
  saveConfig(config);
  await syncCustomModelsIfLive();
  console.log(`Removed custom model ${routedSlug(model.provider, model.modelId)}.`);
}

function customModelCells(model: OcxCustomModel): string[] {
  return [
    model.id.slice(0, 8),
    model.modelId,
    model.displayName ?? "-",
    model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "-",
    model.inputModalities?.join(",") ?? "-",
    model.reasoningEfforts?.join(",") ?? "-",
    model.defaultReasoningEffort ?? "-",
  ];
}

function printCustomModelGroup(provider: string, models: OcxCustomModel[]): void {
  const rows = models.map(customModelCells);
  const headers = ["ID", "MODEL", "DISPLAY NAME", "CONTEXT", "MODALITIES", "EFFORTS", "DEFAULT EFFORT"];
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  console.log(`${provider}:`);
  console.log(`  ${line(headers)}`);
  for (const row of rows) console.log(`  ${line(row)}`);
  console.log();
}

function handleCustomList(args: string[]): void {
  const rest = [...args];
  const wantsJson = consumeFlag(rest, "--json");
  rejectUnexpectedArgs(rest, LIST_CUSTOM_USAGE);
  const models = loadConfig().customModels ?? [];
  if (wantsJson) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  if (models.length === 0) {
    console.log("No custom models registered.");
    return;
  }
  const byProvider = new Map<string, OcxCustomModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider) ?? [];
    group.push(model);
    byProvider.set(model.provider, group);
  }
  for (const [provider, providerModels] of byProvider) printCustomModelGroup(provider, providerModels);
}

function handleConfiguredModels(args: string[]): void {
  const restArgs = [...args];
  const wantsJson = consumeFlag(restArgs, "--json");
  const providerFilter = consumeFlagValue(restArgs, "--provider");

  if (restArgs.length > 0) {
    const unknown = restArgs.filter(a => a.startsWith("-"));
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    } else {
      console.error(`Unexpected argument(s): ${restArgs.join(", ")}`);
    }
    console.error("Usage: ocx models [--provider <name>] [--json]");
    process.exit(1);
  }

  const config = loadConfig();

  if (providerFilter && !hasOwnProvider(config.providers, providerFilter)) {
    console.error(`Provider "${providerFilter}" is not configured. See: ocx provider list`);
    process.exit(1);
  }

  const models = collectModels(config, providerFilter ?? undefined);

  if (wantsJson) {
    console.log(JSON.stringify({
      models,
      note: "Static config models only. Providers with liveModels=true may have additional models at runtime.",
    }, null, 2));
    return;
  }

  if (models.length === 0) {
    console.log("No models found in configured providers.");
    if (!providerFilter) console.log("Providers may discover models dynamically at runtime (liveModels).");
    return;
  }

  // Group by provider
  const byProvider = new Map<string, ModelEntry[]>();
  for (const entry of models) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.provider, list);
  }

  for (const [provName, provModels] of byProvider) {
    const isDefaultProv = provName === config.defaultProvider ? " (default provider)" : "";
    console.log(`${provName}${isDefaultProv}:`);
    for (const m of provModels) {
      const marker = m.isDefault ? " *" : "";
      const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
      console.log(`  ${m.model}${marker}${ctx}`);
    }
    console.log();
  }

  console.log("* = default model for provider");
  console.log("Note: providers with liveModels may have additional models at runtime.");
}

export async function handleModels(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    await handleCustomAdd(rest);
    return;
  }
  if (subcommand === "remove") {
    await handleCustomRemove(rest);
    return;
  }
  if (subcommand === "list-custom") {
    handleCustomList(rest);
    return;
  }
  if (["live", "edit", "enable", "disable", "provider", "selected", "context", "shadow"].includes(subcommand ?? "")) {
    const { handleModelsRuntimeCommand } = await import("./models-runtime");
    const code = await handleModelsRuntimeCommand(subcommand!, rest);
    if (code !== null) process.exitCode = code;
    return;
  }
  handleConfiguredModels(subcommand === "list" ? rest : args);
}
