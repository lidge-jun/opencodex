# wp5 — hardening, activation evidence, delivery

## Deferred review findings, now closed

Both were accepted in `004_wp3_review_response.md` as real but non-blocking, and both are
fixed here rather than left as known issues.

### Finding 4 — the debounced write was starvable

`schedulePersist` cleared and re-armed its timer on every observation, so any write cadence
faster than the 250 ms debounce deferred the write indefinitely. Measured on the unfixed
version:

| Cadence | Observations | Disk writes |
| --- | --- | --- |
| every 40 ms for 3 s | 75 | 0 |
| every 10 ms for 2 s | 200 | 0 |
| every 400 ms | 5 | 5 |

The trailing write lands once traffic quiesces, so this was starvation rather than breakage —
but a busy pooled install killed with SIGKILL (container stop, OOM) lost its entire baseline
and re-baselined on restart, silently missing any reset spanning the gap. That is exactly the
across-a-restart guarantee the store exists to provide. The module already reasoned about this
for claims ("a claim MUST NOT ride the debounce") and then left the baseline riding it.

**Fix:** a maximum-staleness cap. `firstDeferredPersistAt` records when the pending write was
first scheduled; once deferral exceeds 1 s the next call writes immediately. At 0.29 ms per
serialize-and-write, a forced write per second under sustained load is free.

**Test honesty note.** The first version of the regression test asserted the state file
EXISTED, passed with the cap removed, and therefore proved nothing — hydration already creates
the file. It now truncates the file first and asserts the observed row reached disk while
traffic was still arriving. With the cap removed: `(fail)`. With it: `(pass)`. Worth recording,
because the vacuous version looked identical from the test list.

### Finding 7 — `updateAccountQuota` committed windows without notifying

It writes `weeklyPercent`/`monthlyPercent` and their deadlines but had no
`notifyCodexQuotaSnapshot` call. No in-repo caller today, but it is re-exported as public API
through `src/codex/auth-api.ts`, so a future caller would have bypassed detection *and* left a
stale baseline that corrupts the next real diff. Now notifies. The credits-only path in
`setAccountQuotaFromParsed` still deliberately does not — it carries no window values.

## Known limitations, stated rather than buried

- **`detectedAt` brackets a reset; it does not timestamp one.** Observation cadence is bounded
  by the 5-minute provider cache TTL and the 10-minute per-account TTL, so the reset instant is
  only ever known to lie between two observations. The field is named `detectedAt` rather than
  `resetAt` precisely so every consumer sees that.
- **Two deliberate false negatives** (recorded in `003_wp3_audit_response.md`): a clockless
  window that resets while unused, and a rollover immediately followed by heavy use that
  restores the previous percentage. Both are silent by design — the alternative in each case is
  a rule that also fires on healthy traffic.
- **Rolling-window creep suppression is heuristic.** A reset whose new deadline lands within 2x
  the elapsed gap reads as creep. On the observation paths that exist here the gap is minutes
  and a real window is hours, so the margin is wide; it is not a proof.
- **Payload privacy is a type obligation, not a scanned one.** `bun run privacy:scan` reads
  repository text, not runtime output. The payload is built field by field with a closed type
  and an asserting test; nothing mechanical prevents a future field from being added wrongly.

## Out of scope

`src/codex/reset-credit-recovery.ts` owns credit *consumption*, not window detection, and is
currently unwired in production. Untouched.
