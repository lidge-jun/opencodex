function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeWorkflowEffort(value: unknown): unknown {
  return typeof value === "string" && value.trim().toLowerCase() === "ultra" ? "max" : value;
}

/**
 * Mirasim's native Responses compact route consumes the official compact request shape rather
 * than OpenCodex's local summary prompt. The official client normalizes its workflow-only
 * "ultra" selector to the single-request wire effort "max" before signing.
 */
export function normalizeMirasimCompactBody(
  body: Readonly<Record<string, unknown>>,
  wireModelId: string,
): Record<string, unknown> {
  const model = wireModelId.trim();
  if (!model.toLowerCase().startsWith("gpt-")) {
    throw new Error("Mirasim native compact is available only for GPT Responses models");
  }

  const normalized: Record<string, unknown> = { ...body, model };
  delete normalized.stream;

  const reasoning = plainRecord(normalized.reasoning);
  if (reasoning) {
    normalized.reasoning = {
      ...reasoning,
      effort: normalizeWorkflowEffort(reasoning.effort),
    };
  }
  if ("reasoning_effort" in normalized) {
    normalized.reasoning_effort = normalizeWorkflowEffort(normalized.reasoning_effort);
  }
  const outputConfig = plainRecord(normalized.output_config);
  if (outputConfig) {
    normalized.output_config = {
      ...outputConfig,
      effort: normalizeWorkflowEffort(outputConfig.effort),
    };
  }
  return normalized;
}
