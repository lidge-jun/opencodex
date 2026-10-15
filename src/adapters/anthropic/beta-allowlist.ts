/**
 * The `anthropic-beta` values a managed native Messages request may carry from its caller (PF-10).
 *
 * A beta header changes what the provider accepts and bills, so the native lane never forwards
 * the caller's header as written. Each value is compared, case-insensitively, against a fixed
 * list for the destination's provider class; a match is re-emitted in this file's own spelling,
 * so no caller byte ever reaches the wire, and everything else is dropped. The caller learns
 * nothing about which value was dropped, and the trace records only that something was
 * (`anthropic-beta-dropped`). The proxy log names a dropped value only when it is on this file's
 * closed list of published beta names ({@link KNOWN_UNFORWARDED_BETAS}); anything else is counted,
 * never echoed, so a caller-chosen value (which may carry an account or tenant name) cannot reach
 * the log, while drift in the known set stays visible by name.
 *
 * Proxy-owned betas (the OAuth pair, the fast-mode beta) are not listed here: the lane sets them
 * itself from the provider's own configuration, exactly as the adapter does.
 *
 * Imports only the leaf schema-pairing table; no provider, credential or transport code.
 */

import { ANTHROPIC_BETA_BODY_PAIRS } from "./beta-body-pairs";
export { CONTEXT_MANAGEMENT_BETA, THINKING_BINDING_BETA } from "./beta-body-pairs";

/** Where the native lane sends: Anthropic's own API, or an Anthropic-compatible third party. */
export type AnthropicProviderClass = "first-party" | "compatible";

/**
 * Betas a caller may forward to `api.anthropic.com`. Deliberately short: only a value whose
 * effect is limited to how the model uses the body it already sent, with
 * no billing tier and no retained server state, belongs here. Beta-gated body fields
 * are admitted only through the shared pairing table.
 */
const FIRST_PARTY_BETAS: readonly string[] = [
  // Lets thinking blocks appear between tool calls in one assistant turn. No request field;
  // the thinking and tool blocks it affects are already on the lane's field allowlist, and the
  // proxy's own OAuth quota probe sends it (`src/providers/quota/vendor-probes-oauth.ts`).
  "interleaved-thinking-2025-05-14",
  ...ANTHROPIC_BETA_BODY_PAIRS.filter(pair => !pair.nativeClientOnly).map(pair => pair.beta),
];

/**
 * Betas a caller may forward to an Anthropic-compatible third party. Empty: a third party's
 * beta semantics are its own, an unknown value can fail the request outright, and none is
 * needed for the fields the lane forwards.
 */
const COMPATIBLE_BETAS: readonly string[] = [];
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";
/**
 * Published betas this lane recognizes but does not forward. Only these, and the allowlisted
 * values above, are ever named in the log; the list grants nothing on the wire.
 */
const KNOWN_UNFORWARDED_BETAS: readonly string[] = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fast-mode-2026-02-01",
  "thinking-token-count-2026-05-13",
  "mid-conversation-tool-changes-2026-07-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19",
  "files-api-2025-04-14",
  "token-efficient-tools-2025-02-19",
  "fine-grained-tool-streaming-2025-05-14",
  "code-execution-2025-08-25",
  "mcp-client-2025-04-04",
  "web-fetch-2025-09-10",
  "computer-use-2025-01-24",
  "output-128k-2025-02-19",
  "structured-outputs-2025-11-13",
  "skills-2025-10-02",
  "model-context-window-exceeded-2025-08-26",
];

/** An observed Claude client already requested these native body schemas. Advisor may
 * perform its explicitly requested model sub-inference; no feature or body is injected. */
const NATIVE_CLIENT_BETAS: readonly string[] = [
  ...FIRST_PARTY_BETAS,
  "advisor-tool-2026-03-01",
  "per-turn-control-2026-07-01",
  "redact-thinking-2026-02-12",
  "inline-tools-2026-09-15",
  "thinking-display-updates-2026-08-18",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  ...ANTHROPIC_BETA_BODY_PAIRS.filter(pair => pair.nativeClientOnly).map(pair => pair.beta),
];
const NATIVE_CLIENT_ALLOWLIST = new Map(NATIVE_CLIENT_BETAS.map(beta => [beta.toLowerCase(), beta]));

const ALLOWLISTS: Readonly<Record<AnthropicProviderClass, ReadonlyMap<string, string>>> = {
  "first-party": new Map(FIRST_PARTY_BETAS.map(beta => [beta.toLowerCase(), beta])),
  compatible: new Map(COMPATIBLE_BETAS.map(beta => [beta.toLowerCase(), beta])),
};

/** A caller header longer than this is not parsed at all and counts as dropped. */
const MAX_CALLER_BETA_HEADER_CHARS = 2048;

export interface AllowlistedAnthropicBetas {
  /** Allowlisted values in this file's spelling, first-seen order, no duplicates. */
  betas: string[];
  /** Whether any non-empty caller value was left out. */
  dropped: boolean;
  /**
   * Log-safe names of the dropped values: a value is named only when it is on this file's closed
   * list of known beta names; every other dropped value is summarized by
   * `droppedUnrecognized`. Bounded, deduplicated, never part of the wire or the trace.
   */
  droppedNames: string[];
  /** Dropped values left unnamed (not a known beta, past the name cap, or an oversized header). */
  droppedUnrecognized: number;
}

const LOGGABLE_BETA_NAMES: ReadonlySet<string> = new Set([
  ...KNOWN_UNFORWARDED_BETAS, ...NATIVE_CLIENT_BETAS, ...FIRST_PARTY_BETAS,
].map(beta => beta.toLowerCase()));
const MAX_DROPPED_NAMES = 16;

/**
 * Filter the caller's comma-separated `anthropic-beta` header for one provider class. An absent
 * or blank header yields nothing and drops nothing.
 */
export function allowlistAnthropicBetas(
  callerHeader: string | null | undefined,
  providerClass: AnthropicProviderClass,
  features: { inlineTools?: boolean; observedNativeClient?: boolean } = {},
): AllowlistedAnthropicBetas {
  if (typeof callerHeader !== "string" || callerHeader.trim() === "") {
    return { betas: [], dropped: false, droppedNames: [], droppedUnrecognized: 0 };
  }
  if (callerHeader.length > MAX_CALLER_BETA_HEADER_CHARS) {
    return { betas: [], dropped: true, droppedNames: [], droppedUnrecognized: 1 };
  }
  const allowed = providerClass === "first-party" && features.observedNativeClient ? NATIVE_CLIENT_ALLOWLIST : ALLOWLISTS[providerClass];
  const betas: string[] = [];
  const droppedNames: string[] = [];
  let droppedUnrecognized = 0;
  for (const part of callerHeader.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const canonical = allowed.get(token) ?? (providerClass === "first-party" && features.inlineTools
      && token === INLINE_TOOLS_BETA ? INLINE_TOOLS_BETA : undefined);
    if (canonical !== undefined) {
      if (!betas.includes(canonical)) betas.push(canonical);
    } else if (LOGGABLE_BETA_NAMES.has(token) && droppedNames.length < MAX_DROPPED_NAMES) {
      if (!droppedNames.includes(token)) droppedNames.push(token);
    } else {
      droppedUnrecognized++;
    }
  }
  return { betas, dropped: droppedNames.length > 0 || droppedUnrecognized > 0, droppedNames, droppedUnrecognized };
}

const loggedDropSets = new Set<string>();
const MAX_LOGGED_DROP_SETS = 64;

/**
 * One proxy log line per distinct dropped set per process: `anthropic-beta-dropped=<names>`.
 * Only the log-safe names from {@link allowlistAnthropicBetas} are written; other values are
 * reported as a count. Repeated requests with the same set stay quiet.
 */
export function logDroppedAnthropicBetas(
  result: Pick<AllowlistedAnthropicBetas, "droppedNames" | "droppedUnrecognized">,
  warn: (line: string) => void = console.warn,
): void {
  if (result.droppedNames.length === 0 && result.droppedUnrecognized === 0) return;
  const names = [...result.droppedNames].sort().join(",");
  const key = `${names}|${result.droppedUnrecognized > 0 ? "u" : ""}`;
  if (loggedDropSets.has(key) || loggedDropSets.size >= MAX_LOGGED_DROP_SETS) return;
  loggedDropSets.add(key);
  const unrecognized = result.droppedUnrecognized > 0 ? ` (+${result.droppedUnrecognized} unnamed)` : "";
  warn(`[anthropic] anthropic-beta-dropped=${names || "-"}${unrecognized}`);
}

/** The allowlist for one class, for documentation and tests. */
export function anthropicBetaAllowlist(providerClass: AnthropicProviderClass): readonly string[] {
  return [...ALLOWLISTS[providerClass].values()];
}
