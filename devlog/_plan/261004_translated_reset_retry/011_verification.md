# Verification and source coverage

All useful behavior from public PR #6525 at `49c5c7012f1f27d781079231dde92562ced68594` is carried: initial/rebuilt generic pre-header replay, shared grant, default-off and self-contained restrictions, physical accounting, all ten original test cases, provider comments, eight translated/reference pages, and failover SoT. No source behavior is deliberately dropped or unresolved. Yuxin Qiao's public commit identity is retained in co-author trailers. Source closure remains a coordinator decision after replacement publication and verification.

The implementation adds 25 regression cases. Coverage includes complete-body loopback disconnects, previous-response expansion, post-header prelude/output failures, terminal replacement statuses, exhausted/spent grants, exact direct/rebuild ceilings, and prepaid compaction/Fast/OAuth accounting. It preserves compact-only one-send behavior. Combo admission retains its target-local initial allowance: `comboTargetSendBudget` reserves capacity for later declared targets and the child settles an already-booked send. The shared aggregate budget and replacement grant remain authoritative; this change does not redesign combo admission.

## Observed checks

- Original source test on unchanged dispatch: 6 passed, 4 failed. Failures: initial/rebuilt reset opt-in returned 429 instead of 200; repeated reset made one send instead of two; exhausted budget sent once instead of zero.
- `bun test tests/responses/responses-translated-reset.test.ts tests/responses/responses-send-budget-counts.test.ts`: 55 passed, zero failed (35 new-file cases, including all original ten; 20 existing count cases).
- `bun test tests/lib/upstream-retry.test.ts tests/codex-integration/reserve-dispatch.test.ts`: 90 passed, zero failed.
- Adjacent reset-replay, reasoning-downgrade, Fast-downgrade and ambiguous-resend-gate files: 37 passed during implementation. The combined intermediate run also exposed three combo regressions. Those were repaired, and all 20 existing count cases passed unchanged in the final 55-test run.
- `bun test tests/lab/core-lab-boundary.test.ts`: 25 passed, zero failed after implementation.
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts`: 27 passed, zero failed.
- Typecheck, privacy scan and diff whitespace check passed. Structure check passed after staging the new test, as required by its Git-index path authority.
- Docs frozen install/build passed: 561 pages and 77,944 internal links.
- Curl against an isolated loopback handler and a real disconnecting upstream: opt-in succeeded with two POSTs; absent opt-in and stored turn each stopped at one and returned `x-should-retry: false`; empty/malformed bodies returned 400 with zero POSTs. Temporary servers, leases and state directory were cleaned up.

Architect consultation and independent plan audit passed. A fresh implementation reviewer returned PASS with no remaining blockers. One publication hygiene finding removed private review handles from the unpushed plan history; code and tests were unchanged.

Before publication, remote dev advanced from the inspected `0818ea1812a028e1c14cd0b0511b44863407bc52` to `87e315633978a6a0431696b952bedde83ede1a47` through release-version PR #6549. The lane was rebased onto that commit. Only inherited version files changed; the feature diff and behavior verification remain identical.

## Verification limits

Concurrent release stabilization and parallel lanes make local full/changed suites impractical under the explicit resource contract. Wider checks belong to actual current-head hosted PR CI. Missing, pending, skipped or cancelled jobs are not passing proof; retain draft status while broad/native evidence is incomplete. Native packaged runtime and live-provider acceptance were not exercised. No merge, source closure, release/deploy or installed-runtime/account changes were performed.
