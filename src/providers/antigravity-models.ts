// Google Antigravity (Cloud Code Assist) bundled model list.
//
// Single source of truth: the Antigravity `:fetchAvailableModels` backend, the same one the `agy`
// CLI resolves labels against. The ids below separate CCA wire ids, collapsed picker entries,
// and hidden compatibility aliases for saved selections. The CCA envelope's `model` field must
// receive the wire id (for example "Gemini 3.1 Pro (High)" => gemini-pro-agent), while the
// picker exposes collapsed base models with reasoning-effort routing.

// ── Wire IDs (what CCA :fetchAvailableModels returns) ──
const ANTIGRAVITY_WIRE_MODELS = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// ── Effort ladders per collapsed base model ──
// Gemini models: effort → wire model suffix (official agy UI pattern).
// Claude Opus: effort → thinkingConfig.thinkingLevel (CLIProxyAPI proven pattern).
export const ANTIGRAVITY_MODEL_EFFORTS: Record<string, string[]> = {
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-6-thinking": ["low", "medium", "high", "max"],
};

// ── Effort → wire model map for Gemini base models ──
const ANTIGRAVITY_EFFORT_WIRE_MAP: Record<string, Record<string, string>> = {
  "gemini-3.6-flash": {
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
  },
  "gemini-3.1-pro": {
    low: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  },
};

// ── Default effort per Gemini base model ──
const ANTIGRAVITY_DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.6-flash": "medium",
  "gemini-3.1-pro": "high",
};

// ── Visible client aliases (kept for saved-config compat, not picker-visible) ──
const ANTIGRAVITY_VISIBLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
};

// ── Hidden compatibility aliases for saved selections ──
// Wire suffix IDs are identity aliases — they resolve to themselves so saved configs
// with explicit suffixes (e.g. gemini-3.6-flash-low) continue to work.
const ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.6-flash-low": "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium": "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high": "gemini-3.6-flash-high",
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-pro-agent": "gemini-pro-agent",
  "gemini-3.5-flash-extra-low": "gemini-3.6-flash-low",
  "gemini-3.5-flash-low": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-mid": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-high": "gemini-3.6-flash-high",
  "gemini-3-flash-agent": "gemini-3.6-flash-high",
};

export const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  ...ANTIGRAVITY_VISIBLE_MODEL_ALIASES,
  ...ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES,
};

// Picker-visible: collapsed base models only.
export const ANTIGRAVITY_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.1-pro",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// Context windows from the upstream `:fetchAvailableModels` maxTokens per model.
const ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.6-flash-low": 1_048_576,
  "gemini-3.6-flash-medium": 1_048_576,
  "gemini-3.6-flash-high": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "gpt-oss-120b-medium": 131_072,
};

export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Collapsed base IDs — explicit entries for the picker.
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  // Wire IDs and aliases via derivation.
  ...ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS,
  ...Object.fromEntries(
    Object.entries(ANTIGRAVITY_MODEL_ALIASES).map(([alias, wire]) => [
      alias,
      ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS[wire],
    ]),
  ),
};

export function resolveAntigravityWireModelId(modelId: string): string {
  return ANTIGRAVITY_MODEL_ALIASES[modelId] ?? modelId;
}

/**
 * Whether the given model ID is a suffix wire ID or compat alias that already encodes
 * an effort level. For these IDs, the caller must NOT send thinkingConfig — the suffix
 * IS the effort, and sending both creates a contradictory request.
 */
export function isAntigravitySuffixModelId(modelId: string): boolean {
  return !(ANTIGRAVITY_MODELS as string[]).includes(modelId);
}

/**
 * Resolve a picker-visible base model + optional reasoning effort to the CCA wire model ID.
 *
 * Precedence (evaluated in order):
 * 1. Suffix wire ID or compat alias → resolve via `resolveAntigravityWireModelId`, no thinkingConfig.
 * 2. Mapped Gemini base with effort → return mapped wire ID + thinkingLevel.
 * 3. Mapped Gemini base without effort → return default-effort wire ID, no thinkingConfig.
 * 4. Claude Opus with effort → return identity + thinkingLevel (no suffix variants exist).
 * 5. All other IDs → return `resolveAntigravityWireModelId(modelId)`, no thinkingConfig.
 */
export function resolveAntigravityEffortWireModel(
  modelId: string,
  effort?: string,
): { wireModelId: string; thinkingLevel?: string } {
  // Rule 1: suffix/compat alias — suffix IS the effort.
  if (isAntigravitySuffixModelId(modelId)) {
    return { wireModelId: resolveAntigravityWireModelId(modelId) };
  }

  // Rule 2/3: mapped Gemini base model.
  const effortMap = ANTIGRAVITY_EFFORT_WIRE_MAP[modelId];
  if (effortMap) {
    if (effort && effort in effortMap) {
      return { wireModelId: effortMap[effort]!, thinkingLevel: effort };
    }
    const defaultEffort = ANTIGRAVITY_DEFAULT_EFFORT[modelId]!;
    return { wireModelId: effortMap[defaultEffort]! };
  }

  // Rule 4: Claude models — effort via thinkingConfig only (no suffix variants).
  // Anthropic adaptive thinking supports low/medium/high/max for both Sonnet 4.6 and Opus 4.6.
  // CLIProxyAPI proves CCA accepts thinkingConfig on base IDs (validation confirmed).
  if (/^claude-/.test(modelId) && effort) {
    return { wireModelId: modelId, thinkingLevel: effort };
  }

  // Rule 5: everything else.
  return { wireModelId: resolveAntigravityWireModelId(modelId) };
}
