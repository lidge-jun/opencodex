# 020 — Fix #1065: pre-first-byte deadline for the bounded JSON read

Branch: `codex/1065-bounded-body-first-byte`, base `origin/dev` (no
overlap with the stack or with 010 — different files entirely).

## Change

1. `src/lib/bounded-body.ts`: add `firstByteTimeoutMs?: number` to
   `BoundedBodyOptions`, defaulting to `inactivityTimeoutMs`. Arm the
   initial inactivity timer (`:131`) with `firstByteTimeoutMs`; the
   existing reset after the first non-empty chunk (`:192-196`) switches
   to `inactivityTimeoutMs`. All existing callers unchanged.
2. `src/server/responses/core.ts:2229-2233`: pass
   `firstByteTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS` (180s).
   The total wall-clock cap still bounds a dead upstream.
   Audit note (accepted): with firstByte=total=180s the total deadline
   wins the no-byte race — the option effectively means "allow first
   output for the entire existing total budget," which is the intent;
   the issue proves failures at ~30.5s and gives no evidence for a
   smaller invented ceiling like 120s.
3. Clarify (not replace) the comment at `core.ts:745-749`: pre-header
   generation is indeed untouched; the missing statement is that
   generation after early/chunked headers but before the first body byte
   was subject to the 30s inactivity timeout.

## Resource tradeoff (recorded)

Header-only stalls can occupy a turn for up to 180s instead of 30s.
Memory stays bounded: 64 KiB initial buffer per reader
(`bounded-body.ts:125`) × 256 active-turn cap (`lifecycle.ts:30`) ≈
16 MiB at max concurrency. Slot occupancy is 6× longer; accepted.

## Caller inventory (default preserves all)

`web-search/loop.ts:491`, `images/loop.ts:571`,
`adapters/upstream-http-error.ts:26`, `adapters/kiro-retry.ts:194,219`,
`codex/auth-api.ts:405`, `codex/quota-rejection.ts:181`,
`server/responses/core.ts:275,634,2229`. Only `core.ts:2229` opts in.

## Regression tests (`tests/bounded-body.test.ts`)

1. First byte delayed past `inactivityTimeoutMs`, under
   `firstByteTimeoutMs` → completes, `truncated: false`. RED without fix.
2. No first byte before `firstByteTimeoutMs` → `inactivityTimedOut: true`.
3. First byte on time, later inter-chunk gap > `inactivityTimeoutMs` →
   still times out (between-chunk protection retained).
4. No `firstByteTimeoutMs` given → identical to today (protects the 5s
   error-body callers: `upstream-http-error.ts`, `kiro-retry.ts`,
   `auth-api.ts`).
5. Call-site regression (audit blocker): primitive tests stay green if
   `core.ts` forgets to pass the option. Export the bounded-read options
   object (or add a structural contract test) pinning that the bounded
   JSON call site passes `firstByteTimeoutMs = UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS`.
   Test convention: fake ReadableStreams + short real timers, per
   existing `bounded-body.test.ts:36,68`.

## Verification

`bun run typecheck`, `bun test tests/bounded-body.test.ts`, targeted
responses-core suites that exercise the bounded path, `bun run
privacy:scan`. Red-green ablation recorded for test 1.
