---
title: FAB-00 State Machines
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 050 -- State Machines

## Task

```
open -> (all acceptance claims validated) -> completed
open -> (operator cancel | policy) -> cancelled
open -> (security/quarantine trigger) -> quarantined
quarantined -> (operator reconciliation) -> open
```
Terminal: `completed`, `cancelled`. `quarantined` is recoverable.

## Run

```
created -> starting -> running
running -> (need input) -> waiting_input
running -> (approval requested) -> waiting_approval
running -> (pause) -> paused
running -> (interrupt | user cancel) -> cancelled
running -> (done, exit 0 + validated claims) -> completed
running -> (error / exit!=0) -> failed
any non-terminal -> (lease lost, fenced) -> lost
```
**Decision:** `lost` is terminal and forces reconciliation (`090`); a lost run's uncommitted writes are **quarantined, never auto-discarded**.

## Handoff

```
proposed -> preparing -> awaiting_approval -> starting_target -> committing -> completed
awaiting_approval -> (decline | tier-3 loss) -> rolled_back
starting_target | committing -> (failure pre-commit) -> rolled_back
committing -> (failure post-commit) -> failed   # target-runtime failure; rescue/reversal path
```
**Invariant (sec.16):** a handoff never leaves both source and target with write authority. Pre-commit failure -> source retains ownership. Post-commit failure -> target owns; rescue/reversal path.

## Workspace

```
registered -> preparing -> ready -> owned
owned -> (reviewer assignment) -> read_only
owned -> (verify) -> [isolated verify mode]
owned -> (dirty checkpoint before handoff) -> dirty -> ready
owned -> (failure / suspicious) -> quarantined
owned -> (release) -> released -> archived
```
**Decision:** `read_only` and `quarantine` are enforced via OS/process sandbox, **not** git (sec.17 / `020` D). One writer per worktree.

## Cross-machine invariants (property-tested, sec.24 / `130`)

- One primary owner per task at all times.
- Fencing token strictly monotonic across ownership changes.
- Completed handoff ? exactly one target owner; `rolled_back` ? ownership unchanged.
- Permissions never widen without an approval event.
- `lost` / `quarantined` require explicit reconciliation to return to `open` / `ready`.
