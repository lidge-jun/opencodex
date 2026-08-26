/**
 * Expected-price overlay for models whose jawcode cost rows are missing or all-zero
 * (subscription/OAuth surfaces). Sourced from official pricing pages only
 * (devlog/_plan/260720_toks_speed_price_columns/003 — Luna research, main-verified).
 *
 * Status semantics:
 * - "verified": official page opened directly; the 4-tuple is the published API price.
 * - "verified-derived": mapped from a verified base-model price (for example an
 *   effort-suffix variant); propagates `estimated=true` downstream.
 * - "unverified": research lead only. NEVER registered here and never returned by
 *   the resolver — unverified prices live in the 003 §5 backlog until promoted.
 */

export interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Upper bound for a user-configured USD-per-1M-token rate. Real prices are far
 * below this (the most expensive published models cost a few hundred USD/M);
 * the bound keeps `rate * tokens / 1e6` finite for any token count a usage log
 * can plausibly hold, so an overlay cannot overflow the estimate to Infinity
 * and serialize cost fields as null.
 */
export const MAX_COST4_RATE = 1_000_000;

export type ExpectedPriceStatus = "verified" | "verified-derived" | "unverified";

export interface ExpectedPriceOverlay {
  provider: string;
  modelId: string;
  cost4: Cost4;
  source: string;
  verifiedAt: string;
  status: ExpectedPriceStatus;
}

const GEMINI_31_PRO: Cost4 = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
const GPT56_SOL: Cost4 = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };
/**
 * Daybreak aliases. `daybreak-*-latest` never appears in the pricing table itself — only its
 * current snapshot does — so these tuples are the snapshot's published rates and carry
 * `verified-derived`. That status also keeps the `estimated` marker on, which matters more
 * here than for a normal row: OpenAI can repoint an alias at a differently-priced model.
 * Red = gpt-5.6-cyber (12.50 / 1.25 / 15.625 / 75, cache write = 1.25x uncached input).
 * Blue = gpt-5.6-sol. Verified 2026-08-11 against the pricing page's Cyber models table.
 */
const DAYBREAK_RED: Cost4 = { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 };
const GPT56_TERRA: Cost4 = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };
const GPT56_LUNA: Cost4 = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };
const GEMINI_36_FLASH: Cost4 = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };
// Gemini 3.7 Flash launch promotion: Google publishes $0.75 in / $3.75 out per 1M
// through 2026-12-31, stepping up to $1.50 / $7.50 on 2027-01-01. Revisit this row
// then — the promotional rate is dated on the pricing page, not open-ended.
const GEMINI_37_FLASH: Cost4 = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const MINIMAX_M21_HIGHSPEED: Cost4 = { input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 };
const KIMI_K3: Cost4 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };
const KIMI_K27_CODE: Cost4 = { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 };
const KIMI_K27_CODE_HIGHSPEED: Cost4 = { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 };
const KIMI_K26: Cost4 = { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 };
const KIMI_K25: Cost4 = { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 };
const QWEN38_MAX: Cost4 = { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 };
// Anthropic official list prices (USD / 1M tokens). Cache write uses the published 5-minute rate.
const CLAUDE_SONNET_46: Cost4 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CLAUDE_OPUS_46: Cost4 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
// Opus 5 is priced from the maintainer's confirmation that it matches the previous
// Opus, not from a published Opus 5 page. Hence `verified-derived`, and a source
// string that states the provenance instead of pointing at ANTHROPIC_PRICING.
const CLAUDE_OPUS_5_DERIVED_SOURCE =
  "user-confirmed: claude-opus-5 matches Claude Opus 4.6; no separate Anthropic Opus 5 price page verified";
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing (official; 5m cache-write tier)";

const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing (2026-07-22); cacheWrite=0: storage is billed per-hour, not per-token";
const GEMINI_37_PRICING = "https://ai.google.dev/gemini-api/docs/pricing (2026-08-14); promotional rate through 2026-12-31, rises to 1.50/7.50 on 2027-01-01; cacheWrite=0: storage is billed per-hour, not per-token";
const MINIMAX_PRICING = "https://platform.minimax.io/docs/guides/pricing-paygo";
const OPENAI_GPT56_PRICING = "https://developers.openai.com/api/docs/pricing";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing-details-usd; V4 Flash alias transition scheduled 2026-07-24 — re-verify after";
// Kimi official tables publish input/output/cache-hit only; cacheWrite is mapped to the
// cache-miss input price (Kimi auto-caches with no separate write billing). 2026-07-20 re-verified.
const KIMI_PRICING = "https://platform.kimi.ai/docs/pricing (official table; cacheWrite derived = input, Kimi auto-cache has no write billing)";
// 260804: Qwen3.8-Max shipped as a stable model and Qwen published a per-token rate, which
// is the exit condition the previous Routeway reseller overlay named. Two caveats are
// deliberately in the source string rather than dropped: the figure comes from Qwen's own
// release announcement, NOT from an Alibaba Model Studio billing table (which still lists
// qwen3.7-max and qwen3-max but has no qwen3.8-max row), and no cache rate is published
// anywhere. Cache stays 0 rather than inheriting the reseller's 0.15 — a reseller number
// under a vendor-price label would be a wrong value wearing a verified badge.
const QWEN38_MAX_PRICING = "https://qwen.ai/blog?id=qwen3.8 (Qwen release announcement; no Model Studio billing row yet; cache rates unpublished -> 0)";

export const EXPECTED_PRICE_OVERLAYS: readonly ExpectedPriceOverlay[] = [
  // claude-opus-5 is exposed by three providers but absent from the jawcode bundle, so
  // cost resolution returned null and the Logs `~$` column rendered an em dash. The
  // model-level vendor fallback only searches jawcode metadata, never overlays, so one
  // anthropic row would not cover cursor/kiro — each exposing provider needs its own.
  { provider: "anthropic", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
  { provider: "cursor", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
  { provider: "kiro", modelId: "claude-opus-5", cost4: CLAUDE_OPUS_46, source: CLAUDE_OPUS_5_DERIVED_SOURCE, verifiedAt: "2026-07-25", status: "verified-derived" },
  // MiniMax M2.1 highspeed — published PAYG price (verified).
  { provider: "minimax", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "minimax-cn", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // DeepSeek current-generation IDs (verified; cache-hit price mapped to cacheRead).
  { provider: "deepseek", modelId: "deepseek-chat", cost4: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "deepseek", modelId: "deepseek-reasoner", cost4: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // Google Antigravity effort-suffix variants — derived from the verified base-model
  // price (Google does not publish per-suffix prices; Agent inference bills at the
  // base model's standard rate per the official Billing FAQ).
  // 3.7 Flash rides CCA, whose billing equivalence to the Developer API list price is
  // not published, so this is `verified-derived` rather than `verified`: the number is
  // proven, the claim that Antigravity charges it is inferred.
  { provider: "google-antigravity", modelId: "gemini-3.7-flash", cost4: GEMINI_37_FLASH, source: `derived: Gemini 3.7 Flash promotional rate through 2026-12-31 ${GEMINI_37_PRICING}`, verifiedAt: "2026-08-14", status: "verified-derived" },
  // Retained after the 3.6 retirement: historical usage.jsonl rows still carry these
  // ids, and dropping the row would silently zero the cost of requests already made.
  { provider: "google-antigravity", modelId: "gemini-3.6-flash", cost4: GEMINI_36_FLASH, source: `collapsed base ID ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro", cost4: GEMINI_31_PRO, source: `collapsed base ID ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified" },
  // OpenAI GPT-5.6 `-pro` virtual selections. The virtual resolver keeps the SELECTED id in
  // the usage log and records the wire model separately, and cost resolution deliberately
  // does not fall back through resolvedModel — so without these rows every `-pro` request
  // resolved to null and rendered no cost estimate at all (#908 audit, runtime-verified).
  // Pro reasoning bills at the base model's published API rate; the suffix is an effort knob.
  { provider: "openai-apikey", modelId: "gpt-5.6-sol-pro", cost4: GPT56_SOL, source: `collapsed base ID ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-03", status: "verified-derived" },
  { provider: "openai-apikey", modelId: "gpt-5.6-terra-pro", cost4: GPT56_TERRA, source: `collapsed base ID ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-03", status: "verified-derived" },
  { provider: "openai-apikey", modelId: "gpt-5.6-luna-pro", cost4: GPT56_LUNA, source: `collapsed base ID ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-03", status: "verified-derived" },
  // Daybreak aliases: priced as their current snapshots (red -> gpt-5.6-cyber,
  // blue -> gpt-5.6-sol). The alias ids carry no rows of their own upstream, hence
  // verified-derived. Blue deliberately reuses GPT56_SOL rather than duplicating the tuple.
  { provider: "openai-apikey", modelId: "daybreak-red-latest", cost4: DAYBREAK_RED, source: `alias of gpt-5.6-cyber ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-11", status: "verified-derived" },
  { provider: "openai-apikey", modelId: "daybreak-blue-latest", cost4: GPT56_SOL, source: `alias of gpt-5.6-sol ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-11", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro-low", cost4: GEMINI_31_PRO, source: `derived: gemini-3.1-pro (<=200k tier) ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro-high", cost4: GEMINI_31_PRO, source: `derived: gemini-3.1-pro (<=200k tier) ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-pro-agent", cost4: GEMINI_31_PRO, source: `wire id for gemini-3.1-pro high ${GEMINI_PRICING}`, verifiedAt: "2026-07-23", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.6-flash-low", cost4: GEMINI_36_FLASH, source: `derived: gemini-3.6-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.6-flash-medium", cost4: GEMINI_36_FLASH, source: `derived: gemini-3.6-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.6-flash-high", cost4: GEMINI_36_FLASH, source: `derived: gemini-3.6-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-extra-low", cost4: GEMINI_36_FLASH, source: `compat alias -> gemini-3.6-flash-low ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-low", cost4: GEMINI_36_FLASH, source: `compat alias -> gemini-3.6-flash-medium ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-mid", cost4: GEMINI_36_FLASH, source: `compat alias -> gemini-3.6-flash-medium ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-high", cost4: GEMINI_36_FLASH, source: `compat alias -> gemini-3.6-flash-high ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3-flash-agent", cost4: GEMINI_36_FLASH, source: `compat alias -> gemini-3.6-flash-high ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified-derived" },
  // Direct Google Gemini API current model (verified — published table).
  { provider: "google", modelId: "gemini-3.6-flash", cost4: GEMINI_36_FLASH, source: GEMINI_PRICING, verifiedAt: "2026-07-22", status: "verified" },
  // Developer API row: the price IS published for this surface, so `verified`.
  { provider: "google", modelId: "gemini-3.7-flash", cost4: GEMINI_37_FLASH, source: GEMINI_37_PRICING, verifiedAt: "2026-08-14", status: "verified" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro-preview", cost4: GEMINI_31_PRO, source: GEMINI_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // Antigravity-bundled third-party models — derived from the underlying vendor's
  // official API price (Antigravity itself bills via subscription quota).
  { provider: "google-antigravity", modelId: "claude-sonnet-4-6", cost4: CLAUDE_SONNET_46, source: `anthropic official Claude Sonnet 4.6 ${ANTHROPIC_PRICING}`, verifiedAt: "2026-07-23", status: "verified" },
  { provider: "google-antigravity", modelId: "claude-opus-4-6-thinking", cost4: CLAUDE_OPUS_46, source: `anthropic official Claude Opus 4.6 ${ANTHROPIC_PRICING}`, verifiedAt: "2026-07-23", status: "verified" },
  // Alias without the Antigravity "-thinking" suffix (if logs/UI ever surface it).
  { provider: "google-antigravity", modelId: "claude-opus-4-6", cost4: CLAUDE_OPUS_46, source: `anthropic official Claude Opus 4.6 ${ANTHROPIC_PRICING}`, verifiedAt: "2026-07-23", status: "verified" },
  { provider: "google-antigravity", modelId: "gpt-oss-120b-medium", cost4: { input: 0.03, output: 0.15, cacheRead: 0, cacheWrite: 0 }, source: "derived: gpt-oss-120b open-weights — OpenRouter advertised lowest https://openrouter.ai/openai/gpt-oss-120b/providers", verifiedAt: "2026-07-20", status: "verified-derived" },
  // Kimi / Moonshot — official price tables are now published (2026-07-20 re-check;
  // previously empty). kimi = Kimi Code OAuth surface, moonshot = CN key surface,
  // kimi-code = API key surface (expected list price, not actual billing).
  { provider: "kimi", modelId: "k3", cost4: KIMI_K3, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "k3[1m]", cost4: KIMI_K3, source: `derived: k3 (official docs: k3[1m] is the 1M-context compat notation for k3) ${KIMI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "kimi-k2.7-code", cost4: KIMI_K27_CODE, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "kimi-k2.7-code-highspeed", cost4: KIMI_K27_CODE_HIGHSPEED, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "kimi-k2.6", cost4: KIMI_K26, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "kimi-k2.5", cost4: KIMI_K25, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi", modelId: "kimi-for-coding", cost4: KIMI_K27_CODE, source: `derived: kimi-k2.7-code (Kimi Code maps to K2.7 Code per official model docs) ${KIMI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "moonshot", modelId: "kimi-k3", cost4: KIMI_K3, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "moonshot", modelId: "kimi-k2.7-code", cost4: KIMI_K27_CODE, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "moonshot", modelId: "kimi-k2.7-code-highspeed", cost4: KIMI_K27_CODE_HIGHSPEED, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "moonshot", modelId: "kimi-k2.6", cost4: KIMI_K26, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "moonshot", modelId: "kimi-k2.5", cost4: KIMI_K25, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "k3", cost4: KIMI_K3, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "k3[1m]", cost4: KIMI_K3, source: `derived: k3 ${KIMI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "kimi-k2.7-code", cost4: KIMI_K27_CODE, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "kimi-k2.7-code-highspeed", cost4: KIMI_K27_CODE_HIGHSPEED, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "kimi-k2.6", cost4: KIMI_K26, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "kimi-k2.5", cost4: KIMI_K25, source: KIMI_PRICING, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "kimi-code", modelId: "kimi-for-coding", cost4: KIMI_K27_CODE, source: `derived: kimi-k2.7-code ${KIMI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  // Qwen3.8-Max: vendor-published input/output rate (verified). See QWEN38_MAX_PRICING
  // for what that source does and does not cover.
  { provider: "alibaba-token-plan", modelId: "qwen3.8-max", cost4: QWEN38_MAX, source: QWEN38_MAX_PRICING, verifiedAt: "2026-08-04", status: "verified" },
  { provider: "alibaba-token-plan-intl", modelId: "qwen3.8-max", cost4: QWEN38_MAX, source: QWEN38_MAX_PRICING, verifiedAt: "2026-08-04", status: "verified" },
  // Cursor Auto router — Cursor's published fixed token price (verified).
  { provider: "cursor", modelId: "auto", cost4: { input: 1.25, output: 6, cacheRead: 0.25, cacheWrite: 1.25 }, source: "https://docs.cursor.com/account/pricing + https://cursor.com/blog/aug-2025-pricing", verifiedAt: "2026-07-20", status: "verified" },
];

/**
 * Exact official corrections for stale nonzero catalog rows. These are intentionally separate
 * from fallback overlays: they win over the bundled row only for the declared provider/model and
 * therefore cannot reprice routed resellers that reuse the same model slug.
 */
export const VERIFIED_PRICE_OVERRIDES: readonly ExpectedPriceOverlay[] = [
  {
    provider: "xai",
    modelId: "grok-4.6",
    cost4: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    source: "https://docs.x.ai/developers/pricing",
    verifiedAt: "2026-08-18",
    status: "verified",
  },
];

export function findVerifiedPriceOverride(
  provider: string,
  modelId: string,
  overrides: readonly ExpectedPriceOverlay[] = VERIFIED_PRICE_OVERRIDES,
): ExpectedPriceOverlay | undefined {
  return overrides.find(row => row.provider === provider && row.modelId === modelId);
}

/**
 * Exact-key overlay lookup. Returns verified first, then verified-derived.
 * NEVER returns "unverified" rows — fail-closed is enforced in code, not just docs.
 * No fuzzy / case-fold / wire-model fallback.
 */
export function findExpectedPriceOverlay(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): ExpectedPriceOverlay | undefined {
  const exact = overlays.filter(row => row.provider === provider && row.modelId === modelId);
  return exact.find(row => row.status === "verified")
    ?? exact.find(row => row.status === "verified-derived");
}

/** OpenAI Fast price multipliers retained as a compatibility export. */
export const PRIORITY_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 2,
  // Post-price-cut Fast tables (https://openai.com/api-fast-mode/, 2026-08-05):
  // Terra 4/24/0.40/5 and Luna 0.40/2.40/0.04/0.50 are both 2× the corrected
  // standard tuples; the stale bases made these look like 1.6/0.4 (#907).
  "gpt-5.6-terra": 2,
  "gpt-5.6-luna": 2,
  "gpt-5.5": 2.5,
  "gpt-5.4-mini": 2,
  "gpt-5.4": 2,
};

/** Returns the priority-tier price multiplier for a model (1 if not listed). */
export function resolvePriorityMultiplier(modelId: string): number {
  return PRIORITY_MULTIPLIERS[modelId] ?? 1;
}

export interface PriorityPricingRule {
  provider: string;
  modelId: string;
  multiplier: number;
  /** Apply the premium only after the upstream response confirms this tier. */
  requiresResponseConfirmation?: true;
  source: string;
  verifiedAt: string;
}

const OPENAI_FAST_PRICING = "https://openai.com/api-fast-mode/";
const XAI_PRIORITY_PRICING = "https://docs.x.ai/developers/advanced-api-usage/priority-processing";

/**
 * Exact provider/model priority premiums. Routed resellers never inherit a vendor rule merely
 * because they reuse its model slug. Multipliers apply uniformly after cache discounts.
 */
export const PRIORITY_PRICING_RULES: readonly PriorityPricingRule[] = [
  ...["openai", "openai-apikey"].flatMap(provider =>
    Object.entries(PRIORITY_MULTIPLIERS).map(([modelId, multiplier]): PriorityPricingRule => ({
      provider,
      modelId,
      multiplier,
      source: OPENAI_FAST_PRICING,
      verifiedAt: "2026-08-05",
    })),
  ),
  ...["grok-4.5", "grok-4.6"].map((modelId): PriorityPricingRule => ({
    provider: "xai",
    modelId,
    multiplier: 2,
    requiresResponseConfirmation: true,
    source: XAI_PRIORITY_PRICING,
    verifiedAt: "2026-08-18",
  })),
];

/** Exact provider/model priority-pricing lookup. */
export function findPriorityPricingRule(
  provider: string,
  modelId: string,
  rules: readonly PriorityPricingRule[] = PRIORITY_PRICING_RULES,
): PriorityPricingRule | undefined {
  return rules.find(rule => rule.provider === provider && rule.modelId === modelId);
}

/**
 * Long-context pricing tiers (#908). Several vendors reprice the ENTIRE request
 * once the prompt crosses a published input-token threshold, so a flat Cost4
 * cannot express it.
 *
 * The threshold is measured on RAW `usage.inputTokens` (total prompt size,
 * including cache reads/writes) — never on normalized billable input, which has
 * already had cache tokens subtracted. A 280k prompt with a 200k cache read has
 * 80k billable input and still crosses OpenAI's 272k boundary; deciding after
 * normalization would under-bill exactly the cache-heavy long requests.
 *
 * Rules are exact provider+model matches. No case folding: the jawcode bundle
 * carries BOTH `minimax-m3` and `MiniMax-M3` at different rates, so folding
 * would select the wrong base row. No model-level fallback: routed resellers
 * (Cursor, OpenRouter) share model slugs but price independently.
 */
export interface ContextTier {
  provider: string;
  modelId: string;
  /** Long rates apply once raw input tokens pass this boundary. */
  thresholdInputTokens: number;
  /** true = `>=` threshold (xAI), false = `>` threshold (OpenAI, MiniMax). */
  inclusive: boolean;
  /** Per-field factor from the short rate to the published long rate. */
  multiplier: Cost4;
  /** Published relationship between confirmed priority and long-context bands. */
  confirmedPriorityRelation?: "exclusive" | "lower-bound";
  source: string;
  verifiedAt: string;
}

/**
 * OpenAI GPT-5.6: "Prompts with >272K input tokens are priced at 2x input and
 * 1.5x output for the full request." Cached input and cache writes also double,
 * per the published short/long columns.
 */
const OPENAI_LONG_CONTEXT: Cost4 = { input: 2, output: 1.5, cacheRead: 2, cacheWrite: 2 };
/** xAI and MiniMax double every rate uniformly past their thresholds. */
const UNIFORM_DOUBLE: Cost4 = { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 };

const OPENAI_PRICING_DOC = "https://developers.openai.com/api/docs/pricing";
const OPENAI_GPT56_CONTEXT_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // Virtual `-pro` selections keep their own id in usage logs (the wire model is
  // recorded separately), so they need their own rows or they silently skip the tier.
  "gpt-5.6-sol-pro",
  "gpt-5.6-terra-pro",
  "gpt-5.6-luna-pro",
];

export const CONTEXT_TIERS: readonly ContextTier[] = [
  ...["openai", "openai-apikey"].flatMap(provider =>
    OPENAI_GPT56_CONTEXT_MODELS.map((modelId): ContextTier => ({
      provider,
      modelId,
      thresholdInputTokens: 272_000,
      inclusive: false,
      multiplier: OPENAI_LONG_CONTEXT,
      confirmedPriorityRelation: "exclusive",
      source: OPENAI_PRICING_DOC,
      verifiedAt: "2026-08-03",
    })),
  ),
  {
    provider: "xai",
    modelId: "grok-4.5",
    thresholdInputTokens: 200_000,
    inclusive: true,
    multiplier: UNIFORM_DOUBLE,
    confirmedPriorityRelation: "lower-bound",
    source: "https://docs.x.ai/developers/pricing",
    verifiedAt: "2026-08-03",
  },
  {
    // xAI publishes the whole-request >=200k band for grok-4.6. Its combination with
    // Priority Processing is not published, so confirmed priority uses this row as a lower bound.
    provider: "xai",
    modelId: "grok-4.6",
    thresholdInputTokens: 200_000,
    inclusive: true,
    multiplier: UNIFORM_DOUBLE,
    confirmedPriorityRelation: "lower-bound",
    source: "https://docs.x.ai/developers/pricing",
    verifiedAt: "2026-08-18",
  },
  {
    // daybreak-blue-latest aliases gpt-5.6-sol, which publishes the full long-context row
    // ($10 / $1 / $12.50 / $45). Scoped to openai-apikey ON PURPOSE: Daybreak is not
    // routable on the Codex-login `openai` provider, so adding the alias to the shared
    // OPENAI_GPT56_CONTEXT_MODELS list (expanded across both providers above) would mint a
    // tier for a provider/model pair that cannot exist.
    // daybreak-red-latest has NO tier row: the cyber snapshot's four long-context cells are
    // all "-" on the pricing page (verified 2026-08-11).
    provider: "openai-apikey",
    modelId: "daybreak-blue-latest",
    thresholdInputTokens: 272_000,
    inclusive: false,
    multiplier: OPENAI_LONG_CONTEXT,
    source: OPENAI_PRICING_DOC,
    verifiedAt: "2026-08-11",
  },
  ...["minimax", "minimax-cn"].map((provider): ContextTier => ({
    provider,
    modelId: "MiniMax-M3",
    thresholdInputTokens: 512_000,
    inclusive: false,
    multiplier: UNIFORM_DOUBLE,
    source: "https://platform.minimax.io/docs/guides/pricing-paygo",
    verifiedAt: "2026-08-03",
  })),
];

/** Exact provider+model context-tier lookup. No fuzzy matching, no case folding. */
export function findContextTier(
  provider: string,
  modelId: string,
  tiers: readonly ContextTier[] = CONTEXT_TIERS,
): ContextTier | undefined {
  return tiers.find(tier => tier.provider === provider && tier.modelId === modelId);
}

/** Whether a raw input-token count crosses the tier's published boundary. */
export function isLongContext(tier: ContextTier, rawInputTokens: number): boolean {
  if (!Number.isFinite(rawInputTokens)) return false;
  return tier.inclusive
    ? rawInputTokens >= tier.thresholdInputTokens
    : rawInputTokens > tier.thresholdInputTokens;
}
