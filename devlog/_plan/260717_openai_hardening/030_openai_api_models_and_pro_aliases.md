# Cycle 030 — OpenAI API Metadata and Pro Virtual Models

## Objective

Add eight OpenAI API choices total: existing `gpt-5.5` plus seven GPT-5.6 ids,
of which exactly three are API-only virtual Pro choices. Keep virtual identity on
all OCX/user surfaces, including HTTP JSON/SSE and real WebSocket response payloads;
translate only API wire requests and retain the base id separately as resolved identity.

## Trusted metadata owners

### MODIFY `src/types.ts`, `src/config.ts`, and `src/server/auth-cors.ts`

Add `modelMaxInputTokens?: Record<string, number>` to `OcxProviderConfig`. Disk-load
schema and management admission both require a plain own-property record of positive
finite integers. Zero, negative, fractional, string, array, null, inherited, or
non-finite values fail with 400 and do not overwrite prior config. Do not add virtual
model maps to persisted config.

### MODIFY `src/providers/registry.ts`

Add registry-only:

```ts
virtualModels?: Record<string, { wireModelId: string; reasoningMode: "pro" }>;
modelMaxInputTokens?: Record<string, number>;
```

For `openai-apikey`, set exactly eight models: `gpt-5.5`, `gpt-5.6`,
Sol/Terra/Luna, and the three
Pro ids. Base/alias/Pro rows use 1,050,000 context, 922,000 max input, text+image,
and Codex-supported `low,medium,high,xhigh,max`. Define no generic `gpt-5.6-pro`.
Keep OpenRouter constants untouched.

### MODIFY `src/providers/derive.ts`

Clone `modelMaxInputTokens` into config hints. Do not clone registry-only virtual maps
into user/provider config or management DTOs.

### MODIFY `src/oauth/key-providers.ts` and `src/oauth/login-cli.ts`

Thread `modelMaxInputTokens` through the public key-provider DTO and CLI-created
provider config using independent clones. Prefer the canonical derived registry type
over a second hand-written metadata shape. `virtualModels` remains registry-private and
must be absent from both DTO and persisted CLI config.

### NEW `src/providers/openai-virtual-models.ts`

Export the exact contract:

```ts
interface OpenAiVirtualModelResolution {
  selectedModelId: string;
  wireModelId: string;
  reasoningMode: "pro";
}
class InvalidOpenAiVirtualModelRegistryError extends Error {}
resolveOpenAiVirtualModel(
  providerName: string,
  selectedModelId: string,
): OpenAiVirtualModelResolution | undefined;
applyOpenAiVirtualModel(
  parsed: OcxParsedRequest,
  route: RouteResult,
  logCtx: RequestLogContext,
): OpenAiVirtualModelResolution | undefined;
resolveOpenAiCompactModel(
  providerName: string,
  selectedModelId: string,
): OpenAiVirtualModelResolution | undefined;
```

The two resolvers are pure. `applyOpenAiVirtualModel` intentionally mutates only the
passed parsed request, route, raw request model/reasoning object, and log context, and
is idempotent on second application. They read trusted registry metadata only, require
provider `openai-apikey` and exact keys, return `undefined` on ordinary no-match, throw
`InvalidOpenAiVirtualModelRegistryError` for a matched entry with a blank, namespaced,
non-string wire id or unsupported mode, and never infer from a `-pro` suffix.

Normal Responses behavior:

- preserve original namespaced selection in `logCtx.requestedModel`;
- set `logCtx.model` to selected local id such as `gpt-5.6-sol-pro`;
- rewrite `route.modelId`, `parsed.modelId`, and raw body model to base id;
- merge `reasoning.mode="pro"`, overriding a conflicting mode while preserving
  independent supported effort and other allowed reasoning fields.
- omitted or `null` raw reasoning becomes `{mode:"pro"}`; a valid object is cloned and
  merged; parser-rejected scalar/array reasoning never reaches apply. Preserve effort,
  summary, and every other parser-allowed reasoning key.

Compact behavior is fixed by the official schema: map virtual id to base id and send
no `reasoning` member because `ResponseCompactParams` has no reasoning field.
Compaction does not change the selected model stored by Codex; the next `/responses`
turn reapplies Pro mode.

## Catalog and request flow

### MODIFY `src/codex/catalog.ts`

- Extend `CatalogModel` with `maxInputTokens`.
- Provider hints read `modelMaxInputTokens`.
- Routed `auto_compact_token_limit` becomes
  `min(floor(effectiveContextWindow*0.9), maxInputTokens)`; a 350K user cap stays 315K.
- Add `augmentRoutedModelsWithRegistryOpenAiApiRows` after live/static gathering and
  before visibility/sort. It deterministically rebuilds all seven registry-owned
  GPT-5.6 rows (alias, three bases, three Pro virtuals), including rows omitted by a
  successful live `/models` response. It replaces same-id live rows with trusted rows
  and warns once per collision.
- Treat registry 1,050,000 context and 922,000 max input as trusted baselines for these
  seven rows. Existing live metadata cannot lower or raise those baselines. Apply user
  `modelContextWindows` and `modelMaxInputTokens` only afterward as lowering caps;
  values above official limits never raise them. Do not change global cap semantics for
  nontrusted rows.
- Direct/Multi rows never receive API virtuals or API context values.

### MODIFY `src/router.ts`

Merge registry `modelMaxInputTokens` as trusted defaults, then apply user numeric hints
as lowering caps (`min`), never as overrides that raise 922K. Virtual mapping is not
placed on the route provider; the resolver receives provider name explicitly.

### MODIFY `src/server/responses.ts`

Immediately after `routeModel` and namespace stripping, call
`applyOpenAiVirtualModel` before effort caps/native clamps. Native clamp continues to
use original namespaced `requestedModel`, so routed Pro never masquerades as native.
Rewrite client-visible response `model` back to the selected virtual id for buffered
HTTP JSON, every HTTP SSE response/event object carrying the upstream base model, and
the same SSE frames re-framed onto a real WebSocket. This rewrite is response-only;
record the upstream base as `logCtx.resolvedModel` before rewriting.
Change the compact signature to:

```ts
export async function handleResponsesCompact(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response>;
```

It calls `resolveOpenAiCompactModel`, emits the base id only, and sets
`logCtx.model` to the selected local virtual id, `logCtx.requestedModel` to the
original namespaced id, `logCtx.resolvedModel` to the base id, and
`logCtx.provider` to `route.providerName`.

### MODIFY `src/server/index.ts`

For `POST /responses/compact`, allocate request id/start time and a
`RequestLogContext` before calling `handleResponsesCompact(req, config, logCtx)`.
Remove the compact handler's private context. `src/server/index.ts` is the sole
allocator/finalizer and calls direct `addFinalRequestLog` exactly once after the
buffered handler returns, or once in its catch. Body decode failure, local 4xx,
upstream 5xx, success, and cancellation each produce exactly one row with the same
response-status/error classification as `/responses`. Compact usage may remain
`unreported`, but the persisted entry preserves all three model identities.

### MODIFY `src/server/request-log.ts` and `src/usage/log.ts`

Add `requestedModel?: string` to `PersistedUsageEntry`, its JSON normalizer, and the
`addRequestLog` persistence payload. Then use the fields with fixed ownership:

- `model` = selected local id (virtual id for Pro);
- `requestedModel` = original caller id including provider namespace;
- `resolvedModel` = upstream response/base model.

`addRequestLog` persists selected `model`, namespaced `requestedModel`, and optional
base `resolvedModel` unchanged. No separate wire-id field is added.

### VERIFY `src/usage/summary.ts` (no production change expected)

Existing grouping by provider + persisted selected `model` is already correct; never
group by `resolvedModel`. Add only a regression proving three Pro rows do not collapse
into bases.

## Tests and activation proof

### MODIFY `tests/provider-registry-parity.test.ts`

Assert eight OpenAI API ids total and exact seven GPT-5.6 ids (alias, three bases,
three Pro), official metadata, three mappings, no generic alias, and no virtual map in
derived management config.

### MODIFY `tests/codex-catalog.test.ts`

Assert all seven trusted rows survive successful live discovery that omits the alias
and Pro ids; one conflicting live row is replaced with one warning. Cover live context
below/above 1.05M and user caps below/above official values: 922K uncapped, 315K at a
350K context cap, never 945K. Assert Direct/Multi metadata isolation.

### NEW `tests/openai-api-virtual-models.test.ts`

Use `startServer`, exact `globalThis.fetch` URL interception that throws on every
unknown URL, and `afterEach` restoration. Capture HTTP, HTTP SSE, and a real WebSocket
upgrade plus `response.create` for all three Pro ids. Assert API URL/key,
base wire model, mode Pro, preserved effort, selected log model, namespaced requested
model, base resolved model, client-visible virtual response model, and zero Codex
account headers. Base models, other
providers, unknown `-pro`, and forged config maps remain unchanged/rejected.

Capture compact requests for standard and all Pro ids. Assert API key + base model and
absence of `reasoning`; Direct/Multi compact behavior remains Cycle-020-owned. Query
`/api/logs` and inspect the temporary usage JSONL to assert virtual `model`, namespaced
`requestedModel`, base `resolvedModel`, routed provider (never `unknown`), and compact
usage status `unreported`.

Add exact resolver tests for match/no-match, other provider, blank/namespaced wire id,
unsupported mode, omitted/null/conflicting reasoning, effort/summary preservation,
parser-rejected non-object shapes, and second-application idempotence.

### MODIFY `tests/config.test.ts`, `tests/server-auth.test.ts`,
`tests/provider-registry-parity.test.ts`, and key-login tests

Disk and management boundaries accept only plain positive-integer max-input maps and
preserve old config on every rejection. Key-provider DTO and CLI config contain an
independently cloned map but no virtual mapping. Reserved API metadata remains trusted
and management cannot inject virtual mappings.

### MODIFY `tests/request-log.test.ts`, `tests/usage-log.test.ts`, and
`tests/usage-summary.test.ts`

After HTTP, WS, and compact Pro requests, query `/api/logs` and reread usage JSONL.
Assert selected virtual `model`, namespaced `requestedModel`, base `resolvedModel`,
and routed provider; summaries group by virtual id.

## Verification and exit gate

```sh
bun test tests/config.test.ts tests/server-auth.test.ts tests/provider-registry-parity.test.ts tests/codex-catalog.test.ts tests/openai-api-virtual-models.test.ts tests/oauth-login-summary.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts
bun x tsc --noEmit
```

Accept only when every advertised virtual id has captured HTTP/HTTP-SSE/real-WS/compact
wire and client-response identity proof; each compact outcome logs exactly once; every
fetch URL is exact; and no provider/config/body outside the exact API mappings is
transformed.
