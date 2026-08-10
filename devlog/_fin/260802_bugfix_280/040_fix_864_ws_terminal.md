# 040 — Fix #864: Windows turn never completes (terminal SSE lost)

Root cause (investigator Carver, highest confidence): v2.7.43's image_gen
API-key normalization creates a non-empty alias map
(src/server/responses-image-gen-repair.ts:22), so `needsClientRewrite`
becomes true for Desktop-shaped requests. That routes Windows traffic off
the native relay onto the tee() -> relaySseWithPayloadRewrite ->
relaySseWithFailedTail chain — the chain the code itself marks unsafe on
Windows (Bun#32111). Symptoms match exactly: text frames pass, the
terminal block never reaches the client, HTTP and WS both affected, plain
curl unaffected (no additional_tools.image_gen). Whether the initial #588
wrapper or the #602 single-pass refactor (sse-payload-rewrite.ts:68) holds
the precise stall needs a Windows frame capture; the fix covers both.

## Fix

Keep Windows off the pull-based wrapper while preserving image-tool
restoration:

- Extend the existing eager single-reader relay to apply the payload
  rewrite inline; use it for `win32 && needsClientRewrite`.
- Never select `tee() -> relaySseWithPayloadRewrite ->
  relaySseWithFailedTail()` on Windows.
- Preserve inverse `image_gen__x -> {namespace:"image_gen", name:"x"}`
  mapping for real tool-call events.

## Tests

- tests/passthrough-abort.test.ts: strengthen the Windows transport guard
  so `needsClientRewrite` cannot select the pull-wrapper chain (selection-
  logic level — runs anywhere).
- tests/responses-image-gen-repair.test.ts: Desktop-shaped HTTP request
  with additional_tools.image_gen; deltas + terminal reach EOF; tool-call
  namespace restored.
- tests/server-auth.test.ts: websocket variant asserting exactly one
  response.completed.
- Note: full runtime red/green proof needs real Windows Bun 1.3.14
  (macOS cannot reproduce Bun#32111); CI Windows leg carries that proof
  after push.

## Results (2026-08-02, wp5 executed on branch codex/bugfix-280)

- f5e66fba red regression (rewrite framing + transport invariant, red with
  fix stashed).
- 9d271d09 fix: relaySseEagerBounded gains rewritePayload (complete-block
  framing, budgeted buffer, EOF tail); core routes win32 && needsClientRewrite
  through it, never the tee()+JS-pull chain.
- 8b6f1613 repair round 1 (Chandrasekhar FAIL): unchanged blocks pass
  byte-identical (multi-data CRLF), decoder flush ordered after buffer,
  rewrite applied to EOF tail, budget released on all teardown paths,
  isWin32EagerRewrite extracted with policy tests.
- bf2afc0e repair round 2: decoder-tail regression exercises the real flush.
- Final review: PASS. relay-eager + caps + passthrough-abort + image-gen +
  sse-rewrite + ws + server-auth suites green; typecheck green.
- Honest caveat: the Windows runtime proof (Bun#32111 stall itself) defers
  to the CI Windows leg after push — recorded per plan.
