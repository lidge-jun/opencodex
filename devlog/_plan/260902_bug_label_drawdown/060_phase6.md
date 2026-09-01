# 060 — Batch F: implementable bug issues

Five issues describe defects concrete enough to fix.

- **#3152** dashboard log panel layout jittering (`gui`) — adjacent to #3174's responsive
  work. Likely a measured-geometry fix in the same style.
- **#3170** provider input size limit handled gracefully — closes via #3177. **Confirmed by
  the A-gate audit (A4):** the body says `Closes #3170` and the diff maps a streaming 413
  to a terminal `context_length_exceeded` instead of the 5/5 reconnect loop. GitHub's
  `closingIssuesReferences` is empty only because the PR targets `dev`, so close by hand.
- **#2999** native-main refresh can overwrite external Codex writers (`account-pool`) —
  **the plan was wrong to assume #3112 closes it (A4).** The issue describes two races;
  #3112 is explicitly only the *lock-scope* half — serializing two `OPENCODEX_HOME`s
  against one `CODEX_HOME`. The named publication/overwrite race is still carried by the
  existing refuse-not-overwrite check. So #3112 landing does **not** close #2999: the
  publication half needs its own fix, or the issue stays open with that scope recorded.
- **#2813** Codex Luna Reserve / gpt-reserve disables routed models after the 5-hour quota
  is exhausted (`account-pool`) — needs a real reproduction of the reserve-mode gate.
- **#1527** Cursor adapter large-context turns collapse while direct Cursor stays healthy
  (`provider-compatibility`, `streaming`) — the hardest of the five; likely a request-shape
  or budget difference between adapter and direct paths.

## Order

Verify the two that other PRs close first (#3170, #2999) — those are free if Batch A and C
land. Then #3152, then #2813, then #1527.

## Method per implemented fix

Reproduce from the issue, locate the defect with `path:line` evidence, fix the root cause
rather than the symptom, add a focused regression proven red-green, land as its own squash
merge closing the issue.

## Verification (C)

Focused suite output with counts, red-green proof, landing SHA ancestry, issue closed.
