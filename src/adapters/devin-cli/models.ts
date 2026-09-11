/**
 * Models the Devin CLI accepts on `session/new`.
 *
 * The CLI picks its own default when no model is named, so this roster exists
 * for the picker rather than as a gate. It is a static list on purpose: ACP has
 * no discovery call, and the vendor roster moves faster than a pinned copy
 * would, so an unknown id is passed through to the CLI to accept or refuse.
 */
export const DEVIN_CLI_DEFAULT_MODEL = "swe-2";

export const DEVIN_CLI_MODELS = [
  "swe-2",
  "swe-2-high",
  "claude-opus-5-medium",
  "claude-fable-5-1-medium",
  "claude-sonnet-5-medium",
  "gpt-6-astra-medium",
  "gpt-5-6-sol-medium",
  "gemini-3-8-flash-medium",
  "glm-5-3-high",
  "glm-5-3-low",
  "kimi-k3-high",
] as const;
