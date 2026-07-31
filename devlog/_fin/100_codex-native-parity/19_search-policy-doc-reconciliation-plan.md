# 100.19 — Search Policy Documentation Reconciliation Plan

## Objective

Reconcile Phase 100 search-policy documentation after the confirmed `gpt-5.4-mini` text+image
sidecar correction.

The implementation is already correct on `dev`:

```text
routed web_search_tool_type = "text_and_image"
routed supports_search_tool = true
```

The remaining issue is documentation drift: older research docs still contain the pre-correction
recommendation that routed entries should prefer `text` unless image-search is proven end to end.
That statement is now superseded because opencodex executes hosted search through the native
`gpt-5.4-mini` sidecar and verbalizes image results for text-only routed models.

## Files

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/devlog/100_codex-native-parity/11_search-defaults-and-inherited-state.md
```

Update the stale current-observation opening sentence so it no longer says routed entries are
accidentally inheriting native metadata:

```diff
-The live local opencodex catalog currently shows routed entries inheriting native search metadata.
+The current opencodex catalog intentionally normalizes routed search metadata after native-template
+cloning.
```

Keep the current example table and local catalog path block, then replace the stale explanation below
that block:

```diff
-This is not because opencode-go models have native OpenAI hosted image-search support. It is because
+opencodex cloned a native template and did not normalize these fields.
+This is not because opencode-go models have native OpenAI hosted image-search support. It is because
+`normalizeRoutedCatalogEntry()` deliberately rewrites routed catalog entries to `text_and_image`
+after cloning. opencodex then executes hosted search through the native `gpt-5.4-mini` sidecar and
+passes routed models a synthetic search tool plus textual summaries of any image results.
```

Update the source pointer:

```diff
-/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:108
+/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:73-88
```

Update the decision preamble:

```diff
-Leave the current behavior documented for now, but treat it as explicit technical debt:
+The current behavior is now the resolved Phase 100.2/100.16 policy:
```

Replace the stale decision bullets:

```diff
- native OpenAI passthrough may keep `text_and_image` and `supports_search_tool`;
- routed non-OpenAI models should not inherit hosted OpenAI search semantics silently;
- if opencodex keeps `web_search_tool_type = text_and_image`, the docs must state it means Codex
-  will offer a hosted text+image web-search shape, while opencodex currently converts/drops hosted
-  tools and can only provide sidecar synthetic web-search behavior;
- first implementation pass should prefer setting routed `web_search_tool_type` to `text` unless
-  the sidecar actually supports image-search semantics end to end.
+ native OpenAI passthrough may keep `text_and_image` and `supports_search_tool`;
+ routed non-OpenAI models should not inherit hosted OpenAI search semantics silently;
+ Phase 100.2 now deliberately sets routed `web_search_tool_type = "text_and_image"` because
+  opencodex executes hosted search through the native `gpt-5.4-mini` sidecar;
+ routed upstream providers still do not receive OpenAI hosted image-search tools directly;
+  opencodex suppresses the hosted tool and exposes a synthetic search function to the routed model;
+ for text-only routed models, image search results are verbalized as text with source URLs;
+ the earlier text-only recommendation is superseded by `16_search-image-sidecar-correction.md`.
```

Update the implementation note:

```diff
-It can remain enabled for routed models only if opencodex wants routed providers to see Codex's
-deferred tool-discovery surface.
+It remains enabled for routed models because opencodex intentionally relays Codex's deferred
+tool-discovery surface through parser/bridge handling.
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/devlog/100_codex-native-parity/90_phase-plan.md
```

Mark the search-policy question as resolved while keeping deferred `tool_search` and hosted
`web_search_tool_type` conceptually separate:

```diff
-3. Should routed models expose deferred `tool_search` by default?
+3. Resolved in Phase 100.2/100.16:
+   - routed models expose deferred `tool_search` by default;
+   - routed hosted web-search metadata is `text_and_image` because actual hosted search runs via
+     native `gpt-5.4-mini` sidecar.
```

### NO SOURCE CHANGE

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
```

No code patch is planned because the current source and tests already assert the corrected policy:

```text
normalizeRoutedCatalogEntry(entry).web_search_tool_type === "text_and_image"
normalizeRoutedCatalogEntry(entry).supports_search_tool === true
```

## Verification

Run:

```bash
bun test tests/codex-catalog.test.ts tests/web-search.test.ts
bun x tsc --noEmit
rg -n 'prefer setting routed|explicit technical debt|did not normalize these fields|codex-catalog.ts:108' devlog/100_codex-native-parity/11_search-defaults-and-inherited-state.md devlog/100_codex-native-parity/90_phase-plan.md
git diff --check
```

Expected result:

```text
all targeted catalog/search tests pass
typecheck passes
stale doc phrase search returns no matches
diff whitespace check passes
```

## Commit

If approved, commit as:

```text
docs: reconcile routed search policy
```
