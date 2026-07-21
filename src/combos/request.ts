import type { OcxComboDefaultEffort, OcxComboTarget, OcxConfig } from "../types";
import { resolveComboId } from "./types";

export function comboIdFromRawBody(body: unknown, config: OcxConfig): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return resolveComboId(config, model);
}

export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (!defaultEffort) return clone;
  const reasoning = clone.reasoning;
  if (reasoning === undefined) {
    clone.reasoning = { effort: defaultEffort };
  } else if (
    reasoning
    && typeof reasoning === "object"
    && !Array.isArray(reasoning)
    && !Object.prototype.hasOwnProperty.call(reasoning, "effort")
  ) {
    clone.reasoning = { ...(reasoning as Record<string, unknown>), effort: defaultEffort };
  }
  return clone;
}
