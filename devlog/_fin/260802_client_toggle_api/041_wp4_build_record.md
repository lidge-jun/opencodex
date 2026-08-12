# 041 — WP4 build record

What actually happened while implementing `040_wp4_management_api.md`, kept
because two of it were defects the plan could not have predicted and the next
work package inherits both lessons.

Landed as `135133683`:

- `src/server/management/integration-routes.ts` (new)
- `src/server/management-api.ts` — one import, one `??` dispatch slot
- `tests/management-integration-routes.test.ts` (new, 18 tests)

`model-rows.ts` and `model-routes.ts` were listed in §1.1 as WP4 files but had
already been extracted in an earlier commit, so this work package touched
three files rather than five. That is a plan/reality difference worth naming
rather than quietly satisfying.

Gates: `bun run typecheck` clean, `bun run privacy:scan` passed, `bun run test`
7238 pass / 7 skip / 0 fail.

## Defect 1 — a test wrote a real file in the user's home

**Bun's `os.homedir()` snapshots the real home at process start and ignores a
later `process.env.HOME` assignment.** Verified directly:

```
$ bun -e 'process.env.HOME="/tmp/x"; console.log(require("node:os").homedir())'
/Users/jun
$ HOME=/tmp/x bun -e 'console.log(require("node:os").homedir())'
/tmp/x
```

The first draft of the route suite redirected `process.env.HOME` to a temp dir
and believed it was isolated. It was not: `INTEGRATION_CLIENTS.hermes` resolved
the real home, and the apply test created `~/.hermes/config.yaml` — a real file
in the user's real home, 331 bytes, pointing Hermes at the local proxy.

Recovery: the file was preserved and moved out of `~/.hermes` into
`.tmp/incident-260802-hermes/` (gitignored scratch, per AGENTS.md). Hermes had
no prior config there — the file was created by the test, not overwritten over
a user's own — so nothing of the user's was lost. No other client config was
touched: `~/.config/opencode/opencode.json` kept its 2026-06-08 mtime, and the
other four client paths did not exist before or after.

Fix: the writer, the state reader and the registry all already accepted
`env`/`home` explicitly; only the route had no way to pass them. It gained
`setIntegrationPathTestHooks({ env, home })`, spread into every registry-
resolving call through `pathOverrides()`. `setIntegrationMutationFlightTestHooks(null)`
clears it too, because a cleared flight map with a live temp home would be a
worse trap than either alone.

**The rule this produces for WP5-WP7: rewriting `HOME` is not isolation in
Bun. A test that wants a different home must pass one.**

## Defect 2 — the journal advertised undo for bytes that were gone

`JournalEntry.snapshot` is the tag as it was AT WRITE TIME. Retention deletes
snapshot files later and deliberately leaves the row untouched, because the row
is immutable history. The journal route copied `operation.snapshot.kind` into
its response, so after eleven operations the oldest row still reported
`snapshot: "stored"` while its file had been collected: the GUI would render an
undo button, and pressing it would answer `410 integration_snapshot_expired`.

Fix: the route resolves through `store.readSnapshot(operation).kind`, which is
the same resolver the restore preflight uses. That is what keeps the list and
the action agreeing about the same file.

## Activation notes

The store-isolation test seeds a real store (records, journal, snapshot,
maintenance marker), drives apply → disable → restore → collection GET through
the routes with a temp-rooted store, then compares the seeded root
byte-for-byte. It was driven red on purpose: replacing `integrationStore()`
with an unconditional `createIntegrationStateStore()` fails it, and the pass
returns when the seam is restored.

`bun devlog/_plan/260802_client_toggle_api/tools/check-blocks.ts` stays clean;
the §4 body was taken from the compiled block rather than retyped, which is the
whole reason that tool exists.

## A-gate round 1 — FAIL, and what it caught

An independent sol-medium audit returned FAIL with six MAJORs. Five were real
and are fixed; one was a plan/code contradiction that had to be decided rather
than patched. The pattern in almost all of them is the same: **the code was
right and the test could not tell.**

### Fixed in code

1. **Drift refusal bypassed the recovery serializer.** The restore handler
   special-cased `drift_requires_confirm` with a hand-written envelope that
   dropped the writer's `message` — the only field that says which file
   drifted and where its backup is. Every refusal now leaves through
   `writerFailureResponse`.
2. **`writerFailureResponse` took a structural echo instead of `WriteRefused`.**
   Its local shape made `message` optional, which is precisely what let (1)
   compile. It now takes the writer's own type, so the compiler objects.

### Fixed in tests — four assertions that could not fail

3. **Reason-vs-state routing was never activated.** Every refusal fixture had
   `reason` equal to `state`, so reverting to state-first routing would have
   left all 18 tests green. Two new tests make the journal append fail after a
   successful file write: the writer returns `write_failed` while the state is
   `current`, and a second one fails the rollback too and asserts
   `residual: true` with a snapshot path.
4. **Stale-flight cleanup was not activated.** The replacement was awaited to
   completion before the stale flight was released, so there was no live
   replacement for the stale `finally` to evict. Both flights are now in the
   air simultaneously. Driven red by deleting the identity check.
5. **The isolation test watched the wrong directory.** It compared a second
   temp store, which says nothing about the default
   `~/.opencodex/integrations` a lost seam would actually write to. It now
   inventories the real default root before and after, and asserts the
   collection read is bound by requiring `current` — a state only reachable if
   the ownership record from this transaction was found.
6. **CSRF ordering was assumed, not tested.** The test called
   `requireManagementAuth` itself and then declined to dispatch, which proves
   the helper works and nothing about ordering. A new test starts a real
   listener and lets an unauthenticated mutation try to reach the route: 401,
   no file, no journal row, plus the authenticated control and the
   cross-origin 403 the roadmap asked for and the suite had omitted.

### Decided rather than patched

§3.2's "exact" bodies predate `006 §4`, which makes `message` a REQUIRED field
of `WriteRefused` and requires recovery fields to survive routing. The two
documents contradicted each other and the auditor was right to refuse to guess
which won. `006` is authoritative; §3.2 now says so explicitly and marks which
rows are exact as written (validation and admission) and which additionally
carry the writer's recovery fields.

§1.1's "WP4 changes exactly five files" was also inaccurate: `model-rows.ts`
and `model-routes.ts` landed in WP1, so the WP4 commit touches three. The
wording now says cumulative scope instead of pretending otherwise.

Suite after remediation: 21 tests, up from 18.
