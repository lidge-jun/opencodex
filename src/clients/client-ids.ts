/** Shared, dependency-free export client roster for runtime types and CLI discovery. */
export const EXPORT_CLIENT_IDS = [
  "qoder", "qoder-cn", "workbuddy", "workbuddy-ai", "opencode", "pi", "omp", "hermes",
  "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "commandcode", "prime", "aside",
  "raycast", "omo", "cline", "kilo", "droid", "gentle-shell", "t3code",
] as const;
export type ExportClientId = (typeof EXPORT_CLIENT_IDS)[number];
