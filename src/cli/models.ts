/**
 * `ocx models` subcommand — list configured models and manage custom models.
 */
import { resolveMatchedPrice, type MatchedPrice } from "../usage/cost";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { syncModelsToCodex } from "../codex/sync";
import { configuredContextWindow } from "../codex/catalog/provider-fetch";
import { hasOwnProvider, isValidProviderName, loadConfig, saveConfig } from "../config";
import {
  configuredReasoningEfforts,
  modelRecordValue,
} from "../reasoning-effort";
import { encodedModelIdCollides, resolveSlugSelection, routedSlug } from "../providers/slug-codec";
import { isModelsRuntimeSubcommand } from "./models-runtime-subcommands";
import { knownModelIdsForProvider } from "../router";
import { findLiveProxy } from "../server/proxy-liveness";
import { modelInList, type OcxConfig, type OcxCustomModel } from "../types";
import type { RuntimeApiDeps } from "./runtime-api";
import { projectLocalSyncResult, type LocalSyncResult } from "./local-sync-result";

export interface ModelsCommandDeps extends RuntimeApiDeps { syncModels?: typeof syncModelsToCodex; }

const ADD_USAGE = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>] [--live] [--json]";
const REMOVE_USAGE = "Usage: ocx models remove <customId|provider/modelId> [--yes] [--live] [--json]";
const LIST_CUSTOM_USAGE = "Usage: ocx models list-custom [--json]";
const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

import { parseReasoningArgs } from "./models-custom-input";
export { parseReasoningArgs } from "./models-custom-input";

interface ModelEntry {
  provider: string;
  model: string;
  isDefault: boolean;
  contextWindow: number | null;
  inputModalities: string[] | null;
  reasoningEfforts: string[] | null;
  price: MatchedPrice | null;
}

/**
 * Collect static configured models for all providers or one selected provider.
 * Keep each provider's default model first and resolve metadata through shared helpers.
 * Live-discovered models are not fetched by this listing.
 */
function collectModels(config: OcxConfig, providerFilter?: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const providers = providerFilter
    ? { [providerFilter]: config.providers[providerFilter] }
    : config.providers;

  for (const [provName, prov] of Object.entries(providers)) {
    if (!prov) continue;
    const seen = new Set<string>();
    const inputModalities = prov.modelInputModalities ?? {};

    /** Append one model with resolved metadata, ignoring duplicates within this provider. */
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
      // Same reason, for the ladder: `configuredReasoningEfforts` is what the catalog
      // (`provider-fetch`) and the effort cap (`effort-policy`) resolve through, and it
      // does three things this expression did not — it returns [] for a noReasoningModels
      // match, drops levels Codex does not declare, and re-adds tiers the wire map proves
      // the model emits. Restating two of its five lines here reported a ladder the proxy
      // strips, and unsanitized junk as a supported level.
      const efforts = configuredReasoningEfforts(prov, model) ?? null;

      entries.push({
        provider: provName,
        model,
        isDefault,
        contextWindow: configuredContextWindow(prov, model) ?? null,
        inputModalities: modalities,
        reasoningEfforts: efforts,
        price: resolveMatchedPrice(provName, model),
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

async function syncCustomModelsIfLive(config: OcxConfig, deps: ModelsCommandDeps): Promise<LocalSyncResult> {
  try {
    const live = await (deps.findLiveProxy ?? findLiveProxy)();
    if (!live) return { status: "not-attempted", ok: false };
    return projectLocalSyncResult(await (deps.syncModels ?? syncModelsToCodex)(live.port, config, null));
  } catch {
    return { status: "failed", ok: false };
  }
}

function printCustomMutation(action: "added" | "removed", model: OcxCustomModel, sync: LocalSyncResult, wantsJson: boolean): void {
  const complete = sync.configApplied === true && sync.ok;
  if (sync.status !== "not-attempted" && (!sync.ok || sync.status === "refused")) process.exitCode = 1;
  if (wantsJson) {
    console.log(JSON.stringify({ action,
      model: action === "added" ? model : { id: model.id, provider: model.provider, modelId: model.modelId },
      needsSync: !complete, sync }, null, 2));
    return;
  }
  if (sync.warning) console.log(`Warning: ${sync.warning}`);
  console.log(`${action === "added" ? "Added" : "Removed"} custom model ${routedSlug(model.provider, model.modelId)}${action === "added" ? ` (${model.id})` : ""}.`);
  if (sync.status === "skipped") console.log("Custom model saved; client sync was skipped by the integration policy.");
  else if (!complete && sync.status !== "not-attempted") console.log("Custom model saved; client/catalog sync remains incomplete. Inspect the target before retrying.");
}

async function handleCustomAdd(args: string[], deps: ModelsCommandDeps): Promise<void> {
  const rest = [...args];
  const wantsJson = consumeFlag(rest, "--json");
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
  const sync = await syncCustomModelsIfLive(config, deps);
  printCustomMutation("added", entry, sync, wantsJson);
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

async function handleCustomRemove(args: string[], deps: ModelsCommandDeps): Promise<void> {
  const rest = [...args];
  const wantsJson = consumeFlag(rest, "--json");
  const confirmed = consumeFlag(rest, "--yes");
  const target = rest.shift()?.trim() ?? "";
  rejectUnexpectedArgs(rest, REMOVE_USAGE);
  if (!target) fail("custom model id or provider/modelId is required", REMOVE_USAGE);
  if (wantsJson && !confirmed) {
    console.error("Error: JSON removal requires --yes; it does not prompt.");
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const existing = config.customModels ?? [];
  // Slug matching goes through the shared resolver so this command sees the same collision
  // class catalog filtering and persisted sync see (#2491). `slugEquals` compares the raw and
  // encoded spellings of ONE id, so a selector written in the native slash form matched only
  // that row while the dash form matched both — the two relations disagreed on the same
  // config. Removal stays exact-or-refuse: an ambiguous selector still aborts below, which is
  // the right default for a destructive command.
  const separator = target.indexOf("/");
  const selectedProvider = separator >= 0 ? target.slice(0, separator) : undefined;
  // Resolve ONCE against the provider's whole roster, then map the decision back onto rows.
  // Calling the resolver per row with a singleton roster hid every cross-row fact it needs:
  // a self-namespaced `acme/turbo` and a sibling `turbo` each matched their own singleton,
  // so the command saw two matches and aborted as ambiguous even though the selector names
  // one row exactly.
  const rosterMatched = selectedProvider === undefined
    ? undefined
    : resolveSlugSelection(
      selectedProvider,
      target,
      existing.filter(model => model.provider === selectedProvider).map(model => model.modelId),
    );
  // Deliberately admit the whole matched set rather than narrowing to `exact`: an encoded
  // selector that spans a real collision must still abort below. Removal stays exact-or-refuse.
  const admitted = new Set(rosterMatched?.matched ?? []);
  const matchingIndexes = existing.flatMap((model, index) => {
    if (selectedProvider === undefined) return model.id === target ? [index] : [];
    if (model.provider !== selectedProvider) return [];
    return admitted.has(model.modelId) ? [index] : [];
  });
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
  const sync = await syncCustomModelsIfLive(config, deps);
  printCustomMutation("removed", model, sync, wantsJson);
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
      const rates = m.price?.cost4;
      const pricing = rates ? ` ~$${rates.input}/$${rates.output} input/output per 1M tokens` : " price unknown";
      console.log(`  ${m.model}${marker}${ctx}${pricing}`);
    }
    console.log();
  }

  console.log("* = default model for provider");
  console.log("Note: providers with liveModels may have additional models at runtime.");
}

export async function handleModels(args: string[], deps: ModelsCommandDeps = {}): Promise<void> {
  const [subcommand, ...rest] = args;
  const live = rest.filter(arg => arg === "--live" || arg.startsWith("--live="));
  if (live.length) {
    if (live.length !== 1 || live[0] !== "--live" || (subcommand !== "add" && subcommand !== "remove")) {
      console.error("Error: --live is a single boolean flag for models add or remove.");
      process.exitCode = 2;
      return;
    }
    rest.splice(rest.indexOf("--live"), 1);
    const { handleModelsCustomRuntimeCommand } = await import("./models-custom-runtime");
    process.exitCode = await handleModelsCustomRuntimeCommand(subcommand, rest, deps);
    return;
  }
  if (subcommand === "add") {
    await handleCustomAdd(rest, deps);
    return;
  }
  if (subcommand === "remove") {
    await handleCustomRemove(rest, deps);
    return;
  }
  if (subcommand === "list-custom") {
    handleCustomList(rest);
    return;
  }
  if (isModelsRuntimeSubcommand(subcommand)) {
    const { handleModelsRuntimeCommand } = await import("./models-runtime");
    const code = await handleModelsRuntimeCommand(subcommand!, rest, deps);
    if (code !== null) process.exitCode = code;
    return;
  }
  handleConfiguredModels(subcommand === "list" ? rest : args);
}
