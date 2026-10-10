# RT6 outcome

Status: DONE. Merge train complete and the final dev-tip CI is green. The release itself is cut by the GPT-6.1 Sol release chat (01a0ef42), which bundles RT6 with its own PR; this train did not pre-move versions, promote preview/main, or run release.yml.

## Release evidence

- dev tip: `540af24384d713603ff96863d811dfccca5392e8` (#6261 merge commit).
- Final Cross-platform CI (workflow_dispatch, lane all) on that tip: run **36640672883**, attempt 1, **success** — 38 executed jobs green including windows 1/9-9/9, macos 1/2-2/2, macos control, macos widget + bundle, keyring windows/macos/ubuntu, and the `ci` aggregate.
- Service lifecycle on the same tip: run **36640675838**, **success**.

## Landed on dev (14 PRs)

#6230, #6236, #6248 (carry #6225), #6235, #6249 (fixes #6242), #6161, #6247 (carry #6232), #6255 (carry #6234), #6258 (carry #6238), #6204, #6207, #6200, #6203, #6261. Exact-head CI and review evidence: 021_merge_ledger.md, 022_ci_evidence.md.

Issues closed: #6093, #5679, #6237, #6139, #6242, #6162, #6197, #6013.

## How the first dev-tip failure was resolved

Run 36629963702 on b78bfb8f00 failed windows 8/9: two keyring tests added by #6161 computed simulated POSIX paths with the Windows host's path module. #6261 (`540af24384`) makes `packagedKeyringCandidates` use the target platform's path rules and adds a regression test that fails without the fix; packaged runtime behavior is unchanged because the target platform is the host platform at runtime. The same run's macos 1/2 failure (two plugin-ACL tests timing out at about 2 s) passed on a same-SHA re-run and passed again in 36640672883; recorded as a suspected ACL inspection timeout, not fixed.

## Left open

- #6244: owner policy question (auto-release after a bound vs operator clear).
- Upstream credential echo on existing passthrough paths: scratch note .tmp/rt6/followup-credential-echo.md (not tracked, pre-existing on dev).
- Worktrees /tmp/ocx-rt6-l1..l4 and /tmp/ocx-rt6-coord remain; nothing on them is needed for the ledger.
