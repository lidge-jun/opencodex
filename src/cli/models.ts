/**
 * `ocx models` subcommand — list configured models and manage custom models.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { syncModelsToCodex } from "../codex/sync";
import { codexAccountLogLabel } from "../codex/account-label";
import {
  customModelCodexAccountTargetAssignmentError,
  normalizeCustomModelCodexAccountTarget,
} from "../codex/custom-model-account-target";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import {
  hasOwnProvider,
  isValidProviderName,
  loadConfig,
  mutatePersistedConfig,
  saveConfig,
} from "../config";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";
import { encodedModelIdCollides, routedSlug, slugEquals } from "../providers/slug-codec";
import { knownModelIdsForProvider } from "../router";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR } from "./models-account-target";
import { runtimeRequest } from "./runtime-api";
import type { OcxConfig, OcxCustomModel } from "../types";

const ADD_USAGE = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>] [--codex-account-target <@main|pool-id>]";
const REMOVE_USAGE = "Usage: ocx models remove <customId|provider/modelId> [--yes]";
const LIST_CUSTOM_USAGE = "Usage: ocx models list-custom [--json]";
const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

export interface ModelsCommandDeps {
  findLiveProxyImpl?: typeof findLiveProxy;
  fetchImpl?: typeof fetch;
}

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

      const noVision = prov.noVisionModels?.includes(model);
      const modalities = inputModalities[model] ?? (noVision ? ["text"] : null);
      const efforts = reasoningEfforts[model] ?? prov.reasoningEfforts ?? null;

      entries.push({
        provider: provName,
        model,
        isDefault,
        contextWindow: contextWindows[model] ?? globalContext,
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

async function handleCustomAdd(args: string[], deps: ModelsCommandDeps = {}): Promise<void> {
  const rest = [...args];
  const provider = rest.shift()?.trim() ?? "";
  const modelId = rest.shift()?.trim() ?? "";
  const displayNameValue = consumeFlagValue(rest, "--display-name");
  const contextWindowValue = consumeFlagValue(rest, "--context-window");
  const modalitiesValue = consumeFlagValue(rest, "--modalities");
  const reasoningEffortsValue = consumeFlagValue(rest, "--reasoning-efforts");
  const defaultEffortValue = consumeFlagValue(rest, "--default-reasoning-effort");
  const codexAccountTarget = consumeFlagValue(rest, "--codex-account-target");
  rejectUnexpectedArgs(rest, ADD_USAGE);

  if (!provider || !modelId) fail("provider and modelId are required", ADD_USAGE);
  if (!isValidProviderName(provider)) fail(`invalid provider name "${provider}"`);

  const config = loadConfig();
  if (!hasOwnProvider(config.providers, provider)) {
    fail(`provider "${provider}" is not configured. See: ocx provider list`);
  }
  let liveTargetBaseUrl: string | undefined;
  if (codexAccountTarget !== undefined) {
    const targetError = customModelCodexAccountTargetAssignmentError(
      config,
      provider,
      codexAccountTarget,
    );
    if (targetError) fail(targetError, ADD_USAGE);
    const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
    if (live) {
      liveTargetBaseUrl = `http://${probeHostname(live.hostname)}:${live.port}`;
    }
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

  const slug = routedSlug(provider, modelId);
  const entry: OcxCustomModel = {
    id: randomUUID(),
    provider,
    modelId,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(parsed.reasoningEfforts ? { reasoningEfforts: parsed.reasoningEfforts } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
    ...(codexAccountTarget !== undefined ? { codexAccountTarget } : {}),
    addedAt: new Date().toISOString(),
  };
  if (codexAccountTarget !== undefined && liveTargetBaseUrl) {
    const codexAccountTargetWriteNonce = randomUUID();
    let saved: { id?: unknown; codexAccountTarget?: unknown; codexAccountTargetWriteNonce?: unknown };
    try {
      saved = await runtimeRequest("/api/custom-models/account-target", {
        method: "POST",
        body: JSON.stringify({
          provider,
          modelId,
          displayName,
          contextWindow,
          inputModalities,
          reasoningEfforts: parsed.reasoningEfforts,
          defaultReasoningEffort: parsed.defaultReasoningEffort,
          codexAccountTarget,
          codexAccountTargetWriteNonce,
        }),
      }, {
        baseUrl: liveTargetBaseUrl,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR, ADD_USAGE);
    }
    if (
      typeof saved.id !== "string"
      || saved.codexAccountTarget !== codexAccountTarget
      || saved.codexAccountTargetWriteNonce !== codexAccountTargetWriteNonce
    ) {
      fail(CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR, ADD_USAGE);
    }
    console.log(`Added custom model ${slug} (${saved.id}).`);
    return;
  }
  // Preserve the long-standing fresh-home behavior for ordinary rows: `saveConfig`
  // creates config.json from the loaded defaults. Exact-account rows use the stricter
  // locked mutation below because their account/provider predicates must be rechecked.
  if (codexAccountTarget === undefined) {
    const existing = config.customModels ?? [];
    if (existing.some(model => routedSlug(model.provider, model.modelId) === slug)) {
      fail(`custom model "${slug}" already exists`, ADD_USAGE);
    }
    const known = knownModelIdsForProvider(provider, config.providers[provider], config);
    if (encodedModelIdCollides(modelId, known)) {
      fail(`custom model "${slug}" is ambiguous; it encodes to an existing model id`, ADD_USAGE);
    }
    config.customModels = [...existing, entry];
    saveConfig(config);
    await syncCustomModelsIfLive();
    console.log(`Added custom model ${slug} (${entry.id}).`);
    return;
  }
  const mutation = mutatePersistedConfig<{ error?: string }>(persisted => {
    if (!hasOwnProvider(persisted.providers, provider)) {
      return {
        changed: false,
        value: { error: `provider "${provider}" is not configured. See: ocx provider list` },
      };
    }
    if (codexAccountTarget !== undefined) {
      const targetError = customModelCodexAccountTargetAssignmentError(
        persisted,
        provider,
        codexAccountTarget,
      );
      if (targetError) return { changed: false, value: { error: targetError } };
    }
    const existing = persisted.customModels ?? [];
    if (existing.some(model => routedSlug(model.provider, model.modelId) === slug)) {
      return { changed: false, value: { error: `custom model "${slug}" already exists` } };
    }
    const known = knownModelIdsForProvider(provider, persisted.providers[provider], persisted);
    if (encodedModelIdCollides(modelId, known)) {
      return {
        changed: false,
        value: { error: `custom model "${slug}" is ambiguous; it encodes to an existing model id` },
      };
    }
    persisted.customModels = [...existing, entry];
    return { changed: true, value: {} };
  });
  if (mutation.status === "unavailable") {
    fail(`config could not be updated safely (${mutation.reason}); retry`, ADD_USAGE);
  }
  if (mutation.value.error) fail(mutation.value.error, ADD_USAGE);
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

function displayCodexAccountTarget(config: OcxConfig, target: string | undefined): string {
  if (!target) return "-";
  const accountId = normalizeCustomModelCodexAccountTarget(target);
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return "@main";
  const account = (config.codexAccounts ?? []).find(candidate => candidate.id === accountId);
  return account ? (account.alias?.trim() || codexAccountLogLabel(account)) : "unavailable";
}

function customModelCells(config: OcxConfig, model: OcxCustomModel): string[] {
  return [
    model.id.slice(0, 8),
    model.modelId,
    model.displayName ?? "-",
    model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "-",
    model.inputModalities?.join(",") ?? "-",
    model.reasoningEfforts?.join(",") ?? "-",
    model.defaultReasoningEffort ?? "-",
    displayCodexAccountTarget(config, model.codexAccountTarget),
  ];
}

function printCustomModelGroup(config: OcxConfig, provider: string, models: OcxCustomModel[]): void {
  const rows = models.map(model => customModelCells(config, model));
  const headers = ["ID", "MODEL", "DISPLAY NAME", "CONTEXT", "MODALITIES", "EFFORTS", "DEFAULT EFFORT", "CODEX ACCOUNT"];
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
  const config = loadConfig();
  const models = config.customModels ?? [];
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
  for (const [provider, providerModels] of byProvider) printCustomModelGroup(config, provider, providerModels);
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

export async function handleModels(args: string[], deps: ModelsCommandDeps = {}): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    await handleCustomAdd(rest, deps);
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
