# 080 — Fix F: G2/G4 instrumentation (codex/cursor-gap-6)

No deterministic local fix is provable yet: G2 (turn stall/degenerate
loop) needs an SSE trace of a stalling app session; G4 (" mar" token
splice) reproduced only under accumulated replay volume in a live
subagent. Honest scope: diagnostics capture, not a behavior fix.

## Diff plan

1. Provider diagnostics already expose continuationMode +
   checkpointInvalidationReason (protobuf-request.ts:933, cursor.ts:283)
   — surface them in the debug provider-diagnostic log line for every
   cursor turn (cheap, existing debug channel), so a stalling session's
   next report carries replay-state evidence.
2. ADD a bounded root-blob integrity check at assembly time: after
   building root blob candidates for external replay, verify the
   serialized text round-trips byte-identically (detect splice-class
   corruption at the source); on mismatch emit a debug diagnostic with
   offsets (no payload contents — privacy scan safe).
3. Document the capture procedure for the next stall occurrence
   (curl -N session mirror) in this doc.

## Accept criteria

## Implementation notes (wpF, 2026-08-26)

- Item 1 (diagnostics) was already satisfied by the baseline: the
  run-request diagnostic logs continuationMode +
  checkpointInvalidationReason + rootBlobs/rootBytes
  (protobuf-request.ts:934-949). No change needed.
- Item 2 landed as a serve-time digest check in native-exec.ts
  getBlobArgs: blobs are content-addressed (SHA-256 id), so a served
  payload whose digest mismatches its raw 32-byte id is in-store
  corruption — the splice signature. Emits
  `blob-integrity-mismatch` debug diagnostic (key prefix + byte length
  only; no payload).

## G2 stall capture procedure (next occurrence)

1. Reproduce with the SAME thread in the Codex app; note wall-clock time.
2. Mirror the request via curl (session log has the request id):
   `curl -N http://localhost:10100/v1/responses -H 'Content-Type: application/json' --data-binary @req.json | tee stall.sse`
3. Enable debug diagnostics (OCX debug env) and capture the
   run-request + checkpoint-continuation lines for the stalling turn.
4. Evidence to file here: last SSE event before silence, whether
   response.completed arrived, continuationMode of the turn, and any
   blob-integrity-mismatch lines.

- Diagnostic line appears for cursor turns under debug flag (test with
  debug seam).
- Integrity check triggers on an injected mutated blob (unit test with
  fault injection); silent on clean paths.
- privacy:scan stays green (no payload logging).
