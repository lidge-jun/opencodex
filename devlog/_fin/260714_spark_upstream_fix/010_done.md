# 010 — Done: gpt-5.3-codex-spark upstream fix

## Summary

Fixed three classes of upstream errors that prevented `gpt-5.3-codex-spark` from working
as a subagent model in opencodex.

## Root cause

Spark is not in `UPSTREAM_NATIVE_ENTRIES` (map only loads `gpt-5.6-*` slugs), so
`deriveEntry()` clones the 5.6 template — inheriting `use_responses_lite: true` and
other 5.6-only flags. codex-rs reads these flags and injects parameters spark rejects.

## Changes

### Fix 1 — Catalog root fix (`src/codex/catalog.ts`)

In `deriveEntry()`, non-5.6 native branch: strip `use_responses_lite` and
`supports_websockets` for non-5.6 natives after the template clone. This prevents
codex-rs from injecting `reasoning.context: "all_turns"` in the first place.

### Fix 2 — Adapter defense (`src/adapters/openai-responses.ts`)

Two defense-in-depth functions in the passthrough adapter's `buildRequest` chain:

- `stripUnsupportedReasoningParams`: strips `reasoning.context`, `reasoning.summary`,
  and `reasoning.generate_summary` for spark (stale catalog guard).
- `stripSparkNamespaceFields`: strips `namespace` fields from input items and removes
  `type: "namespace"` tools for spark (MCP namespace incompatibility).

### Fix 3 — Test update (`tests/codex-catalog.test.ts`)

Updated `buildCatalogEntries preserves native bare GPT template fields` test to expect
`use_responses_lite: undefined` and `supports_websockets: undefined` for non-5.6 natives,
matching the corrected behavior.

## Evidence

- `bun run tsc`: 0 errors
- `bun test codex-catalog.test.ts`: 51 pass, 0 fail
- `ocx sync`: spark catalog entry has no `use_responses_lite` or `supports_websockets`
- Spark subagent dispatch: completed successfully, no upstream 400 errors

## Terminal outcome: DONE
