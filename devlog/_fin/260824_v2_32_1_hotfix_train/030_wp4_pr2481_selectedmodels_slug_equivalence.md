# 030 — wp4: #2481, `selectedModels` must match the way the resolver matches

Phase: wp4. Depends on: wp1. PR: #2481, head `a81275fea`, author `ntdatt812`.

## Defect

Providers with slash-bearing native ids (OpenRouter, NVIDIA, Together,
Fireworks, ZenMux) are displayed in the Codex picker as an *encoded slug* —
`routedSlug` replaces the inner slash (`src/providers/slug-codec.ts:27-49`).
An operator who writes an allowlist from what the picker showed them stores the
encoded form. But `filterCatalogVisibleModels` compared against native ids only:

```ts
if (Array.isArray(sel) && sel.length > 0) allowByProvider.set(name, new Set(sel));
...
return !allow || allow.has(m.id);
```

So the allowlist hides every model it was written to keep, while direct calls to
the same model still route fine — a silent, self-inflicted-looking catalog
inconsistency.

`sync.ts` already keys the same list canonically at
`src/codex/catalog/sync.ts:819-821`, so this filter was the odd one out.

## The change

`src/codex/catalog/provider-fetch.ts:44` — MODIFY (import
`slugEquivalenceKey`).

`src/codex/catalog/provider-fetch.ts:1560-1582` — MODIFY:

```diff
-    if (Array.isArray(sel) && sel.length > 0) allowByProvider.set(name, new Set(sel));
+    if (Array.isArray(sel) && sel.length > 0) {
+      allowByProvider.set(name, new Set(sel.map(model => slugEquivalenceKey(routedSlug(name, model)))));
+    }
...
-    return !allow || allow.has(m.id);
+    return !allow || allow.has(slugEquivalenceKey(routedSlug(m.provider, m.id)));
```

Both sides of the comparison are now canonical, which is the only way the two
spellings can be one entry.

## The four consumers, and what the reviewer found

| Surface | Primitive used | Location |
|---------|----------------|----------|
| `/v1/models` listing | `filterCatalogVisibleModels` | `src/server/index.ts:1056` |
| Injected Codex catalog | same filter, then canonical merge | `src/codex/catalog/sync.ts:1442`, `:1036` |
| CLI model removal | `slugEquals` | `src/cli/models.ts:271-288` |
| Actual routing | `decodeRoutedModelIdOrThrow` | `src/router.ts:638-665` |

They share the `slug-codec` module but **not one collision policy**:
`slugEquivalenceKey` maps `p/a/b` and `p/a-b` to the same key
(`src/providers/slug-codec.ts:89-97`), while routing *rejects* that ambiguity
(`:72-80`, proven by `tests/slug-codec.test.ts:211-237`).

That divergence is real but it is **pre-existing**, and closing it means
changing routing's fail-closed contract. This train does not do that. The
decision recorded here: accept the equivalence-key behavior for the catalog
filter, add a test that pins the collision behavior so the divergence is
documented rather than accidental, and file the unification as a follow-up.
Widening a hotfix into a codec-contract change is exactly the regression radius
this train exists to avoid.

## Required test additions

`tests/selected-models.test.ts` — the PR's four ZenMux cases are kept. Add:

1. A route-level assertion that `/v1/models` lists a slash-bearing model that
   was allowlisted by its encoded slug — the PR tests only the helper.
2. Rows for `openrouter`, `nvidia`, `together`, `fireworks` (the four providers
   the codec contract names) rather than ZenMux alone.
3. A collision fixture containing both `a/b` and `a-b` that pins current
   behavior explicitly, with a comment naming the routing divergence and the
   follow-up.

Expected values are hardcoded, never derived from `slugEquivalenceKey`, so the
test cannot pass by agreeing with a broken helper.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Encoded slug and native id both keep the model visible | `bun test tests/selected-models.test.ts` |
| 2 | Route-level `/v1/models` behavior asserted, not just the helper | same |
| 3 | Model outside the allowlist stays hidden | same |
| 4 | Collision behavior pinned and documented | same |
| 5 | Fork CI approved and green at head; merged | `gh pr checks 2481`, merge SHA |

## Scope boundary

IN: the catalog visibility filter and its tests.
OUT: unifying `slugEquals` / `decodeRoutedModelIdOrThrow` / `slugEquivalenceKey`
into one policy; any change to routing's ambiguity rejection.

