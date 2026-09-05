// Oh My Pi config export.
import type { PiModelEntry, ExportModel, ExportContext, ManagedContribution } from "./contracts";
import { PI_API_DIALECT, OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { normalizeExportModels, inputModalitiesForClient, exportModelLabel, authoritativeContextWindow, outputBudgetFor, singleFragment } from "./model-metadata";


/**
 * omp accepts a model-level API override. Keep the provider on Chat
 * Completions so routed providers retain their established wire format, while
 * native OpenAI models can use the lossless Responses surface.
 */
export interface OmpModelEntry extends PiModelEntry {
  api?: "openai-responses";
  /** omp requires this flag before it honors a thinking block. */
  reasoning?: true;
  thinking?: {
    mode: "effort";
    efforts: string[];
    defaultLevel?: string;
  };
}

export interface OmpProviderBlock {
  baseUrl: string;
  api: typeof PI_API_DIALECT;
  apiKey: string;
  models: OmpModelEntry[];
}

export interface OmpGeneratedConfig {
  providers: Record<string, OmpProviderBlock>;
}

/**
 * omp validates model entries strictly. These are its documented effort
 * values; omit an unknown value rather than invalidating the whole provider.
 */
const OMP_EFFORT_VOCABULARY = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function ompEfforts(model: ExportModel): string[] {
  const efforts: string[] = [];
  for (const effort of model.reasoningEfforts ?? []) {
    const normalized = effort.trim().toLowerCase();
    if (OMP_EFFORT_VOCABULARY.has(normalized) && !efforts.includes(normalized)) {
      efforts.push(normalized);
    }
  }
  return efforts;
}

/**
 * omp's models.yml is Pi-like, but it supports effort metadata and a per-model
 * API dialect. Native OpenAI models use Responses; all routed models inherit
 * the provider's existing Chat Completions dialect.
 */
export function buildOmpClientConfig(ctx: ExportContext): OmpGeneratedConfig {
  const models: OmpModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const entry: OmpModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
      ...(model.native && model.provider === "openai" ? { api: "openai-responses" } : {}),
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    const efforts = ompEfforts(model);
    if (efforts.length > 0) {
      const defaultLevel = model.defaultReasoningEffort?.trim().toLowerCase();
      entry.reasoning = true;
      entry.thinking = {
        mode: "effort",
        efforts,
        ...(defaultLevel && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
      };
    }
    models.push(entry);
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        api: PI_API_DIALECT,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        models,
      },
    },
  };
}

export function summarizeOmp(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as OmpGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

export function buildOmpContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildOmpClientConfig(ctx);
  return singleFragment("omp", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}
