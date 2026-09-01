/**
 * Extended capability advertisement for the OpenAI-shape `GET /v1/models` list.
 *
 * Cursor's local-agent runtime (the "Private Inference" build, `localMode=true`) enables its
 * reasoning-effort control only when at least one row in `data[]` carries `api_types` naming an
 * API family it can speak, optionally with a `capabilities` object. Plain OpenAI clients, Grok
 * Build, and the Codex catalog branch ignore both keys. Every OpenCodex route serves Chat
 * Completions, Responses and Anthropic Messages, streams, and accepts tool calls, so those are
 * constants; context length and vision come from catalog data when known and are omitted
 * otherwise, matching Cursor's optional-field schema.
 */

/**
 * Membership is load-bearing for Cursor: its wire selector picks the Anthropic Messages path only
 * when NO OpenAI-family type (`chat_completions`/`responses`/`openai_chat`/`openai_responses`)
 * is present. Keep at least one OpenAI-family entry; a unit test guards this.
 */
export const OPENCODEX_MODEL_API_TYPES: readonly string[] = Object.freeze(["chat_completions", "responses", "anthropic_messages"]);

export const OPENAI_FAMILY_API_TYPES: ReadonlySet<string> = new Set(["chat_completions", "responses", "openai_chat", "openai_responses"]);

export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  inputModalities?: readonly string[];
}

export interface ModelCapabilityFields {
  api_types: readonly string[];
  capabilities: {
    context_length?: number;
    /** Cursor's extended-row filter REQUIRES this to contain "text"; every route emits text. */
    output_modalities: string[];
    input_modalities?: string[];
    supports_tool_use: true;
    supports_streaming: true;
    supports_reasoning: boolean;
    supports_vision?: boolean;
    reasoning_effort?: string[];
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function modelCapabilityFields(input: ModelCapabilityInput): ModelCapabilityFields {
  const efforts = (input.reasoningEfforts ?? []).filter(effort => typeof effort === "string" && effort.length > 0);
  const contextLength = positiveInt(input.contextWindow);
  const modalities = Array.isArray(input.inputModalities)
    ? input.inputModalities.filter(modality => typeof modality === "string" && modality.length > 0)
    : undefined;
  const supportsVision = modalities !== undefined ? modalities.includes("image") : undefined;
  return {
    api_types: [...OPENCODEX_MODEL_API_TYPES],
    capabilities: {
      ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      // Once a gateway advertises api_types, Cursor keeps only rows whose output_modalities
      // include "text"; omitting the key drops the row from the extended catalog.
      output_modalities: ["text"],
      ...(modalities !== undefined && modalities.length > 0 ? { input_modalities: [...modalities] } : {}),
      supports_tool_use: true,
      supports_streaming: true,
      supports_reasoning: efforts.length > 0,
      ...(supportsVision !== undefined ? { supports_vision: supportsVision } : {}),
      ...(efforts.length > 0 ? { reasoning_effort: [...efforts] } : {}),
    },
  };
}
