import type { OcxComboDefaultEffort, OcxComboTarget, OcxConfig } from "../types";
import { resolveComboId } from "./types";

const warnedUnsupportedDefaults = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileComboWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = warnedUnsupportedDefaults.size;
  warnedUnsupportedDefaults.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

export function resetComboEffortWarningStateForTests(): void {
  warnedUnsupportedDefaults.clear();
}

export function comboIdFromRawBody(body: unknown, config: OcxConfig): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return resolveComboId(config, model);
}

/**
 * Detect image-bearing Responses *input* only.
 *
 * Must not walk the full request body: tool JSON schemas, metadata, or extension
 * payloads can legally contain `{ "type": "input_image" }` without any image
 * being dispatched. After previous_response_id expansion, scan the materialised
 * `input` tree (message content and function_call_output.output).
 */
export function comboRequestHasImageInput(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return responsesInputHasImage((body as { input?: unknown }).input);
}

function responsesInputHasImage(input: unknown): boolean {
  if (typeof input === "string" || input == null) return false;
  if (!Array.isArray(input)) return false;
  return input.some(responsesInputNodeHasImage);
}

function responsesInputNodeHasImage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(responsesInputNodeHasImage);
  const record = value as Record<string, unknown>;
  if (record.type === "input_image") return true;
  // Message content parts and nested function_call_output content/output arrays.
  if (record.content !== undefined && responsesInputNodeHasImage(record.content)) return true;
  if (record.output !== undefined && responsesInputNodeHasImage(record.output)) return true;
  return false;
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
  // Picker availability treats an unknown ladder as a wildcard, but runtime
  // injection stays fail-closed until this concrete target advertises support.
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
