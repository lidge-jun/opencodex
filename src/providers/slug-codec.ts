/**
 * Codex-facing slug codec for routed models whose NATIVE ids contain "/".
 *
 * Codex's models-manager resolves per-model metadata (effort ladder, context window,
 * capabilities — "tagging") with an exact one-slash rule: the namespaced-suffix lookup
 * (codex-rs models-manager/src/manager.rs, `find_model_by_namespaced_suffix`) splits
 * once on "/" and rejects the lookup when the remainder still contains "/". Providers
 * whose native ids are themselves namespaced (zenmux `moonshotai/kimi-k3-free`,
 * openrouter `anthropic/...`, nvidia `moonshotai/...`, together, fireworks, …) would
 * otherwise produce two-slash Codex slugs that silently fall back to default metadata.
 *
 * Contract:
 * - Codex-facing surfaces (catalog entries, picker lists, Codex-bound config picks)
 *   use `routedSlug(provider, id)` — inner slashes become "-".
 * - Internal state (upstream requests, logs, usage, jawcode metadata, combo keys)
 *   keeps the native id. Decoding is an EXACT bijective lookup against the provider's
 *   known native ids — never a blind "-" → "/" replace — with three ordered rules:
 *   native exact match (back-compat with raw full-slash selectors) > unique alias
 *   match > pass-through unchanged (honest upstream error).
 * - Config comparisons are tolerant via `slugEquals`/`slugsEquivalent` so legacy raw
 *   values keep working regardless of which form was stored.
 */

/** Separator standing in for "/" inside the model-id portion of a Codex-facing slug. */
export const SLUG_ALIAS_SEPARATOR = "-";

/** Native model id -> Codex-facing alias id. No-op for ids without "/". */
export function encodeRoutedModelId(id: string): string {
  return id.includes("/") ? id.replaceAll("/", SLUG_ALIAS_SEPARATOR) : id;
}

/** Codex-facing routed slug: exactly one "/" — `<provider>/<encoded id>`. */
export function routedSlug(provider: string, id: string): string {
  return `${provider}/${encodeRoutedModelId(id)}`;
}

/**
 * Map a Codex-supplied model id back to the provider's native id.
 * `knownIds` is the provider's known native ids (config ∪ registry ∪ live cache).
 */
export function decodeRoutedModelId(requested: string, knownIds: Iterable<string>): string {
  let aliasMatch: string | undefined;
  for (const id of knownIds) {
    if (id === requested) return requested; // native exact (raw selector back-compat)
    if (id.includes("/") && encodeRoutedModelId(id) === requested) {
      // Ambiguous alias (e.g. both `a/b` and `a-b` exist): refuse to guess.
      if (aliasMatch !== undefined && aliasMatch !== id) return requested;
      aliasMatch = id;
    }
  }
  return aliasMatch ?? requested;
}

/** Does a stored config slug name this routed model, in either raw or encoded form? */
export function slugEquals(stored: string, provider: string, id: string): boolean {
  return stored === `${provider}/${id}` || stored === routedSlug(provider, id);
}

/** Equivalence between two routed slugs regardless of raw/encoded mix. */
export function slugsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.indexOf("/");
  const pb = b.indexOf("/");
  if (pa <= 0 || pb <= 0) return false;
  if (a.slice(0, pa) !== b.slice(0, pb)) return false;
  return encodeRoutedModelId(a.slice(pa + 1)) === encodeRoutedModelId(b.slice(pb + 1));
}
