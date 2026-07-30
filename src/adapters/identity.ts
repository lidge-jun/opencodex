/**
 * Central identity neutralization.
 *
 * Codex sends the SAME GPT-5 identity line to EVERY model at request time (the per-model catalog
 * `base_instructions` is ignored on the wire). For routed, non-OpenAI providers that line is both
 * wrong (the model isn't GPT-5) and a liability: the previous fix replaced it with text that
 * advertised "...served through / running via the opencodex proxy", which leaked our proxy identity
 * into the upstream payload — a signature no first-party client (Claude Code, Gemini CLI, Kiro) ever
 * sends, and a likely ToS trigger.
 *
 * The neutral replacement keeps ONLY the necessary instruction (don't misreport as GPT-5/OpenAI)
 * and names no proxy. Provider-native identity blocks (e.g. the anthropic OAuth "You are a Claude
 * agent..." prefix) are layered on TOP of this by the individual adapters; this module never claims
 * to be a specific first-party client.
 */

/** Historical exact identity line Codex injected for every model. */
export const CODEX_GPT5_IDENTITY_LINE = "You are Codex, a coding agent based on GPT-5.";

/** Codex CLI 0.145.0+ wording (#622) — still GPT-5 identity, slightly different phrasing. */
export const CODEX_GPT5_IDENTITY_LINE_AGENT = "You are Codex, an agent based on GPT-5.";

/**
 * Known Codex GPT-5 identity sentences. Narrow: only "coding agent" / "an agent" + GPT-5(.x)?
 * Avoid a broad `You are Codex.*` rewrite that could touch unrelated content.
 */
const CODEX_GPT5_IDENTITY_RE =
  /You are Codex, (?:a coding agent|an agent) based on GPT-5(?:\.[0-9]+)*\./g;

/** Proxy-neutral replacement: no "opencodex proxy" mention, just the GPT-5/OpenAI disclaimer. */
export const NEUTRAL_IDENTITY_LINE = "You are a coding agent. Do not claim to be GPT-5 or to be made by OpenAI.";

/**
 * Replace Codex's hardcoded GPT-5 identity line with the proxy-neutral line. Safe to call on any
 * system text: when the line is absent (already neutralized, or a provider that never received it)
 * the input is returned unchanged. This is the single chokepoint every adapter routes through, so
 * the leak can't reappear in one adapter while being fixed in another.
 */
export function neutralizeIdentity(systemText: string): string {
  return systemText.replace(CODEX_GPT5_IDENTITY_RE, NEUTRAL_IDENTITY_LINE);
}

/** The catalog (static, on-disk) replacement for `base_instructions`. Same neutral wording. */
export const NEUTRAL_IDENTITY_CATALOG = NEUTRAL_IDENTITY_LINE;
