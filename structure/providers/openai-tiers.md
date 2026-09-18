# OpenAI Provider Account Modes

Management provider-validation calls use the [shared relative send-path validation](../config.md#provider-relative-send-paths) before persistence. Catalog HTTP acquisition follows the [proxy-routing contract](../catalog.md#remote-catalog-http-proxy-routing).

Explicit Codex CLI installation observation does not identify an account, attest provider selection or alter account state. See the [read-only observation contract](../runtime.md#explicit-codex-cli-installation-observation).

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](../runtime.md#lifecycle).

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

The separately retained main-policy snapshot preserves omitted short evidence even after its
reset clock passes. Credits-only, weekly-only, and metadata-only updates cannot remove an
existing short usage reading or release its hard lock; a fresh short reading can replace it.

The Codex writer explicitly asks `src/quota/reset-observer.ts` to retain an absent short window
in `src/quota/reset-seen-store.ts`, with its original observation time. Detection compares only
incoming windows, so eviction emits nothing and a later real rollover still has its baseline.
Account cleanup forgets that baseline; other provider writers keep replacement semantics.
Auto-refresh uses its separately retained reset boundary after display eviction.
Regression coverage lives in `tests/codex-integration/codex-quota-parser-parity.test.ts`,
`tests/codex-integration/main-account-hard-lock-policy.test.ts`,
`tests/usage/quota-reset-observation.test.ts`, and `tests/usage/quota-reset-seen-store.test.ts`.

`codexMainAccountHardLock` is a separate opt-in local admission policy, off by default.
It blocks newly admitted identity-matched main-account requests at 99% of the 5h/short window
when present, otherwise the weekly window (monthly for monthly-only accounts). It does not take
the maximum across those windows. Pool alternatives remain eligible; explicit main selection and stored Direct
substitution do not override it. It neither pauses the account nor clears upstream cooldown/reauth
state, and management quota refresh remains available. Only a fresh valid reading below 99%, including
0%, releases a measured block; passing a reset timestamp alone does not. While blocked, the existing
once-per-minute background sweep refreshes owned main usage, with bounded/coalesced reads and no
inference or reset-credit consumption. Failed, missing, non-finite or out-of-range readings do not
release the block. Policy validation precedes legacy clamping. Supplementary monthly data cannot
become the fallback governing window without a monthly-only plan or explicit primary-monthly evidence.
Previously unobserved usage is unknown, not fabricated headroom.

The policy reads a separately retained identity-tagged quota snapshot, so the legacy rotation
cache's six-hour expiry does not silently release a known block. A confirmed account transition
invalidates old evidence. Request-owned bearers are matched only against a credential and effective
workspace already observed under native ownership; an unrelated or unmatched keyring credential
is not attributed to stored main and introduces no physical-main read. Credential equality tags
remain process-local and never enter disk, logs, or management DTOs.

When protection is enabled, owned startup rebuilds this binding from its pinned auth path under
the native owner and exclusive claim, after journal recovery and stage cleanup, before publishing
ready. Caller-owned Direct, exact-main, fallback, and main-pin admission stays temporarily fenced
during that initialization; stored Pool alternatives remain eligible. Foreign/unknown service-home
paths neither initialize the binding nor trigger an ownership reprobe from caller-owned admission.
A new listener with protection enabled rearms the same guarded path on an existing ready lifecycle,
including when the physical credential was replaced after the earlier listener started.
Failed initialization creates no new binding. A previously verified same-process binding and its
safety state remain until a valid replacement observation or confirmed account transition; malformed
or conflicting input alone is not replacement evidence.

This is not a reservation of the last 1%: already-admitted, parallel, unmatched-keyring, or direct
upstream traffic can still reach exhaustion. While blocked, main cannot use Luna reserve either.
Keeping ordinary usage below exhaustion may prevent Reserve activation; the policy never changes
OpenAI's Reserve grants or `ordinary_usage_allowed` response. Settings and the main-account DTO
report enabled state separately from current `off`, `unknown`, `ready`, or `blocked` status.

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
`pool.cacheAffinity`; see [uploaded-file account retention](#uploaded-file-account-retention).
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
clearing the healthy shared main pin. A paused or quota-drained main skips this exception and follows the
ordinary Pool promotion path.

> Decision record: [ADR-0086](../decisions/ADR-0086-public-provider-contract.md)

```text
gpt-5.6-sol                         # openai; Pool or Direct follows the provider option
main/gpt-daybreak-blue-latest       # openai; observed account-native Daybreak, Sol capability metadata
openai/gpt-daybreak-blue-latest     # Codex forward; explicit Daybreak row with Sol native metadata
openai-apikey/gpt-5.6-sol           # OpenAI API key
openai-apikey/daybreak-blue-latest  # API Daybreak alias; separate approval/provisioning
openai-apikey/gpt-5.6-sol-pro       # API Pro virtual model
```

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
  one model that is still account-gated, which disabled both its alternate-account retry and its
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
## Paginated history writer boundary
`src/codex/history-provider.ts` refuses external writes to paginated or migration-capable history. `src/codex/inject.ts` checks affected rows and manifest-owned restore targets before and after config/profile/journal changes, including successful journal and fallback restores, and compensates refused restore/removal transitions. Failed config restore stops later catalog/history work and rolls back a coordinated remove transition. Apply retains an existing provider definition before candidate admission even when history preflight passes, so migration after artifact commit or during worker startup cannot leave earlier conversations without their provider. See the [history writer contract](../codex-home.md#paginated-history-writer-boundary) for guarantees and concurrent-writer limits.

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

A quota-strategy re-evaluation may move a LIVE thread binding only to an account that has genuine
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

Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.
`src/codex/auth-api/login-flow.ts` distinguishes HTTP 429 from an attempted warmup as `codex_warmup_rate_limited` and preserves that code in OAuth status. Failed attempted warmup does not persist replacement credentials; quota-confirmed deferred registration and HTTP 401/403 handling remain separate. `src/codex/warmup.ts` retains a known 429 when bounded error-body draining times out.
