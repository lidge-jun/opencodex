export interface CursorModelInfo {
  id: string;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
  inputModalities?: string[];
}

export const CURSOR_DEFAULT_CONTEXT_WINDOW = 128_000;

const CURSOR_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const CURSOR_DEFAULT_INPUT_MODALITIES = ["text", "image"] as const;
const CONTEXT_1M = 1_000_000;
const CONTEXT_400K = 400_000;
const CONTEXT_256K = 256_000;
const CONTEXT_200K = 200_000;

export function inferCursorContextWindow(modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (id.includes("1m")) return CONTEXT_1M;
  if (id.startsWith("gemini-")) return CONTEXT_1M;
  if (id === "glm-5.2") return CONTEXT_1M;
  if (id.startsWith("gpt-5.4") || id === "gpt-5.5") return CONTEXT_400K;
  if (id.startsWith("grok-")) return CONTEXT_256K;
  if (id.includes("claude")) return CONTEXT_200K;
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

  // Cursor public Models & Pricing reference. Live discovery stays disabled;
  // these ids only seed the routed Codex catalog.
  // Cursor base ids (the request builder appends the per-model effort suffix, see effort-map.ts).
  // Reasoning models advertise effort so Codex exposes the tier picker.
  { id: "claude-4-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-opus", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4.6-opus", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4.6-sonnet", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-opus-4-7", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-opus-4-8", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-fable-5", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },

  { id: "composer-1" },
  { id: "composer-1.5" },
  { id: "composer-2" },
  { id: "composer-2.5" },

  { id: "gemini-2.5-flash", contextWindow: CONTEXT_1M },
  { id: "gemini-3-flash", contextWindow: CONTEXT_1M },
  { id: "gemini-3-pro", contextWindow: CONTEXT_1M },
  { id: "gemini-3-pro-image-preview", contextWindow: CONTEXT_1M },
  { id: "gemini-3.1-pro", contextWindow: CONTEXT_1M },
  { id: "gemini-3.5-flash", contextWindow: CONTEXT_1M },

  { id: "glm-5.2", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },

  { id: "gpt-5", supportsReasoningEffort: true },
  { id: "gpt-5-high", supportsReasoningEffort: true },
  { id: "gpt-5-fast", supportsReasoningEffort: true },
  { id: "gpt-5-high-fast", supportsReasoningEffort: true },
  { id: "gpt-5-low-fast", supportsReasoningEffort: true },
  { id: "gpt-5-mini" },
  { id: "gpt-5-codex", supportsReasoningEffort: true },
  { id: "gpt-5.1-codex", supportsReasoningEffort: true },
  { id: "gpt-5.1-codex-max", supportsReasoningEffort: true },
  { id: "gpt-5.1-codex-mini", supportsReasoningEffort: true },
  { id: "gpt-5.2", supportsReasoningEffort: true },
  { id: "gpt-5.2-high", supportsReasoningEffort: true },
  { id: "gpt-5.2-codex", supportsReasoningEffort: true },
  { id: "gpt-5.3-codex", supportsReasoningEffort: true },
  { id: "gpt-5.3-codex-high", supportsReasoningEffort: true },
  { id: "gpt-5.4", contextWindow: CONTEXT_400K, supportsReasoningEffort: true },
  { id: "gpt-5.4-mini", contextWindow: CONTEXT_400K },
  { id: "gpt-5.4-nano", contextWindow: CONTEXT_400K },
  { id: "gpt-5.5", contextWindow: CONTEXT_400K, supportsReasoningEffort: true },

  { id: "grok-4.20", contextWindow: CONTEXT_256K, supportsReasoningEffort: true },
  { id: "grok-4.3", contextWindow: CONTEXT_256K, supportsReasoningEffort: true },
  { id: "grok-build-0.1", contextWindow: CONTEXT_256K },

  { id: "kimi-k2.5" },
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
