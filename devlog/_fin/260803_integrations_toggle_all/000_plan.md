# Turning Claude Code and Grok Build on and off

## Objective

Claude Code and Grok Build become switchable from the Integrations overview,
each removal explained before it happens. Both stay ON by default while
opencodex runs.

> **Status: re-scoped after four audits.** This unit now covers **Claude Code
> and Grok only**. Codex and Claude Desktop moved to
> `../260803_codex_desktop_toggle/` because they need a durable operation-state
> schema that these two do not (`007_audit_synthesis_r4.md`). `010` and `020`
> are retired under `_retired/`. Still a docs-only Phase-0 cycle; no
> implementation yet.

The objective for all four is unchanged — Codex and Desktop are a sibling unit,
not a dropped requirement.

Research: `001_removal_path_inventory.md`. Dialog direction and copy:
`002_consequence_dialog_ux.md`. Audit fold-backs: `003`, `004`, `005`, `007`.
`006` records the semantic-restore replan; `007` records why two of its four
clients then left. Read `001`, `002` and `007` before any phase work.

## What four audits changed about the shape

1. **These two toggles need no rollback machinery, and three revisions of it
   were the mistake.** Claude Code's undo is flipping a boolean back. Grok's
   undo is the enable path regenerating its fence from the current catalog —
   strictly better than replaying a stale snapshot. Neither writes a journal row
   or a snapshot.
2. **Codex and Desktop genuinely do need it**, which is why they left. A durable
   operation record, prepare/commit with restart reconciliation, and a
   field-scoped config writer are real work that only those two require
   (`007` §The decision this round forces).
3. **The one thing this unit still needs from the audits** is the ownership
   preflight: `ocx stop` refuses shared teardown under a foreign-home service,
   and nothing on the HTTP side ever did. Grok's disable inherits that refusal.
4. **A claim I got wrong.** `saveConfigPreservingClaudeCode` does NOT protect an
   unrelated config section — its docstring says so explicitly. Claude Code's
   toggle inherits the same concurrency behavior every other `claudeCode` writer
   has, no better and no worse, and this unit does not pretend to fix it.
## Dependency order

WP1 (Claude Code) and WP2 (Grok) are parallel siblings — neither depends on the
other, and saying so matters after audit r4 #11 read the previous client
ordering as risk sequencing dressed up as dependency. WP3 (routes) and WP4 (GUI)
depend on both.

| Phase | Doc | Deliverable |
|---|---|---|
| WP1 | `011_wp1_claude_code_toggle.md` | The route module + Claude Code's toggle |
| WP2 | `012_wp2_grok_toggle.md` | Grok's toggle + the ownership preflight |
| WP3 | `030_management_routes.md` | `GET` status, refusal envelopes, per-client guard |
| WP4 | `040_dialog_and_cards.md` | Consequence dialog, six-locale copy, two switches |

The GUI is last because its copy must name what the writers actually do. A
dialog written before its writer promises whatever sounded reasonable — which is
exactly how an earlier revision came to promise a byte-for-byte Grok restore the
writer never performed.

## Scope boundary

IN: `src/server/management/native-integration-routes.ts` (new),
`src/server/management-api.ts`, `src/grok/inspect.ts` (new),
`src/integrations/native/ownership-preflight.ts` (new),
`gui/src/pages/integrations/`, `gui/src/i18n/*.ts`,
`gui/src/styles-integrations.css`, `tests/`, `gui/tests/`.

OUT: `src/integrations/journal.ts`, `store.ts`, `ownership.ts`, `registry.ts`,
`writer.ts` — the six file clients' machinery is untouched and, after the
re-scope, not even widened. `src/claude/desktop-3p.ts` and `src/codex/` belong
to the sibling unit. The release pipeline, `docs-site`, any push.

## Criteria

- C1 — Claude Code and Grok toggle both directions from the overview cards.
- C2 — each is reversible by the toggle itself: Claude Code by the flag, Grok by
  regenerating its fence. Disable → enable → disable is stable.
- C3 — Grok's disable removes only the fenced region; user bytes outside it are
  byte-identical afterwards, including a trailing user section and CRLF endings.
- C4 — Grok's toggle-off is gated by a dialog naming path, breakage and undo;
  Claude Code's is not (UX-LAZY-01, `002`).
- C5 — `orphaned-marker`, `home_mismatch` and `not_installed` surface as
  localized explained refusals, never a raw 500.
- C6 — all six locales carry every new key.
- C7 — typecheck, full `bun run test`, gui test, gui lint, privacy scan green.
- C8 — neither toggle writes a journal row or a snapshot.
- C9 — a concurrent Claude Code toggle and file-client mutation do not lose each
  other's config write.

## Risk register

| Risk | Mitigation |
|---|---|
| Grok disable strips something the user owns | Delegate to `stripGrokConfig`, which is fence-scoped and preserves outside bytes verbatim; never reimplement stripping (`012`) |
| Shared teardown runs under a foreign-home service | Ownership preflight before Grok disable — the refusal names both homes and does NOT tell the user to stop a service (`012`) |
| An ambiguous fence boundary gets guessed | `orphaned-marker` refuses and writes nothing; retrying cannot help, so the copy does not suggest it (`012`) |
| Concurrent config writes lose each other | Claude Code rides the existing `withConfigMutationLockSync`; Grok gets a per-client single-flight. Broader config concurrency is pre-existing and explicitly out of scope (`030`) |
| The GUI promises an undo the writer does not make | Grok's dialog says re-enabling regenerates the fence from the current model list, not that it restores old bytes (`012`, `002`) |

## Recorded follow-up, not in scope

- Roughly nine other `saveConfigPreservingClaudeCode` callers in
  `agent-settings-routes.ts` race each other today; this unit neither creates
  nor fixes that. The shared coordinator that would have addressed it moved to
  the sibling unit, which has cross-client bookkeeping that genuinely needs one
  (audit r5 #2).
- A field-scoped config writer would fix that AND the stale-subtree case audit
  r4 #3 found, where a caller's whole `claudeCode` subtree wins over a
  concurrent disk edit. It belongs to `../260803_codex_desktop_toggle/` WP1,
  which needs it for Desktop's four bookkeeping fields.
