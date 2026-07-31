# Done — remote compaction v2 for routed providers

## What shipped
- `src/responses/compaction.ts` (new): `ocx1:`+base64 transparent envelope
  (encode/decode), `COMPACT_PROMPT` + `SUMMARY_PREFIX` mirroring codex-rs
  templates/compact/*.md, `compactionItemToText` (opaque-blob degradation note).
- `src/responses/parser.ts`: `compaction_trigger` input item -> sets
  `parsed._compactionRequest` and is dropped; `compaction`/`compaction_summary`
  input items -> decoded to a SUMMARY_PREFIX user message (ocx1) or an opaque
  note (real OpenAI encryption).
- `src/types.ts`: `_compactionRequest?: boolean` on OcxParsedRequest.
- `src/server.ts`: routed (non-passthrough) compaction turns run BEFORE
  planWebSearch with tools/_webSearch/toolChoice/parallelToolCalls cleared and
  COMPACT_PROMPT appended as the final user message; `compaction: true` passed
  at all 4 bridge call sites.
- `src/bridge.ts`: `compaction` option on bridgeToResponsesSSE +
  buildResponseJSON. In compaction mode all adapter events except done/error are
  swallowed (text accumulates silently — replay dedup, since
  rememberResponseState stores input+output) and done emits EXACTLY ONE
  `{type:"compaction", encrypted_content:"ocx1:"+base64(text)}` output item
  before response.completed. Error path unchanged (response.failed, no item).
- `src/adapters/openai-responses.ts`: forward path scrubs ocx1 compaction items
  into plain user messages (ChatGPT backend cannot decrypt our envelope); real
  encrypted items forwarded untouched.
- `tests/responses-compaction.test.ts` (new): 15 tests — envelope round-trip,
  parser trigger/decode/opaque/alias, streaming single-item + error + no-flag
  regression, buildResponseJSON both paths, forward scrub both paths.

## Evidence (fresh, 2026-07-06)
- `bun test ./tests/`: 1532 pass, 0 fail, 159 files, exit 0.
- `bun x tsc --noEmit`: exit 0.
- Audit: gpt-5.5 reviewer (Banach) PASS-WITH-FIXES; all fixes adopted
  (pre-planWebSearch wiring, replay-duplication suppression, toolChoice/
  parallelToolCalls clearing for cursor).

## Residual risk
- The summary quality now depends on the routed model; Codex's own retained-
  message trimming (64k budget) still applies on its side.
- Codex UI shows no streaming text during a routed compaction turn (we swallow
  deltas); the native path behaves the same way (compaction is a background item).
- Real OpenAI-encrypted compaction items remain opaque to routed models (note
  only) — nothing decryptable proxy-side by design.
- WS bridge relays SSE frames as-is; no changes needed (reviewer-verified).
- The RUNNING ocx instance must be restarted to pick this up.

## Terminal outcome: DONE
