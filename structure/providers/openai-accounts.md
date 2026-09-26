# OpenAI Account Identity And Pool Operations

How OpenAI accounts are migrated, identified, and rotated once the account modes in
[OpenAI provider account modes](openai-tiers.md) are configured: wire identity, store concurrency,
pool plan exclusions and ordering, quota observations, and account-bound thread and file
retention.

## Migration and restore

Current configs use `openaiProviderTierVersion: 2`. Startup projects shipped v1 Direct/Multi
configs into one canonical `providers.openai` row, absorbs the legacy account-selection intent into
`codexAccountMode`, removes legacy public provider rows, and maps a legacy default to `openai`.
A marker-1 config containing neither Codex-forward row preserves that absence.

Known `openai-multi/<model>` selected ids are rewritten to bare ids in disabled/subagent/injection,
shadow, sidecar, Claude model/tier, and model-map destination fields. Rewritten arrays are
deduplicated in stable order; unrelated providers, API-key ids, and unknown passthrough fields are
not rewritten. Conflicting provider context caps keep the lower positive value with path-only
warnings.

Before the first v2 projection, opencodex creates a mode-0600, no-replace byte snapshot:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

The historical v1 backup is never overwritten. Restoring the v2 backup intentionally restores the
shipped v1 shape; the next startup re-migrates to the same marker-2 bytes.

A pre-existing snapshot that differs from the current config is classified before anything is written
(`src/config/openai-tier-backup.ts` `classifyOpenAiTierBackup`, re-exported through the `src/config.ts` facade): a snapshot that parses as a valid pre-migration (v1)
config is a user-intentional rollback point and is copied to a unique
`config.json.pre-openai-tiers-v1-rollback.<timestamp>.bak` path before startup retries the v2
migration backup; a snapshot that is unparseable or already tier-v2 is stale and is replaced with a
warning. The distinction matters because silently discarding a rollback point is destructive, while
preserving a stale one would block every later migration.

## Model and wire identity

Native Spark membership and its model-specific request/tool exceptions are removed; the shared
[catalog retirement policy](../catalog.md#shared-catalog) preserves historical user selections.

- `openai` exposes one group of bare native Codex ids in Pool and Direct. Changing mode does not
  change catalog, selected, requested, or wire model identity.
- `openai-apikey` exposes namespaced API rows. Its trusted catalog contains `gpt-5.5`, `gpt-5.6`,
  Sol/Terra/Luna, and the three corresponding Pro variants. No generic `gpt-5.6-pro` alias exists.
- The selector-qualified account-native `*/gpt-daybreak-blue-latest` and API-key
  `daybreak-blue-latest` are distinct wire surfaces. An observed native row follows the pinned Sol
  capability metadata, but routing strips only the account selector and keeps
  `gpt-daybreak-blue-latest` byte-for-byte; it never expands the bare list or substitutes Sol.
- Account-gated native rows use each account's authenticated Codex `/models` roster as the
  availability authority. Pool selection excludes accounts whose confirmed roster omits the model;
  selector rows are generated only for the mapped entitled account. The bare row uses any eligible
  account in Pool mode but only main-account evidence in Direct mode; a Direct turn independently
  checks the forwarded caller credential, or stored main when an admission bearer is substituted.
  Discovery failures fail closed. If an
  entitled account still receives the exact pre-stream unsupported-model 400, opencodex invalidates
  that account's roster and permits at most seven additional same-account sends, re-confirming the
  exact rejection and fresh grant before each later send; otherwise ordinary eligible-account
  failover applies.

- The account-gated set is `gpt-daybreak-blue-latest` and `gpt-6-astra-minor`. Neither has a
  shipped catalog row, so roster absence is the only evidence available for either. Astra Minor
  borrows `gpt-6-astra` capability metadata for catalog rows only; it has no wire normalization, so
  a request goes upstream as `gpt-6-astra-minor`.

- The flagship roster that lists unconditionally is `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna` (Sol and Luna added 2026-09-23 from a live roster
  probe; https://openai.com/index/introducing-gpt-6-sol-and-luna/). None of them is gated, and all
  six are native-main drain sentinels. The confirmed-denial ordering below is still scoped to the
  first four (`ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS`); Sol and Luna do not feed it yet.

- The always-visible flagships (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`)
  use the same rosters with the opposite polarity, and are never gated on them. Only a CONFIRMED
  DENIAL counts: `cachedDeniedCodexAccountIdsForModel` reads rosters discovery already gathered,
  synchronously and with no upstream fetch on the request path, and `getEligiblePoolAccounts` drops
  those accounts ahead of the priority tier. If that would leave no candidate the full list is
  restored, so evidence can never remove a model the way a fail-closed gate would (#3022). Unknown,
  unconfirmed, expired and too-old-client rosters stay unknown and change nothing; a grant under any
  client version clears a denial recorded under another. Nothing refuses before dispatch, and the
  bounded alternate-account retry on an exact unsupported-model 400 remains the safety net (#4768).
  A cached roster lives five minutes and nothing on the flagship request path refetches it, so the
  roster alone left that evidence absent for most requests and both ordering rules became the
  identity function — the pool then selected on quota, which is #4906. The refusal itself is
  therefore the second source: an exact pre-stream unsupported-model 400 from a Pool account is
  recorded per (account, model) in `src/codex/observed-model-denials.ts` and unioned into
  `cachedDeniedCodexAccountIdsForModel`. It is confirmed, authenticated evidence, never a plan
  name and never remaining quota. It is bounded and retained for six hours, it is outranked by any
  confirmed roster grant for the same pair, it is cleared when that account successfully serves
  that model, and it is discarded when the account's credential identity changes. Recording is
  scoped to the always-visible flagships, so a 400 anywhere else cannot steer routing. Every
  consumer treats it exactly like a roster denial, so the restore-on-empty and pin-exempt rules
  above continue to hold and no request is refused before dispatch.
  Detection reads the model upstream actually named rather than rebuilding the sentence from
  `route.modelId`, because `applyCodexAccountGatedWireNormalization` rewrites Daybreak to
  `gpt-5.6-sol` before dispatch; comparing against the route model alone never matched for the
  one wire-normalized account-gated model, which disabled both its alternate-account retry and its
  same-account ladder.
  `getEligiblePoolAccounts` is not the only door, so `preferModelEntitledAccount` applies the same
  evidence to an already-active shared cursor: the replacement is drawn from the eligible list, the
  active account is returned unchanged when no entitled alternative exists, and the correction is
  request-scoped and never persisted, so the operator's cursor is unchanged for the next request.
  An operator's manual pin is exempt: evidence orders the pool's own discretion and never overrules
  an explicit selection, and because `selectPriorityTier` reads the pin to lower the tier ceiling,
  filtering it out beforehand would re-enable the tiers the operator excluded rather than merely
  demote the account. Eligibility itself is untouched — `isCodexAccountSelectable` remains the sole
  authority for pause, plan exclusion, quota cooldown and avoidance, soft avoidance, refresh cooling
  and usability, and `codexAccountBlockReason` still reports which of those guards fired.

- `gpt-daybreak-blue-latest` remains the catalog and entitlement identity, but the canonical
  ChatGPT wire uses `gpt-5.6-sol`, the serving id reported by successful Daybreak responses.
  Daybreak compaction uses the existing synthetic `/responses` compaction path instead of the
  native `/responses/compact` endpoint, whose model support is selector-specific. The internal
  turn stays streaming as required by the canonical ChatGPT backend, and OCX returns the opaque
  encrypted compaction item without attempting to decrypt or re-encode it.
  The optional `prompt_cache_retention` hint is removed on this route because Daybreak's
  authenticated catalog does not advertise it and upstream rejects it before execution.

> Decision record: [ADR-0087](../decisions/ADR-0087-model-and-wire-identity.md)

> Decision record: [ADR-0088](../decisions/ADR-0088-model-and-wire-identity.md)
- The two GPT-5.6 surfaces advertise different windows on purpose. API rows use 1,050,000
  context with 922,000 max input. Codex-login rows default to the live catalog 272,000
  (auto-compact 244,800) and only rise to 922,000 / 829,800 when the user turns the 1M
  switch on.

  The ceiling is the same on both — probing a real Codex-login account accepted 921,508 input
  tokens and refused 922,013 with `context_length_exceeded` on Sol, Terra and Luna alike,
  matching the 922,000 the API surface already declared. A Codex-login `context_window` is a
  spending budget, not a label: Codex fills `context_window * effective_context_window_percent`
  (95% by default, codex-rs `turn_context.rs`). Advertising 1,050,000 there spent 997,500 and
  blew past the ceiling. The 922,000 opt-in yields a 875,900-token budget and keeps ~46k of
  headroom. Evidence: `devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md`
  and `014_final_922k_with_margin.md`.
- `*-pro` selected ids rewrite to the base wire id with `reasoning.mode: "pro"`; request logs,
  usage, model visibility, subagent state, and injection state retain the selected virtual id.
- Compact preserves provider/selected identity but sends the base model without a reasoning object.

## Process-local affinity diagnostics

Provider debug capture includes one `[ocx:codex:affinity]` record for each canonical ChatGPT
forward response before account-model retry selection. The record compares only an explicit safe
header-name allowlist. Values are represented by size buckets and 12-character HMAC equality tags
under a random process-local key; raw credentials, account ids, attestation values, thread/session
ids, turn metadata, and request bodies never enter the record. Known top-level turn-metadata fields
use the same process-local tags, while unknown fields contribute only a count. Oversized values are
classified without hashing. The diagnostic is observational: it cannot strip headers, retry,
switch accounts, reset threads, or mutate affinity.

> Decision record: [ADR-0089](../decisions/ADR-0089-process-local-affinity-diagnostics.md)

## Idle-window steering

`codexPool.startIdleWindows` is an optional boolean that defaults to `false`. When it is `true`,
`src/codex/routing/idle-window.ts` may steer a new unbound real request after conversation and
family affinity have been checked. An explicit account pin and manual account preference take
precedence. Independent model quota scopes are excluded. The selection does not move the shared
active cursor, and normal strategy selection continues for other conversations.

An account is eligible only when its observed short quota is exactly 0%, its short window is
explicitly 18,000 seconds, the observation is no older than five minutes, and the observed reset
is within 60 seconds of `observation + 5h`. The synchronous process-local reservation prevents
duplicate selection of the same window. Its deadline is at least five hours and one minute after
selection; an observation after that deadline is required before that account can be steered again. The reservation
map is cleared on proxy restart and has no disk persistence.

This is request steering only. It sends no synthetic request and starts no timer. The ordinary
strategy path remains responsible for subsequent unbound selections.

## Account identity and store concurrency

Pool mode needs stable public names and a store that survives concurrent refresh:

- Public selectors are generated per account; the main login's selector is `main`, collision-suffixed
  if that name is taken, and it maps to the config-only sentinel `@main`, which sits outside the
  pool-account id grammar (`src/codex/account-namespaces.ts`, `src/codex/account-namespace-match.ts`).
  Selectors must not collide with provider or combo ids. A user alias is display metadata; routing
  consults credential identity, never the alias.
- The credential store is generation-guarded and refresh-locked (`src/codex/account-store.ts`): a
  refresh persists only if the generation it started from still holds, and a lost race raises a
  generation-conflict error instead of overwriting the newer credential.
  The lock is held and released by file identity rather than by path. A lock that exists but is
  not yet readable counts as held until it ages past the stale window, because its owner creates
  the file and writes its metadata as two steps, and a holder deletes the lock only while the
  path still resolves to the file it created. If descriptor identity is unavailable or unusable,
  release leaves the path for stale-lock recovery. Path-probe errors preserve the callback outcome; confirmed-owner unlink errors other than `ENOENT` still propagate. The stat/unlink pair is not an atomic
  compare-and-delete against non-cooperating writers. Cooperating acquisition, stale reclamation and release serialize inside the synchronous config-mutation transaction, released before the async callback. Release keeps its descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery.

## Sidecars, management, and UI

The desktop restart adapter uses [Windows process ownership and installation membership](../runtime.md#codex-desktop-process-membership), independently of Pool/Direct credential selection.

HTTP/SSE, Responses WebSocket, compact, images, search, and vision resolve the same account mode.
There is one mode-aware `openai` forward sidecar candidate; `openai-apikey` is not a ChatGPT-forward
sidecar candidate and cannot hide a failed Codex credential with separately billed API usage.

`src/server/audio-upstream.ts` uses the same selection for standalone transcription. Explicit
native Direct auth remains caller-owned; proxy-key-only Direct claims stored main before
materialization, replacing both bearer and account identity exclusively from that credential.
Both synchronous and asynchronous stored-main substitution in `src/codex/auth-context.ts` remove a caller account header before copying the stored identity; an absent stored account ID leaves no account header. Caller-owned native Direct authentication retains its existing passthrough behavior.
`src/providers/openai-sidecar.ts` releases quota-probe ownership on every
materialization or usability failure before transferring a resolved context to its caller.
Audio reports one terminal upstream outcome after validating the response body; redirects remain
neutral and client/shutdown cancellation does not manufacture an account failure.

External voice reconnects restrict provider selection as well as exact account selection to the
original call binding. Credential acquisition accepts a cancellation signal; post-resolution
materialization checks cancellation before returning ownership. Connectivity-only WebSocket
completion is neutral: HTTP 101 does not prove inference or quota recovery, and a normal close
may follow a protocol error. Explicit transport errors/timeouts settle once during cleanup.

The dashboard presents one OpenAI Codex card with accessible Pool/Direct controls and a separate,
unchanged API-key card. `PATCH /api/providers?name=openai` persists exactly one
`codexAccountMode`, clears affinity/quota cache, primes only when entering Pool, and does not refresh
the model catalog or restart the proxy. Codex Auth shows an option-aware Pool/Direct banner, while
Models always shows one bare OpenAI group. Disabled or absent canonical `openai` state can be
restored from the Accounts picker or Codex Auth through gated recovery: missing rows are created
from the canonical preset, disabled canonical rows are re-enabled without replacing saved mode or
model settings, and noncanonical `openai` rows never receive that recovery path.

`GET /api/codex-auth/accounts?refresh=1` treats missing main credentials, HTTP 401, and allowlisted
terminal 403 codes as `needsReauth`; generic permission failures remain non-terminal, and a
successful main usage refresh clears the runtime mark.

Canonical forwarding alone can apply the optional client-output safety-buffering hint filter;
API-key and custom forward destinations preserve their metadata. See [Responses transport](../transports/responses.md).

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).

## Automatic pool plan exclusions

`src/codex/routing/selection.ts` applies optional `codexPool.excludedPlans` to both candidate selection and existing active/affined accounts. An all-excluded pool returns no automatic candidate, including preview and configured-account fallback. Native main remains exempt and unknown plans remain eligible. Explicit account-qualified routes retain pause, credential and entitlement checks while bypassing only this automatic policy.

`src/codex/auth-api/account-list.ts` projects `selectionExcludedReason: "plan_excluded"` and `selectionExcludedPlan` from the routing config, even when a newer display-only WHAM plan could not be persisted. The dashboard and account CLI show the policy reason separately from credential health; renewal clears the derived fields. The automatic next-session action and badge are omitted for excluded rows.
Paginated and migration-capable history follows the [authoritative writer contract](../codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](../config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

## Context relay ownership

`src/codex/context-owner.ts` records which account actually served a root session, taken from the
final materialized outbound headers of an accepted model attempt, after refresh and failover.
Entries are bounded, process-local and expiring, and are keyed by the admission principal that
`src/server/auth-cors.ts` mints for the matched opencodex API key, plus the destination and the
root session. Two keys therefore cannot observe or overwrite each other's ownership even when both
resolve to one ChatGPT workspace, and rotating a key mints a new principal instead of inheriting
the previous holder's sessions. `resolveContextPrincipal` resolves that principal from the opencodex API key the request
presents, on both the recording and the relay path so the two agree. A remote bind supplies it
through admission. A loopback bind admits without reading a token, so the key is resolved from the
request only for a loopback admission; this adds identity where the caller volunteered it rather
than admitting anyone new, and changes neither admission nor which credential goes upstream. The
built-in loopback injection cannot carry that header, so the relay is unavailable through the
default Codex integration and refuses instead of inferring an owner. Making loopback callers
identifiable is an open maintainer decision, not a gap to be closed by relaxing the refusal.

A workspace id identifies an organization, so an entry also binds the stable user claim carried by
the accepted credential. That claim is read without signature verification, which is why upstream
acceptance stays the evidence: a credential proving a different user does not continue the session,
conflicting claims are never recorded, and an entry with no proven user continues only for the
exact accepted credential. Conflicting observations stay ambiguous, and ambiguous, unknown,
expired, evicted or restart-lost ownership fails closed before account selection or upstream I/O.

`src/server/context-history.ts` relays the native history and notes endpoints under one deadline
that starts on route entry, before the body is read and before credential selection, so an
unfinished body cannot hold an admitted turn. Client cancellation and deadline expiry are reported
separately, nothing is dispatched upstream after either, and notes writes are never retried.

Context relay dispatch rechecks the native experimental opt-in after body and credential waits.
A disabled gate prevents upstream dispatch even when the request entered while enabled. Final
materialized headers pass the proxy-credential exclusion check before owner matching.

## Quota history publication identity

`src/codex/account-store.ts` assigns each explicit pool credential publication a private random `quotaHistoryIdentity`. Same-account token refresh preserves it, including each alias record's own identity; replacement or deletion retires it. A refresh CAS with a changed upstream account identity rotates the tag and does not propagate that changed identity to old aliases. Credential-only projections omit this metadata.

`capturePoolQuotaWriter` captures the exact dispatched access/account pair and generation. Legacy identity initialization rechecks under the credential mutation lock, persists metadata without advancing credential generation or mutation epoch, and fails to no optional evidence on read/lock/write errors. Append admission uses the captured generation and tag; history retention compares the tag across ordinary refresh. Native main is excluded from this pool proof. These interfaces supply the bounded observation layer; the identity alone is neither a quota sample nor proof of capacity.

## Bounded pool quota observations

`src/codex/quota-history.ts` retains at most 200 raw observations per stored pool account for 30 days, bounded globally to 64 identities, 4096 observations and 2 MiB. `src/codex/quota.ts` persists these alongside the latest quota cache; the file reader caps allocation at 4 MiB and rejects nonregular/oversized input. Invalid history envelopes are discarded without blocking inference. Atomic cache replacement is best-effort single-writer persistence, not cross-process merging.

WHAM and response-header producers pass the exact captured pool writer, including refreshed replay and compact outcomes. Admission rechecks credential generation and publication UUID. Same-account refresh preserves prior history; replacement/removal invalidates it. Raw invalid percentages discard the entire trusted observation before display clamping; carried windows, reset credits alone, native main and staged-login probes never become durable pool history.

`GET /api/codex-auth/quota/history` and `ocx account history openai <pool-account-id>` read only cached, identity-checked observations. The optional limit is 1–200. Public results omit the internal publication UUID and credential generation. These observations are inputs for capacity estimation; percentages alone do not establish absolute token capacity.

## Observed effective token capacity

`src/codex/quota-capacity.ts` joins raw account-family observations with reported single-send usage attempts wholly contained within matching, unexpired reset intervals. Source, window duration and monthly-primary provenance must match; percentage delta must be at least one point. Duplicate request/attempt identities never multiply usage. Local, estimated, multi-send, independent-model and absent-attempt evidence does not supply a capacity sample.

The history read API reports a median effective token estimate and interval sample count with low confidence and explicit coverage/rounding/label-continuity assumptions. It is not a provider token limit or mathematical lower bound and never affects account selection. Truncated, unavailable or excessive usage-ledger reads produce insufficient evidence while retaining history. Publication UUID and explicit unique account label are checked around the asynchronous read; identity changes discard the estimate and refresh the returned history.

## Reset-first account ordering

`src/codex/routing/selection.ts` supports Codex-only `accountPoolStrategy: "reset-first"`. For new shared-quota assignments it chooses the earliest future short/weekly reset after existing eligibility, priority and usage-threshold filtering; ties and absent/elapsed deadlines use the existing usage order. Seconds and milliseconds are normalized with `resetAtToMs`. Threshold zero disables usage filtering while retaining reset ordering. Monthly deadlines do not order this strategy.

Live bindings obey the cache-affinity release policy: `pool.cacheAffinity` is on by default, so threshold crossing alone retains a healthy account. A bound thread that does leave may move only onto an account with genuine quota headroom and strictly lower usage. Manual preference, scoped health and shared-cursor guards remain authoritative. Set the flag false to restore threshold rebinding of bound tasks, except for a conversation carrying live uploaded-file references. Independent `spark`/`reserve` quota scopes resolve reset-first to existing quota selection because shared reset timestamps do not describe those windows. The configured value stays unchanged.

The Codex parser in `src/oauth/pool-kernel.ts` is reexported by the compatibility facade and used by both `/api/pool/settings` and the legacy Codex settings route. Generic and Anthropic parsers reject reset-first. The dashboard offers it only for Codex; API, CLI and translated guides preserve the same contract.

The account-pool strategy control and `ocx account pool get openai strategy` summarize how the
configured threshold applies to the active strategy. Manual-switch warnings use the routing usage
score. A reset-less terminal short window is current only when its `shortObservedAt` is not in the
future and is at most `TERMINAL_SHORT_WINDOW_FRESHNESS_MS` old; general `updatedAt` changes do not
extend that observation.

## Bound-thread rebind destination

An ordinary quota-strategy re-evaluation may move a LIVE thread only to an account that has genuine
quota headroom and is also strictly cooler than the bound account. Both bars are load-bearing.
Without the headroom bar, "strictly cooler" has no floor, so a pool whose every member sits in the
80-100% band hands a long conversation from account to account on consecutive turns; Codex prompt
caches are account-isolated, so each hop restarts from a cold prefix and a 7k-token turn becomes a
150k-token one (#4546). Without the strictly-cooler bar, `hasCodexQuotaHeadroom` — which answers
true for unknown usage, correctly for an unbound pick — would trade a warm prefix for an unmeasured
account. `CODEX_UNKNOWN_USAGE_SCORE` is 101, so the second bar excludes an unobserved destination
without a special case.

Movement is therefore bounded by the number of accounts rather than the number of turns. The rule
narrows a preference and never a refusal: a 429/402 with no success since, a failover streak, pause,
cooldown, lost generation and an unusable account all still release the binding before this rule is
consulted, and they run in `resolveCodexAccountForThreadDetailed` ahead of it. A known score of 100
with no recorded refusal is deliberately not a release path on its own — stickiness until the
account actually refuses is intended — but it does surrender the binding as soon as a sibling with
headroom exists. Unbound assignment is untouched and still takes the coolest eligible account,
because a fresh request has no warm prefix to lose. `pool.cacheAffinity` is enabled by default,
raising the bar from the threshold to genuine exhaustion.

Two call sites need the rule — the live path in `reevaluateAffinityQuota` and the side-effect-free
`previewReusableAffinityAccount` that subagent fallback reads — and they share one helper rather
than restating it, because the suite asserts the two answer identically and a preview that
disagreed would hand fallback a different account than the request actually uses.

## Uploaded-file account retention

Uploaded files are scoped to the account that issued them, so a conversation carrying live
`file_id` references is the one case where a voluntary move is not merely expensive. It orphans the
reference, and because the reference stays in conversation history every later turn is refused with
`409 account_change_file_scope` until the user re-uploads under the serving account or restarts the
conversation. Pool rotation is automatic, so any conversation with an attachment is otherwise one
rotation away from being permanently blocked (#4778).

`conversationCarriesUploadedFiles` answers that question from the request body alone — the same
predicate the refusal guard uses, so routing and refusal can never disagree about which
conversations are in scope — and `resolveResponsesCodexAuth` carries the answer into
`CodexAccountUsabilityOptions.retainAccountForUploadedFiles`. `src/codex/routing/cache-affinity.ts`
owns the rule: `retainsBoundAccountForQuota` names every reason a healthy bound account is kept,
and `mayRebindAffinityForQuota` applies the default cache-affinity bar whenever one of them holds,
even with `pool.cacheAffinity` false. That flag trades cache locality for capacity, not
correctness for capacity.

The retention is a preference over the VOLUNTARY move only, and it is not an eligibility boundary.
Genuine exhaustion and an unusable account still release the binding, and every involuntary release
that runs earlier in `resolveCodexAccountForThreadDetailed` — quota refusal, failover streak, pause,
cooldown, lost generation, affinity expiry — is untouched. A pinned conversation therefore cannot be
wedged on an account that cannot serve it, which is why the refusal remains required: it reduces how
often that refusal fires and can never replace it.

Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.
`src/codex/auth-api/login-flow.ts` distinguishes HTTP 429 from an attempted warmup as `codex_warmup_rate_limited` and preserves that code in OAuth status. Failed attempted warmup does not persist replacement credentials; quota-confirmed deferred registration and HTTP 401/403 handling remain separate. `src/codex/warmup.ts` retains a known 429 when bounded error-body draining times out.


## Per-account auto-switch thresholds

`codexAccountAutoSwitchThresholds` is persisted per-account routing metadata. Each 0..100 value
overrides global `autoSwitchThreshold` for that source account; absence inherits global, and 0 disables
only usage-driven switching from that account. Runtime resolves this effective value for unbound
selection, quota/reset-first bound-task re-evaluation, fill-first, priority-tier headroom, main-account
pin reuse, previews and subagent quota fallback. Failure recovery remains separate. The stable
`__main__` alias participates, deletion removes an added account's sidecar entry, and malformed maps
degrade as a unit rather than invalidating config. Zero never disables main-account hard-lock,
startup policy binding, quota cooldowns or model entitlement checks. Pool pin reuse and caller-owned
fallback enforce relevant cooldown when the bearer matches the already-observed main credential,
including after an awaited entitlement read. This uses memory-only identity evidence; unrelated
callers and explicit Direct retain their existing policy, and an independent model's cooldown does
not block another quota scope. Cache-affinity preservation across model detours still retires shared
state at genuine 100% exhaustion, including with a zero account override; below exhaustion the
threshold remains disabled.

Refusal detection accepts the HTTP `detail` envelope and the WebSocket refused-create projection's
`error.message` envelope. Both require HTTP 400 and the complete model-specific refusal sentence;
malformed or competing envelopes, unrelated errors and postcommit stream errors authorize no replay.
The same evidence feeds the bounded alternate attempt and later automatic selection without changing
a manual pin or threshold-zero quota policy.
`codexScopedExhaustionCode` exposes its result only to the post-resolution rotation gate; a code by
itself cannot bind a refusal to every credential in a heterogeneous pool.

## Ongoing priority failback

`codexAccountPriorityFailback: true` explicitly permits bound quota-strategy tasks to return to a
strictly higher priority with known non-exhausted headroom. It defaults off and requires the bound
source account's effective threshold to be positive: source override 0 disables it, while a positive
source override enables it even with global 0. A candidate's positive effective threshold requires
usage below that value; candidate 0 removes only this preference, never unknown/exhausted, health,
entitlement or hard-lock exclusions. This separate preference can lose a warm cache; ordinary
rebinding stays strictly cooler. The shared `routing.ts` helper gives preview and resolve the same
result after generation, refusal, health, pin and model checks; independent/model lanes retain their
shared-cursor isolation. Stale quota and short-window observation timestamps do not authorize this
optional move. Every member of the selected higher-priority tier must pass those checks before
lowest-usage selection.

`src/codex/quota-observation-freshness.ts` keeps process-local observation times for quota windows
that contribute to the candidate's score. Credits and partial updates preserve carried timestamps;
hydrated bars alone cannot authorize failback until live observations cover those windows. This
evidence changes no persisted quota shape, scoring, recovery or hard-lock policy. `account-priority.ts`
owns the five-minute cadence; `auth-api/pool-mode-gate.ts` bounds request-triggered attempts,
including failures, while preserving main-owner claims and per-credential WHAM dispatch backoff.
No requests means no new polling. For this reason only, stale observation proof bypasses aggregate
quota-cache freshness after the existing attempt backoff. Main refresh keeps its owned lease and
passive intent: cache bypass does not clear an inference reauthentication mark. Other prime reasons
retain their existing cache rules. The split config schema degrades malformed optional values to
false. Exact-account and Direct routes are unchanged.
