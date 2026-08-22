# 160 — Phase 17: closeout (attribution comments, full suite, dispositions)

Terminal phase. No source changes beyond this unit's own records.

## 1. Attribution comments on superseded contributor PRs

One comment per in-scope contributor PR, posted with `gh pr comment`. The
comment must state, in this order:

1. Which stack PR carries their work.
2. That their authorship is preserved — cherry-picked authorship or a
   `Co-authored-by:` trailer, named explicitly.
3. What was adapted or dropped, and why, when the adoption was not verbatim.
4. That their PR is left **open** for them to close or continue — the campaign
   does not close contributor PRs.

Target PRs: #1114, #1124, #1130, #1115, #1122, #1121, #1111, #947, #1047, #978,
#985, #1036, #1126, #1093, #1092, #1085, #997, #999.

No comment is posted on deferred feature programs (#1131, #1109, #1096, #1039,
#1010, #1002, #812, #811, #581) — they were never superseded, and a comment
implying otherwise would be misleading.

## 2. Full suite on the final stack head

`bun run test` on the top of the stack. The result is reported as measured —
including any load-sensitive failures, with the isolated re-run result stated
separately rather than folded into a "green" claim.

## 3. Disposition matrix

Written to `devlog/_fin/260806_stacked_bug_campaign/170_dispositions.md` with
this exact schema — one row per item in `001` and `002`, no item omitted:

```
| Item | Kind | Final state | Carrier | Credited | Evidence |
```

- **Item** — `#<number>` (issue or PR).
- **Kind** — `issue` or `pr`.
- **Final state** — one of `landed-stackNN`, `deferred`, `upstream`,
  `needs-info`, `feature`, `already-merged`.
- **Carrier** — the stack PR number that carries the work, or `—`.
- **Credited** — the contributor display name, or `—`.
- **Evidence** — the commit SHA on the stack branch, or the reason string for a
  non-landed state.

A row whose Final state is `landed-stackNN` and whose Evidence is empty is a
FAIL of this phase: it claims a landing with no proof.

The matrix must reconcile against the campaign totals: 49 issues and 32 open
PRs (+ #1129 already merged). A total mismatch is a FAIL, not a rounding note.

## 4. What is deliberately NOT done

- No PR is merged.
- No issue or PR is closed — including issues whose fix is in the stack. They
  close when the stack merges, which is the maintainer's decision.
- No branch is deleted, no release is cut, no version is bumped.

## Terminal outcome

Reported honestly against the goalplan criteria: `DONE` only if the stack PRs
exist against `dev` with their CI state reported and every in-scope contributor
PR carries its attribution comment. Otherwise the real outcome
(`BUDGET_EXHAUSTED`, `BLOCKED`, `NEEDS_HUMAN`) with evidence.
