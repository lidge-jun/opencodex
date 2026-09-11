# 001 — the rescan, with the evidence each verdict rests on

Four read-only lanes, `gpt-5.6-sol` at high effort, against `dev` = `5cec0a33e`.
Every file:line below was re-read by the main session before it was written here.

## What the lanes changed about my prior beliefs

Three findings inverted an assumption I would otherwise have shipped on.

**#3071 is not a one-way missing-field bug.** The tree's own comment at
`src/bridge.ts:149-168` argues the batch omission of singular `query` is
*load-bearing*: codex-rs renders "<first> ..." only when `query` is absent and
`queries.len() > 1`. So the fix is not "add the field" — it is a deliberate trade of
that plural ellipsis for a strict-validator pass, and PR #3069 makes exactly that
trade in its comment rewrite. Anyone reviewing the diff without reading the old
comment would think a bug was being removed when a rendering behaviour is being sold.

**PR #3040 (#3008) fails open, and the issue asked it not to.** It proceeds for every
non-zero *or signal-killed* stop whenever PID/runtime files are absent
(PR-head `src/update/index.ts:42-47`), then claims the proxy is stopped without
probing the captured endpoint (`:279-296`). The current abort at
`src/update/index.ts:260` is over-broad, but replacing it with "proceed unless we can
see a proxy" is worse than the defect: an update that replaces package files under a
live server leaves it executing mixed old/new code, which is the exact hazard the
comment at `:245-250` was written to prevent.

**PR #3056 (#3026) fixes one of the two defects #3026 reports.** The id-aware read is
right — `dev` still calls id-agnostic `readLatestSessionMeta` at
`src/codex/history-provider.ts:552`, `:631` and `:878`, despite already having an
id-aware fold at `:680-688`. But `has_user_event` drift is still rejected
(`:487-500`, `:611-613`) and restore still forces the manifest's value, so the issue
cannot close on that PR alone.

## Per-item evidence

### #3071 / #3068 — 73/80, enters as wp1

`webSearchAction()` omits singular `query` for batches (`src/bridge.ts:164`).
`backfillWebSearchQueries()` repairs only the opposite direction
(`src/adapters/openai-responses.ts:916`). The reporter's direct replay is decisive:
`{queries:["a","b"]}` 400s, adding `query` returns 200.

PR #3069 at `5cf5cc1d230` fixes both functions and both assertions
(`tests/bridge.test.ts:1078`, `tests/openai-responses-passthrough.test.ts:1298`) fail
against current `dev`, so the regression is real. Two non-blocking gaps found by the
tools lane: the stale one-way comments at `src/adapters/openai-responses.ts:904-910`,
and `:927-928` should test `typeof action.queries[0] === "string"` because unknown
input items use a loose schema (`src/responses/schema.ts:106`).

#3068 is the same author, title, body, repro, log and config as #3071. Close it in
favor of #3071; it does not get a second slot.

### #3032 — 75/80, enters as wp2

A measured incident: 6.8 GiB of spill after 44 minutes, with the rate and projection
supplied. Latest PR head `b4d1d2404f` fixes steady-state ordering, reload, periodic
enforcement and deferred-generation accounting — but `spilledResponseBytes()`
(PR-head `src/responses/state.ts:627-651`) counts installed states and deferred
unlinks, not a file being created by `writeResponseSpillDurablyAsync`. That
publication stays live through `:246-300` with up to 256 MiB pending (`:174-179`), so
disk can exceed the advertised 1 GiB cap until ACL publication settles. Six of its
tests are real; none reserves bytes during a blocked Windows publication.

This is the same subsystem wp3 of round 1 just hardened, so the shutdown-drain
invariants have to survive the change.

### #3026 — 75/80, enters as wp3

Reporter measured 6/389 manifest entries affected, and one rejected entry blocks the
whole manifest (`src/codex/history-provider.ts:586-596`), which wedges every
`ocx stop` and `ocx update`. 20/20 on durability: recovery needs manual DB surgery.

### #3029 — 72/80, enters as wp4

`shortPercent` is preserved as a blocking window (`src/codex/quota.ts:587`) but a
short-only snapshot is forced to unknown (`src/codex/routing.ts:374`), and unknown
then passes headroom (`:1173`) and suppresses auto-switch (`:1604`). The comment at
`routing.ts:374` explains why unknown is right for `shortPercent: 0` — it must not
make an unverified account look emptiest — and that reasoning does not extend to a
terminal 100. The tree tests `shortPercent: 87` as unknown
(`tests/codex-routing.test.ts:129`) and has no terminal short-only case.

No open PR targets this. PR #3003 throttles failed WHAM priming instead, and is
independently wrong: two pre-WHAM errors lack `quotaProbeSkipped`
(PR-head `src/codex/auth-api.ts:1013-1021`), causing false five-minute suppression.

### #3008 — 71/80, enters as wp5

`src/update/index.ts:250-267` conflates `stop.status`, PID state and runtime state,
which makes its own history warning at `:269-275` unreachable. `handleStop()` sets
failure after history restoration (`src/cli/index.ts:739-748`), i.e. after teardown
already succeeded, so a history-only failure is indistinguishable from a real one.

### #3019 — 70/80, enters as wp6

Account-list quota sends WHAM once and converts any 401 straight into `needsReauth`
(`src/codex/auth-api.ts:971`, `:978`), while the rejected-bearer recovery primitive
already exists at `src/codex/account-store.ts:588`. PR #3020's core sequence is right
(401 → `forceRefreshCodexPoolToken` → one replay) but it is seven files and ~1300
lines, conflicts with `dev`, and its own full-suite run timed out. Carry the core,
leave the rest.

## Items whose PRs are correct and should just merge normally

Not train work, but recording it so the queue is not re-audited: PR #3052 (#3051) is
correct and narrow at `46125ea83`, and PR #3039 (#3009) is substantively correct at
`8573decb79` once rebased with its zero-budget assertion restored.

## Below-bar component scores

`000` points here for these, so here they are. Same four axes: blast radius /
data-durability / evidence / shippability.

| item | blast | data | evid | ship | total | the axis that decides it |
| --- | --- | --- | --- | --- | --- | --- |
| #3009 Windows 20s repair deadline | 18 | 14 | 18 | 19 | 69 | none low — it simply lands one point short, and PR #3039 already carries the fix |
| #3064 non-ASCII scheduler path | 17 | 14 | 18 | 19 | 68 | data 14: installation rolls back, no durable user data lost |
| #3024 dated configured models dropped | 15 | 12 | 20 | 19 | 66 | data 12: models disappear from a persisted view, nothing is destroyed |
| #2999 native-main publication race | 12 | 20 | 17 | 15 | 64 | blast 12: concurrent native-main refresh only, despite the maximum credential risk |
| #3066 routed private metadata | 18 | 5 | 20 | 19 | 62 | data 5: availability, not corruption |
| #3038 (same defect as #3066) | 18 | 5 | 20 | 19 | 62 | duplicate of the above with a worse implementation |
| #3051 Cursor HTTP/2 pre-header EOF | 14 | 8 | 20 | 20 | 62 | data 8: a stale catalog |
| #3021 encrypted subagent MESSAGE | 14 | 18 | 9 | 18 | 59 | evidence 9: one occurrence, no ciphertext captured |
| #3078 start shadow guard | 13 | 10 | 18 | 18 | 59 | targets `main`, and its test does not typecheck |
| #3070 usage keeps decreasing | 12 | 11 | 8 | 20 | 51 | evidence 8: a screenshot with no route or config correlation |
| #3053 sidecar catalog modalities | 12 | 2 | 15 | 18 | 47 | data 2: a client-side attachment block |
| #2813 Luna Reserve disables routed rows | 18 | 4 | 18 | 8 | 48 | ship 8: no OpenCodex control point identified |
| #3063 combo compact failover | 10 | 3 | 11 | 18 | 42 | evidence 11: source trace only, and the claimed regression is vacuous |
| #1419 Bun SIGTRAP | 18 | 6 | 11 | 4 | 39 | ship 4: no current-runtime repro on the shipped Bun 1.4.0 |
| #1527 Cursor large-context collapse | 14 | 10 | 8 | 5 | 37 | ship 5: the four named mechanisms are already fixed on `dev` |
| #3059 restore-dialog focus | 10 | 2 | 6 | 4 | 22 | evidence 6: the tree contradicts the claimed unmount path |

`#3068` carries #3071's 73 and is suppressed as a duplicate rather than scored
separately.

Two of these are worth a second look if the >=70 set ever empties: #3009 at 69 is one
rebase away from done, and #2999 is the only below-bar item scoring 20 on credential
risk — it is held back by shippability, not by severity.
