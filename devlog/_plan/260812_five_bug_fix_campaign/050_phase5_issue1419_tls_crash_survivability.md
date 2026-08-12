# 050 — Phase 5 (#1419): a transient TLS failure must not take the process down

Depends on: 010-040 landed, because this phase is the one whose terminal
outcome may legitimately be a disposition rather than a fix, and it should not
block the four provable fixes.

## What the evidence supports, and what it does not

Reported: `EXC_BREAKPOINT / SIGTRAP` on the main thread ~0.5-0.6s after a
connection reset followed by `unknown certificate verification error`, twice,
with matching Bun image UUID and matching main-thread stack offsets. The
dashboard died with the proxy because `ocx gui` serves it from the same process.

External research (`001`, Lane C):

- **No** `oven-sh/bun` issue establishes that TLS verification failure or a
  socket reset aborts with `SIGTRAP`/`EXC_BREAKPOINT`.
- Current stable Bun is `1.3.14` (2026-05-13) — the version in the report. There
  is **no newer stable release to upgrade into**, so "bump Bun" is not available
  as a fix.
- Adjacent known defects are hangs and `ECONNRESET`, not aborts.

So the honest position is: we cannot presently attribute the trap to an
OpenCodex JavaScript path, and we cannot close it by a runtime bump. The
maintainer has already asked the reporter for the full faulting frame list,
which is the correct discriminator between Bun's TLS/fetch implementation and
JavaScriptCore's unhandled-exception path.

**This phase therefore does not claim to fix the native trap.** It does the
part that is within our authority and is independently valuable.

## The repository already knows this failure family

`src/lib/abort.ts`:

> Bun's HTTP client, when a `fetch(..., { signal })` is aborted AFTER the
> response resolved, tears down the response body stream and rejects any
> in-flight internal read. If our code hasn't attached a reader yet ... Bun
> reports it as `unhandledRejection: TypeError: null is not an object`
> (native-only stack) — **uncatchable by any caller try/catch**.

`cancelBodyOnAbort` exists precisely to absorb that orphaned rejection by making
us the consumer that settles the body. `src/lib/eventstream-decoder.ts:211`
carries the same note. This is direct in-tree evidence that Bun can surface
**uncatchable** failures originating in HTTP/TLS teardown, and that the working
mitigation is to ensure *we* settle every stream we open rather than relying on
`try/catch`.

That gives a concrete, testable work item that does not depend on reproducing
the trap.

## Scope

IN

1. **Audit every `fetch` in the request path for an unsettled body on the
   failure branch.** Any site that awaits `fetch()` and can leave `response.body`
   without a consumer when an error or abort intervenes is a candidate for the
   same orphaned-rejection class `cancelBodyOnAbort` was written for. Each site
   found gets the existing helper applied — reusing the established mitigation,
   not inventing a second one.
2. **Process-level last-resort observability.** A top-level
   `process.on("unhandledRejection")` / `uncaughtException` handler that logs an
   actionable OpenCodex-side diagnostic (redacted per `privacy:scan` rules — no
   URLs with credentials, no bodies) before the runtime decides the process's
   fate. This cannot stop a native `SIGTRAP` — nothing in-process can — but it
   converts the currently-silent JS-attributable subset into a named error, which
   is exactly what the issue asks for as its minimum bar: "at minimum exit with
   an actionable OpenCodex error."
3. **Supervision/restart hardening**, only if the service layer does not already
   provide it. `src/service.ts` is inspected first; if a supervised restart path
   exists, the work is to verify it covers abnormal termination (signal death,
   not just `process.exit`) and to record that finding rather than add a second
   mechanism.

OUT

- Claiming the trap is fixed.
- Vendoring or patching Bun.
- Pinning a Bun version (no newer stable exists).
- Disabling TLS verification anywhere, under any flag. A "fix" that weakens
  certificate verification to avoid a crash trades a liveness bug for a security
  defect and is refused outright.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

For the body-settling work: drive a request whose `fetch` resolves and is then
aborted before a reader attaches, against a local test server, and assert the
process emits no unhandled rejection and the proxy still answers a subsequent
request. The "still answers afterwards" assertion is the one that proves
survival rather than mere absence of a log line.

For the diagnostic handler: install it, trigger a synthetic unhandled rejection
in a child process running the real entry point, and assert the emitted
diagnostic names the OpenCodex-side context and contains no credential material.

For supervision: kill a running instance with `SIGTRAP`/`SIGKILL` and observe
whether the supervisor restarts it and whether the dashboard becomes reachable
again — this is the observable that maps directly to the reporter's experience.

## Terminal-outcome policy for this phase

- If the audit finds a real unsettled-body site in the request path → fix it,
  regression-test it, land it, and report #1419 as **partially addressed** with
  the specific path named. The issue stays open pending the crash frames.
- If the audit finds none → the deliverable is the diagnostic handler plus a
  documented disposition comment on the issue stating what was checked, what the
  external research established (no known Bun fix, already on newest stable),
  and precisely which frames would settle attribution. Outcome: **NEEDS_HUMAN**
  on the root cause, with the survivability work landed on its own merits.

Either way, the issue is **not** closed by this unit unless a real in-tree cause
is found and fixed. Closing a crash report without a reproduction or a proven
cause would be exactly the "evidence-free closure" the repository's triage rules
forbid.

## Accept criteria

1. The `fetch`-site audit is complete and recorded, naming every site checked
   and its settle path.
2. Any unsettled-body site found is fixed and covered by a regression test that
   asserts a subsequent request still succeeds.
3. The diagnostic handler emits an actionable, credential-free message.
4. `bun run privacy:scan` exit 0.
5. `bun run typecheck` exit 0; server/service suites green on `ssh lidge`.
6. #1419 receives either a PR link or an evidence-backed disposition comment.

## Verification commands

```bash
bun x tsc --noEmit
bun run privacy:scan
bun test tests/server*.test.ts tests/service*.test.ts tests/abort*.test.ts
```

## Delivery

Branch `codex/1419-tls-failure-survivability` if code lands; otherwise a
disposition comment on the issue with the audit table.
