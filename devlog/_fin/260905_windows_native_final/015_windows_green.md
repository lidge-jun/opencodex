# 015 — Final Windows green and delivery evidence

## Verified outcome

[Windows run 33949825505](https://github.com/lidge-jun/opencodex/actions/runs/33949825505)
tested exact stack head `6ad49c8b5b01ff84c24cee4bb811eb23a3566e5f`.
All six Windows suite jobs completed with SUCCESS, without a failed-shard rerun:

| Shard | Job | Pass | Skip | Fail |
| --- | --- | ---: | ---: | ---: |
| 1/6 | 101262480199 | 3040 | 19 | 0 |
| 2/6 | 101262480175 | 3356 | 10 | 0 |
| 3/6 | 101262480188 | 3216 | 15 | 0 |
| 4/6 | 101262480176 | 3399 | 6 | 0 |
| 5/6 | 101262480221 | 2804 | 32 | 0 |
| 6/6 | 101262480276 | 2903 | 2 | 0 |
| Total | 1091 files | 18718 | 84 | 0 |

Windows keyring and npm-global checks also passed. Local verification was limited
to focused files and typecheck: 90 pass, 0 fail, 446 assertions across the five
changed test files; typecheck and privacy scan exited 0. No local full suite or
SSH execution was used. macOS was not a completion dependency.

## Original failures and preserved behavior

- Effective config-path assertion passed in 8.49ms; changed-home directory alias
  without a config file passed in 5.60ms. Native realpath fixed spelling without
  relaxing identity checks.
- All 12 fresh-process journal scenarios passed, including prepared/source-exact
  at 11.52s. Both manual-observation cases and the ordinary-Pool case passed.
  The primary error and cleanup fault probes remain documented in 011.
- All five restore-after-app-rewrite cases passed in 4.07–8.26s. The actual
  earlier 15s Windows failure is closed; 014 records the old/new delayed-child
  contrast and independent command-kill proof, not a blind deadline increase.
- Held-lock injection returned busy and wrote nothing (5.88s). Competing OFF
  became the discriminated skip (3.05s). Original assertions were preserved;
  write-before-lock and stale-ON mutations had already demonstrated they fail.
- All temporary fault/source mutations were restored before the tested commit.
  No production source change or test skip was added by these two final layers.

## Review and integration

Stack: [#3629](https://github.com/lidge-jun/opencodex/pull/3629) then
[#3637](https://github.com/lidge-jun/opencodex/pull/3637). Noether approved the
implementation; fresh adversarial reviewer Lorentz returned PASS for the child
diff `d6c03b1d9..6ad49c8b5`, checking deadlines, process reaping, primary-error
preservation, nested admission/error propagation and unchanged assertions.

Parent #3629 merged as `0a9815cf745c4572a1329d6da8ab88f1e02fc940`; GitHub
retargeted the child to dev. This final record ships with the child. Delivery
uses admin merge under the maintainer's explicit authorization, without claiming
a separate human approval. Merge commits preserve tested ancestry. The final
goal receipt must independently confirm both PRs MERGED and ancestor of dev.

The integrated code base was `a53775103`. Subsequent dev `a687eb735` added only
four unrelated devlog documents. The following check exited 0:

```sh
git diff --exit-code a53775103 a687eb735 -- . ':(exclude)devlog'
```

The archive
and this outcome record are also documentation-only; final receipt checks the
tested head against both the local head and merged dev excluding devlog.

Windows lessons were integrated into existing fuck-powershell cases rather than
duplicated: [PR #53](https://github.com/lidge-jun/fuck-powershell/pull/53), merged
`43d148691dbf5b05e40e9a6d604986e6ebf496a8`; validation reported 94 cases,
335 nodes, 683 edges, zero warnings. Earlier corpus PR #52 is also merged.

## Limits and next decision

A completed red run was not accepted as stabilization. The original two failures
led to a real residual restore failure, which led to the child-layer repair and
this green run. There is no remaining observed Windows failure in this final
run. This does not promise immunity to future runner variation or new code.
Reopen investigation on a new actual failure signature; do not weaken assertions
or add speculative budgets to unmeasured sibling tests. No further optimization
or macOS waiting is required for this Windows-only goal.
