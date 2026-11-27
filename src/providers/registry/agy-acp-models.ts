/** Static catalog metadata shared by registry derivation and structural config validation. */
export const AGY_ACP_DEFAULT_MODEL = "gemini-3.8-flash";
export const AGY_ACP_SEED_MODELS = [
  AGY_ACP_DEFAULT_MODEL,
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-4-hydrogen",
  "gemini-3.7-flash",
  "gemini-pro-orchestrator-neon",
  "gemini-pro-orchestrator",
  "gemini-pro-orchestrator-argon",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
] as const;
