# OpenAI Provider Account Modes

Management provider-validation calls use the [shared relative send-path validation](../config.md#provider-relative-send-paths) before persistence. Catalog HTTP acquisition follows the [proxy-routing contract](../catalog.md#remote-catalog-http-proxy-routing).

Explicit Codex CLI installation observation does not identify an account, attest provider selection or alter account state. See the [read-only observation contract](../runtime.md#explicit-codex-cli-installation-observation).

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](../runtime.md#lifecycle).

[Orca-linked pool accounts](../codex-home.md#orca-source-owned-account-import) use the current
source access token and leave refresh ownership with Orca. They enter the pool validation-pending;
import deduplicates by ChatGPT account ID, including shared-workspace IDs.

This current contract supersedes the provider-identity and account-selection sections of
`devlog/_fin/260717_openai_hardening`; that archived unit remains historical evidence for the
earlier three-tier implementation. The replacement contract and its verification evidence live in
`devlog/_fin/260717_openai_single_provider_option`.

## Public provider contract

| Provider id | Product route | Credential owner | Account selection |
| --- | --- | --- | --- |
| `openai` | Codex login | current caller/main login plus the hardened Codex account store | `codexAccountMode` is `"pool"` or `"direct"`; missing mode defaults to Pool |
| `openai-apikey` | OpenAI API | configured API key or active key-pool entry | no Codex-account lookup or fallback |

`openai` is one provider identity with one bare native model group. Pool is the default for fresh
and mode-less configs. It runs the main-plus-added affinity, quota, cooldown, health, and failover
engine. Direct short-circuits that engine before pool state is read or mutated and uses only the
current caller/main-login bearer. Neither mode may fall through to `openai-apikey`, and the API
provider may not fall through to Codex-login credentials.

Caller credentials stay scoped to the selected physical route. Typed proxy admission survives
Combo/policy recursion, but raw Authorization and ChatGPT account headers are removed from
rebuilt requests at those selections or actual shadow/thread-spawn rewrites. An original caller's
Direct credential — a clean non-proxy bearer carrying a locally decoded ChatGPT account claim
(routing evidence, not signature verification), with any explicit account header matching that
claim — is captured separately and may be
restored only for the final canonical OpenAI route, under the existing Direct/Pool, native-main
claim, and entitlement rules. This restore is deliberately stricter than unchanged-route Direct
forwarding, which keeps its legacy rules. The stricter explicit-pair snapshot (JWT with matching account
header) additionally feeds optional OpenAI sidecars and is also
withheld from an unchanged keyless Cursor route; an independently supplied Cursor bearer
remains supported. A noncanonical caller-auth transport keeps only a clean single bearer with
no ChatGPT account claim: a bearer carrying a ChatGPT account claim, a combined or malformed
Authorization value, and the chatgpt-account-id header are withheld from it. Key-auth and noncanonical routes use
their own configured key or provider-owned OAuth credential. Canonical unqualified `openai`
forwarding preserves the sanitized caller/main-login bearer in Direct mode and may select a
stored native credential in Pool mode. An explicit account-qualified sidecar may select its
stored account even when the provider default is Direct. A thread-spawn marker without a rewrite
preserves the caller credential. Bearer admission can still select stored native credentials under
the existing turn claim. Claude replay may reconstruct its claimed main snapshot only for a final canonical
ChatGPT target. Alternate-account retry retains the sanitized caller input separately from the
selected Pool headers, so neither a discarded source bearer nor a Pool token becomes caller-main
authority during retry.

Explicit OpenAI sidecar authentication is retained separately in request-local memory before
Combo or policy headers are rewritten. Only the canonical sidecar resolver can restore that
single bearer and matching explicit account pair; it revalidates the existing credential and
destination rules. A recorded absence is not recaptured from a later provider request, and
combined Authorization values are rejected. This snapshot never becomes primary-provider or
alternate-main retry authentication; the original caller's native snapshot is separate.
Optional Chat/Claude stored-main enrichment still requires
the native-main turn claim.

Chat's noncanonical caller-auth branch passes only an internal permission to resolve stored
sidecar auth later. Final helper planning checks vision terminal/routed-backend and search
tool-choice/compaction/runTurn exclusions before requesting a canonical Direct candidate.
Only that concrete need, without an existing explicit snapshot or exact-account selection,
can acquire a startup- and drain-fenced native-main claim and read the stored token. The pair
stays local to sidecar headers; caller, primary, and retry authority are unchanged. Unrelated
Cursor turns therefore leave native main switchable while their upstream remains active.
Pool and exact-account sidecars continue through their existing account-selection path.

The two routes also keep separate request-compatibility contracts. The canonical ChatGPT Codex
forward destination removes public `prompt_cache_options` because that backend rejects the field
before inference; `prompt_cache_key` remains supported. `openai-apikey` and noncanonical/custom
Responses destinations preserve caller-provided options because their upstream contracts may
support them.

> Decision record: [ADR-0084](../decisions/ADR-0084-public-provider-contract.md)

Pool affinity keys a Codex V2 conversation TREE as one cohort. The binding unit is the cohort the
client already declares, because upstream keys its prompt cache the same way: `prompt_cache_key`
is `responses_metadata.session_id`, or `{source}:{parent_thread_id}` for an internal session, and
one `AgentControl` whose `session_id` is the root thread's id is shared with every sub-agent
spawned from that root. Two requests carrying the same `prompt_cache_key` are therefore served by
the same account. While the key was per thread, a tree could split across accounts while every
member kept sending one cache key, so the split member asserted a warm prefix that was
deterministically cold on its account: no failure, only a full prompt replay and the token spend
(#4780).

A request carrying `session-id` maps to an opaque `app:HMAC(session, session)` under a random
process-local key, and every root, child and grandchild of that tree resolves to it. Without a
session the cohort is read from the parent's lineage record, falling back to
`app:HMAC(parent, parent)` when this scope has not seen that parent -- which is the same key that
parent derives for itself, so a chain of parent-only turns converges rather than splitting at
every depth. No caller-supplied identifier reaches Pool state. Which requests bind at all is
unchanged -- a bare `thread-id` with neither a session nor a parent has no family anchor and
stays unbound. Components are trimmed and bounded at 512 bytes, missing or
oversized values stay unbound, raw identifiers and durable hashes are never stored, and
account-qualified selectors skip both lookup and mutation. Selection, subagent fallback preview,
and terminal outcome accounting carry the same key so route planning cannot preview one account
and authenticate another. A transient-failure streak does not delete the live binding that
actually selected the account; the request is served by another account while the binding is kept.

**Cohort keying is not a revert of #4546 wp8, and reading it as one will flip it straight back.**
wp8 fixed a different defect: a child bound under the RAW parent id, an identity unrelated to the
root's own `app:HMAC(session, thread)` binding, so siblings shared an entry the root was not on
and a grandchild keying on its own parent landed on a key nobody had ever bound. A cohort key
cannot produce that incoherence, because the root's own binding IS the cohort key -- there is one
identity for the tree rather than two competing ones, and the grandchild-orphan property is pinned
as a test rather than left as an argument. What wp8 additionally gave each thread, a binding of
its own, is what #4780 deliberately gives up.

The cost is explicit: a tree gains cache locality and loses per-thread placement independence. All
members share one binding, so a fan-out cannot spread across accounts, and when that account is
exhausted or retired the whole tree moves together. That is correct for cache affinity and it is
a behaviour change, not a refinement. It also interacts with the send-budget and placement work
#4546 introduced, since a tree is now one binding for accounting as well as for routing.

`src/codex/lineage.ts` owns that derivation and records the family relation behind it: each
thread's own conversation key, its immediate parent's thread id, and the transitive root, so a
grandchild resolves to the same root as its parent. Records are held per authenticated scope (an
HMAC of the caller's Authorization under the same process-local key), and bounded in both
dimensions -- idle TTL and an LRU cap on records per scope, and an LRU cap on scopes.

First placement is largely subsumed by cohort keying: a member of a tree any other member has
already bound resolves to that same binding, so there is nothing to place. `pickLineageServingAccount`
remains for the one case cohort keying cannot unify -- a session-less chain whose parent this scope
has not recorded -- and is gated on the parent's key actually differing from the request's own, so
it never re-asks a question the binding lookup already answered. An ineligible or dead family
account still contributes nothing, because a stale home is worse than no hint, and the hint does
not move the shared active-account cursor. The same module exposes the root lookup other layers
use for cost attribution and a lineage-backed worker/interactive answer; admission's header-only
classification is unchanged and does not yet read it.

> Decision record: [ADR-0085](../decisions/ADR-0085-public-provider-contract.md)

An explicit `Retry-After` or an unclassified quota 429 is account-wide. A reset-derived native-model
429 is advisory and remains within its confirmed quota group: shared native quota (including
GPT-5.6 Terra/Luna) is separate from exact `gpt-reserve`. Ordinary success cannot clear Reserve.
Retired Codex Spark windows are suppressed before ingestion, hydration, presence/capacity decisions
and account/provider DTO projection; generic custom windows remain supported. Spark model-derived
response quota/reset evidence cannot become shared quota or recovery evidence. Explicit Retry-After
and credential/transport failures retain their ordinary handling.

`src/codex/quota-rejection.ts` separates a limit the account owns from one it merely belongs to.
`usage_limit_exceeded` and `insufficient_quota` name a plan window and stay reset-credit eligible.
`credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` and
`organization_usage_limit_exceeded` name a balance or cap held by the organization or project, so
`classifyCodexPreStreamRejection` reports `scoped-quota-exhaustion` with `alternateRetryEligible`
false and `scopedExhaustionCode` set, and never `resetCreditEligible` — a reset credit reconciles a
ChatGPT plan window and cannot pay an organization's bill. The two sets are disjoint and share one
parser, so a `code`/`type` pair that disagrees, a duplicate key at any depth, or a case or
whitespace near-miss yields no code at all. `codexScopedExhaustionCode` exposes the scoped answer
alone for the rotation gate and fails closed, so only positive evidence changes a routing decision.

`pausedCodexAccountIds` is a persisted Pool eligibility boundary. A paused added account or the
stable `__main__` alias remains visible for maintenance and quota reads, but is excluded from new
affinity, quota rotation, cooldown probes, transient failover, and manual activation. In-flight
requests keep their captured credential. An all-paused pool fails closed.
The dashboard's bulk pause action refreshes all account quotas and mutates only accounts whose
plan-relevant window is freshly confirmed at exactly 100%; unknown and failed refreshes are skipped.

A quota refusal that announces a reset carries two durations, not one. The hard cooldown governs
blocking and keeps its cap, and a separate avoidance window records the period the refusal actually
announced, bounded at six hours so a reset days out cannot take an account out of rotation for that
long. Selection and affinity reuse both pass over an account while its window is live. The window
binds the stable `__main__` alias on the same terms as an added account: the main login is not in
the configured pool and enters candidacy through its own re-insertion path, which applies the same
avoidance check the pool filters apply. Avoidance stays soft. Last-resort selection still reaches
the account when nothing else can serve, a successful recovery probe drops the window with the
cooldown it belonged to, and both operator escapes remove it: clearing a cooldown and naming an
account each clear the window from the account-wide entry and from every scoped entry, because a
reset-derived refusal records only the scoped one.

Clearing a cooldown is also the management operation for a window whose cooldown has already
lapsed. Because the cooldown is the shorter of the two durations, the state an operator usually
finds is an expired cooldown and a live window, so a live window alone makes the operation
succeed and report a clear. An account with neither reports no change, which is what keeps the
route from disclosing whether an account exists.

A confirmed manual reset-credit consumption may immediately reconcile that account's
eligible pre-existing ordinary reset-derived cooldown after a complete, non-exhausted usage
observation started after the reset. Paused or reauthentication-required accounts and
cooldowns held by another in-flight probe remain excluded; their cooldowns are retained.
Confirmation requires a readable answer. Every reset-credit read, including the consume
response on both the manual and background paths, goes through the shared bounded-body
reader, so an upstream answer past that bound is unconfirmed rather than buffered whole.
An unconfirmed manual consume leaves its operation ambiguous and reconciles nothing.
Recovery owns the specific cooldown and authenticates
main and added Pool accounts through their respective credential contracts. Main usage
publication keeps the latest successfully published observation authoritative. Pool recovery
across a credential refresh requires the actual self/joined refresh lineage, not matching
replacement timestamps. It preserves
newer failures, independent Reserve scope, explicit Retry-After, pause, pin and
selection state. Replay and `already_redeemed` are not new-reset evidence. Failed usage
recovery leaves the cooldown in place and preserves the confirmed consume success;
retrying usage must not require another credit.

`codexQuotaAutoRefresh` is a separate default-off spending intent. For each explicitly enabled
account/window, the one-minute state sweep compares the cached upstream reset timestamp, sends the
existing minimal non-stored warmup through that exact account once the timestamp is due, then
field-patches the completed timestamp. The next observed reset boundary is also retained in
`nextFiveHourResetAt` / `nextWeeklyResetAt` until completed; later idle-window metadata cannot
postpone it. Successful warmups publish quota headers under the captured credential/identity fence.
For opted-in accounts only, stale metadata is refreshed at most once per five minutes through
the existing WHAM recovery path, independently of dashboard traffic or reset notifications.
Inference 401s quarantine the rejected credential; failures log an opaque label and safe reason.
Paused or reauthentication-required
accounts are skipped, simultaneous 5-hour/weekly resets share one warmup, transient failures retry
after five minutes, and account deletion removes its setting and completion markers.
Main-account hard-lock also gates these billable warmups. A policy/identity skip changes neither
completion markers nor retry delay; quota reads remain available. Main refresh completes before
shared credential ownership, then prepared credentials and restrictions are rechecked. Lifecycle
cleanup uses the dependency-free quota-auto-refresh state leaf, avoiding a reconciliation cycle.

The account-pool dashboard exposes one bulk control under Advanced settings, not per-card
rows. It applies both reported 5-hour and weekly windows to every current main/added account;
new accounts do not inherit opt-in. The existing granular settings API remains authoritative.
UI writes are serialized, followed by a settings read; partial failures preserve the intended
ON/OFF action for explicit retry. OFF also clears unavailable windows with stale enabled flags.

Exact `gpt-reserve` has a separate process-local quota scope. Only global/default and shared
ordinary scopes can receive a generic quota-recovery claim; ordinary success cannot clear Reserve.
Effective Desktop authless compatibility adds only configured main-selector Reserve catalog rows,
never global/native/API-key or added-account discovery. Prefer observed Reserve metadata; a
Luna-derived fallback is explicitly marked and never becomes an observed native source on resync.
Loopback injection and catalog eligibility share the pure `loopback-target` predicates.
Runtime eligibility is separate: only trusted receiving-listener admission with source loopback,
the opt-in flag and non-client role activates compatibility. A secondary listener's existence does
not affect public ingress. Admission flows through Responses, compact, WS handshake/turns,
translated replay and helper planning; missing admission is not inferred from a URL or Host header.
Claude's replay keeps its existing sidecar/routing overrides but passes the original live policy
reference separately. Policy flags/role/pause remain current through materialization and dispatch;
the replay snapshot must not hide a policy change while a send waits for pacing.

Reserve availability belongs to `reserve-availability`, not the catalog. An already-owned main
token/writer makes a capability-aware fixed WHAM GET, bounded to8s/64KiB. Ordinary disallowed,
Luna Reserve banner and exactly one allowed Reserve bucket are all required. Optional account/user
echoes must match. The max60s grant and single-flight are bound privately to the exact credential,
identity generation and a WeakMap-backed proof; refresh, revocation or identity replacement cannot
reuse a spread/copied proof. Passive usage only revokes. Ordinary quota publication uses an injected
callback to the existing validated parser/store; no runtime import of the quota/config facade is
introduced into this leaf. Quota types live in `quota-types` to avoid a cache/facade type cycle.
Final materializers require proof based on the exact model plus transport-scoped live config,
including custom-named canonical-forward routes that synthesize a main context. The injected
transport guard rechecks actual headers after pacing, at every HTTP attempt and WebSocket create;
expiry/revocation fails closed without renewal inside a send. Nested retry evidence preserves local
policy errors instead of recording a network failure. A missing proof does not fall through to
ordinary Luna or another account. Native vision/search helpers and standalone search refuse Reserve
under this compatibility opt-in; ordinary helper/default behavior is unchanged.
Upstream remains the entitlement authority.

`isCodexReserveOptInMissing` in `src/codex/loopback-target.ts` is the strict complement of
`isCodexReserveRequestEligible` for the opt-in reason alone: exact `gpt-reserve`, a non-client role,
loopback admission, and the flag off. Callers classify the destination as canonical forward first.
A request matching it is refused locally with HTTP 400 `invalid_request_error` naming
`codexDesktopAuthless` and `ocx system settings --desktop-authless on`, carrying no account
identifier, credential or request body, and no retry semantics. It is not a cooldown and does not use
`CodexReserveUnavailableError`, whose `CodexAccountCooldownError` base maps to 429
`rate_limit_error` through `cooldownErrorResponse` and would restate the upstream verdict this
refusal exists to replace. The other two ineligibility reasons, a client role and a non-loopback
admission source, still forward unchanged, as does a `gpt-reserve` selector an operator has aliased
or routed onto a noncanonical provider. Enabling the flag restores eligibility rather than the
refusal, so the two predicates can never both hold.

### Quota cache and short-window history

`src/codex/quota.ts` drops an omitted account-level short tuple from the display/rotation
cache when its stored reset instant has elapsed. Seconds and milliseconds are accepted;
future or missing deadlines remain carried, and explicit incoming short readings remain stored.
This stops partial weekly/Spark or credits-only refreshes from renewing obsolete Spark-derived
5h rows through the cache-wide `updatedAt` timestamp. Plan labels do not suppress real windows.

The separately retained main-policy snapshot preserves omitted blocking short evidence even after
its reset clock passes. Credits-only, partial weekly-only, and metadata-only updates cannot remove an
existing blocking short usage reading or release its hard lock; a fresh short reading can replace
it. A validated long-primary WHAM snapshot can also retire the short tuple as described below.
Expired non-blocking short evidence is dropped, so it cannot take priority over a fresh blocking weekly reading.

The Codex writer explicitly asks `src/quota/reset-observer.ts` to retain an absent short window
in `src/quota/reset-seen-store.ts`, with its original observation time. Detection compares only
incoming windows, so eviction emits nothing and a later real rollover still has its baseline.
Account cleanup forgets that baseline; other provider writers keep replacement semantics.
Auto-refresh uses its separately retained reset boundary after display eviction.
Regression coverage lives in `tests/codex-integration/codex-quota-parser-parity.test.ts`,
`tests/codex-integration/main-account-hard-lock-policy.test.ts`,
`tests/usage/quota-reset-observation.test.ts`, and `tests/usage/quota-reset-seen-store.test.ts`.

`codexMainAccountHardLock` is a local admission policy that is **on by default** since #5694, at
`MAIN_ACCOUNT_HARD_LOCK_PERCENT` = 98% of the 5h/short window when present, otherwise the weekly
window (monthly for monthly-only accounts). It does not take the maximum across those windows.
It blocks newly admitted identity-matched main-account requests. Pool alternatives remain eligible;
explicit main selection and stored Direct substitution do not override it. It neither pauses the
account nor clears upstream cooldown/reauth state, and management quota refresh remains available.
Only a fresh valid reading below 98%, including 0%, releases a measured block; passing a reset
timestamp alone does not. While blocked, the existing once-per-minute background sweep refreshes
owned main usage, with bounded/coalesced reads and no inference or reset-credit consumption. Failed,
missing, non-finite or out-of-range readings do not release the block. Policy validation precedes
legacy clamping. Supplementary monthly data cannot become the fallback governing window without a
monthly-only plan or explicit primary-monthly evidence. Previously unobserved usage is unknown, not
fabricated headroom.

`isMainAccountHardLockEnabled` is the single resolver: an absent key and `true` both enable the
policy, and only an explicit `false` opts out. The settings PUT stores that `false` rather than
deleting the key, and writing `true` deletes it, so the stored shape cannot disagree with the
projection the dashboard renders. Two consequences are deliberate: an opt-out written before #5694
deleted the key and therefore now reads as on, and `src/config/schema/config-schema.ts` degrades a
malformed value to `undefined`, which is also on, so a hand-edit typo cannot silently disable the
policy.

The trade-off is admission, not accounting. The main account's Luna Reserve needs an exhausted
ordinary window to activate, so while the lock is blocking Reserve cannot engage; an operator who
wants Reserve turns the setting off rather than deleting the key. This is not a reservation of the
last 2%: already-admitted, parallel, unmatched-keyring, or direct upstream traffic can still reach
exhaustion. Settings and the main-account DTO report enabled state separately from the current
`off`, `unknown`, `ready`, or `blocked` status. Status semantics stay in
`tests/codex-integration/main-account-hard-lock-policy.test.ts`; the default-on resolver, the 98%
boundary, the admission consequence, and the settings opt-out round trip are covered by the
hard-lock tests registered in `scripts/test-layout/layout.json`, including
`tests/config/settings-main-account-hard-lock.test.ts`.

A single fresh valid WHAM response with an explicitly long primary window can replace an obsolete
short-window tuple when secondary and tertiary windows are explicitly null or also explicitly long with a valid usage reading.
Long means **at least 24 hours**, matching the parser's short/long discriminator; a one-day primary
qualifies, not only a seven-day or monthly window. The policy trusts that one reported topology;
it does not require repeated observations or independently confirm upstream window completeness.
Omitted secondary/tertiary fields, a long auxiliary window without a usage reading, an unknown primary duration, partial headers, or invalid usage cannot prove that the
short window disappeared. Replacement proof belongs only to that observation and is never persisted;
the resulting weekly/monthly window still blocks at 98%. This prevents old short-window exhaustion
from surviving indefinitely on a now weekly/monthly account. Coverage lives in
`tests/codex-integration/main-quota-evidence-validation.test.ts`,
`tests/codex-integration/main-quota-provenance.test.ts`, and
`tests/codex-integration/main-account-hard-lock-recovery.test.ts`.

The policy reads a separately retained identity-tagged quota snapshot, so the legacy rotation
cache's six-hour expiry does not silently release a known block. A confirmed account transition
invalidates old evidence. Request-owned bearers are matched only against a credential and effective
workspace already observed under native ownership; an unrelated or unmatched keyring credential
is not attributed to stored main and introduces no physical-main read. Credential equality tags
remain process-local and never enter disk, logs, or management DTOs.

Owned startup rebuilds this binding from its pinned auth path under the native owner and exclusive
claim, after journal recovery and stage cleanup, before publishing ready. That work now runs for
every owned startup instead of only for an explicit opt-in, because the policy is on by default.
Caller-owned Direct, exact-main, fallback, and main-pin admission stays temporarily fenced during
that initialization; stored Pool alternatives remain eligible. Foreign/unknown service-home paths
neither initialize the binding nor trigger an ownership reprobe from caller-owned admission. A new
listener, and a completed manual recovery, rearms the same guarded path on an existing ready
lifecycle, including when the physical credential was replaced after the earlier listener started.
Failed initialization creates no new binding and does not withhold readiness: an absent, malformed,
or identity-conflicting pinned credential leaves the gate ready with no policy binding. A previously
verified same-process binding and its safety state remain until a valid replacement observation or
confirmed account transition; malformed or conflicting input alone is not replacement evidence.

`codexAccountPriorities` is a persisted Pool *ordering* boundary and never an eligibility one. It maps
an account id to an integer from -100 to 100, higher used earlier, with absence meaning 0. Selection
narrows the already-eligible list to the highest tier that still holds an account with quota headroom
and lets the configured strategy pick within that tier. A tier drains only when every member is over
the auto-switch threshold, cooling down, soft-avoided, paused, or needs reauth; unknown quota never
drains a tier, and every tier drained leaves the eligible list untouched. Ordering never admits an
account that pause, cooldown, health, or reauth already excluded, and never overrides those
exclusions. It adds no new rebind cause for a bound thread, which still moves only for the reasons it
already had: a quota-strategy re-evaluation when `pool.cacheAffinity` is off (threshold) or the bound
account cannot serve (the default), an account that stopped being selectable, or affinity expiry. A
conversation carrying live uploaded-file references raises that bar to the default one regardless of
`pool.cacheAffinity`; see [uploaded-file account retention](openai-accounts.md#uploaded-file-account-retention).
A transient-failure streak does not delete a live binding. A bound move requires genuine quota
headroom and strictly lower usage on the destination. The stable `__main__` alias carries an order on
equal terms with added accounts, which is what lets the Desktop login be ordered last. An absent or
empty map reproduces the prior selection sequence exactly.

Preemption moves unbound requests back up when a higher tier regains headroom, and it holds the
runtime cursor only. Under an independent quota scope it must never touch the shared active cursor,
because the scopes track separate native quota groups and a scoped request has no standing to move
the account every other scope resolves from.

A manual activation pins its account and lowers the tier ceiling to that account's own tier. The pin
is released by drain, exclusion, deletion, an explicit failover/promotion away, and any write to
`codexAccountPriorities` — a pin and an order are both the operator naming an account to use, so the
newer statement wins. Ordinary round-robin movement inside the capped tier does not release it.
Without that last rule a pin made before any order existed, which is just an ordinary account switch,
would outrank every order set afterwards for as long as the account kept headroom.

Whether a pin is about to be released is one predicate, `codexAccountPinDrainReason` in
`src/codex/routing/pin-drain.ts`, and the surface that accepts a pin evaluates it rather than
keeping a second copy. It lives beside selection rather than in `routing.ts` for the same reason
`routing/cache-affinity.ts` does: two callers ask it and must answer identically, one acting on
the answer and one reporting it.

`PUT /api/codex-auth/active` still accepts a pin on a drained account -- a usage reading is a
preference and can be stale, so refusing would turn a proactive threshold into a hard capacity limit
-- but it reports `pinDrained` with a `pinDrainReason` of `needs_reauth`, `paused`, `unusable` or
`quota_threshold` when the next resolve would drop what it just recorded. The fields are absent when
the pin survives, so a client that does not know them reads no drain. Without this the route answered
a bare 200 and the operator watched an accepted selection be ignored one request later, which is the
contradiction reported in #4521. Reauth and pause are classified before the native-main fence,
because a selection-only caller makes every later classification answer "no drain" and a pin on a
signed-out main would otherwise read as durable.

Only an actual selection pins. Clearing the active account states that no account is chosen, so it
releases the pin instead of recording one against the `__main__` fallback that the same handler uses
for its paused check. A pin no effective active account matches is invisible — `pinned` compares the
two and reports false — while the tier filter still honours it, which would silently cap the pool at
the main account's tier.

The pin is a ceiling, not a selection: inside the capped tier the strategy cursor still moves. So the
pinned account and the effective active account are different questions, and the management API answers
both (`pinned` and `pinnedAccountId`). A surface that marks only the active account loses the pin from
view exactly when it is doing the most work — suppressing every higher tier.

A keyring-backed Codex request can carry its own forwardable ChatGPT bearer while the provider remains
in Pool mode. When the effective manual pin is `__main__`, main is not paused, and its cached quota still
has headroom, auth resolution validates the caller bearer's own gated-model roster and uses that
request-owned credential before stored-Pool selection. The credential never enters Pool persistence,
affinity, entitlement cache, or health state, and this decision never reads the physical main credential.
If the caller lacks the requested model, a stored-account model detour may serve the request without
clearing the healthy shared main pin. With quota-strategy cache affinity, the same detour preserves an
ordinary added-account binding and shared selection beyond the proactive-switch threshold until genuine
exhaustion; pause, cooldown, reauthentication, quota refusal, and failover evidence still retire shared
state normally. A paused or quota-drained main skips the request-owned credential exception and follows
the ordinary Pool promotion path.

Without a pin, that same bearer makes main an ordinary candidate rather than a last-resort fallback.
A forwardable request-owned bearer IS main's live credential for that request — it is what would be
sent if selection named main — so `requestOwnedMainCredentialIsLive` answers the pool-liveness
question yes, and main is compared against the stored accounts on the operator's own usage, priority
and reset ordering. Selecting main then serves it from the caller's credential without claiming,
reading, reconciling or priming the stored profile, and without owning affinity or health state.
A main that wins only through that bearer is also never recorded as the shared active account: the
request resolves to main, while the persisted and runtime shared active account remain unchanged.
Answering that question with the pin predicate instead scored main `main_credential_unavailable` on
every unpinned request, so a pool with one stored sibling degraded to "stored account until it cannot
serve, then main" whatever the usage numbers, the strategy or `codexAccountPriorities` said (#5019).

Two things stay out of it. An account-gated model is still excluded, because main's roster is
discovered from the stored credential this request may not read, so candidacy alone cannot produce a
gated-model grant. Retained startup recovery and a draining profile still make main ineligible, since
those fence the identity rather than the credential. Request preview answers this from the same shared
expression: a preview that scored main differently would hand subagent fallback a different account
than the one that serves, which is the divergence #4850 closed.

> Decision record: [ADR-0086](../decisions/ADR-0086-public-provider-contract.md)

```text
gpt-5.6-sol                         # openai; Pool or Direct follows the provider option
main/gpt-daybreak-blue-latest       # openai; observed account-native Daybreak, Sol capability metadata
openai/gpt-daybreak-blue-latest     # Codex forward; explicit Daybreak row with Sol native metadata
openai-apikey/gpt-5.6-sol           # OpenAI API key
openai-apikey/daybreak-blue-latest  # API Daybreak alias; separate approval/provisioning
openai-apikey/gpt-5.6-sol-pro       # API Pro virtual model
```
