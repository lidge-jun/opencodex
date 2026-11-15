import { usageTotalTokens, type PersistedUsageAttempt, type UsageStatus } from "../usage/log";
import type { OcxUsage } from "../types";

interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

export function aggregateAttemptUsage(
  attempts: readonly PersistedUsageAttempt[],
): FinalizedUsageResult {
  // A usage-less attempt that never reached upstream spent nothing (summary.ts `spentNothing`),
  // so it cannot leave the row's usage unknown.
  const measured = attempts.filter(attempt => attempt.usage
    || (attempt.sendCount !== 0 && attempt.locallyAnswered !== true));
  const status: UsageStatus = measured.length > 0
    && measured.every(attempt => attempt.usageStatus === "unsupported")
    ? "unsupported"
    : measured.some(attempt => (
        attempt.usageStatus === "unreported" || attempt.usageStatus === "unsupported"
      ))
      ? "unreported"
      : measured.some(attempt => attempt.usageStatus === "estimated")
        ? "estimated"
        : measured.length > 0
          ? "reported"
          : "unreported";

  const usages = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
  if (usages.length === 0) return { status };

  const sumOptional = (
    key: "cachedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cacheCreation1hInputTokens"
      | "reasoningOutputTokens" | "providerCredits",
  ): number | undefined => {
    const present = usages.flatMap(usage => (
      typeof usage[key] === "number" ? [usage[key] as number] : []
    ));
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  // Readers take `cacheReadInputTokens ?? cachedInputTokens` (usage/cost.ts), so once any attempt
  // reports the read field, an attempt that only reports `cachedInputTokens` must count in it too.
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens") === undefined ? undefined
    : usages.reduce((sum, usage) => sum + (usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0), 0);
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const cacheCreation1hInputTokens = sumOptional("cacheCreation1hInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const providerCredits = sumOptional("providerCredits");
  const totalTokens = usages.reduce(
    (sum, usage) => sum + (usageTotalTokens(usage) ?? 0),
    0,
  );
  const aggregate: OcxUsage = {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation1hInputTokens !== undefined ? { cacheCreation1hInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(providerCredits !== undefined ? { providerCredits } : {}),
    ...(status === "estimated" ? { estimated: true } : {}),
    ...(usages.every(usage => usage.upstreamReported) ? { upstreamReported: true as const } : {}),
  };
  return { usage: aggregate, status, totalTokens };
}
