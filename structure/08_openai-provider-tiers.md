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

```text
gpt-5.6-sol                         # openai; Pool or Direct follows the provider option
openai-apikey/gpt-5.6-sol           # OpenAI API key
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
config is a user-intentional rollback point and blocks migration; a snapshot that is unparseable or
already tier-v2 is stale and is replaced with a warning. The distinction matters because silently
discarding a rollback point is destructive, while preserving a stale one would block every later
migration.

## Model and wire identity

- `openai` exposes one group of bare native Codex ids in Pool and Direct. Changing mode does not
  change catalog, selected, requested, or wire model identity.
- `openai-apikey` exposes namespaced API rows. Its trusted catalog contains `gpt-5.5`, `gpt-5.6`,
  Sol/Terra/Luna, and the three corresponding Pro variants. No generic `gpt-5.6-pro` alias exists.
- API GPT-5.6 rows use 1,050,000 context tokens and 922,000 max input tokens. Codex-login rows keep
  the native 372,000-token contract.
- `*-pro` selected ids rewrite to the base wire id with `reasoning.mode: "pro"`; request logs,
  usage, model visibility, subagent state, and injection state retain the selected virtual id.
- Compact preserves provider/selected identity but sends the base model without a reasoning object.

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
