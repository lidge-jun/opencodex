import { isValidProviderName } from "../config/provider-name";
import { isDeclaredReasoningEffort } from "../reasoning-effort";
import { resolveSlugSelection } from "../providers/slug-codec";
import { printCatalogResult, runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import { parseCustomModelAddInput } from "./models-custom-input";
import {
  CliUsageError, RuntimeApiError, runtimeBaseUrl, runtimeRequest, takeFlag,
  type RuntimeApiDeps,
} from "./runtime-api";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}

function modelIdentity(value: unknown): { id: string; provider: string; modelId: string } {
  if (!record(value) || !identity(value.id) || !identity(value.provider)
    || !isValidProviderName(value.provider) || !identity(value.modelId)) {
    throw new Error("Invalid custom model identity");
  }
  return { id: value.id, provider: value.provider, modelId: value.modelId };
}

/** Rebuild the public stored-entry DTO; never copy arbitrary response properties. */
function addedModel(value: unknown, provider: string, modelId: string): Record<string, unknown> {
  const result: Record<string, unknown> = modelIdentity(value);
  if (!record(value) || result.provider !== provider || result.modelId !== modelId
    || !identity(value.addedAt) || !Number.isFinite(Date.parse(value.addedAt))) {
    throw new Error("Invalid custom model response");
  }
  result.addedAt = value.addedAt;
  if (value.displayName !== undefined) {
    if (!identity(value.displayName) || value.displayName.includes("/")) throw new Error("Invalid display name response");
    result.displayName = value.displayName;
  }
  if (value.contextWindow !== undefined) {
    if (typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
      throw new Error("Invalid context response");
    }
    result.contextWindow = value.contextWindow;
  }
  for (const key of ["inputModalities", "reasoningEfforts"] as const) {
    const values = value[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || !values.every(item => typeof item === "string"
      && (key === "inputModalities" ? ["text", "image", "audio"].includes(item) : isDeclaredReasoningEffort(item)))
      || new Set(values).size !== values.length || (key === "inputModalities" && values.length === 0)) {
      throw new Error("Invalid model metadata response");
    }
    result[key] = [...values];
  }
  if (value.defaultReasoningEffort !== undefined) {
    if (typeof value.defaultReasoningEffort !== "string" || !Array.isArray(result.reasoningEfforts)
      || !result.reasoningEfforts.includes(value.defaultReasoningEffort)) throw new Error("Invalid default effort response");
    result.defaultReasoningEffort = value.defaultReasoningEffort;
  }
  return result;
}

function resolveRemoval(value: unknown, target: string): { id: string; provider: string; modelId: string } {
  if (!Array.isArray(value)) throw new Error("Invalid custom model roster");
  const rows = value.map(modelIdentity);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate stored model IDs");
  const byId = rows.find(row => row.id === target);
  if (byId) return byId;
  const separator = target.indexOf("/");
  const provider = separator >= 0 ? target.slice(0, separator) : undefined;
  const roster = provider === undefined ? [] : rows.filter(row => row.provider === provider);
  const admitted = new Set(provider === undefined ? []
    : resolveSlugSelection(provider, target, roster.map(row => row.modelId)).matched);
  const matches = roster.filter(row => admitted.has(row.modelId));
  if (matches.length === 0) throw new RuntimeApiError("Custom model not found", 404, null);
  if (matches.length !== 1) throw new CliUsageError("Ambiguous custom model selector; use the complete stored ID");
  return matches[0]!;
}

export async function handleModelsCustomRuntimeCommand(
  sub: "add" | "remove", argv: string[], deps: RuntimeApiDeps = {},
): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    if (sub === "add") {
      const input = parseCustomModelAddInput(args);
      const body = serializeManagementJson(input);
      const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
      const response = await runtimeRequest("/api/custom-models", { method: "POST", redirect: "error", body }, pinned);
      const result = addedModel(response, input.provider, input.modelId);
      return printCatalogResult(result, record(response) ? response.catalogRefresh : undefined, wantsJson,
        [`Saved custom model ${input.provider}/${input.modelId} (${result.id}).`]);
    }
    const confirmed = takeFlag(args, "--yes");
    if (!confirmed) throw new CliUsageError("Live custom model removal requires --yes");
    if (args.length !== 1 || !args[0]?.trim() || args[0].startsWith("-")) {
      throw new CliUsageError("A complete stored ID or provider/model selector is required");
    }
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const roster = await runtimeRequest("/api/custom-models", { redirect: "error" }, pinned);
    const selected = resolveRemoval(roster, args[0].trim());
    if (selected.id === "." || selected.id === "..") throw new Error("Stored ID is not addressable as a route segment");
    const response = await runtimeRequest(`/api/custom-models/${encodeURIComponent(selected.id)}`, {
      method: "DELETE", redirect: "error",
    }, pinned);
    if (!record(response) || response.ok !== true) throw new Error("Invalid custom model removal response");
    return printCatalogResult({ ok: true, ...selected }, response.catalogRefresh, wantsJson,
      [`Removed custom model ${selected.provider}/${selected.modelId} (${selected.id}).`]);
  });
}
