# 020 — WP2: 401 re-bootstrap deadline + abort-aware resolution (H2)

Base: `codex/gui-resource-deadline` (WP1). Branch: `codex/gui-auth-unwedge`.

## Goal

The session re-bootstrap can never pin the page. The silent bootstrap fetch gets a
deadline; the shared `resolutionInFlight` wait becomes per-caller abort-aware; a
failed/timed-out resolution clears so later requests retry instead of joining a
poisoned page-lifetime promise. Measured target: repeat 001/E2 — after the
bootstrap deadline expires, /api/* traffic resumes against the healthy server with
NO reload.

## File change map

- MODIFY `gui/src/api.ts` — all changes below (single-file unit).
- NEW `gui/tests/api-auth-deadline.test.ts` — regression tests (harness modeled on
  tests/api-auth-memory.test.ts, which already stubs rawFetch via
  resetApiAuthFetchForTests).

No UI copy, no server changes. `promptForAdminToken` UX unchanged.

## Change spec (gui/src/api.ts)

### 1. Constants + test hook

```ts
/** Silent re-bootstrap must fail fast: every /api/* request queues behind it (H2). */
const SESSION_REBOOTSTRAP_TIMEOUT_MS = 10_000;
```

Module-level `let rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;` and extend
`resetApiAuthFetchForTests` to also restore this default; add
`setRebootstrapTimeoutForTests(ms)` (same test-only pattern as the existing reset).

### 2. Bounded bootstrap with a TRI-STATE result (audit #2 — the load-bearing fix)

Before: `rawFetch(SESSION_REBOOTSTRAP_PATH, { cache: "no-store" })` — no timeout,
no signal; and `null` from this function means "server won't mint" → prompt.

After: `reBootstrapSessionToken(): Promise<"minted" | "unavailable" | "failed">`
(no caller-signal param — audit #12: the shared body must not take any single
caller's signal):

- The rawFetch carries the bounded signal via `createBoundedFetch(rebootstrapTimeoutMs)`
  (bounded-fetch.ts — the existing owner of the timeout-compose pattern).
- `"minted"` — session stored (existing storeSession success).
- `"unavailable"` — response.ok but no valid session meta, or a definitive refusal
  (4xx): the server will not mint → the prompt fallback remains for non-loopback
  dashboards. (Same reachability as today's null.)
- `"failed"` — timeout, abort, or network error: TRANSIENT. Must NOT fall through
  to the prompt (today it would: on a loopback dashboard a 10s proxy hiccup would
  pop an admin-token modal — new user-facing regression the audit caught).
- Classification totality (round 2): any non-ok that is NOT a definitive 4xx
  refusal — 5xx included (transient 502/503 behind an intermediate proxy) — maps to
  `"failed"`. Nothing but 4xx/ok-without-meta may reach the prompt.

resolveTokenAfter401's body maps the tri-state: `minted` → return token;
`unavailable` → existing prompt path; `failed` → return null for THIS wave (the
finally clears resolutionInFlight, so the next 401 re-arms a fresh bootstrap).

### 3. Abort-aware shared resolution (resolveTokenAfter401, ~line 165-189)

Before: all callers `await resolutionInFlight`; the caller's signal is never
consulted, so a store-side abort (unmount, or WP1's deadline) cannot unwind the wait.

After — signature `resolveTokenAfter401(failedToken: string | null, callerSignal?: AbortSignal)`:

    if (callerSignal?.aborted) return null;
    if (promptCancelled) return null;
    if (!resolutionInFlight) resolutionInFlight = (async () => { ...tri-state body from §2...
    })().finally(() => { resolutionInFlight = null; });
    if (!callerSignal) return resolutionInFlight;
    // Per-caller race: an abort unwinds THIS caller only; the shared resolution
    // continues for the others. The abort listener is removed in finally so a
    // resolution-won race never leaks one listener per request (audit #12).
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      callerSignal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([resolutionInFlight, aborted])
      .finally(() => { if (onAbort) callerSignal.removeEventListener("abort", onAbort); });

Note the shared async body takes NO caller signal (a dead caller must not kill the
join for the others); only the re-bootstrap's own timeout bounds it.

### 3b. Bootstrap watchdog (added in B after live verification; scoped in A re-audit)

Live fault injection found a residual the 10s fetch bound misses: a bootstrap fetch
that never honors the client abort leaves the shared body pending forever and
re-wedges every waiter. A 15s watchdog (`resolutionWatchdogMs`) therefore races
THE BOOTSTRAP CALL inside the body and resolves `{ kind: "failed" }` on a win.

Scope discipline (round-3 audit): the watchdog must NEVER race the admin-token
prompt. The prompt is user-controlled and unbounded; while its body pends, later
waves join the same `resolutionInFlight`, which is what keeps exactly one dialog
on screen (promptForAdminToken has no singleton guard). A whole-body watchdog
fires at 15s mid-prompt and stacks a fresh modal every cycle on non-loopback
dashboards — the exact configuration the prompt exists for. Regression test:
api-auth-deadline "the watchdog never bounds the prompt".

The conditional clear (`resolutionInFlight === tracked`) stays: a late settle of
an abandoned body must not wipe a newer in-flight resolution.

### 4. Thread the caller signal through installApiAuthFetch (~line 191-226)

- Extract `const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)`
  at the top of the wrapped fetch.
- Pass it to `resolveTokenAfter401(token, callerSignal)`.
- When resolution returns null, return the original 401 response (existing behavior)
  — resource fetchers then throw via readJsonOrThrow and the store settles failed
  (WP1 semantics) instead of pending forever.
- Retry attempts already carry the signal through init spread; assert in tests.

## Behavior after

| Scenario | Before | After |
|---|---|---|
| Bootstrap hangs, 401 wave | whole app pends forever, /healthz alive (E2) | bootstrap times out ≤10s → shared resolution settles null → callers return the 401 → fetchers throw → stores settle failed (~10s + settle, NOT 40s — the bootstrap timeout fires long before WP1's 30s store deadline; audit #10) → next poll retries and recovers; no reload |
| Transient bootstrap failure on loopback | (with naive timeout) admin-token modal storm | "failed" never reaches the prompt (audit #2) |
| Caller aborted while awaiting resolution (unmount / WP1 deadline) | wait ignores abort | that caller unwinds; shared resolution continues for others |
| Bootstrap slow (<10s) | works | unchanged |
| Non-loopback (no session mint) | prompt fallback | unchanged — prompt path has no time bound (user-controlled), only caller-abort unwind |

## Tests (NEW gui/tests/api-auth-deadline.test.ts)

Stub `rawFetch` via resetApiAuthFetchForTests pattern; window.fetch installed by
installApiAuthFetch. Drive requests to `/api/x`.

1. `hung bootstrap fails the request within the deadline and clears the shared
   resolution` — rawFetch: /api/* → 401 once; /opencodex-session → never resolves.
   setRebootstrapTimeoutForTests(50). First fetch rejects/returns 401 within ~ms;
   then rawFetch for /opencodex-session switches to a resolving mint and a SECOND
   /api fetch succeeds — proving resolutionInFlight cleared and re-armed.
2. `bootstrap timeout never opens the admin-token prompt` (audit #2) — prompt spy
   installed via resetApiAuthFetchForTests(prompt); after (1)'s timeout wave the
   spy has ZERO calls; a 502 bootstrap response also yields ZERO prompt calls
   (round-2 totality case); only an "unavailable" mint refusal (4xx / ok-without-meta)
   opens it (separate assert).
3. `caller abort during pending resolution unwinds only that caller` — two fetches
   join one resolution (bootstrap pends); abort caller A → A settles (401/error)
   while B still pends; then bootstrap mints → B succeeds. Leak assert (round 2):
   monkey-patch A's signal addEventListener/removeEventListener spies BEFORE the
   fetch and assert balanced calls after the race settles (EventTarget exposes no
   listener enumeration).
4. `no page-lifetime poisoning` — after (1)'s timeout, a third request triggers
   exactly one NEW bootstrap call (count asserts).
5. `retry carries the caller signal` — after a successful resolution, the retried
   /api request's init.signal is the caller's (spy on rawFetch args).

Activation scenarios: test 1 triggers the timeout branch for real; test 2 triggers
the abort-race branch; browser check repeats 001/E2 end-to-end.

## Verifiers

- `cd gui && bun test tests/api-auth-deadline.test.ts tests/api-auth-memory.test.ts tests/admin-token-dialog.test.ts`
- `cd gui && bun run build`
- Browser: 001/E2 scenario — with the bootstrap stalled, tabs reach settled error
  states ≤ ~10s + one poll tick (bootstrap timeout, audit #10 correction);
  unstalling the bootstrap recovers all tabs without reload.

## Out of scope (WP2)

Server-side session TTL changes; token UX redesign; /v1/* proxy-path auth.

## D addendum — landed (2026-08-16)

Implementation: commits 4f489ddf9 (bounded tri-state bootstrap + abort-aware
resolution), 6ced61d45 (bootstrap watchdog + 001/E3 harness-artifact correction),
edc51e6b2 (watchdog scoped off the prompt — round-3 audit fix).

Verification evidence:
- `cd gui && bun test tests/api-auth-deadline.test.ts tests/api-auth-memory.test.ts tests/admin-token-dialog.test.ts tests/bounded-fetch.test.ts`
  → 23 pass / 0 fail (6 new deadline cases: hung-bootstrap re-arm, no-prompt on
  timeout/5xx, per-caller abort unwind with listener-balance spy, signal carry on
  retry, signal-dropping zombie bounded by the watchdog, prompt never watchdog-
  bounded with single-dialog join).
- `cd gui && bun run build` → green.
- Live E2 (in-app browser, CDP Fetch injection on a sandboxed instance): 401 storm
  + bootstrap stalled past every bound → poll waves settle and re-arm (~15s
  cycle); after the injection clears, EVERY tab recovers automatically with no
  reload (full 5s poll wave of 200s, dashboard exits the cannot-connect state).
  Harness note: the raw CDP channel rejects Fetch.disable — interception is
  cleared with Fetch.enable + empty patterns; earlier "post-heal silence"
  observations were that artifact, recorded as a correction in 001/E3.
- Audit: binding rounds r3 (FAIL → fixed) and r4 (PASS, fresh).
