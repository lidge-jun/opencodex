# 030 — Phase 3: stop sending stateful parameters to a stateless Responses upstream

## Problem

`stripPreviousResponseId(body, strip)` strips only when the proxy expanded the input
or when `authMode === "forward"`. Its docstring justifies keeping the field otherwise:

> API-key mode keeps the field on unexpanded requests: the platform `/v1/responses`
> supports real server-side storage.

True for the OpenAI platform, false for DeepSeek, which documents: *"The API is
stateless: responses and conversations are not stored on the server."* On a replay
expansion miss (proxy restart, unrecorded prior turn) we would forward
`previous_response_id` to an upstream that does not implement it.

The same reasoning covers the rest of the stateful family: `conversation`,
`background`, and `store: true`. `metadata` and `service_tier` are likewise absent
from the documented request schema.

## Design

Add a registry-declared capability rather than a provider-id check in the adapter, so
the knowledge lives where the other provider facts live and any future stateless
Responses provider inherits it.

```ts
  /**
   * Responses upstream that stores nothing server-side. Stateful request
   * parameters are dropped and `store` is pinned false.
   */
  statelessResponses?: boolean;
```

## Change map

### MODIFY `src/providers/registry.ts`

Add `statelessResponses?: boolean` to `ProviderRegistryEntry`, and on `deepseek`:

```ts
+    // "The API is stateless: responses and conversations are not stored on the
+    // server." https://api-docs.deepseek.com/api/create-response/
+    statelessResponses: true,
```

### MODIFY `src/types.ts`

Add the matching optional field to `OcxProviderConfig` beside `responsesPath`.

### MODIFY `src/providers/derive.ts`

Seed + backfill exactly as phase 1 does for `responsesPath`.

### `src/config.ts` — one schema line (revised after the second audit)

The first pass argued a boolean has no malformed form, so no schema entry was needed.
That was half right: `providerConfigSchema` is `.passthrough()` (`config.ts:448`), so
nothing breaks. But `responsesPath` carries a schema line (`config.ts:440`) IN
ADDITION to its custom validator, and that line declares the surface rather than
guarding a format. Without it, a user who writes `statelessResponses: "true"` sails
through the schema and the strict `=== true` check silently disables the feature —
fail-safe, but invisible.

```ts
+  statelessResponses: z.boolean().optional(),
```

One line turns a silent typo into an error.

### MODIFY `src/adapters/openai-responses.ts`

New helper, placed next to `stripPreviousResponseId`:

```ts
/**
 * Drop request parameters a stateless Responses upstream does not implement, and pin
 * `store` false so item-id scrubbing downstream behaves consistently.
 *
 * `previous_response_id` is handled separately because its normal strip is
 * conditional on replay expansion; here the field can never be honoured at all.
 */
function stripStatefulResponsesParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const drop = ["previous_response_id", "conversation", "background", "metadata", "prompt"] as const;
  const present = drop.some(k => Object.prototype.hasOwnProperty.call(body, k));
  if (!present && body.store === false) return body;
  const next: Record<string, unknown> = { ...body };
  for (const key of drop) delete next[key];
  next.store = false;
  return next;
}
```

`prompt` (`src/responses/schema.ts:156`) is a reference to a **server-stored prompt
template** — the most stateful field in the accepted schema, and one a stateless
upstream cannot resolve by construction. Added on the second audit's finding.

The helper returns a COPY (`{ ...body }`), so `parsed._rawBody` keeps the client's
original `store` value and `rememberResponseState` still records the turn. That is
load-bearing for the multi-turn continuity argument below, so it must not become an
in-place mutation.

### Ordering constraint

The strip must run BEFORE the composed sanitize chain (`openai-responses.ts:982`),
because `stripItemIdsWhenUnstored` inside that chain keys off `store === false`. Its
position after `stripPreviousResponseId` is readability only. A refactor that hoists
it past the chain would silently break the premise, so the code carries a comment
saying so.

### `service_tier` is deliberately NOT dropped (audit blocker 3)

DSCodex drops it, and the DeepSeek request schema does not list it. But `core.ts:758`
writes `service_tier` for EVERY `openai-responses` route when `config.fastMode` is
set. Silently deleting a configured knob inside an adapter — with no diagnostic — is
worse than forwarding a parameter the upstream ignores: the research doc records that
DeepSeek ignores unrecognised tool types and input items rather than erroring, and
nothing in the reference page says an unknown top-level key is fatal.

Dropping it would also make the adapter quietly override a server-level decision,
which is the kind of action-at-a-distance that is hard to debug later. If DeepSeek
turns out to reject it, that is a one-line addition to `drop` with real evidence
behind it. Leaving it in is the reversible choice.

The second audit sharpened this: the real defect is at `core.ts:773`, where an
OpenAI-specific commercial knob is applied by WIRE SHAPE
(`adapter === "openai-responses"`) rather than by provider capability — and phase 2
widened that set to include DeepSeek. The correct eventual fix narrows the write
site, not the adapter. Recorded as a known follow-up rather than fixed here, which
would expand this phase's scope.

Honest gap: whether DeepSeek actually rejects an unknown `service_tier` is
**UNVERIFIED**. No API key is available, so no authenticated probe is possible, and
the reference page neither lists the field nor states that unknown top-level keys are
fatal.

Wire it in `buildRequest` immediately after the existing `stripPreviousResponseId`
call, before the forward-only branch:

```ts
       let outBody = stripPreviousResponseId(...);
+      if (provider.statelessResponses === true) outBody = stripStatefulResponsesParams(outBody);
```

Placing it here means `stripItemIdsWhenUnstored` (which keys off `store === false`)
then runs with the correct premise — a small consistency win beyond the primary fix.

### Orphan repair must extend to stateless providers (second audit, HIGH)

Dropping `previous_response_id` is only half the story on a replay MISS (proxy
restart, evicted entry). The delta input can begin with a `function_call_output`
whose paired `function_call` lived in the prefix that was never expanded. Today
`repairOrphanedInputItems` runs only under `if (forward)`
(`openai-responses.ts:967`), and DeepSeek is key-auth — so we would hand the upstream
an orphaned tool result and get a 400 or a silently context-free answer.

A criterion that says "no stateful parameter reaches a stateless upstream" is worth
little if the resulting body is unparseable, so the repair is in scope for this phase:

```ts
-      if (forward) {
+      const stateless = provider.statelessResponses === true;
+      if (forward || stateless) {
         outBody = repairOrphanedInputItems(outBody, unexpandedMiss);
+      }
+      if (forward) {
         outBody = stripUnsupportedForwardParams(outBody);
       }
```

`repairOrphanedInputItems` returns the original reference when pairs are intact, so
the cost on the normal path is zero. The existing warn at `core.ts:1445` already fires
for this provider, so the diagnostic was there while the repair was not.

## Accept criteria

- Built body for a stateless provider contains none of the four dropped keys and
  carries `store: false`.
- A non-stateless Responses provider is byte-identical to before.
- `service_tier` SURVIVES the strip (regression guard for the decision above).
- `prompt` is dropped (server-stored template reference).
- On a replay MISS, an orphaned `function_call_output` is repaired for a stateless
  provider rather than forwarded — the body must be parseable, not merely free of
  stateful parameters.
- A registry entry that does not declare the field does not acquire it from the seed
  (negative control mirroring `tests/provider-model-discovery-contract.test.ts:175`),
  so a future blanket seed cannot leak the capability provider-wide.

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The branch is triggered by building a request against the deepseek config with a body
that deliberately carries `previous_response_id` and `metadata`; the observable effect
is their absence from `JSON.parse(built.body)` plus `store === false`. The negative
control builds the same body against a provider without the flag and asserts the keys
survive, proving the strip is capability-gated rather than unconditional.
