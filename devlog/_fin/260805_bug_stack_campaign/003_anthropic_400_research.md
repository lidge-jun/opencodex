# 003 — Anthropic 400 on new-session spawn: research

## Symptom

2026-08-05 00:21-00:23 KST: three consecutive 400 `invalid_request_error`
responses against `anthropic/claude-opus-5` (effort high), all in conversation
`2c0f87c664e130b3927c4884fafd8283` (`ocx-mset3lcs-1i1`, `ocx-mset3rk6-1i6`,
`ocx-mset4i2p-1ik`), plus one in `7f8dbd4a06336b01da0d476fb65b38f2` at 00:23.
Same model+effort returned 200 for other conversations from 00:26 onward,
including 319K-620K-token inputs. Model alias failure, auth failure, and
context overflow are excluded.

Local evidence gap: `usage.jsonl` records only `Provider error 400` — the
upstream error body was not retained for these responses-inbound failures
(compare 2026-08-01 rows, which preserved the full Anthropic error JSON).

## Root cause — REFUTED hypothesis and what the live probes proved

The initial lane-C hypothesis (unsigned foreign tool_use + adaptive thinking →
400) is **refuted by two live probes** run through the local proxy against the
real Anthropic API on 2026-08-05 ~01:00 KST:

- Probe 1 (synthetic): inline `custom_tool_call` + `custom_tool_call_output`
  history, `anthropic/claude-opus-5`, effort high → **200** (134 tokens).
- Probe 2 (exact parent state): the full 923,656-byte item list of
  `resp_050cd54528dd6d7f…` (the last successful state at 00:21:12, 46s before
  the first failure) + a new user message, same model/effort → **200**
  (297,376 input tokens).

Anthropic's current extended-thinking contract matches probe 1: adaptive
thinking does not require a thinking preface on replayed tool-use turns.
The history shape is exonerated. (A-gate audit round 1, blocker 1.)

Transport-branch analysis (audit round 2, verified in code): the bare
`Provider error 400` does NOT come from the direct path — that path appends
`: <body>` even when the body is empty (`src/server/responses/core.ts:2822`,
trailing colon preserved). The exact bare shape is produced by the
**web-search bridge** (`src/web-search/loop.ts:460-484`): a body-read failure
returns status-only, and the formatted suffix requires
`prepared.responseAdapter.formatErrorBody`, **which the anthropic adapter
does not implement** — so on this path even a well-formed Anthropic JSON
error envelope is discarded and the client + ledger see only
`Provider error 400`. The images bridge has analogous status-only behavior.
Thread-spawn requests from the Codex app carry the `web_search` tool, and
routed (non-OpenAI) models dispatch through `runWithWebSearch`
(`src/server/responses/core.ts:2295-2310`), which returns before the normal
recovery loop.

Conclusion: the failing requests almost certainly went through the web-search
bridge, and the 400's own cause (validation vs edge) is **unknowable from
surviving evidence because the bridge discarded the upstream body**. The
diagnosability defect is precisely located; the underlying 400 is reproduced
only if it recurs after the observability fix. Anthropic's error contract
(every API error carries a JSON envelope) makes "proxy discarded the body"
the more probable reading than "empty-body edge rejection", though both
remain possible.

## Original research record (kept for provenance)

Each failure happened exactly when resuming the next turn after a
`custom_tool_call_output`. Reconstruction of the failing body from saved
Responses state + rollout items shows:

```json
{ "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" }, "max_tokens": 24576 }
```

with history containing assistant turns of shape `[text, tool_use]` with **no
thinking/redacted_thinking block**, followed by `user: [tool_result]`.

Mechanism (later refuted by probes 1-2 above):

1. `previous_response_id` expansion merges stored input regardless of which
   provider produced the earlier turns (`src/responses/state.ts:857-860`).
2. The Responses parser restores foreign `custom_tool_call` items as assistant
   tool calls but cannot fabricate a valid Anthropic-signed thinking block
   from OpenAI/Grok reasoning (`src/responses/parser.ts:510-517`, envelope
   handling at 439-475; unsigned fallbacks fail
   `isLikelyRealAnthropicThinkingSignature`, `src/adapters/anthropic.ts:240-244`).
3. The Anthropic adapter drops unsigned thinking parts
   (`isLikelyRealAnthropicThinkingSignature`, `src/adapters/anthropic.ts:601`)
   but still emits the `tool_use` blocks (`src/adapters/anthropic.ts:604-607`),
   then turns adaptive thinking on for the whole request
   (`src/adapters/anthropic.ts:834-835`).
4. Anthropic 400s: with thinking enabled, an assistant tool-use turn must be
   preceded by a thinking/redacted_thinking block.

Secondary hypothesis (prefixed model ID missing the adaptive gate on older
runtimes, fixed by `930efdf60`/`f728dc0fb`) does not fit: the running process
started 2026-08-04 22:45 KST from a checkout containing both fixes, and the
reconstructed body was already `adaptive`.

Latent-path activation: `787bd1541` exposed Opus 5 in the catalog
(`src/providers/registry.ts:240`); the regression is not the alias but the
first time an adaptive-thinking model replayed foreign tool history.

## "New session" interpretation

`conversationId` is a log-correlation hash, not a continuation key
(`src/server/request-log-conversation.ts:30-38,64-75`). History replay is decided by
`previous_response_id`. The failing "new prompt/spawn" inherited the parent's
Responses chain — the proxy must not clear state on thread-spawn headers
(that would break intentional context inheritance).

## Fix direction

Revised after the probes (see `020_phase2_anthropic_400_fix.md`):

1. Observability (phase 2): implement `formatErrorBody` on the anthropic
   adapter so the web-search/images bridges surface the upstream error
   message instead of discarding it; persisted `upstreamError` then flows
   through the existing capture (`src/server/relay.ts:429` →
   `src/server/request-log.ts:648`) with no production change there.
2. Resilience (deferred): any 400 retry decision waits until the observability
   fix distinguishes empty-body edge rejections from discarded JSON bodies in
   the wild. Premature retry design was audit-blocked twice and is dropped
   from phase 2.
3. NO history flattening (refuted hypothesis); no signature fabrication; no
   state clearing on thread spawn.
