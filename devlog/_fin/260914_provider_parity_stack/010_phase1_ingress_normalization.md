# Phase 1 — inbound normalization and explicit reasoning disable

Branch `agent/provider-parity-01-ingress`, base `dev`. Findings F1 and F7.

Thesis: the Chat ingress must recognize the same image shapes the translated path
already understands, before it decides which pipeline the request enters, and it
must not discard an explicit request to disable reasoning.

## Scope

IN: inbound Chat image-part normalization, the native-route eligibility predicate
it feeds, and the reasoning-effort allowlist.

OUT: vision describer policy (`#4501`/PR `#4511`), any remote fetch of an image
reference, adapter-side image handling, reasoning replay.

## File change map

| File | Action |
|---|---|
| `src/chat/image-parts.ts` | NEW — shared recognizer and normalizer |
| `src/chat/inbound.ts` | MODIFY — consume the shared recognizer; allow `none` |
| `src/server/chat-completions.ts` | MODIFY — normalize before route selection |
| `src/server/chat-native.ts` | MODIFY — predicate reads the shared recognizer |
| `tests/server/chat-native-image-normalization.test.ts` | NEW |
| `tests/server/chat-inbound-reasoning-none.test.ts` | NEW |
| `scripts/test-layout/layout.json` | MODIFY — register both test files |
| `tests/fixtures/test-layout-expected.json` | MODIFY — register both test files |
| `structure/data-planes/inbound-compat.md` | MODIFY — record both behaviors |
| `docs-site/` | MODIFY — reasoning `none` is user-visible |

## NEW `src/chat/image-parts.ts`

Moves the existing recognizer out of `inbound.ts` unchanged in behavior, and adds
the normalizer the ingress needs. Keeping one implementation is the point of the
layer: the two call sites diverged precisely because the logic was duplicated.

```ts
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The image reference carried by a Chat content part, in URL or data-URI form.
 * Accepts OpenAI `image_url`, Pi/MCP `{type:"image", data, mimeType}`, and
 * Anthropic-shaped `{type:"image", source:{...}}`. Returns null for anything else.
 */
export function chatImageUrlFromPart(part: Rec): string | null

/** The `detail` hint, when the part carries a recognized one. */
export function chatImageDetailFromPart(part: Rec): "auto" | "low" | "high" | undefined

/** True when any messages[].content[] part carries a recognized image. */
export function chatBodyCarriesImage(rawBody: Rec): boolean

/**
 * Rewrite every recognized non-OpenAI image part into `image_url` form.
 * Returns the same object reference when nothing matched, so a body with no
 * image — and a body whose images are already `image_url` — is untouched.
 */
export function normalizeChatImageParts(rawBody: Rec): Rec
```

`chatImageUrlFromPart` is `imageUrlFromPart` from `src/chat/inbound.ts:48-79`
moved verbatim. `chatBodyCarriesImage` is `src/server/chat-native.ts:168-177`
widened to call it instead of testing `part.type === "image_url"`.

`normalizeChatImageParts` produces, for a matched part:

```ts
{ type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } }
```

Identity rules, all of which get a test:

- no image anywhere -> the same object reference is returned, nothing is copied
- every image already `image_url` -> the same object reference is returned
- a matched part is replaced; every sibling part, every other message field, and
  every top-level body field keep their exact value and order

The copy is structural and shallow per level: only the `messages` array, the
message objects that contain a matched part, and their `content` arrays are
rebuilt. This is what "preserve native Chat fields" requires — the native path is a
whitelist passthrough, so an incidental deep clone would be a behavior change.

## MODIFY `src/server/chat-completions.ts`

Before, at `:111-115`:

```ts
    const rawBody = await readChatBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
    assertChatCompletionsRoutingBody(rawBody);
    chatBody = rawBody;
```

After:

```ts
    const rawBody = await readChatBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
    assertChatCompletionsRoutingBody(rawBody);
    // Normalize before routing: isNativeChatRouteEligible below decides the pipeline
    // from the image parts it can see, and the native path forwards the body as-is.
    chatBody = normalizeChatImageParts(rawBody) as typeof rawBody;
```

This single site is why the layer is placed at the bottom of the stack. It runs
ahead of `routeModel` (`:145`) and ahead of `isNativeChatRouteEligible`
(`:169`), so both the diversion decision and the forwarded wire see the same parts.

## MODIFY `src/server/chat-native.ts`

Delete the local `chatBodyCarriesImage` (`:168-177`) and import the shared one.
`isNativeChatRouteEligible` at `:155` is otherwise unchanged.

## MODIFY `src/chat/inbound.ts` — F1 half

Delete `imageUrlFromPart` (`:48-79`); import `chatImageUrlFromPart` and use it in
`userContentToBlocks`. Behavior is identical, and the existing tests for the
translated path are the proof of that.

## MODIFY `src/chat/inbound.ts` — F7 half

Before, at `:28`:

```ts
const OUTPUT_CONFIG_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
```

After:

```ts
// "none" is the runtime's disable sentinel, not an unknown value: src/reasoning-effort.ts
// treats it as valid and maps it to "omit the reasoning parameter", and the Pi client
// export maps Pi's "off" level onto it. Dropping it here let a provider default
// re-enable thinking the caller explicitly turned off.
const OUTPUT_CONFIG_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
```

`reasoningConfigSchema.effort` is `z.string().optional()`
(`src/responses/schema.ts:136-139`), so the produced body still validates. The
downstream consumers already understand the sentinel:
`src/reasoning-effort.ts:196` omits the wire parameter for it, and
`src/adapters/anthropic.ts:964-966` sends `thinking:{type:"disabled"}`.

## Acceptance criteria

Each row names the activation scenario and the observable effect.

| # | Scenario | Observable effect |
|---|---|---|
| 1 | user message with a Pi `{type:"image", data, mimeType}` part, text-only routed model | request is diverted off the native path; `isNativeChatRouteEligible` returns false |
| 2 | same with an Anthropic `{type:"image", source:{type:"base64"}}` part | diverted |
| 3 | same with `source:{type:"url"}` | diverted; no fetch is attempted |
| 4 | tool message carrying a Pi image part | diverted |
| 5 | vision-capable routed model, Pi image part | stays native; forwarded body carries `image_url`, not the raw part |
| 6 | image-only content (no text part) | image survives normalization |
| 7 | body with no image | `normalizeChatImageParts` returns the identical object reference |
| 8 | body whose images are already `image_url` | identical object reference; `detail` preserved |
| 9 | `reasoning_effort:"none"` over Chat | projected body carries `reasoning.effort === "none"` |
| 10 | the same against an Anthropic-adapter route | wire body carries `thinking:{type:"disabled"}` |
| 11 | `reasoning:{effort:"none"}` nested form | same as 9 |

Rows 1-4 and 9-11 are the red-first regressions: they fail on `dev` today.

## Bypass record

Enforcement tier: E7, agent-followed plus test coverage. Executing surface: the
focused test files above and `bun run typecheck`. Known bypass: a future call site
that reads `messages` before `handleChatCompletionsWithBudget` normalizes, or a
third image shape neither recognizer knows. Residual risk: accepted — the shared
module makes the next shape a one-file change. Wording was not downgraded; this is
a normalization, and it is not claimed to be a schema guarantee.
