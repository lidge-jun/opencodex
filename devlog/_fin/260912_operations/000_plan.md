# Operations delivery roadmap

Operators need accurate startup failures, safe update retry cleanup, readable usage, and actionable connected-client guidance. This unit carries the remaining reviewed contributions and repairs their current callers. The original stop-refusal implementation is already present on dev; it is not applied twice.

Loop: satisfy-spec HOTL, triggered by the operations lane assignment. Goal: reviewable PRs with final-tip hosted evidence and a durable handoff. Non-goals: merging, closing originals, releases, live service/config changes, local product suites/build/typecheck/install. Scope: this managed worktree and explicitly authorized GitHub PR writes; existing credentials only. No user token/time/agent-count cap. Stop only after every disposition, acceptance row and final-tip result is recorded, or an actual unavailable external gate is documented. Memory artifact: this unit and ignored .tmp/operations/handoff.md. Escalation: real tool/access denial or scope beyond assigned issues; main owns code and decisions. Native architect role is unavailable; supported inherited design reviews plus separate A audits follow explicit user direction.

## Work-phase map

| ID | Document | Outcome | Dependency |
| --- | --- | --- | --- |
| roadmap | 000 + all decade docs | Docs-only source-grounded roadmap | none |
| update | 010_update.md | Retire observed exited pinned children (#4185) | roadmap |
| listeners | 020_listeners.md | Name auxiliary bind failures and malformed edits (#4236 residual) | roadmap |
| totals | 030_totals.md | Keep readable usage and disclose omissions (#4111) | roadmap |
| client-usage | 040_client_usage.md | Hub usage scoped to connected client (#4205) | roadmap; preserve totals contract if shared |
| pairing | 050_pairing.md | Hub identity and origin-specific browser authentication (#4206/#4208) | roadmap |
| transport | 060_transport.md | Reviewed local management catalog read (#4315/#4317) | roadmap |
| verification | 070_verification.md | Exact tips, hosted results, credits, handoff | all implementations |

Independent changes use independent branches/PRs from the fetched dev baseline plus the common roadmap checkpoint. Only actual shared-code dependencies become an ordinary manual chain. No native stack registration. Intermediate auto-CI stays enabled; final cumulative tips are the acceptance unit.

## Source disposition

- #4170 OPEN at 4d72ef010363b80cd78f65148a5228d6797a3117, but dev contains 1ada8f5ff1 and further refusalNextStep behavior in src/lib/process-control.ts. No duplicate carry. Missing-message incident and actual scheduler behavior are not proven resolved by wording.
- #4185 OPEN at 2602f3ceca4b93237436911dcd8dffc35b3b5e57; current src/update/job.ts still uses lastChild.pid alone.
- #4111 OPEN at 2f07acb58b3e73f48cea38334f301b430a8634cd. Readable totals differ from connected-client routing.
- #4317 OPEN / CHANGES_REQUESTED at 27f577aa795f3b968c070a50eded48411bd7e985. Independent security review and own caller-complete patch required. Sensitive analysis stays in ignored scratch.
- #4236 latest public comment identifies only auxiliary listener bind diagnosis and malformed edit reporting as outstanding. #4249/#4250/#4251/#4252/#4254/#4255 are already landed and must not be replayed.

## Evidence policy

Local suites of every size, typecheck, builds and install: NOT RUN by explicit user instruction. Regression code goes to GitHub-hosted Cross-platform CI, whose pull_request trigger has no base filter (.github/workflows/ci.yml:3). Docs consistency uses git diff --check and file-map inspection, not claimed test coverage. Source review is not execution. Each final source SHA is paired with its actual run ID/URL/conclusion; skipped/cancelled runs are not passing proof. Every C/D records this limitation and defers behavioral acceptance to final hosted results.

Existing tree conventions: src/cli owns commands, src/server owns listener/management boundaries, src/update owns update retries, gui/src owns React presentation, tests mirrors domains, structure/manifest.json maps owning docs. No new dependencies, service layer, or settings are needed.
