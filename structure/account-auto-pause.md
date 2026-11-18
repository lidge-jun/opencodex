# Account Auto-Pause

Opt-in policy (with one Cloud Code Assist default), credential ownership, durable pause metadata, and bounded recovery for
permanent account refusals. Counters are process-local; persisted pauses require explicit resume.

## Opt-in account refusal observation

`src/server/responses/fetch-helpers.ts` accepts an optional caller-owned observer factory for physical
Codex/runTurn response observation; the transport leaf imports no account or OAuth policy. OAuth/key HTTP overrides capture after reselection in
`src/server/responses/request-transport.ts`; native Chat/Messages capture at their send
boundaries. `src/oauth/account-auto-pause.ts` is dormant unless `effectiveAccountAutoPause` in
`src/config/account-auto-pause-revisions.ts` resolves a policy for the named provider (an explicit
opt-in, or the Cloud Code Assist default below), writes pause metadata, and preserves upstream responses if
optional persistence fails. Counters and asynchronous decisions belong to the runtime
config object; completed pauses belong to the existing durable account stores. A response is counted only when the final destination and credential
headers, reported by `sendWithConnectionPolicy` after plugin rewrites and queued rebuilds, match the
captured attempt; a Codex WebSocket send has no HTTP final-send report and counts only when no
plugin upstream rewriter was registered at capture and the registration epoch in
`src/plugins/upstream-hooks.ts` is unchanged when the response arrives. Nested capture sites that see the same physical response count it once
per account, and an observer without a final-send report never attributes a response another
observer had reported. Regression coverage:
`tests/responses/responses-account-auto-pause-wire-owner.test.ts`.

DeepSeek's expiring image uploads during adapter construction use the captured credential
selection fence, but are not inference attempts and do not contribute to account refusal
counters. Their transport and lifetime follow the [Responses image replay contract](transports/responses.md#fetch-helper-import-boundary).

## Permanent account refusal policy

`providers.<name>.accountAutoPause` is optional, default off, with an integer
`consecutiveFailures` in 1–100 (default 2). The one default (#8752): a row with no
`accountAutoPause` key, `adapter: "google"`, `googleMode: "cloud-code-assist"`, `authMode: "oauth"`
and a first-party Cloud Code Assist `baseUrl` (`isCanonicalAntigravityUrl`) resolves to
threshold 1 with `conclusiveOnly`, so only `isConclusiveAccountBan` (the Terms of Service account ban
in `src/oauth/account-auto-pause-policy.ts`) counts. The observer checks the sending provider and
the final-send destination against the same host allowlist, so a custom `baseUrl` or a rewritten
dial never gains the default's authority; such a route pauses only with an explicit opt-in. Any present key, including `{}` or
`enabled: false`, replaces the default; `enabled: true` counts every permanent refusal as before. `src/config/schema/account-auto-pause.ts` validates
the policy and allowlisted reason/timestamp DTO. OAuth pause metadata is stored with the
auth row; Codex metadata/revision fences use `codexAccountPauseState`; key pools retain
`disabled`, `pauseDetails` and `pauseRevision` per entry. Both explicit and implicit OAuth
auto-pauses store a sibling `pauseEvidence` with the decisive refusal's HTTP `statusCode`
and optional message. The message comes from `error.message`, with whitespace collapsed
and redaction applied before the 300-character cap. A Cloud Code Assist appeal sentence
survives when the qualifying message contains it. Structured metadata such as `appeal_url`
is outside the evidence contract. Older builds can still read the strict `pauseDetails`.
Runtime counters are process-local. Manual resume clears the pause metadata and changes
the revision (including an already enabled key), fencing already-sent refusals.

## Explicit health-gated resume and login (#8398)

Resume stays explicit: nothing resumes a paused account in the background. `ocx account resume
<provider> <id> --if-healthy` sends `ifHealthy: true` with a resume to `PUT /api/oauth/accounts/pause`
or `PUT /api/codex-auth/accounts/pause`; API-key pools reject the flag. `src/oauth/account-resume-health.ts`
refuses `oauth_organization_disabled` and `account_permission_denied` (`PERMANENT_PAUSE_REASONS`)
without a read. For Anthropic instances it reads usage with the stored token through the bare
`probeAnthropicUsageQuota`, which publishes no quota or routing evidence; it never refreshes a paused
credential, because every refresh path refuses a paused row, so an expiring token reports
`credential_expired`. Other OAuth providers report `health_check_unsupported`. The resume then commits
through `setAccountPaused` with a `resumeGuard` holding the probed credential generation and pause
revision, and answers `account_changed` if either moved. `src/codex/account-resume-health.ts` applies the
same rules to a pool account through a forced, explicit `fetchPoolAccountQuota`: healthy means a fresh
quota read by a still-live credential generation, and the main account reports `health_check_unsupported`.
A refusal is HTTP 409 `{ code: "resume_refused", reason }`, and the CLI exits 3. An account that is not
paused when checked gets a 200 `unchanged: true` with no write, so a pause landing meanwhile is never
cleared unchecked. A Codex resume also resumes the accounts `withCodexAccountPauseGroup` links to the
named one, so a permanent reason on any of them refuses the whole resume.

An explicit login or reauthentication clears an automatic pause (one with details) on the account
whose credential it replaced: `clearAutomaticPauseForLogin` in `src/oauth/store.ts`
(`saveCredentialWithReceipt` for a login, and `saveAccountCredential` only with `clearAutomaticPause`,
which only the reauthentication branch of `runLogin` in `src/oauth/index.ts` sets; Kiro's pre-login
identity binding writes without it) and the reauthentication branch of
`src/codex/auth-api/login-flow.ts`. A cleared pause publishes `publishOAuthAccountPauseChange` after the
write commits. An operator pause has no details and stays. Coverage:
`tests/oauth/oauth-account-resume-if-healthy.test.ts`, `tests/codex-integration/codex-resume-if-healthy.test.ts`,
`tests/helpers/codex-relogin-pause.ts` and `tests/cli/cli-account-pool-verbs.test.ts`.

## Opt-in permanent refusal recovery

`src/server/responses/request-transport.ts` observes exact physical account outcomes before
retry wrappers replace the response. Threshold-triggered OAuth/key pauses rebuild the
request through `src/server/responses/account-auto-pause-recovery.ts` and the existing selection owner, with at most three account moves funded by the existing recovery owner. Before rebuilding, the transport binds replay and continuation ownership to the refreshed credential on both the retry request and the outer request used for persistence.
`src/server/responses/passthrough-dispatch.ts` and
`src/server/responses/core-codex-account.ts` admit a confirmed Codex auto-pause to the
existing alternate-account ladder without reclassifying subscription refusal as a dead
credential. `src/server/responses/compact.ts` observes the same pool contexts; custom gateway sends stay outside Codex pool outcome recording and recovery. Fixed
account selectors and uploaded-file constraints continue to suppress alternate moves.

## Permanent account refusal auto-pause

`src/oauth/account-auto-pause.ts` captures the exact sending OAuth snapshot, Codex context
or API-key selection and validates outgoing credential headers before observing a response.
`src/oauth/account-auto-pause-policy.ts` recognizes whole account-scoped 401/403 messages (for Google, only the whole Cloud Code Assist Terms of Service account-ban messages Google has returned, alone or with its fixed contact or appeal sentence, on a consistent 403 `PERMISSION_DENIED` envelope; project-scoped `CONSUMER_SUSPENDED` and service-enablement errors are excluded),
serializes response-arrival decisions, resets on accepted HTTP responses, and excludes
transient/quota/model/request failures. No provider body or account identifier enters its log.
The opt-in counter defaults to two refusals; each process owns its counters. Durable pause
uses `setAccountPaused`, `setCodexAccountPaused`, or
`src/providers/api-key-pause.ts`; resume changes an incarnation fence and clears the reason.
Key pool pause and resume mutate under `commitProviderApiKeySelection`, verifying the selection
revision and policy fences. An enabled row sharing the active reference preserves that reference when another row is paused or removed; active row identity prefers the first enabled matching row. When the last enabled row for the active reference is paused, the active selection advances in ring
order to the next enabled entry; resuming an entry into an all-paused pool restores the active key.
Each successful key pause or resume also invalidates that account’s cached and in-flight passive
key-limit observations, preserving sibling accounts.
API-key selectors and reactive/proactive failover exclude disabled pool entries, including request-local round-robin allocation. A distributed refusal pauses its exact sending entry even when a different key is active, under the existing selection-revision fence. Recovery allocates a healthy sibling and reacquires its pacing lease before dispatch.
When every key in a pool is paused, no paused key is dispatched. One pre-existing exception: the opt-in Responses xAI image/video bridge resolves its key when the media call is planned (`src/images/plan.ts`) and reuses it at fulfillment (`src/images/fulfill.ts`, `src/images/loop.ts`), so a pause that lands between planning and fulfillment does not stop that already-planned call. A request with no other eligible route fails closed with 403 `permission_error` before keyed wire transport; API-key selection never falls back to ambient environment credentials or Application Default Credentials. Manual pause or resume clears key cooldowns and rotation cursors, and purges model and quota caches on active key transition. Quota probing skips disabled keys while preserving fresh last-good cached quota.
Regression coverage: `tests/oauth/oauth-account-auto-pause.test.ts` and
`tests/responses/responses-account-auto-pause.test.ts` and `tests/providers/api-key-auto-pause-distribution.test.ts`.

## Policy-change fence

`src/config/account-auto-pause-revisions.ts` keeps `accountAutoPausePolicyRevisions`, a per-provider
UUID that changes whenever a tracked provider's effective policy fingerprint changes (effective
threshold and `conclusiveOnly`, provider disabled, base URL, adapter, auth mode). A provider is tracked
once it has ever configured `accountAutoPause` or resolved the Cloud Code Assist default; other
providers that never opted in leave no map in the file. Only
`persistConfigUnlocked` mints values, from the literal pre-write file, so caller-supplied revisions never
authorize anything. Each process also keeps an observed map with a local generation, bumped on
fingerprint changes adopted by reload and save-time reconciliation, and on disk-to-disk changes seen
by any load; a detached load never compares itself with the live fingerprint. A capture records
the revision, generation, threshold, `conclusiveOnly` and route. A pause commits only while all of these are still
equal, both in memory and in the fresh persisted file inside the config mutation lock. The OAuth
automatic commit runs its final check and auth publication under that lock, and contention means
no pause. API-key commits use the same disk check in their selection mutation, and Codex commits
check it beside `src/codex/account-pause.ts` state; pausing `__main__` there also ends any retained native-main login ([native-main login retention](providers/native-main-login-retention.md)). Revision records exist only for providers present after disk-only provider
preservation: deleting a provider reclaims its record, and both the persisted and the observed
maps stay bounded by the provider list. Every new observed record and every generation advance draws
from one process-wide counter, so a deleted and recreated provider can never reproduce an older
attempt's fence. Once a config path has been observed, a capture never seeds a missing name from
the caller's config object: only load, reload or save adoption can enroll it, so a stale live config
cannot re-enroll a provider an observation deleted. A raw legacy delete and identical recreate that no load observes stays undetectable.
Codex pool ownership binds the bearer, the `chatgpt-account-id` workspace and any organization or
project selector at capture and in the final-send report. A malformed map suppresses automatic pause
until the next valid write mints fresh revisions. A raw editor that bypasses the lock and finishes a
disable/re-enable between two observations stays undetectable.
Regression coverage: `tests/oauth/oauth-account-auto-pause-revision.test.ts` and
`tests/config/config-account-auto-pause-revisions.test.ts`.

## Auto-paused account recovery

OAuth and Codex account-list DTOs project optional `pauseDetails` (fixed reason plus epoch
ms timestamp) beside the existing pause flag. The OAuth account list API also returns
the sibling `pauseEvidence` when present. The CLI preserves `pauseDetails` and includes the
reason in account listings. `tests/server/management-account-auto-pause.test.ts` covers the
OAuth evidence projection and its removal after resume.
`src/server/management/oauth-account-routes.ts` also serves
`PUT /api/providers/keys/pause` with provider `name`, key `id` and boolean `paused`, through
the existing management authorization boundary. Its success response reports the committed
`activeAccountId` (or `null`) and whether the active key changed. Key listings expose `disabled`
and pause details. OAuth upserts for dual-auth providers keep validated key pause fields through
`src/oauth/api-key-pool-preserve.ts` and never promote a paused key to the active key. Dashboard key Resume clears the pause through that endpoint before activating
the key; OAuth/Codex keep their existing resume actions.
`src/server/management/route-registry.ts` declares key pause as an ordinary management mutation,
covered by the existing account pause/resume CLI capabilities. Responses recovery and passthrough
observation owners are included in `tests/helpers/responses-core-source.ts`; its graph guard checks
inventory coverage, physical line limits, and acyclic dependencies including type-only imports.

## Permanent refusal pause indicators

`gui/src/components/provider-workspace/ProviderAuthPanel.tsx` and
`gui/src/components/codex-account-pool-cards.tsx` expose fixed auto-pause reason and timestamp
on Paused badges; `gui/src/account-pause-display.ts` translates the reason and formats the
timestamp with the app locale. Disabled key rows offer Resume through their existing selection action;
`gui/src/hooks/useProviderAccountPools.ts` resumes before activation, then refreshes the
roster under its existing selection-mutation fence. No upstream error body is displayed.

The account-pool hook coordinates logout with pending account selection and deletion per provider.
The account panel exposes login cancellation once the provider supplies a login hint.
When the roster and OAuth status cannot be verified, the account panel keeps logout available
without presenting an unverified account as signed in.

`src/lib/account-auto-pause-response.ts` registers process-local pause/refusal provenance with the pacing owner and retains it when
adapter error normalization or a leased pacing-body rewrap replaces a response, without exposing metadata in HTTP headers.

`src/types/account-auto-pause.ts` owns the policy and fixed pause-reason DTO vocabulary.
