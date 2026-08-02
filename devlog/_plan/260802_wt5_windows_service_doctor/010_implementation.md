# wt5 — Implementation roadmap (re-verify at P before building)

Branch `codex/wt5-windows-service` off `dev`. Windows-heavy lane: run long CPU/validation work on `ssh macmini-cf` or a Windows box; bare `macmini` fails host-key verification (ops note from maintainer).

## Bug A — #868: scheduler verification settle

File map:

- MODIFY `src/service.ts` (scheduler registration + post-create verification) — retry ONLY transient post-create Task Scheduler visibility/XML health states.
- PRESERVE fail-closed for: conflicts, missing assets, unknown SCM status. Stop late reconciliation when attempt ownership changes.
- Tests: scheduler/startup/service/install-verification contracts (PR claims 136 focused; re-verify on rebase).

Acceptance + activation:

1. Transient post-create invisibility settles to installed/viable/running within the retry budget. Activation: fault-injection test with scripted transient states.
2. Conflict / missing asset / unknown SCM each still fail closed with no retry storm. Activation: three adversarial tests.
3. Ownership change mid-reconcile stops late writes. Activation: interleaving test.
4. Live Windows validation: startup protection reports installed, viable, running, conflict-free (PR author claims this; executing session re-runs it).

## Bug B — #861/#848: Bun runtime provenance

File map (owner-directed shape from issue #848 comment — follow it exactly):

- MODIFY all five launcher paths to stamp one allowlisted `override | bundled | process` marker: npm Node launcher, Windows scheduler, native WinSW (`src/lib/winsw.ts`), launchd, systemd (`src/service.ts`, `src/lib/bun-runtime.ts`).
- MODIFY `src/server/management/system-routes.ts` — expose the recorded provenance scalar alongside Bun version/revision.
- MODIFY doctor/status (`src/cli/status.ts`) — report recorded provenance; legacy payload without the field = unknown/absent. NEVER call `durableBunRuntime()` at report time to guess from the current shell (mislabels the running process).
- KEEP `bunRevision` informational; conservative `auto-known-bad` for canaries unchanged; eager-relay capability policy untouched.
- DOCS: `structure/05_gui-and-management-api.md` — provenance trust + backward-compat rule.

Acceptance + activation:

1. With `OPENCODEX_BUN_PATH` override active, doctor no longer repeats the setup instruction. Activation: regression test with override env + stamped marker.
2. Legacy service payload (no marker) reports unknown, not a shell guess. Activation: fixture with old payload.
3. Regressions cover scheduler + WinSW + launchd + systemd + direct Node launcher (owner's explicit list in #848).

## Verification gate

`bun run typecheck` + focused doctor/runtime/service/watchdog tests (baseline was 99/99 on the issue thread) + `bun run test`.
