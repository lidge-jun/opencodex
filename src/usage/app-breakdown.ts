import { normalizeRecordedClient } from "./client";

/** Closed report categories; an absent historical client is kept distinct. */
export const USAGE_APPS = ["codex", "claude_code", "claude_desktop", "grok", "opencode", "aside", "other", "unknown", "unclassified"] as const;
export type UsageApp = typeof USAGE_APPS[number];

export function usageApp(client: unknown): UsageApp {
  const normalized = normalizeRecordedClient(client);
  if (normalized === undefined) return "unclassified";
  if (normalized === "codex_cli" || normalized === "codex_desktop" || normalized === "codex_ide") return "codex";
  return normalized;
}

export interface UsageAppSummary {
  client: UsageApp;
  requests: number;
  measuredRequests: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  pricedRequests: number;
  unpricedRequests: number;
  shareRatio: number;
}
