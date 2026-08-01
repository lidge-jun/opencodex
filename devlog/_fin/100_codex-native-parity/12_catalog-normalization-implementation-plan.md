# 100.12 — Catalog Normalization Implementation Plan

## PABCD Cycle

This document is the P-phase artifact for Phase 100.1.

Goal:

```text
Make every routed non-OpenAI catalog entry safe after native Codex template cloning.
```

This is the first implementation slice because it blocks the most dangerous accidental inheritance:
native `model_messages`, `tool_mode`, `multi_agent_version`, and `use_responses_lite`.

## Current Shape

Primary implementation path:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Current behavior:

1. `deriveEntry()` clones a native Codex template.
2. It rewrites `slug`, `display_name`, `description`, `priority`, `visibility`, and `base_instructions`.
3. For routed slugs, it already removes speed/service-tier metadata.
4. Before this Phase 100.1 implementation, it did not strip `model_messages`, `tool_mode`,
   `multi_agent_version`, or `use_responses_lite`.

Risk:

native templates can carry prompt/runtime selectors that are valid for OpenAI native models but wrong
for routed models.

## Implementation Plan

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Add a dedicated helper:

```ts
export function normalizeRoutedCatalogEntry(entry: RawEntry): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}
```

Then call it from the routed branch inside `deriveEntry()` after the identity rewrite and reasoning
ladder setup.

Native bare GPT entries must not pass through this helper.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
```

Add Bun tests that:

1. build a routed entry from a native-like template containing:
   - `model_messages`
   - `tool_mode`
   - `multi_agent_version`
   - `use_responses_lite`
   - `supports_websockets`
   - speed/service-tier fields
2. assert routed output strips those fields;
3. assert routed `base_instructions` no longer claims GPT/OpenAI identity;
4. assert native bare GPT entries preserve native-only fields.

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/package.json
```

Add:

```json
"test": "bun test"
```

so each Phase 100 cycle can use a stable test command.

## Verification

Run:

```bash
bun test
bun x tsc --noEmit
git diff --check
```

Manual catalog assertions:

- routed entries have no `model_messages`;
- routed entries have no `tool_mode`;
- routed entries have no `multi_agent_version`;
- routed entries have no `use_responses_lite`;
- routed entries have no `supports_websockets`;
- native bare GPT entries preserve native catalog fields.

## Commit

Commit message:

```text
fix: normalize routed Codex catalog entries
```

This commit should include code, tests, and this devlog file.
