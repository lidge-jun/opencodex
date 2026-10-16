# 030: Delivery

- One branch, `codex/260923-p1-provider-state-continuity`, with ordered commits: roadmap,
  Part 1 (the #5614 carry with its co-author trailer first), Part 2, docs.
- One PR to `dev` using `.github/PULL_REQUEST_TEMPLATE.md`, with `Closes #5563` and
  `Closes #5618`. Verification records local checks as NOT RUN and cites hosted CI on the exact
  head.
- GUI: the Part 2 change in `gui/src/pages/use-providers-crud.ts` is logic plus locale strings.
  The lane cannot run the dashboard to take a screenshot, so the PR asks the coordinator for the
  screenshot or the waiver.
- Completion: every required check on the head SHA completes successfully. On a failure, read the
  failing job log, fix the cause, push again and re-read.
