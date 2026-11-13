import { requestLogDto } from "../../../src/server/management/shared";
import { refreshUserCostOverlays } from "../../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../../src/types";

/**
 * Rows for the #8452 follow-up: a credit charge's amount is
 * `providerCredits x creditPriceUsd`, but the Logs detail panel printed the token
 * catalog key as its "Price source" and rendered the token rate's caveats against it.
 *
 * Every row is built by the production `requestLogDto`, with
 * `displayMetrics.cost.estimate.price` populated exactly as the estimator fills it. A
 * hand-written estimate would let a panel pass a shape the proxy never serves.
 */
export const billingFixturesConfig = {
  port: 0,
  providers: {
    // Credit-billed, with a catalog price that carries the long-context and Priority rules.
    xai: { adapter: "openai", baseUrl: "https://api.x.ai", authMode: "apiKey", creditPriceUsd: 0.04 },
    // The combo's credit leg: a provider whose own catalog price is plain jawcode.
    kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd: 0.04 },
  },
} as unknown as OcxConfig;

/** A confirmed Priority tier, which is what makes the token-rate estimate a floor. */
export const priorityTierOutcome = {
  canonical: "priority", wireKind: "service-tier", wireValue: "priority",
  fastOutcome: "applied", confirmation: "confirmed", responseServiceTier: "priority",
} as const;

/** Over the 200k long-context band, so the token path resolves the published long rate. */
const longUsage = { inputTokens: 300_000, outputTokens: 1_000 };

const baseRow = {
  timestamp: 1_700_000_000_000,
  status: 200,
  durationMs: 1_000,
  sendCount: 1,
  recoveryKinds: [],
} as const;

export function installBillingFixturesPricing(): void {
  refreshUserCostOverlays(billingFixturesConfig);
}

export function clearBillingFixturesPricing(): void {
  refreshUserCostOverlays({ port: 0, providers: {} } as unknown as OcxConfig);
}

/** A token-priced long-context Priority row: its estimate really is a floor over a catalog rate. */
export function tokenPriorityRow(requestId: string) {
  return requestLogDto({
    ...baseRow,
    requestId, provider: "xai", model: "grok-4.7",
    usageStatus: "reported", usage: longUsage, tierOutcome: priorityTierOutcome,
  } as never);
}

/** The same row billed from provider credits: exact for the configured price. */
export function creditRow(requestId: string) {
  return requestLogDto({
    ...baseRow,
    requestId, provider: "xai", model: "grok-4.7",
    usageStatus: "estimated",
    usage: { ...longUsage, providerCredits: 2, estimated: true },
    tierOutcome: priorityTierOutcome,
  } as never);
}

/** One credit leg (kiro) and one token-priced Priority leg (xai) behind a combo parent. */
export function mixedComboRow(requestId: string) {
  const attempt = (overrides: Record<string, unknown>) => ({ ...baseRow, ...overrides });
  return requestLogDto({
    ...baseRow,
    requestId, provider: "combo", model: "combo/mixed",
    durationMs: 2_000,
    usageStatus: "estimated",
    usage: { inputTokens: 901_000, outputTokens: 1_400, estimated: true },
    attempts: [
      attempt({
        ordinal: 1, provider: "kiro", model: "claude-opus-5.5", adapter: "kiro",
        usageStatus: "estimated",
        usage: { inputTokens: 600_000, outputTokens: 400, providerCredits: 1.95, estimated: true },
      }),
      attempt({
        ordinal: 2, provider: "xai", model: "grok-4.7", adapter: "openai",
        usageStatus: "reported", usage: longUsage, tierOutcome: priorityTierOutcome,
      }),
    ],
  } as never);
}

/** A credit leg, a lower-bound token leg, and a separate exact token leg. */
export function mixedThreeLegComboRow(requestId: string) {
  const attempt = (overrides: Record<string, unknown>) => ({ ...baseRow, ...overrides });
  return requestLogDto({
    ...baseRow, requestId, provider: "combo", model: "combo/mixed-three",
    usageStatus: "estimated", usage: { inputTokens: 901_100, outputTokens: 1_410, estimated: true },
    attempts: [
      attempt({ ordinal: 1, provider: "kiro", model: "claude-opus-5.5", adapter: "kiro", usageStatus: "estimated", usage: { inputTokens: 600_000, outputTokens: 400, providerCredits: 1.95, estimated: true } }),
      attempt({ ordinal: 2, provider: "xai", model: "grok-4.7", adapter: "openai", usageStatus: "reported", usage: longUsage, tierOutcome: priorityTierOutcome }),
      attempt({ ordinal: 3, provider: "xai", model: "grok-4.7", adapter: "openai", usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 } }),
    ],
  } as never);
}

/**
 * The same two legs, but the token leg resolves an exact standard rate: under the long-context
 * band and with no Priority outcome, so nothing in the sum is a floor.
 */
export function mixedExactComboRow(requestId: string) {
  const attempt = (overrides: Record<string, unknown>) => ({ ...baseRow, ...overrides });
  return requestLogDto({
    ...baseRow,
    requestId, provider: "combo", model: "combo/mixed-exact",
    durationMs: 2_000,
    usageStatus: "estimated",
    usage: { inputTokens: 701_000, outputTokens: 1_400, estimated: true },
    attempts: [
      attempt({
        ordinal: 1, provider: "kiro", model: "claude-opus-5.5", adapter: "kiro",
        usageStatus: "estimated",
        usage: { inputTokens: 600_000, outputTokens: 400, providerCredits: 1.95, estimated: true },
      }),
      attempt({
        ordinal: 2, provider: "xai", model: "grok-4.7", adapter: "openai",
        usageStatus: "reported", usage: { inputTokens: 100_000, outputTokens: 1_000 },
      }),
    ],
  } as never);
}

/**
 * A row produced by a build from before this follow-up: it already carried `billing` (so the
 * total is correctly denominated in credits) but the estimate still inherited the token rate's
 * `priorityLowerBound` and token-only reasons. A dashboard seeded from that build — or reading a
 * proxy that has not been upgraded — must not print `>=` or a token caveat over an exact charge.
 */
type MutableCostEnvelope = {
  displayMetrics: { cost: { estimate: Record<string, unknown>; estimateReasons?: string[] } };
};

export function staleCreditProvenanceRow(requestId: string) {
  const row = creditRow(requestId) as unknown as MutableCostEnvelope;
  row.displayMetrics.cost.estimate.priorityLowerBound = true;
  row.displayMetrics.cost.estimateReasons = ["usage_estimated", "cache_detail_missing", "expected_price_overlay", "priority_lower_bound"];
  return row as unknown as ReturnType<typeof creditRow>;
}

/**
 * A row cached by a build from before `billing` existed. Its absence means token-priced
 * by compatibility, so the token provenance must still render rather than be suppressed
 * as if the amount had come from credits.
 */
type MutableAttemptEnvelope = MutableCostEnvelope & {
  attempts?: MutableCostEnvelope[];
};

export function legacyTokenRowWithoutBilling(requestId: string) {
  const row = tokenPriorityRow(requestId) as unknown as MutableAttemptEnvelope;
  delete row.displayMetrics.cost.estimate.billing;
  for (const attempt of row.attempts ?? []) delete attempt.displayMetrics.cost.estimate.billing;
  return row as unknown as ReturnType<typeof tokenPriorityRow>;
}
