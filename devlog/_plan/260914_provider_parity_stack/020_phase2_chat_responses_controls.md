# Phase 2 — Chat to Responses control fidelity

Branch `agent/provider-parity-02-controls`, base `agent/provider-parity-01-ingress`.
Findings F2 and F6.

Thesis: a Chat request translated into the Responses pipeline should keep the
controls the caller actually sent, and the restrictions that exist for the
canonical ChatGPT backend should apply to that backend rather than to every
provider sharing its adapter string.

## Scope

IN: the `openai-responses` control strip, and the inbound projection of assistant
reasoning text and sampling penalties.

OUT: `stop` support claims, opaque reasoning-signature replay, `#4528`'s subject,
Azure (`azure-openai` is a different adapter and never matched this condition).

## File change map

| File | Action |
|---|---|
| `src/server/chat-completions.ts` | MODIFY — scope the strip |
| `src/chat/inbound.ts` | MODIFY — carry reasoning text and penalties |
| `tests/server/chat-responses-control-scope.test.ts` | NEW |
| `tests/server/chat-inbound-reasoning-replay.test.ts` | NEW |
| `scripts/test-layout/layout.json` | MODIFY |
| `tests/fixtures/test-layout-expected.json` | MODIFY |
| `structure/data-planes/inbound-compat.md` | MODIFY |
| `structure/providers/chat-compat.md` | MODIFY |

## MODIFY `src/server/chat-completions.ts` — F2

Before, at `:221-231`:

```ts
  if (settledRoute?.provider.adapter === "openai-responses") {
    // ChatGPT backend rejects store:true and unsupported sampling knobs.
    internalBody.store = false;
    delete internalBody.max_output_tokens;
    delete internalBody.temperature;
    delete internalBody.top_p;
    delete internalBody.stop;
    delete internalBody.user;
  } else if (internalBody.store === undefined) {
    internalBody.store = false;
  }
```

After:

```ts
  if (settledRoute?.provider.adapter === "openai-responses") {
    // store:false is correct for every Responses route here — the proxy never wants
    // upstream-side retention for a translated Chat turn.
    internalBody.store = false;
    // The sampling and output-cap restrictions belong to the canonical ChatGPT
    // backend, which rejects them. Seven providers share this adapter string
    // (openai, openai-apikey, meta-model, meta-muse, zai, zhipu-bigmodel-responses,
    // volcengine-agent-plan); a generic API-key Responses endpoint accepts the
    // caller's controls, so stripping them there silently discards caller intent.
    if (isCanonicalOpenAiForwardProvider(settledRoute.provider)) {
      delete internalBody.max_output_tokens;
      delete internalBody.temperature;
      delete internalBody.top_p;
      delete internalBody.stop;
      delete internalBody.user;
    }
  } else if (internalBody.store === undefined) {
    internalBody.store = false;
  }
```

`isCanonicalOpenAiForwardProvider` is already imported in this file and already
used at `:247` for exactly this "is this really the ChatGPT backend" question, so
the scope test reuses the module's existing authority rather than inventing a
second provider classification.

The forward restrictions themselves are not relaxed. `store` stays pinned false on
every Responses route. `stop` is preserved for non-canonical providers because the
caller sent it, which is not a claim that every provider on this adapter supports
it — an upstream that rejects it still rejects it, and that is a truthful upstream
error rather than a silent proxy-side drop.

Two neighbouring paths are checked, not assumed:

- the synthetic effort-row override (`:127-129`) rewrites `chatBody.model` before
  routing, so `settledRoute` is the post-override route and the condition reads the
  settled provider
- a combo or policy route sets `routeMayChangeCredentialDomain` (`:161`) and its
  concrete child is selected later in the Responses pipeline; the strip here applies
  to the settled parent, which is the same object the existing code read

## MODIFY `src/chat/inbound.ts` — F6 reasoning

`assistantContentToBlocks` (`:121-137`) gains a reasoning branch. The inbound
direction becomes the inverse of the outbound reconstruction that
`src/adapters/openai-chat.ts:800-843` already performs.

```ts
// Assistant turns replayed by a Chat client carry the model's prior thinking as
// reasoning_content (string) or reasoning_details (array of segments). Both are
// plaintext this proxy can represent; keeping them lets an interleaved-thinking
// provider see its own prior reasoning instead of a bare continuation.
function assistantReasoningText(msg: Rec): string | undefined
```

Accepted shapes, both already produced by the outbound path:

- `reasoning_content: string`
- `reasoning_details: [{ type: "reasoning.text", text: string }, ...]` — the
  `text` fields are joined in order

The extracted text becomes a `{type:"reasoning", content:[{type:"reasoning_text",
text}]}` input item, which `reasoningItemSchema`
(`src/responses/schema.ts:56-60`) already accepts, emitted immediately before the
assistant message it belongs to so ordering is preserved.

What is deliberately not done: no `signature`, no `encrypted_content`, no item id
is synthesized. A signature is a provider-issued attestation over content this
proxy did not receive, and fabricating one would either be rejected upstream or, worse,
accepted as a false claim of provenance. Cross-provider opaque metadata is likewise
not copied. Opaque reasoning replay across a Chat boundary needs its own design and
is recorded as residual in `050_residuals.md`.

## MODIFY `src/chat/inbound.ts` — F6 penalties

The body builder (`:337-362`) gains two lines beside the existing `temperature`
and `top_p` handling:

```ts
  if (typeof raw.presence_penalty === "number") body.presence_penalty = raw.presence_penalty;
  if (typeof raw.frequency_penalty === "number") body.frequency_penalty = raw.frequency_penalty;
```

The rest of the chain exists already and is the reason this is a two-line fix
rather than a feature: `src/responses/schema.ts:162-163` accepts both,
`src/responses/parser.ts:544-545` parses them into
`options.presencePenalty`/`frequencyPenalty`, and
`src/adapters/openai-chat.ts:1600-1603` writes them back to the Chat wire. Only
the first link was missing.

Provider opt-outs stay authoritative: `noPenaltyModels`
(`src/adapters/openai-chat.ts:147-150`) still deletes both for models that reject
them.

## Acceptance criteria

| # | Scenario | Observable effect |
|---|---|---|
| 1 | Chat request to a non-canonical `openai-responses` provider with `max_tokens`, `temperature`, `top_p` | all three survive into `internalBody` |
| 2 | same request to the canonical ChatGPT backend | all three are stripped, as today |
| 3 | both cases | `store === false` |
| 4 | non-canonical provider with `stop` and `user` | both survive |
| 5 | request carrying a synthetic effort-row model id | scope decision reads the settled post-override route |
| 6 | assistant turn with `reasoning_content` | a `reasoning` input item precedes the assistant message, carrying the text |
| 7 | assistant turn with `reasoning_details` segments | segments joined in order into one item |
| 8 | either case | no `signature`, no `encrypted_content` field is produced |
| 9 | assistant turn with no reasoning | input item list is byte-identical to today |
| 10 | `presence_penalty`/`frequency_penalty` sent over Chat | both reach `options` and the outbound wire |
| 11 | the same against a `noPenaltyModels` model | both are dropped at the adapter, as today |

Rows 1, 4, 6, 7 and 10 are the red-first regressions.

## Bypass record

Tier E7. Executing surface: the two new test files plus `bun run typecheck`.
Known bypass: a provider that shares the `openai-responses` adapter string and
genuinely rejects sampling controls would now receive them and return an upstream
error. Residual risk: accepted and stated — an honest upstream 400 is preferable to
a silent proxy-side drop, and the canonical backend keeps its strip. No wording was
downgraded; this is a scope correction, not a capability claim.
