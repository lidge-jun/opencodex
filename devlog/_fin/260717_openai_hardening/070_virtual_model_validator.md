# Cycle 070 — Virtual Model Validator and Fail-closed Seam

## Objective

Add `validateOpenAiVirtualModelDefinition` as the deterministic activation seam for
synthetic malformed registry definitions. The validator is pure, never mutates
`PROVIDER_REGISTRY`, and throws `InvalidOpenAiVirtualModelRegistryError` on blank,
self-referencing, namespaced, non-string wire ids or unsupported modes.

## Scope

- `InvalidOpenAiVirtualModelRegistryError` error class
- `validateOpenAiVirtualModelDefinition(selectedModelId, definition)` pure function
- Reject: undefined/null/array/empty object, blank wireModelId, wireModelId with `/`,
  wireModelId === selectedModelId, non-"pro" reasoningMode, non-string wireModelId
- `resolveOpenAiVirtualModel` delegates to validator on matched entry
- `applyOpenAiVirtualModel` returns the resolution or undefined (not void)
- `resolveOpenAiCompactModel` returns resolution or undefined (not `{isVirtual}` shape)
- Idempotence: second application on already-rewritten parsed/route is safe

## Activation tests

- `tests/openai-api-virtual-models.test.ts` "validateOpenAiVirtualModelDefinition" suite
- Ten malformed synthetic definitions (including the self-referencing
  `wireModelId === selectedModelId` case) rejected without mutating registry
- Pure resolution returned without mutating the definition object
- Apply returns resolution on match, undefined on no-match
- Omitted/null reasoning → `{mode:"pro"}`
- Conflicting mode replaced, effort/summary/generate_summary preserved

## Evidence

- See the Cycle A closure evidence below for the self-reference and registry-immutability
  activation proof; consolidated/final receipts are indexed by 190 and 050.

## Status

`done — closed by the Cycle A closure evidence below; see 190 + 050 evidence`

## Cycle A closure evidence (2026-07-17)

- The malformed-definition table now contains ten explicit cases, including
  `wireModelId === selectedModelId`, and snapshots `PROVIDER_REGISTRY` before each
  rejection to prove byte-for-byte immutability afterward.
- `bun test tests/openai-api-virtual-models.test.ts --test-name-pattern
  "validateOpenAiVirtualModelDefinition"`: PASS — 11 tests, 0 failures, 22 assertions.
