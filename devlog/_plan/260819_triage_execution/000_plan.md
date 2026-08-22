# 000 — 260819 triage-execution campaign plan

Baseline: 4-lane sol-medium triage (2026-08-19) over 53 open PRs + 75 open
issues. This unit EXECUTES the verdicts. All merges via gh pr merge --admin
(user pre-approved). Issue-closure rule: a merged PR that resolves an issue
closes that issue in the same work-phase.

Live-state reverify (wp0, 2026-08-19): all 14 merge candidates OPEN,
MERGEABLE, base=dev, zero FAILED checks — but NOT all CI-proven: #2061 #2066
#2042 #2072 #2068 #1903 #2075 have no Cross-platform CI run on their exact
heads (only hygiene/enforce-target). mergeStateStatus=BLOCKED is the
review-requirement ruleset; admin merge passes. #1885 CONFLICTING (close
target anyway), #1498 draft+CONFLICTING+red hygiene (close target).

**Pre-merge validation rule (r1 audit fold-back):** a PR without a
Cross-platform CI conclusion on its exact head must NOT be merged on
mergeability alone. Before merging such a PR: scratch-merge its head onto
current dev in a lidge worktree and run the focused suites the diff touches
(plus tsc); only a clean scratch-merge run authorizes the admin merge. The
post-merge push CI on the merge SHA remains the decisive gate; a red
post-merge CI triggers immediate fix-forward or revert of that one merge.

## Work-phase map (dependency-ordered)

| wp | scope | PRs / issues | gate |
|---|---|---|---|
| wp1 | batch-quota | merge #2056 #2055 -> close #2047 #2046 | sol review lane per PR, then admin merge, CI on merge SHA |
| wp2 | batch-small-fixes | merge #2053 #2045 #2061 #2066 -> close #2065 | same |
| wp3 | batch-lab-chat | merge #2042 #2059; re-diff #2075 vs #2042 (prefix-matching claim); #2044 test-gap decision (merge with follow-up test or request change) | same + 2075 contradiction resolution |
| wp4 | batch-features | SERIALIZED: merge #2072 first, then re-diff/re-review/scratch-validate #1903 against post-2072 dev before merging it (both touch src/codex/catalog/provider-fetch.ts + provider docs + 9 GUI locales); then #2068 #2057; close #1885 (superseded by #2072) #1498 (stale/dont-merge) | same + serialization gate |
| wp5 | redesign #2073 | injector env_http_headers -> env_key (codex 0.146+) | C3: wp5's P WRITES 010_env_key_contract.md (contract proof from codex-rs source/release notes via cxc-search) BEFORE impl; impl+tests, PR, admin merge, close #2073 |
| wp6 | redesign #2064 | Remote raw-thinking on empty summary[] | C3: wp6's P WRITES 020_remote_reasoning_leak_rca.md (root-cause in OUR relay; model-side intermittent exposure is out of scope) BEFORE impl; impl+tests, PR, merge, close #2064 |
| wp7 | redesign #1926 | tsig credential scope | C4 security: design 051_tsig_credential_scope.md (fin unit), impl+tests, PR, merge, close #1926 |
| wp8 | redesign #1942 | Windows transactional update rollback | C4: base design 090_transactional_update_rollback.md has a KNOWN path-structure defect (staging/backup as CHILDREN of <prefix> makes the live-prefix swap move them with it, and live cannot move into its own subdirectory) — wp8's P MUST amend the design to sibling-of-prefix staging/backup paths (e.g. <prefix>.ocx-staging-<ts>) before impl; impl+tests, PR, merge, close #1942 |
| wp9 | closeout | final dev-head CI verify, ledger, unit disposition | push-CI green or pre-existing-red classified |

## Review-lane contract (every merge batch)

- One sol-medium read-only reviewer per PR (parallel), packet includes
  $codexclaw:cxc-dev + $codexclaw:cxc-search mentions, full diff read,
  verdict line MERGE-OK | BLOCK(reason).
- Main agent merges only MERGE-OK PRs; BLOCK verdicts downgrade the PR to
  NEEDS-WORK with an evidence comment.
- Merge method: squash when the branch has fixup/noise commits, merge
  otherwise.
- Suites: lidge dispatch without long blocking waits; decisive gate is the
  Cross-platform CI push run on the merged SHA.

## Known risks

- Seven merge candidates lack head CI (see pre-merge validation rule above);
  scratch-merge lidge validation is mandatory for them.
- wp4 #2072/#1903 file overlap (provider-fetch.ts, provider docs, locales):
  serialized merge with re-validation between.
- #1942 base design path defect: fixed at wp8 P via design amendment.
- #2075 verdict conflict: 1st-pass ADOPT-NOW vs sol NEEDS-WORK (claims it
  reintroduces prefix matching #2042 fixes). Resolve by diffing #2075 head
  against #2042 semantics AFTER #2042 lands.
- #2064: reasoning leakage can be intermittent model-side behavior; fix only
  what our relay provably does wrong (persisting/rendering raw reasoning when
  summary[] is empty).
- Windows dispatch CI leg is known-red pre-campaign (Log Guard families) —
  not a gate for these merges.
