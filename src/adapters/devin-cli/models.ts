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

/**
 * Context windows for the CLI roster, in the same effort-suffixed ids the CLI
 * accepts.
 *
 * Without this the picker fell back to the 128k default for every Devin CLI
 * model, including `swe-2`, which is the roster's own default — so the one
 * model most sessions ran reported less than half its real window.
 *
 * The numbers come from Cognition's `GetCascadeModelConfigs` catalog
 * (`ClientModelConfig` field #18), which is the only first-party source: the
 * Devin CLI and Desktop model pages, the SWE-2 announcement, and the Windsurf
 * model reference all list these models without a window. The CLI is a separate
 * product from the cloud, but Cognition documents the same models on both and
 * describes no per-surface difference — the SWE-2 announcement ships it to
 * Desktop, CLI, Web, and Fusion in one sentence — so the catalog's figure is
 * used for both rather than inventing a second table.
 *
 * ACP has no discovery call, so unlike the cloud provider this cannot be
 * refreshed live; it needs updating when the roster above does.
 */
export const DEVIN_CLI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-2": 262_000,
  "swe-2-high": 262_000,
  "claude-opus-5-medium": 1_000_000,
  "claude-fable-5-1-medium": 1_000_000,
  "claude-sonnet-5-medium": 1_000_000,
  "gpt-6-astra-medium": 1_000_000,
  "gpt-5-6-sol-medium": 1_000_000,
  "gemini-3-8-flash-medium": 1_048_576,
  "glm-5-3-high": 1_048_576,
  "glm-5-3-low": 1_048_576,
  "kimi-k3-high": 1_048_576,
};
