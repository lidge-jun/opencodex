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
 * Known Codex identity sentences. Narrow: only "coding agent" / "an agent" + GPT-<major>(.minor)*.
 * Avoid a broad `You are Codex.*` rewrite that could touch unrelated content.
 *
 * The major version is a wildcard because Codex writes the CURRENT generation into this line and
 * bumps it: `gpt-6-astra` (upstream #42607) ships "You are Codex, an agent based on GPT-6.".
 * Pinning `GPT-5` meant a GPT-6-era prompt routed to a third-party provider kept telling that
 * model it was Codex-on-GPT-6 — the exact misattribution this chokepoint exists to remove, silently
 * reintroduced by a version bump.
 */
const CODEX_GPT5_IDENTITY_RE =
  /You are Codex, (?:a coding agent|an agent) based on GPT-[0-9]+(?:\.[0-9]+)*\./g;

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
  const replacement = routedIdentityLine(modelName);
  return systemText
    .replace(CODEX_GPT5_IDENTITY_RE, () => replacement)
    .replace(NEUTRAL_IDENTITY_RE, () => replacement)
    .replace(ROUTED_IDENTITY_RE, () => replacement);
}

function routedIdentityLine(modelName: string): string {
  const identity = safeRoutedModelIdentity(modelName);
  return identity
    ? `You are a coding agent powered by the ${identity}. If asked which model you are, identify as ${identity}. Do not claim to be a different model or to have a different creator.`
    : "You are a coding agent powered by the configured model. If asked which model you are, identify as configured model. Do not claim to be GPT-5 or made by OpenAI.";
}

/**
 * This proxy's OWN generated identity sentence (both the named and the `configured model`
 * fallback form). Codex stores a session's instructions once and replays them verbatim when it
 * spawns a sub-agent on a DIFFERENT model (#5217), so a worker inherits the parent's sentence and
 * then answers identity questions with the parent's model id.
 *
 * The pattern is deliberately anchored on the exact wording this module emits — the leading
 * "You are a coding agent powered by the " and the matching "If asked which model you are,
 * identify as " clause — so it can only ever rewrite text the proxy generated. The model id is
 * matched with the same character class `safeRoutedModelIdentity` allows, never `.*`, so user
 * prose, fenced code and provider-native identity blocks are out of reach.
 */
const ROUTED_IDENTITY_RE =
  /You are a coding agent powered by the (?:configured model|[A-Za-z0-9._/@:+\-[\]~]+)\. If asked which model you are, identify as (?:configured model|[A-Za-z0-9._/@:+\-[\]~]+)\. Do not claim to be (?:a different model or to have a different creator|GPT-5 or made by OpenAI)\./g;

/**
 * The model-neutral catalog line. Since #5217 the catalog no longer bakes a model id into
 * `base_instructions` — a stored instruction block is replayed to sub-agents on other models —
 * so the id is written at request time instead, where the destination is known.
 */
const NEUTRAL_IDENTITY_RE = new RegExp(
  NEUTRAL_IDENTITY_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "g",
);

/** True when `text` carries an identity sentence this proxy generated. */
export function hasRoutedIdentity(text: string): boolean {
  ROUTED_IDENTITY_RE.lastIndex = 0;
  return ROUTED_IDENTITY_RE.test(text);
}

/**
 * Request-time repair for a routed destination: rewrite an inherited identity sentence so it names
 * the model this request is actually sent to. Text without one is returned unchanged.
 */
export function repairRoutedIdentity(text: string, modelName: string): string {
  const replacement = routedIdentityLine(modelName);
  return text.replace(ROUTED_IDENTITY_RE, () => replacement);
}

/** Apply `repair` to the developer/system text of a Responses request body, in place of nothing. */
export function repairIdentityInResponsesBody(body: unknown, repair: (text: string) => string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  let changed = false;
  const mapText = (text: string): string => {
    if (!hasRoutedIdentity(text)) return text;
    const next = repair(text);
    if (next !== text) changed = true;
    return next;
  };
  const instructions = typeof record.instructions === "string" ? mapText(record.instructions) : record.instructions;
  const input = Array.isArray(record.input)
    ? record.input.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const message = item as Record<string, unknown>;
      if (message.type !== undefined && message.type !== "message") return item;
      if (message.role !== "developer" && message.role !== "system") return item;
      if (typeof message.content === "string") {
        const next = mapText(message.content);
        return next === message.content ? item : { ...message, content: next };
      }
      if (!Array.isArray(message.content)) return item;
      let partChanged = false;
      const content = message.content.map((part: unknown) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return part;
        const record = part as Record<string, unknown>;
        if (typeof record.text !== "string") return part;
        const next = mapText(record.text);
        if (next === record.text) return part;
        partChanged = true;
        return { ...record, text: next };
      });
      return partChanged ? { ...message, content } : item;
    })
    : record.input;
  return changed ? { ...record, ...(instructions !== undefined ? { instructions } : {}), input } : body;
}

/**
 * Request-time repair for a native (Codex/OpenAI) destination: drop an inherited routed identity
 * sentence instead of rewriting it. A native worker keeps Codex's own identity wording, which the
 * client already sends in its `model_switch` block; re-stating a routed sentence there would tell
 * a first-party model it is some third-party model.
 */
export function stripRoutedIdentity(text: string): string {
  return text.replace(ROUTED_IDENTITY_RE, () => "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The catalog (static, on-disk) replacement for `base_instructions`. Same neutral wording. */
export const NEUTRAL_IDENTITY_CATALOG = NEUTRAL_IDENTITY_LINE;
