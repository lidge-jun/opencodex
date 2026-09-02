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

/**
 * The reasoning-effort ladder Cursor's local-agent runtime attaches to a model, keyed by the
 * model id after its last `/`. Cursor decides this from its own table rather than from the
 * gateway's `reasoning_effort` list, so the dashboard can only PREDICT it; the values here
 * mirror that table (read from the 3.18.25 bundle) and carry no Cursor behavior of their own.
 * Null means Cursor shows no Reasoning control for the id. Distinct from
 * `src/adapters/cursor/effort-map.ts`, which maps opencodex efforts onto Cursor's *backend*
 * tiers for the outbound provider; this is what Cursor's *local* picker renders.
 */
const CURSOR_EFFORT_FAMILIES: ReadonlyArray<{ test: RegExp; ladder: readonly string[] }> = [
  { test: /^gpt-5[.-]6-(?:luna|sol|terra)$/u, ladder: ["low", "medium", "high", "xhigh"] },
  { test: /^gpt-5(?:\.\d+)?$/u, ladder: ["low", "medium", "high", "xhigh"] },
  { test: /^claude-opus-5$/u, ladder: ["low", "medium", "high", "xhigh", "max"] },
  { test: /^claude-opus-4[-.](?:7|8)$/u, ladder: ["low", "medium", "high", "xhigh", "max"] },
  { test: /^claude-sonnet-5$/u, ladder: ["low", "medium", "high", "xhigh", "max"] },
  { test: /^claude-opus-4[-.](?:5|6)$/u, ladder: ["low", "medium", "high", "max"] },
  { test: /^claude-sonnet-4[-.]6$/u, ladder: ["low", "medium", "high", "max"] },
  { test: /^grok-4[.-](?:3|5|6)(?:-(?:batch|build|nocomp))?$/u, ladder: ["minimal", "low", "medium", "high", "xhigh"] },
  { test: /^grok-build-latest$/u, ladder: ["minimal", "low", "medium", "high", "xhigh"] },
  { test: /^gemini-3\.[1-9].*flash-lite/u, ladder: [] },
  { test: /^gemini-/u, ladder: ["minimal", "low", "medium", "high"] },
];

export function cursorEffortFamily(modelId: string): string[] | null {
  let id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  const at = id.indexOf("@");
  if (at !== -1) id = id.slice(0, at);
  for (const family of CURSOR_EFFORT_FAMILIES) {
    if (family.test.test(id)) return family.ladder.length > 0 ? [...family.ladder] : null;
  }
  return null;
}

export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  /**
   * Larger opt-in window (Cursor "Max Mode"). When it exceeds contextWindow, the row advertises
   * the long window as context_length and the default window as the long-context threshold,
   * which makes Cursor's local runtime show a Context selector (default vs long, long marked
   * as costing more).
   */
  longContextWindow?: number;
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
  /**
   * Cursor reads the long-context threshold from `pricing.overrides[].min_prompt_tokens`. That
   * key sits outside its validated capability schema, so it is the one place a threshold can
   * be carried without failing row validation (`cost.long_context` is rejected by that schema).
   */
  pricing?: { overrides: Array<{ min_prompt_tokens: number }> };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

export function modelCapabilityFields(input: ModelCapabilityInput): ModelCapabilityFields {
  const efforts = (input.reasoningEfforts ?? []).filter(effort => typeof effort === "string" && effort.length > 0);
  const contextLength = positiveInt(input.contextWindow);
  const longContextLength = positiveInt(input.longContextWindow);
  const hasLongTier = contextLength !== undefined && longContextLength !== undefined && longContextLength > contextLength;
  const modalities = Array.isArray(input.inputModalities)
    ? input.inputModalities.filter(modality => typeof modality === "string" && modality.length > 0)
    : undefined;
  const supportsVision = modalities !== undefined ? modalities.includes("image") : undefined;
  return {
    api_types: [...OPENCODEX_MODEL_API_TYPES],
    capabilities: {
      ...(hasLongTier
        ? { context_length: longContextLength }
        : contextLength !== undefined ? { context_length: contextLength } : {}),
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
    ...(hasLongTier ? { pricing: { overrides: [{ min_prompt_tokens: contextLength }] } } : {}),
  };
}
