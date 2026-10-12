# 020 — wp3: dev candidate

The candidate is the `dev` SHA after wp2's last merge. It is fixed before the version
pre-move, so the pre-move PR never changes the tree that ships.

Dispatch the full lane on `dev` and bind it to the exact SHA:

```bash
git fetch origin dev
CAND=$(git rev-parse origin/dev)
gh workflow run ci.yml --ref dev -f lane=all
gh run list --workflow ci.yml --branch dev --event workflow_dispatch --limit 3 \
  --json databaseId,headSha,status,conclusion
```

Take the run whose `headSha` equals `CAND`. If `dev` moves before the dispatch resolves,
the candidate is the run's head, and every later step uses that SHA.

Once the candidate is bound, dispatch the dev pre-move of [030](030_wp4_release.md) §1 so its
pull request runs its own checks in parallel with the candidate run. The pre-move never changes
the candidate: the candidate is a fixed SHA, and the pre-move PR is merged only after both its
own exact-head checks and this run have finished green.

Acceptance: every job of that run has conclusion `success`, except `privacy gate`,
which is skipped by design on `workflow_dispatch`, and the `ci` aggregate is `success`.
A job counts at its latest attempt only.

Failure handling:

- A Windows job failing once with a known runner-stall signature (`spawnSync ETIMEDOUT`,
  a 480 s batch timeout where each file passes alone, `EPERM` on temp cleanup) is rerun
  once with `gh run rerun --job <id>` after the run completes.
- The same case failing twice is a defect: a focused fix PR to `dev`, reviewed, merged at
  a green exact head, then a new lane=all dispatch on the new candidate.
- Any non-Windows failure is a defect from the first occurrence.

Runners: the owner's standing instruction for release rounds is that release-path runs get
the runners and other runs are cancelled by hand, one at a time, never by script. While this
run and the release runs are active, other queued or in-progress runs are cancelled
individually after reading each run's workflow, branch and event; runs on `main`, `preview`,
the candidate run, this round's own PR runs and `Release` runs are never cancelled.
