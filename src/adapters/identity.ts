/**
 * Central routed-model identity repair.
 *
 * Codex sends the SAME GPT-5 identity line to EVERY model at request time (the per-model catalog
 * `base_instructions` is ignored on the wire). For routed, non-OpenAI providers that line is both
 * wrong (the model isn't GPT-5) and a liability: the previous fix replaced it with text that
 * advertised "...served through / running via the opencodex proxy", which leaked our proxy identity
 * into the upstream payload — a signature no first-party client (Claude Code, Gemini CLI, Kiro) ever
 * sends, and a likely ToS trigger.
 *
 * The replacement keeps the necessary instruction (don't misreport as GPT-5/OpenAI), names the
 * model id that is actually sent on the wire when it is safe to interpolate, and names no proxy.
 * Provider-native identity blocks (e.g. the anthropic OAuth "You are a Claude agent..." prefix)
 * are layered on TOP of this by the individual adapters; this module never claims to be a specific
 * first-party client.
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
  // A callback avoids `$&`, `$'`, and other replacement-string substitutions if this constant ever
  // becomes configurable. Keep the same safe form in identifyRoutedModel below.
  return systemText.replace(CODEX_GPT5_IDENTITY_RE, () => NEUTRAL_IDENTITY_LINE);
}

function safeRoutedModelIdentity(modelName: string): string | null {
  // Callers pass the model id after adapter-specific wire normalization. Brackets remain valid for
  // providers that intentionally send a suffix such as `[1m]`; the OpenAI-chat adapter strips that
  // suffix before calling us only when modelSuffixBracketStrip is enabled.
  const trimmed = modelName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  const allowedPunctuation = "._/@:+-[]~";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    const isAsciiAlphaNumeric = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122);
    if (!isAsciiAlphaNumeric && !allowedPunctuation.includes(char)) return null;
  }
  return trimmed;
}

/**
 * Identity for a routed model. Callers pass the concrete model id that will be sent upstream, so
 * identity questions can name it instead of falling back to Codex/GPT identity inherited from the
 * native template.
 */
export function identifyRoutedModel(systemText: string, modelName: string): string {
  const identity = safeRoutedModelIdentity(modelName);
  const replacement = identity
    ? `You are a coding agent powered by the ${identity}. If asked which model you are, identify as ${identity}. Do not claim to be a different model or to have a different creator.`
    : "You are a coding agent powered by the configured model. If asked which model you are, identify as configured model. Do not claim to be GPT-5 or made by OpenAI.";
  return systemText.replace(CODEX_GPT5_IDENTITY_RE, () => replacement);
}

/** The catalog (static, on-disk) replacement for `base_instructions`. Same neutral wording. */
export const NEUTRAL_IDENTITY_CATALOG = NEUTRAL_IDENTITY_LINE;
