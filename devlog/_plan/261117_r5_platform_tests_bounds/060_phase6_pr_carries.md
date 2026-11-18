# wp6 — PR carries: #8817 (conditional)

## #8817 fix(windows): exclude foreign users from stop candidates

Author luvs01 <luvs01@hanmail.net>, draft, head b12472cfe8, four commits (50cb9b0e5f, f423a0ceee,
0a00504194, b12472cfe8). C4: it narrows which Windows processes the checked stop treats as
candidates. Exact-head PR CI is green (Linux; Windows jobs skipped on PRs).

Carry only on a SAFE-TO-CARRY or SAFE-WITH-FIXES verdict from an independent security review
(fresh subagent): candidates may only be removed, exclusion requires owner-SID evidence bound to
the creation time, unreadable or budget-exhausted owner evidence stays a candidate, no
process-controlled text reaches a PowerShell command, and this home's own wrapper is never
foreign.

Diff: cherry-pick the four commits onto the lane branch in order, squash into one commit
`fix(windows): exclude foreign users from stop candidates` with
`Co-authored-by: luvs01 <luvs01@hanmail.net>`, then apply any fixes the review lists. The lane PR
says "Supersedes #8817".

Verification: the five `tests/windows/*` files of the PR, `file-size-ratchet`,
`structure:check`. NOT RUN: a real Windows host, cross-user sessions, ARM64.

If the review answers UNSAFE, or the change would land without any Windows execution of its new
PowerShell cases, the item is DEFER with the review's reason.


## Outcome (2026-11-17)

DEFER. The independent security review answered SAFE-WITH-FIXES: termination candidates only
shrink, owner evidence is bound to the creation time, nothing process-controlled reaches
PowerShell, and service accounts and the current user are never foreign. On the merged tree the
five focused files gave 127 pass / 6 skip / 0 fail.

The blocking finding: the foreign-owner exclusion is also applied to the confirmation paths
(`windowsHomeWrapperPids` in src/service/windows-stop-binding.ts, Part B's `unnamed` in
src/service/windows-stop-confirm.ts, `wrapperProcessesAlive` in
src/service/windows-guarded-manager.ts). Ownership is compared with the stop process's own SID,
so a stop run from another account (an elevated shell under a separate admin) classifies this
home's wrapper as foreign and can report the port freed while the wrapper still lives and can
respawn the proxy. The fix keeps the exclusion in `bindWindowsStopWrappers` candidate selection
only, or compares against the task/install account. Both need a cross-user Windows run before
they can be called correct, which this lane cannot do.
