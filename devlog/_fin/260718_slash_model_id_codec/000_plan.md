# 000 — Slash-model-id codec plan (Codex one-slash tagging fix)

Date: 2026-07-18. Work class: C3 (cross-module, public catalog surface). One work-phase = one PABCD cycle.

## Problem

Codex's models-manager resolves per-model metadata ("tagging": effort ladder, context
window, capabilities) with an exact one-slash rule — `find_model_by_namespaced_suffix`
(codex-rs `models-manager/src/manager.rs:599-615`) does `split_once('/')` and rejects the
lookup when the remainder still contains `/`. Providers whose NATIVE model ids contain
`/` (zenmux `moonshotai/kimi-k3-free`, openrouter `anthropic/...`, nvidia `n/...`,
together, fireworks, vercel-ai-gateway) therefore produce two-slash Codex slugs
(`zenmux/moonshotai/kimi-k3-free`) that fall back to default metadata — tagging is not
reflected. Verified live in `~/.codex/opencodex-catalog.json`: the only 2-slash slug is
`zenmux/moonshotai/kimi-k3-free`; Sol subagent confirmed against current Codex source
and ZenMux's live `/api/v1/models` (2026-07-18).

## Decision (user-directed)

Expose a Codex-facing alias with inner slashes replaced by `-`
(`zenmux/moonshotai-kimi-k3-free`) and decode back to the native id in the proxy layer.
Prior art (opencode, LiteLLM) keeps the remainder raw, but Codex's tagging lookup forces
a one-slash shape; no industry hyphen convention exists, so this is a
Codex-facing compatibility alias only.

Hard rules (from Sol research + collision analysis):

- NEVER blind-decode `-` → `/`. Decode is an exact bijective lookup against the
  provider's known native ids; unknown ids pass through unchanged (honest upstream error).
- Native ids remain canonical everywhere internal: upstream requests, logs, usage,
  jawcode metadata, combo keys, disabled lists.
- Back-compat: raw full-slash selectors (`zenmux/moonshotai/kimi-k3-free` in config or
  request) keep working — exact native-id match wins before encoded match.
- Collisions (`a/b` vs `a-b` on one provider): detect at catalog build, warn once;
  the plain-hyphen native id wins the catalog slot (matching decode precedence),
  the loser is dropped from the catalog but stays callable via its raw full-slash
  selector. Duplicate encoded slugs are never emitted.

## Loop spec

- Archetype: spec-satisfaction repair. Trigger: user report + Sol verification.
- Goal: every routed model with a slash-containing native id appears in Codex with a
  one-slash slug and full tagging; proxy transparently calls upstream with the native id.
- Non-goals: changing upstream provider APIs; migrating existing Codex-side caches
  beyond the normal `ocx sync` / cache-invalidate flow; renaming providers.
- Verifier: `bun test tests/` focused (router codec + catalog slug), `tsc` typecheck,
  plus activation evidence: built catalog entry for a slash-id model has exactly one `/`
  and routeModel decodes the encoded form to the native id.
- Stop: verifier green + D evidence. Terminal outcomes: DONE / BLOCKED / NEEDS_HUMAN.

## File change map (diff-level)

### NEW `src/providers/slug-codec.ts`

Leaf module (imports types only; no cycles — router.ts already imports providers/*).

```ts
export function encodeRoutedModelId(id: string): string;      // id.replaceAll("/", "-")
export function routedSlug(provider: string, id: string): string; // `${provider}/${encode(id)}`
export function decodeRoutedModelId(requested: string, knownIds: Iterable<string>): string;
// 1) requested is itself a known native id -> requested (back-compat, raw selector)
// 2) exactly one known id encodes to requested -> that native id
// 3) otherwise -> requested unchanged
export function slugEquals(stored: string, provider: string, id: string): boolean;
// stored === `${provider}/${id}` || stored === routedSlug(provider, id)  (config back-compat)
```

### MODIFY `src/providers/registry.ts`

- zenmux entry (line ~657): add `models: ["moonshotai/kimi-k3-free", "moonshotai/kimi-k3"]`
  (live-verified 2026-07-18 via zenmux.ai/api/v1/models, Sol evidence) so cold-cache
  decode works for the reported case; replace the FREEZE comment with the verification note.

### MODIFY `src/codex/catalog.ts`

- `buildCatalogEntries` (line ~962): `slug = routedSlug(m.provider, m.id)`.
- `deriveEntry`: base_instructions model name + `applyJawcodeCatalogMetadata` must use the
  NATIVE id (`model?.id`), not the encoded slug slice — jawcode metadata keys are native
  (openrouter `anthropic/...`). Both template and fallback branches.
- `orderForSubagents` keyOf + `buildCatalogEntries` rank map + `filterCatalogVisibleModels`
  disabled check (line ~1364): compare config-stored slugs with `slugEquals`
  (accept raw and encoded; new writes are encoded).
- Encode-collision detection in `buildCatalogEntries`: two native ids of one provider
  mapping to the same alias -> `console.warn` once per provider; native exact match keeps
  precedence at decode time.

### MODIFY `src/router.ts`

- Namespace branch (after `modelId.slice(slash + 1)`):
  `knownIds = union(config.providers[provName]?.models, registryEntry?.models, getStaleCached(provName)?.map(m => m.id))`;
  `return routeResult(provName, prov, decodeRoutedModelId(sliced, knownIds))`.
  Import `getStaleCached` from `./codex/model-cache` (leaf; type-only back-import — no cycle).
- `defaultModel` / `models.includes` fallback branches: also match via encoded comparison
  (`slugEquals`-style on the bare id) so an encoded bare id still routes.

### MODIFY `src/server/management-api.ts`

- `/api/models` GET namespaced (line ~681) and `/api/injection-model` available list
  (line ~864): emit `routedSlug(...)` so stored config values (disabledModels,
  injectionModel) match the Codex-facing catalog slug. Reads stay `slugEquals`-tolerant.

### CHECK-ONLY (no change unless audit finds a write)

- `src/server/index.ts` `/v1/models` OpenAI list shape (raw namespaced availability list
  for generic clients — upstream-facing, keep raw); `exactComboCatalogSlugs` /
  `isExactComboCatalogModel` (internal raw keys, consistent); `src/claude/*` alias family
  (own id scheme; raw selectors still decode); `src/codex/inject.ts` — verify no
  `model = "provider/slash/id"` is ever written into codex config.toml.

### NEW `tests/slug-codec.test.ts` + MODIFY existing

- encode/decode round-trip; decode precedence (native > encoded > pass-through);
  collision warning; routeModel: `zenmux/moonshotai-kimi-k3-free` ->
  `moonshotai/kimi-k3-free` via registry-seeded zenmux models; back-compat raw
  `nvidia/n/kimi-k2.6` still routes (existing nvidia tests must stay green);
  buildCatalogEntries emits `zenmux/moonshotai-kimi-k3-free` with one `/` and keeps
  jawcode metadata lookup on the native id.

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

1. Encoded request path: unit test drives routeModel with the encoded slug and asserts
   the decoded native id reaches the route result (the conditional decode branch FIRES —
   a pass-through would fail the assertion).
2. Collision branch: fixture provider with both `a/b` and `a-b` asserts the warning fired
   and native-id precedence held.
3. Cold-cache decode: no live cache seeded — registry `models` seed alone decodes the
   zenmux id.

## SoT sync (SOT-SYNC-01)

Check `README.md` provider/model docs for a routed-slug description; patch if it names
the `<provider>/<model>` shape without the alias rule. Record in C.

## A-round 1 synthesis (REVIEW-SYNTHESIS-01) — verdict GO-WITH-FIXES (blockers=2)

Reviewer: Galileo (gpt-5.6-terra, independent). All five findings ACCEPTED and folded:

1. [High, ACCEPT] `applyJawcodeCatalogMetadata` signature becomes
   `(entry, provider, nativeModelId, contextCap)` — never re-derive provider/id from the
   encoded slug. Both deriveEntry branches (template + fallback) pass `m.provider`/`m.id`
   (fallback branch parses the RAW slug only when no CatalogModel exists, i.e. never for
   routed entries). Regression tests: template + null-template with native slash id.
2. [High, ACCEPT] `catalogModelEfforts` (catalog.ts ~279-286) resolves slugs with
   `slugEquals` tolerance and keys its returned Map by the CALLER-provided slug, so raw
   legacy `subagentModels` entries keep resolving in v2 multi-agent guidance
   (responses.ts:255-256). Regression: tests/multi-agent-compat.test.ts.
3. [Med, ACCEPT — contract resolved] Config canonical forms: INTERNAL lists
   (`disabledModels`) keep native raw `${provider}/${id}`; CODEX-FACING picks
   (`subagentModels`, `injectionModel`) store the encoded routedSlug. Every comparison
   site is `slugEquals`-tolerant so legacy raw values keep working. Apply routedSlug +
   tolerant disabled checks to ALL management picker surfaces: `/api/models`,
   `/api/injection-model`, `/api/subagent-models` (management-api.ts ~681, ~864, ~943-951),
   and the Claude management list (~969-978).
4. [Med, ACCEPT] Claude agent roster: decode the model-id portion in
   `src/claude/agents-inject.ts` (~57-61) before `claudeCodeAlias(provider, id)` using the
   same known-ids union, so the raw-native context-window map
   (context-windows.ts:116-138) keeps matching. Preferred over duplicating window-map
   entries per encoding.
5. [Med, ACCEPT] Added C activation assertions: decode-miss pass-through
   (`provider/unknown_encoded` unchanged), collision warn-once (two builds → one warning),
   defaultModel/models-list encoded fallback branches.

Test-surface corrections from reviewer Q6: existing nvidia catalog test
(tests/nvidia-nim-hardening.test.ts:86) pins a raw two-slash catalog slug — UPDATE to the
encoded form; zenmux registry-seed assertion goes in
tests/provider-registry-parity.test.ts near :101-108; jawcode regression extends
tests/codex-catalog.test.ts:1063-1085; golden fixture untouched unless a codec fixture is
added (then update tests/codex-catalog-golden.test.ts expectations).
