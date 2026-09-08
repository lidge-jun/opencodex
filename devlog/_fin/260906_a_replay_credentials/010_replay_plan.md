# Replay fixture diff plan

MODIFY tests/server/server-agent-task-recovery-replay.test.ts only:

1. In the two original real-handler tests (cached NEW_TASK continuation and MESSAGE replay), capture one headers object before the first post and reuse it for the second. Keep status200, one recovery, two provider bodies, plaintext-present and ciphertext-absent assertions.
2. Scope a Date.now spy to each test at a real current second plus995ms. Advance controlled time by10ms between posts. Assert a newly constructed unused credential differs across that boundary, while the actual conversation continues with its original headers. Restore the clock in finally. No sleep or timeout increase.
3. Add a changed-token isolation control using the existing fakeChatGptJwt claim override: same account/envelope and two valid tokens differing in exp must not share cached plaintext. Reusing the original request still restores. Assert no extra network recovery and unchanged encrypted input on the miss.
4. Main performs exact-head remote isolated replay/cache/security tests and typecheck. A scratch red control restores per-post codexHeaders() calls while keeping the forced boundary; both conversations must lose the expected plaintext. The changed-token negative remains a pass. Restore candidate bytes after the probe.
5. Independent review checks fixture identity, clock cleanup and unchanged production boundary. Publish the own affinity branch, cascade the capability child and obtain fresh CI after all recorded verification repairs. Original source author commits remain intact. No new production file or test-layout entry.
