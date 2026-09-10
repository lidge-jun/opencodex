# Closeout — quota-reset detection and notification

**Terminal outcome: shipped as a PR against `dev`.** Five work-phases, each a full PABCD cycle.

## What exists now

OpenCodex notices when a usage window resets and can tell you about it — both the scheduled
rollover you could predict and an out-of-band reset you could not. Off by default; a default
install executes no detection code, starts no timer, and writes no state file.

| Piece | File |
| --- | --- |
| Pure detection | `src/quota/reset-detector.ts` |
| Durable claims, baselines, event ring | `src/quota/reset-seen-store.ts` |
| Observation entry point | `src/quota/reset-observer.ts` |
| Provider/Codex shape mapping | `src/quota/window-mapping.ts` |
| Idle poller | `src/quota/reset-poller.ts` |
| Config resolution | `src/quota/reset-notify-config.ts` |
| Webhook + command sinks | `src/quota/reset-sinks.ts` |
| Activation switch | `src/quota/reset-activation.ts` |
| Management route | `src/server/management/quota-reset-routes.ts` |

Seams: `src/codex/quota.ts` and `src/providers/quota.ts`, both reaching the observer only
through `import()`. Enforced by `tests/quota-reset-core-boundary.test.ts`.

## Commits

```
c752929d7  docs(devlog): roadmap                              wp1
fb958fd5d  docs(devlog): A-phase audit findings               wp1
19d2447e9  docs(devlog): work-phase map                       wp1
e3853d84a  feat(quota): detector + claim store                wp2
aff0ca2ec  fix(quota): scheduled corroboration, clockless key wp2
f4fcbb547  feat(quota): both seams + idle poller              wp3
2e4b3be3e  fix(quota): config-mtime notify cache              wp3
1e5945f61  fix(quota): serialization, identity, boundary      wp3
6e1cab123  feat(quota): sinks, activation, surfaces           wp4
453e91542  docs(quota): reference documentation               wp4
c54333d4c  fix(quota): persistence cap + second writer        wp5
```

## Defects found and fixed during the work

Eleven, of which four were found by an adversarial review of code that was already green and
four by attacking my own guards. The ones worth remembering:

1. **The provider seam was dead on arrival.** `previous` binds only when `cache.key === key`,
   but the key digest includes the quota values themselves — so it is empty exactly when a reset
   happened. Fixed by giving the detector its own persisted baseline.
2. **Out-of-order observations manufactured resets.** Two awaits before the baseline swap, and
   Bun does not resolve concurrent `import()` calls in call order. A burst of rising usage fired
   a false "surprise" every run, and the false event burned the durable claim key — permanently
   suppressing the genuine reset. Fixed by serializing on a synchronously-reassigned chain.
3. **Reauth fired a false reset on every occurrence**, and the test written to prevent it also
   cleared the observer store, which no production path does. The test simulated a state that
   never happens.
4. **The account key collapsed an API-key pool** onto one identity and could be read after a
   mid-flight failover rewrote it.
5. **The enable gate could never turn on.** `captureConfigGeneration` only advances on
   account/provider reconciliation, so editing the notify section never bumped it.
6. **The observed-window map evicted its hottest row**, because re-setting a key does not move
   it in a Map, so eviction removed the earliest-inserted rather than the least-recently-used.
7. **`accountTag` was brute-forceable** — an unsalted hash of an email fell in 36 guesses, and
   the tag crosses a webhook boundary.
8. **A rolling window's natural decay read as a surprise reset**, on the most common window in
   the system.

## Process notes

- **A guard that has never failed is not evidence.** Every guard here was driven red first. Two
  tests passed against the code they were meant to catch: the burst test (the observer module is
  already cached in-process, so a child process was required) and the starvation test (it
  asserted a file existed, which hydration already guarantees).
- **A reviewer's diagnosis and their prescription are separate claims.** Finding 6's magnitude
  bound was implemented, measured, and rejected — it suppressed an 83-point real drop while
  still firing on the 27-point decay it targeted. The diagnosis was right and the remedy was
  wrong, and only measuring told them apart.
- **Subagent reliability was poor**: of five reviewers dispatched across the unit, one produced
  the substantive review above and three went silent. Every blocker it raised was independently
  reproduced here before being acted on.
- **SOURCE-DELTA-01 fired once**, correctly, when I committed wp4 before entering B. The
  remaining docs work became that phase's delta.

## Left undone, deliberately

- No GUI surface. `safeConfigDTO` is a whitelist, so the section is invisible to the dashboard
  by design; a toggle would need that whitelist extended and a redaction decision for the
  webhook URL.
- English docs only. Translated locales are a separate pass, not a machine translation.
- `src/codex/reset-credit-recovery.ts` untouched: it owns credit consumption, not detection.
