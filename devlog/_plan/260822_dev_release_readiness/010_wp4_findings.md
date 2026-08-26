# 010 — WP4 audit lane findings (consolidated)

Six read-only lanes executed the 002 matrix at head 67b5fa019 (inherited-
model fallback after ox-alpha 429'd on 6 parallel spawns — the stealth
model's rate pool cannot host 6 concurrent lanes).

## Verdicts

| Lane | Verdict | Notes |
|---|---|---|
| L1 cursor stack | 0 P0 / 0 P1 / 1 P2 | 351 tests green across 7 rows; classifier chain single-pass proven; watchdog disarm ordering verified |
| L2 registry/quota | CLEAN | 5 rows; noVision substring fear disproven (modelInList exact/colon match); quota display-only |
| L3 release surface | CLEAN | file:line security confirmation delivered: key path env-only (release.ts:244), fixed-string rejection errors, all 16 workflows SHA-pinned, release.yml permissions {} |
| L4 GUI/mgmt API | 0 P0 / 0 P1 / 1 P2 | GET/PUT/runtime parity proven; i18n keys typed-complete |
| L5 runtime/CI | CLEAN | Bun 1.4 mitigations individually green; Windows service state machine fail-closed; aggregate-gate derives needs from all jobs |
| L6 responses-core | CLEAN | 635 tests green; compaction ordering invariant honored; describe-executor recursion fenced at depth 1 |

## P2 register (not promote blockers)

1. **[L1] ~1MiB invalid_argument replay burn** — oversized single message
   triggers one guaranteed-pointless fresh-conversation replay (~doubles
   time-to-error). Fix sketch recorded (pre-flight size guard before
   runOnce). Own cycle later.
2. **[L4] routed-vision GET display drift** — GET does not re-verify
   targetVisible, so a later noVisionModels edit shows stale routed pair
   while runtime falls through. Display-only; reachable only by hand-edit.
3. (carried from 002) deploy-key least-scope is host-config, outside code
   audit; Bun canary pinning moot since stable bump.

## Gates run this phase

- bun x tsc --noEmit: clean.
- Full suite: 14264 pass / 10 skip / 0 fail (897 files, 613s — slow due to
  parallel audit lanes on the same machine, not test regressions).
- privacy:scan: green (run in WP1/WP3 closes; re-run at WP5 close).
- Matrix note: several 002 "Verify" globs named nonexistent files; lanes
  located and ran the real nearest coverage (recorded per lane report).

