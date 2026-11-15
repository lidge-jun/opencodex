import type { OcxProviderConfig } from "../types";
import { mapFill } from "./resolved-model-policy-merge";
import {
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODELS,
} from "./registry/model-seeds";

/** Every seeded Claude id with its documented synchronous output maximum. */
const CLAUDE_MODEL_OUTPUT_CAPS: Readonly<Record<string, number>> = Object.fromEntries(
  ANTHROPIC_MODELS.map(id => [id, ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[id] ?? ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS]),
);

function isDirectAnthropicDestination(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Output caps for an Anthropic-adapter row, keyed by the Claude model id rather than the row name
 * (#8525). Codex never sends `max_output_tokens`, so a row without any cap fell back to the
 * adapter's conservative 8192 even when it served a Claude model whose documented maximum is
 * 64K-128K — every custom-named row and every registry row that seeds no cap.
 *
 * Precedence, highest first: an operator per-model cap; any provider default, operator-set or
 * registry-seeded (a row carrying one gets nothing filled, so seeded rows resolve exactly as
 * before); the registry cap of a seeded Claude id; the Anthropic default on api.anthropic.com
 * itself; the adapter's 8192. A gateway id the registry does not list — a vendor namespace, a
 * dated suffix, a non-Claude model — keeps the 8192 fallback.
 *
 * Runtime-only: applied to the routed copy and never persisted, so the caps cannot follow a row
 * that is later pointed somewhere else. A row that reaches the Anthropic wire only through a
 * per-model `modelAdapters` switch is not covered, because the routed row's adapter differs.
 */
export function withAnthropicModelOutputCaps(provider: OcxProviderConfig): OcxProviderConfig {
  if (provider.adapter !== "anthropic" || provider.defaultMaxOutputTokens !== undefined) return provider;
  const [modelMaxOutputTokens] = mapFill(CLAUDE_MODEL_OUTPUT_CAPS, provider.modelMaxOutputTokens);
  return {
    ...provider,
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    ...(isDirectAnthropicDestination(provider.baseUrl) ? { defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS } : {}),
  };
}
