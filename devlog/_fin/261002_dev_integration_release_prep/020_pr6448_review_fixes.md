# 020 — wp2: resolve #6448 review threads and land it

Base: `origin/codex/opengateway-provider` at 07cfd325665a60be4b2c046d7aaf55fef2737a58 (detached in the session source worktree).
Push rule: one fast-forward push `git push origin HEAD:codex/opengateway-provider` only if the remote head still equals
the observed head (check with `git ls-remote` immediately before pushing); never force.

## F1 — Codex P2 "mark the public catalog as non-validating" (thread PRRT_kwDOS-0Gi86oUDWv)

Status: fixed at head. `entries-extended.ts:1158` sets `apiKeyValidation: "unknown"`; `derive.ts:319` copies it into
`deriveKeyLoginMap()`; `key-providers.ts:78` returns "unknown" before any fetch. Gap: no test pins the derived entry.

NEW `tests/providers/opengateway-key-validation.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { deriveKeyLoginMap } from "../../src/providers/derive";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("derived OpenGateway login preserves unknown validation", () => {
  expect(deriveKeyLoginMap().opengateway?.apiKeyValidation).toBe("unknown");
  expect(KEY_LOGIN_PROVIDERS.opengateway?.apiKeyValidation).toBe("unknown");
});
test("the public catalog is never probed to validate a key", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ data: [] }); }) as unknown as typeof fetch;
  expect(await validateApiKey("opengateway", KEY_LOGIN_PROVIDERS.opengateway!, "any-key")).toBe("unknown");
  expect(calls).toBe(0);
});
```
(B verifies the actual export location of `KEY_LOGIN_PROVIDERS` before writing the import.)
Reply: fixed in 07cfd32566; derived-entry regression added; resolve thread.

## F2 — CodeRabbit Major "keep a preferred model's position when a custom model replaces it" (thread PRRT_kwDOS-0Gi86oUopM)

Status: valid. `routed-gather.ts:535-541` keeps discovery order for providers whose captured discovery declares
`preferFirst`; `routed-gather.ts:749-752` then drops every discovered row a custom row replaces and appends all custom
rows after all discovered rows, so a custom override of a Sionic-first model lands at the bottom.

MODIFY `src/codex/catalog/routed-gather.ts` (replace lines 749-752):
```diff
-  // Custom rows override discovered rows that encode to the same Codex-facing slug.
-  const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
-  const deduped = all.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
-  const models = [...deduped, ...customModels];
+  // Custom rows override discovered rows that encode to the same Codex-facing slug. A provider whose
+  // captured discovery declares an order (preferFirst) keeps each replacement in the discovered row's
+  // slot; every other provider keeps the historical order of discovered rows followed by custom rows.
+  const customBySlug = new Map<string, CatalogModel[]>();
+  for (const custom of customModels) {
+    const key = routedSlug(custom.provider, custom.id);
+    const bucket = customBySlug.get(key);
+    if (bucket) bucket.push(custom);
+    else customBySlug.set(key, [custom]);
+  }
+  const placedInSlot = new Set<string>();
+  const models: CatalogModel[] = all.flatMap(model => {
+    const key = routedSlug(model.provider, model.id);
+    const replacements = customBySlug.get(key);
+    if (!replacements) return [model];
+    if (!orderedProviders.has(model.provider) || placedInSlot.has(key)) return [];
+    placedInSlot.add(key);
+    return replacements;
+  });
+  models.push(...customModels.filter(custom => !placedInSlot.has(routedSlug(custom.provider, custom.id))));
```
Invariants: non-ordered providers produce exactly the previous array (same filter, same append order); duplicate custom
rows for one slug stay together and keep config order; unmatched custom rows keep their append position; a discovered row
is emitted at most once; when a slug is overridden, every discovered row colliding on it is dropped (as before), while
unoverridden colliding discovered rows still survive gather and are resolved later in catalog projection.
`orderedProviders` and `CatalogModel` are already in scope (line 535, import line 89).

NEW `tests/codex-integration/catalog-custom-ordering.test.ts` (pattern copied from the "live ordering survives routed gather"
case in `tests/providers/opengateway-provider.test.ts`: fixture `tests/fixtures/opengateway-models.json`, `withStubbedProviderFetch`,
`clearModelCache("opengateway")` in afterEach):
- "a custom row replacing a preferred OpenGateway model keeps the discovered slot": customModels
  `[{ id: "u1", provider: "opengateway", modelId: "deepseek/deepseek-v4.1-flash-ultrafast", displayName: "Pinned DS", contextWindow: 200000 }]`;
  gathered opengateway ids equal the discovered order
  `["deepseek/deepseek-v4.1-flash-ultrafast", "z-ai/glm-5.3-flash-ultrafast", "openai/o4-mini", "openai/o3-pro"]`
  (the `expected` array of opengateway-provider.test.ts:16, not the raw fixture order); row 0 has `catalogKind === CODEX_CUSTOM_MODEL_CATALOG_KIND`
  ("custom-model-v1", imported from `src/codex/catalog/parsing`), `displayName` "Pinned DS" and contextWindow 200000; the id
  appears once; `buildCatalogEntries(null, [], rows)` slugs keep that order and priorities are nondecreasing in it (unfeatured
  routed entries share priority 5, build-entries.ts:264); a second (cached) pass gives the same order.
- "an encoded-slug custom row takes the slot of the discovered row it collides with": custom modelId
  `"z-ai-glm-5.3-flash-ultrafast"` (hyphenated) encodes to the same Codex slug as discovered `"z-ai/glm-5.3-flash-ultrafast"`;
  the gathered list has exactly one row at index 1, and it is the custom row.
- "cold-start seeds keep a replaced seed's slot when discovery fails": `clearModelCache("opengateway")` first, fetch returns
  HTTP 500; gathered ids follow the registry seed order (`entry.models`) and the custom row for seed 0 sits at index 0.
- "a slug shared by two discovered rows and two custom rows yields one slot with both custom rows": stub `/v1/models` with
  `{ data: [ row("other/first"), row("acme/x"), row("acme-x"), row("other/last") ] }` where
  `row = id => ({ id, status: "active", endpoints: ["chat_completions"], providers: [{ id: "sionic-ai" }] })`, and
  customModels `[{ id:"c1", provider:"opengateway", modelId:"acme/x", displayName:"C1" }, { id:"c2", provider:"opengateway", modelId:"acme-x", displayName:"C2" }]`.
  Gathered opengateway rows are `other/first, C1, C2, other/last` (displayName order shows the bucket keeps config order and the
  second discovered collision is dropped via `placedInSlot`); `buildCatalogEntries` emits one entry for slug
  `opengateway/acme-x` whose `display_name === "C2"`: `resolveSlugAliasCollisions` (build-entries.ts:173,256;
  aggregation.ts:487-493) prefers the native id without a slash over first occurrence, the same winner the pre-change tail produced.
- "an unmatched custom row is still appended after discovered rows": modelId "vendor/not-in-catalog" ends last.
- "providers without preferFirst keep the historical append order": a synthetic provider
  `static: { adapter: "openai-chat", baseUrl: "https://static.invalid/v1", apiKey: "k", liveModels: false, models: ["c", "a", "b"] }`
  (`liveModels: false` selects the static path, provider-models.ts:232) and a custom row for "a" yields ["b","c","a"] for that
  provider (alphabetical discovered rows, custom appended).
REGISTER both new basenames in `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`
(`"opengateway-key-validation.test.ts": "providers"`, `"catalog-custom-ordering.test.ts": "codex-integration"`).
Ratchet: neither touched source nor new tests have a cap in `tests/fixtures/file-size-baseline.json`.

SoT: `structure/catalog.md` (owner of `routed-gather.ts`) gains one sentence near its routed-gather custom-row paragraph,
and `structure/providers-and-adapters.md`'s preferFirst paragraph gains the same clause: a custom row replacing a discovered
row of a preferFirst provider keeps that row's slot; other providers keep discovered rows first, custom rows after.

Activation: the new path fires only when a custom row's slug equals a discovered row of an ordered provider; the first
test drives exactly that and asserts slot + custom metadata. Verified by the PR's single hosted CI run.

Landing: push once; wait for the exact-head rollup (all required green); reply + resolve both threads; merge-tree against
post-#6441 dev; decision comment; `gh pr merge 6448 --squash --admin --match-head-commit <head>`.

## P revalidation (wp2, 2026-10-02)

Previous D (wp1): #6441 landed as 21aed9fee9; direction for wp2 unchanged (apply this doc to #6448).
Remote head still 07cfd325665a60be4b2c046d7aaf55fef2737a58; macOS run 37001597370 finished success; the Aside poller in og01 has
exited. The FAILURE in the rollup is a superseded enforce-target run (two later runs on this head succeeded).
dev is 21aed9fee9; since the PR's merge base, dev changed scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json
(other PRs' registrations) and none of routed-gather.ts / structure/catalog.md / providers-and-adapters.md.
Amendment: B first checks out the PR head and merges origin/dev into it (a normal merge commit, so the push stays a
fast-forward and the single CI run tests the integrated tree), then applies F1 tests, the F2 diff, the F2 tests, both layout
registrations and the two structure sentences, as one commit "fix(opengateway): keep a custom replacement in its preferred
slot; pin derived non-validating key login" with Co-authored-by none (same author). Push once after ls-remote re-check.
