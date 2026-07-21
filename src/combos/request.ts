import type { OcxComboDefaultEffort, OcxComboTarget } from "../types";
import { parseComboModelId } from "./types";

const warnedUnsupportedDefaults = new Set<string>();

export function resetComboEffortWarningStateForTests(): void {
  warnedUnsupportedDefaults.clear();
}

export function comboIdFromRawBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return parseComboModelId(model);
}

export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
  targetReasoningEfforts: readonly string[] | undefined,
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (!defaultEffort) return clone;
  const reasoning = clone.reasoning;
  const needsDefault = reasoning === undefined || (
    reasoning
    && typeof reasoning === "object"
    && !Array.isArray(reasoning)
    && !Object.prototype.hasOwnProperty.call(reasoning, "effort")
  );
  if (!needsDefault) return clone;
  if (!targetReasoningEfforts?.includes(defaultEffort)) {
    const key = `${target.provider}/${target.model}:${defaultEffort}`;
    if (!warnedUnsupportedDefaults.has(key)) {
      warnedUnsupportedDefaults.add(key);
      console.debug("[opencodex] combo default effort omitted", {
        provider: target.provider,
        model: target.model,
        requestedEffort: defaultEffort,
        capability: targetReasoningEfforts === undefined ? "unknown" : "unsupported",
      });
    }
    return clone;
  }
  if (reasoning === undefined) {
    clone.reasoning = { effort: defaultEffort };
  } else {
    clone.reasoning = { ...(reasoning as Record<string, unknown>), effort: defaultEffort };
  }
  return clone;
}
