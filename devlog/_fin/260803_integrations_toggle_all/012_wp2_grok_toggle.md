# WP2 — Grok Build

> **Rev 2** after audit round 4 (`007_audit_synthesis_r4.md`). The journal and
> snapshot machinery is GONE from this phase. Round 4 forced the question I had
> been avoiding: what is Grok's undo, actually?

## Undo is the enable path

Turning Grok back on regenerates the fence from the current catalog — the same
work `syncGrokConfig` does, though the route calls `injectGrokConfig` directly
for a reason given below (§One preflight is not enough). That is the undo. It is also strictly better
than replaying a snapshot: a snapshot from an hour ago carries a stale model
list, while the enable path writes what the proxy serves right now.

Rev 1 planned a byte snapshot anyway, reasoning that the file IS the
integration. Re-examined: the snapshot was never the undo mechanism. It was
insurance against a botched strip — and `stripGrokConfig` is already
fence-scoped, already preserves user bytes outside the markers verbatim, already
restores the file's dominant EOL, and already refuses outright when the fence
boundary is ambiguous (`001` §Grok). Insurance against a writer that careful,
for a file whose contents we can regenerate, is machinery without a job.

What the byte snapshot WOULD have protected — a user's hand edits inside our
fence, or the exact fence bytes from before a catalog change — is content we
deliberately own and rewrite on every sync. Restoring it would fight the writer.

So this phase carries no journal row and no snapshot either.

## IN

1. `src/server/management/native-integration-routes.ts` — MODIFY (created in
   WP1): add `PUT /api/native-integrations/grok` and Grok's `GET` row.
2. `src/integrations/native/ownership-preflight.ts` — NEW: the service-home
   check that makes `home_mismatch` reachable (audit r1 #5).
3. `src/grok/inspect.ts` — NEW: the non-mutating inspector (below).
4. `src/grok/inject.ts` — MODIFY: export `findManagedRegion` as an internal API
   so the inspector shares it (audit r6 #3). One exported parser, not a second
   copy — two parsers for one fence is how a strip eventually removes the wrong
   bytes. Nothing else in the writer changes.
5. `tests/native-grok-toggle.test.ts` — NEW.

## A read-only inspector, because GET must not mutate

`030`'s `disableBlocked` needs to know whether a disable would hit
`orphaned_marker` — but the only code that can answer that today is
`stripGrokConfig`, which writes, and its boundary parser `findManagedRegion` is
private (`src/grok/inject.ts:49`). An implementer would have had to invent the
contract (audit r5 #3).

```ts
// src/grok/inspect.ts — NEW

export type GrokInspection =
  | { kind: "absent" }            // no fence, or no config file
  | { kind: "present" }           // a well-formed fence we own
  | { kind: "not_installed" }     // no GROK_HOME
  | { kind: "orphaned_marker" };  // begin without end — a disable would refuse

/** Reads. Never writes. Shares `findManagedRegion` with the writer so the two
 *  can never disagree about where our block starts and stops. */
export function inspectGrokConfig(opts?: { grokHome?: string }): GrokInspection;
```

`findManagedRegion` is currently private to `inject.ts` (`src/grok/inject.ts:49`)
and ES modules cannot share an unexported symbol, so WP2 exports it. It stays an
internal API — the inspector and the writer are its only callers.

**In GET it is advisory.** A file can change between the GET and the PUT, so
`disableBlocked` cannot promise the PUT will succeed. It exists to avoid
offering an action we already know is blocked, not to replace the check.

### In PUT it is the authoritative preflight — for BOTH directions

This is the fix for a defect round 6 found one branch below the one round 5
found (audit r6 #4).

Enabling under a non-loopback bind calls `stripGrokConfig` first. If the file
holds a begin marker with no end marker, that strip returns
`ok: false, skippedReason: "orphaned-marker"` and changes nothing
(`inject.ts:474`) — but `injectGrokConfig` reads only `removed.changed` and
discards the rest (`inject.ts:357-363`). It then reports non-loopback success
with `changed: false`, and the fence is still sitting in the file.

Landing the card on `absent` there would be a lie: the block exists, we just
could not safely touch it.

So PUT runs `inspectGrokConfig` BEFORE calling either delegate, in both
directions, while holding the client guard:

```ts
const seen = inspectGrokConfig({ grokHome });
if (seen.kind === "not_installed") return refusal(404, "not_installed", ...);
if (seen.kind === "orphaned_marker") return refusal(409, "orphaned_marker", ...);
// disable only: shared teardown must not run under a foreign-home service
if (!enabled) { const owned = assertNativeTeardownOwned(); if (!owned.ok) return refusal(409, "home_mismatch", ...); }
```

An ambiguous fence therefore never reaches the code path that would misreport
it, and the refusal is identical whichever direction the user was heading —
which is right, because the reason is the same: we cannot tell where our block
ends.

### One preflight is not enough — `syncGrokConfig` yields

Round 7 found the hole my round-6 fix left. `syncGrokConfig` awaits
`fetchAllModels` before it ever calls `injectGrokConfig`
(`src/grok/sync.ts:37`), so the file can become orphaned in that window — by
`ocx ensure`, by `/api/grok/apply`, by a hand edit — and the route would again
report `absent` over a fence it could not touch.

A check before an `await` is a check, not a guarantee.

So the enable path re-inspects **after** the catalog resolves and immediately
before the write:

```ts
const models = await fetchCatalogForGrok(ctx);   // the awaiting part, done first
const recheck = inspectGrokConfig({ grokHome }); // authoritative: no await follows
if (recheck.kind === "orphaned_marker") return refusal(409, "orphaned_marker", ...);
return injectGrokConfig(models, ...);            // synchronous from here
```

`injectGrokConfig` is declared `function`, not `async`, and its body does only
synchronous fs work (`src/grok/inject.ts:333`). So once entered nothing yields.

**That closes the in-process gap and not the cross-process one** (audit r8 #1).
Bun's event loop cannot interleave another request between the recheck and the
write, but `ocx ensure`, a second proxy, or a hand edit can still orphan the
file in that window. Synchronicity is not exclusion.

### Where the hole actually is: one branch, not the whole writer

`injectGrokConfig` already refuses an orphaned marker correctly on its main
path — `if (originalRegion?.orphaned) return orphanedMarkerResult("injection")`
(`src/grok/inject.ts:382`). The swallowed refusal exists only in the
**non-loopback** branch above it, which calls `stripGrokConfig` and reads back
`removed.changed` while discarding `removed.ok` (`inject.ts:356-369`).

So the loopback enable — the overwhelmingly common case, and the only one that
writes a fence — is already race-safe: whatever the file looks like when the
writer reads it, that read decides.

### The fix: check the result we already have

The route does not need cross-process locking, a modified writer, or a new
delegate. It needs to stop discarding a value that is already returned:

```ts
const result = injectGrokConfig(port, models, { hostname, grokHome, excluded });
// The non-loopback branch reports its own strip only through `changed`, so a
// strip that REFUSED and a strip that found nothing are indistinguishable in
// the result. Re-inspect to tell them apart — after the write, when the file
// state is final.
if (result.skippedReason === "non-loopback") {
  // EXHAUSTIVE on purpose. An earlier draft checked only `orphaned_marker` and
  // let everything else fall through to `absent` — which would report `absent`
  // over a fence the inspection had just seen (audit r9). The reported state is
  // whatever the LAST read observed; nothing here is inferred from what we
  // intended to do.
  const after = inspectGrokConfig({ grokHome });
  switch (after.kind) {
    case "orphaned_marker":
      // Our strip declined; the ambiguous fence is still in the file.
      return refusal(409, "orphaned_marker", ...);
    case "present":
      // Someone re-installed a well-formed fence between the strip and this
      // read — `ocx ensure`, another proxy, a hand edit. It is not ours to
      // remove under a policy that just declined to write one, and calling it
      // `absent` would contradict the read.
      return ok({ changed: result.changed, state: "current",
                  reason: "non_loopback_superseded" });
    case "not_installed":
      return refusal(404, "not_installed", ...);
    case "absent":
      return ok({ changed: result.changed, state: "absent",
                  reason: "non_loopback_removed" });
  }
}
```

`non_loopback_superseded` is a rare, honest outcome rather than a refusal: the
request did what policy allowed, and the file now holds a fence that arrived
from elsewhere. The card shows `current` because that is what is on disk, and
the message says the block was not written by this request.

The rule generalises: **report the state the last read observed, never the state
the operation intended.** Every branch above ends in a value derived from
`after`, not from `result`.

The post-write inspection is authoritative because it reads the file AFTER every
write this operation performs. A later `ocx ensure` can still change things, but
that is true of any answer we give and is not a race — it is time passing.

This is deliberately the narrowest fix that is actually correct. The
alternatives the audit offered — propagating the orphan result out of
`injectGrokConfig`, or a cross-process lock over every Grok writer — both change
behavior for `ocx start`/`ensure`, whose policy skip must never block startup.
Neither belongs to a unit that adds a GUI switch.

### What the route must rebuild, exactly

Bypassing the wrapper means rebuilding what it passed. It is a short, closed
list — verified against `src/grok/sync.ts:36-66`, and if it grows, this route
has to grow with it:

```ts
// 1. Native slugs, each with its context window — without it Grok falls back to
//    its own 200k default and understates a 372k model.
const native = visibleNativeSlugs(config).map(id => ({
  id, ...(nativeOpenAiContextWindow(id) !== undefined ? { contextWindow: nativeOpenAiContextWindow(id) } : {}),
}));
// 2. Routed models, filtered by catalog visibility, keyed by alias when present.
const routed = filterCatalogVisibleModels(await fetchAllModels(config), config)
  .map(m => ({ id: m.alias ?? `${m.provider}/${m.id}`,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) }));
// 3. The FULL list plus the exclusion set — never a pre-filtered list. The writer
//    allocates aliases over everything and emits only what is switched on, so a
//    model's alias never depends on its neighbours' switches.
injectGrokConfig(port, [...native, ...routed], {
  hostname, grokHome, excluded: new Set(config.grokExcludedModels ?? []),
});
```

Point 3 is the one that would silently break: passing an already-filtered list
would make every alias depend on which models happen to be enabled, so toggling
one model would rename the others. The wrapper's own comment says so, and this
route inherits the rule rather than rediscovering it.

A test asserts the route and `syncGrokConfig` produce an identical
`GrokInjectModel[]` for the same config, so the two cannot drift.

That means WP2 calls `injectGrokConfig` directly rather than `syncGrokConfig`,
and does the catalog fetch itself — `syncGrokConfig` is precisely the wrapper
that interleaves an await between the check and the write. The catalog-building
code is small and already exported; duplicating the fence logic is what we
refuse to do, and this duplicates none of it.

The writer is still NOT modified to propagate the orphan result. That would
change `ocx start`/`ensure` behavior for a policy skip whose own comment says it
must never block startup, and this unit has no business making that call. Other
writers — startup, `ocx ensure`, `/api/grok/apply` — keep their existing
best-effort semantics; this route is stricter than them on purpose, because a
user who clicked a switch is owed a true answer and a background sync is not.

OUT: `src/integrations/journal.ts`, `store.ts`, `ownership.ts`, `registry.ts` —
all untouched. No id widening, which also retires audit r4 #7 entirely: there is
no journal surface to widen unsafely.

## The route delegates

`stripGrokConfig()` for off, and for on the catalog build plus
`injectGrokConfig()` — the two halves `syncGrokConfig` wraps, called separately
so the orphan recheck can sit between them (§One preflight is not enough).
Neither writer is reimplemented: the guards that matter — the orphaned-marker refusal, alias
reservation, byte-for-byte preservation outside the fence, the one-time
`.bak-opencodex` — all live there and a second copy would rot.

### Preflight, before either call

```ts
// Disable only. Writing our own fence is not a shared teardown.
const owned = assertNativeTeardownOwned();
if (!owned.ok) return refusal(409, "home_mismatch", owned.message);
```

`ocx stop` has honored this since it started catching `ServiceOwnershipError`
(`src/cli/index.ts:464`); nothing on the HTTP side ever did. Without it a route
calling `stripGrokConfig` directly would pull the fence out from under a service
running from another `CODEX_HOME`/`OPENCODEX_HOME`. The refusal names both
homes and does NOT tell the user to stop a service — the trigger is a home
mismatch, not a running service (`001` §The guard I described wrong).

Every `skippedReason` maps to its own outcome (`001` §Grok):

| `skippedReason` | `ok` | Outcome | Changed the file? |
|---|---|---|---|
| `no-grok-home` | true | refusal `not_installed` | no |
| `orphaned-marker` | **false** | refusal `orphaned_marker` | no |
| `non-loopback` | true | **an OUTCOME, not a refusal — `non_loopback_removed` or `non_loopback_superseded`, decided by the post-write inspection** | **possibly yes** |
| none, `ok:false` | false | refusal `write_failed` | no |

The first two are now produced by the inspector preflight, before any delegate
runs, so the table describes what a delegate CAN return rather than what the
route waits to discover.

`orphaned_marker` must never become `write_failed`. Nothing failed: a begin
marker without an end marker means we cannot tell where our block stops, so we
decline to guess. Telling the user to retry would be advice that cannot work.

### `non-loopback` is not a refusal (audit r5 #1)

I had this wrong and the reviewer caught it against the source. Enabling under a
non-loopback bind does NOT decline and leave the file alone. `injectGrokConfig`
calls `stripGrokConfig` first, removes any previously generated block, and only
then returns `ok: true, changed: true, skippedReason: "non-loopback"`
(`src/grok/inject.ts:352-362`).

The strip is correct and the comment above it explains why: a regenerated block
cannot carry the admission token a non-loopback bind needs without either
writing the user's secret into their own file or opening grok's credential
fallthrough, so a stale loopback block must go. But it means the operation
CHANGED the user's file, and reporting a 409 refusal — which `030` defines as
"nothing happened" — would be exactly the lie this unit exists to avoid.

So it is a 200 outcome:

```json
{ "ok": true, "clientId": "grok", "changed": true, "state": "absent",
  "reason": "non_loopback_removed",
  "message": "opencodex is bound to a non-loopback address, so Grok cannot be auto-registered. The previously generated block was removed because it pointed at a loopback address that no longer serves." }
```

`changed` reflects what `stripGrokConfig` actually reported: `true` when a stale
block was removed, `false` when there was nothing to remove.

The `state` does NOT follow from `changed` — it follows from the post-write
inspection (§The fix). Normally that reads `absent` and the card says Grok is
not wired up. If it reads `present`, something re-installed a fence in the
meantime and the card says `current`, because that is what is on disk.

`absent` is a READING, not an inference. The preflight keeps the orphaned case
from reaching the write at all (r6 #4), and the post-write inspection decides
what to report (r8 #1, r9). Without both, `changed: false` would also cover "a
fence we could not touch is still in the file" and `absent` would be false.

"Can no longer reach here" means through THIS route: the pre-write recheck
closes the in-process window (r7 #1) and the post-write inspection closes the
cross-process one (r8 #1). A concurrent `ocx ensure` can still orphan the file a
millisecond after we answer; no check can prevent that, and the next `GET`
reports `unsafe` when it happens.

## What the dialog must therefore say

Undo regenerates the fence rather than restoring the old bytes, so the copy in
`002` changes from "보관해 둔 파일로 되살립니다" to the truth: re-enabling
rewrites the block from the current model list. For a user that is the same
outcome — their aliases come back — but promising a byte-for-byte restore would
be a promise the writer does not make.

## Acceptance

- [ ] Disable removes only the fenced region; bytes outside it are byte-identical
      afterwards, including a trailing user section and CRLF line endings.
- [ ] Re-enable regenerates the fence and the model aliases are present again.
- [ ] Disable → enable → disable is stable: the file returns to the same
      non-fenced content each time.
- [ ] `orphaned-marker` refuses as `orphaned_marker` and writes nothing.
- [ ] `no-grok-home` refuses `not_installed`; the GET row carries
      `installed: false` (the card rendering belongs to WP4 — Rev 3 N4).
- [ ] Enabling under a non-loopback bind WITH an existing fence returns 200
      `non_loopback_removed` with `changed: true`, and the fence is gone. It must
      NOT return a refusal claiming nothing changed (audit r5 #1).
- [ ] Enabling under a non-loopback bind with NO fence returns the same outcome
      with `changed: false`.
- [ ] Enabling under a non-loopback bind with an ORPHANED marker refuses
      `orphaned_marker` and never reports `absent` — the fence is still there
      (audit r6 #4).
- [ ] The inspector runs before either delegate in BOTH directions; a test
      asserts `injectGrokConfig` is not called when the marker is orphaned.
- [ ] The enable path re-inspects AFTER the catalog fetch and immediately before
      the write, with no await in between — a test orphans the file inside a
      stubbed `fetchAllModels` and asserts the route refuses rather than
      reporting `absent` (audit r7 #1).
- [ ] The enable path ALSO inspects after a `non-loopback` result and refuses
      `orphaned_marker` when the fence survived — a test orphans the file
      between the recheck and the write and asserts the route does not report
      `absent` over a fence that is still there (audit r8 #1).
- [ ] The post-inspection switch is EXHAUSTIVE over all four inspector states;
      a test installs a well-formed fence between the strip and the read and
      asserts `current`/`non_loopback_superseded`, never `absent` (audit r9).
- [ ] In the NON-LOOPBACK outcome every reported `state` is derived from the
      post-inspection, not from the writer's result; loopback enable and
      disable report the writer's result, whose own read IS the last read
      within one synchronous operation (Rev 3 N4).
- [ ] WP2 calls `injectGrokConfig` directly, not `syncGrokConfig`; a test
      asserts the wrapper is not on this path.
- [ ] The route's model list is byte-identical to `syncGrokConfig`'s for the
      same config — native slugs with context windows, routed models by alias,
      the FULL list plus the exclusion set (not a pre-filtered list).
- [ ] A catalog-fetch failure returns a refusal rather than writing an empty
      fence: `syncGrokConfig` guards this and the route must too.
- [ ] `findManagedRegion` has exactly one definition; the inspector imports it
      rather than re-implementing the boundary scan.
- [ ] A foreign-home install-state fixture makes disable refuse `home_mismatch`
      and write nothing — the branch is reachable, not declared (audit r1 #5).
- [ ] Enabling is NOT gated by the ownership preflight.
- [ ] No journal row and no snapshot are written by this toggle.
- [ ] `bun run typecheck`, the existing Grok tests, and `privacy:scan` green.

## Rev 3 — wp2-cycle A-gate nits folded (reviewer: PASS-WITH-NITS, 0 blockers)

A fresh adversarial pass at this work-phase's own A gate verified every
load-bearing claim above against the live tree and found five spec gaps.
All five are accepted; none rebutted.

**N1 — port/hostname resolution is now specified.** The route mirrors
`runGrokApplyFlight` (agent-settings-routes.ts:99-103): the fence must name the
host and port the RUNNING process actually bound, not what config.json last
recorded — `sync.ts:24-27` warns a stale `config.hostname` picks the wrong
loopback policy branch entirely, and a port-collision auto-increment would
point the fence's `base_url` at a dead port.

```ts
const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
const port = runtime?.port ?? Number(ctx.url.port) || ctx.config.port;
const hostname = runtime?.hostname ?? ctx.config.hostname;
```

`readRuntimePort` goes behind a deps seam for the same reason the catalog fetch
does: a route test cannot be allowed to depend on the developer's real runtime
state file.

**N2 — the seams and the import cycle.** `management-api.ts` statically
imports this module, so the route must NOT statically import `fetchAllModels`
back from it — `sync.ts:18-21` already dodges that exact cycle with a dynamic
import, and this route copies the dodge. `ManagementApiDeps` gains three seams,
all defaulting to the real implementations in production:

```ts
fetchAllModels?: (config: OcxConfig) => Promise<CatalogModel[]>;
injectGrokConfig?: typeof import("../../grok/inject").injectGrokConfig;
readRuntimePort?: (pid: number) => RuntimePortState | null;
```

The first two are what make the r7/r8 acceptance tests possible (orphaning the
file inside a stubbed fetch, and between the recheck and the write). A catalog
fetch failure is a 500 refusal with reason `write_failed`: nothing was written,
and retrying is correct advice once the provider blip passes.

**N3 — two guards over one file, said out loud.** The single-flight keyed
`grok` refuses a second concurrent TOGGLE with 409 `config_busy`. It does not
join, and it does not coordinate with `runGrokApplyFlight` (`/api/grok/apply`
JOINS an identical in-flight operation rather than refusing — 030 records why
rewriting that contract is not this unit's business). Toggle-vs-apply
interleaving is therefore possible and is covered not by exclusion but by the
post-write inspection: whatever the file holds after both operations, the
reported state is the last read. Reusing `config_busy` for an in-process flight
is a deliberate widening of a reason 030 introduced for `SQLITE_BUSY`
contention — both mean "try again in a moment, nothing was written", which is
the only thing the GUI does with it.

**N4 — two acceptance items rescoped to what a test can assert:**

- "Every reported `state` is derived from the post-inspection" applies to the
  NON-LOOPBACK outcome, where the writer's result is genuinely ambiguous. The
  loopback enable and the disable report the writer's result, which is
  equivalent within one synchronous operation — the writer's own read IS the
  last read. Item reworded accordingly.
- "`no-grok-home` refuses `not_installed`; the card reads not-installed" splits
  into its wp2-testable half: the GET row carries `installed: false`. The card
  belongs to WP4.

**N5 — citation corrected:** the strip orphan refusal is inject.ts:473, not 474.
