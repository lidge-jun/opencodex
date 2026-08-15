# 050 — Gemini thought signature survives the Responses round trip (#1735)

## Problem

Gemini issues a `thoughtSignature` on the exact part that carries a function call, and the next
request is only valid when that signature returns on the part rebuilt from that same call.

Today the signature is observed on the response and then lost: the adapter event carries only
`id`/`name`, the Responses `function_call` item has nowhere to put it, and the parser rebuilds an
`OcxToolCall` without it. A same-process replay cache hides this for streaming turns, which is why
the bug reads as intermittent — history replay and `previous_response_id` have no cache to fall
back on.

PR #1772 repaired one web-search reconstruction. The roadmap's own instruction is that a
web-search-only patch is not acceptable, because every other tool loop rebuilds calls the same way.

## Approach

Carry the metadata with the individual tool call, at every hop it already travels:

1. `OcxProviderOpaqueToolCallMetadata` on `OcxToolCall` and on `tool_call_start`.
2. `src/responses/provider-opaque-metadata.ts` — the single seam that reads and writes the wire
   shape `extra_content.google.thought_signature`.
3. Google adapter attaches metadata from the originating part (streaming and buffered), and on
   the outbound side prefers it over the legacy field.
4. Responses schema models the bounded nested shape; parser reads it back.
5. Bridge emits it on the `function_call` item so a client can round-trip it.

Values are opaque: never parsed, merged, re-encoded, or synthesized. One upstream part maps to one
event, one Responses item, one internal call, one rebuilt part.

## Deliberately out of scope for this cycle

The audit also found two adjacent defects that are **not** #1735 and must not ride along:

- Google-issued `functionCall.id` is discarded and replaced with a synthetic `call_*`. The
  generated call/response ids still match each other, so pairing works; preserving Google's exact
  id is a separate contract change with its own blast radius.
- `src/web-search/loop.ts` interleaves parallel calls as `FC1, FR1, FC2, FR2` where Google requires
  `FC1, FC2, FR1, FR2`. That is a message-ordering fix in the sidecar loop, independent of whether
  a signature is carried.

Both are recorded here so the next cycle can pick them up deliberately rather than by accident.

## Acceptance

A signature observed on a Google function-call part is present on the Responses `function_call`
item, survives parsing back into the tool call, and is re-attached to the rebuilt part — with no
dependency on the replay cache. Legacy callers that still set `thoughtSignature` keep working.
