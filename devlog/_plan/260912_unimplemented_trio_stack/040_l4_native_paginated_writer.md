# L4: paginated history — offline ordinal recovery, live refusal preserved (#4311)

Class C4 (user data). Stack top, base the L3 branch. Branch
`codex/260912-native-paginated-writer`.

## Problem and scope decision (open decision 2, resolved here for audit)

#4311's live defect (ordinal-0 `session_meta` clone) is already guarded:
`updateSessionMeta` throws for paginated records before writing
(throw at src/codex/history-provider.ts:1172), and preflight refuses
`history_paginated_requires_native_writer`
(structured field src/codex/inject.ts:899; preflight closure
src/codex/inject.ts:1182-1194). The residual acceptance is
(a) native paginated writer support and (b) corrupted-rollout recovery.

(a) needs a Codex-owned writer API/IPC. None exists in this tree: Codex
owns ordinals and the live projection cursor
(structure/codex-home.md:232-234), `appendRolloutLine` deliberately does
not allocate ordinals (src/codex/history-provider.ts:77,248), and H
serializes only OpenCodex writes (src/codex/history-lock.ts;
src/codex/internal/history-writer.ts:86,107). Inventing N+1 is explicitly
forbidden by the issue (concurrent native writer / stale cursor). This
layer therefore ships (b) the offline recovery tool, keeps (a) refused
with the same structured reason, and says so in the PR. A follow-up
native-writer integration needs a Codex-side write API first — reported,
not faked.

## Changes

NEW `src/codex/history-ordinal-recovery.ts`
- Offline repairer for the #4311 corruption shape: an unprojected suffix
  whose ordinals regress (projector error `expected N, got 0`).
- Preconditions, all enforced before any write:
  - Codex fully closed (no running Codex process holds the home; detect
    via the same process/home inspection the service uses, fail safe when
    undecidable).
  - Target resolution follows `resolveCodexStateDbPath` and
    `threads.rollout_path` (src/codex/paths.ts:107-108; the column is
    read through history-provider, not paths.ts) — never assume
    `~/.codex/sessions`.
  - Suffix shape verified: ordinals strictly increase before the boundary,
    regress at the boundary, and the suffix parses cleanly. Anything else
    refuses.
  - Byte-identical backup written before mutation (manifest beside the
    existing backup convention, src/codex/history-provider.ts:30).
- Rewrite: only ordinal digits in the unprojected suffix, renumbered to
  continue the pre-boundary sequence; message text, ids, timestamps, and
  all earlier bytes preserved. Exact readback verification before
  reporting success. Dry-run (verify-only) is the default; `--write`
  applies.

MODIFY `src/cli/` (doctor/dispatch surface per existing conventions)
- `ocx doctor history repair-paginated-ordinals [--thread <id>]`
  [--write]: runs the recovery, prints boundary, counts, backup path, and
  readback result. Register capability/help; regenerate skill surface if
  the registry changes.

MODIFY `structure/codex-home.md`
- Record the recovery tool's ownership of offline ordinal repair and
  restate that live paginated writes stay refused (structure:check gate).

Explicitly unchanged (regression-tested, not edited):
`preflightCodexHistoryInjection` (history-provider.ts:307),
`appendRolloutLine` (77), `updateSessionMeta` paginated guard (1172),
inject pre/postflight (inject.ts:1182,1295,1332), catalog-only sync
(src/codex/sync.ts:216).

## Tests (red-first; tests/codex-integration)

NEW `tests/codex-integration/history-ordinal-recovery.test.ts`
- Synthetic fixture: session_meta ordinal 0 followed by event ordinal 1
  (the issue's minimal shape) behind a healthy increasing prefix.
- Dry-run reports and writes nothing (byte-identical file).
- Applied repair renumbers only the suffix; every non-ordinal byte
  identical; readback passes; backup exists and matches the original.
- Refusals: Codex process detected / undecidable; suffix shape mismatch
  (no regression, gap, unparsable line); missing backup space; absolute
  rollout_path outside CODEX_HOME via sqlite_home.
- Preservation invariants red-first: run the preservation assertions
  against the unimplemented command first (red), then implement (green).
MODIFY `tests/codex-integration/codex-history-provider.test.ts`
- Assert preflight refusal reason unchanged for paginated rows (the
  recovery tool must not become a live writer).
NEW files: layout.json explicit + expected-fixture entries.

## Out of scope

Live paginated writes, ordinal allocation, native-writer IPC, any change
to the authless/compaction relabel fork (inject.ts:1098), provider-table
lifetime policy (separate #4311 sub-thread, tracked by containment unit),
in-app repair while Codex runs.
