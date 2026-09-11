# wp6: manual reset recovery

Historical phase record. Delivery is complete; see [071](071_delivery.md) and [072](072_final_proof.md) for terminal evidence.

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

## wp6 P refresh

Previous wp5 D verified #3965 already landed in dev402be7c1f, exacthead62412d386CIpassed, and locally adopted identical prerequisite (926b3719f); no duplicatePR5. This recovery PR targets existing layer4 #3993 and identifies the already-landed alias prerequisite in its relative diff. Source3973 remains open. Fresh inventory found overlapping contributorPR3995 (e172453052bf7bbc4a0ae5aa24592982c0c64b15) and independent fallbackPR3997; the latter resolves3996 and is outside this goal. The earlier no-overlap narrative was incorrect and is superseded before B.

Prepared recovery e6e081c09 plus repair a87a3f624 passed independent security and behavior audits. The private repair synthesis and updated handoff under ignored scratch resolve main-publication ordering and positive refresh provenance; never copy security working analysis into this public unit. All six target preimages on actual predecessor926b3719f equal auditedbase9eb44cfb4. Revalidate the unchanged candidate across intervening V2/GUI/testharness context, then adopt. All mocked regressions, current-head hostedCI, privacy, finalfullcohort proof and source-item closeout remain required. No localproductcommands or realcreditactions.

## Concurrent source reconciliation in P/A

Review new3995 against the prepared candidate before adoption. Preserve originalcontributor credit and include its useful language/CLI docs or regression cases when source comparison warrants. Existing prepared recovery provides bounded claims/publication/provenance invariants; no competing implementation is accepted solely from prior green claims. Comparative security/behavior source reviews are in progress, all notes remain scratch. No productdelta forwp6 has been adopted yet.

## Consolidated source decision

Retain audited recovery e6e081c09+a87a3f624 and consolidate contributorPR3995 rather than creating competing deliveries. Comparative security review retains its PASS; detailed algorithm findings remain private in credit3995Comparison.md. Keep pause/reauth eligibility and existing background lease ownership conservative and document that recovery can remain pending under those conditions. #3997/#3996 stays outside scope.

Additional MODIFY paths: docs-site/src/content/docs/ko/reference/management-api.md and docs-site/src/content/docs/reference/cli/providers-accounts.md, carrying the matching contributor guidance with parity to the final conditional recovery contract. This expands six unique files to eight. Do not duplicate the fuller English API paragraph. Adapt PR3995 tests into the existing auth-api test: two cold-main reset/already_redeemed cases without prior listing/reconciliation, bogus consume99 versus freshWHAM1; strengthen the existing saturation test with pre-existing shared cooldown, one consume, zero usage and retainedcooldown; adapt the two-old-flight/current-generation convergence scenario to assert fresh fourthdispatch completes before oldresponses, then oldresponses cannotoverwritefreshquota or recoveredcooldown. Preserve and await every deferred fixture cleanup. No new testfile, account-store schema or CLI runtime change.

Carry sourcee172453052 with Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com> in the adaptation commit and final PR body; describe exactly which tests/docs are adopted. B includes local candidate adoption and these bounded test/doc additions; independent interdiff review and exacthead hostedCI remain mandatory. No local tests/install/typecheck/build or realcredits.

## C fixture foldback

CI34188041321 caught a shared401-recovery budget leaking between fake-home cases: prior manual-a selfrefresh spends generation2, and the next case creates a different generation2 in a newhome but doesnotreset the module budget. The early spent-budget refusal prevents the intended external-replacement replay. MODIFY only the existing auth-api test: import/call resetQuotaRecoveryForTests in beforeEach/afterEach, assert empty budget at the negative-case start, observe real force-refresh provenance, and KEEP expectedfreshremaining2, replay URLs and cooldown-preservation assertions. No production relaxation. Also use existing watchdogMs(10000) and60souter ceiling for the new convergence fixture; its current run passed, so this is convention/contended-runner safety, not increasing a failing behavioral timeout. Source/interdiff review and newexactheadCI are required.
