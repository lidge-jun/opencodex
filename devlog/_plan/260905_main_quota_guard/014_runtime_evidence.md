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
