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

/**
 * Resolve one config selection against a provider's known native ids (#2491).
 *
 * `slugEquivalenceKey` is deliberately lossy — the Codex one-slash rule forces `a/b` and
 * `a-b` onto the same encoded form — so a selection written in either spelling matches BOTH
 * when a provider publishes both. Filtering and persisted sync share that key, which keeps
 * them consistent with each other but silently over-grants.
 *
 * This resolver keeps the tolerant behaviour (a selection still matches through either
 * spelling, and an id absent from an incomplete live roster still resolves) while reporting
 * whether the match was EXACT or merely equivalent. A caller that can afford to be strict —
 * one holding a complete known-id set — can then prefer the exact row instead of granting the
 * whole collision class.
 *
 * Returning the ambiguity rather than resolving it is deliberate: the roster is an incomplete
 * dictionary, so silently narrowing to the exact spelling would hide a published id whenever
 * discovery omitted it. The caller owns that tradeoff because only the caller knows whether
 * its id set is complete.
 */
export interface SlugSelectionMatch {
  /** Native ids this selection admits. */
  readonly matched: readonly string[];
  /** The id whose raw form the selection names exactly, when one exists. */
  readonly exact: string | undefined;
  /** True when more than one known id shares the selection's encoded form. */
  readonly ambiguous: boolean;
}

export function resolveSlugSelection(
  provider: string,
  selection: string,
  knownIds: Iterable<string>,
): SlugSelectionMatch {
  // A slash in the selection is ambiguous on its own: `p/a-b` is provider-qualified, while
  // `a/b` is a bare NATIVE id that happens to contain a slash. Treating every slash-bearing
  // selection as provider-qualified made `a/b` resolve against provider "a", so the same
  // collision reported ambiguous through the dash spelling and unambiguous through the slash
  // spelling — the exact asymmetry this resolver exists to remove.
  const matched: string[] = [];
  let exact: string | undefined;
  const ids = [...knownIds];
  // A selection that starts with `<provider>/` is genuinely ambiguous: it reads as the
  // provider-qualified form of `b`, but it is ALSO the native spelling of a self-namespaced
  // id `provider/b`. Stripping the prefix unconditionally erased that second reading, so a
  // published `acme/turbo` became unreachable while a sibling `turbo` silently absorbed the
  // selection. The native id wins when the roster actually publishes it, because only then is
  // the literal spelling known to name a real row.
  const namesNativeId = ids.some(id => id === selection);
  const qualified = !namesNativeId && selection.startsWith(`${provider}/`)
    ? selection
    : routedSlug(provider, selection);
  const selectionKey = slugEquivalenceKey(qualified);
  for (const id of ids) {
    if (slugEquivalenceKey(routedSlug(provider, id)) !== selectionKey) continue;
    matched.push(id);
    if (id === selection || `${provider}/${id}` === selection) exact = id;
  }
  return { matched, exact, ambiguous: matched.length > 1 };
}
