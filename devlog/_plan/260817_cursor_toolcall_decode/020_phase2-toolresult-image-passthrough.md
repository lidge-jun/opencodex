# 020 — Phase 2: tool-result image passthrough

Answers **F2** (`002`). Severity High. One PABCD cycle.
**Revised twice after adversarial audits** (round 1 findings 7-8, round 2
findings 2 and 4).

## Problem restated

`contentToText` (`protobuf-request.ts:328`) replaces every image part of a tool
result with `[image input unsupported by Cursor adapter phase 3: ...]`, and
`toolResultPart` (`:384`) always emits a single `text` item — although
`McpToolResultContentItem` has an `image` case (`gen/agent_pb.ts:8476`) carrying
`data: Uint8Array` and `mimeType`.

## The source format is a URL, not base64 (round 1, finding 7)

`OcxImageContent` carries a single `imageUrl` that is either a `data:` URL or a
remote `https` URL (`types.ts:156`). The MCP helper in `native-exec-mcp.ts:115`
takes bare base64 plus a separate mime and is the wrong contract here.

## Do not tighten the shared parser (round 2, finding 4)

`src/adapters/image.ts:8` already provides `parseDataUrl`, **shared by the
Anthropic, Google, and Command Code adapters**. Tightening its return contract to
get strict validation would silently change those adapters while this phase's
tests only cover Cursor.

Therefore: add a **new strict helper built on top of `parseDataUrl`**, local to
this concern. It calls the shared parser, then validates the base64 charset and
decoded length itself — `Buffer.from(x, "base64")` accepts many invalid strings
without throwing. The shared parser is not modified.

Remote `https` URLs stay **out of scope**: `McpImageContent` needs bytes, and
fetching inside request construction would add network IO to a pure encoding
path. They keep a placeholder that says so.

## Bounding must be serialization-aware (round 1 finding 8, round 2 finding 2)

Round 1 established that a per-image cap is insufficient, because
`protobuf-request.ts:362` serializes an entire `ConversationStep` — text, every
image, and the envelope — into **one** blob capped at
`BLOB_MAX_ENTRY_BYTES` (`native-exec.ts:89`).

Round 2 showed the conversation-level *decoded-byte* budget still does not fix
it: a step also carries existing arguments, text, mime strings, and protobuf
framing (`:354-381`). A previously valid near-limit text result plus an admitted
image can push a step over the entry limit and fail a request that used to work.
**A budget over decoded image bytes cannot bound a serialized protobuf step.**

The bound must therefore be checked **after serialization**, not predicted before
it:

- keep the newest-first conversation-level image budget as a cheap pre-filter,
  so old screenshots degrade before new ones and most steps never approach the
  limit;
- after building a step, measure its serialized size; if it exceeds the entry
  limit minus a headroom margin, degrade that step's images to placeholders
  (newest retained last) and re-serialize;
- a step that still does not fit after dropping every image is a pre-existing
  text-only condition and is left to the existing admission path — this phase must
  not change behavior for requests that carry no images.

**The limit must come from the admission authority, not a copy.**
`BLOB_MAX_ENTRY_BYTES` is private and test-overridable (`native-exec.ts:91`, `:122-126`).
Hardcoding 16 MiB here would drift from admission the moment either side changes,
and would let test 7 pass against a number the real store no longer uses. Export
the effective limit (or a shared admission-threshold accessor) and pass it in, so
the degrade loop and the admission check always agree — including when a test
overrides it.

That last clause is the real acceptance boundary: **no request that works today
may start failing because of this phase.**

## The three result paths

Native-with-matching-call (lines 493-496) gains real image content. The external
replay path (481-490) and the unmatched-native path (498-503) keep a placeholder,
reworded to state that an image was produced and omitted.

## On the `wip/cursor-tool-result-text` draft

Reject for this phase. It compacts the *placeholder* rather than sending the
image, and its text compaction is a hardcoded regex over accessibility output
that discards real content on a guess. If AX volume still hurts afterwards, it
earns its own unit with measurements.

## Diff-level plan

**new strict decode helper** (beside `protobuf-request.ts`, or in the cursor
adapter directory)

- `decodeInlineImage(imageUrl): { bytes: Uint8Array; mimeType: string } | undefined`,
  implemented over `parseDataUrl` with explicit charset/length validation.
  Returns `undefined` for remote URLs and malformed payloads; never throws.

**`src/adapters/cursor/protobuf-request.ts`**

- `toolResultContentItems(message, budget)` -> `McpToolResultContentItem[]`:
  parts in order; text -> `McpTextContent`; image -> `McpImageContent` when it
  decodes and fits; otherwise a placeholder text item naming why.
- `toolResultPart` takes the budget and uses that array.
- `conversationTurns` owns the budget, allocates newest-first, and performs the
  post-serialization size check and degrade-and-retry described above.

## Tests (`tests/cursor-tool-result-image.test.ts`)

1. One text + one `data:` image part -> two items in order, the second case
   `image` with exact decoded bytes and the mime from the URL.
2. String-content result -> exactly one text item (regression).
3. Remote `https` image URL -> placeholder, no bytes.
4. Malformed base64 -> placeholder, no throw.
5. Images across several results are admitted newest-first until the budget is
   exhausted; older ones become placeholders.
6. A single oversized image is rejected by the per-image ceiling.
7. **Near-limit text plus an image**: the step is degraded to fit and the request
   still succeeds — the regression guard for round 2 finding 2.
8. A request carrying **no** images serializes byte-identically to the pre-change
   behavior. Requires determinism: `crypto.randomUUID()` is called during
   request construction (`protobuf-request.ts:509`, `:592`), so either
   freeze it or compare deterministic nested step bytes against a pre-change fixture.
9. The external replay path emits no image bytes and keeps its text budget.

## Done when

All nine pass, typecheck clean, cursor suite green on `ssh lidge`, pushed.

## POST-SHIP CORRECTION (audit r1, 2026-08-18)

This phase shipped the ENCODER, and the encoder is correct. It does **not** deliver
the end-to-end capability, and the earlier wording in `000_index.md` overstated it.

Every Cursor model is listed in `noVisionModels`
(`src/providers/registry.ts:978-982`), so before the adapter ever runs, the vision
sidecar replaces image parts with text descriptions — or strips them fail-closed
when no sidecar plan exists (`src/server/responses/core.ts:2225-2243`). That
preprocessing explicitly covers `toolResult` messages
(`src/vision/index.ts:252-259`, replacement at `:565-581`).

`tests/cursor-tool-result-image.test.ts` calls `encodeCursorRunRequest` directly
with hand-built `rawMessages`, so it proves encoder support and nothing about the
production path.

The registry comment claiming "Cursor's wire protocol never forwards image parts"
is now half-stale: still true for USER images (`request-builder.ts:206-214`
flattens them), no longer true for tool results.

Closing this gap is its own unit, not a wording fix: dropping Cursor from
`noVisionModels` alone would leave user images with neither an image nor a
description. It needs role-aware vision policy plus an end-to-end regression
through the server path. Tracked as follow-up 1 in
`devlog/_plan/260818_cursor_call_integration/000_plan.md`.
