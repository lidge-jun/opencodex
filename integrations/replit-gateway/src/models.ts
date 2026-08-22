export function parseModelAllowlist(raw: string): string[] {
  const models = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (models.length === 0) {
    throw new Error("model allowlist must include at least one model id");
  }
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model)) {
      throw new Error(`duplicate model id in allowlist: ${model}`);
    }
    seen.add(model);
  }
  return models;
}

export function isModelAllowed(allowlist: ReadonlySet<string>, modelId: string): boolean {
  return allowlist.has(modelId);
}

export function toModelAllowlistSet(models: readonly string[]): ReadonlySet<string> {
  return new Set(models);
}

export function createOpenAiModelsResponse(models: readonly string[]): Response {
  return Response.json({
    object: "list",
    data: models.map((id) => ({ id, object: "model" })),
  });
}
