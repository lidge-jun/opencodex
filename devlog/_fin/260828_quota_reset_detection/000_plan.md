# Quota reset detection and notification

Unit: `260828_quota_reset_detection`
Branch: `codex/quota-reset-detection` (target `dev`)
Class: C4 (new subsystem, config surface, background timer, outbound network sink)

## Objective

When a usage window resets, opencodex should notice and say so exactly once.

Two reset shapes matter and they are not the same event:

- **scheduled** — the window's own clock ran out. The previous snapshot carried a
  `resetAt` in the future, wall-clock passed it, and the next snapshot reports a
  lower used-percent. This is the weekly/5-hour rollover an operator can already predict.
- **surprise** — used-percent drops while the previous `resetAt` is *still in the
  future*, or `resetAt` jumps forward before its own deadline. Upstream moved the window
  out of band. Nobody can predict this one, which is exactly why it needs a signal.

The deliverable is detection plus a default-OFF notification sink, not a routing change.

## Constraints

- Bun-native TypeScript, strict `tsc`. No Node-only APIs.
- `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` must not
  gain a transitive `src/lab/` import (`tests/core-lab-boundary.test.ts`). The new
  subsystem is itself optional and must not become a second core-path passenger.
- Notification default OFF. A user with no reset config runs no timer and invokes no sink.
- Event payloads carry closed-union labels and numbers only. No account ids, no emails,
  no tokens, no paths. `bun run privacy:scan` scans *repository files*, not runtime
  output, so payload privacy is a design obligation the scanner cannot enforce.
- `src/codex/reset-credit-recovery.ts` owns credit *consumption* and stays untouched.
  A deliberate credit redemption is not a surprise reset.

## Current state (verified 260828)

Detection is absent. `rg -ni 'resetdetect|quotareset|reset-event|resetEvent' src` returns
three hits, all inside `function quotaResetAt(...)` in `src/providers/quota.ts:1646` — a
DTO field reader. Notification is absent: `rg -n 'webhook' src scripts docs-site/src`
returns zero matches.

What does exist, and what the design leans on:

| Fact | Location |
|---|---|
| Codex per-account windows (`weeklyResetAt`, `shortResetAt`, `monthlyResetAt`, `resetCredits`) | `src/codex/quota.ts:7` |
| The one writer holding both prev and next in scope | `src/codex/quota.ts:274` (`const existing = accountQuota.get(accountId)`) |
| Commit points that snapshot becomes durable through | `src/codex/quota.ts:289`, `:336` |
| Disk snapshot, version 1, 6-hour read-side age limit | `src/codex/quota.ts:40`, `:41`, `:485` |
| Provider-side windows (`fiveHourResetAt` etc.) | `src/providers/quota.ts:93` |
| Provider-level snapshot commit — the ONLY place a newer report displaces an older one | `src/providers/quota.ts:2343`, with `previous` in scope at `:2290` |
| Provider per-account cache replacement sites | `src/providers/quota.ts:1585`, `:1592`, `:1603` |
| Provider quota has NO background refresh — one caller, request-driven | `src/server/management/provider-routes.ts:421` |
| Reset-sentinel normalization (`0`/negative are not clocks) | `src/providers/quota.ts:279` |
| Opt-in background job pattern (unref'd timer, gate in the callee) | `src/storage/policy-scheduler.ts:13`, `src/storage/policy-job.ts:445` |
| Bounded ring + snapshot accessor for a read route | `src/server/memory-watchdog.ts:48` |
| Optional-subsystem teardown registry | `src/lib/optional-shutdown-hooks.ts:32` |
| Strict optional config section template | `src/config.ts:843`, `:898`, `:2058`, `:2179` |
| SSRF policy for an operator-supplied URL | `src/lib/destination-policy.ts:377` |

## Four traps the design has to survive

These are the reasons a naive "percent went down, fire" detector is wrong here.

1. **Credits-only writes rewrite `updatedAt` with byte-identical windows.**
   `src/codex/quota.ts:276` (`creditsOnly`) copies every window field from `existing`
   and changes only `resetCredits`. Keying on `updatedAt` fires on nothing.
2. **Writers never hydrate from disk.** `hydrateAccountQuotasFromDisk` is called by the
   three readers only (`src/codex/quota.ts:511`, `:516`, `:542`). A cold-start write can
   see `existing === undefined` while a valid snapshot sits on disk. Treating absent-prev
   as a reset invents an event on every restart.
3. **Rows get deleted for reasons that are not resets.** Reauth clears the row on purpose
   (`src/codex/auth-api.ts:2019`), reconciliation drops non-live accounts
   (`src/codex/quota.ts:540`), and account purge clears it
   (`src/codex/account-lifecycle.ts:39`). Delete-then-readd looks like 0% arriving fresh.
4. **Header writes are partial snapshots.** `src/server/responses/core.ts:3793` writes on
   every pooled response and may omit the burst tuple entirely; the merge at
   `src/codex/quota.ts:323` carries forward what the payload lacks. A detector must diff
   the *committed* snapshot, not the incoming payload.

5. **Provider reports are keyed by provider, not by account.** `clearProviderQuotaCache()` plus
   an account switch makes the next `anthropic` report a *different account's* usage — lower
   percent, different `resetAt`. That is an identity change, not a reset. Events must be keyed
   by `(provider, account, window)`.
6. **Provider quota is never refreshed on its own.** `fetchProviderQuotaReports` has exactly
   one caller — the `/api/provider-quotas` route. With no dashboard open and no CLI call, no
   two consecutive snapshots exist, so a reset passes unobserved indefinitely. The opt-in
   poller in wp3 is therefore load-bearing, not a nicety.
7. **Two `normalizeResetAt` implementations disagree.** `src/providers/quota.ts:279` treats
   `<= 0` as a sentinel and scales seconds to ms; `src/codex/quota.ts:192` admits `0` and
   does no scaling. The detector normalizes at its own boundary rather than trusting either.

Consequence: absent-prev is never a reset, identity is `(scope, account, window)`, and window
values — not the write timestamp — decide whether anything happened.

Observation cadence is also bounded by design: the provider cache TTL is 5 minutes
(`src/providers/quota.ts:37`) and the per-account TTL is 10 (`:1425`), so a reset instant can
only ever be bracketed between two observations, never timestamped exactly. Events carry
`detectedAt` and the observed `resetAt`, and never claim to know when the reset occurred.

## Detection contract

```
observe(scope, windowLabel, prev, next, now) -> ResetEvent | null
```

`kind: "scheduled"` requires `prev.resetAt !== undefined && now >= prev.resetAt` and
a percent drop. `kind: "surprise"` requires a material percent drop (>= 5 points, so
rounding noise cannot trip it) while `prev.resetAt` is still ahead of `now`, or
`next.resetAt` advancing past `prev.resetAt` before that deadline. Every other
transition, including any missing `prev`, returns `null`.

Idempotence key: `scope | windowLabel | resetAtBucket`. Persisted, because "exactly once"
has to hold across a restart, and the whole point of a surprise reset is that it happens
while nobody is watching.

## Work-phase map (dependency-ordered)

Locked at the close of the wp1 docs cycle. Files named here are the authoritative
deliverable list; a later cycle amends its own doc rather than reinterpreting this table.

| Phase | Doc | Delivers | New files | Depends on |
|---|---|---|---|---|
| wp1 | `000`, `001`, `010`–`040` | roadmap, contract, 7 traps, audit response | 6 docs | — |
| wp2 amendment | `002_wp2_audit_response.md` | the 9-blocker A-gate response | 1 doc | wp1 |
| wp2 | `010_phase2_detection_core.md` | pure detector + durable claim store | `src/quota/reset-detector.ts`, `src/quota/reset-seen-store.ts`, 2 test files | wp1 |
| wp3 | `020_phase3_observation_wiring.md` | codex + provider seams, opt-in poller | `src/quota/reset-observer.ts`, `src/quota/reset-poller.ts`, 1 test file; edits `src/codex/quota.ts`, `src/providers/quota.ts`, `src/server/background-lifecycle.ts` | wp2 |
| wp4 | `030_phase4_sinks_and_surface.md` | config section, sinks, event ring, API + CLI | `src/quota/reset-notify-config.ts`, `src/quota/reset-sinks.ts`, `src/server/management/quota-reset-routes.ts`, 1 test file; edits `src/types/config.ts`, `src/config.ts` (schema, register, write-validate, warn ×3, `validFileConfigDiagnostics`), `src/cli/config-command.ts` (redact `webhookUrl`), `src/server/management-api.ts`, `src/cli/provider-runtime.ts`, `src/cli/registry.ts` | wp3 |
| wp5 | `040_phase5_hardening_delivery.md` | boundary guard, full gates, docs, evidence, PR | `tests/quota-reset-core-boundary.test.ts`, `050_activation_evidence.md`, `060_closeout.md`; edits 3 docs-site pages | wp4 |

Ordering is structural: nothing can be wired before the contract exists, no sink can fire
before something detects, and delivery proves the whole chain. Each phase closes with
something independently verifiable.

## Out of scope

Routing/failover reaction to a reset; automatic credit consumption; GUI work beyond what
an operator needs to read the event log; any credential or OAuth change; `src/lab/`.

## Verifiers (run, not assumed)

| Command | Exit | Observes this change? |
|---|---|---|
| `bun x tsc --noEmit` | 0 on baseline 295860825 | Yes — `tsconfig.json` includes `src/**/*.ts` |
| `bun test tests/<file>.test.ts` | 0 (8 pass on `codex-quota-parser-parity`) | Yes — names the new test file directly |
| `bun run test` | full suite | Yes |
| `bun run privacy:scan` | 0 | Repository text only — NOT runtime payloads |
| `bun test tests/core-lab-boundary.test.ts` | 0 | Yes — walks the runtime import graph |
| `bun test tests/quota-reset-core-boundary.test.ts` | added in wp5 | Yes — the existing Lab guard hardcodes `/src/lab/` (`tests/core-lab-boundary.test.ts:63`) and cannot see `src/quota/` |

`bun install` was required first: a fresh worktree fails with
`Cannot find module 'zod/v4'` and every focused run reports a spurious single error.

## Bypass ledger

The default-OFF guarantee is enforced by a test (E7-class), not by anything unbypassable.
Executing surface: `bun run test`. Known bypass: a contributor who wires the sink into a
path the test does not observe. Residual risk: a future caller invoking the sink directly
rather than through the gate. Final enforcement layer: none — the boundary is the test plus
review. Wording is deliberately "early warning", not "enforcement".
