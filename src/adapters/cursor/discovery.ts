export interface CursorModelInfo {
  id: string;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
  inputModalities?: string[];
}

export const CURSOR_DEFAULT_CONTEXT_WINDOW = 128_000;

const CURSOR_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const CURSOR_DEFAULT_INPUT_MODALITIES = ["text", "image"] as const;

export function inferCursorContextWindow(modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (id === "gpt-5.5") return 400_000;
  if (id.includes("claude") && id.includes("sonnet")) return 200_000;
  return CURSOR_DEFAULT_CONTEXT_WINDOW;
}

function normalizeInputModalities(input: string[] | undefined): string[] {
  const values = (input ?? [...CURSOR_DEFAULT_INPUT_MODALITIES])
    .map(item => item.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : [...CURSOR_DEFAULT_INPUT_MODALITIES];
}

export function normalizeCursorModels(models: readonly CursorModelInfo[]): CursorModelInfo[] {
  const byId = new Map<string, CursorModelInfo>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : inferCursorContextWindow(id),
      supportsReasoningEffort: model.supportsReasoningEffort === true,
      inputModalities: normalizeInputModalities(model.inputModalities),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
  { id: "auto", contextWindow: CURSOR_DEFAULT_CONTEXT_WINDOW, supportsReasoningEffort: false },
  { id: "claude-4.5-sonnet", contextWindow: 200_000, supportsReasoningEffort: false },
  { id: "gpt-5.5", contextWindow: 400_000, supportsReasoningEffort: true },
]);

export function cursorModelIds(models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS): string[] {
  return normalizeCursorModels(models).map(model => model.id);
}

export function cursorModelContextWindows(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, number> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [model.id, model.contextWindow ?? inferCursorContextWindow(model.id)]),
  );
}

export function cursorModelInputModalities(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, string[]> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [model.id, normalizeInputModalities(model.inputModalities)]),
  );
}

export function cursorModelReasoningEfforts(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, string[]> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [
      model.id,
      model.supportsReasoningEffort === true ? [...CURSOR_REASONING_EFFORTS] : [],
    ]),
  );
}
