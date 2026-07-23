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
const GEMINI_36_FLASH: Cost4 = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };
const MINIMAX_M21_HIGHSPEED: Cost4 = { input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 };
const KIMI_K3: Cost4 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };
const KIMI_K27_CODE: Cost4 = { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 };
const KIMI_K27_CODE_HIGHSPEED: Cost4 = { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 };
const KIMI_K26: Cost4 = { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 };
const KIMI_K25: Cost4 = { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 };
const QWEN38_ROUTEWAY_TEMPORARY: Cost4 = { input: 1.5, output: 5, cacheRead: 0.15, cacheWrite: 0 };
// Anthropic official list prices (USD / 1M tokens). Cache write uses the published 5-minute rate.
const CLAUDE_SONNET_46: Cost4 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CLAUDE_OPUS_46: Cost4 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing (official; 5m cache-write tier)";

const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing (2026-07-22); cacheWrite=0: storage is billed per-hour, not per-token";
const MINIMAX_PRICING = "https://platform.minimax.io/docs/guides/pricing-paygo";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing-details-usd; V4 Flash alias transition scheduled 2026-07-24 — re-verify after";
// Kimi official tables publish input/output/cache-hit only; cacheWrite is mapped to the
// cache-miss input price (Kimi auto-caches with no separate write billing). 2026-07-20 re-verified.
const KIMI_PRICING = "https://platform.kimi.ai/docs/pricing (official table; cacheWrite derived = input, Kimi auto-cache has no write billing)";
// TEMPORARY proxy only: Routeway's reseller API rate is not Alibaba Token Plan billing.
// Replace these overlays when Alibaba publishes an official qwen3.8-max-preview token rate.
const QWEN38_ROUTEWAY_PRICING = "https://routeway.ai/models/qwen3.8-max-preview (temporary reseller proxy; NOT Alibaba Token Plan billing; cacheWrite unpublished -> 0)";

export const EXPECTED_PRICE_OVERLAYS: readonly ExpectedPriceOverlay[] = [
  // MiniMax M2.1 highspeed — published PAYG price (verified).
  { provider: "minimax", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "minimax-cn", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // DeepSeek current-generation IDs (verified; cache-hit price mapped to cacheRead).
  { provider: "deepseek", modelId: "deepseek-chat", cost4: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "deepseek", modelId: "deepseek-reasoner", cost4: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // Google Antigravity effort-suffix variants — derived from the verified base-model
  // price (Google does not publish per-suffix prices; Agent inference bills at the
  // base model's standard rate per the official Billing FAQ).
  { provider: "google-antigravity", modelId: "gemini-3.6-flash", cost4: GEMINI_36_FLASH, source: `collapsed base ID ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro", cost4: GEMINI_31_PRO, source: `collapsed base ID ${GEMINI_PRICING}`, verifiedAt: "2026-07-22", status: "verified" },
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
  // Alibaba has not published a per-token Token Plan rate yet. Use Routeway's
  // independently published reseller rate temporarily and keep estimates derived.
  { provider: "alibaba-token-plan", modelId: "qwen3.8-max-preview", cost4: QWEN38_ROUTEWAY_TEMPORARY, source: QWEN38_ROUTEWAY_PRICING, verifiedAt: "2026-07-22", status: "verified-derived" },
  { provider: "alibaba-token-plan-intl", modelId: "qwen3.8-max-preview", cost4: QWEN38_ROUTEWAY_TEMPORARY, source: QWEN38_ROUTEWAY_PRICING, verifiedAt: "2026-07-22", status: "verified-derived" },
  // Cursor Auto router — Cursor's published fixed token price (verified).
  { provider: "cursor", modelId: "auto", cost4: { input: 1.25, output: 6, cacheRead: 0.25, cacheWrite: 1.25 }, source: "https://docs.cursor.com/account/pricing + https://cursor.com/blog/aug-2025-pricing", verifiedAt: "2026-07-20", status: "verified" },
];

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

/**
 * OpenAI service_tier "priority" (Fast) price multipliers by model slug.
 * Source: https://platform.openai.com/docs/models (2026-07-24).
 * Priority pricing applies uniformly to all token types (input, output, cache).
 * Models not listed here fall back to 1× (no multiplier).
 */
export const PRIORITY_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 2,
  "gpt-5.6-terra": 2,
  "gpt-5.6-luna": 2,
  "gpt-5.5": 2.5,
  "gpt-5.4": 2,
};

/** Returns the priority-tier price multiplier for a model (1 if not listed). */
export function resolvePriorityMultiplier(modelId: string): number {
  return PRIORITY_MULTIPLIERS[modelId] ?? 1;
}
