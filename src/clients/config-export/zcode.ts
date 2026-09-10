// ZCode config export.
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, inputModalitiesForClient, exportModelLabel, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";


/**
 * ZCode's `~/.zcode/v2/config.json` provider entry (observed schema, validated live
 * against ZCode 3.7.7 / 3.8.1 and re-extracted from 3.11.2's bundle).
 * `kind: "openai"` selects the OpenAI Responses protocol, which the proxy serves at
 * `/v1/responses`. ZCode's own dispatch is the authority: its
 * `getDefaultModelProviderEndpointPathForKind` maps `anthropic` to `/v1/messages`,
 * `openai` to `/responses`, and `openai-compatible` to `/chat/completions`.
 *
 * Responses is the only surface the proxy speaks natively. The Chat and Anthropic
 * inbounds translate their body into a Responses shape and replay it through
 * `handleResponses`, then translate the stream back, so the previous
 * `openai-compatible` wiring paid two translations per turn and reshaped tool-call
 * deltas and reasoning blocks on the way through.
 * `apiKeyRequired` keeps ZCode's UI from prompting for a key it does not need on
 * loopback; the serialized key is always the non-secret loopback placeholder.
 */
export interface ZcodeModelEntry {
  name?: string;
  limit?: { context: number; output?: number };
  modalities: { input: string[]; output: string[] };
  /**
   * On-disk Thought Level block. ZCode 3.x persists `variants`/`defaultVariant`
   * and parses them into in-memory `levels`/`defaultLevel`. Omit the field when
   * the catalog has no selectable ladder, so the picker stays hidden.
   */
  reasoning?: {
    enabled: boolean;
    variants: string[];
    defaultVariant?: string;
  };
}

export interface ZcodeProviderBlock {
  name: "OpenCodex";
  kind: "openai";
  enabled: true;
  source: "custom";
  options: {
    apiKey: string;
    baseURL: string;
    apiKeyRequired: true;
  };
  models: Record<string, ZcodeModelEntry>;
}

export interface ZcodeGeneratedConfig {
  provider: Record<string, ZcodeProviderBlock>;
}

/**
 * ZCode dials the OpenAI Responses surface (`openai`), which appends `/responses` to
 * `baseURL`. We supply `baseURL` with the `/v1` suffix so requests land on
 * `/v1/responses`; ZCode's `normalizeModelProviderBaseUrlForKind` strips only the
 * `/responses` suffix for this kind, so the `/v1` root survives. Model ids are the
 * proxy's canonical `provider/id` selectors, which `/v1/responses` resolves directly.
 * Context limits follow the authoritative-window rule: a model without one ships
 * without `limit` rather than guessing. Modalities are ZCode's observed
 * `text`-floor vocabulary; image-capable rows advertise image input.
 */
export function buildZcodeClientConfig(ctx: ExportContext): ZcodeGeneratedConfig {
  const models: Record<string, ZcodeModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const entry: ZcodeModelEntry = {
      name: exportModelLabel(model),
      modalities: { input, output: ["text"] },
    };
    // `limit.context` follows the authoritative-window rule. `output` is
    // deliberately absent: ZCode's schema makes it optional and we have no
    // authoritative output budget to assert (reviewer finding: an emitted
    // stand-in would be a guessed capability, exactly what "no metadata is
    // guessed" forbids).
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.limit = { context };
    }
    // `none` is a Codex omit-sentinel, not a ZCode picker option. Keep catalog
    // `ultra` when present: ZCode forwards the selected variant to the wire field its
    // kind uses — `reasoning.effort` on `openai`, which is what `/v1/responses` reads
    // natively. Set `defaultVariant` only when it survives that filter.
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => effort !== "none");
    if (efforts && efforts.length > 0) {
      const defaultVariant = model.defaultReasoningEffort?.trim().toLowerCase();
      entry.reasoning = {
        enabled: true,
        variants: efforts,
        ...(defaultVariant && efforts.includes(defaultVariant) ? { defaultVariant } : {}),
      };
    }
    models[model.namespaced] = entry;
  }
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        kind: "openai",
        enabled: true,
        source: "custom",
        options: {
          apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
          baseURL: ctx.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
          apiKeyRequired: true,
        },
        models,
      },
    },
  };
}

export function summarizeZcode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as ZcodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

export function buildZcodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildZcodeClientConfig(ctx);
  return singleFragment("zcode", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}
