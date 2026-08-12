# Audit round 1 — synthesis

Verdict: **FAIL**, 9 blocking (2 Critical, 7 High) plus 4 Medium and 1 Low.
Reviewer: dispatched independent explorer, adversarial pass over all seven docs
against the real tree.

This is the A gate doing its job. Recording the root causes before amending
(REVIEW-SYNTHESIS-01), because three of the nine share one cause and patching
them individually would leave it alive.

## Root causes

### RC-1 — I modelled a snapshot as one file

Blockers 1 and 4 are the same mistake in two places. `captureSnapshot` takes
`text: string | null`, so I designed each native client around a single
`capture()`. But neither operation is single-file:

- Desktop deletes `<id>.json` and `.bak` AND rewrites `_meta.json`. Snapshotting
  only `_meta.json` means restore puts back an `appliedId` pointing at a profile
  that is still deleted — **the exact dangling-pointer corruption WP2 exists to
  prevent**. My "snapshot the file we could break, not the one we could rebuild"
  line was wrong: the profile is regenerable from config, but not by *restore*,
  and restore is what the Rollback Centre offers.
- Codex's `restoreNativeCodex` touches `config.toml`, `opencodex.config.toml`,
  the catalog, its own journal, and possibly `state_5.sqlite`. Snapshotting
  `config.toml` alone cannot reverse it.

**Fix:** a native snapshot is a SET of files. Accepted in full.

### RC-2 — I assumed a refusal means nothing was written

Blocker 2. `runNativeOperation` returns early on `ok: false` with no journal row,
which is right for a preflight refusal and catastrophic for a failure *after* a
partial mutation — `removeDesktop3pConfig` catches every exception into
`removed: false`, including one thrown after `_meta.json` was already rewritten.
The user would get "nothing changed" while their library is half-changed.

`writer.ts` already solved this with `compensate()` and a `residual` flag
(`writer.ts:103-163`). I did not carry the concept over.

**Fix:** three outcomes — `unchanged | committed | partial` — with `partial`
carrying residual paths and a journal row. Accepted in full.

### RC-3 — I declared a branch without wiring its trigger

Blocker 5. Both `030` and `002` promise a `home_mismatch` refusal, but neither
native spec calls anything that raises `ServiceOwnershipError` — it comes only
from the service install-state check (`src/service.ts:193-235`), which the CLI
calls and my routes do not. So the branch is unreachable by construction, and
worse, the route would happily tear shared config out from under a foreign-home
service.

This is precisely the C-ACTIVATION-GROUNDING-01 failure the A phase exists to
catch: I wrote the accept criterion for a path with no trigger.

**Fix:** add the preflight that makes it reachable. Accepted in full.

## Disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | Desktop restore recreates dangling metadata | **Accept** — compound snapshot, restore files then metadata, invariant test |
| 2 | Critical | Partial failure reported as refusal | **Accept** — `partial` outcome + residual paths + journal row |
| 3 | High | Snapshot leaked on refusal/no-op | **Accept** — preflight before capture; delete uncommitted snapshot |
| 4 | High | Codex snapshot ≠ blast radius | **Accept with variation** — see below |
| 5 | High | `home_mismatch` unreachable | **Accept** — shared ownership preflight |
| 6 | High | Cross-client concurrency unsafe | **Accept** — one coordinator, resource-lock matrix |
| 7 | High | Desktop ownership by display name | **Accept** — persisted id + provenance marker |
| 8 | High | Deleting `appliedId` on no survivor | **Accept** — refuse `no_safe_desktop_fallback` |
| 9 | High | `mutate` sync but uses `await` | **Accept** — async throughout |
| 10 | Medium | Ownership widening unnecessary | **Accept** — journal/maintenance only |
| 11 | Medium | Two status authorities | **Accept** — one merge function, card reads `row.applied` |
| 12 | Medium | Overstated claims | **Accept** — corrected in `001` |
| 13 | Medium | Retention secret footprint | **Accept** — bound documented, cleanup guaranteed |
| 14 | Low | Doc inconsistencies | **Accept** — order and copy aligned |

### Variation on #4

The reviewer offered two options: expose the existing Codex journal as the
authoritative restore, or build a compound snapshot. Taking the compound
snapshot, and including `opencodex-journal.json` itself in it.

Reason: `restoreNativeCodex` *deletes* its journal on a complete restore
(`journal.ts:109-141`). So after a disable, the mechanism the reviewer would
have us delegate to is gone — it cannot serve a later re-enable-then-undo. A
snapshot that captures the journal file alongside the configs survives that,
and keeps one restore concept across all four clients instead of "Codex is
special".

SQLite history is **excluded** from the snapshot and stated as a limitation:
`state_5.sqlite` is a live database that only sees legacy retagging, copying it
under a lock we do not hold would be its own hazard, and it already has a
separate backup (`codex-history-backup-<hash>.json`). The dialog will say the
resume-history tag is not covered rather than implying it is.

### No rebuttals

Nothing in this round is rebutted. All 14 are folded in.

## Amendments

`010` and `020` are rewritten. `000`, `001`, `002`, `030`, `040` are patched.
Re-audit goes to the SAME reviewer with this synthesis attached (AUDIT-LOOP-01).
