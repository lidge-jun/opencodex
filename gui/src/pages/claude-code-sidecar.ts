/**
 * Claude Code sidecar override helpers — keep Auto as an in-memory draft so
 * users can enter a model before persist. Empty Auto persists only when it
 * carries an explicit activation state or pool edit.
 */

import type { AnthropicInstanceId, SidecarOverride, VisionOverrideBackend } from "./claude-manual-env";

export type SidecarSelectValue = "inherit" | "auto" | VisionOverrideBackend;

// Draft-only provenance follows object spreads but cannot enter JSON or the PUT shape.
const modelEditStartedDisabled = Symbol("modelEditStartedDisabled");
type SidecarDraft = SidecarOverride & { [modelEditStartedDisabled]?: true };

/** A confirmed save starts a new editing baseline; drafts without a pending marker keep their identity. */
export function confirmSidecarOverride(override?: SidecarOverride): SidecarOverride | undefined {
  if (!override || !(override as SidecarDraft)[modelEditStartedDisabled]) return override;
  const next = { ...override } as SidecarDraft;
  delete next[modelEditStartedDisabled];
  return next;
}

export type PersistedSidecarOverride = {
  enabled?: boolean;
  backend?: VisionOverrideBackend | null;
  model?: string;
  anthropicInstance?: AnthropicInstanceId | null;
};

/** Select value: any in-memory override without a backend is Auto (including empty drafts). */
export function sidecarSelectValue(override?: SidecarOverride): SidecarSelectValue {
  if (!override) return "inherit";
  return override.backend ?? "auto";
}

/** Backend select changes. Inherit clears; Auto/OpenAI/Anthropic preserve model. */
export function applySidecarBackendChange(
  override: SidecarOverride | undefined,
  value: SidecarSelectValue,
): SidecarOverride | undefined {
  if (value === "inherit") return undefined;
  const next = { ...override, backend: value === "auto" ? undefined : value };
  if (value !== "anthropic" && next.anthropicInstance !== undefined) next.anthropicInstance = null;
  return next;
}

export function applySidecarPoolChange(override: SidecarOverride | undefined, value: string): SidecarOverride {
  const next = { ...override };
  if (value === "anthropic" || value === "anthropic2") next.anthropicInstance = value;
  else if (next.anthropicInstance !== undefined) next.anthropicInstance = null;
  return next;
}

/** Model edits preserve activation unless this draft started disabled. */
export function applySidecarModelChange(
  override: SidecarOverride | undefined,
  model: string,
): SidecarOverride {
  const startedDisabled = override?.enabled === false || (override as SidecarDraft | undefined)?.[modelEditStartedDisabled];
  return { ...override, model, ...(startedDisabled ? {
    enabled: model.trim().length > 0, [modelEditStartedDisabled]: true as const,
  } : {}) };
}

/**
 * Persist shape for PUT /api/claude-code.
 * Empty Auto drafts become null → Inherit unless an explicit activation state must survive.
 */
export function serializeSidecarOverride(
  override?: SidecarOverride,
): PersistedSidecarOverride | null {
  if (!override) return null;
  const trimmed = (override.model ?? "").trim();
  const activation = override.enabled === undefined ? {} : { enabled: override.enabled };
  if (!override.backend) {
    if (!trimmed && override.anthropicInstance === undefined) return override.enabled === undefined ? null : { ...activation, backend: null, model: "" };
    return { ...activation, backend: null, model: trimmed,
      ...(override.anthropicInstance !== undefined ? { anthropicInstance: override.anthropicInstance } : {}) };
  }
  return { ...activation, backend: override.backend, model: trimmed,
    ...(override.anthropicInstance !== undefined ? { anthropicInstance: override.anthropicInstance } : {}) };
}
