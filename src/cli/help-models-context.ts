/** Exact runtime usage row, including its indentation. No runtime imports. */
export const MODELS_CONTEXT_USAGE = "  ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]";

export const MODELS_CONTEXT_DETAILS = [
  "Manage context caps for routed providers.",
  "status: read current settings without changing them (the default action).",
  "value <tokens>: set a positive token cap for future toggles; --set-all also applies it to every routed provider.",
  "provider <name> on|off: enable or disable a provider cap; on accepts --value <tokens> for that provider only.",
  "all on|off: enable or disable caps for every routed provider.",
  "--json: print the result as JSON.",
  "",
  "Examples:",
  "  ocx models context status --json",
  "  ocx models context value 128000",
  "  ocx models context provider openai on --value 128000",
  "  ocx models context all off",
] as const;
