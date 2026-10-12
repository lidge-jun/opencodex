# Phase 1 (wp2): honor Retry-After, stop retrying aborted token requests

Closes #4045, #4046, #4047. One cohesive PR: all three defects live in the same
retry loop of `postXaiToken` and the same helper cluster; splitting them would
produce three PRs editing adjacent lines of one function.

Revision 3, folding two audit rounds. Round 1: four issue verifiers (#4045
CONFIRMED, #4046 PARTIALLY, #4047 PARTIALLY, #4048 CONFIRMED) — strict parser
copied from `src/combos/failover.ts`, two-name terminal guard, pre-sleep abort
check. Round 2: plan auditor GO-WITH-FIXES (blockers=1) plus a bounded
retry-algorithm reviewer FAIL (one real High) — folded below: donor-fidelity
date regex, non-vacuous HTTP-date test, hostile-vector tests, corrected CI map,
**abort-aware in-wait sleep**, and the **retry-budget terminal rule** replacing
the issue sketch's silent 60 s clamp.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/oauth/xai.ts` | MODIFY | import `abortError`/`sleepWithAbort` from `../lib/upstream-retry`; `retryDelay` rewrite (returns `number \| undefined`), new `jitterDelay`/`parseRetryAfterMs`/`parseHttpDateMs`/`sleepAbortable`, remove `isAbortError`, terminal abort/timeout handling + abort-aware backoff in `postXaiToken` |
| `tests/providers/xai/xai-oauth-retry.test.ts` | MODIFY | new regression tests (below); existing five must keep passing unmodified |
| `docs-site/` | none | retry timing is internal; no user-facing configuration or documented behavior changes |

`src/lib/upstream-retry.ts` is a documented leaf module (its header: "MUST stay
a leaf module") importing only `./abort`, so the new import adds no transitive
weight to the OAuth path and reuses the repo-standard `abortError` shape
(`signal.reason ?? DOMException("The operation was aborted", "AbortError")`).

Scope boundary — IN: the two rows above plus this unit directory. OUT: every other
provider's OAuth lane, `callback-server.ts`, `pkce.ts`, `validateXaiEndpoint`
(phase 2), `src/combos/failover.ts` (parser donor — copied, not imported),
CLI surfaces, GUI.

## Diff-level design

### 1. Constants (NEW, next to `TOKEN_REQUEST_TIMEOUT_MS` at src/oauth/xai.ts:13)

```ts
const RETRY_AFTER_MAX_DELAY_MS = 60_000;
const JITTER_DELAY_CAP_MS = 2_000;
```

### 2. Parser and delay helpers (NEW/REWRITE)

Before (src/oauth/xai.ts:98, current `dev`):

```ts
function retryDelay(attempt:number,retryAfter:string|null,random:()=>number):number{const base=attempt===1?100:250,j=Math.round(base*(.75+random()*.5)),seconds=retryAfter!==null&&/^\d+$/.test(retryAfter)?Number(retryAfter):0;return Math.min(2000,Math.max(j,seconds*1000));}
```

After:

```ts
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseHttpDateMs(value: string): number | undefined {
  const match = IMF_FIXDATE_RE.exec(value);
  if (!match) return undefined;
  const month = HTTP_MONTH_INDEX[match[2]!.toLowerCase()];
  if (month === undefined) return undefined;
  const year = Number(match[3]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    ? timestamp
    : undefined;
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  const text = retryAfter?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Math.ceil(Number(text) * 1000);
    return ms > 0 ? ms : undefined;
  }
  const timestamp = parseHttpDateMs(text);
  if (timestamp === undefined) return undefined;
  const delay = timestamp - Date.now();
  return delay > 0 ? delay : undefined;
}

function jitterDelay(attempt: number, random: () => number): number {
  const base = attempt === 1 ? 100 : 250;
  return Math.min(JITTER_DELAY_CAP_MS, Math.round(base * (0.75 + random() * 0.5)));
}

/**
 * Delay before the next attempt, or undefined when the server asked for a wait
 * beyond the retry budget — retrying earlier than Retry-After is the original
 * #4045 defect shape, so the caller must fail instead of clamping.
 */
function retryDelay(attempt: number, retryAfter: string | null, random: () => number): number | undefined {
  const serverMs = parseRetryAfterMs(retryAfter);
  if (serverMs === undefined) return jitterDelay(attempt, random);
  return serverMs <= RETRY_AFTER_MAX_DELAY_MS ? serverMs : undefined;
}

async function sleepAbortable(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
```

Default sleep primitive (post-review amendment, verified by direct read of
`src/lib/upstream-retry.ts:53`): the production default changes from
`Bun.sleep` to the already-exported `sleepWithAbort`, which clears its own
timer on abort — so a cancelled CLI leaves no live 60 s timer behind:

```ts
const sleep = deps.sleep ?? ((ms: number) => sleepWithAbort(ms, signal));
```

`sleepAbortable` remains as the wrapper so a test-injected `deps.sleep` is
still raced against the caller signal; in production the composition is
sleepWithAbort's own abort handling plus the wrapper's reason-preserving
rejection. `upstream-retry.ts` is a documented leaf importing only
`./abort`; no shared-module export or API change is needed.

Parser provenance (round-1 fold): compact copy of the strict parser the
repository already maintains in `src/combos/failover.ts:117`, at donor fidelity
(round-2 fold): case-insensitive enumerated weekday/month names and a full
six-field UTC round-trip check, so `10:60:00` overflow and lowercase dates
behave exactly as the donor. NOT the issue's `Number()`/`Date.parse` sketch:
bare `Number()` over-accepts (`"1e3"`, `"0x10"`, `"+2"`) and
`Date.parse` is implementation-defined off IMF-fixdate. The donor is not
imported because that would couple `src/oauth/` to `src/combos/`; a
`src/lib/` unification is a possible follow-up, out of scope here. HTTP-date
support covers ALL THREE RFC 9110 formats at full donor fidelity (round-3 fold
of a CodeRabbit Major): IMF-fixdate, RFC 850 (including the two-digit-year
50-year rule), and asctime — RFC 9110 §5.6.7 requires a recipient parsing an
HTTP-date to accept all three formats; only senders are confined to
IMF-fixdate. An earlier draft of this plan claimed recipients need only parse
IMF-fixdate and was wrong. Fractional seconds are a repo-local interop
extension already honored at `failover.ts:124`. Zero, negative, past-dated,
and unparseable values fall back to jitter.

Contract changes, all intentional:

- Server-provided delays up to `RETRY_AFTER_MAX_DELAY_MS` (60 s) are honored
  exactly instead of being clamped to 2 s (#4045). The 2 s cap now applies to
  the jittered fallback only.
- **Retry-budget terminal rule (round-2 fold, supersedes the issue sketch's
  `Math.min(seconds*1000, 60_000)`):** a server delay ABOVE the 60 s budget
  (`Retry-After: 61`, `3600`, a far-future date) makes the attempt terminal —
  the 429/5xx error is thrown immediately with zero further fetches. Clamping
  to 60 s would retry earlier than the server asked, recreating the original
  defect; the local retry budget cannot honor that floor, so it stops instead.
- In-wait cancellation (round-2 fold): the backoff sleep is raced against the
  caller signal with listener cleanup, so an abort DURING a honored 60 s wait
  rejects promptly with the abort reason instead of up to ~120 s late
  (`Bun.sleep` is not signal-aware). The test-injected `deps.sleep` primitive
  is preserved — the wrapper races whatever sleep is injected.
- The old `Math.max(jitter, serverMs)` floor is dropped: a present server
  value wins outright; jitter exists only for the no-header case.
- Ceiling interplay: two honored 60 s waits can stretch wall-clock to ~120 s
  while `TOKEN_REQUEST_TIMEOUT_MS` stays 30 s per attempt; per-attempt fetch
  timeout is unchanged. An abort during any wait now cancels promptly.

### 3. Abort/timeout terminal handling in `postXaiToken` (MODIFY)

Catch branch — before (src/oauth/xai.ts:114 area):

```ts
}catch(error){if(isAbortError(error)&&signal?.aborted)throw error;last=error;
```

After (only the abort predicate and the sleep change; the attempt-3 wrap and
continue are kept verbatim):

```ts
} catch (error) {
  if (signal?.aborted) throw error;
  const name = (error as { name?: string } | undefined)?.name;
  if (name === "AbortError" || name === "TimeoutError") throw error;
  last = error;
  if (attempt === 3) {
    throw new XaiTokenRequestError(undefined, undefined, "xAI token request failed: network error", { cause: error });
  }
  await sleepAbortable(jitterDelay(attempt, random), sleep, signal);
  continue;
```

Response branch — after:

```ts
  const error = await readTokenError(response);
  last = error;
  if (!(response.status === 429 || response.status >= 500) || attempt === 3) throw error;
  if (signal?.aborted) throw error;
  const delay = retryDelay(attempt, response.headers.get("retry-after"), random);
  if (delay === undefined) throw error;
  await sleepAbortable(delay, sleep, signal);
```

`isAbortError` is deleted (definition and only use are both in this file).
Rationale:

- The class check fails when `controller.abort(reason)` carries a custom reason:
  fetch rejects with the reason object as-is, so `instanceof DOMException` is
  false and the loop slept and retried an already-aborted request (#4047).
  Checking `signal?.aborted` covers every abort reason.
- The internal 30 s `AbortSignal.timeout` in `requestSignal` fires without
  aborting the caller's signal; the name guard covers BOTH `AbortError` and
  `TimeoutError` because Bun linked-signal timeouts often reject as
  `AbortError` (`src/server/images.ts:349`), matching the two-name
  non-retryable policy at `src/lib/upstream-retry.ts:178`. The check is safe
  here because the fetch signal is always `requestSignal(signal)` — a
  composition of exactly the caller signal and the internal timeout — so an
  abort-named rejection with a live caller signal can only mean the internal
  timeout fired.
- The pre-sleep `signal?.aborted` check in the response branch plus the
  abort-raced sleep mean a caller abort is honored before AND during the wait.

## Regression tests (all in `tests/providers/xai/xai-oauth-retry.test.ts`)

Existing helpers reused: `queue(...)`, `ok()`, `body`, injected
`{ sleep, random }` deps. All Retry-After cases drive the exported
`postXaiToken` with a 429 response carrying the header — never the unexported
helpers directly.

1. `429 honors Retry-After seconds beyond the jitter cap` — queue
   `[429(retry-after: 60), ok()]`, `random: () => 0.5`; expect sleeps
   `[60000]` and 2 fetch calls. Proves #4045.
2. `Retry-After above the 60s budget is terminal, never retried early` —
   `retry-after: 3600`; expect rejection with the 429 `XaiTokenRequestError`,
   exactly 1 fetch call, zero sleeps. Proves the retry-budget rule (the
   anti-#4045 invariant: never retry earlier than the server asked).
3. `Retry-After one second above the budget is terminal` — `retry-after: 61`;
   same expectations as test 2. Pins the boundary.
4. `Retry-After below the old 2s cap is still honored exactly` —
   `retry-after: 1`; expect `[1000]`. Pins the no-clamp edge.
5. `fractional Retry-After is honored` — `retry-after: 1.5`; expect
   `[1500]`. Proves #4046 (fractional).
6. `HTTP-date Retry-After is honored` — header
   `new Date(Date.now() + 30_000).toUTCString()`, `random: () => 0.5` pinned;
   expect one sleep `> 2000` and `<= 30000` — above the jitter cap, so a
   missing or broken `parseHttpDateMs` (which would sleep ~100 ms of jitter)
   fails this test. Proves #4046 (HTTP-date).
6b. `RFC 850 HTTP-date Retry-After is honored` — future date formatted
   `Wednesday, 09-Sep-26 ... GMT` (two-digit year, 50-year rule); same
   `> 2000 && <= 30000` assertion with pinned random. Proves the RFC 850
   recipient form (round-3 fold).
6c. `asctime HTTP-date Retry-After is honored` — future date formatted
   `Wed Sep  9 ... 2026` (space-padded day); same assertion. Proves the
   asctime recipient form (round-3 fold).
7. `unparseable Retry-After falls back to jitter` — `retry-after: soon`,
   `random: () => 0.5`; expect `[100]`.
8. `past HTTP-date falls back to jitter` — `Sun, 06 Nov 1994 08:49:37 GMT`,
   `random: () => 0.5`; expect `[100]`.
9. `whitespace-padded seconds are honored` — `retry-after: " 2 "`; expect
   `[2000]`. Proves the trim.
10. `hostile Retry-After vectors fall back to jitter` — one test looping over
    `["0", "-5", "1e3", "0x10", ""]` with a fresh 429-then-ok queue and
    `random: () => 0.5` per value; each expects exactly `[100]`. Pins the
    strict parser against a `Number()`-swap regression.
11. `abort with a custom reason is not retried` —
    `controller.abort(new Error("user cancel"))` before the call; fetch stub
    rejects with `controller.signal.reason`; expect rejection with that exact
    error (NOT wrapped in `XaiTokenRequestError`), 1 fetch call, zero sleeps.
    Proves #4047 (reason-carrying abort).
12. `token request timeout is terminal` — fetch stub rejects with
    `new DOMException("timed out", "TimeoutError")`, no caller abort; expect
    rejection with `name: "TimeoutError"` (not wrapped), 1 fetch, zero sleeps.
13. `Bun-shaped timeout abort is terminal` — fetch stub rejects with
    `new DOMException("The operation was aborted", "AbortError")` while the
    caller signal is NOT aborted; expect rejection, 1 fetch, zero sleeps.
14. `caller aborted before a 429 backoff does not sleep` — abort inside the
    fetch stub before returning the 429; expect rejection with the 429
    `XaiTokenRequestError` and zero sleeps. Proves the pre-sleep guard.
15. `caller abort during a Retry-After wait rejects promptly` — 429 with
    `retry-after: 60`; injected `sleep` records its argument then returns a
    never-resolving promise; the test body waits until the `60000` argument is
    recorded, THEN calls `controller.abort(new Error("cancel during wait"))`
    (never synchronously inside the injected sleep — `Promise.race` evaluates
    `sleep(ms)` before the abort listener is attached); expect rejection with
    that exact error, 1 fetch call, and the recorded sleep argument `60000`.
    Proves the in-wait abort race (round-2 High fold).

Existing-test compatibility (traced line by line by the round-2 auditor):
`network retry succeeds` still sleeps `[100]`; `429 and 5xx retry at most
three attempts` still sleeps `[100, 250]`; `third transient failure is
final` and `permanent 4xx` untouched; `caller abort is not retried` still
rejects with the `AbortError` DOMException via the `signal?.aborted` guard.

## Verifier

Remote: on the pull request, `ci.yml` runs the Linux `test` job, the macOS
`platform-macos` job, and the `gates` job (`tsc --noEmit`); the
`changes` filter covers `src/**` and `tests/**`, so
`tests/providers/xai/xai-oauth-retry.test.ts` executes in the Linux batches and
macOS shards. The Windows job (`platform-windows`) and `macos-control` are
NOT ON PR — they run only on `workflow_dispatch` with `lane=all`; the
cumulative final-head `lane=all` dispatch before merge is owned by the managing
task. The PR records the exact-head run URLs. Local: NOT RUN (`bun test`,
`bun run typecheck`) — user restriction; compile risk is covered by the
`gates` typecheck job, and the diff stays inside one already-typed function
cluster.

## Audit record

- Round 1 (four read-only xai/grok-4.6 issue verifiers): #4045 CONFIRMED;
  #4046 PARTIALLY (sketch parser wrong — folded: strict donor parser);
  #4047 PARTIALLY (Bun timeout surfaces as `AbortError`, per-attempt fresh
  timer — folded: two-name guard, Bun-shaped test); #4048 CONFIRMED (phase 2).
- Round 2 (independent plan auditor): GO-WITH-FIXES (blockers=1) — HTTP-date
  test was vacuous (folded: pinned random, assertion above the jitter cap);
  CI map overstated Windows (folded); hostile parser vectors untested (folded);
  donor-fidelity regex and truncated catch hunk (both folded).
- Round 2 (bounded retry-algorithm reviewer, via managing task): FAIL, one real
  High — in-wait abort: `Bun.sleep` is not signal-aware, so an abort during a
  honored 60 s wait could cancel up to ~120 s late. Folded: `sleepAbortable`
  race with listener cleanup around the (possibly injected) sleep primitive,
  pre-sleep and in-wait coverage, test 15. Managing-task invariant folded: a
  server delay beyond the local budget must be terminal, never a silent early
  retry — the retry-budget rule replaces the issue sketch's clamp.
- Round 3 (PR #4087 review bots on the published diff): Codex P1 — the 020
  phase-2 doc restated an unreleased endpoint-validation weakness and its
  remediation in tracked devlog; folded by stripping 020 to a minimal stub with
  all assessment/plan detail in gitignored scratch only. CodeRabbit Major —
  RFC 9110 §5.6.7 requires recipients to accept all three HTTP-date formats;
  folded by copying the donor parser at full fidelity (IMF-fixdate + RFC 850
  50-year rule + asctime) and adding tests 6b/6c.
