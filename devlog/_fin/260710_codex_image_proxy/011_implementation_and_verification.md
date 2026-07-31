# WP1 implementation and verification — standalone Images data plane

Date: 2026-07-10
Status: C passed

## Implemented change

- Added `src/server/images.ts` as the focused owner for exact standalone Images forwarding.
- Added exact `POST /v1/images/generations` and `POST /v1/images/edits` branches in `src/server/index.ts` before the generic `/v1/*` guard.
- Preserved the existing gate order: draining, data-plane API auth, origin policy, then handler.
- Selected only enabled `openai-responses` providers using `authMode: "forward"`, in deterministic default/`openai`/`chatgpt`/config order.
- Reused Codex thread affinity and pool credentials; selected runtime pool auth wins over static and inbound auth fields.
- Kept the request opaque, rejected non-identity content encodings, and bounded actual streamed bytes at 256 MiB before retaining the overflow chunk.
- Made one upstream fetch attempt only. No reset retry is used for paid non-idempotent Images POSTs.
- Relayed upstream status/body and sanitized headers, linked request cancellation before headers, canceled the upstream body after headers, and registered the stream with graceful-shutdown tracking.
- Recorded 429/5xx/connect outcomes only for pool/main-pool contexts.
- Added integration and safety suites, retained JSON 404 behavior for unknown Images subpaths, and updated all three README locales plus both structure SOTs.

## RED evidence

Before product code, the generation regression was added and run:

```text
bun test tests/images-proxy.test.ts
Expected: 200
Received: 404
0 pass, 1 fail
```

This reproduced the original generic-guard failure rather than a mock-only unit condition.

## Build repair found by activation

The actual-stream overflow test first exposed an ordering defect: the collector released its reader
lock before asynchronous cancel propagation could settle. The implementation now schedules lock
release after cancel resolves/rejects while returning 413 without waiting. A stream kept open after
the overflow chunk proves that its underlying cancel hook fires.

## Automated C evidence

Focused affected suites:

```text
bun test tests/images-proxy.test.ts tests/images-proxy-safety.test.ts \
  tests/server-auth.test.ts tests/codex-auth-context.test.ts \
  tests/upstream-retry.test.ts tests/passthrough-headers.test.ts
80 pass, 0 fail, 289 expect() calls
```

Full repository and static gates:

```text
bun test ./tests/
1942 pass, 0 fail, 8285 expect() calls across 194 files

bun run privacy:scan
Privacy scan passed

bun run typecheck
exit 0

git diff --check
exit 0
```

An independent `gpt-5.6-sol` medium implementation review returned `PASS` with
`blocking_issues: none` after checking credential classes, body bounds, header selection,
single-attempt behavior, cancellation/lifecycle, health isolation, docs, and tests.

## Manual HTTP QA

Evidence root:

`.codexclaw/evidence/019f4a8d-53c2-7de1-b812-beed6d130796/qa/http-images/`

A patched-source opencodex server and mock forward provider were driven with `curl -i`:

- generation returned 200 and proved `/backend-api/codex/images/generations`, auth, account, and `version`;
- edit returned 200 and proved `/backend-api/codex/images/edits`;
- anonymous/wrong-key requests returned 401, hostile origins 403, valid preflight 204, and GET/unknown subpaths JSON 404;
- empty/malformed bodies relayed upstream 400 envelopes, wrong content type relayed 415, and non-identity encoding returned local 415;
- a real chunked 268,435,457-byte request returned a parseable 413 at the 268,435,456-byte ceiling;
- two explicit identical POSTs produced upstream call numbers 4 and 5, confirming each invocation is independent and no hidden automatic retry occurs;
- content negotiation stayed a sane JSON default.

Teardown evidence records both listener ports empty, the harness PID absent, and its temporary root removed.

## Scope and deployment note

No files in `codex-rs` or `ima2-gen` changed. Existing unrelated worktree changes were preserved.
No package was published and the installed proxy already serving port 10100 was not replaced during
this task, because interrupting the active provider could sever the current Codex session. The
patched source behavior itself was exercised over the real HTTP surface; activation of an installed
older daemon is a separate restart/update operation.
