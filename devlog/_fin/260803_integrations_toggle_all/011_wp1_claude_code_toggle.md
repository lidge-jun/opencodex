# WP1 — Claude Code, the one with no external file

> **Rev 2** after audit round 4 (`007_audit_synthesis_r4.md`). The generic
> `NativeClient<TState>` abstraction is GONE. Four audits established that a
> durable pre-state schema is real work that only Codex and Desktop need, and
> those two have moved to their own unit. What is left here is what Claude Code
> actually requires, which is very little.

## What this toggle actually is

`config.claudeCode.enabled`. One boolean, read at six call sites; `false` makes
`/v1/messages` answer 403 and stops agent and system-env injection
(`001` §Claude Code).

**Undo is flipping it back.** No journal row, no snapshot, no captured
pre-state, no restore route. The Rollback Centre exists for operations that
move bytes in someone else's file; this one changes a field in ours, and the
user reverses it with the same switch.

That is the round-4 lesson applied: I spent three revisions building a
transactional store around an operation that needs none of it.

## IN

1. `src/server/management/native-integration-routes.ts` — NEW: a small module
   owning `GET /api/native-integrations` and
   `PUT /api/native-integrations/claude`.
2. `src/server/management-api.ts` — MODIFY: mount it.
3. `tests/native-claude-code-toggle.test.ts` — NEW.

OUT: `src/integrations/**` entirely — no journal, no snapshot, no store, no id
widening. `/api/claude-code` keeps owning the detailed settings; this adds a
toggle, not a second settings surface.

## The route

```ts
// PUT /api/native-integrations/claude   { enabled: boolean }

if (typeof body.enabled !== "boolean") {
  return jsonResponse({ error: "enabled must be a boolean" }, 400);
}
const current = config.claudeCode?.enabled !== false;
if (current === body.enabled) {
  return jsonResponse({ ok: true, clientId: "claude", changed: false,
    state: body.enabled ? "current" : "absent", message: "no change" });
}
const next = { ...(config.claudeCode ?? {}), enabled: body.enabled };
// See §The migration sentinel — omitting this converts Auto into a sticky
// manual subscription on the next startServer.
if (!next.authModeMigratedAt) next.authModeMigratedAt = new Date().toISOString();
config.claudeCode = next;
(deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
return jsonResponse({ ok: true, clientId: "claude", changed: true,
  state: body.enabled ? "current" : "absent", message: ... });
```

## The migration sentinel (A-phase finding)

Auditing this phase against the route it mirrors turned up something the plan
had missed. `PUT /api/claude-code` stamps `authModeMigratedAt` on EVERY persist
of the `claudeCode` block (`agent-settings-routes.ts:1060-1069`), and its
comment explains why in terms that apply exactly to this toggle:

> The migration reads "a claudeCode block with no authMode" as a pre-upgrade
> subscriber and pins it to literal subscription — correct for a config written
> before `auto` existed, fatal for one written after. Without this, choosing
> Auto (which DELETES authMode) or merely toggling Claude on (App.tsx PUTs
> `{enabled}` alone and creates the block) would be converted into a sticky
> manual subscription by the next startServer.

"Merely toggling Claude on" is precisely what this route does. A card toggle
that created the block without the sentinel would silently convert a user's Auto
auth mode into a pinned subscription at the next restart — a failure that
surfaces far from its cause, in a subsystem this unit never mentions.

This is the concrete reason the plan says the two controls must not disagree
about what "off" means: agreeing on the FLAG is not enough, they have to agree
on the block's invariants.

**The persistence seam is not optional** (P-phase stale check, discovered
re-reading `context.ts` before building). `ManagementApiDeps` carries
`saveConfigPreservingClaudeCode` specifically so route tests with an in-memory
fixture config cannot overwrite the developer's real `OPENCODEX_HOME` — its
docstring cites the incident that put it there (devlog 260730 §070). Every
route that persists config goes through `deps.` first and falls back to the
import. A direct call would make this unit's tests capable of eating a real
config.

This is the same write `PUT /api/claude-code` already performs for the switch on
the Claude tab (`agent-settings-routes.ts:939-941`), so the two controls cannot
disagree about what "off" means.

## The config-isolation claim, corrected

Rev 1 asserted that an unrelated config edit survives the toggle. **That was
false**, and its own source said so — `saveConfigPreservingClaudeCode`'s
docstring (`src/config.ts:2132-2135`):

> Scope residual: only `claudeCode` is reconciled. A hand edit to `providers` is
> still clobbered — recorded and asserted in tests so it cannot drift into an
> assumed guarantee.

The honest statement: this toggle inherits exactly the concurrency behavior every
other `claudeCode` writer already has. It is not better and not worse, and this
unit does not fix it. A field-scoped config writer would — and belongs in the
unit that needs it for Desktop's four fields, not here.

Concurrency needs no route-level guard, and the reason is specific rather than
optimistic. `saveConfigPreservingClaudeCode` runs inside
`withConfigMutationLockSync`, which holds a SQLite `BEGIN IMMEDIATE` for the
duration (`src/config.ts:1768-1786`) — so a second PROCESS cannot interleave.
Within this process, the read-modify-save is synchronous and Bun's event loop
cannot interleave two of them.

One honest caveat: that lock uses `busy_timeout = 0`, so a contended acquisition
fails immediately rather than waiting — it throws `ConfigMutationLockError`
(`src/config.ts:1786-1793`). A cross-process collision surfaces as an error, not
as a silent lost write. The route turns GENUINE contention — the wrapped cause
carrying `SQLITE_BUSY` — into a `config_busy` refusal, and any other acquisition
failure into `write_failed`, because `ConfigMutationLockError` also covers a
lock file that cannot be opened at all (`030` §Lock contention). "Last writer
wins" would have been the wrong summary either way: the second writer does not
win, it fails.

The shared coordinator earlier revisions relied on here is gone (audit r5 #2):
it existed to protect journal bookkeeping this toggle does not write.

## Acceptance

- [ ] A config with no `claudeCode` key reads as ON — absent means enabled,
      matching the six existing read sites.
- [ ] `PUT {enabled:false}` sets the flag and `/v1/messages` answers 403.
- [ ] `PUT` of the current value returns `changed: false` and writes nothing.
- [ ] A toggle that CREATES the `claudeCode` block stamps `authModeMigratedAt`;
      a test asserts a config with no block gains the sentinel, and that a
      config already carrying one is not re-stamped.
- [ ] The card switch and the Claude tab switch agree after either is used.
- [ ] A contended config lock returns 409 `config_busy`, not a 500 and not a
      silent success (audit r7 #2).
- [ ] A lock that cannot be ACQUIRED for a non-contention reason returns 500
      `write_failed`, not `config_busy` — retrying an unopenable lock file
      fails identically forever (audit r8 #2).
- [ ] No journal row and no snapshot are written by this toggle.
- [ ] `bun run typecheck` clean; the existing Claude tests stay green.
