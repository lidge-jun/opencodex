import type { PersistedUsageEntry, PersistedUsageAttempt, UsageStatus } from "../../src/usage/log";

export interface RandomizedUsageRollupFixture {
  entries: PersistedUsageEntry[];
  foldBoundaryTimestamp: number;
  duplicateRequestId: string;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function attempt(
  ordinal: number,
  provider: string,
  model: string,
  usageStatus: UsageStatus,
  inputTokens: number,
  outputTokens: number,
): PersistedUsageAttempt {
  return {
    ordinal, provider, model, adapter: "openai-chat", status: 200, durationMs: ordinal,
    sendCount: 1, recoveryKinds: [], usageStatus,
    usage: { inputTokens, outputTokens }, totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Deterministic randomized corpus for the phase-020 fold-plus-tail property test.
 * It deliberately includes combo attempts, out-of-order timestamps, entries on
 * the fold-boundary day, and a cross-day duplicate-id pair for the documented
 * out-of-domain assertion. Phase 020 filters that pair for its in-domain run.
 */
export function generateRandomizedUsageRollupFixture(
  seed = 0x260804,
  now = Date.UTC(2026, 7, 4, 12),
  count = 80,
): RandomizedUsageRollupFixture {
  const random = mulberry32(seed);
  const dayMs = 86_400_000;
  const foldBoundaryTimestamp = now - 9 * dayMs;
  const providers = ["openai", "anthropic", "kiro"] as const;
  const models = ["gpt-5.5", "claude-fable-5", "claude-sonnet-4-6"] as const;
  const statuses: UsageStatus[] = ["reported", "estimated", "unreported", "unsupported"];
  const entries: PersistedUsageEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const dayOffset = Math.floor(random() * 18);
    const timestamp = index % 11 === 0
      ? foldBoundaryTimestamp + (index % 2) * 60_000
      : now - dayOffset * dayMs - Math.floor(random() * dayMs);
    const provider = providers[Math.floor(random() * providers.length)]!;
    const model = models[Math.floor(random() * models.length)]!;
    const status = statuses[Math.floor(random() * statuses.length)]!;
    const inputTokens = 1 + Math.floor(random() * 500);
    const outputTokens = 1 + Math.floor(random() * 100);
    const combo = index % 7 === 0;
    entries.push({
      requestId: `property-${seed}-${index}`,
      timestamp,
      provider,
      model,
      ...(index % 4 === 0 ? { surface: "claude-desktop" as const } : {}),
      ...(index % 3 === 0 ? { admissionKind: "configured" as const, apiKeyId: `key-${index % 5}` } : {}),
      status: 200,
      durationMs: 10,
      usageStatus: status,
      ...(status === "reported" || status === "estimated"
        ? { usage: { inputTokens, outputTokens, ...(status === "estimated" ? { estimated: true } : {}) }, totalTokens: inputTokens + outputTokens }
        : {}),
      ...(combo ? { attempts: [
        attempt(1, "openai", "gpt-5.5", "reported", inputTokens, outputTokens),
        attempt(2, "anthropic", "claude-fable-5", "estimated", inputTokens + 1, outputTokens + 1),
      ] } : {}),
    });
  }
  const duplicateRequestId = `property-${seed}-duplicate`;
  entries.push({ ...entries[0]!, requestId: duplicateRequestId, timestamp: now - 15 * dayMs });
  entries.push({ ...entries[1]!, requestId: duplicateRequestId, timestamp: now - 12 * dayMs });
  entries.sort(() => random() - 0.5);
  return { entries, foldBoundaryTimestamp, duplicateRequestId };
}
