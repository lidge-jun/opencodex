# OpenAI Provider Account-Mode SOT

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

Pool affinity preserves the existing `x-codex-parent-thread-id` supplied by ordinary Codex clients.
The parent id is trimmed and bounded under the same 512-byte component limit as the Desktop
fallback. When Codex Desktop omits it or sends an unusable value, the complete bounded `session-id`
plus `thread-id` pair is mapped to an opaque HMAC under a random process-local key. Missing or
oversized components remain unbound, raw identifiers and durable hashes are never stored, and
account-qualified selectors skip both lookup and mutation. Selection, subagent fallback preview,
and terminal outcome accounting carry the same key so route planning cannot preview one account
and authenticate another, and a transient failure clears the binding that actually selected the
account.

[Decision Log]
- 목적과 의도: Keep Desktop reconnects on the account selected for the App task without persisting
  or exposing its session and thread identifiers.
- 기존 구현 및 제약 조건: Pool affinity used only `x-codex-parent-thread-id`; Desktop requests can
  omit it while stable `session-id` and `thread-id` headers remain available. Exact account
  selectors must stay outside automatic Pool affinity.
- 검토한 주요 대안: Leave reconnects unbound, persist a plain hash, bind from either header alone,
  delete App turn metadata, or derive one process-local key from the complete pair.
- 선택한 방식: Preserve the parent-thread key when present; otherwise HMAC the two bounded headers
  under a random per-process key and carry that opaque value through selection, subagent preview,
  and outcome handling.
- 다른 대안 대신 이 방식을 선택한 이유: A complete pair avoids weak partial identities, a
  process-local HMAC prevents durable correlation or dictionary recovery, and no upstream metadata
  needs to be mutated before the first-403 cause is proven.
- 장점, 단점 및 영향: Reconnects stop rotating among Pool accounts and failure accounting clears
  the correct binding. Affinity intentionally resets on process restart, and requests missing either
  component retain the prior unbound behavior.

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

[Decision Log]
- 목적과 의도: Preserve the account-gated Daybreak UX while avoiding shard-dependent selector
  rejection and the unsupported prompt-cache retention parameter.
- 기존 구현 및 제약 조건: The authenticated roster grants Daybreak, but live successful
  responses report `gpt-5.6-sol`; the selector can still fail eight consecutive times.
- 검토한 주요 대안: Increase retries indefinitely, hide Daybreak entirely, or canonicalize only
  the credential-bearing wire model after entitlement selection.
- 선택한 방식: Keep Daybreak for visibility and account authorization, then send the stable
  serving id and remove only the unsupported optional retention hint.
- 다른 대안 대신 이 방식을 선택한 이유: It keeps fail-closed entitlement checks and avoids
  unbounded duplicate requests while preserving the user-facing model choice.
- 장점, 단점 및 영향: Requests become deterministic and cheaper; this relies on the serving id
  observed from successful upstream responses and must be revisited if the roster exposes a
  first-class wire id later.

[Decision Log]
- 목적과 의도: Prevent account-gated native models from being shown or dispatched through a
  ChatGPT account that upstream does not authorize.
- 기존 구현 및 제약 조건: A static global Daybreak row solved clean-install discovery for
  entitled accounts, but Pool accounts can hold different grants and Codex's injected catalog does
  not refresh itself.
- 검토한 주요 대안: Infer grants from plan labels, learn only from prompt failures, bind Daybreak
  permanently to main, or rewrite the wire id to `gpt-5.6-sol`.
- 선택한 방식: Share bounded authenticated per-account model-roster evidence between catalog sync,
  `/v1/models`, and Pool auth selection.
- 다른 대안 대신 이 방식을 선택한 이유: Plan labels and account position do not prove a grant;
  failure-only learning wastes a turn; permanent main binding rejects valid secondary grants; wire
  rewriting changes the requested product identity.
- 장점, 단점 및 영향: Entitled accounts retain clean-install discovery while unentitled accounts
  never receive the gated dispatch. A cold gated request may pay one bounded roster fetch per
  account, and an unavailable discovery temporarily hides the model rather than guessing.
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
  headroom. Evidence: `devlog/_plan/260817_native_gpt56_1m_context/001_measurement_evidence.md`
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

```text
[Decision Log]
- 목적과 의도: Identify which combined Codex affinity values survive a Plus-to-K12 credential substitution without collecting private thread or account data.
- 기존 구현 및 제약 조건: Pool auth intentionally copies the curated caller metadata and replaces only authorization plus chatgpt-account-id. Individual header probes did not reproduce the workspace denial, while raw captures would expose account-bound identifiers.
- 검토한 주요 대안: Delete all affinity metadata; log raw values; persist ordinary hashes; perform automatic header-ablation retries; or emit process-local keyed equality evidence only when provider debug is enabled.
- 선택한 방식: Emit bounded pre-stream diagnostics with a random per-process HMAC key, a fixed non-credential header allowlist, known turn-field summaries, and no request mutation.
- 다른 대안 대신 이 방식을 선택한 이유: Equality across two requests in one run is enough to narrow the incompatible combination; process-local HMACs prevent durable correlation and make offline guessing useless, while observation-only capture cannot change production semantics.
- 장점, 단점 및 영향: Maintainers can compare a Plus success and exact-K12 denial safely. Tags cannot be compared across restarts, and the diagnostic does not itself identify an upstream policy rule or fix the rejection.
```

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
