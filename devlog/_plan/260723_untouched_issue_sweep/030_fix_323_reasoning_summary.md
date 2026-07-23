# 030 — Fix #323: Per-Model Reasoning Summary Delivery Compatibility

## Summary

ensureStrictCatalogFields() defaults supports_reasoning_summaries to true for
all models. Unknown third-party openai-responses models get advertised as
supporting reasoning summaries, causing Codex CLI to send
reasoning_summary_delivery=sequential_cutoff. The upstream rejects it with 400.

Two-layer fix needed: catalog defaults + wire-level sanitizer.

## File Change Map

### src/codex/catalog.ts — MODIFY

**Change 1: ensureStrictCatalogFields() (line ~607-611)**

Preserve already-decided boolean instead of overwriting with true:

```diff
 function ensureStrictCatalogFields(entry: CatalogEntry): void {
   // ... other fields ...
-  if (entry.supports_reasoning_summaries === undefined) entry.supports_reasoning_summaries = true;
+  if (entry.supports_reasoning_summaries === undefined) entry.supports_reasoning_summaries = false;
 }
```

Conservative default: unknown models don't support reasoning summaries.
Bundled/native OpenAI models already have explicit true from snapshot.

**Change 2: CatalogModel type (line ~464)**

Add optional capability field:

```diff
 interface CatalogModel {
   // ... existing fields ...
   supportsVerbosity?: boolean;
+  supportsReasoningSummaries?: boolean;
 }
```

**Change 3: applyCatalogModelMetadata() (line ~896)**

Apply model-level hint to catalog entry:

```diff
   if (model.supportsReasoningSummaries !== undefined) {
     entry.supports_reasoning_summaries = model.supportsReasoningSummaries;
   }
```

### src/types.ts — MODIFY (line ~720)

Add provider config field for per-model summary delivery control:

```diff
+ modelReasoningSummaryDelivery?: Record<string, false | "sequential" | "concurrent" | "concurrent_cutoff" | "sequential_cutoff">;
```

### src/adapters/openai-responses.ts — MODIFY (line ~149)

Add wire sanitizer near existing reasoning sanitizer:

```diff
+ // Sanitize reasoning_summary_delivery for models that don't support it
+ if (body.stream_options?.reasoning_summary_delivery) {
+   const summaryConfig = modelRecordValue(provider.modelReasoningSummaryDelivery, modelId);
+   if (summaryConfig === false) {
+     delete body.stream_options.reasoning_summary_delivery;
+     if (Object.keys(body.stream_options).length === 0) delete body.stream_options;
+   } else if (typeof summaryConfig === "string") {
+     body.stream_options.reasoning_summary_delivery = summaryConfig;
+   }
+ }
```

### src/config.ts, src/router.ts, src/providers/registry.ts — MODIFY

Add modelReasoningSummaryDelivery to config validation, router merge,
and registry defaults using existing model-record patterns.

### tests/codex-catalog.test.ts — MODIFY (line ~1711)

Fix existing test expectation: unknown routed model should get
supports_reasoning_summaries: false (not true).

### tests/openai-responses-passthrough.test.ts — MODIFY (line ~52)

Add sanitizer tests:
- Model with summary disabled: sequential_cutoff removed
- Model with enum override: value normalized
- Model with summary enabled: value preserved
- include_usage sibling preserved when delivery removed

## Scope Boundary

- IN: catalog defaults, CatalogModel type, wire sanitizer, config/router/registry
- OUT: Codex CLI behavior (upstream, not our code)
- OUT: Non-openai-responses adapters (they don't forward stream_options)

## Edge Cases

- Bundled OpenAI models (GPT-5.6 Sol/Terra/Luna etc.): already true from snapshot
- gpt-5.3-codex-spark: already special-cased for reasoning, include in sanitizer
- Third-party model supporting 3 enums but not sequential_cutoff: needs enum
  override, not just boolean disable — modelReasoningSummaryDelivery provides this
- reasoning effort vs reasoning summary: separate capabilities, don't conflate
- Alias/family resolution: use modelRecordValue() (existing pattern)
