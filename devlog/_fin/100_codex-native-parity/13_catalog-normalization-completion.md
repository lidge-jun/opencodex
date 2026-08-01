# 100.13 — Catalog Normalization Completion

## Scope

Phase 100.1 implemented routed catalog selector normalization.

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
/Users/jun/Developer/new/700_projects/opencodex/package.json
```

## Implemented Behavior

Routed non-OpenAI catalog entries now pass through `normalizeRoutedCatalogEntry()` after native
template cloning.

The helper strips:

- `model_messages`
- `tool_mode`
- `multi_agent_version`
- `use_responses_lite`
- `supports_websockets`
- `additional_speed_tiers`
- `service_tier`
- `service_tiers`
- `default_service_tier`

Native bare GPT entries do not pass through this helper, so native OpenAI passthrough metadata is
preserved.

## Test Coverage

Added:

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
```

Covered assertions:

1. direct `normalizeRoutedCatalogEntry()` stripping;
2. routed entries produced by `buildCatalogEntries()` strip native-only selectors;
3. native bare GPT entries preserve native-only fields and still normalize `fast` catalog tier ids
   to `priority`.

## Verification

Commands:

```bash
bun test tests
bun x tsc --noEmit
git diff --check
```

Results:

```text
bun test tests: 3 pass, 0 fail
bun x tsc --noEmit: pass
git diff --check: pass
Backend verifier: DONE
```

## Remaining Phase 100 Work

Phase 100.1 only blocks accidental native selector inheritance in the catalog. Remaining slices:

- 100.2 search capability policy;
- 100.3 thinking and usage parity;
- 100.4 jawcode-backed context metadata;
- 100.5 error and header fidelity.
