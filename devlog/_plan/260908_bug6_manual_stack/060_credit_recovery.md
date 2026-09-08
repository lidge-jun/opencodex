# wp6: manual reset recovery

Depends on wp5 canonical operation identity. C4. Implements the user-visible contract in public issue https://github.com/lidge-jun/opencodex/issues/3973 . No real account actions or credit consumption are authorized by this development task.

## File map and private implementation appendix

- MODIFY `src/codex/auth-api.ts`: connect the authenticated manual operation with the existing quota-observation and routing-recovery ownership contracts.
- MODIFY `src/codex/routing.ts`: reuse narrowly targeted recovery ownership rather than broad account-health clearing.
- MODIFY `tests/codex-integration/codex-auth-api.test.ts` and `tests/codex-integration/codex-cooldown-recovery.test.ts`: mocked endpoint and ownership-race regressions using existing fixture conventions.
- MODIFY `docs-site/src/content/docs/reference/management-api.md` and `structure/08_openai-provider-tiers.md`: document the resulting supported contract when the patch is public, without account examples or internal proof material.
- NO CHANGE to persisted ledger schemas, auto-redemption policy, selected-account policy, GUI, or real credentials.

The complete before/after design, exact current source anchors, threat model, reachable activation cases and observable negative assertions are recorded in ignored `.tmp/bug6-01a07e9d/credit-plan.md`, section "Layer 2", against baseline `9e1468d4b7a41b498ed2aca98507ada2c741afea`. This is a mandatory implementation appendix, not deferred planning. Repository AGENTS.md requires unpublished security working notes to stay in scratch, overriding public devlog placement. Both the A reviewer and B worker must read the appendix; loss of the appendix requires reconstructing and auditing it before B.

## Acceptance and verification

Only the matching account's eligible pre-existing cooldown may be recovered after confirmed reset and fresh supporting evidence. Ordinary successful requests, uncertain results and replay do not gain broader recovery authority. Existing unrelated scopes and caller selections remain intact. The private appendix enumerates the full mocked positive/negative matrix and claim cleanup requirements.

Run no local product commands. Hosted CI must execute the affected auth, cooldown, quota and provenance suites; independent security review remains required. PR #3848 overlaps the flight interface: refresh before B and integrate any landed change without absorbing its unrelated registration behavior. New code belongs to this owned stack; do not modify other open PRs. Record privacy-safe outcome evidence here only after publication.
