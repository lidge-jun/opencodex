# Codex and Claude Desktop toggles

Split out of `260803_integrations_toggle_all` after its fourth audit
(`../260803_integrations_toggle_all/007_audit_synthesis_r4.md`). That unit keeps
Claude Code and Grok, whose toggles need no durable operation state. These two
need one, and it is the shared dependency four audit rounds kept circling.

## Why these two are together and separate

| | Codex | Claude Desktop |
|---|---|---|
| Artifacts | `config.toml`, `opencodex.config.toml`, model catalog, resume history (SQLite) | `<id>.json`, `.bak`, `_meta.json`, four fields in our config |
| Owner | us, mostly | **Claude Desktop** — we edit another app's registry |
| Prior state recoverable? | from its own journal, when hashes still match | only from `_meta.json` bytes; `appliedId` was never recorded |
| Removal code exists? | yes, `restoreNativeCodex` | **no** |

Neither can be undone by re-running its enable path, which is what makes Claude
Code and Grok cheap. Codex's enable is not the inverse of its disable — the
journal fallback means a disable may strip fragments rather than restore bytes,
and a later enable writes today's catalog, not yesterday's arrangement. Desktop
cannot re-derive which profile the user had selected at all.

So both need an operation record that outlives the request, and that record is
the first phase.

## Read first

From the parent unit, all still authoritative:

- `001_removal_path_inventory.md` — what each client's disable actually costs
- `003`, `004`, `005`, `007` — the four audit syntheses; `007` is why this unit
  exists
- `002_consequence_dialog_ux.md` — dialog direction; the Codex and Desktop copy
  lives there

## Phases

| Phase | Doc | Deliverable |
|---|---|---|
| WP1 | `010_operation_state.md` | The durable operation record: a versioned discriminated journal entry, prepare/commit, restart reconciliation, a field-scoped config writer |
| WP2 | `020_codex_toggle.md` | Codex disable/enable on top of it |
| WP3 | `030_desktop_toggle.md` | Desktop removal + rollback, `appliedProfileId` schema work |

WP2 and WP3 are **parallel siblings**, not a sequence: Desktop does not depend on
Codex (audit r4 #11). Both depend on WP1 and nothing else.

## What WP1 must deliver

Named by audit round 4, findings #1, #2, #5, #3:

1. **A versioned discriminated journal entry.** Today's `JournalEntry`
   (`src/integrations/journal.ts:34-51`) is file-shaped: one `configPath`, one
   `SnapshotRef`, one `resultFingerprint`. A routing description and three
   library members do not fit it. Needs `file-v1 | native-state-v1 |
   desktop-hybrid-v1` with validated serialized state, per-member fingerprints,
   and retention behavior.
2. **Prepare/commit with restart reconciliation.** A crash between the mutation
   and the append leaves no undo state at all. Idempotent re-apply does not fix
   this — it helps once a state exists, and none was recorded. The prepared
   record must be durable before the mutation and resolved after.
3. **A field-scoped config writer.** `saveConfigPreservingClaudeCode` persists
   the whole live object and its own docstring says a `providers` hand edit is
   clobbered (`src/config.ts:2132-2135`); worse, when disk and caller both
   changed `claudeCode`, the caller's stale subtree wins, so one toggle field can
   clobber a concurrent Desktop-profile edit. Desktop's four fields need a write
   that reloads from disk and touches only named paths.

## Carried-forward findings

Everything in `005` §Carried forward plus round 4's, in particular: Codex's
pre-state must capture the effective injection mode and history policy, not just
a routing kind (r4 #4); `injectCodexConfig` takes a concrete `catalogPath`, so
"selector" needs a resolver (r4 #4); Desktop's ordering is dangling-pointer-safe
but not transactionally crash-safe and must say so (r4 #6); auto-apply must be
suppressed while an operation is prepared (r4 #6).

## Status

Not started. `020` and `030` carry their pre-split content and are **stale**
against the operation-state design WP1 has not written yet; their next P
re-verifies them against it before any build.
