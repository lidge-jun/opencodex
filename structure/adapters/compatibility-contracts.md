# Compatibility Contracts

## Purpose

Compatibility manifests state what one exact provider, normalized upstream base URL, adapter,
authentication mode, inbound protocol, upstream protocol, and model set does with a feature. They
do not infer that every model using the same adapter or wire protocol has identical behavior.

The initial contract is intentionally narrow: canonical `openai` Codex-login forwarding for
`gpt-5.6-sol` over the `openai-responses` adapter. Later providers or models need their own fixture
evidence before they can be added.

## Files

| Path | Responsibility |
| --- | --- |
| `src/compatibility/manifest.ts` | Versioned schema, wire classifications, and fail-closed validation. |
| `src/compatibility/openai-responses.ts` | First bundled compatibility manifest. |
| `src/compatibility/index.ts` | Manifest catalog for future CLI and GUI readers. |
| `tests/fixtures/compatibility/` | Secret-free request vectors plus destination, header-boundary, and assertion-level expected behavior. |
| `tests/codex-integration/compatibility-manifest.test.ts` | Executes fixtures against production adapters and proves every claim has evidence. |

## Dispositions

| Disposition | Meaning |
| --- | --- |
| `passthrough` | The relevant semantic value reaches the upstream representation unchanged. |
| `translated` | OpenCodex deliberately represents the feature differently while preserving its purpose. |
| `degraded` | OpenCodex keeps useful information but cannot preserve the complete original semantics. |
| `unsupported` | The feature is removed or rejected for the exact declared subject. |

`translated`, `degraded`, and `unsupported` claims require a concrete limitation. Every fixture
claim names exact assertion IDs; a test-file name alone is not evidence because it can stay green
after the relevant assertion is deleted.

## Runtime boundary

Compatibility manifests are passive data. The Responses request path, router, and server startup do
not import them. A future `ocx compatibility explain` or GUI reader may load the catalog on demand,
but adding a manifest must not activate Compatibility Lab or alter dispatch behavior.

## Canonical forward continuation extensions

The canonical ChatGPT Codex forward boundary removes client-only
`prompt_cache_breakpoint` properties from `input` recursively. The traversal is bounded by depth
and node count; exceeding either bound leaves the marker-bearing input unchanged instead of
publishing a partially transformed continuation. When the request explicitly sets `store: false`,
top-level `item_reference` input rows are omitted because the destination cannot resolve state that
it did not persist. Function and tool-result `call_id` pairs and `reasoning.effort` remain intact.

This is destination-scoped compatibility behavior. Key-auth public Responses providers and custom
forward gateways keep both extensions unchanged because their contracts may accept or interpret
them independently.

> Decision record: [ADR-0094](../decisions/ADR-0094-canonical-forward-continuation-extensions.md)

> Decision record: [ADR-0095](../decisions/ADR-0095-canonical-forward-continuation-extensions.md)

## Routed code-mode patch completion

Native Responses custom exec and function helper aliases apply the same complete-envelope
resolver at input.done, output_item.done and terminal snapshots. Potential raw/wrapped patch
previews are withheld before compilation; ordinary native custom payloads retain their raw
grammar. A string merely containing patch markers remains executable caller input and is
never rewritten. Completion and disposal release retained preview buffers.

## Native ordinary function completion

The native Responses lane captures ordinary function schemas from the current caller-owned
catalog before provider lowering; historical replay catalogs cannot add repair authority.
Completion events, JSON responses and stored continuation output share schema-aware argument
repair. Preview deltas retain the existing bridge contract; authoritative completed arguments
carry representation fixes. Custom tool wrappers and native forward traffic are excluded.

Namespace restoration and the undeclared-name guard share one dotted-alias collision inventory,
including bare declarations inside the reserved functions group. Canonical authorization happens
before dotted aliases are added. A conflicting explicit namespace is never overwritten. Namespace
restoration retains the existing lowered-kind handling because custom tools are lowered to
functions before the adapter constructs its alias map; ordinary argument repair independently
checks the original declaration kind.
