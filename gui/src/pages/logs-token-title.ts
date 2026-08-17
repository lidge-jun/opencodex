import type { TFn } from "../i18n/shared";

interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  contextTotalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface TokenTitleEntry {
  provider: string;
  usageStatus?: string;
  usage?: TokenUsageBreakdown;
}

export function isCursorUsageProvider(provider: string): boolean {
  return provider === "cursor" || provider.startsWith("cursor-");
}

/** Cache read/write split; recovers reads from legacy rows that stored read+write combined. */
export function cacheSplit(log: TokenTitleEntry): { read?: number; write?: number } {
  const u = log.usage;
  if (!u) return {};
  const write = typeof u.cacheCreationInputTokens === "number" ? u.cacheCreationInputTokens : undefined;
  const read = typeof u.cacheReadInputTokens === "number"
    ? u.cacheReadInputTokens
    : typeof u.cachedInputTokens === "number" && write !== undefined
      ? Math.max(0, u.cachedInputTokens - write)
      : u.cachedInputTokens;
  return { read, write };
}

export function tokensTitle(log: TokenTitleEntry, t: TFn): string | undefined {
  if (!log.usage) return undefined;
  const split = cacheSplit(log);
  const parts = [
    `${t("logs.tokens.input")}=${log.usage.inputTokens}`,
    `${t("logs.tokens.output")}=${log.usage.outputTokens}`,
  ];
  if (split.read !== undefined) parts.push(`${t("logs.tokens.cacheRead")}=${split.read}`);
  if (split.write !== undefined) parts.push(`${t("logs.tokens.cacheWrite")}=${split.write}`);
  if (typeof log.usage.contextTotalTokens === "number") {
    parts.push(`${t("logs.tokens.contextTotal")}=${log.usage.contextTotalTokens}`);
  }
  if (typeof log.usage.reasoningOutputTokens === "number") {
    parts.push(`${t("logs.tokens.reasoning")}=${log.usage.reasoningOutputTokens}`);
  }
  if (log.usageStatus === "estimated") parts.push(t("logs.tokens.estimatedNote"));
  if (log.usageStatus === "estimated" && split.read === undefined && split.write === undefined) {
    parts.push(t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursorNote" : "logs.tokens.noCacheNote"));
  }
  return parts.join(" \u00B7 ");
}
