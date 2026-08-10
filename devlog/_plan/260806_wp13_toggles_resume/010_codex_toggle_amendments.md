# 010 — Codex toggle: design amendments over 040

`040_codex_toggle.md` stays the diff-level source for messages, exit codes, the
seven-caller skip table, and the `CodexHistoryFailureReason` discriminator
(current anchor `src/codex/history-provider.ts:167-175`). Two of its structural
premises are replaced here; where this document and 040 disagree, this document
wins.

## Amendment 1 — no four-client coordinator; the write lock is the serializer

040 imports `runClientIntegrationFlight`, `requirePersistedClientIntent`, and
`mutateClientIntegrationEnabled` from a WP3 shared contract that was never built
(`040_codex_toggle.md:33-38,431-454,578-618`), and `000_plan.md` r3 drops that
premise. What actually exists:

- `setIntegrationEnabled` persists intent and explicitly does not linearize
  (`src/codex/desired-state.ts:14-19,90`).
- The management route has a route-local single flight
  (`native-integration-routes.ts:199-224`) that serializes toggles *within* the
  server process only.
- `withCodexWriteLock` serializes Codex artifact writes *across* processes
  (`src/codex/codex-write-lock.ts:67-125`; production caller `inject.ts:871-956`).

Replacement design, Codex-only:

1. Intent writes stay `setIntegrationEnabled` — one owner, no new mutation API.
2. The race 040 worried about (CLI OFF vs route ON, two processes) is closed by
   **revalidation under each artifact's own serialization boundary**, not by a
   cross-surface flight and not by one global lock. The three artifact families
   already have distinct serializers, and the Codex lock is *released* before
   the history worker launches (`inject.ts:951-966`), so "inside
   withCodexWriteLock" cannot cover history. Concretely:
   - config/profile writes re-read persisted desired state inside their
     `withCodexWriteLock` transaction (`codex-write-lock.ts:315-345` — the
     callback is synchronous, and the desired-state read is a synchronous file
     read, so it fits);
   - the history worker re-reads desired state inside
     `withHistoryWriteSerialization` (`history-worker.ts:119-131`), returning
     the existing `blocked`-style envelope with a new reason
     `"desired_disabled"`/`"desired_enabled"` instead of mutating;
   - catalog restore re-reads inside `withCatalogWriteSerialization`
     (`inject.ts:1241-1246`).
   A lost race becomes the discriminated skip (`status:"skipped"`,
   `skippedReason:"desired_disabled"` or `"desired_enabled"` for the restore
   direction). Each lock provides mutual exclusion for its artifact; the
   re-read inside it provides the freshness 040's
   `requirePersistedClientIntent` wanted (`040:600-618`). The small window
   where different artifacts observe different intent is acceptable: each
   artifact converges to the latest persisted intent, and the startup gate
   re-converges the remainder on the next start.
3. The route keeps its local flight for HTTP idempotency; the CLI needs no
   flight because the lock + revalidation is the correctness boundary.

## Amendment 2 — the OFF path stays on the async worker boundary

040's CLI diff wraps synchronous `restoreNativeCodex()` with a `beforeWrite`
hook (`040:184-205`). The CLI has since moved to `restoreNativeCodexAsync()`
with history in a Worker (`inject.ts:1193-1218`); reverting to the inline path
would regress the event-loop isolation the substrate campaign built. Instead:

- `restoreNativeCodexAsync` gains the artifact-level result 040 demands
  (`040:294-329`): a per-artifact envelope `{ config, catalog, history }` —
  catalog is a first-class member because restore performs it independently
  (`inject.ts:1241-1246`) and a `completed`-vs-not outcome exists today that
  the summary silently flattens. Profile restoration is reported inside the
  `config` member (it rides the same journal transaction). `history` carries
  `CodexHistoryFailureReason` (`"busy" | "permission"`) instead of being folded
  into `inline.success` (defect at `inject.ts:1193-1217`). Aggregate `success`
  is false if ANY member failed.
- Persist-OFF ordering for `ocx restore`/`eject`: `setIntegrationEnabled(false)`
  FIRST (so a crash mid-restore leaves intent durable and startup will not
  resurrect routing), then the async restore; the history job revalidates
  desired state under the lock per Amendment 1 before mutating. `restore back`/
  `eject back` persist ON first, then sync — and a sync skip caused by a
  concurrent OFF prints 040's competing-OFF error with exit 2.
- `success` for the command means: config (incl. profile) AND catalog restored
  AND history either restored or classified (`busy` → retry advice, exit 1;
  `permission` → ACL advice, exit 1). No path reports success with an
  unclassified hole in any artifact.

## Test impact (from the audit, folded in)

- `tests/codex-sync-api.test.ts:73-81` — expects the new `status:"applied"`.
- `tests/cli-restore-back.test.ts:11-35` — drop source-string assertions,
  assert behavior through a temp-home process run.
- `tests/native-codex-toggle.test.ts:106-156` — new envelopes and seams.
- `tests/codex-desired-state.test.ts`, `tests/codex-inject-write-lock.test.ts`
  — extend for revalidation-under-lock; not intrinsically broken.

## Commit order (typecheck green at every commit)

1. `CodexHistoryFailureReason` + artifact envelope in history-provider/inject
   (additive, no callers change behavior yet).
2. Discriminated `status` on `syncModelsToCodex` + all seven callers updated in
   the same commit (exit-code contract lands here).
3. Revalidation-under-lock in inject/restore/history job.
4. CLI restore/eject persist intent + new messages; process-level tests.
5. Route/context wiring + GUI, if any surface text changes.
