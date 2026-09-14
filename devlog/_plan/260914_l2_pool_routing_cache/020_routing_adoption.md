# wp2 — configured routing is not adopted routing (#4550)

## What the report establishes

A Codex CLI thread kept returning `usage_limit_exceeded` while a healthy secondary account sat
in the pool. Thread-correlated diagnostics show those turns dialing
`wss://chatgpt.com/backend-api/codex/responses` directly, with no matching proxy usage record,
while `ocx status` reported `routing=opencodex-local`. The reporter's own leading hypothesis is
retained pre-injection configuration: the process started before the route was written and has
been holding the old one ever since.

The report asks for either transport interception or an honest status. Interception is not
available to us — a client process that already resolved its endpoint is beyond the proxy's
reach, and restarting it is the operator's call. So the defect we can actually fix is the
status: it presents a fact about **config on disk** as a fact about **live traffic**.

## What status knows today

`getCodexRoutingKind()` classifies `~/.codex/config.toml` and `deriveStartupHealth` turns
`opencodex-local` into `routingInjected: true`. `formatStartupRoutingDetail` prints
`routing=<kind>, service=…, shim=…`. Every input is a file read. No part of that chain can
distinguish a client that adopted the route from one that predates it.

## The evidence we do have

Both halves already exist in this repository:

- **When the route was written.** `src/codex/journal.ts` records our injection and stamps it,
  and the journal file is rewritten on every injection, so the newer of the recorded timestamp
  and the journal's mtime bounds when the current route became effective.
- **When each client started.** `src/codex/app-server-processes.ts` already enumerates
  processes cross-platform and reads start times (`readProcessStartMs`,
  `readProcessStartMsBatch`, `/proc/<pid>/stat` on Linux, `ps -o lstart` on macOS,
  `Win32_Process.CreationDate` on Windows), and its `ProcessSnapshot` already carries an
  optional `startedAtMs`.
- **Which processes are Codex clients.** `src/codex/native-profile-processes.ts` carries the
  matching rules — direct `codex` basenames plus interpreter-wrapped `node|bun codex.js`
  entrypoints — but they are private and reachable only through a *count*. The count is enough to
  answer "is Codex busy" and not enough to name a stale PID, so those rules are extracted into an
  exported predicate and the existing counter is rewired through it. Copying them into a second
  module is how `#2457` happened; one predicate, two callers.

A Codex client whose start time precedes the injection cannot have read the injected route.
That is a sound inference, and it is the one the operator needed.

## Shape

A new leaf module `src/codex/routing-adoption.ts`, so the derivation is pure and testable and
the wiring into shared files stays small:

```ts
type RoutingAdoption = "not-applicable" | "adopted" | "pending-client-restart" | "unknown";
deriveRoutingAdoption({ routingKind, injectedAtMs, clients }): RoutingAdoptionEvidence
collectRoutingAdoption(...): RoutingAdoptionEvidence   // journal + process enumeration
```

- `not-applicable` — routing is not ours to speak for (native or custom).
- `adopted` — routing is `opencodex-local` and every running Codex client started after the
  injection. This is still an inference about *opportunity*, not a traffic observation, and the
  wording must not overclaim.
- `pending-client-restart` — at least one running Codex client predates the injection.
- `unknown` — no injection time, or process start times unreadable. Enumeration failure reports
  `unknown`; it never invents a clean bill of health, matching the `#476` restart contract.

Clock coarseness matters: `ps lstart` is second-granularity, and `app-server-processes.ts`
already documents why its equivalent comparison uses `<=`. A client started in the same second
as the injection is treated as **not** stale, so a rounding artifact cannot produce a false
warning.

`formatStartupRoutingDetail` gains an adoption token, and the summary names the concrete
action — restart the affected client — rather than only the routing kind.

## Regression test

A pure-derivation test: a pre-injection client yields `pending-client-restart` with that PID
listed; a post-injection client yields `adopted`; a missing injection time or an unreadable
start time yields `unknown`; a same-second start is not stale; a non-opencodex routing kind is
`not-applicable`; and the formatted detail string differs between configured and adopted.
