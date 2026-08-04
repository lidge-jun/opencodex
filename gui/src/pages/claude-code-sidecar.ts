/**
 * Claude Code sidecar override helpers — keep Auto as an in-memory draft so
 * users can enter a model before persist, and only serialize Auto when a
 * trimmed model is present.
 */

import type { SidecarBackend, SidecarOverride } from "./claude-manual-env";

export type SidecarSelectValue = "inherit" | "auto" | SidecarBackend;

export type PersistedSidecarOverride = {
  backend: SidecarBackend | null;
  model: string;
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
  if (value === "auto") return { ...override, backend: undefined };
  return { ...override, backend: value };
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
    if (!trimmed) return null;
    return { backend: null, model: trimmed };
  }
  return { backend: override.backend, model: trimmed };
}
