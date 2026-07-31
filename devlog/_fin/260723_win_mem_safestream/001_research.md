# 001 — Research: passthrough topology, upstream Bun state, ops surfaces

Verified against tree e3a059c6 (2026-07-23). Sources: 3 interview Mind-scan
rounds + Sol audit round 1 + live GitHub checks.

## 1. Passthrough branch map (src/server/responses/core.ts:1020-1075)

```
upstreamResponse.ok && isEventStream && body
  └─ [nativeBody, inspectBody] = body.tee()            (:1025)
     ├─ inspectBody → background consumer (eager, full-speed)
     │    recordTerminalOutcomes ? consumeForInspection (:1039)
     │                          : consumeForResponseLogMetadata (:1051)
     └─ nativeBody → client:
          repair configured → relaySseWithResponsesItemIdRepair → relaySseWithFailedTail (:1063-1068)
          win32 && !repair  → nativeBody raw (pure native relay, Bun#32111 workaround) (:1066)
          else              → relaySseWithFailedTail(nativeBody) (:1068)
```

Leak amplification hypothesis (#314): inspectBody is drained eagerly, so tee()
keeps pulling upstream regardless of client speed; a slow Windows client leaves
unread chunks accumulating in nativeBody's branch queue (WHATWG tee semantics),
on a runtime (1.3.14) whose fetch backpressure is broken (#29831 not included).

## 2. Inspection side-effect inventory (core.ts:1030-1058) — MUST be preserved

| Side effect | Wire point | Breakage if dropped |
|---|---|---|
| Terminal outcome recording (#44: post-cancel late terminal → completed/failed, never downgraded) | consumeForInspection onTerminal + reportNativeTerminal (:1035-1041) | account health blind, req-log wrong |
| Account health/rotation | terminalBodyWillRecord=true skips header-path recordCodexUpstreamOutcome (:1006-1012); recording rides inspection | soft-avoid/cooldown/failover dead |
| Multi-turn context cache | rememberPassthroughResponse (:1046) — core.ts:899 "ONLY way a chained turn keeps earlier context" | silent context loss |
| Turn lifecycle | registerTurn(:1029) / unregisterTurn via onDone (:1043,:1054) | drainAndShutdown hangs or skips |
| Cancel finalization | onCancel → onNativePassthroughCancel (:1045) | dropped log entries (#44) |
| First output | onFirstOutput (:1048,:1057) | latency metrics gone |
| Non-recording metadata | consumeForResponseLogMetadata (:1051-1057) | request logs empty |

## 3. Existing relay inventory (src/server/relay.ts)

- relaySseWithFailedTail (:51) — single-reader pull relay; cancel() aborts upstream.
- relaySseWithHeartbeat (:317) — single-reader pull relay WITH inline inspection
  (terminal detection, clientCancelled discrimination, cleanup/onDone). Closest
  existing shape to the planned eager relay, BUT it is client-paced (pull-driven):
  a stalled client delays inspection; no post-cancel drain; no bounded queue.
  → WP2 decision: NEW module relay-eager.ts. Rejection of extend-heartbeat (P3):
  eager pumping + bounded queue + post-cancel discard-drain is a different
  concurrency shape (producer loop + queue), not a parameterization of pull().
  Retrofitting would fork the function internally anyway and risk regressing
  its 3 existing call sites.
- consumeForInspection (:407) — eager background pump; #44 cancel semantics via
  signal listener + cancelled flag; synthetic failed-502 on mid-stream reset.
- relaySseWithResponsesItemIdRepair (responses-item-id-repair.ts:262) —
  async-pull ReadableStream; cancel() does NOT abort upstream.

## 4. Upstream Bun issue matrix (live-checked 2026-07-23)

| Item | State | Evidence | Confidence |
|---|---|---|---|
| #28035 fetch backpressure | CLOSED, fixed by PR #29831 ("couple fetch() receive backpressure to JS body consumption") | github.com/oven-sh/bun/issues/28035 | verified |
| #29831 in bundled 1.3.14? | UNKNOWN — treat as NOT included | no release note found naming it; #32471 reports leak still on 1.3.14 | unverified, assume-worst |
| #32111 async-pull cancel segfault | Fix PR #32120 merged 2026-06-21; NOT assumed in 1.3.14. NOT win32-only (repro on macOS/Linux ARM64) — our code routes around it on win32 only | github.com/oven-sh/bun/pull/32120 | verified (merge), unverified (release inclusion) |
| node:net handle leak PR #31654 | OPEN PR (robobun → main), not merged | github.com/oven-sh/bun/pull/31654 | verified |
| Bundled runtime | package.json:59 pins "bun": "1.3.14"; CI pins same | package.json | verified |

Gate consequence: min-fixed threshold for the eager relay CANNOT be a released
version number today (no release provably carries #32120). Gate semantics:
DEFAULT known-bad = ALL current versions ≤1.3.14 (and any version until a
min-fixed constant is set in a future bundle-bump commit); explicit config
opt-in is the only way to arm the relay until then. The gate module ships the
mechanism + tests; the policy constant flips in the bundle-bump PR.

## 5. Config/env/service surfaces

- Windows service artifacts bake ONLY OPENCODEX_HOME + auth token
  (service.ts:227/364-374/646; winsw.ts:90-94) — shell env NEVER reaches the
  service ⇒ stream-mode flag MUST persist in config.json (OcxConfig, types.ts:422;
  loadConfig/saveConfig config.ts:645/754). debug-settings.ts is in-memory+env
  only (audit blocker 1) — reuse only its override-precedence idea.
- Management API: all /api/* behind requireApiAuth(req, config, "management")
  (index.ts:245); /healthz unauthenticated (:239) — memory endpoint goes under
  /api/system/memory (namespace verified free). CLI already loads service token
  (cli/index.ts:133).
- Doctor: no HTTP call to proxy today; /proc introspection Linux-only
  (doctor.ts:235). Windows path REQUIRES the new endpoint.
- Lifecycle: activeTurns + drainAndShutdown (lifecycle.ts:51) — relay must
  keep register/unregister parity.
- crash-guard benign shapes (crash-guard.ts:150-176): shape 2 ("ReadableStream
  is locked") justified by the tee path; keep rationale coherent when the eager
  relay lands (comment update, not removal — tee path remains default).
- Invariant test: tests/passthrough-abort.test.ts:33-60 asserts the MIRROR
  COMMENT in src/server/index.ts:131-150 (not core.ts). Any core.ts branch
  change must update comment + test in lockstep; banned identifiers inside the
  mirrored block: relaySseWithHeartbeat(, trackStreamLifetime(.

## 6. Honesty labels (docs-site, WP5)

- On bundled 1.3.14 the leak is NOT fixed by this work; it is bounded by
  visibility (watchdog/doctor) + runtime override (OPENCODEX_BUN_PATH) +
  optional opt-in relay (at user's own #32111 crash risk).
- Real RSS relief: "awaiting Windows user verification".
- Threshold auto-restart: DEFERRED (F4) — warn-only watchdog in this unit.
