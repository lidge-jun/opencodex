# WP7 — Consumer-backed metadata contracts

## Goal and dependency

Consume only metadata fields that change a defined Codex-visible or request-wire behavior, with explicit live/registry/config/generated precedence. Do not preserve arbitrary provider metadata.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/codex/catalog.ts` | generated metadata applies context and input only | add a consumer only for approved fields, each with a named target catalog property or request resolver and precedence function |
| MODIFY | `src/generated/jawcode-model-metadata.ts` | emits `maxTokens`, `reasoning`, `wireModelId` even when unused | format remains generated; no manual edits. Regeneration occurs only after consumer scope is fixed |
| MODIFY | `scripts/generate-jawcode-metadata.ts` | source snapshot can change unused columns | preserve deterministic output and add schema assertions for any newly consumed column |
| MODIFY | `src/types.ts` | `CatalogModel` lacks max-output/wire-id consumers | add only fields selected by the P decision; do not add `metadata: Record<string, unknown>` |
| MODIFY | `src/reasoning-effort.ts`, `src/adapters/openai-chat.ts`, `src/adapters/google.ts`, `src/adapters/cursor/discovery.ts` | reasoning and wire ids are provider-specific | change only the provider owner selected in P; consume a generated hint only when live/registry precedence and a real request consumer are defined |
| MODIFY | `tests/codex-catalog.test.ts` | context/input enrichment only | table-test precedence, absent data, stale generated hints, and provider alias cases |
| MODIFY | `tests/provider-registry-parity.test.ts` | generated schema existence | assert no generated field bypasses explicit provider caps/aliases |

## P decision table

| Field | Default decision | Required consumer proof |
|---|---|---|
| `maxTokens` | research | Codex catalog field or request max-output clamp that reads it |
| `reasoning` | adapt only if needed | picker reasoning availability not already owned by registry/live metadata |
| `wireModelId` | adapt only for a named provider | request model resolver with alias precedence and round-trip test |
| prices or arbitrary rich metadata | out | a separately approved billing/product consumer |

## Precedence contract

Explicit user config > provider registry policy > authenticated live metadata > generated snapshot > conservative default. A generated row may fill a missing value but cannot raise a user/registry cap, resurrect a hidden model, or override an inbound compatibility alias.

## Activation scenarios

- A generated `wireModelId` affects only the provider whose resolver opts in; an identically named model on another provider remains unchanged.
- A lower configured context/max-output cap wins over a larger generated value.
- A missing or stale generated row leaves live/registry behavior unchanged.
- Regeneration with no consumed-field delta causes no catalog snapshot delta.

## Verification

```bash
bun run generate:jawcode-metadata
git diff -- src/generated/jawcode-model-metadata.ts
bun test tests/codex-catalog.test.ts tests/provider-registry-parity.test.ts tests/reasoning-effort.test.ts
bun run typecheck
```

The generation command's full diff output is a required C attestation artifact. Empty output proves no drift; non-empty output blocks D until every changed row is reviewed and accepted or the generated file is restored.

## Terminal outcomes

- `DONE`: at least one real consumer is implemented with precedence and activation proof, or the audit records that no field qualifies and closes `NOOP`.
- `NOOP`: context/input remain the only justified consumers.
- `UNSAFE`: a proposed opaque field bag would carry untrusted, consumerless data into runtime or UI.
- `NEEDS_HUMAN`: product ownership is required for price/billing semantics.
