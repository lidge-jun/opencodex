# 050 — Fix #857: stale app-server roster detection + safe guidance

Root cause (investigator Gauss, verified): ocx reads the disk catalog
fresh each turn (src/codex/catalog/sync.ts:96-105) and emits positive v2
guidance (src/server/responses/collaboration.ts:216), while Codex's
app-server loads the catalog once into a StaticModelsManager and validates
spawn_agent overrides offline against that snapshot. Rewriting
opencodex-catalog.json cannot update a running app-server. ocx warns only
during sync (src/cli/index.ts:826); process snapshots lack start times
(src/codex/app-server-processes.ts:65).

## Fix (scoped slice of the full design)

1. `collectCodexAppServerCatalogState()` returning
   `fresh | stale | not_running | unknown`: catalog mtime vs app-server
   process start (extend snapshots with startedAtMs; /proc on Linux, ps on
   macOS, Win32_Process.CreationDate on Windows; unknown start time ->
   `unknown`).
2. Surface in `ocx agent status` (+ JSON) and `ocx doctor`; add state to
   `/api/subagent-models`.
3. Runtime safety: when `stale` or `unknown`, suppress positive model
   claims (preferred model, roster, fallback chain) in v2 guidance;
   optionally inject neutral "restart Codex" guidance. Never auto-restart.
4. GUI banner in Subagents.tsx — included if the slice stays small,
   otherwise deferred to a follow-up.

## Tests

- tests/codex-app-server-processes.test.ts: fresh/stale/not-running/
  unknown/multi-process/PID-reuse with injected platform snapshots.
- tests/multi-agent-compat.test.ts: stale/unknown suppress model claims;
  fresh and no-app-server keep current output.
- Management API test: /api/subagent-models carries the state.
- Preserve existing sync-warns-without-restart tests.

## Results (2026-08-02, wp6 executed on branch codex/bugfix-280)

- 26dc5aa2 fix: collectCodexAppServerCatalogState (catalog mtime vs process
  start, 5s TTL, platform readers), v2 guidance suppression on
  stale/unknown, /api/subagent-models state, ocx doctor check; env override
  keeps host process state out of hermetic tests.
- 2ad395a3 repair round 1 (Faraday FAIL): enumeration failure → unknown
  (listers propagate; restart flow keeps its own no-target contract);
  timestamp ties conservatively stale; batched start-time reads; TTL cache
  only for fully-default calls.
- 856b37cf repair round 2 (FAIL): missing /proc throws (unknown, not
  not_running); Windows GetOwner gaps emit an incompleteness sentinel;
  timeouts tightened with documented bounds.
- 942bb613 repair round 3 (FAIL): sentinel on ALL owner-verification
  failure branches; batch timeouts match the documented bounds.
- Final review: PASS. GUI banner deferred per plan. Synchronous cold-call
  bound documented on the collector; fully-async refresh out of scope.
