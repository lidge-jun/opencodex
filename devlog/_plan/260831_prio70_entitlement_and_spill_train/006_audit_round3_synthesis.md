# 006 — audit round 3: wp1 cleared, wp3 and wp4 corrected

Round 3 on `cef1ea527`. Blocker 1 **CLOSED**, and the question the whole train
exists to answer came back **Yes**. Two findings remain, both accepted.

## CLEARED — wp1 as reduced is sound, and it does fix #3022

The reviewer traced the reported path end to end and confirmed it:

> No inbound version and no `codex-runtime.json` makes tier 3 select
> `GATED_MODEL_CLIENT_VERSION_FLOOR`. Change 1 raises that effective floor to
> `0.144.0`; background sync directly invokes the resolver. The valid Plus
> credential is fetched, upstream is queried under `0.144.0`, and the returned
> sol/terra/luna rows enter a confirmed snapshot. Catalog projection then retains
> those gated rows.

with `src/codex/model-entitlements.ts:122`, `:539`, `:547`,
`src/codex/catalog/sync.ts:1834`, `:1579`.

Also cleared:

- **Change 1's `max()` is sound.** It touches tier 3 only; a genuinely older
  inbound or runtime version still wins. A later snapshot that lowers its recorded
  minimum cannot lower the measured floor — which is the intended safety property,
  not a side effect.
- **2a does not cause a retry storm.** The 15s TTL plus flight dedup bounds it to
  ~4 fetches/minute per account/version.
- **No over-denial.** Projections still expose only roster-present gated models
  (`:573`), so the reduced change cannot widen grants either.

Residual blockers on #3022 are honest ones: no usable credential, an upstream
failure, or an account that genuinely does not get the rows at `0.144.0`.
Management surfaces that never trigger background discovery are wp2's problem, not
#3022's.

## STILL OPEN — wp3, on two counts

### 1. "Enter the fallback at cap expiry" and "fallback uses the remaining budget" contradict each other

If the drain consumes the whole end-to-end deadline, the fallback inherits zero
time. Round 2 wrote both requirements without noticing they cancel.

**Amendment.** Split the budget explicitly: the drain gets a sub-deadline, and a
reserved slice belongs to the fallback. Concretely — end-to-end budget `B`, drain
cap `B - R`, fallback reserve `R`, and the fallback receives `R` rather than
whatever happens to be left. `R` must be large enough for one directory harden plus
one file harden at a reduced per-call deadline, since those are two separate calls
(`src/responses/spill-store.ts:324`).

### 2. Abandon-and-file is a real regression, not the status quo

This correction matters and the round-2 text was wrong.

On `origin/dev`, oversized candidates are published **synchronously before the
request returns** (`src/responses/state.ts:382`, `:393` — `admitOversizedCandidate`
calls `writeResponseSpillDurably` inline). So today there is no shutdown-loss
window at all for that case. `030` even says so itself, then contradicted it by
calling abandonment "unchanged behaviour".

Abandonment is only equivalent to **PR #3018's head**, which is precisely the state
that introduced the loss window. Measuring against the unmerged PR instead of
`dev` is how a regression gets waved through.

**Amendment.** The split condition is withdrawn. wp3 lands the bounded fallback, or
wp3 does not land. If the budget plumbing proves too large, the correct fallback is
**not** to abandon — it is to keep #3018 unmerged until the drain is complete,
because `dev` is currently *correct* on durability and merely slow on Windows. A
47-second stall is worse UX; a lost continuation is worse behaviour. We do not
trade the second for the first.

## NEW — wp4 cannot tell empty from failed

Verified: parsed-empty and network/timeout failure both produce
`{models: new Set(), confirmed: false}` — the success path when `parseAccountModels`
returns an empty set (`src/codex/model-entitlements.ts:414`) and the catch path
(`:424`) are indistinguishable downstream.

So wp4's `unconfirmed-empty` and "refresh failed" are the same state in the data.
Reporting them as different would be the invented-status-field lie `002` objected
to.

**Amendment.** wp4 gains an explicit prerequisite: record failure **provenance** on
the cache entry (parsed-empty / http-error / timeout / unparseable) before any
diagnostic claims to distinguish them, plus a regression asserting the two states
are actually distinct. If provenance is not added, wp4 reports one merged
`unconfirmed` state and says so plainly.

## Standing after three rounds

- wp1 (#3022, the 78/80 shipped regression): **cleared to implement.**
- wp2 (#3023): no blocker raised in rounds 2 or 3; the memo TTL and invalidation
  hook amendments stand.
- wp3 (#3011): blocked pending the budget split and the withdrawal of
  abandon-as-acceptable.
- wp4, wp5: sequenced after, with wp4 now dependent on failure provenance.

Implementation begins with wp1, which is the user-visible regression and the one
the reviewer has now positively traced to a fix.
