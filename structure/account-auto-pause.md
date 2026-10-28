# Account Auto-Pause

Opt-in policy, credential ownership, durable pause metadata, and bounded recovery for
permanent account refusals. Counters are process-local; persisted pauses require explicit resume.

## Opt-in account refusal observation

`src/server/responses/fetch-helpers.ts` accepts an optional caller-owned observer factory for physical
Codex/runTurn response observation; the transport leaf imports no account or OAuth policy. OAuth/key HTTP overrides capture after reselection in
`src/server/responses/request-transport.ts`; native Chat/Messages capture at their send
boundaries. `src/oauth/account-auto-pause.ts` is dormant unless the named provider explicitly
enables the policy, writes only fixed pause metadata, and preserves upstream responses if
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
`consecutiveFailures` in 1–100 (default 2). `src/config/schema/account-auto-pause.ts` validates
the policy and allowlisted reason/timestamp DTO. OAuth pause metadata is stored with the
auth row; Codex metadata/revision fences use `codexAccountPauseState`; key pools retain
`disabled`, `pauseDetails` and `pauseRevision` per entry. Runtime counters are process-local.
Manual resume clears details and changes the revision, fencing already-sent refusals.

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
API-key selectors and reactive/proactive failover exclude disabled pool entries, including request-local round-robin allocation. A distributed refusal pauses its exact sending entry even when a different key is active, under the existing selection-revision fence. Recovery allocates a healthy sibling and reacquires its pacing lease before dispatch.
Regression coverage: `tests/oauth/oauth-account-auto-pause.test.ts` and
`tests/responses/responses-account-auto-pause.test.ts` and `tests/providers/api-key-auto-pause-distribution.test.ts`.

## Policy-change fence

`src/config/account-auto-pause-revisions.ts` keeps `accountAutoPausePolicyRevisions`, a per-provider
UUID that changes whenever a tracked provider's effective policy fingerprint changes (policy enabled,
threshold, provider disabled, base URL, adapter, auth mode). A provider is tracked once it has ever
configured `accountAutoPause`; providers that never opted in leave no map in the file. Only
`persistConfigUnlocked` mints values, from the literal pre-write file, so caller-supplied revisions never
authorize anything. Each process also keeps an observed map with a local generation, bumped on
fingerprint changes adopted by reload and save-time reconciliation, and on disk-to-disk changes seen
by any load; a detached load never compares itself with the live fingerprint. A capture records
the revision, generation, threshold and route. A pause commits only while all of these are still
equal, both in memory and in the fresh persisted file inside the config mutation lock. The OAuth
automatic commit runs its final check and auth publication under that lock, and contention means
no pause. API-key commits use the same disk check in their selection mutation, and Codex commits
check it beside `src/codex/account-pause.ts` state. Revision records exist only for providers present after disk-only provider
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
ms timestamp) beside the existing pause flag. The CLI preserves those fields and includes
the reason in account listings. `src/server/management/oauth-account-routes.ts` also serves
`PUT /api/providers/keys/pause` with provider `name`, key `id` and boolean `paused`, through
the existing management authorization boundary. Key listings expose `disabled` and pause
details. OAuth upserts for dual-auth providers keep validated key pause fields through
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

`src/lib/account-auto-pause-response.ts` registers process-local pause/refusal provenance with the pacing owner and retains it when
adapter error normalization or a leased pacing-body rewrap replaces a response, without exposing metadata in HTTP headers.

`src/types/account-auto-pause.ts` owns the policy and fixed pause-reason DTO vocabulary.
