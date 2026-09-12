# Final verification

Depends on editor. MODIFY PR descriptions with exact source/head, manual chain map, attribution and hosted CI evidence; NEW .tmp/combo-handoff/HANDOFF.md, security review and screenshots. No planned product edits; any hosted failure requires a concrete P amendment before repair.

Before: no same-repository carries, no final cumulative proof. After: bottom runtime PR -> editor child PR with editor-only delta; git merge-base --is-ancestor lower upper exits zero, gh pr view proves head/base, gh run view proves successful final-head hosted CI and run URL. Capture actual rendered Combo editor with synthetic fixture data using an existing runtime or hosted-built artifact (no local build/install). Fresh exhausted target disables Save; unknown or expired permits it. Screenshot file must be durably accessible and included in upper PR body. No screenshot waiver.

Security review checks binding creation, private WeakMap retention, report serialization, key-pool/OAuth exclusions and invalidation against current configuration. Review is distinct from maintainer approval. CI negatives cover changed credentials, destination, auth, headers, key pools, display-only limits, fresh/expired/malformed evidence. All local tests NOT RUN. Record any unmet browser/architect/review gate honestly.

## Audit repair amendment

MODIFY lower-layer `tests/providers/provider-quota.test.ts`: explicit-projection test `exhausted` and `projected` objects each gain `updatedAt: Date.now()`. MODIFY lower-layer `tests/codex-integration/catalog-zero-credit-picker.test.ts`: display and bound report fixtures each gain `label: "Alpha"`. Keep runtime and assertions unchanged. Commit on own lower branch, rebase own editor branch onto the new lower tip, push lower normally and upper with explicit lease plus --no-verify. This preserves editor-only upper delta. Independent runtime security audit PASS; these low fixture contract findings are accepted. Recheck original current heads and final carry bases/head/CI; no merge.

## Check-phase repair from independent editor audit

Accepted Bacon P2: mixed retained/fresh report timestamps can leave fresh exhaustion unknown until an older deadline. MODIFY Combos quota loader to update its observation clock on each successful non-aborted snapshot before publication; preserve expiry/visibility effects. Add deterministic mixed-snapshot refresh regression in existing page-loading-contract test with a retained older row and fresh exhausted target, preserving a dirty alias. Update canonical GUI contract. This is C's observe-fix-recheck loop within the verification cycle, not an unrecorded new phase. No local suite. Re-push and replace final-tip CI evidence.
