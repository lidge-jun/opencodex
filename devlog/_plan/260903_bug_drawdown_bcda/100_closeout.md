# 100 — Closeout: bug-labelled drawdown, 2026-09-03

## Outcome

DONE. The open `bug`-labelled pull-request queue reached zero, and every
`bug`-labelled issue open at arming time reached a terminal state. Sixteen pull
requests were squash-merged to `dev`, each proved an ancestor of `origin/dev`
with `git merge-base --is-ancestor`. `origin/dev` moved from `529639a57` to
`b3e205e99`.

## Merged

| PR | Item | Merge |
|----|------|-------|
| #3254 | native chat transient send budget | `b0a42ca2f` |
| #3256 | Kiro reset-aligned cooldown (OAuth) | `fd324dc88` |
| #3246 | write_stdin bridged through exec | `938c0136a` |
| #3289 | responses-state.json write storm (#3141) | `34c9e9802` |
| #3290 | log panel jitter (#3152) | `fc08fc2f7` |
| #3294 | combo request-rate cooldown + Retry-After | `6b2dfde11` |
| #3270 | incremental usage ledger aggregation | `85d40ca35` |
| #3296 | atomic provider editor save (#3280) | `3c7c021ec` |
| #3297 | claude launcher liveness retry | `4cf3e9187` |
| #3298 | provider-scoped quota cap failover | `e9a5b0f13` |
| #3301 | hermetic provider-option E2E (#3299) | `15b43e51c` |
| #3302 | cached-quota pre-emption | `2e74a35d4` |
| #3307 | rotation createdAt (#3303) | `eac662eb1` |
| #3308 | reachable status dashboard URL (#3304) | `472c785c2` |
| #3310 | catalog inactivity timeout (#3305) | `906511f73` |
| #3309 | hub-local loopback integrations (#3306) | `b3e205e99` |

Issues #3141, #3152, #3280, #3299, #3303, #3304, #3305 and #3306 were closed with
their merge commit named.

## Terminal without a diff

Three issues ended NEEDS_HUMAN with the analysis posted rather than a guess:

- **#3245** — the 426 is deliberate (`src/server/index.ts:1107-1126`) and the
  reporter's probe shows no POST at all, so the SSE, timeout and reuse paths were
  never reached. The control test `tests/server-auth.test.ts:1384-1422` passes.
  The candidate fix is upstream in the Codex client's 426 fallback.
- **#1527** — the full-replay, retry-amplification and `max_output_tokens`
  theories are all ruled out by current code; `max_output_tokens` has no wire
  field on that path at all. Only a matched direct-vs-proxy capture can isolate
  the remaining cold-replay candidate.
- **#3279** — no intermittent-invalidation mechanism exists in
  `src/server/gui-session.ts`; the only available "fix" would be weakening
  loopback-origin equality on a guess, on an authentication surface.

## What the process caught that a green build would not

**A plan audit that failed four times.** The wp0 roadmap passed only on round 5.
Two of the reviewer's findings were factual errors in my own writeup, verified
against source: an unusable `Retry-After` yields `DEFAULT_COOLDOWN_MS` (60 s),
not a zero-delay retry (`src/oauth/generic-account-failover.ts:205-211`); and
"incremental equals full recompute" is trivially true pre-fix, so #3270's real
RED assertion is ledger completeness under read and row bounds.

**A browser, not a test.** #3280's first implementation used an allowlist of 11
editable provider fields. Every test passed. Saving a real untouched config in
the dashboard rejected it with `provider "woong" contains non-editable field "note"`
— trading a clear 405 for a save that refuses the user's own config. The policy
became an exhaustive `Record<keyof OcxProviderConfig, ...>` that `tsc` enforces.

**CI, on my own change.** #3296 broke two contracts that focused tests missed: a
route-inventory count and a runtime-metadata rejection. Fixing the second, a
subagent relaxed an existing `safeConfigDTO` assertion so its implementation
would pass. `dev` already listed `modelMaxInputTokens` among values that DTO
must never serialize, so the test was restored verbatim and the implementation
made to satisfy it.

**A revert hiding inside a contribution.** #3302 arrived branched before #3301
and silently reverted it, restoring a public-WebSocket reach and real Windows ACL
subprocesses. Only its genuinely new part — cached-quota pre-emption — was kept.

## Flaky tests observed

Three distinct macOS timing failures recurred and passed on rerun, unrelated to
any change here. Worth their own unit if they keep costing reruns:

- `shutdown-launcher`: `waitUntil(() => healthy(port), 20_000)` at
  `tests/shutdown-launcher.test.ts:111` — proxy startup exceeds 20 s on a loaded
  runner.
- `Response spill shutdown fallback budget exhausted` — a 4 s wall-clock reserve
  (`RESPONSE_SPILL_SHUTDOWN_FALLBACK_RESERVE_MS`).
- `CL-07 task effectiveness producer > inactivity timeout is bounded`.

Plus `minimax-clients`, which assumes a just-closed port stays free.

## Constraint honored

No repository-wide local suite was run at any point. Verification was focused
test files plus the exact-head GitHub check rollup, per the maintainer
instruction for this campaign.

