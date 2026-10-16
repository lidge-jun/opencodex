# Architect consultation — proposals and dispositions

Read-only architect dispatched during P with `cxc-dev` and `dev-architecture`
attached. Its decision IDs are D1-D8. Every claim below was re-verified against the
source in this worktree before being folded in; the verification command and the
confirming line are recorded with each one.

| ID | Proposal | Disposition |
|---|---|---|
| D1 | `src/chat/image-parts.ts` is the right seam | ACCEPTED as planned |
| D2 | Placement is correct; two amendments needed | ACCEPTED with amendments |
| D3 | Predicate correct; `stop` is inert, and the combo guard should be mirrored | ACCEPTED, plan corrected |
| D4 | Item shape correct; the "no signature" claim is false | ACCEPTED, claim rewritten |
| D5 | Field choice correct; the image-model exclusion is a plan error | ACCEPTED, condition replaced |
| D6 | Implicit-auto synthesis is safe | ACCEPTED, no change |
| D7 | Right layer; two ordering hazards and one wrong acceptance row | ACCEPTED, rows corrected |
| D8 | Layer 3 is not actually dependent on layers 1-2 | ACCEPTED, topology claim corrected |

## D2 — amendments folded

Verified readers of `chatBody.messages` after the normalization site: `evidenceFromBody`
(`src/server/chat-completions.ts:147`), the Cursor/Kiro token estimate (`:164`),
`isNativeChatRouteEligible` (`:170`), the native passthrough
(`src/adapters/openai-chat.ts:129`), and the Responses projection (`:196`). All
should see the normalized form.

Policy routing is unaffected either way: `inputContainsImage` is already shape-wide
and reads `record.messages` (`src/routing/request-evidence.ts:40`), so it matched
Pi-shaped parts before this change. The plan now says so instead of leaving it open.

Two real consequences are now acceptance rows rather than assumptions:

- The Cursor/Kiro token estimate shifts, because a Pi part re-serialized as a data
  URI gains the `data:<mime>;base64,` prefix and loses the `mimeType` key.
- `normalizeChatImageParts` copies each matched base64 payload once, and that
  allocation is not metered by `translatorBudget` (which meters only the body read
  at `:112`). On the translated path the identical copy already happens inside
  `imageUrlFromPart`, so this is new peak memory on the **native** path only. The
  plan states the bound rather than silently adding unmetered allocation.

## D3 — `stop` evidence replaces a speculative risk

The plan originally justified keeping `stop` as "an honest upstream error is better
than a silent drop". That was weaker than the truth. `rg stop
src/adapters/openai-responses.ts` returns no match: the adapter never writes `stop`
to any wire, so retaining it in `internalBody` cannot reach an upstream at all and
cannot cause a 400 on this adapter.

The new site also mirrors the `!settledRoute.combo` guard already used with this
same predicate at `src/server/chat-completions.ts:245`, so an unresolved combo
parent is never classified as the canonical backend.

## D4 — the signature claim was wrong and is corrected

Verified at `src/responses/parser.ts:304`:

```ts
signature: envelope?.sig ?? JSON.stringify(reasoning),
```

A reasoning item with no signed envelope therefore *does* receive a fabricated
signature inside the IR. The plan's "no signature is produced" was false.

It never reaches Anthropic, but only because
`isLikelyRealAnthropicThinkingSignature` (`src/adapters/anthropic.ts:247-251`)
requires `/^[A-Za-z0-9+/_=-]+$/`, which a string starting with `{` fails. That is a
charset regex standing in for a design guarantee.

Corrected claim: **no signature is forwarded**. Layer 2 adds a regression asserting
that filter holds for a synthesized item, so the guarantee stops being incidental.

## D5 — the image-model exclusion would have reintroduced F3

The plan copied `!isImageCapableModel(parsed.modelId)` from the `thinkingConfig`
gate. That exclusion exists there for a specific reason — the `responseModalities`
fallback is gated on `!generationConfig.thinkingConfig`
(`src/adapters/google.ts:845-847`) — and `responseMimeType`/`responseJsonSchema`
do not touch that gate.

As written it would have silently dropped a caller's schema for an image-capable
model: unconstrained prose returned as success, which is exactly the defect F3
fixes. Copying a condition without its reason is the failure here.

Replacement: an image-capable model asked for structured output gets an explicit
error, not a silent drop. Requesting JSON-constrained text from a model configured
to return `["TEXT","IMAGE"]` is a contradiction the caller should see. The phrasing
follows the established surface at `src/adapters/kiro/conversation.ts:33`.

## D7 — ordering hazards

Image order is current-then-history, because `imageBlocks` is filled from the
current message before the history loop runs
(`src/adapters/coding-agent/protocol.ts:412`, `:424`, `:443-451`), and
`historyMessages = nonDev.slice(0, -1)` (`:408`) confirms there is no double
counting. Acceptance row 3 claimed "in message order", which is not achievable
without reordering an array that governs existing user-image behavior. The row is
corrected to describe real behavior; reordering is out of scope for this layer.

Kiro: the marker must be appended before `rawGroupText` is computed
(`src/adapters/kiro/payload.ts:292-293`), because adjacency grouping rebuilds the
turn's content from `texts` and would otherwise discard it. No credential risk —
the marker carries no URL — and the base64 budget counts `KiroImage[]`, not text.

F9: the image-bearing branch was correct, but a **video-only** user message still
vanishes at `src/adapters/openai-chat.ts:786-787`, where `[undefined].join("")`
yields `""`. Layer 4 now fixes both branches rather than shipping the asymmetry.

## D8 — the topology claim is corrected

The architect is right that layer 3 is not source-dependent on layers 1-2: F3 and F4
read `options.textFormat` and `options.parallelToolCalls`, which layers 1-2 never
touch. The original wording ("consumes the IR that layers 1 and 2 made faithful")
was narrative, not a dependency.

The stack is kept, for a stated and checkable reason rather than an implied one:

- real source dependency: layers 1 and 2 share `src/server/chat-completions.ts` and
  `src/chat/inbound.ts`
- registration serialization: `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json` are edited by all four layers, and
  `structure/providers/chat-compat.md` by layers 2-4; parallel PRs would conflict
  on every one of them

Layer 3's PR says plainly that it is independent at source level and stacked for
serialization. Also corrected: `000_plan.md` claimed layer 1 touches
`src/adapters/openai-chat.ts`, which its own file map contradicts — that file
belongs to layer 4 only.
