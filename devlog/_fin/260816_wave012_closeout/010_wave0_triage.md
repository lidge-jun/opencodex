# 010 — Wave 0: triage mutations

Status: **executed 2026-08-16**. Every action below is already reflected on GitHub; the section is retained as the record. Re-running it would duplicate external communication, so treat each step as complete and verify state instead of re-posting.

No issue is closed in this phase. GitHub metadata only; no repository code.

## Actions

1. `#1802` — add label `bug`. It currently has `cli` only, yet its title and body describe a real regression (`ocx sync` overwriting a hand-edited config from stale server memory). Keeps the release-blocker count honest at 27 rather than 26.
2. `#92`, `#417` — already labelled `upstream-tracking`. No mutation; record in this unit that they are excluded from the release-blocker statistic, and post one short comment on each confirming they remain upstream trackers and are not counted as ocx release blockers.
3. PR `#1822` — `bug` label review. The PR clarifies Log Guard storage UX and adds a write-load poster; that is GUI UX follow-up, not a defect fix. Replace `bug` with `gui`.
4. `#1049` — post a comment linking `#1798` and `#1802` as independent acceptance cases under the write-coordinator umbrella, stating explicitly that closing `#1049` does not close either.

## Evidence (captured)

- `gh issue view 1802 --json labels` → `bug,cli`.
- `gh pr view 1822 --json labels` → `gui`.
- `#1049` comment `5307288259`, `#92` comment `5307288327`, `#417` comment `5307288395`.

## Non-goals

- Do not close `#92`, `#417`, `#1049`, `#1798`, `#1802`.
- Do not retitle anything.
