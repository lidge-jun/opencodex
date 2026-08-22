# 031 — Instrument the retry envelope before widening it (F4)

**Depends on:** 030. This is a genuine dependency: there is nothing to count
until the primitive exists.

## Change

Count, do not change behavior.

Add to `src/lib/windows-atomic-replace.ts` (the module created in 030) a
module-scope counter keyed by `(code, publisher)` where `code` is the
`ErrnoException.code` that triggered the retry and `publisher` is a caller-
supplied string literal — `"config"`, `"prompt-journal"`,
`"config-ownership"`. Two counts per key: `retried` and `exhausted`.

Export `readWindowsReplaceRetryCounters()` returning a plain snapshot object.

Surface it through `handleSystemRoutes` in
`src/server/management/system-routes.ts:49`, which is where process-level
diagnostics already live. Add a sibling endpoint rather than extending the
existing one: `GET /api/system/windows-replace-retries` returning
`{ counters: { [key]: { retried, exhausted } } }`. `/api/system/memory`
(line 51) returns a memory-shaped payload and appending unrelated counters to it
would make both harder to consume.

The counters are process-lifetime and in-memory; they reset on restart, and that
is acceptable because the question is "does this ever fire at all", not "how
often per hour".

Route test: `tests/system-routes.test.ts` does not exist — current
`handleSystemRoutes` coverage is spread across `tests/memory-watchdog.test.ts`
(line 171) and `tests/codex-restart-route.test.ts` (line 11). Create
`tests/system-routes.test.ts` for this endpoint: assert the snapshot shape, and
assert that a simulated retry driven through the injected `AtomicRenameIO` from
030 increments the expected key.

**Naming constraint:** the `publisher` value must be a fixed literal chosen at
the call site and never derived from a path, because a path can contain a
username.

`privacy:scan` does **not** enforce that. It is a textual scanner over file
content (`scripts/privacy-scan.ts:187`) matching home paths, emails and token
shapes; it cannot see that a runtime value was path-derived. Enforce it in the
type system instead: declare a closed union

```ts
type ReplacePublisher = "config" | "prompt-journal" | "config-ownership";
```

and type the counter API to accept only that. A path-derived string then fails
`bun run typecheck` rather than passing a scan. Add a test asserting the
snapshot's keys are a subset of the union. Keep `privacy:scan` in the verify
block as a backstop for the endpoint's response, not as the mechanism.

## How the evidence is actually collected

In-memory counters cannot prove anything "across a release" on their own, so
the collection path is explicit:

- Local: run the proxy through a normal session, hit the diagnostics route,
  read the snapshot. Zero across ordinary use is itself a data point.
- CI: **not in this phase.** The counters are process-local, and the Windows
  suite runs across four sharded runners in many short-lived processes, none of
  which exposes an endpoint to query. Making "stayed zero across the suite" a CI
  assertion needs a suite finalizer that aggregates per-process state and a
  workflow step to collect it — a design of its own, not a line in this phase.
  What CI covers here is the route test above, nothing more.
- Field: only if a user voluntarily includes a diagnostics snapshot in a bug
  report. We do not collect this, and nothing in this phase transmits anything.

So the evidence comes from local runs and voluntary bug reports, not from CI.
That is thinner than it first looked, and it is the honest description: this
phase can show the counters firing, but it cannot prove a negative at scale
without the aggregation work above.

If no evidence appears within a release cycle, 032 does not happen and this
closes NOOP. That is a legitimate outcome.

## Verify

```powershell
bun run typecheck
bun run privacy:scan
bun test tests/config.test.ts
bun test tests/system-routes.test.ts
```

## Risk

Low. No behavioral change to the retry path itself. The privacy surface is the
only thing worth reviewing.
