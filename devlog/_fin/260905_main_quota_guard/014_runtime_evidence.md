# Runtime implementation checkpoint

## Changed-file evidence

| File | Change and impact |
| --- | --- |
| src/types/config.ts | Optional off-by-default main hard-lock config contract. |
| src/config.ts | Boolean parsing; malformed hand edits stay off. |
| src/codex/main-account-hard-lock.ts | Identity-bound raw-window policy; owner-directed 5h first, weekly otherwise, monthly-only fallback. |
| src/codex/main-account-cache.ts | Memory-only owned identity/generation and keyed credential equality. |
| src/codex/quota.ts | Separately retained private policy evidence, distinct legacy/policy merge bases, governing monthly provenance. |
| src/codex/account-lifecycle.ts | Publish identity from existing owned reconciliation and confirmed transitions. |
| src/codex/account-usability.ts | Exclude blocked main from ordinary selection. |
| src/codex/auth-context.ts | Refuse matched main at admission/materialization, carry writer provenance, preserve safe policy error formatting. |
| src/codex/auth-api.ts | Capture WHAM provenance before request, publish safe main status. |
| src/server/management/config-routes.ts | Partial boolean PUT, exact rollback and acknowledged setting/status DTO. |
| src/server/responses/core.ts | Destination-gated policy propagation, replay/header writer integration; independent providers unaffected. |
| src/server/responses/compact.ts | Matching compact/replay propagation and policy error mapping. |
| src/providers/openai-sidecar.ts | Include Direct sidecars in the same materializer policy. |
| structure/08_openai-provider-tiers.md | Updated policy scope, observation limits and selected-window contract. |
| tests/codex-integration/main-account-hard-lock-policy.test.ts | Authored boundary/window-priority/unknown/reset scenarios. |
| tests/codex-integration/main-quota-provenance.test.ts | Authored identity, restart, TTL, partial merge and monthly transition scenarios. |
| tests/codex-integration/main-account-hard-lock-auth.test.ts | Authored native/refusal/alternate/caller isolation and actual handler destination scenarios. |
| tests/config/settings-main-account-hard-lock.test.ts | Authored acknowledgment/persistence/rollback/malformed setting scenarios. |
| scripts/test-layout/layout.json | Register the four new domain tests. |
| tests/fixtures/test-layout-expected.json | Mirror the test-layout registrations. |

## Observed verification

- Root `bun run typecheck`: exit0 after the final runtime/producer repairs.
- Standalone `bun x tsc --ignoreConfig --noEmit --module ESNext --target ESNext --moduleResolution bundler --skipLibCheck --strict --types bun-types` against the four new test paths: exit0. This checks test types, not test behavior.
- `git diff --check`: exit0.
- Independent Ohm review: all provenance/TTL/tertiary/monthly-producer findings closed; final VERDICT PASS.
- Independent Tesla review: unrelated-provider refusal finding closed; final VERDICT PASS.
- No local test suite was executed. Exact-head CI is pending publication and is required before runtime completion/merge.
- Installed Desktop Reserve-gate source evidence is in001; live Reserve success is not claimed.

## CI round1:373915800

Run33929679810, test2/4 job101205597376: two exact-context assertions in `codex-main-rotation.test.ts:158,186` failed because they did not include the intentionally added internal `mainQuotaWriter`. The batch reported136pass/2fail. Other gates, including the actual CI typecheck/GUI tests/privacy/build job, passed at this point; remaining jobs were not yet complete.
Repair classification: required contract-fixture extension. Preserve exact whole-object equality and every prior credential/routing assertion; add explicit writer key-format and generation-type checks. Identity/ABA semantics remain covered by new provenance tests. No production change and no local suite run.

The same run's test1/4 job101205597387 also failed native-search listener setup with EADDRINUSE at the secondary bind (`server/index.ts:2375`), before the request/assertions. Its fixture chooses a free secondary port, releases it, then binds the public listener with0; that draw can claim the reserved secondary port. The existing `findAvailablePort(...,{reservedPort})` contract already addresses this exact collision in a sibling test. Reuse it for all equivalent ordinary loopback-start fixtures, leaving intentional bind-failure tests unchanged. This changes test port selection only, not production startup, timeouts, retries or assertions. No flake is excused merely by retrying.

Repair checkpoint: preserve declared short-window metadata and retain an already measured tuple on missing usage; `main-quota-window-observation.test.ts` adds owned WHAM/header coverage and is registered in both manifests. Fresh C reviewer Feynman closed the parser finding and reviewed both CI fixture repairs, VERDICT PASS. Root typecheck, standalone new observation-test typecheck, privacy scan and diff check all exited0. No local suite.

CI round2 at a7759cee0, run33930372485 test3/4 job101208017799:193pass/1fail in a batch. The legacy Go monthly-primary fixture in tests/gui/rate-limit-reset-credits.test.ts expected no provenance marker; the approved producer fix now intentionally retains it for same-account weekly-to-monthly transitions. Extend exact equality with monthlyIsPrimaryWindow=true and correct its outdated comment. Other original values/assertions remain unchanged; supplementary-monthly negative cases still omit the marker. No production delta.
