# wp6 — needs-info bug issue disposition

Five issues carry `needs-info`. None is a code task yet; each needs a disposition.

## #3320 Windows scheduler task misclassified for non-ASCII account names
platform/service. Windows-specific, and this session runs on Windows — the one case where
a local reproduction is cheap and legitimate. Disposition: attempt a narrow local repro of
the classifier only (no suite run); if reproduced, it graduates to a fix work-phase.

## #3279 GUI dashboard flips to offline with 401 on /api/* while proxy health is OK
gui. Intermittent session/auth interaction, 5 comments. Needs the dashboard session
lifetime and the exact 401 body. Disposition: targeted info request naming which fields to
capture.

## #3255 Decouple model capability and response speed controls
Labeled bug, but the content is a design change (match the official ChatGPT experience).
Disposition: NEEDS_HUMAN — reclassify to enhancement and ask the maintainer for product
intent. Not fixable by inference.

## #3245 macOS Codex 0.152.0 streams disconnect through ocx 2.39.0
upstream-tracking. Likely not our defect; ocx 2.39.0 is far behind current dev.
Disposition: ask whether it reproduces on 2.42.x; if the reporter is silent, the
stale-needs-info workflow will close it.

## #1527 Cursor adapter large-context turns collapse
18 comments, long-running, provider-compatibility. Disposition: summarize what is already
known, state what evidence would move it, or fold it into the Cursor umbrella if one is
open.

## Accept criteria
- every one of the five reaches a TERMINAL disposition that is VISIBLE on the issue:
  closed with rationale, OR a posted info request with specific named questions AND the
  `needs-info` label present so `stale-needs-info.yml` owns the timeout. An internal note
  that never reaches the issue does not discharge the item.
- #3255 is reclassified from `bug` to `enhancement` (label change applied, not merely
  recommended) and its NEEDS_HUMAN product question is posted for the maintainer.
- #3320 is the one issue where a narrow local Windows reproduction is permitted; if it
  reproduces it graduates to its own appended work-phase (LOOP-UNIT-CHAIN-01) rather than
  being closed as needs-info.
- the five dispositions are recorded in the ledger with the posted comment URL or close
  reason, so the goal-level claim is auditable.
