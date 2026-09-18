# Verify final branch tips and hand off integration evidence

Cycle final consumes every delivered PR. No product change unless a concrete hosted CI/reviewer finding justifies a new repair cycle. Refresh PR head/base/native membership, CI run head SHA, all jobs and outstanding review threads. GitHub-hosted final tips are the user's execution verifier; intermediate runs may exist but are not claimed as tested by this task. Do not cancel workflows or modify protection.

MODIFY this unit's numbered evidence/closure record and task-local handoff: one row per original issue/PR with LIVE/PARTIAL/SUPERSEDED/NOOP and exact remaining acceptance; one row per new PR with URL/base/head SHA/commits/coauthor/manual-chain order; final hosted run IDs/URLs/conclusions and unresolved security/review/field acceptance. Local suites/typecheck/build/install NOT RUN. No merge or original issue closure.

Conditional repair: download exact failing job log, identify cause, amend owning phase plan, implement smallest correction in a fresh PABCD cycle, push --no-verify and verify new final head. Source-only checks are labeled text checks, not suite evidence. After unchanged final tip's checks pass, stop retesting and collect final handoff. Do not mark goal complete while required implementation is absent. Field acceptance has separate evidence status and cannot be replaced by mocks.
