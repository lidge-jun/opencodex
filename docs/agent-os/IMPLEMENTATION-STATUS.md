# Agent OS / Brain Universe — Implementation Status

> Generated: 2026-08-29. Maps the Phase 0-16 roadmap to what is actually
> implemented in this repository, with the test evidence per module.

## Architecture decision

Implemented as one opt-in subsystem under `src/agent-os/` (no new app, no new
process, no external database) following the repository rules: Bun-native
TypeScript, storage as a single SQLite file under the existing config dir
(`~/.opencodex/agent-os.sqlite3`, WAL mode), local-first, deny-by-default.
Brain Universe (Phase 15) is exposed over the existing management API as
read-only routes under `/api/agent-os/*`.

## Module map

| Phase | Module | What exists | Tests |
|---:|---|---|---|
| 02 | src/agent-os/registry.ts | Agent registry: identity, lifecycle (health/enable), fail-closed default permissions, upsert by id | tests/agent-os-registry.test.ts |
| 04 | src/agent-os/tasks.ts | Persistent task queue: enqueue/claim FIFO, heartbeat, retry with backoff, crash recovery via stale-heartbeat reclaim, cancel | tests/agent-os-tasks.test.ts |
| 05 | src/agent-os/policy.ts | Capability policy: deny-by-default, subject-specific beats global, deny beats allow; write-class capabilities additionally require a granted approval record | tests/agent-os-policy.test.ts |
| 07 | src/agent-os/memory.ts | Memory OS: scopes (global/project/agent/decision/failure/workflow), provenance, correction (update keeps id), delete | tests/agent-os-memory-skills.test.ts |
| 08 | src/agent-os/skills.ts | Skill store: versioned records + read-only health pass (duplicate names, missing files, deprecated) | tests/agent-os-memory-skills.test.ts |
| 09 | src/agent-os/workflow.ts | Workflow engine: durable versioned step graphs driven through the Phase 04 queue; approval gates pause runs; denial cancels | tests/agent-os-workflow.test.ts |
| 10 | src/agent-os/teams.ts | Team runs: bounded-parallel child dispatch (deferred plan stored), rejects unbounded specs | tests/agent-os-teams-observe.test.ts |
| 11 | src/agent-os/observability.ts | Task timelines (event trail) + replay planning: safe only for side-effect-free kinds, never silent re-execution | tests/agent-os-teams-observe.test.ts |
| 12 | src/agent-os/remote.ts | Remote nodes: register/heartbeat, liveness states (online/stale/offline), capability routing to live nodes only | tests/agent-os-teams-observe.test.ts |
| 15 | src/agent-os/brain-scanner.ts | Brain Universe scanner: read-only walk, ignore rules, secret exclusion (never read), size policy, framework/instruction detection, coverage counters, symlink escape blocked | tests/agent-os-brain.test.ts |
| 15 | src/agent-os/brain-sessions.ts | Session indexer: Claude/Codex JSONL -> canonical events, streaming line reader, broken lines counted, byte-offset resume | tests/agent-os-brain.test.ts |
| 15 | src/server/management/agent-os-routes.ts | Observatory HTTP surface: GET-only routes for agents/tasks/skills/memory/nodes/reviews/task-timeline/search/ask; POST/PUT/DELETE rejected 405 | tests/agent-os-routes.test.ts |
| 16 (slice) | src/agent-os/reviews.ts | Reviewer Council results: record + deterministic aggregation (fail dominates, warn -> needs_review) | tests/agent-os-teams-observe.test.ts |
| 16 (slice) | src/agent-os/search.ts, ask.ts | Global metadata search + Ask Pao Brain: deterministic intent routing over local data with source citations; honest fallback, no fabrication | tests/agent-os-teams-observe.test.ts |

## Test evidence

```
bun test tests/agent-os-*.test.ts   -> 44 pass / 0 fail (8 files)
bun x tsc --noEmit                  -> exit 0
bun run privacy:scan                -> pass
```

## Security posture (enforced, not just documented)

- Registry defaults: read=true, write=false, terminal=false, net=false.
- Policy: unknown capability/subject = default_deny; shell.exec/fs.write/
  git.push/deploy require an explicit allow policy AND a granted approval.
- Scanner: no write/rename/delete/execute code paths; secret-named files are
  skipped unread; symlinks are never followed; ignore list covers
  node_modules/.git/dist/... by default.
- Observatory HTTP: GET only; mutations are impossible over the API by design.
- Ask/search: metadata over the local store only; semantic search honestly
  reports as unavailable until a local model seam is added.

## WebMCP challenge slice

- Compatibility adapter and dynamic registry live under gui/src/webmcp/.
- Nine P0 tools call the same Agent OS API used by the human UI.
- Audit records use SHA-256 input digests and redacted summaries.
- Brain Universe includes WebMCP status, Tool Inspector and Agent Activity.
- The demo route provides the deterministic Smart Factory scenario.

## Not yet implemented (honest gaps)

- Phase 15 pgvector semantic search — intentionally deferred (local-first; needs
  a local embedding model seam).
- Real ComfyUI/H3 rendering is not configured; demo tools use deterministic
  production-shaped adapters.
- Public deployment and the challenge video are not produced locally.
- Phase 16 full Write-Permit gateway — the approval ledger and policy engine
  exist (Phase 05); the scoped SHA-bound write permit flow is Phase 16 work.
- Phase 01 OpenHarness adapter — no OpenHarness integration exists yet.
