# OpenAI Provider Account Modes

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

The two routes also keep separate request-compatibility contracts. The canonical ChatGPT Codex
forward destination removes public `prompt_cache_options` because that backend rejects the field
before inference; `prompt_cache_key` remains supported. `openai-apikey` and noncanonical/custom
Responses destinations preserve caller-provided options because their upstream contracts may
support them.

> Decision record: [ADR-0084](../decisions/ADR-0084-public-provider-contract.md)

Pool affinity preserves the existing `x-codex-parent-thread-id` supplied by ordinary Codex clients.
The parent id is trimmed and bounded under the same 512-byte component limit as the Desktop
fallback. When Codex Desktop omits it or sends an unusable value, the complete bounded `session-id`
plus `thread-id` pair is mapped to an opaque HMAC under a random process-local key. Missing or
oversized components remain unbound, raw identifiers and durable hashes are never stored, and
account-qualified selectors skip both lookup and mutation. Selection, subagent fallback preview,
and terminal outcome accounting carry the same key so route planning cannot preview one account
and authenticate another, and a transient failure clears the binding that actually selected the
account.

> Decision record: [ADR-0085](../decisions/ADR-0085-public-provider-contract.md)

An explicit `Retry-After` or an unclassified quota 429 is account-wide. A reset-derived native-model
429 is advisory and remains within its confirmed quota group: `gpt-5.3-codex-spark` is separate from
the shared native group (including GPT-5.6 Terra/Luna). This allows a same-account combo to test an
independent quota without allowing fallbacks that share the exhausted quota.

`pausedCodexAccountIds` is a persisted Pool eligibility boundary. A paused added account or the
stable `__main__` alias remains visible for maintenance and quota reads, but is excluded from new
affinity, quota rotation, cooldown probes, transient failover, and manual activation. In-flight
requests keep their captured credential. An all-paused pool fails closed.
The dashboard's bulk pause action refreshes all account quotas and mutates only accounts whose
plan-relevant window is freshly confirmed at exactly 100%; unknown and failed refreshes are skipped.

A confirmed manual reset-credit consumption may immediately reconcile that account's
eligible pre-existing ordinary reset-derived cooldown after a complete, non-exhausted usage
observation started after the reset. Paused or reauthentication-required accounts and
cooldowns held by another in-flight probe remain excluded; their cooldowns are retained.
Recovery owns the specific cooldown and authenticates
main and added Pool accounts through their respective credential contracts. Main usage
publication keeps the latest successfully published observation authoritative. Pool recovery
across a credential refresh requires the actual self/joined refresh lineage, not matching
replacement timestamps. It preserves
newer failures, independent Spark/Reserve scopes, explicit Retry-After, pause, pin and
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
already had: a quota-strategy threshold re-evaluation, a failover streak, an account that stopped
being selectable, or affinity expiry. The stable `__main__` alias carries an order on equal terms with
added accounts, which is what lets the Desktop login be ordered last. An absent or empty map
reproduces the prior selection sequence exactly.

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
(`src/config.ts` `classifyOpenAiTierBackup`): a snapshot that parses as a valid pre-migration (v1)
config is a user-intentional rollback point and is copied to a unique
`config.json.pre-openai-tiers-v1-rollback.<timestamp>.bak` path before startup retries the v2
migration backup; a snapshot that is unparseable or already tier-v2 is stale and is replaced with a
warning. The distinction matters because silently discarding a rollback point is destructive, while
preserving a stale one would block every later migration.

## Model and wire identity

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

## Sidecars, management, and UI

HTTP/SSE, Responses WebSocket, compact, images, search, and vision resolve the same account mode.
There is one mode-aware `openai` forward sidecar candidate; `openai-apikey` is not a ChatGPT-forward
sidecar candidate and cannot hide a failed Codex credential with separately billed API usage.

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
