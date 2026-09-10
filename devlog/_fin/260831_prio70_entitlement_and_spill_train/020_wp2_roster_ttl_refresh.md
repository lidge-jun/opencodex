# 020 — wp2: refresh the expired roster at the shared entry point (#3023)

Stacks on wp1. Consumes `002`. One PABCD cycle.

Branch: `codex/3023-roster-ttl-refresh`, based on the wp1 head (stacked child).

## Why it stacks rather than lands independently

wp2 makes the management surfaces re-read the entitlement record. wp1 fixes *what*
that record contains. Landing wp2 alone would refresh a still-wrong answer: the
bug would appear fixed on a warm cache and persist on a cold one.

## Change 1 — a conditional ensure, not an unconditional resolve

New export in `src/codex/model-entitlements.ts`: an ensure/freshness operation that
enters the real resolver **only** for credential/version entries that are missing
or past their own deadline. It must treat as cached answers:

- a confirmed roster inside `MODEL_ROSTER_TTL_MS`;
- an empty or all-filtered UNCONFIRMED entry within `MODEL_ROSTER_FAILURE_TTL_MS` (wp1
  removed the confirmed-empty case entirely, `:465-478`);
- an unconfirmed failure entry inside `MODEL_ROSTER_FAILURE_TTL_MS`.

It must reuse the existing per-account/version keys and in-flight deduplication
(`:323-325`, `:524-526`, `:542-552`) so concurrent pollers collapse into one upstream fetch.

### Amendment after audit round 1 (`004`, blocker 2): the logged-out hole

"Refresh entries that are missing" **misses forever** when there is no credential.
`MAIN_CODEX_ACCOUNT_ID` is always a candidate (`:556-563`), but
`accountCredentialSnapshot` returns null without one, so the account is filtered
out before any cache entry is created (`:391-419`, `:592-602`). Nothing is ever cached, so
every poll re-enters the full resolver — ~24 times/minute, which is precisely the
cost this cycle forbids.

So the ensure needs a **bounded negative memo**: "no usable credential for account
X as of T", with its own short TTL, checked before credential enumeration. Absence
of a credential is a cacheable answer, not a cache miss.

Regression: repeated logged-out ensures perform zero credential enumerations after
the first. This is the assertion that proves the steady state, and it is red
against a naive implementation.

### The memo needs an invalidation hook (audit round 2 — `005`)

Credential commits do not invalidate entitlement state today
(`src/codex/account-store.ts:131`, `src/codex/auth-api.ts:2016`,
`src/codex/model-entitlements.ts:686-693`). So a negative memo means a **fresh login
stays invisible until the memo expires** — the user logs in and the dashboard still
shows nothing.

Two requirements, both testable:

1. **TTL pinned at 5000 ms.** It bounds how stale a successful login can look, so it
   is a UX number rather than an implementation detail, and it is written here so a
   later change has to argue with a number instead of a vibe.
2. **Clear the memo on every credential write.** Regression: log in, then the very
   next ensure sees the credential without waiting out the TTL.

### The full hook set (audit round 5 — `008`, finding 3)

Round 2's two hooks were not enough, and one was misidentified.
`src/codex/auth-api.ts:2015` is the *branch*; the save is `:2016`, and hooking that
line still misses new-account login at `:546`. The complete set of local credential
mutations:

- `src/codex/account-store.ts:131` — the commit primitive (correctly identified).
- `src/codex/auth-api.ts:2016` and `:546` — existing-account save and new-account
  login.
- `src/codex/account-store.ts:195-218` — pool CAS refresh, called at `:705`, `:790`.
- `src/codex/account-store.ts:252-309` — owner/alias refresh, called at `:858`.
- `src/codex/account-store.ts:312-320` — deletion and tombstone, via
  `src/codex/account-lifecycle.ts:158`.
- `src/codex/main-account.ts:133-163` and `:219` — main-token refresh.
- `src/codex/native-profile-manager.ts:1307`, `:1335`, `:1449` — canonical
  `auth.json` writes during native-profile switch, rollback and recovery, with the
  successful transitions at `:1318` and `:1453`. Added after audit round 6
  (finding 2): these are OpenCodex's own writes, not external ones, so they belong in
  the epoch rather than being left to the identity probe. Regression: a credential
  write that lands **during** an in-flight ensure must not be masked by that flight's
  result.

`src/codex/auth-api.ts:1630-1641` (active-account switch) is config-only and needs
**no** memo clear.

Two consequences for the design:

1. **One cycle-free mutation epoch**, incremented at every successful commit and
   tombstone, rather than a clear-call bolted onto each of the eight call sites.
   Eight hooks is eight chances to miss one, and the miss is silent.
2. **A bounded identity probe has to remain.** External replacement of
   `~/.codex/auth.json` — another Codex process, a manual edit, `codex login` outside
   this proxy — cannot be hooked at all. The memo can be cheap, but it cannot be
   authoritative.

Without this, the cycle fixes a missing-rows bug by shipping a different
missing-rows bug.

## Change 2 — await it from the shared entry point

`src/server/management/model-rows.ts:50`, `listManagementModelRows`: await the
ensure in parallel with `fetchAllModels`, before `nativeModelRows` — the shape
`/v1/models` already uses (`src/server/index.ts:1158-1164`).

The two wait policies cannot be expressed by a bare call (audit round 6, finding 3):
sidecar reaches this very function (`src/sidecar/candidates.ts:40`), so the waiting
policy has to be a parameter of the entry point rather than a property of the
ensure.

```ts
export async function listManagementModelRows(
  config: OcxConfig,
  options: { entitlementWaitMs?: number } = {},
): Promise<ManagementModelRow[]> {
  const [routed] = await Promise.all([
    fetchAllModels(config),
    ensureCodexEntitlementFreshness(config, { waitMs: options.entitlementWaitMs ?? 3_000 }),
  ]);
```

Sidecar passes `{ entitlementWaitMs: 0 }`; `/api/models`, `/api/client-config`,
integrations and `ocx export` take the 3000 ms default.

This repairs all three reported surfaces at once because they funnel here:
`/api/models` directly, `/api/client-config` via `loadExportModels`, and
`ocx export` by requesting `/api/models` over HTTP
(`src/cli/export-command.ts:181`).

**Failure must not throw.** A rejection here would degrade sidecar candidates
(`src/sidecar/candidates.ts:35-40`) and could turn client-config into a 503. The
ensure resolves with a bounded fail-closed result; the rows stay short, which is
the honest outcome, and Change 3 makes that visible.

## Cost bound (the constraint that shapes this)

The dashboard reaches this entry point ~24 times/minute (`/api/sidecar-settings`
every 5s, computing vision and web-search candidates independently), ~30 with the
Models page open. Polls pause on a hidden document.

So the ensure must be a **cache read** in the steady state. Corrected after audit
round 5 (`008`, finding 2): "no credential validation" is not achievable as stated.
The cache key is `(accountId, clientVersion)` (`:323-325`) but freshness also
compares `credentialIdentity` (`:517-522`), and reading the current identity means
touching `auth.json` or the account store (`:378-389`). A pure cache read would
need a cross-process credential-generation signal that does not exist.

Measured target, restated honestly: **zero token refresh and zero network** with a
fresh roster. An identity-only read is permitted; the full
`accountCredentialSnapshot` (`:391-419`) is reserved for entries that are missing,
stale, or identity-mismatched. That assertion is a test, not a hope.

## Change 3 — moved out of this cycle

> Removed after audit round 1 (`004`, blocker 4). The draft named no transport.

`/api/models` returns a bare **array** (`src/server/management/model-routes.ts:352-354`)
and both the GUI and `ocx export` depend on that shape
(`gui/src/pages/Models.tsx:402-417`, `src/cli/export-command.ts:169-185`). A
top-level field breaks them; a per-row field duplicates global state on every row.

The honest diagnostic therefore needs its own endpoint decision, which is a design
question, not a line of code. It is now **wp4** (`040`). wp2 is the refresh fix and
nothing else.

## Regressions

> Corrected after audit round 5 (`008`, finding 6). Three of the four original
> claims were false reds — already green through `:517-552` and wp1's own tests at
> `tests/codex-model-entitlements.test.ts:672-749`. Baseline across the four files
> is 93 pass / 0 fail, so a claim of "red today" has to be earned per case.

**Genuine reds (the wp2 defect itself):**

- `tests/codex-model-entitlements.test.ts` — **credential-read count**: after priming,
  repeated ensures perform **zero `accountCredentialSnapshot` calls**. Corrected after
  audit round 6 (finding 4): asserting only "zero token refreshes and zero fetches"
  is false-green, because the current resolver already satisfies it while still
  invoking the full credential snapshot (`:592-601`). Identity-only reads are
  permitted and counted separately.
- `tests/codex-model-entitlements.test.ts` — **logged-out negative memo**: repeated
  ensures with no credential perform exactly one credential enumeration, not one per
  call. Red against a naive "refresh what is missing" implementation, which never
  caches the absence and so re-enters the resolver ~24 times a minute.
- `tests/codex-model-entitlements.test.ts` — **memo invalidation**: after a
  credential write, the very next ensure sees it without waiting out the memo TTL.
- `tests/management-client-config-route.test.ts` — entitlement fetch count is **1**.
  Red because the current count is **0**: the shared entry point never resolves
  entitlements at all, which is the defect.
- `tests/native-model-toggle.test.ts` — expired confirmed roster, `/api/models`
  still lists sol/terra/luna. Red **only if** the fixture supplies a usable
  credential and an upstream roster; without both, it is vacuous.
- `tests/cli-export-command.test.ts` — red **only after** its stub proxy
  (`tests/cli-export-command.test.ts:51-57`) is repointed at the real `/api/models`
  handler and the assertion names the gated ids. The stubbed rows bypass the
  defective boundary entirely, so today's green proves nothing about this defect.

**Already green — do not claim as proof:** fresh repeated ensure yielding zero
refetches, TTL+1 collapsing to exactly one fetch, and an unconfirmed failure entry
surviving 15s. All three hold today through `:517-552`.

**Rejection regressions (audit round 5, finding 4):** the ensure must not throw at
its boundary. One case for sidecar degrading to auth slots
(`src/sidecar/candidates.ts:35-61`) and one for client-config answering 503
(`src/server/management/model-routes.ts:393-409`) — both must be unreachable via a
failed ensure.
## Must not change

The expiry check (`:673`) — serving expired grants breaks fail-closed revocation.
`/v1/models` authorization or version behaviour. Per-account/version keys.
Synchronous `nativeModelRows` must stay synchronous.

## Open question — SETTLED (audit rounds 5 and 6, `008`)

The draft default (wait out the refresh) is wrong, and a flat per-waiter 3s
deadline is also wrong: the sequential sidecar calls at
`src/server/management/config-routes.ts:589-593` would accumulate up to 6s.

**One whole-ensure flight**, caught fail-closed, and **never aborted by a management
timeout** — the upstream work always runs to completion so the cache is warm for the
next caller. Deduplicating the *whole* ensure matters because roster-fetch dedup
begins only after credential enumeration (`:524-552`), so abandoning a wait would
otherwise repeat the credential work.

### The flight needs an identity, not just a timestamp (audit rounds 6 and 7)

A bare `{ startedAt, promise }` can cross-answer: two callers with different
candidate sets, different client versions, or a credential change in between would
join a flight that is not answering their question. The existing per-entry dedup is
keyed by account, credential identity and version (`:524-526`), and the whole-ensure
flight must not be weaker than the thing it wraps.

The mutation epoch alone is **not** sufficient (audit round 7, finding 1). External
`auth.json` writers cannot advance it — that is stated a few sections up and it is
exactly the gap: a caller that has already observed a new identity would otherwise
join an old-identity flight, which the per-entry dedup would never have allowed.

So the flight key is:

**(normalized candidate set, client version, mutation epoch, identity vector)**

where the identity vector is the normalized list of
`(accountId, credentialIdentity | null)` observed by the joining caller. The
identity-only read that the cost bound already permits is what produces it, so this
costs nothing extra: the caller has the vector in hand before it decides to join.

### The key must also carry the workset (audit round 8, final blocker)

Candidate set, version, epoch and identities can all be unchanged while an **entry
expires mid-flight**. Concretely: a flight starts when account B is still fresh and
so refreshes only A; B then expires; a second caller computes an identical key,
joins, and the resolver's `now` is still fixed from the flight's start
(`src/codex/model-entitlements.ts:586`), so B remains a cache hit (`:517-522`). The
one-shot caller — `ocx export`, the surface #3023 reported — returns short rows
having refreshed nothing.

So the key includes the normalized **`needsRefreshAccountIds`** workset, or joining
is permitted only when the new caller's workset is a **subset** of the running
flight's. Overlap is already deduplicated one level down by the per-account flights
(`:524-552`), so the stricter rule costs at most one extra credential pass and never
an extra roster fetch.

Regression: B expires while an A-only ensure flight is running; the next caller must
refresh B rather than joining and reporting stale-short rows.
### Negative-memo publication is fenced on identity, not just epoch (round 7, finding 2)

An epoch fence alone still lets an external login during a flight receive a freshly
published 5000 ms negative memo once that flight settles. Two requirements:

1. **Fence publication on the captured identity vector.** A settling flight may
   publish "no credential for X" only if X's identity is still what the flight
   observed when it started. Otherwise it discards the memo and lets the next caller
   re-ask.
2. **Measure expiry from the absence observation, not from settlement.** A flight
   that spent 30s in a credential refresh must not then hand out a memo that is
   treated as 5000 ms fresh; its evidence is already 30s old.

Regressions, both genuinely red: a **local epoch write during an in-flight ensure**,
and an **external `auth.json` replacement during an in-flight ensure**. The second
is the one an epoch-only design silently fails.

### Wait policy

- Sidecar candidate paths join with a **0 ms** wait: they never stall, they read
  what is already cached.
- `/api/models`, `/api/client-config`, integrations and `ocx export` wait up to
  **3000 ms**, measured from the flight's original start rather than from each
  waiter's arrival.

`MODEL_ROSTER_TIMEOUT_MS` (8s) is **not** a total bound and must not be treated as
one: it starts inside the roster fetch (`:438-445`), and credential refresh can
spend 30s before that (`src/codex/main-account.ts:188-190`,
`src/codex/account-store.ts:743-746`). The 3000 ms ceiling is what the management
surfaces actually observe; the work behind it may outlive that ceiling.

### Convergence, stated accurately (audit round 6, finding 5)

Not "within one 5s poll cycle" — that contradicts the 30s credential refresh and 8s
roster bound above. The honest statement: a management surface converges on **the
first poll after the background flight settles**. With a warm credential that is
usually the next poll; with a cold credential refresh it can be several. The
guarantee this cycle makes is that **no poll stalls**, not that every poll is fresh.
