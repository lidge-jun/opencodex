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
