# 111 — Windows acceptance and delivery

Outcome: Windows verification passed. The user explicitly excluded waiting for
macOS; this is not an aggregate multi-OS CI-green claim.

## Exact Windows evidence

GitHub Actions run [33943295449](https://github.com/lidge-jun/opencodex/actions/runs/33943295449)
tested `0449c8df022095393c926a76e3e6ed071d40f476`, Bun1.4.0, six Windows shards.

| Shard | Job | Pass | Skip | Fail |
|---|---|---:|---:|---:|
| 1/6 | 101245140818 | 2985 | 3 | 0 |
| 2/6 | 101245140735 | 3155 | 14 | 0 |
| 3/6 | 101245140773 | 3189 | 10 | 0 |
| 4/6 | 101245140856 | 2772 | 8 | 0 |
| 5/6 | 101245140782 | 3105 | 41 | 0 |
| 6/6 | 101245140809 | 2941 | 3 | 0 |

Total: **18147 pass, 79 skip, 0 fail**, 18226 tests across 1080 files. Every
Windows job succeeded; longest job22m38s, below the unchanged25-minute ceiling.
No assertion retry, additional skip, or timeout increase was used for these fixes.

Original failing cases:

- Real-second-process claim:397.63ms, pass.
- Hard claim ceiling:214.78ms, pass (baseline99.26seconds timeout). This is fixture
  setup optimization, not a claimed production speedup. Removing insertion
  pruning still fails the strengthened test with1025 instead of1024.
- Cold burst child:700.25ms, pass.
- Caller abort:1343.94ms, pass; original499/client_cancel and pool-health checks
  remain unchanged. Genuine upstream reset:1457.53ms, pass, still502.
- Three route-reconciliation assertions passed.
- Config-to-webhook activation:358.72ms, pass, HTTPS-only schema unchanged.

## Integration and provenance

Original stack PRs3548,3549,3550,3555,3558,3572 were merged before this follow-up.
Follow-up delivery: [#3610](https://github.com/lidge-jun/opencodex/pull/3610)
(quota) then [#3613](https://github.com/lidge-jun/opencodex/pull/3613) (eager).
Admin merge commits preserve the tested branch ancestry.

While Windows ran, dev#3622 independently repaired quota inventory and the HTTP
activation fixture. Reconciliation parent225ca85d3 keeps dev's single capability
and route entries, regenerates their reference, and retains byte-identical
Windows-tested quota fixture files. Childf2de6b84f merges that parent; the eager
implementation and its tests also remain byte-identical to0449c8df0. Existing
unrelated dev work is preserved, not reimplemented or reset.

Post-reconciliation proof:150focused tests pass, typecheck exit0, and the original
caller/reset server pair2pass. This is scoped merge verification; the full
Windows run is attributed to0449c8df0, not relabeled as a later commit's run.

Two independent gpt-6-astra/high implementation reviewers returned PASS. The
first review's unbounded receiver-wait finding was fixed and fault-tested before
the Windows dispatch. No local repository-wide suite was run.

Corpus update [fuck-powershell#52](https://github.com/lidge-jun/fuck-powershell/pull/52)
was admin-merged at9120948: existing path and test-budget cases gained this
occurrence.94cases,335nodes,682edges,0validation warnings. No duplicate taxonomy
case was added for an application-specific eager accounting defect.

The session goal ledger records final PR merge SHAs and the bound check receipt.
No pending Windows failure remains from either measured baseline. Future changes
to dev require their own verification; this record is pinned to the stated run.
