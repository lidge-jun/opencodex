/**
 * `ocx models` subcommand — list configured models and manage custom models.
 */
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { resolveMatchedPrice, type MatchedPrice } from "../usage/cost";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { syncModelsToCodex } from "../codex/sync";
import { applyRegistryCapabilitySeedFill, configuredContextWindow } from "../codex/catalog/provider-fetch";
import { hasOwnProvider, isValidProviderName, loadConfig, saveConfig } from "../config";
import { readCliConfigForMutation } from "./config-mutation";
import {
  configuredReasoningEfforts,
  modelRecordValue,
} from "../reasoning-effort";
import { encodedModelIdCollides, resolveSlugSelection, routedSlug } from "../providers/slug-codec";
import { isModelsRuntimeSubcommand } from "./models-runtime-subcommands";
import { knownModelIdsForProvider } from "../router";
import { azureVendorModelMetadata, enrichProviderFromRegistry, registryInputModalitiesForDestination } from "../providers/derive";
import { getProviderRegistryEntry } from "../providers/registry";
import { providerMatchesRegistryTransportWithStaticGuards } from "../providers/static-model-discovery";
import { resolveModelPolicy } from "../providers/resolved-model-policy";
import { customRowInputModalities } from "../vision/eligibility";
import { applyProviderContextCap, providerContextCap, resolveUnknownRoutedContextWindow } from "../providers/context-cap";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { reasoningCapabilitiesFromConfig } from "../providers/reasoning-capabilities";
import { dropLearnedUnsupportedReasoningEfforts, providerUsesReasoningMetadata } from "../providers/reasoning-metadata";
import { isKeychainReference } from "../providers/api-key-resolve";
import { hasNativeOpenAiCapabilityMetadata, nativeContextLimits, nativeDefaultReasoningEffort, nativeInputModalities, nativeOpenAiContextWindow, nativeReasoningEfforts } from "../codex/catalog/metadata";
import { canInferVendorContext, vendorContextInference } from "../codex/catalog/vendor-context";
import { terminalSafeText } from "./runtime-api";
import { runPassiveRead } from "../lib/passive-read";
import { findLiveProxy } from "../server/proxy-liveness";
import { modelInList, type OcxConfig, type OcxCustomModel } from "../types";
import type { RuntimeApiDeps } from "./runtime-api";
import { projectLocalSyncResult, type LocalSyncResult } from "./local-sync-result";

export interface ModelsCommandDeps extends RuntimeApiDeps { syncModels?: typeof syncModelsToCodex; }

const ADD_USAGE = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>] [--live] [--json]";
const REMOVE_USAGE = "Usage: ocx models remove <customId|provider/modelId> [--yes] [--live] [--json]";
const LIST_CUSTOM_USAGE = "Usage: ocx models list-custom [--json]";
const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

function printJson(value: unknown): void {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) throw new TypeError("Cannot serialize model output");
  console.log(encoded.replace(/[\u007f-\u009f\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

import { parseReasoningArgs } from "./models-custom-input";
import { redactSecretArgs } from "./secret-args";
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
    // Model listing is read-only: derive effective registry policy on a private copy.
    const effective = structuredClone(prov);
    const registryMatches = providerMatchesRegistryTransportWithStaticGuards(provName, prov);
    if (registryMatches) applyRegistryCapabilitySeedFill(provName, effective);
    enrichProviderFromRegistry(provName, effective);
    if (registryMatches) {
      const policy = resolveModelPolicy({
        providerName: provName, modelId: effective.defaultModel ?? "__catalog_capture__", provider: effective,
        registryEntry: getProviderRegistryEntry(provName), transportMatchedRegistry: true,
        ...(effective.authMode ? { effectiveAuth: { authMode: effective.authMode } } : {}),
      }).provider;
      Object.assign(effective, policy);
    }
    effective.inputModalities ??= registryInputModalitiesForDestination(provName, prov);
    const routerKnown = new Set(knownModelIdsForProvider(provName, prov));

    /** Append one model with resolved metadata, ignoring duplicates within this provider. */
    const addModel = (model: string, isDefault: boolean) => {
      if (seen.has(model)) return;
      seen.add(model);

      const custom = config.customModels?.find(row => row.provider === provName && row.modelId === model);
      const nativeMetadata = custom && hasNativeOpenAiCapabilityMetadata(model);
      const canonicalProvider = provName === OPENAI_CODEX_PROVIDER_ID && prov.authMode === undefined
        ? { ...prov, authMode: "forward" as const } : prov;
      const canonicalNativeCustom = nativeMetadata && provName === OPENAI_CODEX_PROVIDER_ID
        && isCanonicalOpenAiForwardProvider(canonicalProvider);
      const canInfer = canInferVendorContext(provName, effective);
      const modelListEmpty = (effective.models?.length ?? 0) === 0;
      const seededDefault = effective.defaultModel === model && modelListEmpty
        && (effective.liveModels === false || (effective.adapter === "google" && effective.googleMode === "vertex"));
      const hintEligible = !custom || canInfer || routerKnown.has(model) || (effective.models ?? []).includes(model)
        || (effective.retainModels ?? []).includes(model) || seededDefault;
      const azureMetadata = hintEligible ? azureVendorModelMetadata(effective.baseUrl, model, getConfigDir()) : undefined;
      const capability = Object.hasOwn(effective.modelCapabilities ?? {}, model)
        ? effective.modelCapabilities?.[model]?.inputModalities : undefined;
      const customModalities = customRowInputModalities(config, provName, model);
      const modalities = capability ?? customModalities ?? (modelInList(effective.noVisionModels, model)
        ? ["text"] : modelRecordValue(effective.modelInputModalities, model) ?? effective.inputModalities
          ?? azureMetadata?.input ?? (canonicalNativeCustom ? nativeInputModalities(model) : null));
      // Same reason, for the ladder: `configuredReasoningEfforts` is what the catalog
      // (`provider-fetch`) and the effort cap (`effort-policy`) resolve through, and it
      // does three things this expression did not — it returns [] for a noReasoningModels
      // match, drops levels Codex does not declare, and re-adds tiers the wire map proves
      // the model emits. Restating two of its five lines here reported a ladder the proxy
      // strips, and unsanitized junk as a supported level.
      const declaredEfforts = custom?.reasoningEfforts ?? modelRecordValue(effective.modelReasoningEfforts, model) ?? effective.reasoningEfforts;
      // A passive CLI cannot resolve an OS-keychain reference to select account-scoped refusals.
      // Report unknown rather than opening the keychain or claiming an unverifiable ladder.
      const unobservedCredential = providerUsesReasoningMetadata(effective) && isKeychainReference(effective.apiKey);
      let efforts = reasoningCapabilitiesFromConfig(effective, model).supportsReasoningEffort === false || declaredEfforts?.length === 0
        ? [] : unobservedCredential ? null : custom?.reasoningEfforts ?? configuredReasoningEfforts(effective, model, { refreshMetadata: false })
          ?? (canonicalNativeCustom ? nativeReasoningEfforts(model) : null);
      if (nativeMetadata && efforts && efforts.length > 0) {
        const allowed = nativeReasoningEfforts(model);
        if (allowed.length > 0) {
          const declared = new Set(efforts);
          const surviving = [...new Set(allowed)].filter(effort => declared.has(effort));
          const defaultEffort = nativeDefaultReasoningEffort(model);
          efforts = surviving.length > 0 ? surviving : [defaultEffort && allowed.includes(defaultEffort) ? defaultEffort : allowed[0]!];
        }
      }
      if (efforts) efforts = dropLearnedUnsupportedReasoningEfforts(effective, model, efforts);
      const nativeCustomContext = canonicalNativeCustom
        ? nativeOpenAiContextWindow(model, {
          ...nativeContextLimits(config),
          ...(custom.contextWindow ? { modelWindows: { ...nativeContextLimits(config).modelWindows, [model]: custom.contextWindow } } : {}),
        }) : undefined;
      const cap = providerContextCap(config, provName);
      const explicitContext = nativeCustomContext ?? custom?.contextWindow;
      const configuredContext = hintEligible ? configuredContextWindow(effective, model) : undefined;
      const azureWindow = explicitContext === undefined && configuredContext === undefined
        ? azureMetadata?.contextWindow : undefined;
      const azureContext = Number.isSafeInteger(azureWindow) && azureWindow! > 0 ? azureWindow : undefined;
      const inferredContext = explicitContext === undefined && configuredContext === undefined && azureContext === undefined && canInfer
        ? vendorContextInference(model)?.contextWindow : undefined;
      const fallbackContext = hintEligible && cap !== undefined ? resolveUnknownRoutedContextWindow(cap) : undefined;
      const contextWindow = explicitContext
        ?? applyProviderContextCap(configuredContext ?? azureContext ?? inferredContext ?? fallbackContext, cap);

      entries.push({
        provider: provName,
        model,
        isDefault,
        contextWindow: contextWindow ?? null,
        inputModalities: modalities,
        reasoningEfforts: efforts,
        price: resolveMatchedPrice(provName, model),
      });
    };

    // defaultModel first
    if (prov.defaultModel) addModel(prov.defaultModel, true);

    // Keep the CLI list current when this config predates a provider's registry seed.
    // knownModelIdsForProvider is the router's own derivation: config models first, then
    // registry seeds, hint-map keys, and live-discovered cache ids (registry-derived
    // sources only enter when the router's registry transport guard matches), then customModels.
    // Some legacy key presets retain registry ownership even after a destination change. Because hint-map keys
    // are included, wire-only ids a provider's collapsed picker hides still appear here;
    // that is router parity. A model the user pruned from `models` reappears if the
    // registry still seeds it -- the list is a union, not the user's curation. The
    // user's saved models remain first and are never discarded.
    for (const m of [...(prov.models ?? []), ...knownModelIdsForProvider(provName, prov, config)]) {
      addModel(m, m === prov.defaultModel);
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
  console.error(`Error: ${terminalSafeText(message)}`);
  if (usage) console.error(terminalSafeText(usage));
  process.exit(1);
}

function rejectUnexpectedArgs(args: string[], usage: string): void {
  if (args.length === 0) return;
  const shown = redactSecretArgs(args);
  const unknown = shown.filter(arg => arg.startsWith("-"));
  fail(
    unknown.length > 0
      ? `Unknown flag(s): ${unknown.join(", ")}`
      : `Unexpected argument(s): ${shown.join(", ")}`,
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
    printJson({ action,
      model: action === "added" ? model : { id: model.id, provider: model.provider, modelId: model.modelId },
      needsSync: !complete, sync });
    return;
  }
  if (sync.warning) console.log(`Warning: ${terminalSafeText(sync.warning)}`);
  console.log(`${action === "added" ? "Added" : "Removed"} custom model ${terminalSafeText(routedSlug(model.provider, model.modelId))}${action === "added" ? ` (${terminalSafeText(model.id)})` : ""}.`);
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

  const { config, entry } = await withConfigDirHardeningSettled(getConfigDir(), () => {
    const config = readCliConfigForMutation();
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
    return { config, entry };
  });
  const sync = await syncCustomModelsIfLive(config, deps);
  printCustomMutation("added", entry, sync, wantsJson);
}

async function confirmCustomRemoval(model: OcxCustomModel): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("remove requires --yes in non-interactive mode");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Remove custom model ${terminalSafeText(routedSlug(model.provider, model.modelId))}? [y/N] `)).trim().toLowerCase();
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

  const config = readCliConfigForMutation({ passive: true });
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

  const savedConfig = await withConfigDirHardeningSettled(getConfigDir(), () => {
    const fresh = readCliConfigForMutation();
    const current = fresh.customModels ?? [];
    if (JSON.stringify(current.find(row => row.id === model.id)) !== JSON.stringify(model)) {
      fail("custom model changed before removal; inspect it before retrying");
    }
    const next = current.filter(row => row.id !== model.id);
    fresh.customModels = next.length > 0 ? next : undefined;
    saveConfig(fresh);
    return fresh;
  });
  const sync = await syncCustomModelsIfLive(savedConfig, deps);
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
  const rows = models.map(model => customModelCells(model).map(terminalSafeText));
  const headers = ["ID", "MODEL", "DISPLAY NAME", "CONTEXT", "MODALITIES", "EFFORTS", "DEFAULT EFFORT"];
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  console.log(`${terminalSafeText(provider)}:`);
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
    printJson(models);
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
    const shown = redactSecretArgs(restArgs);
    const unknown = shown.filter(a => a.startsWith("-"));
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${terminalSafeText(unknown.join(", "))}`);
    } else {
      console.error(`Unexpected argument(s): ${terminalSafeText(shown.join(", "))}`);
    }
    console.error("Usage: ocx models [--provider <name>] [--json]");
    process.exit(1);
  }

  const config = loadConfig();

  if (providerFilter && !hasOwnProvider(config.providers, providerFilter)) {
    console.error(`Provider "${terminalSafeText(providerFilter)}" is not configured. See: ocx provider list`);
    process.exit(1);
  }

  const models = collectModels(config, providerFilter ?? undefined);
  const note = "Local saved and router-known IDs include registry seeds, custom models and this process's discovery cache. Reasoning may be unknown for keychain credentials. Use ocx models live for the running catalog.";

  if (wantsJson) {
    printJson({
      models,
      note,
    });
    return;
  }

  if (models.length === 0) {
    console.log("No models found in configured providers.");
    console.log(`Note: ${note}`);
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
    console.log(`${terminalSafeText(provName)}${isDefaultProv}:`);
    for (const m of provModels) {
      const marker = m.isDefault ? " *" : "";
      const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
      const rates = m.price?.cost4;
      const pricing = rates ? ` ~$${rates.input}/$${rates.output} input/output per 1M tokens` : " price unknown";
      console.log(`  ${terminalSafeText(m.model)}${marker}${ctx}${pricing}`);
    }
    console.log();
  }

  console.log("* = default model for provider");
  console.log(`Note: ${note}`);
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
    await runPassiveRead(async () => { handleCustomList(rest); }, { onDiagnostic: message => console.error(message) });
    return;
  }
  if (isModelsRuntimeSubcommand(subcommand)) {
    const { handleModelsRuntimeCommand } = await import("./models-runtime");
    const code = await handleModelsRuntimeCommand(subcommand!, rest, deps);
    if (code !== null) process.exitCode = code;
    return;
  }
  await runPassiveRead(async () => { handleConfiguredModels(subcommand === "list" ? rest : args); }, { onDiagnostic: message => console.error(message) });
}
