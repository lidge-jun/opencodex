export function usageSummary30dResourceKey(apiBase: string, surface: "all" | "codex" = "all"): string {
  return surface === "codex"
    ? ["usage-summary-30d", apiBase, "codex"].join(":")
    : ["usage-summary-30d", apiBase, "all"].join(":");
}
