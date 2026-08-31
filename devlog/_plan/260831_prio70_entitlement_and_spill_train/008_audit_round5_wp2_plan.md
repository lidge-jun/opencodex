# 008 — audit round 5: wp2 plan re-audit after wp1 landed

Auditor: sol-high subagent, read-only, run against `codex/prio70-train-260831` at
`1b6b36b96` (wp1 merged into the branch). Verdict **FAIL** — five substantive
corrections plus a stale-citation sweep. All are folded into `020`.

## Findings

1. **Citations shifted by wp1** (+45 lines or so in `model-entitlements.ts`).
   `:223` → `:323-325`; `:455` → `:524-526`, `:542-552`; `:500-506` → `:556-563`;
   `:539-550` → `:391-419`, `:592-602`; `:630` → `:686-693`; expiry `:509` → `:673`.
   Also `auth-api.ts:2015` → `:2016`, `server/index.ts:1155` → `:1158-1164`,
   `export-command.ts:169` → `:181`, `sidecar/candidates.ts:29` → `:35-40`.
   Still valid: `account-store.ts:131`, `model-rows.ts:50`,
   `model-routes.ts:352-354`, `Models.tsx:402-417`.

2. **"Zero credential validation in the steady state" is unachievable as written.**
   The cache key is `(accountId, clientVersion)` (`:323-325`), but freshness also
   compares `credentialIdentity` (`:517-522`), and obtaining the current identity
   reads `auth.json` or the account store (`:378-389`). A pure cache read would need
   a cross-process credential-generation signal that does not exist. Redefined
   target: **zero token refresh and zero network**, via an identity-only read, with
   the full `accountCredentialSnapshot` (`:391-419`) reserved for entries that are
   missing, stale, or identity-mismatched.

3. **The invalidation hook list was incomplete**, and one entry was wrong.
   `auth-api.ts:2015` is the branch, not the save (`:2016`), and hooking it misses
   new-account login at `:546`. Also required: pool CAS refresh
   (`account-store.ts:195-218`, called at `:705`, `:790`), owner/alias refresh
   (`:252-309`, called at `:858`), deletion/tombstone (`:312-320` via
   `account-lifecycle.ts:158`), and main-token refresh
   (`main-account.ts:133-163`, `:219`). External replacement of
   `~/.codex/auth.json` cannot be hooked at all, so a bounded identity probe has to
   remain. Active-account switch (`auth-api.ts:1630-1641`) is config-only and needs
   no clear. One cycle-free mutation epoch at every successful commit and tombstone,
   rather than a hook per call site.

4. **Awaiting in `listManagementModelRows` is structurally safe; rejecting is not.**
   The function is already async, every production caller awaits it, and
   `nativeModelRows` stays synchronous (`src/codex/catalog/metadata.ts:414`). But a
   rejection degrades sidecar to auth slots (`src/sidecar/candidates.ts:35-61`) and
   makes client-config answer 503 (`model-routes.ts:393-409`). The ensure must be
   non-throwing at its boundary, with a regression for each of those two outcomes.

5. **The 8-second figure is not a total bound.** `MODEL_ROSTER_TIMEOUT_MS` starts
   inside the roster fetch (`:438-445`); credential refresh can spend 30 seconds
   first (`main-account.ts:188-190`, `account-store.ts:743-746`). And flight dedup
   begins only *after* credential enumeration (`:524-552`), so abandoning a wait
   avoids duplicate roster fetches but not repeated credential work. The whole
   ensure operation has to be deduplicated, with the deadline anchored to the
   flight's start.

6. **Three of the four regression claims were false reds.** Fresh-zero-refetch,
   TTL+1-single-fetch, and unconfirmed-failure-caching are already green through
   `:517-552`, and the empty/all-filtered 15s behaviour is already covered by wp1's
   own tests (`tests/codex-model-entitlements.test.ts:672-749`). The genuine wp2
   reds are the **credential-read count** and the **logged-out negative memo**. The
   `/api/models` and client-config assertions are red only if the fixture supplies a
   usable credential and upstream roster — and client-config's expected fetch count
   of 1 is red because the current count is **0**, which is the defect itself. The
   CLI case is red only after its stub (`tests/cli-export-command.test.ts:51-57`) is
   replaced with the real handler. Baseline across the four files: 93 pass, 0 fail.

7. wp1 removed the concept the plan still named: there is no "confirmed-empty
   entry" any more (`:465-478`). The correct noun is "an empty or all-filtered
   **unconfirmed** entry within `MODEL_ROSTER_FAILURE_TTL_MS`".

## Open question — settled

The plan's default (wait out the refresh) is wrong, and my proposed flat 3s
per-waiter deadline was also wrong: sequential sidecar calls
(`src/server/management/config-routes.ts:589-593`) would accumulate up to 6s.

**Decision.** One whole-ensure flight carrying `{ startedAt, promise }`, caught
fail-closed, and **never aborted by a management timeout** — the upstream work
always runs to completion so the cache is populated for the next caller.

- Sidecar candidate paths join with a **0 ms** wait. They never stall; they read
  whatever is already cached.
- `/api/models`, `/api/client-config`, integrations and `ocx export` wait up to
  **3000 ms**, measured from the flight's original `startedAt` rather than from each
  waiter's own arrival.

That keeps the useful one-shot window for `ocx export` — which is the surface
#3023 actually reported — while a dashboard poll never stalls and converges within
one 5s cycle.
