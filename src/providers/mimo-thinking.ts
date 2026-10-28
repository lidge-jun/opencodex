import type { ModelCapabilities } from "../types";

// Public MiMo V2.6 exposes an on/off switch, not distinct reasoning strengths.
export const MIMO_THINKING_MODELS = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"] as const;
export const MIMO_THINKING_CAPABILITIES: Record<string, ModelCapabilities> = Object.fromEntries(
  MIMO_THINKING_MODELS.map(id => [id, {
    supportsReasoning: true,
    supportsThinkingToggle: true,
    supportsReasoningEffort: false,
    defaultThinkingEnabled: true,
  }]),
);
