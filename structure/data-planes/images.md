# Images Data Plane

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

`src/server/images.ts` uses the existing ChatGPT/OpenAI fallback unless `images.provider` explicitly
selects a custom API-key `openai-responses` provider. Explicit selection fails closed when the
provider is missing, disabled, registry-managed, incompatible, or lacks a usable key; it never
falls through to another paid upstream. The relay accepts bounded JSON generation and edit requests,
then forwards the decoded JSON without rewriting Codex's edit schema. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

When the OpenAI credential path is unavailable or its authentication fails, `generations` (not
`edits`) may fall back to Google Antigravity if that provider is logged in. The fallback is
credential-driven: it exists so an image request reaches a real upstream answer rather than dying on a
local credential error, and it does not apply when the caller selected an explicit keyed custom
provider, because a configured pool owns its own authentication failure rather than hiding it behind
separately billed generation.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes. An
explicit keyed Images provider accepts the proxy admission secret as either an OpenAI-style bearer
or `x-opencodex-api-key` because the provider key replaces caller authorization before fetch. The
ChatGPT forward path still requires the dedicated header so its upstream bearer remains distinct.
The keyed path never enters `handleResponses`, so `src/server/images.ts` repeats
`selectProactiveApiKeyTransport` inside the keyed branch and rebuilds Authorization from the
returned clone rather than the earlier snapshot.

The API-key `openai-responses` path also adapts Codex's private standalone image tool to the public
Responses tool surface. A complete `image_gen` namespace is lowered to safe
`image_gen__<inner-name>` function aliases even when no hosted image tool is present, because public
Responses runtimes may reserve the namespace itself and reject dotted function names. Native and
legacy dotted calls replayed in `body.input` are encoded to the same aliases. When any client
image-gen declaration is replaced by a usable `image_gen__<inner-name>` alias, the adapter also drops
hosted `image_generation` and deduplicates aliases in stable container order. Empty or malformed
namespaces do not remove the hosted fallback. Discovery and normalization span both top-level
`body.tools` and Codex Desktop Responses Lite `input[].type = "additional_tools"` containers.

For a model explicitly listed in `modelPreferHostedTools`, a non-forward Responses provider may opt
to remove colliding client `image_gen` declarations before this normalization and rewrite their
selectors to hosted `image_generation`, so a provider-reserved hosted tool takes precedence without
loosening a caller's tool-choice restriction. The opt-in is intentionally model-scoped: the default
alias path remains safest for ordinary public Responses endpoints.

For OpenAI API virtual `-pro` models, preference lookup checks the selected public ID first and
uses the resolved base wire-model ID as a fallback. `modelAdapters` resolves the public ID first and
the base ID second; the second pass selects the final adapter, and configuration validation mirrors
both steps.

Client-facing API-key responses perform the inverse mapping: JSON output and SSE function-call
items restore `{ namespace: "image_gen", name: "<inner-name>" }` so Codex can dispatch the local
extension. When item-id repair is also enabled, both transforms compose in one SSE parse/stringify
pass (`src/server/sse-payload-rewrite.ts`) rather than chaining separate JS pull wrappers.
Inspection and continuation-cache branches keep the raw upstream alias, allowing stored
replays to return upstream without leaking a client-only namespace shape. The image-gen layer itself
leaves malformed and empty image-gen namespaces untouched, but on a noncanonical route the general
namespace boundary above runs after it and lowers whatever remains, so no private group reaches the
wire. ChatGPT forward mode preserves the private namespace and hosted tool because that backend
understands their native semantics.

Per-model `modelReasoningSummaryDelivery` is a narrow compatibility layer for
`openai-responses` gateways whose summary capability is real but whose accepted delivery enum
differs from Codex. Presence advertises reasoning summaries in the routed catalog and rewrites only
an already-present `stream_options.reasoning_summary_delivery` at the adapter boundary. It never
injects summary generation into a request, and config validation rejects a delivery map that
conflicts with `modelSupportsReasoningSummaries: false` for the same model.

> Decision record: [ADR-0045](../decisions/ADR-0045-standalone-images.md)

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Claude replay carries [Go conversation affinity](inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
