import { isPlainObject } from "./internal";

/**
 * GPT-5.6 retired the legacy 24-hour retention field, and the ChatGPT backend 400s the whole
 * request when that field is present (issue #2092).
 *
 * The retired field is NOT translated to the replacement: 5.6 carries a different TTL contract,
 * and implicit caching still applies when the caller sent no replacement options. Inventing a
 * value here would silently change a caching decision the caller never made.
 *
 * Deliberately narrow on both axes, because a wider strip is a behavior change rather than a fix:
 * only the gpt-5.6 family (an older model may still honor the field), and only on the canonical
 * ChatGPT backend, which is the deployment that rejects it. Matching is exact-or-dashed-prefix so
 * a future `gpt-5.60` is not swept up by a bare `startsWith`.
 */
export function stripDeprecatedPromptCacheRetention(body: unknown, modelId: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (typeof modelId !== "string") return body;
  if (modelId !== "gpt-5.6" && !modelId.startsWith("gpt-5.6-")) return body;
  if (!Object.hasOwn(body, "prompt_cache_retention")) return body;
  const { prompt_cache_retention: _retention, ...rest } = body;
  return rest;
}

/**
 * Public Responses clients can send `prompt_cache_options`, but the canonical ChatGPT Codex
 * backend rejects the top-level field before inference (issue #2765). Custom forward gateways and
 * API-key Responses providers own different wire contracts, so the caller applies this only after
 * the canonical destination predicate succeeds.
 */
export function stripCanonicalForwardPromptCacheOptions(body: unknown): unknown {
  if (!isPlainObject(body) || !Object.hasOwn(body, "prompt_cache_options")) return body;
  const { prompt_cache_options: _options, ...rest } = body;
  return rest;
}

const POSIT_CACHE_MARKER_MAX_DEPTH = 64;
const POSIT_CACHE_MARKER_MAX_NODES = 100_000;

type PromptCacheMarkerRewrite = {
  value: unknown;
  changed: boolean;
  complete: boolean;
};

/**
 * Remove Posit/Anthropic-style prompt-cache markers without trusting request nesting. The walk
 * aborts atomically when its depth or node budget is exceeded, so a hostile extension object can
 * neither overflow the stack nor receive a partially rewritten subtree.
 */
export function stripPromptCacheBreakpoints(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): PromptCacheMarkerRewrite {
  state.nodes += 1;
  if (depth > POSIT_CACHE_MARKER_MAX_DEPTH || state.nodes > POSIT_CACHE_MARKER_MAX_NODES) {
    return { value, changed: false, complete: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      const rewritten = stripPromptCacheBreakpoints(entry, state, depth + 1);
      if (!rewritten.complete) return { value, changed: false, complete: false };
      changed ||= rewritten.changed;
      next.push(rewritten.value);
    }
    return { value: changed ? next : value, changed, complete: true };
  }
  if (!isPlainObject(value)) return { value, changed: false, complete: true };

  let changed = Object.hasOwn(value, "prompt_cache_breakpoint");
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "prompt_cache_breakpoint") continue;
    const rewritten = stripPromptCacheBreakpoints(entry, state, depth + 1);
    if (!rewritten.complete) return { value, changed: false, complete: false };
    changed ||= rewritten.changed;
    next[key] = rewritten.value;
  }
  return { value: changed ? next : value, changed, complete: true };
}
