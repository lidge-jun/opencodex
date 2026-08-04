# 020 — Phase 2: scope the registry wire default to the inbound protocol

## Problem

`providerModelWireDefault()` knows the provider and model but not which inbound
surface is asking, so `{ "deepseek-v4-flash": "openai-responses" }` fires everywhere.
Claude Code and Chat clients pay a translation hop onto a wire they never requested,
when DeepSeek serves their native wire directly.

### Corrected call-site inventory (audit blocker 2)

An earlier draft of this doc credited `fetch-helpers.ts`, `collaboration.ts`,
`compact.ts` and `encrypted-payload.ts` with call sites. They only **import** the
symbol — zero invocations. Every real Responses-side call lives in `core.ts`:

| Site | Role |
|---|---|
| `core.ts:745` | `applyFinalRouteRequestNormalization` — settles the wire for logging, fast-mode, auth, sidecars |
| `core.ts:1314` | the adapter build that actually reaches the upstream |
| `core.ts:356, 1894, 1961, 2207, 2232, 2264, 2393, 2421` | retry / fallback / refresh paths inheriting the same route |
| `claude-messages.ts:599` | pre-flight only |
| `chat-completions.ts:81` | pre-flight only |

### Why the naive fix is wrong (audit blocker 1, CRITICAL)

`claude-messages.ts:685` and `chat-completions.ts:150` do **not** dispatch upstream.
They translate their body into a `/v1/responses` shape and call
`handleResponses(internalReq, ...)`. Their local `route.provider` is then discarded —
only `internalBody` crosses the boundary. So editing just those two sites would:

1. fail to change the wire at all, because `core.ts:745`/`1314` re-resolve with no
   inbound argument (defaulting to `"responses"`), and
2. actively introduce a NEW defect: the Claude path would compute `nativeRoute = false`
   and keep `max_output_tokens`/`temperature`/`top_p`, while `core.ts:1314` still
   selected `openai-responses` — handing sampling params to a Responses upstream.

`compact.ts:337` also re-enters `handleResponses`, but its only caller is the native
compact route (`index.ts:491`), so it is genuinely Responses-inbound and the default is
correct there. Full entrypoint audit, all five verified:

| Entry | Inbound | Needs an explicit `inboundWire`? |
|---|---|---|
| `index.ts:616` native `/v1/responses` | responses | no — default correct |
| `index.ts:907` WebSocket bridge | responses | no — default correct |
| `compact.ts:337` | responses | no — default correct |
| `core.ts:941` combo child | inherited | no — `...options` propagates it |
| `claude-messages.ts:685`, `chat-completions.ts:150` | anthropic / chat | **yes** |

The inbound must therefore travel WITH the request, not as a defaulted parameter.

## Design

Represent the default as inbound-scoped rather than unconditional. Keep the existing
string form working (it means "any inbound") so no other registry entry changes
meaning, and add an object form carrying the inbound scope.

```ts
/** Which inbound protocol a registry wire default applies to. */
export type InboundWire = "responses" | "chat" | "anthropic";

export type ModelWireDefault = string | { wire: string; inbound: readonly InboundWire[] };
```

`resolveWireProtocolOverride` gains a trailing optional `inbound` parameter defaulting
to `"responses"` — correct for a genuine Responses request.

The inbound then travels through `HandleResponsesOptions`, which already carries
exactly this kind of caller-supplied context (`promptCacheKeyIsSharedCohort`,
`core.ts:496`). `handleResponses` reads it once and passes it to the `core.ts` call
sites that matter.

> Amendment (first audit, Critical): an earlier sketch edited only the two pre-flight sites
> and defended the choice as "keeping the risky edit surface small". The reviewer
> showed that inverted the risk — those two results are discarded, and the ten
> `core.ts` sites are the ones that decide the wire. The option channel replaces it.

## Change map

### MODIFY `src/providers/registry.ts`

```ts
+export type InboundWire = "responses" | "chat" | "anthropic";
+export type ModelWireDefault = string | { wire: string; inbound: readonly InboundWire[] };

-  modelWireDefaults?: Record<string, string>;
+  modelWireDefaults?: Record<string, ModelWireDefault>;
```

`providerModelWireDefault` takes the inbound and honours the scope:

```ts
 export function providerModelWireDefault(
   id: string,
   provider: ...,
   modelId: string,
   allowedWires: ReadonlySet<string>,
+  inbound: InboundWire,
 ): string | undefined {
   ...
   const entry = getProviderRegistryEntry(id);
   if (!entry?.modelWireDefaults || !providerMatchesRegistryTransport(id, provider)) return undefined;
-  const wire = entry.modelWireDefaults[modelId.trim().toLowerCase()];
+  const declared = entry.modelWireDefaults[modelId.trim().toLowerCase()];
+  if (declared === undefined) return undefined;
+  const wire = typeof declared === "string" ? declared : declared.wire;
+  if (typeof declared !== "string" && !declared.inbound.includes(inbound)) return undefined;
   return wire !== undefined && allowedWires.has(wire) ? wire : undefined;
 }
```

DeepSeek's entry becomes scoped:

```ts
-    modelWireDefaults: { "deepseek-v4-flash": "openai-responses" },
+    modelWireDefaults: {
+      // Codex speaks Responses natively and DeepSeek ships a Codex-compatible
+      // apply_patch tool on that wire, so a Responses inbound goes straight out with
+      // zero translation. Claude Code (Anthropic) and OpenAI-compatible clients keep
+      // the provider-wide Chat wire: DeepSeek serves Chat Completions natively too,
+      // so translating them into Responses would add a hop onto our newest upstream
+      // path for no gain.
+      "deepseek-v4-flash": { wire: "openai-responses", inbound: ["responses"] },
+    },
```

### MODIFY `src/server/adapter-resolve.ts`

```ts
 export function resolveWireProtocolOverride(
   providerName: string,
   modelId: string,
   providerConfig: OcxProviderConfig,
+  inbound: InboundWire = "responses",
 ): OcxProviderConfig {
   ...
-    : providerModelWireDefault(providerName, providerConfig, modelId, MODEL_ADAPTER_OVERRIDE_ALLOWED);
+    : providerModelWireDefault(providerName, providerConfig, modelId, MODEL_ADAPTER_OVERRIDE_ALLOWED, inbound);
```

An explicitly configured `modelAdapters` override still wins — user intent outranks a
registry default on every inbound.

### MODIFY `src/server/responses/core.ts`

Add the option (beside `promptCacheKeyIsSharedCohort`, ~line 496):

```ts
   promptCacheKeyIsSharedCohort?: boolean;
+  /**
+   * Inbound protocol of the ORIGINAL client request. Chat and Anthropic surfaces
+   * translate into a Responses-shaped body and replay through handleResponses, so
+   * without this the replay would look like a native Responses request and a
+   * Responses-scoped wire default would fire for a client that never asked for it.
+   */
+  inboundWire?: InboundWire;
```

Thread it at all ten sites — every one must agree, or the adapter and the
normalization disagree. Verified enclosing scopes on the current tree:

| Site(s) | Enclosing function | How it reaches the option |
|---|---|---|
| 1314, 1894, 1961, 2207, 2232, 2264, 2393, 2421 | `handleResponses` (1055) | `options` is in scope directly |
| 745 | `applyFinalRouteRequestNormalization` (727) | takes an args object; **add `inboundWire` to it** and pass from the call site |
| 356 | `retryCodexPoolOnAlternateAccount` (306) | destructures `options` (310), but its type is NARROWED — see below |

**`CodexPoolAccountRetryArgs.options` is not `HandleResponsesOptions`.** At
`core.ts:248-252` it is a structural subset (`abortSignal`,
`onCodexAuthContextResolved`, `deferCodexResetDerivedCooldown`). Passing the full
options object at the call site is legal subtype assignment, but READING
`options.inboundWire` inside the function is a type error. Add the field there too:

```ts
   options: {
     abortSignal?: AbortSignal;
     onCodexAuthContextResolved?: (ctx: CodexAuthContext) => void;
     deferCodexResetDerivedCooldown?: boolean;
+    inboundWire?: InboundWire;
   };
```

**Combo child replay (`core.ts:941`)** re-enters `handleResponses` with
`{ ...options, comboAttempt: true, ... }`. The leading spread propagates
`inboundWire` automatically — no edit needed, but the spread is load-bearing and
must not be reordered away.

```ts
-  route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
+  route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inbound);
```

where `inbound = options.inboundWire ?? "responses"`.

> Stale check (this cycle's P): all ten line numbers still match, and
> `applyFinalRouteRequestNormalization` does NOT currently receive `options` — it takes
> `{ parsed, route, config, req, logCtx }`. The earlier draft claimed it already had
> `options`; correcting that here rather than discovering it mid-build.

### MODIFY `src/server/claude-messages.ts`

Line ~599 (pre-flight, so `nativeRoute` agrees with the adapter chosen downstream):

```ts
-    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
+    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "anthropic");
```

Line ~685, the replay that actually dispatches:

```ts
   const upstream = await handleResponses(internalReq, buildClaudeReplayConfig(config), logCtx, {
     abortSignal: req.signal,
     promptCacheKeyIsSharedCohort: cacheKeySource === "system",
+    inboundWire: "anthropic",
```

### MODIFY `src/server/chat-completions.ts`

Line ~81 pre-flight gets `"chat"`, and the replay at ~line 150:

```ts
   const upstream = await handleResponses(internalReq, config, logCtx, {
     abortSignal: req.signal,
+    inboundWire: "chat",
```

Both layers now read the same inbound, so the pre-flight `nativeRoute` decision and
the adapter that reaches the wire can no longer disagree.

## Accept criteria

- Resolver returns `openai-responses` for inbound `responses`, `openai-chat` for
  inbound `anthropic` and `chat`.
- A string-form `modelWireDefaults` entry still applies on every inbound.
- An explicit `modelAdapters` override still wins on a non-Responses inbound.
- **End-to-end, not just the resolver (audit blocker 1):** a test must prove the
  inbound survives the `handleResponses` replay. A resolver-only test would pass while
  the real behaviour stayed wrong — that false-confidence risk is the whole point of
  this amendment.

  Seam: `handleResponses` is exported and already driven end-to-end with
  `globalThis.fetch` stubbed — `tests/subagent-fallback-handle-responses.test.ts`
  captures upstream URLs in `mockUpstream` (line 150) and types its options as
  `Parameters<typeof handleResponses>[3]` (line 188). Drive a DeepSeek config through
  it and assert the CAPTURED UPSTREAM URL:

  | `inboundWire` | expected upstream URL |
  |---|---|
  | omitted / `"responses"` | `https://api.deepseek.com/responses` |
  | `"anthropic"` / `"chat"` | `https://api.deepseek.com/chat/completions` |

  The URL is externally observable and cannot pass while the replay wire is wrong.

  > An earlier draft offered `applyFinalRouteRequestNormalization` as a fallback seam.
  > It is not exported, and widening a module's public surface purely for a test is the
  > wrong trade — the URL assertion is both stronger and requires no new export.

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The new guard `!declared.inbound.includes(inbound)` is triggered by calling the
resolver with `"anthropic"`/`"chat"` against the deepseek config; the observable
effect is the returned config keeping `adapter: "openai-chat"` instead of flipping.
The positive control is the same call with `"responses"` still flipping to
`openai-responses`, proving the guard is scope-selective rather than always-off.
