# Measured: what `meta-muse` has, and what a first-class OAuth provider has

Research doc (000-range). No diffs here; the implementation lives in the decade docs.

Measured against this checkout on 2026-09-03 (`dev` at `162d11e18`) by an independent
read-only reviewer, then spot-verified by the main agent on the load-bearing rows. Every
claim carries a file:line. Reference providers: `anthropic`, `kiro`, `google-antigravity`.

## A. The user-visible defect, traced end to end

The dashboard shows no Muse usage because of exactly one predicate:

```ts
// src/providers/quota.ts:1477
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic" || provider === "kiro" || provider === "google-antigravity";
}
```

The chain, in order:

1. `gui/src/hooks/useProviderAccountPools.ts:100` requests
   `/api/oauth/accounts?provider=meta-muse&quota=1` — for **every** OAuth provider, with
   no allowlist. The GUI is already asking.
2. `src/server/management/oauth-account-routes.ts:284` computes
   `wantQuota = url.searchParams.get("quota") === "1" && supportsPerAccountQuota(provider)`,
   which is false, and returns the plain account list.
3. `gui/src/components/provider-workspace/ProviderAuthPanel.tsx:517` renders `QuotaBars`
   only when `account.quota != null || account.quotaUnavailable || reserveQuotaSlots`.
   None hold, so after the reserve timer expires the row shows nothing.

**Nothing is broken.** Every layer behaves correctly for a provider that reports no
quota. The provider note says so itself (`src/providers/registry.ts:1543`): "Meta
reports subscription window usage inside streaming responses, but OpenCodex does not yet
read or display it."

That matters for the fix: the GUI request and the bar component both already exist and
are provider-agnostic, so the server-side write is the whole of the missing machinery.

## B. Surfaces `meta-muse` already inherits, with no code

Recorded so wp3 does not "fix" something that works. All follow from
`authMode: "oauth"` plus absence from an exclusion set.

| Surface | Why it already applies | Evidence |
|---|---|---|
| login / status / logout, account list, switch active, remove, alias | `isPublicOAuthProvider` is `name !== "chatgpt" && isOAuthProvider(name)` | `src/oauth/index.ts:296`; routes at `oauth-account-routes.ts:145,254,305,521,535` |
| GUI account rows, switch, reauth, add-account | the panel keys on the OAuth surface, not the provider id | `ProviderAuthPanel.tsx:224` |
| HIGH_RISK ToS modal | explicitly listed | `gui/src/oauth-tos-risk.ts:10` |
| 429 rotation across accounts | `EXCLUDED_PROVIDERS = new Set(["openai", "anthropic"])`; everything else with `authMode: "oauth"` is in | `src/oauth/generic-account-failover.ts:52,100` |
| serving-account attribution | `stampOAuthAccountLabel(..., resolved.accountId)` runs for every OAuth provider | `src/server/responses/core.ts:3440` |
| SSE inspection on the passthrough path | `createSseInspector` has no provider allowlist | `src/server/relay.ts:886` |
| per-token cost rows | both Muse Spark 1.3 tiers already priced | `src/usage/expected-prices.ts:169-170` |
| CLI `list` / `current` / `use` / `remove` / `alias` / `login` | classified `"oauth"` generically | `src/cli/account-api.ts:85` |

Two more **compile and run today but are inert** for want of a cached quota row:
headroom-ranked pre-dispatch selection (`generic-account-failover.ts:281` returns null
when `hasHeadroomEvidence` is false) and quota-aware cooldown. wp1 arms both as a side
effect — worth knowing, because it means wp1 changes routing behaviour for a user with
two Muse accounts, not only a display.

**That side effect carries the unit's one Critical finding.** `headroomOf`
(`account-quota-rank.ts:36`) reads `getCachedProviderAccountQuota`, which applies no
staleness check (`quota.ts:1489` returns `entry.quota` without consulting `entry.ts`).
Every existing caller is safe by construction — a row exists only because a probe wrote
it, and `fetchAccountQuota` re-probes past `ACCOUNT_QUOTA_TTL_MS` (`quota.ts:1602`) — so
freshness is an invariant of the probe path rather than a property of the cache.

A passive row is the first row in this system that no probe refreshes. Feeding one to a
routing decision would make the proxy confidently prefer an account whose measurement is
arbitrarily old. wp1 therefore bounds the ROUTING read at one hour
(`010` §`account-quota-rank.ts`) while leaving the DISPLAY read unbounded, because wp2
shows the age and a human can discount it. Same number, two consumers, different
obligations.

## C. The real gaps

| # | Surface | Gap | Evidence | Disposition |
|---|---|---|---|---|
| 1 | per-account quota read | `supportsPerAccountQuota` excludes `meta-muse`, and it is the wrong predicate anyway — it gates a **probe** | `quota.ts:1477`, `:1683`, `:1629` | wp1: a separate cache-only reader |
| 2 | quota write | nothing ever keys `meta-muse\0<account>` in `accountQuotaCache` | `quota.ts:1430` | wp1 |
| 3 | `?quota=1` enrichment | gated on the probe predicate | `oauth-account-routes.ts:284` | wp1 |
| 4 | observation age | `QuotaBars` renders no timestamp; `AccountQuota.updatedAt` exists but is unread | `QuotaBars.tsx:164`, `codex-quota-utils.ts:21` | wp2 |
| 5 | provider-level row | `maybeFetchProviderQuota` has no `meta-muse` branch, so the Providers overview card is empty | `quota.ts:2298-2301` | wp3 decides: derive from the cache or record NOT-APPLICABLE |
| 6 | provider note | says the quota is unread — false once wp1 lands | `registry.ts:1543` | wp3 |
| 7 | docs-site | same stale sentence | `docs-site/.../providers.md:475` | wp3 |
| 8 | `ocx account refresh` | prints "no quota report" | `src/cli/account-extended.ts:328` | wp3: must stay probe-free by design; make the message honest |
| 9 | `skills/ocx` recipes | no `meta-muse` account recipe | `skills/ocx/references/03_recipes.md:16` | wp3 |

## D. Surfaces that are NOT gaps, and why

Recorded now so wp3 does not spend effort proving them twice.

- **Connection test.** `provider-routes.ts:1195` short-circuits any provider with
  `liveModels === false` to `{ applicable: false, reason: "static_catalog" }` before any
  network call. `meta-muse` sets `liveModels: false` deliberately (`registry.ts:1538`):
  the authenticated roster carries `muse-image-1.0` and `muse-voice-transcribe-1.0`,
  which a Responses-agent provider cannot drive. `kiro` is in exactly the same class.
  **NOT-APPLICABLE by design, not a gap.**
- **`clear-cooldown`.** Anthropic-only (`oauth-account-routes.ts:465`) because the
  generic failover health map is process-local (`generic-account-failover.ts:78`).
  Provider-wide absence; out of scope for a Muse unit.
- **Account import.** `ACCOUNT_IMPORT_PROVIDER = "google-antigravity"`
  (`src/oauth/account-import/types.ts:3`) — a cockpit-tools document format with no Meta
  analogue.
- **401 replay.** `FORCE_REFRESH_PROVIDERS = new Set(["xai", "github-copilot", "kiro"])`
  (`src/oauth/index.ts:540`). Muse holds a **static API key** — `003` §B measured the
  OAuth `access_token` returning 401 while the sibling `api_key` returns 200 — so there
  is nothing to force-refresh. Adding it would replay an identical credential.
- **Background refresh.** `defaultRefreshPolicy: "disabled"` (`src/oauth/index.ts:240`),
  the same posture as `anthropic`, for the same reason: the vendor restricts use outside
  its own client, so every exchange stays attributable to a user action.

## E. The seam wp1 uses, measured

`050` planned to add `onSubscriptionUsage` to `SseInspectorHandlers`. That handler is
unnecessary — the general seam already exists and is strictly better placed:

```ts
// src/server/relay.ts:834
onParsedPayload?: (payload: unknown) => void;
```

It fires for **every** parsed SSE frame, and critically it fires *before* terminal
handling (`relay.ts:1020`), inside a `try/catch` that guarantees inspection never throws
into the pump (`:1021`). All three passthrough construction sites already thread it:

| Site | Line | How |
|---|---|---|
| eager relay | `core.ts:4811` | `onParsedPayload: noteInspectedPayload` |
| tee + terminal | `core.ts:4862` → `relay.ts:1357` | via `inspectionConsumerOptions` |
| tee metadata-only | `core.ts:4862` → `relay.ts:1411` | same options object |

Both tee consumers read the same `inspectionConsumerOptions` literal built at
`core.ts:4857`, so extending `noteInspectedPayload` covers every passthrough shape at
once. **This is why `relay.ts` is not in wp1's file list.**

### The serving account, in that scope

`runResponses` holds these at the point the inspector is constructed:

| Variable | Declared | Meaning |
|---|---|---|
| `genericFailoverAccountId` | `core.ts:3309`, set `:3444` | the account `meta-muse` actually dispatched on; rebound at each rotation site (`:5131`, `:5445`, `:6134`) |
| `resolved: OAuthAccessSnapshot` | `:3397` | carries `.accountId` and `.generation` |
| `replayOAuthCredentialSnapshot` | `:3304`, filled `:3431` | `{ accountId, generation }` |
| `anthropicPoolAccountId` | `:3305` | Anthropic only |

`genericFailoverAccountId` is rebound by every rotation, so reading it **at event time**
— not at handler-construction time — is what makes attribution survive a mid-turn
failover. That is the difference between recording the quota of the account that served
the turn and recording it against the account that failed.

## F. Generation fencing: the correction `050` already carried, verified

`050` recorded an A-gate finding that capturing the generation immediately before the
write cannot see a config change that happened **earlier in the turn**. The tree
confirms the mechanism it must use:

```ts
// src/providers/quota.ts:1470
function mayCommitAccountQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountQuotaKeys.has(key);
}
```

Every existing writer follows the same shape: `captureConfigGeneration()` before the
await, `mayCommitAccountQuotaKey` before the `set` (`quota.ts:1378`, `:1404`, `:1648`).
A streaming turn is a long await, so the caller must capture when it resolves the
credential and pass the number in.

Reconciliation removes rows whose account no longer exists
(`reconcileProviderAccountQuotaRows`, registered as `provider-quota-history` in
`src/lib/state-store-registrations.ts:109`), so a logged-out account cannot leave a stale
bar behind.

## G. Persistence, measured

`persistAccountQuotaCache` (`quota.ts:1449`) debounces into
`schedulePersistAccountQuotas` (`src/providers/account-quota-disk.ts:59`), and
`readPersistedAccountQuotas` (`:40`) drops rows older than `DISK_MAX_AGE_MS` = 6 hours
(`:28`).

**This bounds the honesty problem in wp2.** A passive observation can be arbitrarily old
in memory, but a restart discards anything past six hours. The in-memory TTL
(`ACCOUNT_QUOTA_TTL_MS` = 10 minutes, `quota-wire.ts:22`) is a **probe** TTL — it decides
when to re-probe, and `sweepExpiredProviderAccountQuotaRows` is exported but not
registered as a `sweepExpired` callback (`src/lib/state-store-registrations.ts:109`
registers only `reconcileGeneration`), so an unprobed row is not swept on the TTL tick.
A passive row therefore survives in memory past 10 minutes, which is correct for this
feature and is exactly why the age must be displayed.

## H. Method note

The parity inventory was dispatched as a read-only reviewer packet demanding a file:line
for every claim, precisely because the predecessor unit's plan had drifted from the tree
in three places. Two of its findings — the pre-existing `onParsedPayload` seam and the
already-generic GUI bar rendering — deleted planned work rather than adding it. A
roadmap written from the old plan alone would have shipped a duplicate handler and a
redundant component change.
