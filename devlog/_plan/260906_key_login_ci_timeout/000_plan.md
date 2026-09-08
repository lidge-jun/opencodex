# 000 — Diagnose the key-login live-update CI timeout

One focused PABCD repair cycle. Baseline dev `922bfa653a013647881316f3d95f0631a87acb10` differs from failed CI head `73190c20443876fe1dbf4e9dde5d25644e48e71a` only by the previous lane's outcome record.

## Evidence and outcome

Public CI run 33999342751, job 101395411095, failed `tests/oauth/key-login-live-update.test.ts:61` after 15,046ms against a 15,000ms test budget. The shard finished 9,470 pass, 7 skip, 1 fail. The log records server startup but no failing assertion or awaited-operation trace. Other execution jobs passed; Windows six-shard tests were intentionally skipped by the push workflow.

Keep the same disk/live modelCosts and rotated-key assertions. Locate the wait before changing code. A passing retry alone does not explain the failure.

## Investigation and conditional change map

- Read `tests/oauth/key-login-live-update.test.ts` and instrument its asynchronous boundaries only in remote scratch: key-login commit, management read and server stop.
- Trace `src/oauth/login-cli.ts` notify, `src/server/local-provider-reload-client.ts` request, `src/server/management/provider-routes.ts` reload validation/convergence, and the server's shutdown hooks. Preserve every admission predicate.
- The fixture currently installs the real Umans hostname both before start and through the replacement preset. Check whether DNS/network dependence causes the observed wait. If established, modify only the test fixture: use a synthetic controlled destination via the existing baseUrl override, preserve real local attestation/reload/convergence, assert the reload outcome, and clean owned resources. No timeout extension, skip or mock of the operation under test.
- If the wait is a production lifecycle defect instead, amend this plan with the observed boundary and smallest production correction before B. Do not introduce speculative cancellation or security changes.
- Put the final evidence and failure disposition in `010_outcome.md`; unpublished security findings, if any, remain in ignored scratch.

## Execution and acceptance

Class C2 for a hermetic fixture correction; promote to C4 with independent security review if executed auth/admission logic must change. Main owns refs/PR/FSM; one remote worker owns serialized macOS reproduction under the shared test-user lock, and an independent reviewer owns static analysis. Inherit the parent model. No local suite, typecheck, build or hooks. Remote pinned Bun 1.4.0 and synthetic fixtures only; do not access personal accounts/services. No requested token/cost budget; six-hour checkpoint, not an automatic success condition.

Required evidence: original failure and causal trace, focused remote original/fixed comparison, original assertions intact, relevant adjacent tests and typecheck, independent review, current-head hosted CI, admin merge and actual dev ancestry. Follow final dev CI for this repair. Existing user push/admin authorization applies; every push uses --no-verify. No release, deployment, global relink, integration-branch direct push or changes to another lane's jobs.

DONE requires those actual outcomes. NOOP needs proof current dev already resolves the failure. Unknown cause, an expired wait, and a red CI are not completion. Append a separate cycle only if a distinct necessary repair appears.

## A evidence amendment: controlled failure path

Remote pinned-Bun macOS reproduction: original fixture passes in 95.42ms with controlled outbound HTTP. Delaying only the real Umans DNS answer gives reload transport-unavailable at ~10.28s, successful local config GET at ~10.29s, then `server.stop(true)` begins and remains unsettled until the original 15s test timeout (15,008.86ms). The trace identifies `providerDestinationResolvedError` as the DNS caller. This reproduces the CI timeout shape; the uninstrumented historical CI log still does not prove which external delay occurred there.

Selected change is test-only: an owned literal-loopback upstream in beforeEach with a deterministic catalog response, `umansKeyConfig(baseUrl, port)` using explicit private-network opt-in, the existing key-provider constructor's URL override plus private-network opt-in on the replacement row, and awaited upstream teardown after the proxy. Preserve all four original assertions and the 15s ceiling; additionally assert reload outcome is `reloaded` and config GET is HTTP200. No production auth, destination validation, transport or shutdown change. Focused remote gate covers this test, key-login overlay merge, OAuth live update, local reload client and direct transport, plus root typecheck. A controlled delayed-DNS run must remain green with zero DNS calls from the fixed fixture.
