# Compatibility Contracts

## Purpose

Compatibility manifests state what one exact provider, normalized upstream base URL, adapter,
authentication mode, inbound protocol, upstream protocol, and model set does with a feature. They
do not infer that every model using the same adapter or wire protocol has identical behavior.

The contracts are intentionally narrow. The first covers canonical `openai` Codex-login forwarding
for `gpt-5.6-sol` over the `openai-responses` adapter. The second covers key-auth `opengateway` for
`z-ai/glm-5.3-flash-ultrafast`, which reaches the `openai-responses` wire through the registry's
per-model wire default and declares `supportsResponsesCustomTools: false`. Later providers or
models need their own fixture evidence before they can be added.

## Files

| Path | Responsibility |
| --- | --- |
| `src/compatibility/manifest.ts` | Versioned schema, wire classifications, and fail-closed validation. |
| `src/compatibility/openai-responses.ts` | Canonical Codex forward manifest (native custom tools). |
| `src/compatibility/opengateway-responses.ts` | OpenGateway key-auth manifest (custom tools lowered to functions). |
| `src/compatibility/index.ts` | Manifest catalog for future CLI and GUI readers. |
| `tests/fixtures/compatibility/` | Secret-free request vectors plus destination, header-boundary, and assertion-level expected behavior. |
| `tests/codex-integration/compatibility-manifest.test.ts` | Executes each fixture against the production adapter for its manifest's subject and runs the catalog evidence gate. |

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

## Evidence validation layers

Validation happens in two places. The schema validator in `src/compatibility/manifest.ts` is a
passive leaf: it checks shape, dispositions, limitations, and that fixture evidence lists at least
one assertion ID, without reading fixtures. The catalog evidence gate in the manifest test owns the
rest: each manifest maps to exactly one fixture by `manifestId`, every cited assertion ID must exist
in that fixture, and a deleted or misspelled assertion fails the gate.

The gate also checks that a `passthrough` claim is coherent with its evidence. Passthrough means
the caller's value reaches the upstream unchanged, so each cited assertion must be an `equals`
assertion whose expected value is the caller's value at the same place: `/body/<path>` maps to the
case's `request` at `/<path>`, and `/headers/<name>` maps to the case's `incomingHeaders` by
case-insensitive name. An `absent` assertion, an equality against a rewritten value, or a selector
with no caller counterpart (such as `/url` or a runner-selected credential header) cannot back a
passthrough claim. Envelope header names are normalized to lowercase before assertions run.

Passthrough evidence must also be about the claimed feature. The test keeps a binding from each
feature that may be claimed as passthrough to the outbound selectors that can prove it
(`request.custom_tools` → `/body/tools/<n>` holding a native custom declaration,
`request.custom_tools.grammar` → `/body/tools/<n>/format` holding a grammar with a non-empty
definition, `request.prompt_cache_key` → `/body/prompt_cache_key`). A preserved but unrelated value,
such as the model id, cannot back a grammar claim, and a feature without a binding cannot be claimed
as passthrough until one is added.

## Custom-tool representation and grammar

Custom-tool representation (`request.custom_tools`) and grammar (`request.custom_tools.grammar`)
are separate claims, because a route can keep a usable tool while losing its grammar. Both fixtures
send the same custom tool with a non-empty Lark grammar definition, so the difference between them is
the route. The canonical forward route keeps both unchanged (`passthrough`). The OpenGateway route
lowers the declaration to a function with one required string `input` parameter (`translated`),
removes the format and its definition (`degraded`: the upstream model is not constrained by the
grammar), and replays `custom_tool_call` / `custom_tool_call_output` history as `function_call` /
`function_call_output` (`translated`). These claims describe the local wire transformation only;
they do not certify upstream acceptance or that generated input follows the grammar.

The key-auth fixture runner builds the provider from the registry seed, resolves its per-model wire
default, and applies `enrichProviderFromRegistry` before constructing the adapter. Enrichment is
what carries `supportsResponsesCustomTools: false` onto a configured provider; without it the
lowering this contract describes would not run.

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

## Undeclared-tool refusal is an inbound-protocol claim

Whether a routed provider's call to an undeclared tool is refused depends on the inbound protocol,
not on the adapter or the upstream protocol. The `responses` inbound protocol refuses it and ends
the turn, which is the #1700 contract. The `chat` and `anthropic` inbound protocols relay it,
because those specs place validation and execution with the client's own tool runner.

A manifest claiming a disposition for tool-call delivery therefore names its inbound protocol. The
same provider, base URL, adapter, and authentication mode produce `passthrough` on `chat` and
`anthropic` and `unsupported` on `responses` for the identical undeclared call, which is exactly
the inference the narrow-subject rule above exists to prevent.

Tool-name normalization is not scoped this way and runs on every inbound protocol, so a
provider-invented `default.` namespace resolves back to the declared tool regardless of subject.
The contract is stated in full in [Responses Transport](../transports/responses.md).
