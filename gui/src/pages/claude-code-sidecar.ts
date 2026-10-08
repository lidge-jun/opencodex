/**
 * Claude Code sidecar override helpers — keep Auto as an in-memory draft so
 * users can enter a model before persist. Empty Auto persists only when it
 * carries an explicit pool edit.
 */

import type { AnthropicInstanceId, SidecarOverride, VisionOverrideBackend } from "./claude-manual-env";

export type SidecarSelectValue = "inherit" | "auto" | VisionOverrideBackend;

export type PersistedSidecarOverride = {
  backend: VisionOverrideBackend | null;
  model: string;
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

/** Model typing updates the draft in place; empty Auto stays selectable until save. */
export function applySidecarModelChange(
  override: SidecarOverride | undefined,
  model: string,
): SidecarOverride {
  return { ...override, model };
}

/**
 * Persist shape for PUT /api/claude-code.
 * Empty Auto drafts ({ backend: undefined } / blank model) become null → reload as Inherit.
 */
export function serializeSidecarOverride(
  override?: SidecarOverride,
): PersistedSidecarOverride | null {
  if (!override) return null;
  const trimmed = (override.model ?? "").trim();
  if (!override.backend) {
    if (!trimmed && override.anthropicInstance === undefined) return null;
    return { backend: null, model: trimmed,
      ...(override.anthropicInstance !== undefined ? { anthropicInstance: override.anthropicInstance } : {}) };
  }
  return { backend: override.backend, model: trimmed,
    ...(override.anthropicInstance !== undefined ? { anthropicInstance: override.anthropicInstance } : {}) };
}
