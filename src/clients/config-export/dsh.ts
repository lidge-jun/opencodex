// DSH config export.
import type { ExportModel, ExportContext, ManagedContribution } from "./contracts";
import type { OcxConfig } from "../../types";
import { providerCodexAccountMode } from "../../providers/registry";
import { normalizeExportModels, authoritativeContextWindow, exportModelLabel, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID } from "./constants";


/** DSH rc.6 accepts text/image; unknown values degrade to text, while audio-only cannot be represented. */
function dshInputModalities(modalities: readonly string[] | undefined): string[] | null {
  const declared = modalities ?? [];
  if (declared.length === 0) return ["text"];
  const kept: string[] = [];
  for (const value of declared) {
    if ((value === "text" || value === "image") && !kept.includes(value)) kept.push(value);
  }
  if (kept.length > 0) return kept;
  return declared.every(value => value === "audio") ? null : ["text"];
}

export type DshReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type DshWireReasoningEffort = DshReasoningEffort | "ultra";

export interface DshModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  reasoningEfforts?: Partial<Record<DshReasoningEffort, DshWireReasoningEffort>>;
}

export interface DshProviderBlock {
  displayName: "OpenCodex";
  api: "openai-responses";
  baseURL: string;
  headers: { Authorization: "Bearer ocx_data_dsh" };
  models: DshModelEntry[];
}

export interface DshGeneratedConfig {
  "llm-pi-ai": {
    providers: Record<string, DshProviderBlock>;
  };
}

const DSH_EFFORT_ORDER: readonly DshReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function dshReasoningEfforts(model: ExportModel): DshModelEntry["reasoningEfforts"] {
  const offered = new Set<string>();
  for (const raw of model.reasoningEfforts ?? []) {
    const effort = raw.trim().toLowerCase();
    if (effort === "ultra" || DSH_EFFORT_ORDER.includes(effort as DshReasoningEffort)) offered.add(effort);
  }
  if (offered.size === 0) return undefined;
  const entries: Array<[DshReasoningEffort, DshWireReasoningEffort]> = [];
  for (const effort of DSH_EFFORT_ORDER) {
    if (effort !== "max") {
      if (offered.has(effort)) entries.push([effort, effort]);
      continue;
    }
    // DSH's key is the selectable level; the value is what it sends on the
    // wire. Preserve OpenCodex's `ultra` spelling when that is the only
    // highest effort, exactly like the rc.6 `max: ultra` contract.
    if (offered.has("max")) entries.push(["max", "max"]);
    else if (offered.has("ultra")) entries.push(["max", "ultra"]);
  }
  return Object.fromEntries(entries);
}

function isKnownSafeDshCombo(model: ExportModel, config: OcxConfig): boolean {
  const combos = (config as { combos?: unknown }).combos;
  if (typeof combos !== "object" || combos === null || Array.isArray(combos)) return false;
  const combo = (combos as Record<string, unknown>)[model.id];
  if (typeof combo !== "object" || combo === null || Array.isArray(combo)) return false;
  const targets = (combo as { targets?: unknown }).targets;
  if (!Array.isArray(targets) || targets.length === 0) return false;
  return targets.every(target => {
    if (typeof target !== "object" || target === null || Array.isArray(target)) return false;
    const provider = (target as { provider?: unknown }).provider;
    const modelId = (target as { model?: unknown }).model;
    return typeof provider === "string"
      && provider.length > 0
      && provider === provider.trim()
      && provider !== "openai"
      && typeof modelId === "string"
      && modelId.length > 0
      && modelId === modelId.trim();
  });
}

export function buildDshClientConfig(ctx: ExportContext): DshGeneratedConfig {
  const direct = providerCodexAccountMode("openai", ctx.config?.providers?.openai) === "direct";
  const models: DshModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    if (direct && (model.native === true || model.provider === "openai")) continue;
    if (direct && model.provider === "combo" && (!ctx.config || !isKnownSafeDshCombo(model, ctx.config))) continue;
    const input = dshInputModalities(model.inputModalities);
    if (input === null) continue;
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    const reasoningEfforts = dshReasoningEfforts(model);
    models.push({
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
    });
  }
  return {
    "llm-pi-ai": {
      providers: {
        [OPENCODE_PROVIDER_ID]: {
          displayName: "OpenCodex",
          api: "openai-responses",
          baseURL: ctx.baseUrl,
          headers: { Authorization: "Bearer ocx_data_dsh" },
          models,
        },
      },
    },
  };
}

export function summarizeDsh(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as DshGeneratedConfig | undefined)?.["llm-pi-ai"]?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

export function buildDshContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildDshClientConfig(ctx);
  return singleFragment("dsh", ["llm-pi-ai", "providers", OPENCODE_PROVIDER_ID], doc["llm-pi-ai"].providers[OPENCODE_PROVIDER_ID]);
}
