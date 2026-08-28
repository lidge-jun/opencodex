# wp6 — Lane E: important bug issues with no PR

Dependency position: after wp5, because several wp5 reimplementations already close the
issue that would otherwise appear here (#2810, #2717, #2718, #2221, #2830).

## Candidate pool (16 open bug-labeled issues at triage)

Already covered by a wp5 member, so NOT re-picked here: #2810, #2717, #2718, #2221, #2830.

Remaining, with the selection judgment:

| issue | title | pick | reason |
|-------|-------|------|--------|
| #2833 | Unable to compact v1 | yes | compaction failure blocks ordinary sessions; user-visible and reproducible from the report |
| #2706 | Shadow Call Intercept forces effort low on every gpt-5.6-luna request | yes | silently downgrades max turns for a whole model; concrete and testable |
| #2813 | Codex Luna Reserve disables routed models after 5-hour quota exhausted | yes | routing regression that disables working capacity |
| #2723 | Quota-limited previous-model compact blocks Sol to routed DeepSeek handoff | candidate | overlaps #2833's compact path; decide after #2833 is diagnosed |
| #2792 | Loading index.js causes ERR_CONTENT_LENGTH_MISMATCH | candidate | GUI asset serving defect; needs a repro before planning |
| #2791 | /api/log timeout loop in Chrome desktop | candidate | same subsystem as #2792; likely one root cause |
| #2804 | Windows tray icon exits after 3s | no (this campaign) | Windows-host-specific; cannot be verified from this macOS session, so a fix would ship unproven |
| #2800 | Second OpenCodex home cannot pass admitCodexWrite under Task Scheduler | no | same Windows verification limit |
| #2686 | codex context issue (Chinese, sparse) | no | needs-info in substance; not actionable without reproduction |
| #1527 | Cursor adapter large-context turns collapse | no | prior session found this needs live Cursor account probing, not a code-only fix |
| #1419 | Bundled Bun SIGTRAP after connection reset | no | labeled needs-info; upstream runtime crash without a local repro |

Selection rule applied: pick issues whose defect can be TRIGGERED and OBSERVED from this
environment (C-ACTIVATION-GROUNDING-01). An issue whose fix cannot be shown firing is not a
candidate for a blind patch; it is left open with that stated, which is honest rather than
silently skipped.

## Procedure per picked issue

1. Reproduce from the report: name the exact code path, quote the failing behavior.
2. Write the failing test FIRST, observe it fail.
3. Fix narrowly; observe the test pass.
4. Open a PR targeting dev with Closes #<issue> in the description, filling every section of
   .github/PULL_REQUEST_TEMPLATE.md (Summary, Verification, Checklist).
5. Merge on green exact-head CI; then close the issue manually with the merged SHA, because
   GitHub only auto-closes on merges into the default branch (main) and these target dev.

## Accept criteria

1. Each picked issue has a merged PR whose test drives the reported condition.
2. Each unpicked issue has a recorded reason (above) rather than silence.
