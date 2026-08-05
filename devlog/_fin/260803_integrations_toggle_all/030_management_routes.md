# WP3 — the routes the cards call

> **Rev 6** after audit round 5 (`008_audit_synthesis_r5.md`). The unit is Claude
> Code and Grok only, and neither writes a journal row or a snapshot — so the
> journal route, the restore route, the `partial` response and every
> snapshot-shaped field are gone. Rev 6 also drops the shared **coordinator**:
> with no shared bookkeeping left it protected nothing, and replacing the file
> clients' flight map would have changed their join semantics. What survives is
> the status read, the refusal envelopes and a per-client guard. This is WP3.

## IN

1. `src/server/management/native-integration-routes.ts` — MODIFY: the module
   WP1 creates. This phase adds `GET /api/native-integrations` and the shared
   refusal envelopes; the two PUTs belong to WP1 and WP2.
2. `tests/native-integration-routes.test.ts` — NEW: the `GET` contract and every
   refusal row.

OUT: `src/server/management/integration-routes.ts` and
`src/integrations/**` — the file clients' routes and flight map are NOT touched
by this unit (audit r5 #2). `src/integrations/mutation-lock.ts` moves to the
sibling unit with the coordinator.

**Route-module ownership, stated once:** WP1 CREATES
`native-integration-routes.ts` with Claude Code's PUT. WP2 and WP3 MODIFY it.
Three docs previously each claimed to create it (audit r5 #4).

OUT: `/api/client-integrations/*` — the six file clients keep their routes
unchanged. `/api/claude-code` and `/api/claude-desktop/*` stay for the pages that
own the detailed settings; this module is the toggle surface only.

## Why a new module rather than more branches in `agent-settings-routes.ts`

That file is already ~1100 lines carrying Grok selection, Desktop profiles,
Claude Code settings, subagent flags and feature toggles. Four more branches
would be four more reasons to open it. The new module has one job — enable and
disable a native integration — and its tests can say so.

## Surface

```
GET  /api/native-integrations          → { clients: NativeStatus[] }
PUT  /api/native-integrations/:client  { enabled: boolean }   // claude | grok
```

**There is no restore route.** Undo for both clients is the PUT in the other
direction: Claude Code flips its flag back, Grok regenerates its fence. A
`/restore` endpoint would imply an operation record neither client keeps, and
four audit rounds went into establishing they do not need one. The Rollback
Centre continues to serve the six file clients only.

`GET` also carries each client's non-mutating preflight result, so the GUI can
disable a switch that would be refused instead of opening a dialog and then
failing (audit r4 #8):

```ts
interface NativeStatus {
  clientId: "claude" | "grok";
  state: "absent" | "current" | "unsafe";
  installed: boolean;
  configPath: string;
  /** Non-null when a disable would be refused right now, with the reason. */
  disableBlocked: { reason: NativeRefusalReason; message: string } | null;
}
```

`GET` composes the two reads the overview already makes for these clients
(`/api/claude-code`, `/api/grok`) into one payload shaped like the file
clients'. The GUI keeps its per-client reads for the DETAIL lines it already
renders — auth mode, model count — and uses this one for the switch state, so
WP4 does not have to rewrite the row model already shipped.

Field meanings, which differ per client and must not be guessed:

| Field | Claude Code | Grok |
|---|---|---|
| `installed` | always true — the surface exists wherever the proxy does | `GROK_HOME` exists |
| `state` | `current` when the flag is on, `absent` when off | `current` when our fence is present, `absent` when not, `unsafe` on an orphaned marker |
| `configPath` | opencodex's own `config.json` | the resolved `~/.grok/config.toml` |
| `disableBlocked` | always null — nothing can refuse this disable | set for `home_mismatch` or `orphaned_marker` |

`disableBlocked` is advisory: it comes from `inspectGrokConfig` at read time and
a file can change before the PUT. The same inspector runs again inside the PUT,
in BOTH directions, and THAT result is authoritative (`012` §In PUT it is the
authoritative preflight). An orphaned marker therefore blocks an enable too, not
just a disable — the field name reflects the common case, not the whole gate.


## Refusal envelopes

Same shape as the file clients', because the GUI already has
`describeRefusal` and `isIntegrationRefusalEnvelope` for it. Reusing the shape
means the dialog and the notice area need no second code path.

| HTTP | `code` | `reason` | Trigger |
|---|---|---|---|
| 409 | `native_integration_refused` | `orphaned_marker` | Grok begin marker without an end marker |
| 409 | `native_integration_refused` | `home_mismatch` | installed service's recorded home differs (raised by the WP2 preflight, not by the CLI path) |
| 404 | `native_integration_refused` | `not_installed` | client absent |
| 500 | `native_integration_failed` | `write_failed` | genuine IO failure, nothing changed |

`orphaned_marker` and `home_mismatch` are 409, not 500: nothing failed, we
declined. A 500 would tell the GUI to say "try again", which is precisely the
wrong advice for both.

**`non_loopback` is deliberately NOT in this table.** Enabling Grok under a
non-loopback bind removes any stale generated block, so it is a 200 outcome, not
a refusal claiming nothing happened (`012` §non-loopback is not a refusal). It
sat here as a 409 through two revisions; round 6 caught the table still
contradicting the prose below it.

Two 200 outcomes, chosen by inspecting the file AFTER the write:

| `state` | `reason` | Meaning |
|---|---|---|
| `absent` | `non_loopback_removed` | no fence remains — the normal case |
| `current` | `non_loopback_superseded` | a well-formed fence arrived from elsewhere between our strip and our read |

The second is rare and exists because the alternative is worse: reporting
`absent` over a fence the route had just observed. **Every `state` this module
returns is derived from the last read, never from what the operation intended**
(audit r9).

`stripGrokConfig` writes atomically and Claude Code writes one config field, so
neither client has a half-applied state to report. The `partial` outcome earlier
revisions carried belongs to the sibling unit, where Codex and Desktop can
genuinely produce one.

## Concurrency: a per-client guard, not a coordinator

Earlier revisions introduced one resource-keyed coordinator shared with the file
clients, to protect journal bookkeeping both route families touched. **After the
re-scope there is no shared bookkeeping left**: neither native toggle writes a
journal row or an ownership record. The coordinator moves to
`../260803_codex_desktop_toggle/`, which has real cross-client state to
coordinate.

Round 5 also found the claim that replacing `integration-routes.ts`'s flight map
would "preserve the same busy-409 behavior" to be false. That map JOINS an
identical in-flight operation rather than refusing it, and expires stale flights
after ten minutes (`integration-routes.ts:146`). A plain mutex refuses the second
caller — a behavior change I asserted away instead of declaring. Rewriting a
contract the file clients already implement correctly, for no remaining benefit,
is risk without payoff. **The file-client routes are not touched by this unit.**

What is left is small and per-client:

| Operation | Guard |
|---|---|
| Grok toggle | a single-flight promise keyed `grok`; a second concurrent PUT gets 409 busy |
| Claude Code toggle | the existing config mutation lock inside `saveConfigPreservingClaudeCode` |

Claude Code needs no route-level guard. Within this process the read-modify-save
is synchronous and Bun's event loop cannot interleave two of them; across
processes `withConfigMutationLockSync` holds a SQLite `BEGIN IMMEDIATE`
(`src/config.ts:1768-1786`). Grok needs a guard because two overlapping strips
of the same file would race on bytes.

### Lock contention is an outcome, not last-writer-wins

Earlier revisions said contention resolves as "last writer wins". That is wrong
and round 7 caught it: the lock runs with `busy_timeout = 0`, so a contended
acquisition does not wait — it throws `ConfigMutationLockError`
(`src/config.ts:1786-1793`). Nobody wins; the second writer fails.

That failure needs its own envelope, or an implementer has to invent one:

| HTTP | `code` | `reason` | Trigger |
|---|---|---|---|
| 409 | `native_integration_refused` | `config_busy` | `ConfigMutationLockError` whose `cause.code === "SQLITE_BUSY"` |
| 500 | `native_integration_failed` | `write_failed` | any other `ConfigMutationLockError` — the lock itself is broken |

**The class alone does not mean contention** (audit r8 #2).
`ConfigMutationLockError` carries a constant `code`
(`CONFIG_MUTATION_LOCK_UNAVAILABLE`, `src/config.ts:1716`) and wraps EVERY
acquisition failure: a database that cannot be opened, a path that cannot be
created, an ACL that cannot be set, as well as real contention. Only the
`cause` distinguishes them:

```ts
function isContention(error: ConfigMutationLockError): boolean {
  const cause = error.cause as { code?: unknown } | undefined;
  return cause?.code === "SQLITE_BUSY";
}
```

`cause.code` is verified present, not assumed. Two Bun connections holding
`PRAGMA busy_timeout = 0; BEGIN IMMEDIATE` on the same file produce:

```
name: SQLiteError | code: "SQLITE_BUSY" | errno: 5 | msg: database is locked
```

`src/config.ts:1787-1790` already reads that same `code` off the cause to pick
its message, so the discriminator this contract needs is the one the lock itself
uses. Match on `code`, never on the message text.

Mapping the whole class to 409 would tell a user to retry a lock file they
cannot open — advice that fails identically forever. Contention is 409 and
retryable; a broken lock is a 500 and is not.

In both cases the target mutation has NOT run: acquisition happens before the
callback (`src/config.ts:1768-1798`), so "nothing was written" holds either way.

`config_busy` is the one refusal in this unit where "try again" is correct
advice — unlike `orphaned_marker`, where retrying is exactly what cannot help.

## Acceptance

- [ ] `PUT` both directions for each of the two returns its outcome status.
- [ ] Each refusal row above returns its exact status, `code` and `reason`.
- [ ] Enabling Grok under a non-loopback bind returns 200 with
      `non_loopback_removed`, not a refusal (audit r5 #1).
- [ ] No route in this module appends a journal row or writes a snapshot.
- [ ] `GET` carries `disableBlocked` from the read-only inspector, and the doc
      says plainly that it is advisory — PUT re-checks and its refusal wins.
- [ ] `GET` field meanings match the per-client table: Claude Code is always
      `installed`, Grok's `unsafe` means an orphaned marker.
- [ ] Concurrent PUTs to the SAME client: Grok's second gets 409 busy.
- [ ] A held config transaction makes Claude Code's PUT return 409
      `config_busy` — asserted with a real second connection holding the lock,
      not a mocked throw (audit r7 #2).
- [ ] Grok's enable re-inspects after the catalog fetch: a test orphans the file
      inside a stubbed fetch and asserts a refusal, not `absent` (audit r7 #1).
- [ ] `src/server/management/integration-routes.ts` is unchanged by this unit —
      asserted by the diff, since round 5 found the "preserves behavior" claim
      about replacing its flight map to be false.
- [ ] `GET` reports `installed: false` for an absent client rather than erroring.
- [ ] `bun run privacy:scan` clean — no config content or key in any response.

## wp3-cycle A-gate folds (reviewer: PASS-WITH-NITS, 0 blockers)

All accepted, none rebutted:

1. The real-lock test's retry half must use a FRESH config object: the route
   mutates the in-memory config before persistence, so a refused toggle leaves
   the in-memory flag already flipped and a same-object retry short-circuits
   at the idempotent guard without ever re-acquiring the lock. (Side note,
   recorded as a known residual: that ordering also leaves live config
   diverged from disk after a refused toggle until restart — pre-existing wp1
   behavior, out of this unit's scope.)
2. The test restores `OPENCODEX_HOME` in afterEach and puts the holder
   connection's ROLLBACK/close in `finally` (the grok file's pattern).
3. Three acceptance-coverage gaps in the shipped tests, folded into wp3:
   Claude's enable-WITH-CHANGE direction (`enabled:false` → PUT `true` → 200 /
   `changed:true` / `current`); the refusal envelope's `code` field asserted
   alongside status and reason (`native_integration_refused` vs
   `native_integration_failed`); Claude's GET row asserting `installed: true`.
