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

