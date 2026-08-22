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

/**
 * True when `modelId` shares a Codex-facing encoded form with a different known id.
 * That collision is what makes `provider/openai-gpt-5.5` decode to native `openai-gpt-5.5`
 * while a custom `openai/gpt-5.5` row is still visible.
 */
export function encodedModelIdCollides(modelId: string, knownIds: Iterable<string>): boolean {
  const encoded = encodeRoutedModelId(modelId);
  for (const id of knownIds) {
    if (id === modelId) continue;
    if (encodeRoutedModelId(id) === encoded) return true;
  }
  return false;
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

/**
 * Decode a Codex-facing id, but fail when a custom slash id and another known id
 * share the same encoded form. Write-time checks cannot cover a later live cache.
 */
export function decodeRoutedModelIdOrThrow(requested: string, knownIds: Iterable<string>): string {
  const ids = [...knownIds];
  const encodedRequested = encodeRoutedModelId(requested);
  const matches = new Set<string>();
  for (const id of ids) {
    if (id === requested || encodeRoutedModelId(id) === encodedRequested) matches.add(id);
  }
  if (matches.size > 1) throw new Error(`ambiguous model id "${requested}"`);
  return decodeRoutedModelId(requested, ids);
}

/** Does a stored config slug name this routed model, in either raw or encoded form? */
export function slugEquals(stored: string, provider: string, id: string): boolean {
  return stored === `${provider}/${id}` || stored === routedSlug(provider, id);
}

/** Stable key for the exact equivalence relation used by catalog/config slug matching. */
export function slugEquivalenceKey(slug: string): string {
  const slash = slug.indexOf("/");
  return slash <= 0
    ? JSON.stringify(["exact", slug])
    : JSON.stringify([
      "routed",
      slug.slice(0, slash),
      encodeRoutedModelId(slug.slice(slash + 1)),
    ]);
}

/** Equivalence between two routed slugs regardless of raw/encoded mix. */
export function slugsEquivalent(a: string, b: string): boolean {
  return a === b || slugEquivalenceKey(a) === slugEquivalenceKey(b);
}
